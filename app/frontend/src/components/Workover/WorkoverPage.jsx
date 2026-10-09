import React, { useState, useEffect, useMemo } from 'react';
import {
    Box, Typography, Paper, Grid, Chip, Table, TableBody, TableCell,
    TableContainer, TableHead, TableRow, useTheme
} from '@mui/material';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
    ReferenceLine, Legend
} from 'recharts';
import { Gauge as GaugeIcon, Wrench, ListChecks, Activity as ActivityIcon } from 'lucide-react';
import axios from '../../api';
import { getLatestRigData, isLiveRigPayload, socket } from '../../socket';
import { formatClock } from '../../utils/format';
import EdrView from '../EDR/EdrView';

// Semantic status colors (kept across all themes intentionally).
const STATUS = { ok: '#4ade80', fail: '#ef4444', warn: '#f59e0b' };

// ---- Local presentational helpers (flat/dense tiles instead of analog dials) ----

const ValueTile = ({ label, value, unit, decimals = 0, color = '#38bdf8', min = 0, max, warn, crit, sub }) => {
    const num = Number(value);
    const has = Number.isFinite(num);
    const display = has ? num.toFixed(decimals) : '--';

    let accent = color;
    let ratio = null;
    if (has && Number.isFinite(max) && max > min) {
        ratio = Math.min(Math.max((num - min) / (max - min), 0), 1);
        if (crit != null && num >= crit) accent = STATUS.fail;
        else if (warn != null && num >= warn) accent = STATUS.warn;
    }

    return (
        <Paper sx={{ p: 1.5, bgcolor: 'background.paper', border: '1px solid', borderColor: accent === color ? 'divider' : accent, borderRadius: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
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

const SectionTitle = ({ children, sx }) => (
    <Typography sx={{ color: 'text.secondary', fontSize: '0.7rem', fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', mb: 1, ...sx }}>{children}</Typography>
);

// EDR side-strip definition for this page.
const EDR_CHANNELS = ['drilling.wob', 'drilling.hook_load', 'pct.makeup_torque', 'mudpump.spm', 'mudpump.pressure'];
const EDR_STRIPS = [
    { title: 'Load & Pump', pens: [
        { channelId: 'drilling.wob', color: '#38bdf8', min: 0, max: 100, enabled: true },
        { channelId: 'drilling.hook_load', color: '#fbbf24', min: 0, max: 500, enabled: true },
        { channelId: 'mudpump.spm', color: '#f472b6', min: 0, max: 200, enabled: true }
    ] }
];

// Configured alarm hi-limits (bar). Tubing hi 200, casing hi 150, wellhead 200.
const DEFAULT_LIMITS = { tubing_pressure: 200, casing_pressure: 150, wellhead_pressure: 200 };

function TorqueTurnGraph({ tt, theme }) {
    const active = tt?.active;
    const samples = tt?.samples || [];
    const limits = tt?.limits || {};
    const unit = limits.unit || 'daN·m';
    const axisColor = theme.palette.text.secondary;
    const gridColor = theme.palette.divider;

    const data = useMemo(() => samples.map((s) => ({
        t: typeof s.t === 'number' ? s.t : Number(s.t) || 0,
        torque: s.torque,
    })), [samples]);

    return (
        <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Wrench size={18} /> Make-up Torque vs Time
                </Typography>
                <Chip
                    label={active ? 'MAKE-UP IN PROGRESS' : 'IDLE'}
                    size="small"
                    sx={{
                        bgcolor: active ? `${STATUS.ok}26` : theme.palette.background.default,
                        color: active ? STATUS.ok : theme.palette.text.secondary,
                        fontWeight: 'bold', border: `1px solid ${active ? STATUS.ok : theme.palette.divider}`,
                    }}
                />
            </Box>
            {active && data.length > 0 ? (
                <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                        <XAxis dataKey="t" stroke={axisColor} fontSize={12}
                            label={{ value: 'Time (s)', position: 'insideBottom', offset: -4, fill: axisColor, fontSize: 12 }} />
                        <YAxis stroke={axisColor} fontSize={12}
                            label={{ value: unit, angle: -90, position: 'insideLeft', fill: axisColor, fontSize: 12 }} />
                        <Tooltip contentStyle={{ backgroundColor: theme.palette.background.default, border: `1px solid ${theme.palette.divider}` }} />
                        <Legend />
                        {limits.minTorque != null && (
                            <ReferenceLine y={limits.minTorque} stroke={STATUS.warn} strokeDasharray="6 4"
                                label={{ value: `Min ${limits.minTorque}`, fill: STATUS.warn, fontSize: 11, position: 'insideTopLeft' }} />
                        )}
                        {limits.maxTorque != null && (
                            <ReferenceLine y={limits.maxTorque} stroke={STATUS.fail} strokeDasharray="6 4"
                                label={{ value: `Max ${limits.maxTorque}`, fill: STATUS.fail, fontSize: 11, position: 'insideTopLeft' }} />
                        )}
                        {limits.dumpTorque != null && (
                            <ReferenceLine y={limits.dumpTorque} stroke={theme.palette.primary.main} strokeDasharray="2 4"
                                label={{ value: `Dump ${limits.dumpTorque}`, fill: theme.palette.primary.main, fontSize: 11, position: 'insideBottomLeft' }} />
                        )}
                        <Line type="monotone" dataKey="torque" name={`Torque (${unit})`} stroke={theme.palette.primary.main} strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                </ResponsiveContainer>
            ) : (
                <Box sx={{ height: 280, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: theme.palette.text.secondary, gap: 1 }}>
                    <Wrench size={40} />
                    <Typography variant="body1">No make-up in progress</Typography>
                </Box>
            )}
        </Paper>
    );
}

export default function WorkoverPage() {
    const theme = useTheme();
    const headSx = { color: theme.palette.text.secondary, fontWeight: 'bold', borderColor: theme.palette.divider, whiteSpace: 'nowrap' };
    const cellSx = { color: theme.palette.text.primary, borderColor: theme.palette.divider };

    const [wellhead, setWellhead] = useState({});
    // Key workover load/pump/torque params surfaced as tiles.
    const [ops, setOps] = useState({});
    const [tt, setTt] = useState({ active: false, samples: [], limits: {} });
    const [conn, setConn] = useState({ tally: { run: 0, pass: 0, fail: 0 }, limits: {}, jointCounter: 0, records: [] });
    const [limits, setLimits] = useState(DEFAULT_LIMITS);

    const loadConnections = () => {
        axios.get('/api/connections')
            .then((res) => setConn((prev) => ({ ...prev, ...res.data })))
            .catch((err) => console.error('Failed to load connections:', err));
    };

    useEffect(() => {
        const cached = getLatestRigData();
        if (isLiveRigPayload(cached)) {
            if (cached?.wellhead) setWellhead((p) => ({ ...p, ...cached.wellhead }));
            applyOps(cached);
            if (cached?._torqueturn) setTt(cached._torqueturn);
        }
        // Seed from REST.
        axios.get('/api/rig/latest')
            .then((res) => {
                if (!isLiveRigPayload(res.data)) { setWellhead({}); setOps({}); setTt({ active: false, samples: [], limits: {} }); return; }
                if (res.data?.wellhead) setWellhead((p) => ({ ...p, ...res.data.wellhead }));
                applyOps(res.data);
            })
            .catch(() => {});
        axios.get('/api/torqueturn/current')
            .then((res) => { if (res.data) setTt(res.data); })
            .catch((err) => console.error('Failed to load torque-turn:', err));
        loadConnections();
        // Read configured pressure hi-limits where available.
        axios.get('/api/alarms/config')
            .then((res) => {
                const cfg = res.data || {};
                const next = { ...DEFAULT_LIMITS };
                // Config may be keyed by dataKey with hi/hihi thresholds.
                const pick = (k) => cfg[k]?.hi ?? cfg[k]?.hihi ?? cfg[k]?.limit;
                ['tubing_pressure', 'casing_pressure', 'wellhead_pressure'].forEach((k) => {
                    const v = pick(k);
                    if (typeof v === 'number') next[k] = v;
                });
                setLimits(next);
            })
            .catch(() => { /* fall back to labelled defaults */ });

        // Live wellhead + load/pump params + torque-turn from rig_data.
        const handleRig = (data) => {
            if (!isLiveRigPayload(data)) { setWellhead({}); setOps({}); setTt({ active: false, samples: [], limits: {} }); return; }
            if (data?.wellhead) setWellhead((p) => ({ ...p, ...data.wellhead }));
            applyOps(data);
            if (data?._torqueturn) setTt(data._torqueturn);
        };
        socket.on('rig_data', handleRig);

        // Prepend new connections live.
        const handleConnection = (rec) => {
            if (!rec) return;
            setConn((prev) => {
                const tally = { ...prev.tally };
                tally.run = (tally.run || 0) + 1;
                if (rec.result === 'PASS') tally.pass = (tally.pass || 0) + 1;
                if (rec.result === 'FAIL') tally.fail = (tally.fail || 0) + 1;
                return {
                    ...prev,
                    tally,
                    jointCounter: rec.joint ?? prev.jointCounter,
                    records: [rec, ...(prev.records || [])].slice(0, 100),
                };
            });
        };
        socket.on('connection_made', handleConnection);

        return () => {
            socket.off('rig_data', handleRig);
            socket.off('connection_made', handleConnection);
        };
    }, []);

    const applyOps = (data) => {
        if (!data) return;
        // Keep the previous value when a field is absent; never coerce a missing
        // tag into a NaN tile.
        const pick = (raw, prev) => {
            if (raw == null) return prev;
            const n = Number(raw);
            return Number.isFinite(n) ? n : prev;
        };
        setOps((p) => ({
            hook_load: pick(data.drawworks?.hook_load, p.hook_load),
            wob: pick(data.drilling?.wob, p.wob),
            makeup_torque: pick(data.pct?.makeup_torque, p.makeup_torque),
            spm: pick(data.mudpump?.spm, p.spm),
            pressure: pick(data.mudpump?.pressure, p.pressure)
        }));
    };

    const records = conn.records || [];
    const tally = conn.tally || { run: 0, pass: 0, fail: 0 };
    // Live make-up torque max (daN·m) for the tile threshold accent, when known.
    const ttMax = tt?.limits?.maxTorque;

    return (
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: { xs: 'wrap', lg: 'nowrap' } }}>
            {/* Main content column */}
            <Box sx={{ flex: '1 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>


                {/* Wellhead pressures (bar) — tiles with configured hi-limit accent. */}
                <Box>
                    <SectionTitle>Wellhead Pressures</SectionTitle>
                    <Grid container spacing={1.5}>
                        <Grid item xs={6} sm={4}>
                            <ValueTile label="Tubing" value={wellhead.tubing_pressure} unit="bar" decimals={1} color="#38bdf8" min={0} max={250} warn={limits.tubing_pressure * 0.85} crit={limits.tubing_pressure} sub={`HI limit ${limits.tubing_pressure} bar`} />
                        </Grid>
                        <Grid item xs={6} sm={4}>
                            <ValueTile label="Casing" value={wellhead.casing_pressure} unit="bar" decimals={1} color="#fbbf24" min={0} max={200} warn={limits.casing_pressure * 0.85} crit={limits.casing_pressure} sub={`HI limit ${limits.casing_pressure} bar`} />
                        </Grid>
                        <Grid item xs={6} sm={4}>
                            <ValueTile label="Wellhead" value={wellhead.wellhead_pressure} unit="bar" decimals={1} color="#a78bfa" min={0} max={250} warn={limits.wellhead_pressure * 0.85} crit={limits.wellhead_pressure} sub={`HI limit ${limits.wellhead_pressure} bar`} />
                        </Grid>
                    </Grid>
                </Box>

                {/* Load, weight, torque & pump params surfaced as compact tiles. */}
                <Box>
                    <SectionTitle>Load · Weight · Torque · Pump</SectionTitle>
                    <Grid container spacing={1.5}>
                        <Grid item xs={6} sm={4} md={2.4}>
                            <ValueTile label="Hook Load" value={ops.hook_load} unit="t" decimals={1} color="#38bdf8" min={0} max={500} warn={420} crit={470} />
                        </Grid>
                        <Grid item xs={6} sm={4} md={2.4}>
                            <ValueTile label="WOB" value={ops.wob} unit="t" decimals={1} color="#22d3ee" min={0} max={100} warn={80} crit={90} />
                        </Grid>
                        <Grid item xs={6} sm={4} md={2.4}>
                            <ValueTile label="Make-up Torque" value={ops.makeup_torque} unit="daN·m" decimals={0} color="#a78bfa" min={0} max={ttMax ? ttMax * 1.2 : 5000} warn={ttMax ? ttMax * 0.9 : 4000} crit={ttMax || 4500} />
                        </Grid>
                        <Grid item xs={6} sm={4} md={2.4}>
                            <ValueTile label="Pump Rate" value={ops.spm} unit="spm" decimals={0} color="#f472b6" min={0} max={200} warn={150} crit={180} />
                        </Grid>
                        <Grid item xs={6} sm={4} md={2.4}>
                            <ValueTile label="Pump Press" value={ops.pressure} unit="bar" decimals={1} color="#4ade80" min={0} max={500} warn={350} crit={420} />
                        </Grid>
                    </Grid>
                </Box>

                {/* Torque-turn graph — kept (not a dial). */}
                <TorqueTurnGraph tt={tt} theme={theme} />

                {/* Connections tally + table — kept. */}
                <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                    <Box sx={{ p: 1.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                            <ListChecks size={18} /> Connections
                        </Typography>
                        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
                            <TallyChip theme={theme} label="Joint #" value={conn.jointCounter ?? 0} color={theme.palette.primary.main} />
                            <TallyChip theme={theme} label="Run" value={tally.run ?? 0} color={theme.palette.text.secondary} />
                            <TallyChip theme={theme} label="Pass" value={tally.pass ?? 0} color={STATUS.ok} />
                            <TallyChip theme={theme} label="Fail" value={tally.fail ?? 0} color={STATUS.fail} />
                        </Box>
                    </Box>
                    <TableContainer>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell sx={headSx}>Joint #</TableCell>
                                    <TableCell sx={headSx}>Peak Torque</TableCell>
                                    <TableCell sx={headSx}>Result</TableCell>
                                    <TableCell sx={headSx}>Duration</TableCell>
                                    <TableCell sx={headSx}>Time</TableCell>
                                    <TableCell sx={headSx}>Activity</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {records.map((r, i) => {
                                    const pass = r.result === 'PASS';
                                    const c = pass ? STATUS.ok : STATUS.fail;
                                    return (
                                        <TableRow key={`${r.ts}-${r.joint}-${i}`} hover>
                                            <TableCell sx={cellSx}>{r.joint}</TableCell>
                                            <TableCell sx={cellSx}>{r.peakTorque} <span style={{ color: theme.palette.text.secondary }}>{r.unit}</span></TableCell>
                                            <TableCell sx={cellSx}>
                                                <Chip label={r.result} size="small"
                                                    sx={{ bgcolor: `${c}22`, color: c, fontWeight: 'bold', height: 22 }} />
                                            </TableCell>
                                            <TableCell sx={cellSx}>{r.durationSec != null ? `${r.durationSec}s` : '--'}</TableCell>
                                            <TableCell sx={cellSx}>{formatClock(r.ts)}</TableCell>
                                            <TableCell sx={cellSx}>{r.activity || '--'}</TableCell>
                                        </TableRow>
                                    );
                                })}
                                {records.length === 0 && (
                                    <TableRow>
                                        <TableCell colSpan={6} align="center" sx={{ color: theme.palette.text.secondary, py: 4, borderColor: theme.palette.divider }}>
                                            No connections recorded.
                                        </TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </TableContainer>
                </Paper>
            </Box>

            {/* Persistent EDR side strip */}
            <Paper
                sx={{
                    flex: { xs: '1 1 100%', lg: '0 0 400px' },
                    width: { xs: '100%', lg: 400 },
                    bgcolor: theme.palette.background.paper,
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: 1,
                    p: 1.25,
                    height: { lg: 'calc(100vh - 220px)' },
                    minHeight: { xs: 420, lg: 0 },
                    display: 'flex',
                    flexDirection: 'column'
                }}
            >
                <Typography sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: theme.palette.text.secondary, fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.6, mb: 1 }}>
                    <ActivityIcon size={14} /> EDR — Load &amp; Pump
                </Typography>
                <Box sx={{ flex: 1, minHeight: 0 }}>
                    <EdrView mode="compact" storageKey="edr-workover-1" defaultStrips={EDR_STRIPS} channels={EDR_CHANNELS} />
                </Box>
            </Paper>
        </Box>
    );
}

function TallyChip({ label, value, color, theme }) {
    return (
        <Box sx={{ px: 1.5, py: 0.5, bgcolor: theme.palette.background.default, borderRadius: 1, border: `1px solid ${color}`, textAlign: 'center', minWidth: 64 }}>
            <Typography variant="caption" sx={{ color: theme.palette.text.secondary, display: 'block', lineHeight: 1 }}>{label}</Typography>
            <Typography variant="h6" sx={{ color, fontWeight: 'bold', lineHeight: 1.3 }}>{value}</Typography>
        </Box>
    );
}
