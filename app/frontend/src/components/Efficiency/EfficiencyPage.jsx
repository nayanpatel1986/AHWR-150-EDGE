import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
    Box, Typography, Paper, Grid, Button, TextField, Table, TableBody,
    TableCell, TableContainer, TableHead, TableRow, Dialog, DialogTitle,
    DialogContent, DialogActions, Snackbar, Alert, Chip, useTheme
} from '@mui/material';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { Gauge, Activity, Thermometer, SlidersHorizontal, Wrench, TrendingUp } from 'lucide-react';
import axios from '../../api';
import { getLatestRigData, isLiveRigPayload, socket } from '../../socket';
import { useAuth } from '../../context/AuthContext';

// `daily` / `config` / `instrumentation` are polled from REST; the live `instant`
// header KPIs + circuit table + trend buffer ride the socket `rig_data._efficiency`.
const POLL_MS = 5000;
const MAX_TREND_SECONDS = 24 * 60 * 60;
const MAX_CHART_POINTS = 1200;
const TREND_RANGES = [
    { label: '1m', seconds: 60 },
    { label: '5m', seconds: 5 * 60 },
    { label: '15m', seconds: 15 * 60 },
    { label: '30m', seconds: 30 * 60 },
    { label: '1H', seconds: 60 * 60 },
    { label: '6H', seconds: 6 * 60 * 60 },
    { label: '12H', seconds: 12 * 60 * 60 },
    { label: '24H', seconds: MAX_TREND_SECONDS },
];

// Circuit status -> theme token. computed=green, estimated=amber, needs-instrument=grey.
const STATUS_TOKEN = {
    computed: 'success.main',
    estimated: 'warning.main',
    'needs-instrument': 'text.secondary',
};
const STATUS_LABEL = {
    computed: 'Computed',
    estimated: 'Estimated',
    'needs-instrument': 'Needs Instrument',
};
function statusToken(s) { return STATUS_TOKEN[s] || 'text.secondary'; }

// Render a number with fixed decimals, or an em dash when null/undefined/NaN.
function fmt(n, digits = 1, suffix = '') {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return `${Number(n).toFixed(digits)}${suffix}`;
}
function fmtInt(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    return Math.round(Number(n)).toLocaleString('en-US');
}

function downsample(points, maxPoints = MAX_CHART_POINTS) {
    if (points.length <= maxPoints) return points;
    const step = Math.ceil(points.length / maxPoints);
    return points.filter((_, index) => index % step === 0);
}

function formatAxisTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function toDateTimeLocal(ts) {
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDateTimeLocal(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function tokenColorOf(theme, token) {
    const [group, shade = 'main'] = String(token).split('.');
    return theme.palette?.[group]?.[shade] || theme.palette.text.secondary;
}

function StatusChip({ status, theme }) {
    const token = statusToken(status);
    const c = tokenColorOf(theme, token);
    return (
        <Chip
            label={STATUS_LABEL[status] || status || '—'}
            size="small"
            sx={{ bgcolor: `${c}22`, color: c, fontWeight: 'bold', height: 22, border: `1px solid ${c}` }}
        />
    );
}

// ValueTile-style KPI card (theme tokens, optional accent color).
function KpiTile({ label, value, unit, color, theme }) {
    const accent = color || theme.palette.primary.main;
    return (
        <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${accent}`, height: '100%' }}>
            <Typography variant="caption" sx={{ color: theme.palette.text.secondary, textTransform: 'uppercase', letterSpacing: 1, display: 'block' }}>
                {label}
            </Typography>
            <Typography variant="h5" sx={{ color: accent, fontWeight: 'bold', lineHeight: 1.2 }}>
                {value}
                {unit && <Typography component="span" variant="caption" sx={{ ml: 0.5, color: theme.palette.text.secondary }}>{unit}</Typography>}
            </Typography>
        </Paper>
    );
}

// Small label/value row for the specific-energy panel.
function MetricRow({ label, value, theme }) {
    return (
        <Paper sx={{ p: 1.5, bgcolor: theme.palette.background.default, border: `1px solid ${theme.palette.divider}`, height: '100%' }}>
            <Typography variant="caption" sx={{ color: theme.palette.text.secondary, textTransform: 'uppercase', letterSpacing: 1, display: 'block' }}>
                {label}
            </Typography>
            <Typography variant="h6" sx={{ color: theme.palette.text.primary, fontWeight: 'bold', lineHeight: 1.2 }}>
                {value}
            </Typography>
        </Paper>
    );
}

export default function EfficiencyPage() {
    const theme = useTheme();
    const { user } = useAuth();
    const isAdmin = user?.role === 'admin';

    // Live instant from socket (seeded once from the REST snapshot).
    const [instant, setInstant] = useState(null);
    // Polled slices.
    const [daily, setDaily] = useState(null);
    const [config, setConfig] = useState(null);
    const [instrumentation, setInstrumentation] = useState([]);

    // Rolling trend buffer fed by the socket (System Hydraulic Power + LS Margin).
    const [trend, setTrend] = useState([]);
    const trendRef = useRef([]);
    const [trendRangeSec, setTrendRangeSec] = useState(5 * 60);
    const [customRangeOpen, setCustomRangeOpen] = useState(false);
    const [customWindow, setCustomWindow] = useState(null);
    const [customDraft, setCustomDraft] = useState(() => {
        const end = Date.now();
        return {
            from: toDateTimeLocal(end - 60 * 60 * 1000),
            to: toDateTimeLocal(end),
        };
    });

    const [notification, setNotification] = useState({ open: false, message: '', severity: 'success' });

    // Tuning-constants dialog.
    const [cfgOpen, setCfgOpen] = useState(false);
    const [cfgDraft, setCfgDraft] = useState(null);
    const [saving, setSaving] = useState(false);

    const showNote = (message, severity = 'success') => setNotification({ open: true, message, severity });

    const loadAll = useCallback(() => {
        axios.get('/api/rig/latest')
            .then(({ data: latest }) => {
                if (!isLiveRigPayload(latest)) {
                    setInstant(null);
                    setDaily(null);
                    trendRef.current = [];
                    setTrend([]);
                    return axios.get('/api/efficiency').then((r) => {
                        const d = r.data || {};
                        setConfig(d.config || null);
                        setInstrumentation(Array.isArray(d.instrumentation) ? d.instrumentation : []);
                    });
                }
                return axios.get('/api/efficiency').then((r) => {
                    const d = r.data || {};
                    setDaily(d.daily || null);
                    setConfig(d.config || null);
                    setInstrumentation(Array.isArray(d.instrumentation) ? d.instrumentation : []);
                });
            })
            .catch((e) => console.error('efficiency load failed:', e));
    }, []);

    // Poll daily/config/instrumentation; seed instant from the same payload.
    useEffect(() => {
        const cached = getLatestRigData();
        if (isLiveRigPayload(cached) && cached?._efficiency) {
            setInstant(cached._efficiency);
        }
        loadAll();
        const id = setInterval(loadAll, POLL_MS);
        return () => clearInterval(id);
    }, [loadAll]);

    // Live instant rides the shared socket — Layout owns connect/disconnect.
    useEffect(() => {
        const handleRigData = (data) => {
            if (!isLiveRigPayload(data)) {
                setInstant(null);
                trendRef.current = [];
                setTrend([]);
                return;
            }
            const eff = data?._efficiency;
            if (!eff) return;
            setInstant(eff);
            // Append to the rolling trend buffer (capped).
            const point = {
                ts: Date.now(),
                t: new Date().toLocaleTimeString('en-US', { hour12: false }),
                hydraulicKw: eff.totalHydraulicKw != null ? Number(eff.totalHydraulicKw) : null,
                lsMargin: eff.lsMargin != null ? Number(eff.lsMargin) : null,
            };
            const cutoff = point.ts - (MAX_TREND_SECONDS * 1000);
            const next = [...trendRef.current, point].filter((item) => item.ts >= cutoff);
            trendRef.current = next;
            setTrend(next);
        };
        socket.on('rig_data', handleRigData);
        return () => {
            // Remove ONLY our handler; never disconnect the shared socket.
            socket.off('rig_data', handleRigData);
        };
    }, []);

    const openConfig = () => {
        if (!isAdmin || !config) return;
        setCfgDraft({
            engineRatedKw: config.engineRatedKw ?? '',
            htdPumpRatedLpm: config.htdPumpRatedLpm ?? '',
            pdwPumpRatedLpm: config.pdwPumpRatedLpm ?? '',
            lineLossBar: config.lineLossBar ?? '',
        });
        setCfgOpen(true);
    };

    const saveConfig = async () => {
        if (!isAdmin || !cfgDraft) return;
        const body = {};
        ['engineRatedKw', 'htdPumpRatedLpm', 'pdwPumpRatedLpm', 'lineLossBar'].forEach((k) => {
            if (cfgDraft[k] !== '' && cfgDraft[k] != null) body[k] = Number(cfgDraft[k]);
        });
        setSaving(true);
        try {
            const { data } = await axios.put('/api/efficiency/config', body);
            if (data?.config) setConfig(data.config);
            else loadAll();
            showNote('Tuning constants saved');
            setCfgOpen(false);
        } catch (err) {
            console.error('save efficiency config failed:', err);
            showNote(err.response?.data?.error || 'Failed to save constants', 'error');
        } finally {
            setSaving(false);
        }
    };

    const circuits = Array.isArray(instant?.circuits) ? instant.circuits : [];
    const heat = instant?.heatBalance || null;

    const headSx = { color: theme.palette.text.secondary, fontWeight: 'bold', borderColor: theme.palette.divider, whiteSpace: 'nowrap' };
    const cellSx = { color: theme.palette.text.primary, borderColor: theme.palette.divider };
    const fieldSx = {
        bgcolor: theme.palette.background.default,
        '& .MuiInputBase-input': { color: theme.palette.text.primary },
        '& .MuiInputLabel-root': { color: theme.palette.text.secondary },
        '& .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.divider },
    };

    const axisColor = theme.palette.text.secondary;
    const gridColor = theme.palette.divider;
    const visibleTrend = useMemo(() => {
        if (!trend.length) return [];
        const startTs = customWindow?.startTs ?? ((trend[trend.length - 1]?.ts || Date.now()) - (trendRangeSec * 1000));
        const endTs = customWindow?.endTs ?? (trend[trend.length - 1]?.ts || Date.now());
        return downsample(trend.filter((point) => point.ts >= startTs && point.ts <= endTs));
    }, [trend, trendRangeSec, customWindow]);
    const trendEndTs = customWindow?.endTs ?? (trend[trend.length - 1]?.ts || Date.now());
    const trendStartTs = customWindow?.startTs ?? (trendEndTs - (trendRangeSec * 1000));

    const applyCustomRange = () => {
        const startTs = fromDateTimeLocal(customDraft.from);
        const endTs = fromDateTimeLocal(customDraft.to);
        if (!startTs || !endTs || startTs >= endTs) {
            showNote('Select valid From and To time', 'error');
            return;
        }
        setCustomWindow({ startTs, endTs });
        setCustomRangeOpen(false);
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Header */}
            <Box>
                <Typography variant="h6" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Gauge size={22} /> Efficiency &amp; Energy
                </Typography>
                <Typography variant="body2" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
                    Derived from live pressure/flow/torque/fuel — read-only. Estimated circuits use configured pump rated-flow;
                    the heat-balance method and tong/winch η need added instrumentation.
                </Typography>
            </Box>

            {/* 1. Header KPI tiles (live from socket _efficiency) */}
            <Grid container spacing={2}>
                <Grid item xs={6} sm={4} md={2.4}>
                    <KpiTile theme={theme} label="System Hydraulic Power" unit="kW"
                        value={fmt(instant?.totalHydraulicKw, 1)} color={theme.palette.primary.main} />
                </Grid>
                <Grid item xs={6} sm={4} md={2.4}>
                    <KpiTile theme={theme} label="Engine Shaft Power" unit="kW"
                        value={fmt(instant?.engineKw, 1)} color={theme.palette.text.primary} />
                </Grid>
                <Grid item xs={6} sm={4} md={2.4}>
                    <KpiTile theme={theme} label="Hydraulic Conversion" unit="%"
                        value={fmt(instant?.conversionPct, 1)} color={theme.palette.success.main} />
                </Grid>
                <Grid item xs={6} sm={4} md={2.4}>
                    <KpiTile theme={theme} label="LS Margin" unit="bar"
                        value={fmt(instant?.lsMargin, 1)} color={theme.palette.warning.main} />
                </Grid>
                <Grid item xs={6} sm={4} md={2.4}>
                    <KpiTile theme={theme} label="Fuel Rate" unit="L/h"
                        value={fmt(instant?.fuelLph, 1)} color={theme.palette.text.primary} />
                </Grid>
            </Grid>

            {/* 2. Per-circuit efficiency table */}
            <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Box sx={{ p: 2 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Activity size={18} /> Per-Circuit Efficiency
                    </Typography>
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                        “Estimated” rows mean flow Q came from pump % × configured rated flow.
                    </Typography>
                </Box>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell sx={headSx}>Circuit</TableCell>
                                <TableCell sx={headSx} align="right">Useful Output (kW)</TableCell>
                                <TableCell sx={headSx} align="right">Hydraulic Power (kW)</TableCell>
                                <TableCell sx={headSx} align="right">Efficiency (%)</TableCell>
                                <TableCell sx={headSx}>Status</TableCell>
                                <TableCell sx={headSx}>Note</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {circuits.map((c) => (
                                <TableRow key={c.id} hover>
                                    <TableCell sx={cellSx}>{c.label}</TableCell>
                                    <TableCell sx={cellSx} align="right">{fmt(c.usefulKw, 1)}</TableCell>
                                    <TableCell sx={cellSx} align="right">{fmt(c.hydraulicKw, 1)}</TableCell>
                                    <TableCell sx={cellSx} align="right">{fmt(c.efficiency, 1)}</TableCell>
                                    <TableCell sx={cellSx}><StatusChip status={c.status} theme={theme} /></TableCell>
                                    <TableCell sx={{ ...cellSx, color: theme.palette.text.secondary, whiteSpace: 'normal' }}>{c.note || '—'}</TableCell>
                                </TableRow>
                            ))}
                            {circuits.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={6} align="center" sx={{ color: theme.palette.text.secondary, py: 4, borderColor: theme.palette.divider }}>
                                        Awaiting live efficiency data…
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* 3 + 4: Specific energy + heat balance side-by-side */}
            <Grid container spacing={3}>
                {/* 3. Specific energy (working-day) */}
                <Grid item xs={12} md={7}>
                    <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, height: '100%' }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                            <TrendingUp size={18} /> Specific Energy (Working Day)
                        </Typography>
                        <Grid container spacing={1.5}>
                            <Grid item xs={6} sm={4}><MetricRow theme={theme} label="L / joint" value={fmt(daily?.litresPerJoint, 1)} /></Grid>
                            <Grid item xs={6} sm={4}><MetricRow theme={theme} label="kWh / joint" value={fmt(daily?.kwhPerJoint, 1)} /></Grid>
                            <Grid item xs={6} sm={4}><MetricRow theme={theme} label="L / metre" value={fmt(daily?.litresPerMetre, 1)} /></Grid>
                            <Grid item xs={6} sm={4}><MetricRow theme={theme} label="Fuel Today" value={fmt(daily?.fuelLiters, 0, ' L')} /></Grid>
                            <Grid item xs={6} sm={4}><MetricRow theme={theme} label="Energy Today" value={fmt(daily?.energyKwh, 0, ' kWh')} /></Grid>
                            <Grid item xs={6} sm={4}><MetricRow theme={theme} label="Productive Share" value={fmt(daily?.productiveSharePct, 0, ' %')} /></Grid>
                        </Grid>
                        <Typography variant="caption" sx={{ color: theme.palette.text.secondary, display: 'block', mt: 1.5 }}>
                            Working day 06:00–06:00; fills as joints/metres accrue
                            {daily ? ` (${fmtInt(daily.joints)} joints, ${fmt(daily.metres, 1)} m).` : '.'}
                        </Typography>
                    </Paper>
                </Grid>

                {/* 4. Heat-balance panel */}
                <Grid item xs={12} md={5}>
                    <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, height: '100%' }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                                <Thermometer size={18} /> Heat Balance
                            </Typography>
                            <Chip label="REQUIRES INSTRUMENTATION" size="small"
                                sx={{
                                    bgcolor: `${theme.palette.warning.main}22`,
                                    color: theme.palette.warning.main,
                                    fontWeight: 'bold', height: 22,
                                    border: `1px solid ${theme.palette.warning.main}`,
                                }} />
                        </Box>
                        <Paper sx={{ p: 1.5, bgcolor: theme.palette.background.default, border: `1px solid ${theme.palette.divider}`, mb: 1.5 }}>
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary, textTransform: 'uppercase', letterSpacing: 1, display: 'block' }}>
                                Method
                            </Typography>
                            <Typography sx={{ color: theme.palette.text.primary, fontFamily: 'monospace', fontWeight: 'bold', fontSize: 15, mt: 0.5, wordBreak: 'break-word' }}>
                                {heat?.formula || 'Q_cooler = ṁ · cp · ΔT'}
                            </Typography>
                        </Paper>
                        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1 }}>
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>HPU oil temp (heat-load proxy):</Typography>
                            <Typography variant="h6" sx={{ color: theme.palette.warning.main, fontWeight: 'bold' }}>
                                {fmt(heat?.oilTempC ?? instant?.oilTempC, 1, ' °C')}
                            </Typography>
                        </Box>
                        <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                            {heat?.note || 'Cooler ΔT and oil flow are not instrumented; the oil temperature alone is shown as a heat-load proxy.'}
                        </Typography>
                    </Paper>
                </Grid>
            </Grid>

            {/* 6. Live trend (socket buffer) */}
            <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <Activity size={18} /> Live Trend — System Hydraulic Power &amp; LS Margin
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mb: 1.5 }}>
                    {TREND_RANGES.map((range) => {
                        const active = trendRangeSec === range.seconds;
                        return (
                            <Button key={range.label} size="small" variant={active && !customWindow ? 'contained' : 'outlined'}
                                onClick={() => {
                                    setCustomWindow(null);
                                    setTrendRangeSec(range.seconds);
                                }}
                                sx={{
                                    minWidth: 48,
                                    height: 32,
                                    px: 1.25,
                                    color: active && !customWindow ? theme.palette.primary.contrastText : theme.palette.text.primary,
                                    borderColor: theme.palette.divider,
                                    bgcolor: active && !customWindow ? theme.palette.primary.main : 'transparent',
                                    textTransform: 'none',
                                    fontWeight: 'bold',
                                    '&:hover': {
                                            bgcolor: active && !customWindow ? theme.palette.primary.main : `${theme.palette.primary.main}18`,
                                        borderColor: theme.palette.primary.main,
                                    },
                                }}>
                                {range.label}
                            </Button>
                        );
                    })}
                    <Button size="small" variant={customWindow ? 'contained' : 'outlined'}
                        onClick={() => {
                            const end = trendEndTs || Date.now();
                            const start = customWindow?.startTs ?? (end - trendRangeSec * 1000);
                            setCustomDraft({
                                from: toDateTimeLocal(start),
                                to: toDateTimeLocal(customWindow?.endTs ?? end),
                            });
                            setCustomRangeOpen(true);
                        }}
                        sx={{
                            minWidth: 82,
                            height: 32,
                            px: 1.5,
                            color: customWindow ? theme.palette.primary.contrastText : theme.palette.text.primary,
                            borderColor: theme.palette.divider,
                            bgcolor: customWindow ? theme.palette.primary.main : 'transparent',
                            textTransform: 'none',
                            fontWeight: 'bold',
                            '&:hover': {
                                bgcolor: customWindow ? theme.palette.primary.main : `${theme.palette.primary.main}18`,
                                borderColor: theme.palette.primary.main,
                            },
                        }}>
                        Custom
                    </Button>
                </Box>
                {visibleTrend.length > 0 ? (
                    <ResponsiveContainer width="100%" height={280}>
                        <LineChart data={visibleTrend} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke={gridColor} />
                            <XAxis dataKey="ts" type="number" domain={[trendStartTs, trendEndTs]}
                                tickFormatter={formatAxisTime} stroke={axisColor} fontSize={11} minTickGap={40} />
                            <YAxis yAxisId="kw" stroke={theme.palette.primary.main} fontSize={11}
                                label={{ value: 'kW', angle: -90, position: 'insideLeft', fill: axisColor, fontSize: 11 }} />
                            <YAxis yAxisId="bar" orientation="right" stroke={theme.palette.warning.main} fontSize={11}
                                label={{ value: 'bar', angle: 90, position: 'insideRight', fill: axisColor, fontSize: 11 }} />
                            <Tooltip labelFormatter={formatAxisTime}
                                contentStyle={{ backgroundColor: theme.palette.background.default, border: `1px solid ${theme.palette.divider}`, color: theme.palette.text.primary }} />
                            <Legend />
                            <Line yAxisId="kw" type="monotone" dataKey="hydraulicKw" name="Hydraulic Power (kW)"
                                stroke={theme.palette.primary.main} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                            <Line yAxisId="bar" type="monotone" dataKey="lsMargin" name="LS Margin (bar)"
                                stroke={theme.palette.warning.main} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
                        </LineChart>
                    </ResponsiveContainer>
                ) : (
                    <Box sx={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.palette.text.secondary }}>
                        Buffering live trend…
                    </Box>
                )}
            </Paper>

            {/* 5. Instrumentation gap list */}
            <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Box sx={{ p: 2 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Wrench size={18} /> Instrumentation Gaps
                    </Typography>
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                        What to add to go from estimated → exact.
                    </Typography>
                </Box>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell sx={headSx}>Add Instrument</TableCell>
                                <TableCell sx={headSx}>Unlocks</TableCell>
                                <TableCell sx={headSx}>Status</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {instrumentation.map((row, i) => (
                                <TableRow key={`${row.item}-${i}`} hover>
                                    <TableCell sx={cellSx}>{row.item}</TableCell>
                                    <TableCell sx={{ ...cellSx, color: theme.palette.text.secondary, whiteSpace: 'normal' }}>{row.unlocks}</TableCell>
                                    <TableCell sx={cellSx}><StatusChip status={row.status} theme={theme} /></TableCell>
                                </TableRow>
                            ))}
                            {instrumentation.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={3} align="center" sx={{ color: theme.palette.text.secondary, py: 4, borderColor: theme.palette.divider }}>
                                        No instrumentation gaps reported.
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* 7. Tuning constants (config) */}
            <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <SlidersHorizontal size={18} /> Tuning Constants
                    </Typography>
                    {isAdmin && (
                        <Button size="small" variant="outlined" startIcon={<SlidersHorizontal size={16} />} onClick={openConfig}
                            disabled={!config}
                            sx={{ color: theme.palette.primary.main, borderColor: theme.palette.divider, textTransform: 'none' }}>
                            Edit Constants
                        </Button>
                    )}
                </Box>
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, display: 'block', mb: 1.5 }}>
                    These drive the “estimated” circuit flows (pump % × rated flow).{!isAdmin && ' Read-only — admin required to edit.'}
                </Typography>
                <Grid container spacing={1.5}>
                    <Grid item xs={6} sm={3}><MetricRow theme={theme} label="Engine Rated (kW)" value={fmt(config?.engineRatedKw, 0)} /></Grid>
                    <Grid item xs={6} sm={3}><MetricRow theme={theme} label="HTD Pump Rated (L/min)" value={fmt(config?.htdPumpRatedLpm, 0)} /></Grid>
                    <Grid item xs={6} sm={3}><MetricRow theme={theme} label="PDW Pump Rated (L/min)" value={fmt(config?.pdwPumpRatedLpm, 0)} /></Grid>
                    <Grid item xs={6} sm={3}><MetricRow theme={theme} label="Line Loss (bar)" value={fmt(config?.lineLossBar, 1)} /></Grid>
                    <Grid item xs={6} sm={3}><MetricRow theme={theme} label="Pump Vol. Eff." value={fmt(config?.pumpVolEff, 2)} /></Grid>
                    <Grid item xs={6} sm={3}><MetricRow theme={theme} label="Cooler Oil K" value={fmt(config?.coolerOilK, 2)} /></Grid>
                </Grid>
            </Paper>

            <Dialog open={customRangeOpen} onClose={() => setCustomRangeOpen(false)}
                PaperProps={{ sx: { bgcolor: theme.palette.background.paper, color: theme.palette.text.primary, minWidth: 360 } }}>
                <DialogTitle sx={{ fontWeight: 'bold' }}>Custom Time Range</DialogTitle>
                <DialogContent>
                    <TextField label="From" type="datetime-local" fullWidth size="small" autoFocus
                        value={customDraft.from}
                        onChange={(e) => setCustomDraft((draft) => ({ ...draft, from: e.target.value }))}
                        InputLabelProps={{ shrink: true }}
                        sx={{ ...fieldSx, mt: 1 }} />
                    <TextField label="To" type="datetime-local" fullWidth size="small"
                        value={customDraft.to}
                        onChange={(e) => setCustomDraft((draft) => ({ ...draft, to: e.target.value }))}
                        InputLabelProps={{ shrink: true }}
                        sx={{ ...fieldSx, mt: 2 }} />
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setCustomRangeOpen(false)} sx={{ color: theme.palette.text.secondary }}>Cancel</Button>
                    <Button onClick={applyCustomRange} variant="contained"
                        sx={{ bgcolor: theme.palette.primary.main, color: theme.palette.primary.contrastText }}>
                        Apply
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Tuning constants dialog (admin) */}
            <Dialog open={cfgOpen} onClose={() => setCfgOpen(false)} PaperProps={{ sx: { bgcolor: theme.palette.background.paper, color: theme.palette.text.primary, minWidth: 440 } }}>
                <DialogTitle>Tuning Constants</DialogTitle>
                <DialogContent>
                    {cfgDraft && (
                        <Grid container spacing={2} sx={{ mt: 0.5 }}>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Engine Rated (kW)" type="number" fullWidth size="small"
                                    value={cfgDraft.engineRatedKw} onChange={(e) => setCfgDraft((d) => ({ ...d, engineRatedKw: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="HTD Pump Rated (L/min)" type="number" fullWidth size="small"
                                    value={cfgDraft.htdPumpRatedLpm} onChange={(e) => setCfgDraft((d) => ({ ...d, htdPumpRatedLpm: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="PDW Pump Rated (L/min)" type="number" fullWidth size="small"
                                    value={cfgDraft.pdwPumpRatedLpm} onChange={(e) => setCfgDraft((d) => ({ ...d, pdwPumpRatedLpm: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Line Loss (bar)" type="number" fullWidth size="small"
                                    value={cfgDraft.lineLossBar} onChange={(e) => setCfgDraft((d) => ({ ...d, lineLossBar: e.target.value }))} sx={fieldSx} />
                            </Grid>
                        </Grid>
                    )}
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setCfgOpen(false)} sx={{ color: theme.palette.text.secondary }}>Cancel</Button>
                    <Button onClick={saveConfig} variant="contained" disabled={saving}
                        sx={{ bgcolor: '#38bdf8', color: '#0f172a', '&:hover': { bgcolor: '#0ea5e9' } }}>
                        {saving ? 'Saving…' : 'Save'}
                    </Button>
                </DialogActions>
            </Dialog>

            <Snackbar open={notification.open} autoHideDuration={4000} onClose={() => setNotification({ ...notification, open: false })}>
                <Alert severity={notification.severity} variant="filled">{notification.message}</Alert>
            </Snackbar>
        </Box>
    );
}
