import React, { useEffect, useMemo, useState } from 'react';
import { Box, Button, Grid, Paper, Typography } from '@mui/material';
import { getLatestRigData, isLiveRigPayload, socket } from '../../socket';
import api from '../../api';
import EdrView from '../EDR/EdrView';
import plcCatalog from '../../../../shared/db119Catalog.json';

const CAT_ENGINE_CONFIG = {
    engine1: { source: 'cat_engine' },
    engine2: { source: 'cat_engine_2' }
};

const CAT_CHANNELS = ['cat_engine.rpm', 'cat_engine.load', 'cat_engine.fuel_rate', 'cat_engine.coolant_temp', 'cat_engine.oil_pressure'];
const CAT_STRIPS = [{
    title: 'CAT engine',
    pens: [
        { channelId: 'cat_engine.rpm', color: '#38bdf8', min: 0, max: 2000, enabled: true },
        { channelId: 'cat_engine.load', color: '#fbbf24', min: 0, max: 100, enabled: true },
        { channelId: 'cat_engine.fuel_rate', color: '#f97316', min: 0, max: 200, enabled: true }
    ]
}];

const hasNumber = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const valueText = (value, decimals = 0) => hasNumber(value) ? Number(value).toFixed(decimals) : '--';
const isOn = (value) => hasNumber(value) && Number(value) > 0;
const STATUS = {
    '-1': ['UNKNOWN', '#64748b'], 0: ['READY', '#38bdf8'], 1: ['RUNNING', '#4ade80'], 2: ['DONE', '#4ade80'],
    3: ['EMERGENCY', '#ef4444'], 4: ['NOT READY', '#fbbf24'], 5: ['FAULT', '#ef4444'], 6: ['RUN + FAULT', '#f97316'], 7: ['STOP FORCED', '#ef4444']
};

const Panel = ({ title, right, children, sx = {} }) => (
    <Paper sx={{ p: 1.5, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 1.5, ...sx }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, mb: 1.25 }}>
            <Typography sx={{ color: 'text.primary', fontSize: '0.86rem', fontWeight: 800, letterSpacing: 0.35, textTransform: 'uppercase' }}>{title}</Typography>
            {right}
        </Box>
        {children}
    </Paper>
);

const Kpi = ({ label, value, unit, color = '#e2e8f0', sub }) => (
    <Paper sx={{ p: 1.25, minHeight: 82, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 1.25, textAlign: 'center' }}>
        <Typography sx={{ color: 'text.secondary', fontSize: '0.65rem', fontWeight: 700, letterSpacing: 0.45, textTransform: 'uppercase' }}>{label}</Typography>
        <Typography sx={{ color, fontSize: '1.45rem', lineHeight: 1.1, fontWeight: 800, mt: 0.55 }}>{value} <span style={{ fontSize: '0.66em', color: '#94a3b8' }}>{unit}</span></Typography>
        {sub && <Typography sx={{ color: 'text.secondary', fontSize: '0.62rem', mt: 0.3 }}>{sub}</Typography>}
    </Paper>
);

const RingGauge = ({ label, value, color, status }) => {
    const numeric = hasNumber(value) ? Math.max(0, Math.min(100, Number(value))) : null;
    const text = numeric == null ? '--' : `${Math.round(numeric)}%`;
    return (
        <Box sx={{ minWidth: 78, flex: 1, textAlign: 'center' }}>
            <Typography sx={{ color: 'text.secondary', fontSize: '0.62rem', whiteSpace: 'nowrap' }}>{label}</Typography>
            <Box sx={{ width: 68, height: 68, mx: 'auto', mt: 0.45, borderRadius: '50%', display: 'grid', placeItems: 'center', background: numeric == null ? '#263448' : `conic-gradient(${color} ${numeric * 3.6}deg, #263448 0deg)` }}>
                <Box sx={{ width: 52, height: 52, borderRadius: '50%', bgcolor: 'background.paper', display: 'grid', placeItems: 'center' }}>
                    <Typography sx={{ color: numeric == null ? 'text.secondary' : color, fontSize: '0.95rem', fontWeight: 800 }}>{text}</Typography>
                </Box>
            </Box>
            <Typography sx={{ color: numeric == null ? 'text.secondary' : color, fontSize: '0.62rem', fontWeight: 800, mt: 0.3 }}>{status || (numeric == null ? 'NO DATA' : '')}</Typography>
        </Box>
    );
};

