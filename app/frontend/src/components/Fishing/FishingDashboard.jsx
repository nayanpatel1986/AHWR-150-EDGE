import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Typography, Paper, Grid, TextField, Button, Alert, LinearProgress, Tooltip as MuiTooltip, useTheme } from '@mui/material';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, AreaChart, Area } from 'recharts';
import { Anchor, Activity, ArrowDown, ArrowUp, Clock, RefreshCw } from 'lucide-react';
import { isLiveRigPayload, socket } from '../../socket';
import axios from '../../api';

// Semantic status colors (kept across all themes intentionally).
const STATUS = { ok: '#22c55e', warn: '#fbbf24', fail: '#ef4444' };
const ACCENT = '#fbbf24'; // fishing section accent
const FISHING_HISTORY_METRICS = [
    'drawworks.hook_load',
    'drilling.bit_depth',
    'htd.torque',
    'htd.rpm',
    'mudpump.pressure'
];

const FishingDashboard = () => {
    const theme = useTheme();
    const [timeRange, setTimeRange] = useState('-12h');
    const [customRange, setCustomRange] = useState({ start: '', end: '' });
    const [isCustom, setIsCustom] = useState(false);
    const [showCustomDate, setShowCustomDate] = useState(false);

    // 1. Critical Hoisting Parameters
    const [hoisting, setHoisting] = useState({
        hookLoad: 0,        // tons
        stringWeight: 210,  // tons (Tare / Free String Weight) - USER INPUT
        slackOffWeight: 0,  // tons
        blockPosition: 0    // mm
    });

    // 2. Depth & Speed
    const [depth, setDepth] = useState({
        bitDepth: 0,        // m, from drilling.bit_depth PLC tag
        fishTopDepth: 5150, // m - USER INPUT
        lineSpeed: 0        // m/min
    });

    // 3. Jarring
    const [jarring, setJarring] = useState({
        upImpacts: 12,
        downImpacts: 5,
        lastImpactLoad: 80 // tons
    });

    // 4. Pressure & Pumping. Pump pressure is SPP-Bar from PLC DB3191.R72,
    // normalized by the backend as mudpump.pressure.
    const [pressure, setPressure] = useState({
        tbg: 2500, // psi
        csg: 500,  // psi
        pump: 0    // bar
    });

    // 5. HTD rotation
    const [rotation, setRotation] = useState({
        rpm: 0,
        torque: 0 // daN·m (HTD torque)
    });

    // 6. Weight on bit (tons) — mapped from drilling.wob, useful while milling/washing over a fish.
    const [wob, setWob] = useState(0);

    const [graphData, setGraphData] = useState([]);
    const [alarms, setAlarms] = useState([]);

    const makePoint = useCallback((data, timestamp = Date.now()) => {
        const hookload = Number(data?.drawworks?.hook_load ?? data?.['drawworks.hook_load'] ?? data?.hookload);
        const bitDepth = Number(data?.drilling?.bit_depth ?? data?.['drilling.bit_depth'] ?? data?.depth);
        const torque = Number(data?.htd?.torque ?? data?.['htd.torque'] ?? data?.torque);
        const safeHookload = Number.isFinite(hookload) ? hookload : 0;
        return {
            timestamp,
            time: new Date(timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            hookload: safeHookload,
            depth: Number.isFinite(bitDepth) ? bitDepth : 0,
            overpull: Math.max(0, safeHookload - hoisting.stringWeight),
            torque: Number.isFinite(torque) ? torque : 0
        };
    }, [hoisting.stringWeight]);

    const getRangeMs = useCallback((range) => {
        if (range === '-1m') return 60 * 1000;
        if (range === '-5m') return 5 * 60 * 1000;
        if (range === '-10m') return 10 * 60 * 1000;
        if (range === '-15m') return 15 * 60 * 1000;
        if (range === '-30m') return 30 * 60 * 1000;
        if (range === '-1h') return 60 * 60 * 1000;
        if (range === '-12h') return 12 * 60 * 60 * 1000;
        return 12 * 60 * 60 * 1000;
    }, []);

    const activeRangeLabel = useMemo(() => {
        if (isCustom && customRange.start && customRange.end) {
            return `${new Date(customRange.start).toLocaleString()} to ${new Date(customRange.end).toLocaleString()}`;
        }
        const labels = {
            '-1m': 'Last 1 minute',
            '-5m': 'Last 5 minutes',
            '-10m': 'Last 10 minutes',
            '-15m': 'Last 15 minutes',
            '-30m': 'Last 30 minutes',
            '-1h': 'Last 1 hour',
            '-12h': 'Last 12 hours'
        };
        return labels[timeRange] || 'Last 12 hours';
    }, [customRange.end, customRange.start, isCustom, timeRange]);

    const fetchHistory = useCallback(async (rangeOverride = null) => {
        try {
            const useCustom = rangeOverride?.start && rangeOverride?.end;
            const params = new URLSearchParams({
                metrics: FISHING_HISTORY_METRICS.join(',')
            });
            if (useCustom) {
                params.set('start', new Date(rangeOverride.start).toISOString());
                params.set('stop', new Date(rangeOverride.end).toISOString());
            } else {
                params.set('range', timeRange);
            }
            const res = await axios.get(`/api/history?${params.toString()}`);
            setGraphData(Array.isArray(res.data) ? res.data.map(row => {
                const timestamp = Number(row.timestamp) || (row.time ? Date.parse(row.time) : NaN) || Date.now();
                const hookload = Number(row.hookload ?? row['drawworks.hook_load']);
                const bitDepth = Number(row.depth ?? row['drilling.bit_depth']);
                const torque = Number(row.torque ?? row['htd.torque']);
                const safeHookload = Number.isFinite(hookload) ? hookload : 0;
                return {
                    ...row,
                    timestamp,
                    time: row.name || row.time || new Date(timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                    hookload: safeHookload,
                    depth: Number.isFinite(bitDepth) ? bitDepth : 0,
                    overpull: Number.isFinite(Number(row.overpull)) ? Number(row.overpull) : Math.max(0, safeHookload - hoisting.stringWeight),
                    torque: Number.isFinite(torque) ? torque : 0
                };
            }) : []);
        } catch (err) {
            console.error('Failed to fetch fishing history', err);
            setGraphData([]);
        }
    }, [hoisting.stringWeight, timeRange]);

    // Derived: Overpull
    const overpull = Math.max(0, hoisting.hookLoad - hoisting.stringWeight);
    const tensileLimit = 500; // tons (Pipe Limit)
    const overpullPercentage = Math.min(100, (overpull / (tensileLimit - hoisting.stringWeight)) * 100);

    // Socket Listener
    useEffect(() => {
        fetchHistory();
    }, [fetchHistory]);

    useEffect(() => {
        const handleSocketData = (data) => {
            if (!isLiveRigPayload(data)) {
                setHoisting((prev) => ({ ...prev, hookLoad: null, blockPosition: null }));
                setDepth((prev) => ({ ...prev, bitDepth: null }));
                setRotation((prev) => ({ ...prev, rpm: null, torque: null }));
                setPressure((prev) => ({ ...prev, pump: null }));
                setWob(null);
                setGraphData([]);
                return;
            }
            if (data.drawworks) {
                setHoisting(prev => ({
                    ...prev,
                    hookLoad: Number(data.drawworks.hook_load) || 0,
                    blockPosition: Number(data.drawworks.block_position) || 0
                }));
            }
            if (data.htd) {
                setRotation(prev => ({
                    ...prev,
                    rpm: Number(data.htd.rpm) || 0,
                    torque: Number(data.htd.torque) || 0
                }));
            }
            if (data.mudpump) {
                setPressure(prev => ({
                    ...prev,
                    pump: Number(data.mudpump.pressure ?? data.AHWR?.['SPP-Bar']) || 0
                }));
            }
            if (data.drilling) {
                setDepth(prev => ({
                    ...prev,
                    bitDepth: Number(data.drilling.bit_depth) || 0
                }));
                if (data.drilling.wob != null) setWob(Number(data.drilling.wob) || 0);
            }

            const timestamp = Date.now();
            const livePoint = makePoint(data, timestamp);

            // Update graph with live data
            setGraphData(prev => {
                const newData = [...prev];
                newData.push(livePoint);

                const cutoff = timestamp - getRangeMs(timeRange);
                const filtered = newData
                    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
                    .filter(point => (point.timestamp || 0) >= cutoff);

                if (filtered.length > 2000) filtered.splice(0, filtered.length - 2000);
                return filtered;
            });
        };

        socket.on('rig_data', handleSocketData);
        return () => socket.off('rig_data', handleSocketData);
    }, [getRangeMs, makePoint, timeRange]);

    useEffect(() => {
        if (!isCustom) fetchHistory();
    }, [fetchHistory, isCustom, timeRange]);

    // Safety Alarms Logic
    useEffect(() => {
        const newAlarms = [];
        if (overpull > 100) newAlarms.push({ id: 'overpull', msg: 'HIGH OVERPULL WARNING', severity: 'error' });
        if (pressure.pump > 300) newAlarms.push({ id: 'pump', msg: 'PUMP OVERPRESSURE', severity: 'warning' });
        setAlarms(newAlarms);
    }, [overpull, pressure.pump]);

    const applyCustomRange = () => {
        if (!customRange.start || !customRange.end) return;
        const start = new Date(customRange.start).getTime();
        const end = new Date(customRange.end).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        setIsCustom(true);
        setShowCustomDate(false);
        fetchHistory({ start: customRange.start, end: customRange.end });
    };

    const handlePresetClick = (val) => {
        setIsCustom(false);
        setTimeRange(val);
        setCustomRange({ start: '', end: '' });
    };

    const activeWindow = useMemo(() => {
        if (isCustom && customRange.start && customRange.end) {
            const start = new Date(customRange.start).getTime();
            const end = new Date(customRange.end).getTime();
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
                return { start, end };
            }
        }
        const end = Date.now();
        return { start: end - getRangeMs(timeRange), end };
    }, [customRange.end, customRange.start, getRangeMs, isCustom, timeRange]);

    const chartData = useMemo(() => {
        return graphData
            .filter(point => {
                const ts = point.timestamp || (point.time ? Date.parse(point.time) : NaN);
                return Number.isFinite(ts) ? ts >= activeWindow.start && ts <= activeWindow.end : true;
            })
            .map(point => ({
                ...point,
                timestamp: point.timestamp || Date.now()
            }));
    }, [activeWindow.end, activeWindow.start, graphData]);

    const axisColor = theme.palette.text.secondary;
    const gridColor = theme.palette.divider;

    // Compact value tile (matches the equipment dashboards): big value + unit +
    // label + a thin range bar that turns amber/red near a configured limit.
    const ValueTile = ({ label, value, unit, decimals = 0, color = '#38bdf8', min = 0, max, warn, crit, sub }) => {
        const num = Number(value);
        const has = Number.isFinite(num);
        const display = has ? num.toFixed(decimals) : '--';
        let accent = color;
        let ratio = null;
        if (has && Number.isFinite(max) && max > min) {
            ratio = Math.min(Math.max((num - min) / (max - min), 0), 1);
            if (crit != null && num >= crit) accent = STATUS.fail;
            else if (warn != null && num >= warn) accent = STATUS.warn;
        }
        return (
            <Paper sx={{ p: 1.5, bgcolor: theme.palette.background.paper, border: '1px solid', borderColor: accent === color ? theme.palette.divider : accent, borderRadius: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', fontSize: '0.66rem' }} noWrap>{label}</Typography>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mt: 0.25 }}>
                    <Typography sx={{ color: accent, fontWeight: 800, fontSize: '1.6rem', lineHeight: 1.05 }}>{display}</Typography>
                    {unit && <Typography sx={{ color: theme.palette.text.secondary, fontWeight: 600, fontSize: '0.76rem' }}>{unit}</Typography>}
                </Box>
                {ratio != null && (
                    <Box sx={{ mt: 'auto', pt: 1 }}>
                        <Box sx={{ height: 5, borderRadius: 3, bgcolor: theme.palette.action.hover, overflow: 'hidden' }}>
                            <Box sx={{ width: `${ratio * 100}%`, height: '100%', bgcolor: accent, borderRadius: 3, transition: 'width .4s ease' }} />
                        </Box>
                    </Box>
                )}
                {sub && <Typography variant="caption" sx={{ color: theme.palette.text.secondary, mt: ratio != null ? 0.5 : 'auto', pt: ratio != null ? 0 : 1, fontSize: '0.62rem' }} noWrap>{sub}</Typography>}
            </Paper>
        );
    };

    const SectionTitle = ({ children }) => (
        <Typography sx={{ color: theme.palette.text.secondary, fontSize: '0.7rem', fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', mb: 1 }}>{children}</Typography>
    );

    return (
        <Box sx={{ color: theme.palette.text.primary }}>
            {/* Main content column */}
            <Box sx={{ width: '100%', minWidth: 0 }}>
                {/* Header */}
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>


                    {/* Alarms Banner */}
                    <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                        {alarms.map(alarm => (
                            <Alert key={alarm.id} severity={alarm.severity} variant="filled" sx={{ fontWeight: 'bold', py: 0 }}>
                                {alarm.msg}
                            </Alert>
                        ))}
                    </Box>
                </Box>

                <Grid container spacing={2}>
                    {/* --- LEFT COLUMN: CRITICAL HOISTING --- */}
                    <Grid item xs={12} md={3}>
                        <Typography variant="subtitle1" sx={{ color: ACCENT, mb: 1.5, fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1 }}>
                            <ArrowUp size={18} /> Critical Hoisting (Primary)
                        </Typography>

                        <Grid container spacing={2}>
                            <Grid item xs={6} md={12}>
                                <ValueTile
                                    label="Actual Hook Load"
                                    value={hoisting.hookLoad}
                                    decimals={1}
                                    unit="tons"
                                    color="#38bdf8"
                                    min={0}
                                    max={tensileLimit}
                                    warn={tensileLimit * 0.8}
                                    crit={tensileLimit * 0.92}
                                    sub={`String Wt (Tare): ${hoisting.stringWeight} t`}
                                />
                            </Grid>
                            <Grid item xs={6} md={12}>
                                <ValueTile
                                    label="String Weight"
                                    value={hoisting.stringWeight}
                                    decimals={0}
                                    unit="tons"
                                    color="#a78bfa"
                                    sub="Free / tare weight (input)"
                                />
                            </Grid>
                            <Grid item xs={12} sm={6} md={12}>
                                <Paper sx={{ p: 1.5, bgcolor: theme.palette.background.paper, border: `1px solid ${STATUS.fail}`, height: '100%' }}>
                                    <Typography variant="caption" sx={{ color: STATUS.fail, fontWeight: 'bold' }}>CALCULATED OVERPULL</Typography>
                                    <Typography variant="h3" sx={{ color: STATUS.fail, fontWeight: 'bold' }}>
                                        {overpull.toFixed(2)} <span style={{ fontSize: '0.4em' }}>tons</span>
                                    </Typography>
                                    <Box sx={{ mt: 1.5 }}>
                                        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>Tensile Limit Utilized</Typography>
                                            <Typography variant="caption" sx={{ color: overpullPercentage > 80 ? STATUS.fail : ACCENT }}>{overpullPercentage.toFixed(2)}%</Typography>
                                        </Box>
                                        <LinearProgress
                                            variant="determinate"
                                            value={overpullPercentage}
                                            sx={{ height: 10, borderRadius: 1, bgcolor: theme.palette.divider, '& .MuiLinearProgress-bar': { bgcolor: overpullPercentage > 80 ? STATUS.fail : ACCENT } }}
                                        />
                                    </Box>
                                </Paper>
                            </Grid>

                            <Grid item xs={12}>
                                <Box sx={{ p: 1.5, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, borderRadius: 1 }}>
                                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>SETTINGS</Typography>
                                    <Grid container spacing={1} sx={{ mt: 0.5 }}>
                                        <Grid item xs={6}>
                                            <TextField
                                                label="String Wt (tons)"
                                                type="number"
                                                size="small"
                                                fullWidth
                                                value={hoisting.stringWeight}
                                                onChange={(e) => setHoisting({ ...hoisting, stringWeight: Number(e.target.value) })}
                                                sx={{ bgcolor: theme.palette.background.default, input: { color: theme.palette.text.primary }, label: { color: theme.palette.text.secondary }, '.MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.divider } }}
                                            />
                                        </Grid>
                                        <Grid item xs={6}>
                                            <TextField
                                                label="Tensile Limit"
                                                type="number"
                                                size="small"
                                                fullWidth
                                                value={tensileLimit}
                                                disabled
                                                sx={{ bgcolor: theme.palette.background.default, input: { color: theme.palette.text.primary }, label: { color: theme.palette.text.secondary }, '.MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.divider } }}
                                            />
                                        </Grid>
                                    </Grid>
                                </Box>
                            </Grid>
                        </Grid>
                    </Grid>

                    {/* --- CENTER: GRAPHS & VISUALS --- */}
                    <Grid item xs={12} md={6}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
                            <Typography variant="subtitle1" sx={{ color: ACCENT, fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1 }}>
                                <Activity size={18} /> Operation Analytics
                            </Typography>
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                {activeRangeLabel}
                            </Typography>
                        </Box>

                        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 1.5, flexWrap: 'wrap' }}>
                            <Box sx={{ position: 'relative' }}>
                                <MuiTooltip title="Custom range">
                                    <Button
                                        variant="outlined"
                                        onClick={() => setShowCustomDate(!showCustomDate)}
                                        sx={{ color: theme.palette.text.primary, borderColor: theme.palette.divider, height: '100%', bgcolor: theme.palette.background.paper, minWidth: '40px', px: 1 }}
                                    >
                                        <Clock size={20} />
                                    </Button>
                                </MuiTooltip>
                                {showCustomDate && (
                                    <Paper sx={{ position: 'absolute', top: '100%', left: 0, mt: 1, p: 2, bgcolor: theme.palette.background.default, border: `1px solid ${theme.palette.divider}`, zIndex: 50, width: 'max-content' }}>
                                        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                                            <Typography sx={{ color: theme.palette.text.secondary, fontSize: '0.875rem', fontWeight: 'bold' }}>CUSTOM RANGE</Typography>
                                            <Box
                                                component="input"
                                                type="datetime-local"
                                                value={customRange.start}
                                                onChange={(e) => setCustomRange(prev => ({ ...prev, start: e.target.value }))}
                                                sx={{ bgcolor: 'transparent', color: theme.palette.text.primary, border: `1px solid ${theme.palette.divider}`, borderRadius: '4px', p: '4px', colorScheme: theme.palette.mode === 'dark' ? 'dark' : 'light' }}
                                            />
                                            <Box component="span" sx={{ color: theme.palette.text.secondary }}>-</Box>
                                            <Box
                                                component="input"
                                                type="datetime-local"
                                                value={customRange.end}
                                                onChange={(e) => setCustomRange(prev => ({ ...prev, end: e.target.value }))}
                                                sx={{ bgcolor: 'transparent', color: theme.palette.text.primary, border: `1px solid ${theme.palette.divider}`, borderRadius: '4px', p: '4px', colorScheme: theme.palette.mode === 'dark' ? 'dark' : 'light' }}
                                            />
                                            <Button variant="contained" size="small" onClick={applyCustomRange} sx={{ ml: 1 }}>Go</Button>
                                        </Box>
                                    </Paper>
                                )}
                            </Box>

                            <Box sx={{ width: '1px', height: '24px', bgcolor: theme.palette.divider, mx: 0.5 }} />

                            {[
                                { label: '1m', val: '-1m' },
                                { label: '5m', val: '-5m' },
                                { label: '10m', val: '-10m' },
                                { label: '15m', val: '-15m' },
                                { label: '30m', val: '-30m' },
                                { label: '1h', val: '-1h' },
                                { label: '12h', val: '-12h' }
                            ].map((opt) => {
                                const active = !isCustom && timeRange === opt.val;
                                return (
                                    <Button
                                        key={opt.val}
                                        variant={active ? 'contained' : 'outlined'}
                                        onClick={() => handlePresetClick(opt.val)}
                                        size="small"
                                        sx={{
                                            color: active ? theme.palette.getContrastText(theme.palette.primary.main) : theme.palette.text.secondary,
                                            borderColor: theme.palette.divider,
                                            minWidth: '40px',
                                            textTransform: 'none',
                                            fontWeight: 'bold'
                                        }}
                                    >
                                        {opt.label}
                                    </Button>
                                );
                            })}

                            <Button
                                variant="outlined"
                                startIcon={<RefreshCw size={16} />}
                                onClick={fetchHistory}
                                sx={{ color: theme.palette.primary.main, borderColor: theme.palette.divider, ml: 0.5 }}
                            >
                                Resync
                            </Button>
                        </Box>

                        <Paper sx={{ p: 1.5, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, mb: 2, height: 280 }}>
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>WOH vs DEPTH (Trend)</Typography>
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={chartData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                                    <XAxis dataKey="time" stroke={axisColor} />
                                    <YAxis yAxisId="left" stroke="#38bdf8" label={{ value: 'HKLD (tons)', angle: -90, position: 'insideLeft', fill: '#38bdf8' }} />
                                    <YAxis yAxisId="right" orientation="right" stroke={ACCENT} label={{ value: 'Depth (m)', angle: 90, position: 'insideRight', fill: ACCENT }} />
                                    <Tooltip contentStyle={{ backgroundColor: theme.palette.background.default, border: `1px solid ${theme.palette.divider}` }} />
                                    <Legend />
                                    <Line yAxisId="left" type="monotone" dataKey="hookload" stroke="#38bdf8" dot={false} strokeWidth={2} />
                                    <Line yAxisId="right" type="monotone" dataKey="depth" stroke={ACCENT} dot={false} strokeWidth={2} />
                                </LineChart>
                            </ResponsiveContainer>
                        </Paper>

                        <Paper sx={{ p: 1.5, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, height: 230 }}>
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>OVERPULL HISTORY</Typography>
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={chartData}>
                                    <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                                    <XAxis dataKey="time" stroke={axisColor} />
                                    <YAxis stroke={STATUS.fail} />
                                    <Tooltip contentStyle={{ backgroundColor: theme.palette.background.default, border: `1px solid ${theme.palette.divider}` }} />
                                    <Area type="monotone" dataKey="overpull" stroke={STATUS.fail} fill={STATUS.fail} fillOpacity={0.3} />
                                </AreaChart>
                            </ResponsiveContainer>
                        </Paper>
                    </Grid>

                    {/* --- HOISTING & POSITION --- */}
                    <Grid item xs={12} md={3}>
                        <SectionTitle>Hoisting &amp; Position</SectionTitle>
                        <Grid container spacing={1.5}>
                            <Grid item xs={6}>
                                <ValueTile label="Bit Depth" value={depth.bitDepth} decimals={1} unit="m" color={STATUS.ok} />
                            </Grid>
                            <Grid item xs={6}>
                                <ValueTile label="Fish Top" value={depth.fishTopDepth} decimals={0} unit="m" color={ACCENT} sub="Target (input)" />
                            </Grid>
                            <Grid item xs={6}>
                                <ValueTile label="Block Position" value={hoisting.blockPosition} decimals={0} unit="mm" color="#22d3ee" min={0} max={40000} />
                            </Grid>
                            <Grid item xs={6}>
                                <ValueTile label="Weight on Bit" value={wob} decimals={1} unit="t" color="#818cf8" min={0} max={100} warn={80} crit={90} sub="Mill / wash-over" />
                            </Grid>
                            <Grid item xs={12}>
                                <Box sx={{ p: 1.25, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, borderRadius: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', height: '100%' }}>
                                    <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>Distance to Fish</Typography>
                                    <Typography variant="h6" sx={{ color: theme.palette.text.primary, fontWeight: 'bold' }}>
                                        {(depth.fishTopDepth - depth.bitDepth).toFixed(2)} m
                                    </Typography>
                                </Box>
                            </Grid>
                        </Grid>

                        <Box sx={{ mt: 2 }}>
                            <SectionTitle>Jarring Ops</SectionTitle>
                            <Box sx={{ display: 'flex', gap: 1.5 }}>
                                <Paper sx={{ flex: 1, p: 1.5, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, borderRadius: 2, textAlign: 'center' }}>
                                    <ArrowUp size={24} color="#38bdf8" style={{ margin: 'auto' }} />
                                    <Typography variant="h5" sx={{ fontWeight: 'bold', mt: 0.5, color: theme.palette.text.primary }}>{jarring.upImpacts}</Typography>
                                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>UP JARS</Typography>
                                </Paper>
                                <Paper sx={{ flex: 1, p: 1.5, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, borderRadius: 2, textAlign: 'center' }}>
                                    <ArrowDown size={24} color={ACCENT} style={{ margin: 'auto' }} />
                                    <Typography variant="h5" sx={{ fontWeight: 'bold', mt: 0.5, color: theme.palette.text.primary }}>{jarring.downImpacts}</Typography>
                                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>DOWN JARS</Typography>
                                </Paper>
                            </Box>
                        </Box>

                        <Box sx={{ mt: 2 }}>
                            <SectionTitle>Pump &amp; Rotation</SectionTitle>
                            <Grid container spacing={1.5}>
                                <Grid item xs={6}>
                                    <ValueTile label="Pump Press" value={pressure.pump} decimals={1} unit="bar" color="#f472b6" min={0} max={500} warn={240} crit={300} />
                                </Grid>
                                <Grid item xs={6}>
                                    <ValueTile label="HTD RPM" value={rotation.rpm} decimals={0} unit="rpm" color="#38bdf8" min={0} max={250} warn={200} crit={230} />
                                </Grid>
                                <Grid item xs={6}>
                                    <ValueTile label="HTD TORQUE" value={rotation.torque} decimals={0} unit={"daN\u00B7m"} color="#a78bfa" min={0} max={2000} warn={1500} crit={1800} />
                                </Grid>
                                <Grid item xs={6}>
                                    <ValueTile label="Tubing Press" value={pressure.tbg} decimals={0} unit="psi" color="#fbbf24" min={0} max={5000} warn={4000} crit={4500} />
                                </Grid>
                            </Grid>
                        </Box>
                    </Grid>

                </Grid>
            </Box>
        </Box>
    );
};

export default FishingDashboard;
