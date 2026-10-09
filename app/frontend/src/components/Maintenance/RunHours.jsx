import React, { useState, useEffect, useCallback } from 'react';
import {
    Box, Paper, Typography, Table, TableBody, TableCell, TableContainer, TableHead,
    TableRow, Chip, Divider, Grid, Dialog, DialogTitle, DialogContent, DialogActions,
    Button, IconButton, useTheme
} from '@mui/material';
import { Gauge, Activity, History, X } from 'lucide-react';
import {
    ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis,
    CartesianGrid, Tooltip as RTooltip, Legend,
} from 'recharts';
import axios from '../../api';
import { isLiveRigPayload } from '../../socket';

// Distinct series colours for the parameter-trend chart.
const SERIES_COLORS = ['#38bdf8', '#4ade80', '#f59e0b', '#a78bfa', '#ef4444', '#22d3ee'];

// Run-hour log — per-equipment run history.
//
// Every start/stop of an asset is a RUN SESSION, judged from live readings.
// Exactly one health snapshot is taken a few minutes after each start, once the
// machine has settled into steady running, so the parameter fingerprints are
// comparable across restarts and can be used to spot degradation.

const POLL_MS = 15000;

const fmtTs = (ts) => {
    if (!ts) return '--';
    const d = new Date(ts);
    return isNaN(d) ? '--' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
};
const fmtDur = (h) => {
    if (h == null) return '--';
    const mins = Math.round(h * 60);
    return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
};

