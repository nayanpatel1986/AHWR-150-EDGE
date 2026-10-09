import React, { useState, useEffect, useMemo } from 'react';
import {
    Box, Typography, Paper, Grid, Button, Select, MenuItem, FormControl,
    InputLabel, Chip, Table, TableBody, TableCell, TableContainer, TableHead,
    TableRow, Snackbar, Alert, useTheme
} from '@mui/material';
import { Activity as ActivityIcon, Clock, Zap, RotateCcw, CheckCircle2, AlertTriangle } from 'lucide-react';
import axios from '../../api';
import { getLatestRigData, socket } from '../../socket';
import { useAuth } from '../../context/AuthContext';
import { formatDuration, formatClock, secondsSince, todayISO } from '../../utils/format';

// Semantic status colors (kept across all themes intentionally).
const STATUS = { prod: '#4ade80', npt: '#ef4444', other: '#f59e0b' };

export default function ActivityPage() {
    const theme = useTheme();
    const { user } = useAuth();
    const canWrite = user?.role === 'admin' || user?.role === 'operator';

    const headSx = { color: theme.palette.text.secondary, fontWeight: 'bold', borderColor: theme.palette.divider, whiteSpace: 'nowrap' };
    const cellSx = { color: theme.palette.text.primary, borderColor: theme.palette.divider };
    const fieldSx = {
        bgcolor: theme.palette.background.default,
        color: theme.palette.text.primary,
        '.MuiSvgIcon-root': { color: theme.palette.text.primary },
        '.MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.divider }
    };

    const [current, setCurrent] = useState(null); // {code,label,productive,npt,source,since,suggested}
    const [codes, setCodes] = useState([]);
    const [nptReasons, setNptReasons] = useState([]);
    const [log, setLog] = useState([]);
    const [selCode, setSelCode] = useState('');
    const [selReason, setSelReason] = useState('');
    const [notification, setNotification] = useState({ open: false, message: '', severity: 'success' });
    // Live "since" counter.
    const [, setTick] = useState(0);

    const showNote = (message, severity = 'success') => setNotification({ open: true, message, severity });

    const loadCurrent = () => {
        axios.get('/api/activity/current')
            .then((res) => setCurrent(res.data))
            .catch((err) => console.error('Failed to load current activity:', err));
    };

    const loadLog = () => {
        axios.get(`/api/activity/log?date=${todayISO()}`)
            .then((res) => setLog(Array.isArray(res.data) ? res.data : []))
            .catch((err) => console.error('Failed to load activity log:', err));
    };

    useEffect(() => {
        const cachedActivity = getLatestRigData()?._activity;
        if (cachedActivity) setCurrent((prev) => ({ ...prev, ...cachedActivity }));
        loadCurrent();
        loadLog();
        axios.get('/api/activity/codes')
            .then((res) => {
                setCodes(res.data?.codes || []);
                setNptReasons(res.data?.nptReasons || []);
            })
            .catch((err) => console.error('Failed to load activity codes:', err));

        // Live update: rig_data carries _activity. Refresh current + log when the
        // activity code changes.
        let lastCode;
        const handler = (data) => {
            const act = data?._activity;
            if (!act) return;
            setCurrent((prev) => ({ ...prev, ...act }));
            if (act.code !== lastCode) {
                lastCode = act.code;
                loadLog();
            }
        };
        socket.on('rig_data', handler);

        // Poll the log every 15s as a backstop (durations tick up server-side).
        const logPoll = setInterval(loadLog, 15000);
        // 1s ticker for the live "since" elapsed display.
        const ticker = setInterval(() => setTick((t) => t + 1), 1000);

        return () => {
            socket.off('rig_data', handler);
            clearInterval(logPoll);
            clearInterval(ticker);
        };
    }, []);

    // NPT reason needed when a non-productive / WAIT code is chosen.
    const selCodeMeta = useMemo(() => codes.find((c) => c.code === selCode), [codes, selCode]);
    const needsReason = selCode && (selCode === 'WAIT' || (selCodeMeta && selCodeMeta.productive === false));

    const handleSet = async () => {
        if (!selCode) return;
        try {
            const payload = { code: selCode };
            if (needsReason && selReason) payload.npt = { reason: selReason };
            await axios.post('/api/activity/set', payload);
            showNote(`Activity set to ${selCode}`);
            setSelCode('');
            setSelReason('');
            loadCurrent();
            loadLog();
        } catch (err) {
            console.error('Set activity failed:', err);
            showNote(err.response?.data?.error || 'Failed to set activity', 'error');
        }
    };

    const handleAuto = async () => {
        try {
            await axios.post('/api/activity/set', { code: 'AUTO' });
            showNote('Returned to auto-classification');
            setSelCode('');
            setSelReason('');
            loadCurrent();
            loadLog();
        } catch (err) {
            console.error('Return to auto failed:', err);
            showNote('Failed to return to auto', 'error');
        }
    };

    // Productive vs NPT totals from the log.
    const totals = useMemo(() => {
        let prod = 0; let npt = 0; let other = 0;
        for (const e of log) {
            const d = e.durationSec || 0;
            if (e.npt) npt += d;
            else if (e.productive) prod += d;
            else other += d;
        }
        const total = prod + npt + other || 1;
        return { prod, npt, other, total, prodPct: (prod / total) * 100, nptPct: (npt / total) * 100, otherPct: (other / total) * 100 };
    }, [log]);

    const isProductive = current?.productive;
    const isNpt = current?.npt;
    const statusColor = isNpt ? STATUS.npt : isProductive ? STATUS.prod : STATUS.other;
    const sinceSec = current?.since ? secondsSince(current.since) : 0;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Typography variant="h6" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <ActivityIcon size={22} /> Activity / Tour
                </Typography>

                <Grid container spacing={2}>
                    {/* Current activity */}
                    <Grid item xs={12} md={7}>
                        <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${statusColor}`, height: '100%' }}>
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary, textTransform: 'uppercase', letterSpacing: 1 }}>
                                Current Activity
                            </Typography>
                            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mt: 0.5, flexWrap: 'wrap' }}>
                                <Typography variant="h3" sx={{ fontWeight: 'bold', color: statusColor }}>
                                    {current?.code || '--'}
                                </Typography>
                                <Typography variant="h6" sx={{ color: theme.palette.text.primary }}>{current?.label || 'No data'}</Typography>
                            </Box>
                            <Box sx={{ display: 'flex', gap: 1, mt: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
                                <Chip
                                    icon={isNpt ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
                                    label={isNpt ? 'NPT' : isProductive ? 'Productive' : 'Non-productive'}
                                    size="small"
                                    sx={{ bgcolor: `${statusColor}22`, color: statusColor, fontWeight: 'bold', '& .MuiChip-icon': { color: statusColor } }}
                                />
                                <Chip
                                    label={`Source: ${current?.source === 'manual' ? 'Manual override' : 'Auto'}`}
                                    size="small"
                                    variant="outlined"
                                    sx={{ color: theme.palette.text.secondary, borderColor: theme.palette.divider }}
                                />
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: theme.palette.text.secondary }}>
                                    <Clock size={16} />
                                    <Typography variant="body2">{formatDuration(sinceSec)} since {formatClock(current?.since)}</Typography>
                                </Box>
                            </Box>
                            {current?.suggested && current.suggested !== current.code && (
                                <Box sx={{ mt: 1.5, p: 1.25, bgcolor: theme.palette.background.default, borderRadius: 1, border: `1px dashed ${theme.palette.divider}`, display: 'flex', alignItems: 'center', gap: 1 }}>
                                    <Zap size={16} color={theme.palette.primary.main} />
                                    <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                                        Auto suggestion: <span style={{ color: theme.palette.primary.main, fontWeight: 'bold' }}>{current.suggested}</span>
                                    </Typography>
                                </Box>
                            )}
                        </Paper>
                    </Grid>

                    {/* Manual set control */}
                    <Grid item xs={12} md={5}>
                        <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, height: '100%' }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, mb: 1.5 }}>
                                Set Activity
                            </Typography>
                            {!canWrite ? (
                                <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                                    Read-only. Operator or admin role required to change activity.
                                </Typography>
                            ) : (
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                                    <FormControl fullWidth size="small">
                                        <InputLabel sx={{ color: theme.palette.text.secondary }}>Activity code</InputLabel>
                                        <Select
                                            value={selCode}
                                            label="Activity code"
                                            onChange={(e) => { setSelCode(e.target.value); setSelReason(''); }}
                                            sx={fieldSx}
                                        >
                                            {codes.map((c) => (
                                                <MenuItem key={c.code} value={c.code}>
                                                    {c.code} — {c.label}{c.productive === false ? ' (NPT)' : ''}
                                                </MenuItem>
                                            ))}
                                        </Select>
                                    </FormControl>

                                    {needsReason && (
                                        <FormControl fullWidth size="small">
                                            <InputLabel sx={{ color: theme.palette.text.secondary }}>NPT reason</InputLabel>
                                            <Select
                                                value={selReason}
                                                label="NPT reason"
                                                onChange={(e) => setSelReason(e.target.value)}
                                                sx={fieldSx}
                                            >
                                                {nptReasons.map((r) => {
                                                    const val = typeof r === 'string' ? r : (r.reason || r.code || r.label);
                                                    const lbl = typeof r === 'string' ? r : (r.label || r.reason || r.code);
                                                    return <MenuItem key={val} value={val}>{lbl}</MenuItem>;
                                                })}
                                            </Select>
                                        </FormControl>
                                    )}

                                    <Box sx={{ display: 'flex', gap: 1 }}>
                                        <Button
                                            variant="contained"
                                            onClick={handleSet}
                                            disabled={!selCode || (needsReason && !selReason)}
                                            sx={{ textTransform: 'none', fontWeight: 'bold' }}
                                        >
                                            Set
                                        </Button>
                                        <Button
                                            variant="outlined"
                                            startIcon={<RotateCcw size={16} />}
                                            onClick={handleAuto}
                                            sx={{ color: theme.palette.text.secondary, borderColor: theme.palette.divider, textTransform: 'none' }}
                                        >
                                            Return to Auto
                                        </Button>
                                    </Box>
                                </Box>
                            )}
                        </Paper>
                    </Grid>
                </Grid>

                {/* Productive vs NPT summary */}
                <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, mb: 1.5 }}>
                        Today — Productive vs NPT
                    </Typography>
                    <Box sx={{ display: 'flex', height: 24, borderRadius: 1, overflow: 'hidden', border: `1px solid ${theme.palette.divider}` }}>
                        <Box sx={{ width: `${totals.prodPct}%`, bgcolor: STATUS.prod }} title={`Productive ${formatDuration(totals.prod)}`} />
                        <Box sx={{ width: `${totals.nptPct}%`, bgcolor: STATUS.npt }} title={`NPT ${formatDuration(totals.npt)}`} />
                        <Box sx={{ width: `${totals.otherPct}%`, bgcolor: '#64748b' }} title={`Other ${formatDuration(totals.other)}`} />
                    </Box>
                    <Box sx={{ display: 'flex', gap: 3, mt: 1.25, flexWrap: 'wrap' }}>
                        <LegendItem theme={theme} color={STATUS.prod} label="Productive" value={formatDuration(totals.prod)} />
                        <LegendItem theme={theme} color={STATUS.npt} label="NPT" value={formatDuration(totals.npt)} />
                        <LegendItem theme={theme} color="#64748b" label="Other" value={formatDuration(totals.other)} />
                    </Box>
                </Paper>

                {/* Activity timeline */}
                <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                    <Box sx={{ p: 1.5 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main }}>
                            Today’s Activity Timeline
                        </Typography>
                    </Box>
                    <TableContainer>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell sx={headSx}>Start</TableCell>
                                    <TableCell sx={headSx}>End</TableCell>
                                    <TableCell sx={headSx}>Code</TableCell>
                                    <TableCell sx={headSx}>Label</TableCell>
                                    <TableCell sx={headSx}>Type</TableCell>
                                    <TableCell sx={headSx}>Duration</TableCell>
                                    <TableCell sx={headSx}>Depth</TableCell>
                                    <TableCell sx={headSx}>Source</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {[...log].reverse().map((e, i) => {
                                    const c = e.npt ? STATUS.npt : e.productive ? STATUS.prod : STATUS.other;
                                    return (
                                        <TableRow key={`${e.start}-${i}`} hover>
                                            <TableCell sx={cellSx}>{formatClock(e.start)}</TableCell>
                                            <TableCell sx={cellSx}>{e.end ? formatClock(e.end) : <span style={{ color: STATUS.prod }}>ongoing</span>}</TableCell>
                                            <TableCell sx={cellSx}><span style={{ color: c, fontWeight: 'bold' }}>{e.code}</span></TableCell>
                                            <TableCell sx={cellSx}>{e.label}</TableCell>
                                            <TableCell sx={cellSx}>
                                                <Chip label={e.npt ? 'NPT' : e.productive ? 'Prod' : 'Other'} size="small"
                                                    sx={{ bgcolor: `${c}22`, color: c, height: 20, fontWeight: 'bold' }} />
                                            </TableCell>
                                            <TableCell sx={cellSx}>{formatDuration(e.durationSec)}</TableCell>
                                            <TableCell sx={cellSx}>{e.depth != null ? `${e.depth} m` : '--'}</TableCell>
                                            <TableCell sx={cellSx}>{e.source || 'auto'}</TableCell>
                                        </TableRow>
                                    );
                                })}
                                {log.length === 0 && (
                                    <TableRow>
                                        <TableCell colSpan={8} align="center" sx={{ color: theme.palette.text.secondary, py: 4, borderColor: theme.palette.divider }}>
                                            No activity logged today yet.
                                        </TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </TableContainer>
                </Paper>

            <Snackbar open={notification.open} autoHideDuration={4000} onClose={() => setNotification({ ...notification, open: false })}>
                <Alert severity={notification.severity} variant="filled">{notification.message}</Alert>
            </Snackbar>
        </Box>
    );
}

function LegendItem({ theme, color, label, value }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Box sx={{ width: 12, height: 12, borderRadius: '2px', bgcolor: color }} />
            <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                {label}: <span style={{ color: theme.palette.text.primary, fontWeight: 'bold' }}>{value}</span>
            </Typography>
        </Box>
    );
}
