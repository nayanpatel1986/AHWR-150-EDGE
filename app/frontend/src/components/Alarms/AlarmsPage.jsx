import React, { useState, useEffect, useMemo } from 'react';
import {
    Box, Typography, Paper, Button, Tabs, Tab, Table, TableBody, TableCell,
    TableContainer, TableHead, TableRow, TableSortLabel, Chip, Tooltip, useTheme
} from '@mui/material';
import { ShieldAlert, Check, History as HistoryIcon, Star } from 'lucide-react';
import axios from '../../api';
import { getLatestAlarms, isLiveRigPayload, socket } from '../../socket';
import { useAuth } from '../../context/AuthContext';
import { priorityColor, stateLabel, priorityRank } from '../../utils/alarms';
import { formatDuration, formatClock, secondsSince } from '../../utils/format';

// Semantic status colors (kept across all themes intentionally).
const STATUS = { ok: '#4ade80', warn: '#f59e0b' };
const HISTORY_TYPE_COLOR = {
    RAISE: '#ef4444',
    ACK: '#38bdf8',
    RTN: '#4ade80',
    RTN_UNACK: '#f59e0b',
};

function PriorityChip({ priority }) {
    const color = priorityColor(priority);
    return (
        <Chip
            label={priority}
            size="small"
            sx={{ bgcolor: color, color: '#0f172a', fontWeight: 'bold', height: 22, minWidth: 36 }}
        />
    );
}

function ActiveTable({ rows, canWrite, onAck, onAckAll }) {
    const theme = useTheme();
    const headSx = { color: theme.palette.text.secondary, fontWeight: 'bold', borderColor: theme.palette.divider, whiteSpace: 'nowrap' };
    const cellSx = { color: theme.palette.text.primary, borderColor: theme.palette.divider };

    const [orderBy, setOrderBy] = useState('priority');
    const [order, setOrder] = useState('asc');
    // Re-render every second so "time-in" counts up live.
    const [, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(id);
    }, []);

    const handleSort = (key) => {
        if (orderBy === key) {
            setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
        } else {
            setOrderBy(key);
            setOrder('asc');
        }
    };

    const sorted = useMemo(() => {
        const dir = order === 'asc' ? 1 : -1;
        const get = (r) => {
            switch (orderBy) {
                case 'priority': return priorityRank(r.priority);
                case 'timeIn': return secondsSince(r.raisedAt);
                case 'label': return (r.label || '').toLowerCase();
                case 'condition': return r.condition || '';
                case 'value': return Number(r.value);
                case 'state': return r.state || '';
                default: return 0;
            }
        };
        return [...rows].sort((a, b) => {
            const va = get(a); const vb = get(b);
            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;
            return 0;
        });
    }, [rows, orderBy, order]);

    const columns = [
        { key: 'priority', label: 'Priority' },
        { key: 'timeIn', label: 'Time-in' },
        { key: 'label', label: 'Tag / Label' },
        { key: 'condition', label: 'Condition' },
        { key: 'value', label: 'Value / Limit' },
        { key: 'state', label: 'State' },
    ];

    return (
        <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', px: 1.5, py: 1 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main }}>
                    Active Alarms ({rows.length})
                </Typography>
                {canWrite && (
                    <Button
                        onClick={onAckAll}
                        variant="contained"
                        size="small"
                        startIcon={<Check size={16} />}
                        disabled={rows.length === 0}
                        sx={{ textTransform: 'none', fontWeight: 'bold' }}
                    >
                        Ack all
                    </Button>
                )}
            </Box>
            <TableContainer>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            {columns.map((c) => (
                                <TableCell key={c.key} sx={headSx} sortDirection={orderBy === c.key ? order : false}>
                                    <TableSortLabel
                                        active={orderBy === c.key}
                                        direction={orderBy === c.key ? order : 'asc'}
                                        onClick={() => handleSort(c.key)}
                                        sx={{ color: `${theme.palette.text.secondary} !important`, '& .MuiTableSortLabel-icon': { color: `${theme.palette.primary.main} !important` } }}
                                    >
                                        {c.label}
                                    </TableSortLabel>
                                </TableCell>
                            ))}
                            {canWrite && <TableCell sx={headSx} align="right">Action</TableCell>}
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {sorted.map((a) => {
                            const color = priorityColor(a.priority);
                            const isUnack = a.state === 'UNACK' || a.state === 'RTN_UNACK';
                            return (
                                <TableRow
                                    key={a.id}
                                    hover
                                    sx={{
                                        bgcolor: a.firstOut ? `${theme.palette.primary.main}14` : 'transparent',
                                        borderLeft: `3px solid ${a.firstOut ? theme.palette.primary.main : 'transparent'}`,
                                    }}
                                >
                                    <TableCell sx={cellSx}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                                            <PriorityChip priority={a.priority} />
                                            {a.firstOut && (
                                                <Tooltip title="First-out (initiating alarm)">
                                                    <Star size={14} color={theme.palette.primary.main} fill={theme.palette.primary.main} />
                                                </Tooltip>
                                            )}
                                        </Box>
                                    </TableCell>
                                    <TableCell sx={cellSx}>{formatDuration(secondsSince(a.raisedAt))}</TableCell>
                                    <TableCell sx={cellSx}>
                                        <Typography variant="body2" sx={{ fontWeight: 'bold' }}>{a.label}</Typography>
                                        <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>{a.dataKey}</Typography>
                                    </TableCell>
                                    <TableCell sx={cellSx}>
                                        <Chip label={a.condition} size="small" variant="outlined"
                                            sx={{ color, borderColor: color, height: 20, fontWeight: 'bold' }} />
                                    </TableCell>
                                    <TableCell sx={cellSx}>
                                        <span style={{ color, fontWeight: 'bold' }}>{a.value}</span>
                                        <span style={{ color: theme.palette.text.secondary }}> / {a.limit} {a.unit || ''}</span>
                                    </TableCell>
                                    <TableCell sx={cellSx}>
                                        <Typography variant="body2" sx={{ color: isUnack ? color : theme.palette.text.secondary, fontWeight: isUnack ? 'bold' : 'normal' }}>
                                            {stateLabel(a.state)}
                                        </Typography>
                                        {a.ackBy && <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>by {a.ackBy}</Typography>}
                                    </TableCell>
                                    {canWrite && (
                                        <TableCell sx={cellSx} align="right">
                                            <Button
                                                size="small"
                                                onClick={() => onAck(a.id)}
                                                disabled={!isUnack}
                                                sx={{ textTransform: 'none', color: isUnack ? theme.palette.primary.main : theme.palette.text.disabled, minWidth: 0 }}
                                            >
                                                {isUnack ? 'Acknowledge' : 'Ack’d'}
                                            </Button>
                                        </TableCell>
                                    )}
                                </TableRow>
                            );
                        })}
                        {rows.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={canWrite ? 7 : 6} align="center" sx={{ color: STATUS.ok, py: 4, borderColor: theme.palette.divider }}>
                                    No active alarms — all clear.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </TableContainer>
        </Paper>
    );
}

