import React, { useState, useEffect, useMemo } from 'react';
import { Box, Typography, Button, Tooltip } from '@mui/material';
import { Bell, Volume2, VolumeX, Check, CheckCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import axios from '../../api';
import { getLatestAlarms, isLiveRigPayload, socket } from '../../socket';
import { useAuth } from '../../context/AuthContext';
import { priorityColor, priorityRank } from '../../utils/alarms';
import { formatDuration, secondsSince } from '../../utils/format';
import useAnnunciator from './useAnnunciator';

// Persistent, full-width alarm strip rendered in the Layout shell (below the
// AppBar) so it shows on EVERY route.
//
// - Seeds from GET /api/alarms on mount, then updates live from the shared
//   `alarms` socket event (the server also re-emits on connect and after ack).
//   The named handler is removed on cleanup; the shared socket is NOT created
//   or disconnected here.
// - Shows the highest-priority active alarm prominently (color block + label +
//   value/limit + time-since-raised). ESD / lockout (P1) dominate.
// - Unacknowledged P1/P2 give the highest-alarm block ONE deliberate pulse;
//   acked-but-active is steady. This is the only place heavy motion is allowed.
// - ACK acks the first-out / highest unacked alarm; ACK ALL acks everything.
//   Both hidden for the viewer role.
// - Reuses the existing Web-Audio annunciator (useAnnunciator); the speaker
//   toggle arms it on the user's gesture (autoplay-safe) and it sounds while
//   any unacked alarm exists.
// - Clicking the strip body navigates to /alarms.

const isUnackState = (s) => s === 'UNACK' || s === 'RTN_UNACK';

export default function AlarmStrip() {
    const navigate = useNavigate();
    const { user } = useAuth();
    const canWrite = user?.role === 'admin' || user?.role === 'operator';

    const [active, setActive] = useState([]);
    const [counts, setCounts] = useState({ active: 0, unack: 0, p1: 0, p2: 0, p3: 0, highest: null });
    // Re-render every second so "time-since-raised" counts up live.
    const [, setTick] = useState(0);

    const applyAlarms = (payload) => {
        if (!payload) return;
        setActive(Array.isArray(payload.active) ? payload.active : []);
        if (payload.counts) setCounts(payload.counts);
    };

    useEffect(() => {
        let mounted = true;
        applyAlarms(getLatestAlarms());
        // Seed from REST only if PLC feed is live; stale PLC shows no alarms.
        axios.get('/api/rig/latest', { timeout: 3000 })
            .then(({ data }) => {
                if (!mounted) return;
                if (!isLiveRigPayload(data)) {
                    setActive([]);
                    setCounts({ active: 0, unack: 0, p1: 0, p2: 0, p3: 0, highest: null });
                    return;
                }
                return axios.get('/api/alarms', { timeout: 3000 }).then((res) => { if (mounted) applyAlarms(res.data); });
            })
            .catch((err) => console.error('Failed to seed alarms:', err));

        const handleAlarms = (payload) => applyAlarms(payload);
        const clearIfNoPlc = (payload) => {
            if (!isLiveRigPayload(payload)) {
                setActive([]);
                setCounts({ active: 0, unack: 0, p1: 0, p2: 0, p3: 0, highest: null });
            }
        };
        socket.on('alarms', handleAlarms);
        socket.on('rig_data', clearIfNoPlc);

        const id = setInterval(() => setTick((t) => t + 1), 1000);

        return () => {
            mounted = false;
            socket.off('alarms', handleAlarms);
            socket.off('rig_data', clearIfNoPlc);
            clearInterval(id);
        };
    }, []);

    // The alarm that should dominate the strip: prefer the first-out, otherwise
    // the highest-priority (P1 < P2 < P3), tie-broken by oldest raisedAt.
    const topAlarm = useMemo(() => {
        if (active.length === 0) return null;
        const sorted = [...active].sort((a, b) => {
            if (!!b.firstOut !== !!a.firstOut) return b.firstOut ? 1 : -1;
            const pr = priorityRank(a.priority) - priorityRank(b.priority);
            if (pr !== 0) return pr;
            return (Date.parse(a.raisedAt) || 0) - (Date.parse(b.raisedAt) || 0);
        });
        return sorted[0];
    }, [active]);

    // The alarm ACK targets: first-out / highest UNACKED alarm.
    const ackTarget = useMemo(() => {
        const unacked = active.filter((a) => isUnackState(a.state));
        if (unacked.length === 0) return null;
        const sorted = [...unacked].sort((a, b) => {
            if (!!b.firstOut !== !!a.firstOut) return b.firstOut ? 1 : -1;
            const pr = priorityRank(a.priority) - priorityRank(b.priority);
            if (pr !== 0) return pr;
            return (Date.parse(a.raisedAt) || 0) - (Date.parse(b.raisedAt) || 0);
        });
        return sorted[0];
    }, [active]);

    // Highest UNACKED priority drives the annunciator cadence.
    const highestUnack = useMemo(() => {
        let hi = null;
        for (const a of active) {
            if (!isUnackState(a.state)) continue;
            if (a.priority === 'P1') return 'P1';
            if (a.priority === 'P2' && hi !== 'P1') hi = 'P2';
            if (a.priority === 'P3' && !hi) hi = 'P3';
        }
        return hi;
    }, [active]);

    const { armed, toggle } = useAnnunciator(highestUnack);

    const handleAck = async (e) => {
        e.stopPropagation();
        if (!canWrite || !ackTarget) return;
        try {
            await axios.post(`/api/alarms/${ackTarget.id}/ack`);
            // Server re-emits `alarms`; optimistic local ack for snappy feedback.
            setActive((prev) => prev.map((a) => (a.id === ackTarget.id ? { ...a, state: 'ACK' } : a)));
        } catch (err) {
            console.error('Ack failed:', err);
        }
    };

    const handleAckAll = async (e) => {
        e.stopPropagation();
        if (!canWrite) return;
        try {
            await axios.post('/api/alarms/ack-all');
            setActive((prev) => prev.map((a) => (isUnackState(a.state) ? { ...a, state: 'ACK' } : a)));
        } catch (err) {
            console.error('Ack-all failed:', err);
        }
    };

    const handleToggleSound = (e) => {
        e.stopPropagation();
        toggle(); // must run inside the user gesture to satisfy autoplay policy
    };

    const hasActive = active.length > 0;

    // Calm "all clear" state — green dot, muted text, no motion.
    if (!hasActive) {
        return (
            <Box
                sx={{
                    display: 'flex', alignItems: 'center', gap: 1.5,
                    minHeight: 44, px: { xs: 1.5, md: 3 }, py: 0.5,
                    bgcolor: 'background.paper',
                    borderBottom: '1px solid', borderColor: 'divider',
                }}
            >
                <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#22c55e', flex: '0 0 auto' }} />
                <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
                    No active alarms
                </Typography>
                {/* Speaker toggle stays available so the annunciator can be armed ahead of time. */}
                <Box sx={{ flexGrow: 1 }} />
                <Tooltip title={armed ? 'Mute annunciator' : 'Enable audible annunciator'}>
                    <Button
                        onClick={handleToggleSound}
                        size="small"
                        aria-pressed={armed}
                        sx={{ minWidth: 0, p: 0.5, color: armed ? 'primary.main' : 'text.secondary' }}
                    >
                        {armed ? <Volume2 size={16} /> : <VolumeX size={16} />}
                    </Button>
                </Tooltip>
            </Box>
        );
    }

    const color = priorityColor(topAlarm?.priority);
    const topUnacked = topAlarm && isUnackState(topAlarm.state);
    // Pulse only for unacked P1/P2 (the most urgent); acked-but-active is steady.
    const shouldPulse = topUnacked && (topAlarm.priority === 'P1' || topAlarm.priority === 'P2');
    const elapsed = formatDuration(secondsSince(topAlarm?.raisedAt));

    return (
        <Box
            onClick={() => navigate('/alarms')}
            role="button"
            aria-label="Open alarms page"
            sx={{
                display: 'flex', alignItems: 'center', gap: { xs: 1, md: 1.5 },
                minHeight: 44, px: { xs: 1.5, md: 3 }, py: 0.5,
                cursor: 'pointer',
                bgcolor: `${color}1f`,
                borderBottom: `2px solid ${color}`,
                overflow: 'hidden',
                transition: 'background-color 0.2s',
                '&:hover': { bgcolor: `${color}2e` },
            }}
        >
            {/* Highest-priority alarm block (the dominant element). */}
            <Box
                sx={{
                    display: 'flex', alignItems: 'center', gap: 1,
                    px: 1, py: 0.4, borderRadius: 1, minWidth: 0, flexShrink: 1,
                    bgcolor: `${color}22`,
                    border: `1px solid ${color}`,
                    animation: shouldPulse ? 'alarmStripPulse 1.1s ease-in-out infinite' : 'none',
                }}
            >
                <Bell size={16} color={color} style={{ flex: '0 0 auto' }} />
                {/* Priority chip — text, never color alone. */}
                <Box sx={{
                    px: 0.6, py: 0.05, borderRadius: 0.5, flex: '0 0 auto',
                    bgcolor: color, color: '#0f172a', fontWeight: 'bold', fontSize: 11, lineHeight: 1.7,
                }}>
                    {topAlarm.priority}
                </Box>
                <Typography
                    variant="body2"
                    noWrap
                    sx={{ color, fontWeight: 'bold', minWidth: 0, maxWidth: { xs: 140, sm: 260, md: 340 } }}
                >
                    {topAlarm.label}
                </Typography>
                {/* Value / limit (hidden on tiny screens). */}
                {topAlarm.value != null && (
                    <Typography component="span" variant="caption" noWrap sx={{ color, opacity: 0.9, display: { xs: 'none', sm: 'inline' }, flex: '0 0 auto' }}>
                        {topAlarm.value}
                        {topAlarm.limit != null && (
                            <span style={{ opacity: 0.7 }}> / {topAlarm.limit} {topAlarm.unit || ''}</span>
                        )}
                    </Typography>
                )}
                {/* Time-since-raised. */}
                <Typography component="span" variant="caption" noWrap sx={{ color, opacity: 0.75, display: { xs: 'none', md: 'inline' }, flex: '0 0 auto' }}>
                    · {elapsed}
                </Typography>
            </Box>

            {/* Counts by priority + unack total (text + color cue). */}
            <Box sx={{ display: { xs: 'none', sm: 'flex' }, alignItems: 'center', gap: 1, flex: '0 0 auto' }}>
                <Typography variant="caption" sx={{ color: priorityColor('P1'), fontWeight: 'bold' }}>P1×{counts.p1 || 0}</Typography>
                <Typography variant="caption" sx={{ color: priorityColor('P2'), fontWeight: 'bold' }}>P2×{counts.p2 || 0}</Typography>
                <Typography variant="caption" sx={{ color: priorityColor('P3'), fontWeight: 'bold' }}>P3×{counts.p3 || 0}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>·</Typography>
                <Typography variant="caption" sx={{ color: counts.unack > 0 ? color : 'text.secondary', fontWeight: 'bold' }}>
                    {counts.unack || 0} unack
                </Typography>
            </Box>

            <Box sx={{ flexGrow: 1 }} />

            {/* Controls — stop propagation so they don't navigate. */}
            {canWrite && (
                <Tooltip title={ackTarget ? `Acknowledge ${ackTarget.label}` : 'Nothing to acknowledge'}>
                    <span>
                        <Button
                            onClick={handleAck}
                            disabled={!ackTarget}
                            size="small"
                            startIcon={<Check size={14} />}
                            sx={{
                                minWidth: 0, px: 1, py: 0.25, textTransform: 'none', fontWeight: 'bold', fontSize: 12,
                                color: ackTarget ? '#0f172a' : 'text.disabled',
                                bgcolor: ackTarget ? color : 'transparent',
                                '&:hover': { bgcolor: ackTarget ? color : 'transparent', opacity: 0.85 },
                            }}
                        >
                            Ack
                        </Button>
                    </span>
                </Tooltip>
            )}

            {canWrite && (
                <Tooltip title="Acknowledge all">
                    <span>
                        <Button
                            onClick={handleAckAll}
                            disabled={(counts.unack || 0) === 0}
                            size="small"
                            startIcon={<CheckCheck size={14} />}
                            sx={{
                                minWidth: 0, px: 1, py: 0.25, textTransform: 'none', fontWeight: 'bold', fontSize: 12,
                                color: (counts.unack || 0) > 0 ? color : 'text.disabled',
                                border: `1px solid ${(counts.unack || 0) > 0 ? color : 'transparent'}`,
                                '&:hover': { bgcolor: `${color}22` },
                            }}
                        >
                            Ack all
                        </Button>
                    </span>
                </Tooltip>
            )}

            {/* Audible annunciator toggle (reused Web-Audio logic). */}
            <Tooltip title={armed ? 'Mute annunciator' : 'Enable audible annunciator'}>
                <Button
                    onClick={handleToggleSound}
                    size="small"
                    aria-pressed={armed}
                    sx={{ minWidth: 0, p: 0.5, color: armed ? 'primary.main' : 'text.secondary', flex: '0 0 auto' }}
                >
                    {armed ? <Volume2 size={16} /> : <VolumeX size={16} />}
                </Button>
            </Tooltip>

            {/* One deliberate, looping pulse for unacked P1/P2. */}
            <style>{`@keyframes alarmStripPulse {
                0% { box-shadow: 0 0 0 0 ${color}88; opacity: 1; }
                50% { box-shadow: 0 0 0 4px ${color}00; opacity: 0.55; }
                100% { box-shadow: 0 0 0 0 ${color}00; opacity: 1; }
            }`}</style>
        </Box>
    );
}
