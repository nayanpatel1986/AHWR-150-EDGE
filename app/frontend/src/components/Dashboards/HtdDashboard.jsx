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

// Row-style status chip used inside the state panels.
const StatusRow = ({ label, value, mapping, inset, border }) => {
    const active = mapping[value] || { text: '---', color: '#64748b' };
    return (
        <Box sx={{ p: 1, bgcolor: inset, borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>{label}</Typography>
            <Box sx={{ bgcolor: `${active.color}1f`, color: active.color, border: `1px solid ${active.color}`, px: 1, py: 0.2, borderRadius: 1, fontWeight: 'bold', fontSize: '0.72rem', minWidth: 86, textAlign: 'center' }}>{active.text}</Box>
        </Box>
    );
};

const SectionTitle = ({ children }) => (
    <Typography sx={{ color: 'text.secondary', fontSize: '0.7rem', fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', mb: 1 }}>{children}</Typography>
);

const formatWorkingTime = (hours, minutes) => {
    const h = Number(hours);
    const m = Number(minutes);
    if (!Number.isFinite(h) && !Number.isFinite(m)) return '--';
    const safeHours = Number.isFinite(h) ? Math.max(0, h) : 0;
    const safeMinutes = Number.isFinite(m) ? Math.max(0, m) : 0;
    if (safeMinutes >= 60) {
        const totalMinutes = Math.round((safeHours * 60) + safeMinutes);
        return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
    }
    return `${Math.floor(safeHours)}h ${Math.floor(safeMinutes)}m`;
};

// EDR side-strip config — all HTD catalog channels, including status fields.
const EDR_CHANNELS = [
    'htd.brake_status',
    'htd.rpm_command',
    'htd.elevator_status',
    'htd.gear_status',
    'htd.ibop_status',
    'htd.inclination_status',
    'htd.link_rotation_status',
    'htd.tilt_status',
    'htd.lube_status',
    'htd.op_mode',
    'htd.rpm_request',
    'htd.rotation_status',
    'htd.rpm',
    'htd.status',
    'htd.suspension_status',
    'htd.tilt_status_db65',
    'htd.torque',
    'htd.torque_command',
    'htd.torque_request',
    'htd.working_hours',
    'htd.working_minutes',
    'htd.work_mode',
    'htd.inclination',
    'htd.vertical_speed'
];
const EDR_STRIPS = [
    {
        title: 'HTD',
        pens: [
            { channelId: 'htd.rpm', color: '#38bdf8', min: 0, max: 250, enabled: true },
            { channelId: 'htd.torque', color: '#fbbf24', min: 0, max: 2000, enabled: true },
            { channelId: 'htd.vertical_speed', color: '#4ade80', min: -5, max: 5, enabled: true }
        ]
    }
];

export default function HtdDashboard() {
    const theme = useTheme();
    const surface = theme.palette.background.paper;
    const inset = theme.palette.background.default;
    const border = theme.palette.divider;
    const [data, setData] = useState({});

    useEffect(() => {
        const cached = getLatestRigData();
        if (isLiveRigPayload(cached) && cached.htd) setData(cached.htd);

        const handler = (newData) => {
            if (!isLiveRigPayload(newData)) { setData({}); return; }
            if (newData.htd) setData(newData.htd);
        };
        socket.on('rig_data', handler);
        return () => socket.off('rig_data', handler);
    }, []);

    const statusMapping = {
        0: { text: 'OFF', color: '#64748b' },
        1: { text: 'IDLE', color: '#38bdf8' },
        2: { text: 'ON', color: '#4ade80' }
    };

    const workModeMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'DRILL', color: '#4ade80' },
        2: { text: 'SPIN', color: '#38bdf8' },
        3: { text: 'TORQUE', color: '#fbbf24' }
    };

    const opModeMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'DRILLING', color: '#4ade80' },
        2: { text: 'RIG UP', color: '#38bdf8' }
    };

    const rotationMapping = {
        0: { text: 'STOPPED', color: '#64748b' },
        1: { text: 'FWD', color: '#4ade80' },
        2: { text: 'BWD', color: '#fbbf24' },
        3: { text: 'NEUTRAL', color: '#94a3b8' }
    };

    const lubeMapping = {
        0: { text: 'OFF', color: '#64748b' },
        1: { text: 'CMD RUN', color: '#38bdf8' },
        2: { text: 'RUNNING', color: '#4ade80' },
        3: { text: 'FAULT', color: '#ef4444' }
    };

    const brakeMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'CLOSING', color: '#38bdf8' },
        2: { text: 'CLOSED', color: '#fbbf24' },
        3: { text: 'OPENING', color: '#38bdf8' },
        4: { text: 'OPEN', color: '#4ade80' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const elevatorMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'OPENING', color: '#38bdf8' },
        2: { text: 'CLOSING', color: '#38bdf8' },
        3: { text: 'OPEN', color: '#4ade80' },
        4: { text: 'CLOSE', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const linkRotationMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'UNLOCKING', color: '#38bdf8' },
        2: { text: 'UNLOCKED', color: '#fbbf24' },
        3: { text: 'ROT FWD', color: '#4ade80' },
        4: { text: 'ROT BWD', color: '#fbbf24' },
        5: { text: 'LOCKING', color: '#38bdf8' },
        6: { text: 'LOCKED', color: '#4ade80' },
        7: { text: 'FAULT', color: '#ef4444' }
    };

    const gearMapping = {
        '-2': { text: 'UNKNOWN', color: '#64748b' },
        '-1': { text: 'FAULT', color: '#ef4444' },
        1: { text: 'GEAR 1', color: '#38bdf8' },
        2: { text: 'GEAR 2', color: '#38bdf8' },
        3: { text: 'GEAR 3', color: '#38bdf8' },
        4: { text: 'GEAR 4', color: '#38bdf8' },
        5: { text: 'G1 REGEN', color: '#4ade80' },
        6: { text: 'G2 REGEN', color: '#4ade80' },
        7: { text: 'G3 REGEN', color: '#4ade80' },
        8: { text: 'G4 REGEN', color: '#4ade80' }
    };

    const suspensionMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'PUSH', color: '#4ade80' },
        2: { text: 'PULL', color: '#38bdf8' }
    };

    const tiltDb65Mapping = {
        1: { text: 'TILTING IN', color: '#38bdf8' },
        2: { text: 'TILT IN', color: '#4ade80' },
        3: { text: 'TILTING OUT', color: '#38bdf8' },
        4: { text: 'TILT OUT', color: '#fbbf24' },
        5: { text: 'HALF WAY', color: '#94a3b8' },
        6: { text: 'STAND STILL', color: '#64748b' }
    };

    const inclinationStatusMapping = {
        1: { text: 'IN PROG (IN)', color: '#38bdf8' },
        2: { text: 'INCLINATED IN', color: '#4ade80' },
        3: { text: 'IN PROG (OUT)', color: '#38bdf8' },
        4: { text: 'INCLINATED OUT', color: '#fbbf24' },
        5: { text: 'HALF WAY', color: '#94a3b8' },
        6: { text: 'STAND STILL', color: '#64748b' },
        7: { text: 'TILTED IN', color: '#4ade80' },
        8: { text: 'TILTED OUT', color: '#fbbf24' }
    };

    const panelSx = { p: 1.75, bgcolor: surface, height: '100%', borderRadius: 2, border: `1px solid ${border}`, display: 'flex', flexDirection: 'column' };

    return (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 2 }}>
            {/* Main content */}
            <Box sx={{ flex: '1 1 560px', minWidth: 0 }}>
                <Grid container spacing={2}>
                    {/* Primary states header */}
                    <Grid item xs={12}>
                        <Paper sx={{ p: 1.75, bgcolor: surface, border: `1px solid ${border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>
                            <StatusChip label="Status" value={data.status} mapping={statusMapping} />
                            <Divider orientation="vertical" flexItem sx={{ borderColor: border }} />
                            <StatusChip label="Work Mode" value={data.work_mode} mapping={workModeMapping} />
                            <Divider orientation="vertical" flexItem sx={{ borderColor: border }} />
                            <StatusChip label="Op Mode" value={data.op_mode} mapping={opModeMapping} />
                            <Divider orientation="vertical" flexItem sx={{ borderColor: border }} />
                            <StatusChip label="Rotation" value={data.rotation_status} mapping={rotationMapping} />
                            <Box sx={{ ml: 'auto', textAlign: 'right', pr: 1 }}>
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: '0.62rem', fontWeight: 700 }}>WORKING TIME</Typography>
                                <Typography variant="h6" sx={{ color: 'primary.main', fontWeight: 'bold' }}>{formatWorkingTime(data.working_hours, data.working_minutes)}</Typography>
                            </Box>
                        </Paper>
                    </Grid>

                    {/* ROTARY */}
                    <Grid item xs={12}>
                        <SectionTitle>Rotary & Motion</SectionTitle>
                        <Grid container spacing={1.5}>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Top Drive RPM" value={data.rpm} unit="RPM" color="#38bdf8" min={0} max={250} warn={210} crit={235}
                                    sub={`REQ ${Math.round(Number(data.rpm_request || 0))} - CMD ${Math.round(Number(data.rpm_command || 0))}`} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="HTD Torque" value={data.torque} unit="daN·m" color="#fbbf24" min={0} max={2000} warn={1500} crit={1800}
                                    sub={`REQ ${Math.round(Number(data.torque_request || 0))} - CMD ${Math.round(Number(data.torque_command || 0))}`} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Vertical Speed" value={data.vertical_speed} unit="mm/sec" decimals={2} color="#4ade80" />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Inclination" value={data.inclination} unit="%" color="#a78bfa" min={0} max={100} />
                            </Grid>
                        </Grid>
                    </Grid>

                    {/* MECHANISMS & LINKS */}
                    <Grid item xs={12} sm={6} md={4}>
                        <Paper sx={panelSx}>
                            <SectionTitle>Mechanisms & Links</SectionTitle>
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, justifyContent: 'space-evenly' }}>
                                <StatusRow label="ELEVATOR" value={data.elevator_status} mapping={elevatorMapping} inset={inset} border={border} />
                                <StatusRow label="IBOP" value={data.ibop_status} mapping={elevatorMapping} inset={inset} border={border} />
                                <StatusRow label="BRAKE" value={data.brake_status} mapping={brakeMapping} inset={inset} border={border} />
                                <StatusRow label="LINK ROTATION" value={data.link_rotation_status} mapping={linkRotationMapping} inset={inset} border={border} />
                            </Box>
                        </Paper>
                    </Grid>

                    {/* DRIVE SYSTEM */}
                    <Grid item xs={12} sm={6} md={4}>
                        <Paper sx={panelSx}>
                            <SectionTitle>Drive System</SectionTitle>
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, justifyContent: 'space-evenly' }}>
                                <StatusRow label="GEAR SELECTION" value={data.gear_status} mapping={gearMapping} inset={inset} border={border} />
                                <StatusRow label="SUSPENSION" value={data.suspension_status} mapping={suspensionMapping} inset={inset} border={border} />
                                <StatusRow label="LUBE" value={data.lube_status} mapping={lubeMapping} inset={inset} border={border} />
                            </Box>
                        </Paper>
                    </Grid>

                    {/* POSITIONING */}
                    <Grid item xs={12} sm={12} md={4}>
                        <Paper sx={panelSx}>
                            <SectionTitle>Positioning</SectionTitle>
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, flex: 1, justifyContent: 'space-evenly' }}>
                                <StatusRow label="TILT" value={data.tilt_status_db65} mapping={tiltDb65Mapping} inset={inset} border={border} />
                                <StatusRow label="INCLINATION" value={data.inclination_status} mapping={inclinationStatusMapping} inset={inset} border={border} />
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
                        Top Drive Trends
                    </Typography>
                    <Box sx={{ flex: 1, minHeight: 0 }}>
                        <EdrView mode="compact" storageKey="edr-htd-1" defaultStrips={EDR_STRIPS} channels={EDR_CHANNELS} />
                    </Box>
                </Paper>
            </Box>
        </Box>
    );
}