const Metric = ({ label, value, unit, decimals = 0, color = '#e2e8f0', unavailable = false }) => (
    <Paper sx={{ p: 1.15, bgcolor: 'background.default', border: '1px solid', borderColor: 'divider', borderRadius: 1, minHeight: 70 }}>
        <Typography sx={{ color: 'text.secondary', fontSize: '0.68rem', whiteSpace: 'nowrap' }}>{label}</Typography>
        <Typography sx={{ color: unavailable ? 'text.secondary' : color, fontWeight: 800, fontSize: '1.22rem', mt: 0.45 }}>
            {unavailable ? 'NO DATA' : hasNumber(value) ? valueText(value, decimals) : (value ?? '--')} <span style={{ fontSize: '0.62em', color: '#94a3b8' }}>{unit}</span>
        </Typography>
    </Paper>
);

const Lamp = ({ label, value }) => {
    const on = isOn(value);
    return <Metric label={label} value={on ? 'ON' : 'OFF'} color={on ? '#ef4444' : '#22c55e'} unavailable={!hasNumber(value)} />;
};

const Insight = ({ title, text, color = '#38bdf8' }) => (
    <Box sx={{ py: 0.8, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography sx={{ color, fontWeight: 800, fontSize: '0.78rem' }}>{title}</Typography>
        <Typography sx={{ color: 'text.secondary', fontSize: '0.72rem', lineHeight: 1.35 }}>{text}</Typography>
    </Box>
);

const formatStatus = (value) => STATUS[String(value)] || ['--', '#64748b'];

const getRegenStatus = (data) => {
    const explicit = data.regen_status ?? data.regeneration_status ?? data.aftertreatment_regen_status;
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().toUpperCase();
    if (hasNumber(explicit)) {
        const states = { 0: 'IDLE', 1: 'REGEN ACTIVE', 2: 'REGEN DUE', 3: 'REGEN COMPLETE', 4: 'REGEN INHIBITED' };
        if (states[Number(explicit)]) return states[Number(explicit)];
    }
    if (isOn(data.hest_lamp)) return 'REGEN ACTIVE';
    if (isOn(data.dpf_lamp)) return 'REGEN DUE';
    if (hasNumber(data.next_regeneration)) return Number(data.next_regeneration) <= 0 ? 'REGEN DUE' : 'IDLE';

    // Some CAT installations provide the engine vitals but not the optional
    // regeneration lamp tags. Keep the dashboard useful in that case: a live
    // engine with no regeneration request is idle, not an unavailable engine.
    const engineIsReporting = [
        data.status, data.engine1_status, data.rpm, data.load, data.coolant_temp, data.oil_pressure,
        data.fuel_rate, data.run_hours, data.total_hours
    ].some((value) => hasNumber(value) || (typeof value === 'string' && value.trim() !== '')) || Object.keys(data).length > 0;
    return engineIsReporting ? 'IDLE' : 'DATA UNAVAILABLE';
};

const calculateHealth = (data) => {
    const checks = [];
    if (hasNumber(data.status)) checks.push(Number(data.status) <= 2);
    if (hasNumber(data.oil_pressure)) checks.push(Number(data.oil_pressure) >= 2);
    if (hasNumber(data.coolant_temp)) checks.push(Number(data.coolant_temp) >= 0 && Number(data.coolant_temp) <= 100);
    if (hasNumber(data.coolant_level)) checks.push(Number(data.coolant_level) >= 20);
    if (hasNumber(data.protect_lamp) || hasNumber(data.amber_warning_lamp) || hasNumber(data.red_stop_lamp)) {
        checks.push(!isOn(data.protect_lamp) && !isOn(data.amber_warning_lamp) && !isOn(data.red_stop_lamp));
    }
    if (checks.length < 3) return { label: 'INSUFFICIENT DATA', color: '#64748b', score: null };
    const score = Math.round((checks.filter(Boolean).length / checks.length) * 100);
    const label = score >= 85 ? 'GOOD' : score >= 65 ? 'WATCH' : score >= 40 ? 'WARNING' : 'CRITICAL';
    const color = label === 'GOOD' ? '#22c55e' : label === 'WATCH' ? '#fbbf24' : '#ef4444';
    return { label, color, score };
};

const calculateAftertreatmentHealth = (data) => {
    const checks = [data.def_level, data.def_temp, data.dpf_intake_temp, data.dpf_outlet_temp, data.scr_intake_temp, data.scr_outlet_temp]
        .filter(hasNumber);
    if (checks.length < 3) return { label: 'INSUFFICIENT DATA', color: '#64748b', score: null };
    const thermalChecks = [data.dpf_intake_temp, data.dpf_outlet_temp, data.scr_intake_temp, data.scr_outlet_temp]
        .filter(hasNumber).map(Number);
    const thermalOk = thermalChecks.length < 2 || Math.max(...thermalChecks) <= 750;
    const score = Math.round(((thermalOk ? 1 : 0) + (!isOn(data.dpf_lamp) ? 1 : 0) + (!isOn(data.hest_lamp) ? 1 : 0)) / 3 * 100);
    return { label: score >= 85 ? 'GOOD' : score >= 60 ? 'WATCH' : 'WARNING', color: score >= 85 ? '#22c55e' : '#fbbf24', score };
};

export default function CatEngineDashboard({ engineId = 'engine1' }) {
    const [selectedEngine, setSelectedEngine] = useState(engineId === 'engine2' ? 'engine2' : 'engine1');
    return <Box>
        <Box role="tablist" aria-label="CAT engines" sx={{ display: 'flex', gap: 1, mb: 1.5 }}>
            {['engine1','engine2'].map((id, index) => <Button key={id} role="tab" aria-selected={selectedEngine === id} variant={selectedEngine === id ? 'contained' : 'outlined'} onClick={() => setSelectedEngine(id)}>Engine {index + 1}</Button>)}
        </Box>
        <Box role="tabpanel" aria-label={selectedEngine === 'engine1' ? 'Engine 1' : 'Engine 2'}>
            <CatEngineView key={selectedEngine} engineId={selectedEngine}/>
        </Box>
    </Box>;
}
function CatEngineView({ engineId }) {
    const mapping = CAT_ENGINE_CONFIG[engineId] || CAT_ENGINE_CONFIG.engine1;
    const channels = useMemo(() => CAT_CHANNELS.map(id => id.replace('cat_engine.', mapping.source + '.')), [mapping.source]);
    const strips = useMemo(() => CAT_STRIPS.map(strip => ({ ...strip, title: engineId === 'engine1' ? 'CAT Engine 1' : 'CAT Engine 2', pens: strip.pens.map(pen => ({ ...pen, channelId: pen.channelId.replace('cat_engine.', mapping.source + '.') })) })), [mapping.source, engineId]);
    const [data, setData] = useState({});
    const [efficiency, setEfficiency] = useState({});
    const [feed, setFeed] = useState({ connected: socket.connected, stale: true, hasData: false });
    const [history, setHistory] = useState([]);

    useEffect(() => {
        const apply = (payload) => {
            const livePayload = isLiveRigPayload(payload);
            const meta = payload?._meta || {};
            const nextData = payload?.[mapping.source] || {};
            setData(nextData);
            setEfficiency(engineId === 'engine1' ? (payload?._efficiency || {}) : (payload?._efficiencyByEngine?.[mapping.source] || {}));
            setFeed({ connected: socket.connected, stale: !livePayload || meta.stale === true, hasData: Object.keys(nextData).length > 0 });
        };
        const cached = getLatestRigData();
        if (cached) apply(cached);
        const onData = (payload) => apply(payload);
        const onConnect = () => setFeed((prev) => ({ ...prev, connected: true }));
        const onDisconnect = () => setFeed((prev) => ({ ...prev, connected: false, stale: true }));
        socket.on('rig_data', onData);
        socket.on('connect', onConnect);
        socket.on('disconnect', onDisconnect);
        return () => {
            socket.off('rig_data', onData);
            socket.off('connect', onConnect);
            socket.off('disconnect', onDisconnect);
        };
    }, [mapping.source]);

    useEffect(() => {
        let mounted = true;
        const loadHistory = async () => {
            try {
                const metrics = ['run_hours', 'fuel_rate', 'def_level']
                    .filter(field => plcCatalog.some(tag => tag.measurement === mapping.source && tag.field === field))
                    .map(field => `${mapping.source}.${field}`).join(',');
                const response = await api.get(`/api/history?range=-24h&metrics=${metrics}`, { timeout: 6000 });
                if (mounted) setHistory(Array.isArray(response.data) ? response.data : []);
            } catch { if (mounted) setHistory([]); }
        };
        loadHistory();
        const timer = setInterval(loadHistory, 60000);
        return () => { mounted = false; clearInterval(timer); };
    }, [mapping.source]);

    const live = feed.connected && feed.hasData && !feed.stale;
    const [statusText, statusColor] = formatStatus(data.status);
    const activeAlerts = useMemo(() => {
        const states = [Number(data.status) >= 3, isOn(data.protect_lamp), isOn(data.amber_warning_lamp), isOn(data.red_stop_lamp), isOn(data.dpf_lamp), isOn(data.hest_lamp)];
        return states.filter(Boolean).length;
    }, [data]);
    const regenStatus = getRegenStatus(data);
    const health = useMemo(() => calculateHealth(data), [data]);
    const aftertreatmentHealth = useMemo(() => calculateAftertreatmentHealth(data), [data]);
    const historyStats = useMemo(() => {
        const rows = history.filter((row) => row && hasNumber(row.timestamp)).sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
        const fuel = rows.map((row) => row[`${mapping.source}.fuel_rate`]).filter(hasNumber).map(Number);
        const run = rows.map((row) => row[`${mapping.source}.run_hours`]).filter(hasNumber).map(Number);
        const def = rows.map((row) => row[`${mapping.source}.def_level`]).filter(hasNumber).map(Number);
        const runtime = run.length >= 2 ? Math.max(0, run[run.length - 1] - run[0]) : null;
        const avgFuel = fuel.length >= 2 ? fuel.reduce((sum, value) => sum + value, 0) / fuel.length : null;
        const defRate = def.length >= 2 && runtime > 0 ? Math.max(0, (def[0] - def[def.length - 1]) / runtime) : null;
        return { samples: rows.length, runtime, avgFuel, defRate, defHours: defRate > 0 && hasNumber(data.def_level) ? Number(data.def_level) / defRate : null };
    }, [history, data.def_level, mapping.source]);
    const utilization = hasNumber(data.load) ? Number(data.load) : null;
    const fuelIndex = hasNumber(data.load) && hasNumber(data.fuel_rate) && Number(data.fuel_rate) > 0 ? Number(data.load) / Number(data.fuel_rate) : null;

    return (
        <Box sx={{ width: '100%', pb: 3 }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', sm: 'repeat(4, minmax(0, 1fr))', lg: 'repeat(8, minmax(0, 1fr))' }, gap: 0.75, mb: 1 }}>
                <Kpi label="Engine Status" value={statusText} color={statusColor} />
                <Kpi label="Run Hours" value={valueText(data.run_hours, 1)} unit="hrs" />
                <Kpi label="Total Engine Hours" value={valueText(data.total_hours, 1)} unit="hrs" />
                <Kpi label="RPM" value={valueText(data.rpm)} unit="rpm" color="#38bdf8" />
                <Kpi label="Engine Load / Torque" value={valueText(data.load)} unit="%" color="#fbbf24" />
                <Kpi label="Fuel Rate" value={valueText(data.fuel_rate, 1)} unit="L/h" color="#22d3ee" />
                <Kpi label="Battery Voltage" value={valueText(data.battery_voltage, 1)} unit="V" />
                <Kpi label="Active Alerts" value={live ? activeAlerts : '--'} color={activeAlerts ? '#ef4444' : '#22c55e'} sub={activeAlerts ? 'Review events' : 'No active states'} />
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap' }}>
                <Box sx={{ flex: '1 1 620px', minWidth: 0 }}>
                    <Panel title="Aftertreatment System" right={<Typography sx={{ color: aftertreatmentHealth.color, fontSize: '0.7rem', fontWeight: 800 }}>HEALTH: {aftertreatmentHealth.score ?? '--'}% · {aftertreatmentHealth.label}</Typography>}>
                        <Grid container spacing={1}>
                            <Grid item xs={6} sm={4} md={3}><Metric label="Next Regeneration" value={data.next_regeneration} decimals={1} /></Grid>
                            <Grid item xs={6} sm={4} md={3}><Metric label="DEF Tank Temperature" value={data.def_temp} unit="°C" decimals={1} /></Grid>
                            <Grid item xs={6} sm={4} md={3}><Metric label="DEF Tank Level" value={data.def_level} unit="%" decimals={1} /></Grid>
                            <Grid item xs={6} sm={4} md={3}><Metric label="DPF Differential Pressure" unavailable /></Grid>
                            <Grid item xs={6} sm={4} md={3}><Metric label="DPF Soot Load" unavailable /></Grid>
                            <Grid item xs={6} sm={4} md={3}><Metric label="DPF Intake Temperature" value={data.dpf_intake_temp} unit="°C" decimals={1} /></Grid>
                            <Grid item xs={6} sm={4} md={3}><Metric label="DPF Outlet Temperature" value={data.dpf_outlet_temp} unit="°C" decimals={1} /></Grid>
                            <Grid item xs={6} sm={4} md={3}><Metric label="SCR Intake Temperature" value={data.scr_intake_temp} unit="°C" decimals={1} /></Grid>
                            <Grid item xs={6} sm={4} md={3}><Metric label="SCR Outlet Temperature" value={data.scr_outlet_temp} unit="°C" decimals={1} /></Grid>
                            <Grid item xs={6} sm={4} md={3}><Lamp label="DPF Lamp" value={data.dpf_lamp} /></Grid>
                            <Grid item xs={6} sm={4} md={3}><Lamp label="HEST Lamp" value={data.hest_lamp} /></Grid>
                            <Grid item xs={6} sm={4} md={3}><Metric label="Regen Status" value={regenStatus} color={regenStatus === 'IDLE' || regenStatus === 'NORMAL' ? '#22c55e' : '#fbbf24'} /></Grid>
                        </Grid>
                    </Panel>

                    <Grid container spacing={1.5} sx={{ mt: 0 }}>
                        <Grid item xs={12}>
                            <Panel title="Runtime & Efficiency Analytics">
                                <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-start' }}>
                                    <RingGauge label="Engine Health" value={health.score} color={health.color} status={health.label === 'GOOD' ? 'Good' : health.label} />
                                    <RingGauge label="Utilization" value={utilization} color="#38bdf8" status={hasNumber(utilization) ? 'Load-based' : 'NO DATA'} />
                                    <RingGauge label="Fuel Efficiency" value={efficiency.conversionPct} color="#fbbf24" status={hasNumber(efficiency.conversionPct) ? 'On Target' : 'NO DATA'} />
                                    <RingGauge label="Aftertreatment Health" value={aftertreatmentHealth.score} color={aftertreatmentHealth.color} status={aftertreatmentHealth.label === 'GOOD' ? 'Good' : aftertreatmentHealth.label} />
                                    <Box sx={{ minWidth: 128, flex: 1, pl: 0.5 }}>
                                        <Typography sx={{ color: 'text.secondary', fontSize: '0.65rem', mb: 0.8 }}>Today's Runtime <strong style={{ color: '#e2e8f0', float: 'right' }}>{historyStats.runtime == null ? '--' : `${historyStats.runtime.toFixed(1)} h`}</strong></Typography>
                                        <Typography sx={{ color: 'text.secondary', fontSize: '0.65rem', mb: 0.8 }}>Last 24h Avg Fuel Rate <strong style={{ color: '#e2e8f0', float: 'right' }}>{historyStats.avgFuel == null ? '--' : `${historyStats.avgFuel.toFixed(1)} L/h`}</strong></Typography>
                                        <Typography sx={{ color: 'text.secondary', fontSize: '0.65rem' }}>Target Fuel Efficiency <strong style={{ color: '#e2e8f0', float: 'right' }}>--</strong></Typography>
                                    </Box>
                                </Box>
                            </Panel>
                        </Grid>
                        <Grid item xs={12}>
                            <Panel title="Operational Insights & Recommendations">
                                {health.label === 'GOOD' ? <Insight title="Engine Operating Normally" text={`Rule-based health: ${health.score}% from status, oil pressure, coolant condition, coolant level and lamp inputs.`} color="#22c55e" /> : <Insight title={health.label} text="Recommendations are limited to configured inputs with valid live values." color="#fbbf24" />}
                                {historyStats.defHours != null ? <Insight title="DEF Refill Planning" text={`Observed DEF consumption is ${historyStats.defRate.toFixed(2)}% per operating hour; estimated remaining time is ${historyStats.defHours.toFixed(1)} h. Plan refill during a planned stop.`} /> : <Insight title="DEF Refill Estimate Unavailable" text="INSUFFICIENT DATA FOR DEF LIFE ESTIMATE" color="#fbbf24" />}
                                <Insight title={regenStatus === 'IDLE' || regenStatus === 'NORMAL' ? 'Regeneration State Normal' : 'Review Regeneration State'} text={`Current aftertreatment state: ${regenStatus}.`} color={regenStatus === 'IDLE' || regenStatus === 'NORMAL' ? '#22c55e' : '#fbbf24'} />
                            </Panel>
                        </Grid>
                    </Grid>

                </Box>

                <Box sx={{ flex: { xs: '1 1 100%', lg: '0 0 420px' }, width: { xs: '100%', lg: 420 }, minHeight: { xs: 420, lg: 650 }, height: { lg: 'calc(100vh - 220px)' }, display: 'flex', flexDirection: 'column' }}>
                    <Panel title="Engine Trends" right={<Button size="small" sx={{ minWidth: 0, color: 'primary.main', fontSize: '0.65rem' }}>LIVE</Button>} sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                        <Box sx={{ flex: 1, minHeight: 0 }}><EdrView mode="compact" storageKey={`edr-${engineId}`} defaultStrips={strips} channels={channels} /></Box>
                    </Panel>
                </Box>
            </Box>
        </Box>
    );
}