function HistoryTable({ rows }) {
    const theme = useTheme();
    const headSx = { color: theme.palette.text.secondary, fontWeight: 'bold', borderColor: theme.palette.divider, whiteSpace: 'nowrap' };
    const cellSx = { color: theme.palette.text.primary, borderColor: theme.palette.divider };
    return (
        <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
            <Box sx={{ px: 1.5, py: 1 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main }}>
                    Alarm History (latest {rows.length})
                </Typography>
            </Box>
            <TableContainer>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell sx={headSx}>Time</TableCell>
                            <TableCell sx={headSx}>Event</TableCell>
                            <TableCell sx={headSx}>Priority</TableCell>
                            <TableCell sx={headSx}>Tag / Label</TableCell>
                            <TableCell sx={headSx}>Condition</TableCell>
                            <TableCell sx={headSx}>Value / Limit</TableCell>
                            <TableCell sx={headSx}>By</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map((e, i) => (
                            <TableRow key={`${e.ts}-${i}`} hover>
                                <TableCell sx={cellSx}>{formatClock(e.ts)}</TableCell>
                                <TableCell sx={cellSx}>
                                    <Chip label={e.type} size="small"
                                        sx={{ bgcolor: `${HISTORY_TYPE_COLOR[e.type] || '#64748b'}22`, color: HISTORY_TYPE_COLOR[e.type] || theme.palette.text.secondary, height: 20, fontWeight: 'bold' }} />
                                </TableCell>
                                <TableCell sx={cellSx}>{e.priority ? <PriorityChip priority={e.priority} /> : '--'}</TableCell>
                                <TableCell sx={cellSx}>{e.label || e.key}</TableCell>
                                <TableCell sx={cellSx}>{e.condition || '--'}</TableCell>
                                <TableCell sx={cellSx}>
                                    {e.value != null ? <>{e.value}{e.limit != null ? <span style={{ color: theme.palette.text.secondary }}> / {e.limit}</span> : null}</> : '--'}
                                </TableCell>
                                <TableCell sx={cellSx}>{e.by || '--'}</TableCell>
                            </TableRow>
                        ))}
                        {rows.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={7} align="center" sx={{ color: theme.palette.text.secondary, py: 4, borderColor: theme.palette.divider }}>
                                    No history.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </TableContainer>
        </Paper>
    );
}

