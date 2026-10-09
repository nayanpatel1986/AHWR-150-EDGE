import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Box, Paper, Typography, Button, Stack, MenuItem, TextField, Chip, Divider,
    Dialog, DialogTitle, DialogContent, DialogActions, ToggleButton,
    ToggleButtonGroup, Autocomplete, Alert, CircularProgress, LinearProgress,
} from '@mui/material';
import { useTheme, alpha } from '@mui/material/styles';
import { Download, Upload, Database, RefreshCw, FileDown } from 'lucide-react';
import {
    ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
    Tooltip as RTooltip, Legend,
} from 'recharts';
import axios from '../../api';
import { useAuth } from '../../context/AuthContext';

const SERIES_COLORS = ['#38bdf8', '#f59e0b', '#34d399', '#f472b6', '#a78bfa', '#facc15'];
const MAX_PLOT_SIGNALS = 6;

/** Trigger a browser download from an authenticated API call. */
async function downloadFrom(url, params) {
    const res = await axios.get(url, { params, responseType: 'blob' });
    const disp = res.headers['content-disposition'] || '';
    const match = /filename="?([^";]+)"?/.exec(disp);
    const href = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = href;
    a.download = match ? match[1] : 'export.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
    return res.headers['x-export-truncated'] === 'true';
}

const fmtTime = (t) => {
    if (!t) return '--';
    const d = new Date(t);
    return isNaN(d) ? '--' : d.toLocaleString('en-GB', { hour12: false });
};

