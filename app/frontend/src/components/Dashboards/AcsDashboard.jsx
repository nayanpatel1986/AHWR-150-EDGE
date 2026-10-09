import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box, Divider } from '@mui/material';
import { getLatestRigData, isLiveRigPayload, socket } from '../../socket';
import EdrView from '../EDR/EdrView';

const EDR_CHANNELS = [
    'acs.calibration_status',
    'acs.status',
    'acs.block_position',
    'acs.bottomsaver',
    'acs.crownsaver',
    'acs.floorsaver',
    'acs.lower_tag',
    'acs.upper_tag'
];
const EDR_STRIPS = [
    {
        title: 'ACS',
        pens: [
            { channelId: 'acs.block_position', color: '#38bdf8', min: 0, max: 15000, enabled: true },
            { channelId: 'acs.crownsaver', color: '#ef4444', min: 0, max: 15000, enabled: true },
            { channelId: 'acs.floorsaver', color: '#fbbf24', min: 0, max: 15000, enabled: true }
        ]
    }
];

const StatusIndicator = ({ label, value, mapping }) => {
    const active = mapping[value] || { text: 'Unknown', color: '#64748b' };
    return (
        <Box sx={{ textAlign: 'center', px: 2 }}>
            <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mb: 0.5 }}>{label.toUpperCase()}</Typography>
            <Box sx={{
                bgcolor: `${active.color}15`,
                color: active.color,
                border: `1px solid ${active.color}`,
                px: 2, py: 0.5, borderRadius: 1,
                fontWeight: 'bold', fontSize: '0.875rem'
            }}>
                {active.text}
            </Box>
        </Box>
    );
};

export default function AcsDashboard() {
    const [data, setData] = useState({});
    const mmValue = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : '--';

    useEffect(() => {
        const cached = getLatestRigData();
        if (isLiveRigPayload(cached) && cached.acs) setData(cached.acs);

        const handler = (newData) => {
            if (!isLiveRigPayload(newData)) { setData({}); return; }
            if (newData.acs) setData(newData.acs);
        };
        socket.on('rig_data', handler);
        return () => socket.off('rig_data', handler);
    }, []);

    const statusMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'ON', color: '#4ade80' },
        2: { text: 'OFF', color: '#64748b' },
        3: { text: 'DISABLE', color: '#ef4444' }
    };

    const calibrationMapping = {
        '-1': { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'IN PROGRESS', color: '#38bdf8' },
        2: { text: 'NOT CALIBRATED', color: '#fbbf24' },
        3: { text: 'CALIBRATED', color: '#4ade80' },
        10: { text: 'MOVE UP', color: '#38bdf8' },
        11: { text: 'MOVE DOWN', color: '#38bdf8' }
    };

    return (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 2 }}>
            <Box sx={{ flex: '1 1 560px', minWidth: 0 }}>
                <Grid container spacing={3}>
                    <Grid item xs={12}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                        <StatusIndicator label="System Status" value={data.status} mapping={statusMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Calibration" value={data.calibration_status} mapping={calibrationMapping} />
                    </Paper>
                    </Grid>

                    <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 1.5, bgcolor: '#1e293b', height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 1 }}>BLOCK POSITION</Typography>
                        <Box sx={{ flex: 1, minHeight: 96, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 1.5, bgcolor: '#0f172a', borderRadius: 2 }}>
                            <Typography sx={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '2rem' }}>
                                {mmValue(data.block_position)} <Typography component="span" variant="subtitle1" sx={{ color: '#64748b' }}>mm</Typography>
                            </Typography>
                        </Box>
                    </Paper>
                    </Grid>

                    <Grid item xs={12} md={8}>
                    <Paper sx={{ p: 1.5, bgcolor: '#1e293b', height: '100%' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 1 }}>TAG POSITIONS</Typography>
                        <Box sx={{ display: 'flex', gap: 1.5 }}>
                            <Box sx={{ flex: 1, p: 1.5, bgcolor: '#0f172a', borderRadius: 1, textAlign: 'center' }}>
                                <Typography variant="h5" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{mmValue(data.upper_tag)}</Typography>
                                <Typography variant="caption" sx={{ color: '#64748b' }}>UPPER TAG (mm)</Typography>
                            </Box>
                            <Box sx={{ flex: 1, p: 1.5, bgcolor: '#0f172a', borderRadius: 1, textAlign: 'center' }}>
                                <Typography variant="h5" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{mmValue(data.lower_tag)}</Typography>
                                <Typography variant="caption" sx={{ color: '#64748b' }}>LOWER TAG (mm)</Typography>
                            </Box>
                        </Box>
                    </Paper>
                    </Grid>

                    <Grid item xs={12} md={6}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2 }}>SAVER THRESHOLDS</Typography>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <Box sx={{ p: 2, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography sx={{ color: '#94a3b8' }}>CROWNSAVER</Typography>
                                <Typography sx={{ color: '#ef4444', fontWeight: 'bold', fontSize: '1.2rem' }}>{mmValue(data.crownsaver)} mm</Typography>
                            </Box>
                            <Box sx={{ p: 2, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography sx={{ color: '#94a3b8' }}>FLOORSAVER</Typography>
                                <Typography sx={{ color: '#fbbf24', fontWeight: 'bold', fontSize: '1.2rem' }}>{mmValue(data.floorsaver)} mm</Typography>
                            </Box>
                            <Box sx={{ p: 2, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography sx={{ color: '#94a3b8' }}>BOTTOMSAVER</Typography>
                                <Typography sx={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '1.2rem' }}>{mmValue(data.bottomsaver)} mm</Typography>
                            </Box>
                        </Box>
                    </Paper>
                    </Grid>
                </Grid>
            </Box>

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
                <Paper sx={{ flex: 1, minHeight: 0, p: 1.25, bgcolor: '#1e293b', border: '1px solid #334155', borderRadius: 2, display: 'flex', flexDirection: 'column' }}>
                    <Typography sx={{ color: '#94a3b8', fontSize: '0.72rem', fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', mb: 0.75 }}>
                        ACS Trends
                    </Typography>
                    <Box sx={{ flex: 1, minHeight: 0 }}>
                        <EdrView mode="compact" storageKey="edr-acs-only-1" defaultStrips={EDR_STRIPS} channels={EDR_CHANNELS} />
                    </Box>
                </Paper>
            </Box>
        </Box>
    );
}