export default function AlarmsPage() {
    const theme = useTheme();
    const { user } = useAuth();
    const canWrite = user?.role === 'admin' || user?.role === 'operator';

    const [tab, setTab] = useState(0);
    const [active, setActive] = useState([]);
    const [counts, setCounts] = useState({ active: 0, unack: 0, p1: 0, p2: 0, p3: 0, highest: null });
    const [history, setHistory] = useState([]);

    const loadActive = () => {
        axios.get('/api/rig/latest', { timeout: 3000 })
            .then(({ data }) => {
                if (!isLiveRigPayload(data)) {
                    setActive([]);
                    setCounts({ active: 0, unack: 0, p1: 0, p2: 0, p3: 0, highest: null });
                    return;
                }
                return axios.get('/api/alarms', { timeout: 3000 }).then((res) => {
                    setActive(res.data?.active || []);
                    if (res.data?.counts) setCounts(res.data.counts);
                });
            })
            .catch((err) => console.error('Failed to load alarms:', err));
    };

    const loadHistory = () => {
        axios.get('/api/alarms/history?limit=200', { timeout: 3000 })
            .then((res) => setHistory(Array.isArray(res.data) ? res.data : []))
            .catch((err) => console.error('Failed to load alarm history:', err));
    };

    useEffect(() => {
        const cached = getLatestAlarms();
        if (cached) {
            setActive(cached.active || []);
            if (cached.counts) setCounts(cached.counts);
        }
        loadActive();
        loadHistory();

        const handleAlarms = (payload) => {
            setActive(payload?.active || []);
            if (payload?.counts) setCounts(payload.counts);
        };
        const clearIfNoPlc = (payload) => {
            if (!isLiveRigPayload(payload)) {
                setActive([]);
                setCounts({ active: 0, unack: 0, p1: 0, p2: 0, p3: 0, highest: null });
            }
        };
        socket.on('alarms', handleAlarms);
        socket.on('rig_data', clearIfNoPlc);

        return () => {
            socket.off('alarms', handleAlarms);
            socket.off('rig_data', clearIfNoPlc);
        };
    }, []);

    const handleAck = async (id) => {
        try {
            await axios.post(`/api/alarms/${id}/ack`);
            loadActive();
            loadHistory();
        } catch (err) {
            console.error('Ack failed:', err);
        }
    };

    const handleAckAll = async () => {
        try {
            await axios.post('/api/alarms/ack-all');
            loadActive();
            loadHistory();
        } catch (err) {
            console.error('Ack-all failed:', err);
        }
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1.5 }}>
                <Typography variant="h6" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <ShieldAlert size={22} /> Alarm Management
                </Typography>

                {/* Priority count summary (text + color cue). */}
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    {[['P1', counts.p1], ['P2', counts.p2], ['P3', counts.p3]].map(([p, n]) => (
                        <Paper key={p} sx={{ px: 1.5, py: 0.75, bgcolor: theme.palette.background.paper, border: `1px solid ${priorityColor(p)}`, display: 'flex', alignItems: 'center', gap: 1 }}>
                            <PriorityChip priority={p} />
                            <Typography variant="h6" sx={{ color: theme.palette.text.primary, fontWeight: 'bold' }}>{n || 0}</Typography>
                        </Paper>
                    ))}
                    <Paper sx={{ px: 1.5, py: 0.75, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>UNACK</Typography>
                        <Typography variant="h6" sx={{ color: counts.unack > 0 ? STATUS.warn : STATUS.ok, fontWeight: 'bold' }}>{counts.unack || 0}</Typography>
                    </Paper>
                </Box>
            </Box>

            <Box sx={{ borderBottom: 1, borderColor: theme.palette.divider }}>
                <Tabs value={tab} onChange={(e, v) => { setTab(v); if (v === 1) loadHistory(); }} textColor="primary" indicatorColor="primary">
                    <Tab icon={<ShieldAlert size={16} />} iconPosition="start" label="Active" sx={{ color: tab === 0 ? theme.palette.primary.main : theme.palette.text.secondary, textTransform: 'none', minHeight: 44 }} />
                    <Tab icon={<HistoryIcon size={16} />} iconPosition="start" label="History" sx={{ color: tab === 1 ? theme.palette.primary.main : theme.palette.text.secondary, textTransform: 'none', minHeight: 44 }} />
                </Tabs>
            </Box>

            {tab === 0 && <ActiveTable rows={active} canWrite={canWrite} onAck={handleAck} onAckAll={handleAckAll} />}
            {tab === 1 && <HistoryTable rows={history} />}
        </Box>
    );
}
