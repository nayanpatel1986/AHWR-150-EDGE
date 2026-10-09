import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box, Divider, useTheme } from '@mui/material';
import { getLatestRigData, isLiveRigPayload, socket } from '../../socket';
import EdrView from '../EDR/EdrView';

// ---- Local reusable presentational helpers (flatter/denser than analog dials) ----

const ValueTile = ({ label, value, unit, decimals = 0, color = 'primary.main', min = 0, max, warn, crit, sub, subColor }) => {
    const num = Number(value);
    const has = Number.isFinite(num);
    const display = has ? num.toFixed(decimals) : '--';

    let accent = color;
    let ratio = null;
    if (has && Number.isFinite(max) && max > min) {
        ratio = Math.min(Math.max((num - min) / (max - min), 0), 1);
        const wr = warn != null ? (warn - min) / (max - min) : null;
        const cr = crit != null ? (crit - min) / (max - min) : null;
        if (cr != null && ratio >= cr) accent = '#ef4444';
        else if (wr != null && ratio >= wr) accent = '#fbbf24';
    }

    return (
        <Paper sx={{ p: 1.5, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', fontSize: '0.66rem' }} noWrap>{label}</Typography>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mt: 0.25 }}>
                <Typography sx={{ color: accent, fontWeight: 800, fontSize: '1.7rem', lineHeight: 1.05 }}>{display}</Typography>
                {unit && <Typography sx={{ color: 'text.secondary', fontWeight: 600, fontSize: '0.78rem' }}>{unit}</Typography>}
            </Box>
            {ratio != null && (
                <Box sx={{ mt: 'auto', pt: 1 }}>
                    <Box sx={{ height: 5, borderRadius: 3, bgcolor: 'action.hover', overflow: 'hidden' }}>
                        <Box sx={{ width: `${ratio * 100}%`, height: '100%', bgcolor: accent, borderRadius: 3, transition: 'width .4s ease' }} />
                    </Box>
                </Box>
            )}
            {sub && <Typography variant="caption" sx={{ color: subColor || 'text.secondary', mt: ratio != null ? 0.5 : 'auto', pt: ratio != null ? 0 : 1, fontSize: '0.64rem', fontWeight: 700 }} noWrap>{sub}</Typography>}
        </Paper>
    );
};

const StatusChip = ({ label, value, mapping }) => {
    const active = mapping[value] || { text: '---', color: '#64748b' };
    return (
        <Box sx={{ textAlign: 'center', px: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5, fontSize: '0.62rem', fontWeight: 700 }}>{label.toUpperCase()}</Typography>
            <Box sx={{
                bgcolor: `${active.color}1f`,
                color: active.color,
                border: `1px solid ${active.color}`,
                px: 1.25, py: 0.5, borderRadius: 1,
                fontWeight: 'bold', fontSize: '0.78rem', whiteSpace: 'nowrap'
            }}>
                {active.text}
            </Box>
        </Box>
    );
};

const SectionTitle = ({ children }) => (
    <Typography sx={{ color: 'text.secondary', fontSize: '0.7rem', fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', mb: 1 }}>{children}</Typography>
);

// EDR side-strip config — both catwalk analogs (clamp_pressure, clamp_force) are
// catalogued in shared/edrMetrics.json. min/max are from the catalog defaults.
const EDR_CHANNELS = [
    'cwk.clamp_force',
    'cwk.clamp_pressure',
    'cwk.carrier_status',
    'cwk.clamp_status',
    'cwk.clamp_force_ok',
    'cwk.clamp_pressure_ok',
    'cwk.indexer_dx',
    'cwk.indexer_sx',
    'cwk.kickers_dx',
    'cwk.kickers_sx',
    'cwk.skate_status',
    'cwk.slide_status',
    'cwk.source_cmd',
    'cwk.status'
];
const EDR_STRIPS = [
    {
        title: 'CWK',
        pens: [
            { channelId: 'cwk.clamp_pressure', color: '#38bdf8', min: 0, max: 300, enabled: true },
            { channelId: 'cwk.clamp_force', color: '#a78bfa', min: 0, max: 1000, enabled: true }
        ]
    }
];

export default function CwkDashboard() {
    const theme = useTheme();
    const surface = theme.palette.background.paper;
    const inset = theme.palette.background.default;
    const border = theme.palette.divider;
    const [data, setData] = useState({});

    useEffect(() => {
        const cached = getLatestRigData();
        if (isLiveRigPayload(cached) && cached.cwk) setData(cached.cwk);

        const handler = (newData) => {
            if (!isLiveRigPayload(newData)) { setData({}); return; }
            if (newData.cwk) setData(newData.cwk);
        };
        socket.on('rig_data', handler);
        return () => socket.off('rig_data', handler);
    }, []);

    const statusMapping = {
        0: { text: 'NOT IN PARK', color: '#fbbf24' },
        1: { text: 'PARK POSITION', color: '#4ade80' }
    };

    const sourceMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'DCC', color: '#38bdf8' },
        2: { text: 'RADIO', color: '#a78bfa' }
    };

    const binaryMapping = (onText, offText) => ({
        1: { text: onText, color: '#4ade80' },
        2: { text: offText, color: '#fbbf24' },
        3: { text: 'FAULT', color: '#ef4444' }
    });

    const mechanicalMapping = {
        1: { text: 'IDLE', color: '#64748b' },
        2: { text: 'PARKING', color: '#38bdf8' },
        3: { text: 'FORWARD', color: '#4ade80' },
        4: { text: 'BACKWARD', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const carrierMapping = {
        1: { text: 'STOP', color: '#64748b' },
        2: { text: 'PARK POS', color: '#64748b' },
        3: { text: 'WORK POS', color: '#4ade80' },
        4: { text: 'LIFTING', color: '#38bdf8' },
        5: { text: 'LOWERING', color: '#fbbf24' },
        6: { text: 'FAULT', color: '#ef4444' }
    };

    const clampMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'OPENING', color: '#38bdf8' },
        2: { text: 'CLOSING', color: '#38bdf8' },
        3: { text: 'IS OPEN', color: '#4ade80' },
        4: { text: 'IS CLOSE', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const okMapping = {
        0: { text: 'NOT OK', color: '#ef4444' },
        1: { text: 'OK', color: '#4ade80' }
    };

    const getStatusText = (value, mapping) => mapping[value]?.text || '---';
    const getStatusColor = (value, mapping) => mapping[value]?.color || '#64748b';

    const MechanicalItem = ({ label, value, mapping }) => {
        const active = mapping[value] || { text: '---', color: '#64748b' };
        return (
            <Box sx={{ p: 1, bgcolor: inset, borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>{label}</Typography>
                <Box sx={{ bgcolor: `${active.color}1f`, color: active.color, border: `1px solid ${active.color}`, px: 1, py: 0.2, borderRadius: 1, fontWeight: 'bold', fontSize: '0.72rem', minWidth: 84, textAlign: 'center' }}>{active.text}</Box>
            </Box>
        );
    };

    const panelSx = { p: 1.75, bgcolor: surface, height: '100%', border: `1px solid ${border}`, borderRadius: 2 };

    return (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 2 }}>
            {/* Main content */}
            <Box sx={{ flex: '1 1 560px', minWidth: 0 }}>
                <Grid container spacing={2}>
                    {/* Status header */}
                    <Grid item xs={12}>
                        <Paper sx={{ p: 1.75, bgcolor: surface, border: `1px solid ${border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                            <StatusChip label="Global Status" value={data.status} mapping={statusMapping} />
                            <Divider orientation="vertical" flexItem sx={{ borderColor: border }} />
                            <StatusChip label="Source Cmd" value={data.source_cmd} mapping={sourceMapping} />
                            <Divider orientation="vertical" flexItem sx={{ borderColor: border }} />
                            <StatusChip label="Clamp" value={data.clamp_status} mapping={clampMapping} />
                            <Divider orientation="vertical" flexItem sx={{ borderColor: border }} />
                            <StatusChip label="Carrier" value={data.carrier_status} mapping={carrierMapping} />
                        </Paper>
                    </Grid>

                    {/* CLAMP MEASUREMENTS */}
                    <Grid item xs={12}>
                        <SectionTitle>Clamp Measurements</SectionTitle>
                        <Grid container spacing={1.5}>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Clamp Pressure" value={data.clamp_pressure} unit="bar" decimals={2} color="#38bdf8" min={0} max={250} warn={200} crit={230}
                                    sub={getStatusText(data.clamp_pressure_ok, okMapping)} subColor={getStatusColor(data.clamp_pressure_ok, okMapping)} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Clamp Force" value={data.clamp_force} unit="daN" decimals={2} color="#a78bfa" min={0} max={1000} warn={850} crit={950}
                                    sub={getStatusText(data.clamp_force_ok, okMapping)} subColor={getStatusColor(data.clamp_force_ok, okMapping)} />
                            </Grid>
                        </Grid>
                    </Grid>

                    {/* COMPONENTS */}
                    <Grid item xs={12} sm={6} md={6}>
                        <Paper sx={panelSx}>
                            <SectionTitle>Indexers & Kickers</SectionTitle>
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.9 }}>
                                <MechanicalItem label="INDEXER DX" value={data.indexer_dx} mapping={binaryMapping('UP', 'DOWN')} />
                                <MechanicalItem label="INDEXER SX" value={data.indexer_sx} mapping={binaryMapping('UP', 'DOWN')} />
                                <MechanicalItem label="KICKERS DX" value={data.kickers_dx} mapping={binaryMapping('EXTEND', 'RETRACT')} />
                                <MechanicalItem label="KICKERS SX" value={data.kickers_sx} mapping={binaryMapping('EXTEND', 'RETRACT')} />
                            </Box>
                        </Paper>
                    </Grid>

                    {/* SKATE / SLIDE / CARRIER / CLAMP */}
                    <Grid item xs={12} sm={6} md={6}>
                        <Paper sx={panelSx}>
                            <SectionTitle>Motion & Handling</SectionTitle>
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.9 }}>
                                <MechanicalItem label="SKATE" value={data.skate_status} mapping={mechanicalMapping} />
                                <MechanicalItem label="SLIDE" value={data.slide_status} mapping={mechanicalMapping} />
                                <MechanicalItem label="CARRIER" value={data.carrier_status} mapping={carrierMapping} />
                                <MechanicalItem label="CLAMP STATUS" value={data.clamp_status} mapping={clampMapping} />
                            </Box>
                        </Paper>
                    </Grid>
                </Grid>
            </Box>

            {/* Persistent EDR side strip */}
            <Box
                sx={{
                    flex: { xs: '1 1 100%', lg: '0 0 400px' },
                    width: { xs: '100%', lg: 400 },
                    minHeight: { xs: 420, lg: 560 },
                    height: { lg: 'calc(100vh - 220px)' },
                    display: 'flex',
                    flexDirection: 'column'
                }}
            >
                <Paper sx={{ flex: 1, minHeight: 0, p: 1.25, bgcolor: surface, border: `1px solid ${border}`, borderRadius: 2, display: 'flex', flexDirection: 'column' }}>
                    <Typography sx={{ color: 'text.secondary', fontSize: '0.72rem', fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', mb: 0.75 }}>
                        Catwalk Trends
                    </Typography>
                    <Box sx={{ flex: 1, minHeight: 0 }}>
                        <EdrView mode="compact" storageKey="edr-cwk-1" defaultStrips={EDR_STRIPS} channels={EDR_CHANNELS} />
                    </Box>
                </Paper>
            </Box>
        </Box>
    );
}
