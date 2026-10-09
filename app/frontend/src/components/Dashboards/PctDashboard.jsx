import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box, Divider, useTheme } from '@mui/material';
import { getLatestRigData, isLiveRigPayload, socket } from '../../socket';
import EdrView from '../EDR/EdrView';

// ---- Local reusable presentational helpers (flatter/denser than analog dials) ----

const ValueTile = ({ label, value, unit, decimals = 0, color = 'primary.main', min = 0, max, warn, crit, sub }) => {
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
                <Typography sx={{ color: accent, fontWeight: 800, fontSize: '1.6rem', lineHeight: 1.05 }}>{display}</Typography>
                {unit && <Typography sx={{ color: 'text.secondary', fontWeight: 600, fontSize: '0.74rem' }}>{unit}</Typography>}
            </Box>
            {ratio != null && (
                <Box sx={{ mt: 'auto', pt: 1 }}>
                    <Box sx={{ height: 5, borderRadius: 3, bgcolor: 'action.hover', overflow: 'hidden' }}>
                        <Box sx={{ width: `${ratio * 100}%`, height: '100%', bgcolor: accent, borderRadius: 3, transition: 'width .4s ease' }} />
                    </Box>
                </Box>
            )}
            {sub && <Typography variant="caption" sx={{ color: 'text.secondary', mt: ratio != null ? 0.5 : 'auto', pt: ratio != null ? 0 : 1, fontSize: '0.62rem' }} noWrap>{sub}</Typography>}
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

// EDR side-strip config — all PCT catalog channels, including status fields.
const EDR_CHANNELS = [
    'pct.clamp_low_pressure',
    'pct.clamp_up_pressure',
    'pct.last_makeup_torque',
    'pct.makeup_torque',
    'pct.clamp_low_force',
    'pct.clamp_low_force_ok',
    'pct.clamp_low_pressure_ok',
    'pct.clamp_low_open_ok',
    'pct.clamp_rotation_status',
    'pct.clamp_up_force',
    'pct.clamp_up_force_ok',
    'pct.clamp_up_pressure_ok',
    'pct.clamp_up_open_ok',
    'pct.clamp_low_status',
    'pct.clamp_up_status',
    'pct.dolly_direction',
    'pct.dolly_status',
    'pct.op_mode',
    'pct.rotation_breakout_pressure',
    'pct.rotation_makeup_pressure',
    'pct.sequence',
    'pct.spinner_floating',
    'pct.spinner_gripper_status',
    'pct.spinner_rotation_status',
    'pct.spinner_breakout_torque',
    'pct.spinner_makeup_torque',
    'pct.status'
];
const EDR_STRIPS = [
    {
        title: 'PCT',
        pens: [
            { channelId: 'pct.makeup_torque', color: '#38bdf8', min: 0, max: 20000, enabled: true },
            { channelId: 'pct.clamp_up_pressure', color: '#4ade80', min: 0, max: 300, enabled: true },
            { channelId: 'pct.clamp_low_pressure', color: '#a78bfa', min: 0, max: 300, enabled: true }
        ]
    }
];

export default function PctDashboard() {
    const theme = useTheme();
    const surface = theme.palette.background.paper;
    const inset = theme.palette.background.default;
    const border = theme.palette.divider;
    const [data, setData] = useState({});

    useEffect(() => {
        const cached = getLatestRigData();
        if (isLiveRigPayload(cached) && cached.pct) setData(cached.pct);

        const handler = (newData) => {
            if (!isLiveRigPayload(newData)) { setData({}); return; }
            if (newData.pct) setData(newData.pct);
        };
        socket.on('rig_data', handler);
        return () => socket.off('rig_data', handler);
    }, []);

    const statusMapping = {
        0: { text: 'OFF', color: '#64748b' },
        1: { text: 'IDLE', color: '#38bdf8' },
        2: { text: 'ON', color: '#4ade80' }
    };

    const opModeMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'NORMAL', color: '#4ade80' },
        2: { text: 'MANUAL', color: '#fbbf24' }
    };

    const sequenceMapping = {
        0: { text: 'OFF', color: '#64748b' },
        1: { text: 'MAKE-UP', color: '#38bdf8' },
        2: { text: 'BREAK-OUT', color: '#fbbf24' },
        3: { text: 'RESET', color: '#94a3b8' },
        4: { text: 'FAULT', color: '#ef4444' }
    };

    const dollyDirectionMapping = {
        0: { text: 'NO CMD', color: '#64748b' },
        1: { text: 'MOVE UP', color: '#38bdf8' },
        2: { text: 'MOVE DOWN', color: '#4ade80' }
    };

    const dollyStatusMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'OUT PARK', color: '#fbbf24' },
        2: { text: 'MOVE WORK', color: '#38bdf8' },
        3: { text: 'MOVE PARK', color: '#38bdf8' },
        4: { text: 'IN PARK', color: '#4ade80' },
        5: { text: 'FAULT', color: '#ef4444' },
        6: { text: 'IN WORK', color: '#4ade80' }
    };

    const spinnerRotationMapping = {
        0: { text: 'NO CMD', color: '#64748b' },
        1: { text: 'FULLY UP', color: '#4ade80' },
        2: { text: 'FULLY DOWN', color: '#4ade80' },
        3: { text: 'MAKE-UP', color: '#38bdf8' },
        4: { text: 'BREAK-OUT', color: '#fbbf24' },
        10: { text: 'NOT MOUNTED', color: '#64748b' }
    };

    const gripperMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'OPENING', color: '#38bdf8' },
        2: { text: 'CLOSING', color: '#38bdf8' },
        3: { text: 'OPEN', color: '#4ade80' },
        4: { text: 'CLOSE', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' },
        10: { text: 'NOT MOUNTED', color: '#64748b' }
    };

    const clampRotationMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'NOT ALLIGNED', color: '#ef4444' },
        2: { text: 'ALLIGNED', color: '#4ade80' },
        3: { text: 'MAKE-UP', color: '#38bdf8' },
        4: { text: 'BREAK-OUT', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const clampStatusMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'OPENING', color: '#38bdf8' },
        2: { text: 'CLOSING', color: '#38bdf8' },
        3: { text: 'IS OPEN', color: '#4ade80' },
        4: { text: 'IS CLOSE', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const binaryMapping = (onText, offText) => ({
        0: { text: offText, color: '#64748b' },
        1: { text: onText, color: '#4ade80' }
    });

    const okMapping = { 0: { text: 'LOW', color: '#fbbf24' }, 1: { text: 'OK', color: '#4ade80' } };

    const getStatusText = (value, mapping) => mapping[value]?.text || '---';
    const getStatusColor = (value, mapping) => mapping[value]?.color || '#64748b';

    const MechanicalItem = ({ label, value, mapping }) => {
        const active = mapping[value] || { text: '---', color: '#64748b' };
        return (
            <Box sx={{ p: 1, bgcolor: inset, borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>{label}</Typography>
                <Box sx={{ bgcolor: `${active.color}1f`, color: active.color, border: `1px solid ${active.color}`, px: 1, py: 0.2, borderRadius: 1, fontWeight: 'bold', fontSize: '0.72rem', minWidth: 90, textAlign: 'center' }}>{active.text}</Box>
            </Box>
        );
    };

    // Clamp detail block: status chip header + pressure/force tiles with OK flags.
    const ClampCard = ({ title, color, statusKey, pressKey, pressOkKey, forceKey, forceOkKey }) => (
        <Box sx={{ p: 1.5, bgcolor: inset, borderRadius: 2, border: `1px solid ${border}` }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.25 }}>
                <Typography variant="subtitle2" sx={{ color, fontWeight: 800 }}>{title}</Typography>
                <Box sx={{ color: getStatusColor(data[statusKey], clampStatusMapping), fontWeight: 'bold', fontSize: '0.78rem' }}>
                    {getStatusText(data[statusKey], clampStatusMapping)}
                </Box>
            </Box>
            <Grid container spacing={1}>
                <Grid item xs={6}>
                    <Typography variant="caption" sx={{ color: '#64748b', display: 'block', fontSize: '0.6rem' }}>PRESSURE (bar)</Typography>
                    <Typography sx={{ color: 'text.primary', fontWeight: 'bold', fontSize: '1.1rem' }}>{Number(data[pressKey] || 0).toFixed(2)}</Typography>
                    <Typography variant="caption" sx={{ color: getStatusColor(data[pressOkKey], okMapping), fontSize: '0.62rem', fontWeight: 700 }}>{getStatusText(data[pressOkKey], okMapping)}</Typography>
                </Grid>
                <Grid item xs={6}>
                    <Typography variant="caption" sx={{ color: '#64748b', display: 'block', fontSize: '0.6rem' }}>FORCE (daN)</Typography>
                    <Typography sx={{ color: 'text.primary', fontWeight: 'bold', fontSize: '1.1rem' }}>{Number(data[forceKey] || 0).toFixed(2)}</Typography>
                    <Typography variant="caption" sx={{ color: getStatusColor(data[forceOkKey], okMapping), fontSize: '0.62rem', fontWeight: 700 }}>{getStatusText(data[forceOkKey], okMapping)}</Typography>
                </Grid>
            </Grid>
        </Box>
    );

    return (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 2 }}>
            {/* Main content */}
            <Box sx={{ flex: '1 1 560px', minWidth: 0 }}>
                <Grid container spacing={2}>
                    {/* Status header */}
                    <Grid item xs={12}>
                        <Paper sx={{ p: 1.75, bgcolor: surface, border: `1px solid ${border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                            <StatusChip label="System Status" value={data.status} mapping={statusMapping} />
                            <Divider orientation="vertical" flexItem sx={{ borderColor: border }} />
                            <StatusChip label="Operation Mode" value={data.op_mode} mapping={opModeMapping} />
                            <Divider orientation="vertical" flexItem sx={{ borderColor: border }} />
                            <StatusChip label="Sequence" value={data.sequence} mapping={sequenceMapping} />
                            <Divider orientation="vertical" flexItem sx={{ borderColor: border }} />
                            <StatusChip label="Clamp Rotation" value={data.clamp_rotation_status} mapping={clampRotationMapping} />
                        </Paper>
                    </Grid>

                    {/* TORQUE & ROTATION */}
                    <Grid item xs={12}>
                        <SectionTitle>Torque & Rotation</SectionTitle>
                        <Grid container spacing={1.5}>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Makeup Torque" value={data.makeup_torque} unit="daN·m" color="#38bdf8" min={0} max={20000} warn={15000} crit={18000} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Last Makeup" value={data.last_makeup_torque} unit="daN·m" color="#fbbf24" min={0} max={20000} warn={15000} crit={18000} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Spinner MU Torque" value={data.spinner_makeup_torque} unit="daN·m" color="#4ade80" min={0} max={2000} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Spinner BO Torque" value={data.spinner_breakout_torque} unit="daN·m" color="#a78bfa" min={0} max={2000} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Rotation MU Press" value={data.rotation_makeup_pressure} unit="bar" decimals={1} color="#22d3ee" min={0} max={300} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Rotation BO Press" value={data.rotation_breakout_pressure} unit="bar" decimals={1} color="#f97316" min={0} max={300} />
                            </Grid>
                        </Grid>
                    </Grid>

                    {/* CLAMPS */}
                    <Grid item xs={12} md={7}>
                        <Paper sx={{ p: 1.75, bgcolor: surface, height: '100%', border: `1px solid ${border}`, borderRadius: 2 }}>
                            <SectionTitle>Clamp Details</SectionTitle>
                            <Grid container spacing={1.5}>
                                <Grid item xs={12} sm={6}>
                                    <ClampCard title="UP CLAMP" color="#38bdf8" statusKey="clamp_up_status" pressKey="clamp_up_pressure" pressOkKey="clamp_up_pressure_ok" forceKey="clamp_up_force" forceOkKey="clamp_up_force_ok" />
                                </Grid>
                                <Grid item xs={12} sm={6}>
                                    <ClampCard title="LOW CLAMP" color="#a78bfa" statusKey="clamp_low_status" pressKey="clamp_low_pressure" pressOkKey="clamp_low_pressure_ok" forceKey="clamp_low_force" forceOkKey="clamp_low_force_ok" />
                                </Grid>
                            </Grid>
                        </Paper>
                    </Grid>

                    {/* DOLLY & SPINNER */}
                    <Grid item xs={12} md={5}>
                        <Paper sx={{ p: 1.75, bgcolor: surface, height: '100%', border: `1px solid ${border}`, borderRadius: 2 }}>
                            <SectionTitle>Dolly & Spinner</SectionTitle>
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.9 }}>
                                <MechanicalItem label="DOLLY DIRECTION" value={data.dolly_direction} mapping={dollyDirectionMapping} />
                                <MechanicalItem label="DOLLY STATUS" value={data.dolly_status} mapping={dollyStatusMapping} />
                                <MechanicalItem label="SPINNER ROTATION" value={data.spinner_rotation_status} mapping={spinnerRotationMapping} />
                                <MechanicalItem label="SPINNER GRIPPER" value={data.spinner_gripper_status} mapping={gripperMapping} />
                                <MechanicalItem label="SPINNER FLOATING" value={data.spinner_floating} mapping={binaryMapping('ON', 'OFF')} />
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
                        Power Tong Trends
                    </Typography>
                    <Box sx={{ flex: 1, minHeight: 0 }}>
                        <EdrView mode="compact" storageKey="edr-pct-1" defaultStrips={EDR_STRIPS} channels={EDR_CHANNELS} />
                    </Box>
                </Paper>
            </Box>
        </Box>
    );
}
