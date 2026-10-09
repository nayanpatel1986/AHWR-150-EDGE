import React, { useState, useEffect, useMemo } from 'react';
import { Box, Typography, Grid, Paper, useTheme, ButtonGroup, Button, IconButton } from '@mui/material';
import { Clock, RefreshCw } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { getLatestRigData, isLiveRigPayload, socket } from '../../socket';
import KillSheet from './KillSheet';
import BOPStack from './BOPStack';
import axios from '../../api';

const DASH = '-';
const STATUS = { ok: '#4ade80', warn: '#fbbf24', fail: '#ef4444' };

const PressureCard = ({ label, value, color, isLive }) => {
    const numericValue = Number(value);
    const display = isLive && Number.isFinite(numericValue) ? numericValue.toFixed(2) : DASH;
    return (
        <Paper
            sx={{
                p: 2,
                px: 3,
                bgcolor: '#121620',
                border: 'none',
                borderRadius: 4,
                borderLeft: `4px solid ${color}`,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                height: '100%',
                minHeight: 120,
                boxShadow: 'none'
            }}
        >
            <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', mb: 1 }}>
                {label}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                <Typography sx={{ color: color, fontWeight: 900, fontSize: '2.5rem', lineHeight: 1 }}>
                    {display}
                </Typography>
                <Typography sx={{ color: color, fontWeight: 800, fontSize: '0.85rem', textTransform: 'uppercase' }}>
                    PSI
                </Typography>
            </Box>
        </Paper>
    );
};

const generateMockData = (range) => {
    let length = 30;
    if (range === '1m') length = 10;
    if (range === '10m') length = 60;
    if (range === '15m') length = 90;
    if (range === '30m') length = 180;
    if (range === '1h') length = 360;
    if (range === '12h') length = 720;
    
    return Array.from({ length }).map((_, i) => ({
        time: `10:${(i % 60).toString().padStart(2, '0')}`,
        manifold: Number((500 + Math.random() * 50 + (i > 15 ? 100 : 0)).toFixed(2)),
        annular: Number((800 + Math.random() * 30 + (i > 20 ? 50 : 0)).toFixed(2))
    }));
};

const MiniTrendWidget = () => {
    const [timeRange, setTimeRange] = useState('5m');
    const chartData = useMemo(() => generateMockData(timeRange), [timeRange]);

    const ranges = ['1m', '5m', '10m', '15m', '30m', '1h', '12h'];

    return (
        <Box sx={{ mt: 4, pt: 3, borderTop: '1px dashed #334155', width: '100%' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2, flexWrap: 'wrap', gap: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <IconButton sx={{ color: '#94a3b8', border: '1px solid #334155', borderRadius: 2 }} size="small">
                        <Clock size={16} />
                    </IconButton>
                    <ButtonGroup variant="outlined" size="small" sx={{ '& .MuiButton-root': { borderColor: '#334155', color: '#94a3b8', px: 1, minWidth: '40px' } }}>
                        {ranges.map(range => (
                            <Button 
                                key={range}
                                onClick={() => setTimeRange(range)}
                                sx={timeRange === range ? { bgcolor: '#38bdf8 !important', color: '#0f172a !important', borderColor: '#38bdf8 !important', fontWeight: 'bold' } : {}}
                            >
                                {range}
                            </Button>
                        ))}
                    </ButtonGroup>
                </Box>
                <Button variant="outlined" size="small" startIcon={<RefreshCw size={14} />} sx={{ borderColor: '#334155', color: '#38bdf8', borderRadius: 2 }}>
                    RESYNC
                </Button>
            </Box>

            <Typography variant="body2" sx={{ color: '#94a3b8', mb: 1, ml: 1 }}>
                BOP PRESSURES (Trend)
            </Typography>

            <Box sx={{ width: '100%', height: 220, border: '1px dashed #334155', borderRadius: 2, p: 1, pb: 0 }}>
                <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="time" stroke="#475569" fontSize={10} tickMargin={10} axisLine={false} tickLine={false} />
                        <YAxis stroke="#475569" fontSize={10} axisLine={false} tickLine={false} tickFormatter={(val) => Number(val).toFixed(2)} />
                        <Tooltip
                            contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: 'white', fontSize: '12px' }}
                            itemStyle={{ color: 'white' }}
                        />
                        <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} iconType="circle" />
                        <Line type="monotone" dataKey="manifold" stroke="#a855f7" strokeWidth={2} dot={false} activeDot={{ r: 4 }} name="Manifold Press" />
                        <Line type="monotone" dataKey="annular" stroke="#06b6d4" strokeWidth={2} dot={false} activeDot={{ r: 4 }} name="Annular Press" />
                    </LineChart>
                </ResponsiveContainer>
            </Box>
        </Box>
    );
};