export default function RunHours() {
    const theme = useTheme();
    const [status, setStatus] = useState([]);
    const [daily, setDaily] = useState([]);
    const [assetId, setAssetId] = useState('');       // '' = fleet overview
    const [history, setHistory] = useState(null);
    const [meta, setMeta] = useState({});

    const headSx = { color: theme.palette.text.secondary, fontWeight: 'bold', borderColor: theme.palette.divider, whiteSpace: 'nowrap', fontSize: 12 };
    const cellSx = { color: theme.palette.text.primary, borderColor: theme.palette.divider, fontSize: 13 };

    const load = useCallback(() => {
        axios.get('/api/rig/latest', { timeout: 4500 })
            .then(({ data }) => {
                if (!isLiveRigPayload(data)) {
                    setStatus([]);
                    setDaily([]);
                    return;
                }
                axios.get('/api/cmms/runhours/status', { timeout: 4500 }).then((r) => setStatus(r.data || [])).catch(() => {});
                axios.get('/api/cmms/runhours/daily?days=14', { timeout: 4500 }).then((r) => setDaily(r.data || [])).catch(() => {});
            })
            .catch(() => { setStatus([]); setDaily([]); });
    }, []);

    useEffect(() => {
        load();
        axios.get('/api/cmms/meta', { timeout: 4500 }).then((r) => setMeta(r.data || {})).catch(() => {});
        const id = setInterval(load, POLL_MS);
        return () => clearInterval(id);
    }, [load]);

    // Per-equipment history whenever the selection changes (and on poll).
    useEffect(() => {
        if (!assetId) { setHistory(null); return undefined; }
        let alive = true;
        const fetchHist = () => axios.get(`/api/cmms/runhours/history/${assetId}`, { timeout: 4500 })
            .then((r) => { if (alive) setHistory(r.data); })
            .catch(() => {});
        fetchHist();
        const id = setInterval(fetchHist, POLL_MS);
        return () => { alive = false; clearInterval(id); };
    }, [assetId]);

    const paramText = (params) => {
        const e = Object.entries(params || {});
        if (!e.length) return '—';
        return e.map(([k, v]) => `${k}: ${v == null ? '—' : v}`).join('   ·   ');
    };

    // --- chart series for the history dialog -------------------------------
    // Daily running hours for the selected equipment (oldest -> newest).
    const dailyForAsset = assetId
        ? [...daily].reverse().map((d) => ({ date: d.date.slice(5), hours: Number(d.assets[assetId] || 0) }))
        : [];
    // Health-parameter trend across this equipment's settled snapshots.
    const snapSessions = (history?.sessions || []).filter((s) => s.snapshotAt && s.params).slice().reverse();
    const paramKeys = [...new Set(snapSessions.flatMap((s) => Object.keys(s.params || {})))];
    const paramSeries = snapSessions.map((s) => ({
        label: new Date(s.snapshotAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        hours: s.snapshotHours,
        ...s.params,
    }));
    // Run duration per start (how long each run lasted).
    const runSeries = (history?.sessions || [])
        .filter((s) => s.durationH != null)
        .slice().reverse()
        .map((s, idx) => ({ idx: idx + 1, label: new Date(s.startTs).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }), minutes: Number((s.durationH * 60).toFixed(1)) }));

    const axis = { stroke: theme.palette.text.secondary, fontSize: 11 };
    const tooltipStyle = {
        contentStyle: { backgroundColor: theme.palette.background.default, border: `1px solid ${theme.palette.divider}`, borderRadius: 8, fontSize: 12 },
        labelStyle: { color: theme.palette.text.secondary },
        itemStyle: { color: theme.palette.text.primary },
    };

    const ChartCard = ({ title, subtitle, children, empty }) => (
        <Paper sx={{ p: 1.5, bgcolor: theme.palette.action.hover, border: `1px solid ${theme.palette.divider}`, height: '100%' }}>
            <Typography variant="caption" sx={{ fontWeight: 800, letterSpacing: 0.6, color: theme.palette.text.secondary, textTransform: 'uppercase', fontSize: 10 }}>
                {title}
            </Typography>
            {subtitle && <Typography variant="caption" sx={{ display: 'block', color: theme.palette.text.secondary, mb: 0.5 }}>{subtitle}</Typography>}
            <Box sx={{ height: 190, mt: 0.5 }}>
                {empty
                    ? <Box sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>Not enough data yet</Typography>
                    </Box>
                    : <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>}
            </Box>
        </Paper>
    );

    const Stat = ({ label, value, color }) => (
        <Paper sx={{ p: 1.5, bgcolor: theme.palette.action.hover, border: `1px solid ${theme.palette.divider}`, textAlign: 'center' }}>
            <Typography variant="caption" sx={{ color: theme.palette.text.secondary, textTransform: 'uppercase', letterSpacing: 0.8, fontSize: 10 }}>{label}</Typography>
            <Typography sx={{ color: color || theme.palette.text.primary, fontWeight: 800, fontSize: 20, lineHeight: 1.3 }}>{value}</Typography>
        </Paper>
    );

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* Fleet-wide live state */}
            <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Gauge size={18} /> Equipment Run Hours
                    </Typography>
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                        · running state derived from live readings · one health snapshot {meta.snapshotDelayMin ?? 5} min after each start
                        · <b>click an equipment for its run history</b>
                    </Typography>
                </Box>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell sx={headSx}>Equipment</TableCell>
                                <TableCell sx={headSx}>State</TableCell>
                                <TableCell sx={headSx}>Running since</TableCell>
                                <TableCell sx={headSx} align="right">Cumulative hrs</TableCell>
                                <TableCell sx={headSx} align="right">Hours today</TableCell>
                                <TableCell sx={headSx} align="right">Starts</TableCell>
                                <TableCell sx={headSx} align="right">Snapshots</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {status.map((a) => (
                                <TableRow key={a.id} hover onClick={() => setAssetId(a.id)}
                                    title={`Open ${a.name} run history`}
                                    sx={{ cursor: 'pointer', '&:hover': { bgcolor: theme.palette.action.hover } }}>
                                    <TableCell sx={cellSx}>
                                        <Typography variant="body2" sx={{ fontWeight: 700 }}>{a.name}</Typography>
                                        <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>{a.category}</Typography>
                                    </TableCell>
                                    <TableCell sx={cellSx}>
                                        <Chip label={a.running ? 'RUNNING' : 'STOPPED'} size="small"
                                            sx={{
                                                height: 20, fontSize: 10, fontWeight: 800,
                                                bgcolor: a.running ? 'rgba(74,222,128,0.15)' : 'rgba(100,116,139,0.15)',
                                                color: a.running ? '#4ade80' : '#94a3b8',
                                            }} />
                                        {a.snapshotPending && (
                                            <Chip label="SNAPSHOT DUE" size="small" sx={{ ml: 0.5, height: 20, fontSize: 9, fontWeight: 800, bgcolor: 'rgba(56,189,248,0.15)', color: '#38bdf8' }} />
                                        )}
                                    </TableCell>
                                    <TableCell sx={{ ...cellSx, whiteSpace: 'nowrap', color: theme.palette.text.secondary }}>{a.running ? fmtTs(a.since) : '--'}</TableCell>
                                    <TableCell sx={{ ...cellSx, fontFamily: 'monospace', fontWeight: 800 }} align="right">{a.hours != null ? a.hours.toFixed(1) : '—'}</TableCell>
                                    <TableCell sx={{ ...cellSx, fontFamily: 'monospace', color: a.hoursToday > 0 ? '#4ade80' : theme.palette.text.secondary }} align="right">{a.hoursToday.toFixed(2)}</TableCell>
                                    <TableCell sx={{ ...cellSx, color: theme.palette.text.secondary }} align="right">{a.starts}</TableCell>
                                    <TableCell sx={{ ...cellSx, color: theme.palette.text.secondary }} align="right">{a.snapshots}</TableCell>
                                </TableRow>
                            ))}
                            {status.length === 0 && (
                                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 3, color: theme.palette.text.secondary, borderColor: theme.palette.divider }}>
                                    No equipment reporting.
                                </TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* Per-equipment history — opens when an equipment row is clicked */}
            <Dialog open={!!assetId} onClose={() => setAssetId('')} maxWidth="lg" fullWidth
                PaperProps={{ sx: { bgcolor: theme.palette.background.paper, backgroundImage: 'none' } }}>
                <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: 'bold', color: theme.palette.primary.main, pr: 6 }}>
                    <History size={19} />
                    {history ? history.assetName : 'Equipment'} — Run History
                    {history?.running && (
                        <Chip label="RUNNING" size="small" sx={{ height: 20, fontSize: 10, fontWeight: 800, bgcolor: 'rgba(74,222,128,0.15)', color: '#4ade80' }} />
                    )}
                    <IconButton onClick={() => setAssetId('')} size="small" sx={{ position: 'absolute', right: 12, top: 12, color: theme.palette.text.secondary }} aria-label="Close">
                        <X size={18} />
                    </IconButton>
                </DialogTitle>
                <DialogContent dividers sx={{ p: 0 }}>
                {history && (
                    <>
                        <Box sx={{ px: 2, pb: 2 }}>
                            <Grid container spacing={1.5}>
                                <Grid item xs={6} sm={4} md={2}><Stat label="Starts" value={history.starts} /></Grid>
                                <Grid item xs={6} sm={4} md={2}><Stat label="Completed runs" value={history.completedRuns} /></Grid>
                                <Grid item xs={6} sm={4} md={2}><Stat label="Total run" value={fmtDur(history.totalRunHours)} color="#38bdf8" /></Grid>
                                <Grid item xs={6} sm={4} md={2}><Stat label="Avg per run" value={fmtDur(history.avgRunHours)} /></Grid>
                                <Grid item xs={6} sm={4} md={2}><Stat label="Snapshots" value={history.snapshots} color="#4ade80" /></Grid>
                                <Grid item xs={6} sm={4} md={2}><Stat label="Short runs" value={history.shortRuns} color={history.shortRuns ? '#f59e0b' : undefined} /></Grid>
                            </Grid>
                        </Box>

                        {/* Charts: running-hours history + health-parameter trend */}
                        <Box sx={{ px: 2, pb: 2 }}>
                            <Grid container spacing={1.5}>
                                <Grid item xs={12} md={6}>
                                    <ChartCard title="Daily running hours" subtitle="hours run per day" empty={dailyForAsset.length === 0}>
                                        <BarChart data={dailyForAsset} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} vertical={false} />
                                            <XAxis dataKey="date" {...axis} tickLine={false} />
                                            <YAxis {...axis} tickLine={false} width={38} />
                                            <RTooltip {...tooltipStyle} formatter={(v) => [`${Number(v).toFixed(2)} h`, 'Run time']} />
                                            <Bar dataKey="hours" fill="#38bdf8" radius={[3, 3, 0, 0]} />
                                        </BarChart>
                                    </ChartCard>
                                </Grid>
                                <Grid item xs={12} md={6}>
                                    <ChartCard title="Run duration per start" subtitle="how long each run lasted (minutes)" empty={runSeries.length === 0}>
                                        <BarChart data={runSeries} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} vertical={false} />
                                            <XAxis dataKey="label" {...axis} tickLine={false} />
                                            <YAxis {...axis} tickLine={false} width={38} />
                                            <RTooltip {...tooltipStyle} formatter={(v) => [`${v} min`, 'Run']} />
                                            <Bar dataKey="minutes" fill="#4ade80" radius={[3, 3, 0, 0]} />
                                        </BarChart>
                                    </ChartCard>
                                </Grid>
                                <Grid item xs={12}>
                                    <ChartCard
                                        title="Health parameters across runs"
                                        subtitle={`each point is the settled snapshot taken ${meta.snapshotDelayMin ?? 5} min after a start — a rising or falling trend is the degradation signal`}
                                        empty={paramSeries.length < 2}
                                    >
                                        <LineChart data={paramSeries} margin={{ top: 4, right: 12, left: -18, bottom: 0 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} vertical={false} />
                                            <XAxis dataKey="label" {...axis} tickLine={false} />
                                            <YAxis {...axis} tickLine={false} width={38} />
                                            <RTooltip {...tooltipStyle} />
                                            <Legend wrapperStyle={{ fontSize: 11 }} />
                                            {paramKeys.map((k, i) => (
                                                <Line key={k} type="monotone" dataKey={k} stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                                                    strokeWidth={2} dot={{ r: 2.5 }} isAnimationActive={false} connectNulls />
                                            ))}
                                        </LineChart>
                                    </ChartCard>
                                </Grid>
                            </Grid>
                        </Box>

                        <Divider sx={{ borderColor: theme.palette.divider }} />
                        <TableContainer sx={{ maxHeight: '55vh' }}>
                            <Table size="small" stickyHeader>
                                <TableHead>
                                    <TableRow>
                                        <TableCell sx={{ ...headSx, bgcolor: theme.palette.background.paper }}>Started</TableCell>
                                        <TableCell sx={{ ...headSx, bgcolor: theme.palette.background.paper }}>Stopped</TableCell>
                                        <TableCell sx={{ ...headSx, bgcolor: theme.palette.background.paper }} align="right">Run time</TableCell>
                                        <TableCell sx={{ ...headSx, bgcolor: theme.palette.background.paper }} align="right">Hours @ start</TableCell>
                                        <TableCell sx={{ ...headSx, bgcolor: theme.palette.background.paper }}>Health snapshot ({meta.snapshotDelayMin ?? 5} min in)</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {(history.sessions || []).map((s) => (
                                        <TableRow key={s.id} hover>
                                            <TableCell sx={{ ...cellSx, whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{fmtTs(s.startTs)}</TableCell>
                                            <TableCell sx={{ ...cellSx, whiteSpace: 'nowrap', fontFamily: 'monospace', color: s.endTs ? theme.palette.text.primary : '#4ade80' }}>
                                                {s.endTs ? fmtTs(s.endTs) : 'running…'}
                                            </TableCell>
                                            <TableCell sx={{ ...cellSx, fontFamily: 'monospace' }} align="right">{fmtDur(s.durationH)}</TableCell>
                                            <TableCell sx={{ ...cellSx, fontFamily: 'monospace', fontWeight: 700 }} align="right">{s.startHours != null ? s.startHours.toFixed(1) : '—'}</TableCell>
                                            <TableCell sx={{ ...cellSx, fontFamily: 'monospace', fontSize: 12 }}>
                                                {s.snapshotAt ? (
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                                        <Chip label={`@ ${s.snapshotHours != null ? s.snapshotHours.toFixed(1) : '—'} h`} size="small"
                                                            sx={{ height: 18, fontSize: 9.5, fontWeight: 800, bgcolor: 'rgba(74,222,128,0.15)', color: '#4ade80' }} />
                                                        <span style={{ color: theme.palette.text.secondary }}>{paramText(s.params)}</span>
                                                    </Box>
                                                ) : s.snapshotSkipped ? (
                                                    <Typography variant="caption" sx={{ color: '#f59e0b' }}>run too short — no snapshot</Typography>
                                                ) : (
                                                    <Typography variant="caption" sx={{ color: '#38bdf8' }}>pending…</Typography>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                    {(history.sessions || []).length === 0 && (
                                        <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4, color: theme.palette.text.secondary, borderColor: theme.palette.divider }}>
                                            No runs recorded for this equipment yet.
                                        </TableCell></TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </>
                )}
                </DialogContent>
                <DialogActions sx={{ px: 3, py: 1.5 }}>
                    <Button onClick={() => setAssetId('')} sx={{ textTransform: 'none' }}>Close</Button>
                </DialogActions>
            </Dialog>

            {/* Daily running hours */}
            <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Box sx={{ p: 2 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Activity size={18} /> Daily Running Hours
                    </Typography>
                </Box>
                <TableContainer sx={{ maxHeight: 300 }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell sx={{ ...headSx, bgcolor: theme.palette.background.paper }}>Date</TableCell>
                                {status.map((a) => <TableCell key={a.id} sx={{ ...headSx, bgcolor: theme.palette.background.paper }} align="right">{a.name}</TableCell>)}
                                <TableCell sx={{ ...headSx, bgcolor: theme.palette.background.paper }} align="right">Total</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {daily.map((d) => (
                                <TableRow key={d.date} hover>
                                    <TableCell sx={{ ...cellSx, whiteSpace: 'nowrap' }}>{d.date}</TableCell>
                                    {status.map((a) => (
                                        <TableCell key={a.id} sx={{ ...cellSx, fontFamily: 'monospace', color: d.assets[a.id] ? theme.palette.text.primary : theme.palette.text.secondary }} align="right">
                                            {d.assets[a.id] ? d.assets[a.id].toFixed(2) : '—'}
                                        </TableCell>
                                    ))}
                                    <TableCell sx={{ ...cellSx, fontFamily: 'monospace', fontWeight: 800 }} align="right">{d.total.toFixed(2)}</TableCell>
                                </TableRow>
                            ))}
                            {daily.length === 0 && (
                                <TableRow><TableCell colSpan={status.length + 2} align="center" sx={{ py: 3, color: theme.palette.text.secondary, borderColor: theme.palette.divider }}>
                                    No running hours accrued yet.
                                </TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>
        </Box>
    );
}