export default function WellDataArchive({ wells = [] }) {
    const theme = useTheme();
    const { user } = useAuth();
    const canWrite = user && (user.role === 'admin' || user.role === 'operator');

    // --- export ---
    const [wellId, setWellId] = useState('');
    const [tier, setTier] = useState('archive');
    const [format, setFormat] = useState('csv');
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState(null);

    // --- archive browser ---
    const [archives, setArchives] = useState([]);
    const [bucket, setBucket] = useState('');
    const [info, setInfo] = useState(null);
    const [picked, setPicked] = useState([]);
    const [rows, setRows] = useState(null);
    const [loading, setLoading] = useState(false);

    // --- import ---
    const [importOpen, setImportOpen] = useState(false);
    const [importLabel, setImportLabel] = useState('');
    const [importFile, setImportFile] = useState(null);
    const [importBusy, setImportBusy] = useState(false);
    const [importErr, setImportErr] = useState(null);

    const loadArchives = useCallback(() => {
        axios.get('/api/wells/archives')
            .then((r) => setArchives(r.data || []))
            .catch((e) => console.error('archive list failed:', e));
    }, []);

    useEffect(() => { loadArchives(); }, [loadArchives]);
    useEffect(() => { if (!wellId && wells.length) setWellId(wells[0].id); }, [wells, wellId]);

    // Describe whichever archive is selected.
    useEffect(() => {
        if (!bucket) { setInfo(null); setPicked([]); setRows(null); return; }
        setInfo(null); setRows(null);
        axios.get('/api/wells/archive/describe', { params: { bucket } })
            .then((r) => {
                setInfo(r.data);
                setPicked((r.data.signals || []).slice(0, 3));
            })
            .catch((e) => setMsg({ severity: 'error', text: e.response?.data?.error || e.message }));
    }, [bucket]);

    const doExportWell = async () => {
        const well = wells.find((w) => w.id === wellId);
        if (!well) return;
        setBusy(true); setMsg(null);
        try {
            const truncated = await downloadFrom(`/api/wells/${wellId}/export`, { tier, format });
            setMsg({
                severity: truncated ? 'warning' : 'success',
                text: truncated
                    ? `${well.name} exported, but the row cap was hit — narrow the range or use the 1-minute tier.`
                    : `${well.name} ${tier === 'raw' ? 'raw' : '1-minute'} data exported.`,
            });
        } catch (e) {
            // Blob error bodies need decoding before the message is readable.
            let text = e.message;
            try { text = JSON.parse(await e.response.data.text()).error; } catch { /* keep */ }
            setMsg({ severity: 'error', text });
        } finally { setBusy(false); }
    };

    const doExportBucket = async () => {
        setBusy(true); setMsg(null);
        try {
            await downloadFrom('/api/wells/archive/export', { bucket, format });
            setMsg({ severity: 'success', text: `${bucket} exported.` });
        } catch (e) {
            setMsg({ severity: 'error', text: e.message });
        } finally { setBusy(false); }
    };

    const loadData = async () => {
        if (!bucket || !picked.length) return;
        setLoading(true); setRows(null);
        try {
            // Keep the plot readable no matter how long the archive is.
            const spanMs = info?.from && info?.to ? new Date(info.to) - new Date(info.from) : 0;
            const every = spanMs > 6 * 3600e3 ? `${Math.max(1, Math.round(spanMs / 1500 / 60000))}m` : undefined;
            const r = await axios.get('/api/wells/archive/data', {
                params: { bucket, metrics: picked.join(','), every },
            });
            setRows(r.data);
        } catch (e) {
            setMsg({ severity: 'error', text: e.response?.data?.error || e.message });
        } finally { setLoading(false); }
    };

    const doImport = async () => {
        if (!importFile || !importLabel.trim()) return;
        setImportBusy(true); setImportErr(null);
        try {
            const text = await importFile.text();
            const body = { label: importLabel.trim() };
            if (importFile.name.toLowerCase().endsWith('.json')) {
                const parsed = JSON.parse(text);
                body.rows = Array.isArray(parsed) ? parsed : parsed.rows;
                if (!Array.isArray(body.rows)) throw new Error('JSON must be an array of rows, or { rows: [...] }');
            } else {
                body.csv = text;
            }
            const r = await axios.post('/api/wells/import', body);
            setImportOpen(false);
            setImportFile(null);
            setImportLabel('');
            loadArchives();
            setBucket(r.data.bucket);
            setMsg({
                severity: 'success',
                text: `Imported ${r.data.pointsWritten} points from ${r.data.rows} rows into ${r.data.bucket}`
                    + (r.data.rowsSkipped ? ` (${r.data.rowsSkipped} rows had no usable timestamp)` : ''),
            });
        } catch (e) {
            setImportErr(e.response?.data?.error || e.message);
        } finally { setImportBusy(false); }
    };

    const chartData = useMemo(() => {
        if (!rows?.rows?.length) return [];
        return rows.rows.map((r) => ({ ...r, t: new Date(r.time).getTime() }));
    }, [rows]);

    const plotted = useMemo(() => picked.slice(0, MAX_PLOT_SIGNALS), [picked]);

    const paperSx = {
        p: 2,
        bgcolor: alpha(theme.palette.background.paper, 0.6),
        border: `1px solid ${theme.palette.divider}`,
    };
    const labelSx = { fontSize: 11, letterSpacing: 0.6, color: 'text.secondary', textTransform: 'uppercase', mb: 0.75 };

    return (
        <Stack spacing={2}>
            {msg && <Alert severity={msg.severity} onClose={() => setMsg(null)}>{msg.text}</Alert>}

            {/* ---------------- Export ---------------- */}
            <Paper sx={paperSx}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                    <Download size={16} color={theme.palette.primary.main} />
                    <Typography sx={{ fontWeight: 600, fontSize: 14 }}>Export well data</Typography>
                </Stack>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'flex-end' }}>
                    <Box sx={{ minWidth: 220 }}>
                        <Typography sx={labelSx}>Well</Typography>
                        <TextField select fullWidth size="small" value={wellId} onChange={(e) => setWellId(e.target.value)}>
                            {wells.map((w) => (
                                <MenuItem key={w.id} value={w.id}>{w.name}{w.jobNo ? ` — ${w.jobNo}` : ''}</MenuItem>
                            ))}
                        </TextField>
                    </Box>
                    <Box>
                        <Typography sx={labelSx}>Tier</Typography>
                        <ToggleButtonGroup exclusive size="small" value={tier} onChange={(e, v) => v && setTier(v)}>
                            <ToggleButton value="archive" sx={{ px: 1.5, fontSize: 12 }}>1-minute archive</ToggleButton>
                            <ToggleButton value="raw" sx={{ px: 1.5, fontSize: 12 }}>Raw (full rate)</ToggleButton>
                        </ToggleButtonGroup>
                    </Box>
                    <Box>
                        <Typography sx={labelSx}>Format</Typography>
                        <ToggleButtonGroup exclusive size="small" value={format} onChange={(e, v) => v && setFormat(v)}>
                            <ToggleButton value="csv" sx={{ px: 2, fontSize: 12 }}>CSV</ToggleButton>
                            <ToggleButton value="json" sx={{ px: 2, fontSize: 12 }}>JSON</ToggleButton>
                        </ToggleButtonGroup>
                    </Box>
                    <Button
                        variant="contained" size="medium" disabled={busy || !wellId}
                        startIcon={busy ? <CircularProgress size={14} /> : <FileDown size={15} />}
                        onClick={doExportWell}
                    >
                        Download
                    </Button>
                    {canWrite && (
                        <Button variant="outlined" startIcon={<Upload size={15} />} onClick={() => setImportOpen(true)}>
                            Import history
                        </Button>
                    )}
                </Stack>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 1.5 }}>
                    The 1-minute archive is the permanent per-well record (mean, min and max per minute, kept for ever).
                    Raw is full-rate data and only exists while the well is inside the 90-day raw window.
                </Typography>
            </Paper>

            {/* ---------------- Browse / view ---------------- */}
            <Paper sx={paperSx}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                    <Database size={16} color={theme.palette.primary.main} />
                    <Typography sx={{ fontWeight: 600, fontSize: 14 }}>Stored &amp; imported archives</Typography>
                    <Box sx={{ flex: 1 }} />
                    <Button size="small" startIcon={<RefreshCw size={13} />} onClick={loadArchives}>Refresh</Button>
                </Stack>

                <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'flex-end' }}>
                    <Box sx={{ minWidth: 260 }}>
                        <Typography sx={labelSx}>Archive</Typography>
                        <TextField select fullWidth size="small" value={bucket} onChange={(e) => setBucket(e.target.value)}>
                            <MenuItem value=""><em>Select an archive…</em></MenuItem>
                            {archives.map((a) => (
                                <MenuItem key={a.bucket} value={a.bucket}>
                                    {a.well}
                                    <Chip
                                        size="small" label={a.kind === 'import' ? 'IMPORTED' : 'WELL'}
                                        sx={{ ml: 1, height: 17, fontSize: 9.5 }}
                                        color={a.kind === 'import' ? 'warning' : 'primary'}
                                        variant="outlined"
                                    />
                                </MenuItem>
                            ))}
                        </TextField>
                    </Box>
                    <Autocomplete
                        multiple size="small" sx={{ flex: 1, minWidth: 280 }}
                        options={info?.signals || []} value={picked} onChange={(e, v) => setPicked(v)}
                        disabled={!info}
                        renderInput={(p) => <TextField {...p} label="Signals" placeholder="add signal" />}
                        limitTags={4}
                    />
                    <Button variant="contained" onClick={loadData} disabled={!picked.length || loading}>View</Button>
                    <Button variant="outlined" startIcon={<FileDown size={15} />} disabled={!bucket || busy} onClick={doExportBucket}>
                        Export archive
                    </Button>
                </Stack>

                {info && (
                    <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', gap: 0.75 }}>
                        <Chip size="small" variant="outlined" label={`bucket: ${info.bucket}`} />
                        <Chip size="small" variant="outlined" label={`from: ${fmtTime(info.from)}`} />
                        <Chip size="small" variant="outlined" label={`to: ${fmtTime(info.to)}`} />
                        <Chip size="small" variant="outlined" label={`${info.signals.length} signals`} />
                        {!info.from && <Chip size="small" color="warning" label="archive is empty" />}
                    </Stack>
                )}

                {loading && <LinearProgress sx={{ mt: 2 }} />}

                {rows && (
                    <Box sx={{ mt: 2 }}>
                        <Divider sx={{ mb: 2 }} />
                        {chartData.length === 0 ? (
                            <Typography sx={{ color: 'text.secondary', fontSize: 13, py: 3, textAlign: 'center' }}>
                                No data in this range.
                            </Typography>
                        ) : (
                            <>
                                <Box sx={{ height: 320 }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke={alpha(theme.palette.divider, 0.6)} />
                                            <XAxis
                                                dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time"
                                                tick={{ fontSize: 10 }} stroke={theme.palette.text.secondary}
                                                tickFormatter={(t) => new Date(t).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit' })}
                                            />
                                            <YAxis tick={{ fontSize: 10 }} stroke={theme.palette.text.secondary} width={56} />
                                            <RTooltip
                                                contentStyle={{ background: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, fontSize: 12 }}
                                                labelFormatter={(t) => fmtTime(t)}
                                            />
                                            <Legend wrapperStyle={{ fontSize: 11 }} />
                                            {plotted.map((sig, i) => (
                                                <Line
                                                    key={sig} type="monotone" dataKey={sig} name={sig}
                                                    stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                                                    dot={false} strokeWidth={1.6} connectNulls isAnimationActive={false}
                                                />
                                            ))}
                                        </LineChart>
                                    </ResponsiveContainer>
                                </Box>
                                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 1 }}>
                                    {chartData.length} points
                                    {picked.length > MAX_PLOT_SIGNALS && ` · plotting the first ${MAX_PLOT_SIGNALS} of ${picked.length} signals`}
                                    {rows.truncated && ' · row cap reached, chart is partial'}
                                </Typography>
                            </>
                        )}
                    </Box>
                )}
            </Paper>

            {/* ---------------- Import dialog ---------------- */}
            <Dialog open={importOpen} onClose={() => !importBusy && setImportOpen(false)} maxWidth="sm" fullWidth>
                <DialogTitle sx={{ fontSize: 16 }}>Import historical data</DialogTitle>
                <DialogContent>
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mb: 2 }}>
                        Accepts a file exported from this app — CSV or JSON with a <code>time</code> column and one
                        <code> measurement.field</code> column per signal. Imported data is written to its own archive so it is
                        never mixed with live rig data.
                    </Typography>
                    {importErr && <Alert severity="error" sx={{ mb: 2 }}>{importErr}</Alert>}
                    <Stack spacing={2}>
                        <TextField
                            label="Label" size="small" fullWidth value={importLabel}
                            onChange={(e) => setImportLabel(e.target.value)}
                            helperText="Names the archive, e.g. ANK-118-2024 → import_ANK-118-2024"
                        />
                        <Button variant="outlined" component="label" startIcon={<Upload size={15} />}>
                            {importFile ? importFile.name : 'Choose CSV or JSON file'}
                            <input
                                hidden type="file" accept=".csv,.json,text/csv,application/json"
                                onChange={(e) => {
                                    const f = e.target.files?.[0] || null;
                                    setImportFile(f);
                                    if (f && !importLabel) setImportLabel(f.name.replace(/\.(csv|json)$/i, ''));
                                }}
                            />
                        </Button>
                        {importFile && (
                            <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                                {(importFile.size / 1024).toFixed(0)} kB
                            </Typography>
                        )}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setImportOpen(false)} disabled={importBusy}>Cancel</Button>
                    <Button
                        variant="contained" onClick={doImport}
                        disabled={importBusy || !importFile || !importLabel.trim()}
                        startIcon={importBusy ? <CircularProgress size={14} /> : null}
                    >
                        Import
                    </Button>
                </DialogActions>
            </Dialog>
        </Stack>
    );
}
