import React, { useState, useEffect } from 'react';
import { Box, Typography, Button, Tooltip } from '@mui/material';
import { Bell, BellOff, Volume2, VolumeX, Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import axios from '../../api';
import { getLatestAlarms, isLiveRigPayload, socket } from '../../socket';
import { useAuth } from '../../context/AuthContext';
import { priorityColor } from '../../utils/alarms';
import useAnnunciator from './useAnnunciator';

// Persistent alarm banner shown in the AppBar on every page.
// - Seeds from GET /api/alarms on mount, then updates live from the `alarms`
//   socket event (named handler removed on cleanup; the shared socket is NOT
//   disconnected here).
// - Click navigates to /alarms.
// - Silence/Ack-all button (operator/admin only).
// - Speaker toggle arms the Web Audio annunciator (default off; armed by the
//   user's click to satisfy autoplay policy).
export default function AlarmBanner() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const canWrite = user?.role === 'admin' || user?.role === 'operator';

    const [counts, setCounts] = useState({ active: 0, unack: 0, p1: 0, p2: 0, p3: 0, highest: null });
    // Highest UNACKED priority drives the annunciator cadence. Derived from the
    // active list so we only sound for alarms still needing acknowledgement.
    const [highestUnack, setHighestUnack] = useState(null);
    const { armed, toggle } = useAnnunciator(highestUnack);

    const applyAlarms = (payload) => {
        if (!payload) return;
        if (payload.counts) setCounts(payload.counts);
        const active = Array.isArray(payload.active) ? payload.active : [];
        const unacked = active.filter((a) => a.state === 'UNACK' || a.state === 'RTN_UNACK');
        let hi = null;
        for (const a of unacked) {
            if (a.priority === 'P1') { hi = 'P1'; break; }
            if (a.priority === 'P2' && hi !== 'P1') hi = 'P2';
            if (a.priority === 'P3' && !hi) hi = 'P3';
        }
        setHighestUnack(hi);
    };

    useEffect(() => {
        let mounted = true;
        applyAlarms(getLatestAlarms());
        axios.get('/api/rig/latest', { timeout: 3000 })
            .then(({ data }) => {
                if (!mounted) return;
                if (!isLiveRigPayload(data)) {
                    setCounts({ active: 0, unack: 0, p1: 0, p2: 0, p3: 0, highest: null });
                    setHighestUnack(null);
                    return;
                }
                return axios.get('/api/alarms', { timeout: 3000 }).then((res) => { if (mounted) applyAlarms(res.data); });
            })
            .catch((err) => console.error('Failed to seed alarms:', err));

        const handleAlarms = (payload) => applyAlarms(payload);
        const clearIfNoPlc = (payload) => {
            if (!isLiveRigPayload(payload)) {
                setCounts({ active: 0, unack: 0, p1: 0, p2: 0, p3: 0, highest: null });
                setHighestUnack(null);
            }
        };
        socket.on('alarms', handleAlarms);
        socket.on('rig_data', clearIfNoPlc);

        return () => {
            mounted = false;
            socket.off('alarms', handleAlarms);
            socket.off('rig_data', clearIfNoPlc);
        };
    }, []);

    const handleAckAll = async (e) => {
        e.stopPropagation();
        try {
            await axios.post('/api/alarms/ack-all');
            // The server will emit a fresh `alarms` event; optimistic clear of
            // the audible cue for snappy feedback.
            setHighestUnack(null);
        } catch (err) {
            console.error('Ack-all failed:', err);
        }
    };

    const handleToggleSound = (e) => {
        e.stopPropagation();
        toggle();
    };

    const highest = counts.highest;
    const hasActive = counts.active > 0;
    const color = hasActive ? priorityColor(highest) : '#475569';

    return (
        <Box
            onClick={() => navigate('/alarms')}
            role="button"
            aria-label="Open alarms page"
            sx={{
                display: 'flex', alignItems: 'center', gap: 1.5,
                flex: { xs: '1 1 100%', md: '0 0 auto' },
                order: { xs: 3, md: 0 },
                width: { xs: '100%', md: 'auto' },
                justifyContent: { xs: 'space-between', md: 'flex-start' },
                minWidth: 0,
                px: 1.5, py: 0.75, mr: { xs: 0, md: 2 }, borderRadius: 1, cursor: 'pointer',
                bgcolor: hasActive ? `${color}22` : '#1e293b',
                border: `1px solid ${hasActive ? color : '#334155'}`,
                transition: 'all 0.2s',
                '&:hover': { borderColor: color, bgcolor: hasActive ? `${color}33` : '#243044' },
            }}
        >
            <Box sx={{ color, display: 'flex', alignItems: 'center', animation: counts.unack > 0 ? 'alarmPulse 1s infinite' : 'none' }}>
                {hasActive ? <Bell size={18} /> : <BellOff size={18} />}
            </Box>

            {/* Highest priority chip (text + color, not color alone). */}
            {hasActive && highest && (
                <Box sx={{
                    px: 0.75, py: 0.1, borderRadius: 0.75,
                    bgcolor: color, color: '#0f172a', fontWeight: 'bold', fontSize: 11, lineHeight: 1.6,
                }}>
                    {highest}
                </Box>
            )}

            <Box sx={{ lineHeight: 1, minWidth: 0, flex: { xs: '1 1 auto', md: '0 0 auto' } }}>
                <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', lineHeight: 1 }}>
                    Alarms
                </Typography>
                <Typography variant="body2" noWrap sx={{ color: hasActive ? color : '#94a3b8', fontWeight: 'bold', lineHeight: 1.2 }}>
                    {counts.active} active · {counts.unack} unack
                </Typography>
            </Box>

            {/* Speaker toggle: arms the annunciator (autoplay-safe). */}
            <Tooltip title={armed ? 'Mute annunciator' : 'Enable audible annunciator'}>
                <Button
                    onClick={handleToggleSound}
                    size="small"
                    aria-pressed={armed}
                    sx={{
                        minWidth: 0, p: 0.5, color: armed ? '#38bdf8' : '#64748b',
                        '&:hover': { bgcolor: 'rgba(56,189,248,0.12)' },
                    }}
                >
                    {armed ? <Volume2 size={16} /> : <VolumeX size={16} />}
                </Button>
            </Tooltip>

            {/* Silence / Ack-all (operator/admin only). */}
            {canWrite && counts.unack > 0 && (
                <Tooltip title="Acknowledge all (silence)">
                    <Button
                        onClick={handleAckAll}
                        size="small"
                        startIcon={<Check size={14} />}
                        sx={{
                            minWidth: 0, px: 1, py: 0.25, textTransform: 'none',
                            color: '#0f172a', bgcolor: color, fontWeight: 'bold', fontSize: 12,
                            '&:hover': { bgcolor: color, opacity: 0.85 },
                        }}
                    >
                        Ack all
                    </Button>
                </Tooltip>
            )}

            {/* Keyframes for the unacked pulse. */}
            <style>{`@keyframes alarmPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>
        </Box>
    );
}