const WellControlDashboard = () => {
    const theme = useTheme();
    const [wcData, setWcData] = useState({
        annular_pressure: 0,
        manifold_pressure: 0,
        accumulator_pressure: 0,
        annular_open: false,
        annular_close: false,
        pipe_ram_open: false,
        pipe_ram_close: false,
        blind_ram_open: false,
        blind_ram_close: false,
        shear_ram_open: false
    });
    const [wellhead, setWellhead] = useState({ tubing_pressure: 0, casing_pressure: 0, wellhead_pressure: 0, hasData: false });
    const [feed, setFeed] = useState({
        connected: socket.connected,
        available: false,
        stale: false,
        hasData: false,
        quality: 'disconnected'
    });

    useEffect(() => {
        applyData(getLatestRigData());
        axios.get('/api/rig/latest')
            .then(({ data }) => applyData(data))
            .catch(err => console.error('Failed to fetch latest well control data:', err));

        const handler = (newData) => applyData(newData);
        socket.on('rig_data', handler);

        const handleConnect = () => setFeed(prev => ({ ...prev, connected: true }));
        const handleDisconnect = () => setFeed(prev => ({ ...prev, connected: false }));
        socket.on('connect', handleConnect);
        socket.on('disconnect', handleDisconnect);

        return () => {
            socket.off('rig_data', handler);
            socket.off('connect', handleConnect);
            socket.off('disconnect', handleDisconnect);
        };
    }, []);

    const applyData = (newData) => {
        if (!newData) return;
        if (!isLiveRigPayload(newData)) {
            setFeed(prev => ({ ...prev, available: false, stale: true, hasData: false }));
            setWcData({});
            setWellhead({ hasData: false });
            return;
        }
        const wc = newData.well_control;
        const bop = newData.bop;
        const meta = newData._meta;
        const available = !!(bop?.connected || (wc && wc.available !== false));
        setFeed(prev => ({
            connected: socket.connected,
            available,
            stale: meta ? !!meta.stale : prev.stale,
            hasData: true,
            quality: bop?.quality || (available ? 'good' : 'disconnected')
        }));

        if (available && wc) {
            setWcData({
                annular_pressure: Number((bop?.annular_pressure ?? wc.annular_pressure)) || 0,
                manifold_pressure: Number((bop?.manifold_pressure ?? wc.manifold_pressure)) || 0,
                accumulator_pressure: Number((bop?.accumulator_pressure ?? wc.accumulator_pressure)) || 0,
                annular: { open: Number((bop?.annular_open ?? wc.annular_open)) > 0, close: Number((bop?.annular_close ?? wc.annular_close)) > 0 },
                pipe: { open: Number((bop?.upper_ram_open ?? wc.pipe_ram_open)) > 0, close: Number((bop?.upper_ram_close ?? wc.pipe_ram_close)) > 0 },
                blind: { open: Number((bop?.lower_ram_open ?? wc.blind_ram_open)) > 0, close: Number((bop?.lower_ram_close ?? wc.blind_ram_close)) > 0 },
                shear: Number(wc.shear_ram_open) > 0
            });
        }

        if (newData.wellhead) {
            setWellhead({
                tubing_pressure: Number(newData.wellhead.tubing_pressure) || 0,
                casing_pressure: Number(newData.wellhead.casing_pressure) || 0,
                wellhead_pressure: Number(newData.wellhead.wellhead_pressure) || 0,
                hasData: true
            });
        }
    };

    const isLive = feed.connected && feed.available && !feed.stale;
    const wellheadLive = feed.connected && !feed.stale && wellhead.hasData;
    const banner = !feed.connected
        ? { text: 'WELL CONTROL TELEMETRY UNAVAILABLE - SOCKET DISCONNECTED', color: STATUS.fail }
        : (!feed.available
            ? { text: 'WELL CONTROL TELEMETRY UNAVAILABLE - NO BOP DATA SOURCE', color: STATUS.fail }
            : (feed.stale
                ? { text: 'NO LIVE DATA - WELL CONTROL FEED IS STALE', color: STATUS.warn }
                : (!feed.hasData
                    ? { text: 'WAITING FOR WELL CONTROL TELEMETRY...', color: STATUS.warn }
                    : null)));

    return (
        <Box sx={{ width: '100%', maxWidth: '100%', pb: 4 }}>


            {banner && (
                <Box
                    sx={{
                        mb: 2,
                        px: 2,
                        py: 1.25,
                        borderRadius: 1.5,
                        bgcolor: `${banner.color}1a`,
                        border: `1px solid ${banner.color}`,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1.5
                    }}
                >
                    <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: banner.color, boxShadow: `0 0 10px ${banner.color}` }} />
                    <Typography variant="subtitle1" sx={{ color: banner.color, fontWeight: 'bold', letterSpacing: 0.5 }}>
                        {banner.text}
                    </Typography>
                </Box>
            )}

            <Grid container spacing={3}>
                <Grid item xs={12} lg={4}>
                    <BOPStack rams={wcData} live={isLive} accumulatorPressure={wcData.accumulator_pressure}>
                        <MiniTrendWidget />
                    </BOPStack>
                </Grid>

                <Grid item xs={12} lg={8}>
                    <Grid container spacing={3} sx={{ height: '100%' }}>
                        <Grid item xs={12}>
                            <Grid container spacing={3}>
                                <Grid item xs={12} md={4}>
                                    <PressureCard label="Annular Pressure" value={wcData.annular_pressure} color="#06b6d4" isLive={isLive} />
                                </Grid>
                                <Grid item xs={12} md={4}>
                                    <PressureCard label="Manifold Pressure" value={wcData.manifold_pressure} color="#a855f7" isLive={isLive} />
                                </Grid>
                                <Grid item xs={12} md={4}>
                                    <PressureCard label="Accumulator Pressure" value={wcData.accumulator_pressure} color="#ec4899" isLive={isLive} />
                                </Grid>
                            </Grid>
                        </Grid>

                        <Grid item xs={12}>
                            <KillSheet />
                        </Grid>
                    </Grid>
                </Grid>
            </Grid>
        </Box>
    );
};

export default WellControlDashboard;
