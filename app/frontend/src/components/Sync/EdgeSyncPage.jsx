import React, { useState, useEffect, useCallback } from 'react';
import {
    Box, Typography, Paper, Grid, Button, TextField, Dialog, DialogTitle,
    DialogContent, DialogActions, Snackbar, Alert, Chip, Switch,
    FormControlLabel, Divider
} from '@mui/material';
import { RefreshCw, Cloud, HeartPulse, Download, Settings, Zap, Radio } from 'lucide-react';
import axios from '../../api';
import { socket } from '../../socket';
import { useAuth } from '../../context/AuthContext';

// Edge health is polled; sync status is live over the socket (seeded once via REST).
const HEALTH_POLL_MS = 10000;

// Grade -> theme color token. Good=success, Degraded=warning, Poor=error.
const GRADE_TOKEN = { Good: 'success.main', Degraded: 'warning.main', Poor: 'error.main' };
function gradeToken(g) { return GRADE_TOKEN[g] || 'text.secondary'; }

// Component status -> theme color token. Loose mapping over common health states.
function statusToken(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'ok' || s === 'good' || s === 'healthy' || s === 'present') return 'success.main';
    if (s === 'warn' || s === 'warning' || s === 'degraded' || s === 'stale') return 'warning.main';
    if (s === 'error' || s === 'poor' || s === 'missing' || s === 'fail' || s === 'failed') return 'error.main';
    return 'text.secondary';
}

// Relative "x ago" from an ISO/epoch timestamp.
function timeAgo(ts) {
    if (!ts) return '--';
    const then = typeof ts === 'number' ? ts : Date.parse(ts);
    if (Number.isNaN(then)) return '--';
    const sec = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
}

function fmtInt(n) {
    if (n == null || Number.isNaN(Number(n))) return '--';
    return Math.round(Number(n)).toLocaleString('en-US');
}

// Connection state chip derived from { connected, enabled }.
function StateChip({ status }) {
    let label = 'DISABLED';
    let token = 'text.secondary';
    if (status?.enabled === false) {
        label = 'DISABLED';
        token = 'text.secondary';
    } else if (status?.connected) {
        label = 'CONNECTED';
        token = 'success.main';
    } else {
        label = 'BUFFERING (OFFLINE)';
        token = 'warning.main';
    }
    return (
        <Chip
            label={label}
            sx={{
                bgcolor: (t) => `${t.palette[token.split('.')[0]]?.main || '#64748b'}22`,
                color: token,
                fontWeight: 'bold',
                fontSize: 14,
                height: 32,
                px: 0.5,
                border: '1px solid',
                borderColor: token,
            }}
        />
    );
}

function StatTile({ label, value, color }) {
    return (
        <Paper
            sx={{
                p: 1.5,
                bgcolor: 'background.paper',
                border: '1px solid',
                borderColor: 'divider',
                height: '100%',
            }}
        >
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1, display: 'block' }}>
                {label}
            </Typography>
            <Typography variant="h6" sx={{ color: color || 'text.primary', fontWeight: 'bold', lineHeight: 1.2, wordBreak: 'break-word' }}>
                {value}
            </Typography>
        </Paper>
    );
}

function StatusChip({ status }) {
    const token = statusToken(status);
    return (
        <Chip
            label={status || '--'}
            size="small"
            sx={{
                bgcolor: (t) => `${t.palette[token.split('.')[0]]?.main || '#64748b'}22`,
                color: token,
                fontWeight: 'bold',
                height: 22,
                textTransform: 'capitalize',
                border: '1px solid',
                borderColor: token,
            }}
        />
    );
}

// ETP publisher state chip: STREAMING (connected+session) / CONNECTING (enabled,
// not yet connected) / DISABLED (off).
function EtpStateChip({ status }) {
    let label = 'DISABLED';
    let token = 'text.secondary';
    if (status?.connected && status?.sessionEstablished) {
        label = 'STREAMING';
        token = 'success.main';
    } else if (status?.enabled && !status?.connected) {
        label = 'CONNECTING';
        token = 'warning.main';
    } else if (!status?.enabled) {
        label = 'DISABLED';
        token = 'text.secondary';
    } else {
        // enabled + connected but no session yet — treat as connecting.
        label = 'CONNECTING';
        token = 'warning.main';
    }
    return (
        <Chip
            label={label}
            sx={{
                bgcolor: (t) => `${t.palette[token.split('.')[0]]?.main || '#64748b'}22`,
                color: token,
                fontWeight: 'bold',
                fontSize: 14,
                height: 32,
                px: 0.5,
                border: '1px solid',
                borderColor: token,
            }}
        />
    );
}

export default function EdgeSyncPage() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'admin';

    const [status, setStatus] = useState(null);
    const [config, setConfig] = useState(null);
    const [health, setHealth] = useState(null);
    const [etp, setEtp] = useState(null);
    const [etpSaving, setEtpSaving] = useState(false);
    const [notification, setNotification] = useState({ open: false, message: '', severity: 'success' });

    // Config edit dialog.
    const [cfgOpen, setCfgOpen] = useState(false);
    const [cfgDraft, setCfgDraft] = useState(null);
    const [saving, setSaving] = useState(false);
    const [etpCfgOpen, setEtpCfgOpen] = useState(false);
    const [etpCfgDraft, setEtpCfgDraft] = useState(null);

    // WITSML export.
    const [minutes, setMinutes] = useState(2);
    const [downloading, setDownloading] = useState(false);

    const showNote = (message, severity = 'success') => setNotification({ open: true, message, severity });

    const loadStatus = useCallback(() => {
        axios.get('/api/sync/status')
            .then((r) => setStatus(r.data))
            .catch((e) => console.error('sync status load failed:', e));
    }, []);

    const loadConfig = useCallback(() => {
        axios.get('/api/sync/config')
            .then((r) => setConfig(r.data))
            .catch((e) => console.error('sync config load failed:', e));
    }, []);

    const loadHealth = useCallback(() => {
        axios.get('/api/health/edge')
            .then((r) => setHealth(r.data))
            .catch((e) => console.error('edge health load failed:', e));
    }, []);

    const loadEtp = useCallback(() => {
        axios.get('/api/etp/status')
            .then((r) => setEtp(r.data))
            .catch((e) => console.error('etp status load failed:', e));
    }, []);

    // Seed status + config + ETP once, then ride the live socket events.
    // Reuse the shared socket instance — Layout owns its connect/disconnect lifecycle.
    useEffect(() => {
        loadStatus();
        loadConfig();
        loadEtp();

        const handleSyncStatus = (data) => setStatus(data);
        const handleEtpStatus = (data) => setEtp(data);
        socket.on('sync_status', handleSyncStatus);
        socket.on('etp_status', handleEtpStatus);

        return () => {
            // Remove ONLY our handlers; never disconnect the shared socket.
            socket.off('sync_status', handleSyncStatus);
            socket.off('etp_status', handleEtpStatus);
        };
    }, [loadStatus, loadConfig, loadEtp]);

    // Poll edge health.
    useEffect(() => {
        loadHealth();
        const id = setInterval(loadHealth, HEALTH_POLL_MS);
        return () => clearInterval(id);
    }, [loadHealth]);

    // ---- Admin write actions ----
    const handleFlush = async () => {
        if (!isAdmin) return;
        try {
            const { data } = await axios.post('/api/sync/flush');
            if (data?.status) setStatus(data.status);
            showNote('Forced flush triggered');
            loadStatus();
        } catch (err) {
            console.error('force flush failed:', err);
            showNote(err.response?.data?.error || 'Failed to flush', 'error');
        }
    };

    const openConfig = () => {
        if (!isAdmin || !config) return;
        setCfgDraft({
            enabled: !!config.enabled,
            centralUrl: config.centralUrl || '',
            deviceId: config.deviceId || '',
            deviceToken: '', // never pre-fill the secret; blank = leave unchanged
            batchSeconds: config.batchSeconds ?? '',
            flushIntervalMs: config.flushIntervalMs ?? '',
            maxBufferDays: config.maxBufferDays ?? '',
            compression: !!config.compression,
        });
        setCfgOpen(true);
    };

    const saveConfig = async () => {
        if (!isAdmin || !cfgDraft) return;
        // Build a minimal body; omit deviceToken when left blank so we don't clear it.
        const body = {
            enabled: cfgDraft.enabled,
            centralUrl: cfgDraft.centralUrl.trim(),
            deviceId: cfgDraft.deviceId.trim(),
            compression: cfgDraft.compression,
        };
        if (cfgDraft.batchSeconds !== '') body.batchSeconds = Number(cfgDraft.batchSeconds);
        if (cfgDraft.flushIntervalMs !== '') body.flushIntervalMs = Number(cfgDraft.flushIntervalMs);
        if (cfgDraft.maxBufferDays !== '') body.maxBufferDays = Number(cfgDraft.maxBufferDays);
        if (cfgDraft.deviceToken !== '') body.deviceToken = cfgDraft.deviceToken;
        setSaving(true);
        try {
            const { data } = await axios.put('/api/sync/config', body);
            if (data?.config) setConfig(data.config);
            else loadConfig();
            showNote('Sync configuration saved');
            setCfgOpen(false);
            loadStatus();
        } catch (err) {
            console.error('save sync config failed:', err);
            showNote(err.response?.data?.error || 'Failed to save configuration', 'error');
        } finally {
            setSaving(false);
        }
    };

    // ---- ETP 2.0 publisher (admin) ----
    const setEtpConfig = async (body, successMsg) => {
        if (!isAdmin) return;
        setEtpSaving(true);
        try {
            const { data } = await axios.put('/api/etp/config', body);
            if (data?.status) setEtp(data.status);
            else loadEtp();
            showNote(successMsg);
        } catch (err) {
            console.error('save etp config failed:', err);
            showNote(err.response?.data?.error || 'Failed to update ETP publisher', 'error');
        } finally {
            setEtpSaving(false);
        }
    };

    const toggleEtp = (next) => setEtpConfig({ enabled: next }, `ETP publisher ${next ? 'enabled' : 'disabled'}`);

    const openEtpConfig = () => {
        if (!isAdmin || !etp) return;
        setEtpCfgDraft({
            enabled: !!etp.enabled,
            url: etp.url || '',
            deviceId: etp.deviceId || '',
            token: '',
            streamSeconds: etp.streamSeconds ?? 5,
        });
        setEtpCfgOpen(true);
    };

    const saveEtpConfig = async () => {
        if (!isAdmin || !etpCfgDraft) return;
        const body = {
            enabled: !!etpCfgDraft.enabled,
            url: etpCfgDraft.url.trim(),
            deviceId: etpCfgDraft.deviceId.trim(),
            streamSeconds: Number(etpCfgDraft.streamSeconds) || 5,
        };
        if (etpCfgDraft.token !== '') body.token = etpCfgDraft.token;
        await setEtpConfig(body, 'ETP publisher configuration saved');
        setEtpCfgOpen(false);
    };

    // ---- WITSML export ----
    // These endpoints return XML (text/xml), not JSON. Fetch as a blob via the
    // authenticated axios instance, then trigger a browser download via an anchor.
    const downloadXml = async (url, filename) => {
        setDownloading(true);
        try {
            const { data } = await axios.get(url, { responseType: 'blob' });
            const blob = data instanceof Blob ? data : new Blob([data], { type: 'application/xml' });
            const href = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = href;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(href);
            showNote(`Downloaded ${filename}`);
        } catch (err) {
            console.error('WITSML download failed:', err);
            showNote(err.response?.data?.error || 'Failed to download WITSML XML', 'error');
        } finally {
            setDownloading(false);
        }
    };

    const downloadLog = () => {
        const n = Math.min(60, Math.max(1, Number(minutes) || 1));
        downloadXml(`/api/witsml/log?minutes=${n}`, 'witsml-log.xml');
    };
    const downloadWell = () => downloadXml('/api/witsml/well', 'witsml-well.xml');

    const components = Array.isArray(health?.components) ? health.components : [];
    const missing = Array.isArray(health?.missing) ? health.missing : [];

    const fieldSx = {
        bgcolor: 'background.default',
        '& .MuiInputBase-input': { color: 'text.primary' },
        '& .MuiInputLabel-root': { color: 'text.secondary' },
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Box>
                <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                    <RefreshCw size={22} /> Edge Sync &amp; Data Quality
                </Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
                    Store-and-forward to central CRMF — outbound, read-only telemetry. The rig runs fully offline; buffered data replays automatically on reconnection.
                </Typography>
            </Box>

            {/* ---- Sync status panel ---- */}
            <Paper sx={{ p: 2, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 2 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Cloud size={18} /> Sync Status
                        </Typography>
                        <StateChip status={status} />
                    </Box>
                    {isAdmin && (
                        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                            <Button size="small" variant="outlined" startIcon={<Zap size={16} />} onClick={handleFlush}
                                sx={{ color: '#38bdf8', borderColor: 'divider', textTransform: 'none' }}>
                                Force Flush
                            </Button>
                            <Button size="small" variant="outlined" startIcon={<Settings size={16} />} onClick={openConfig}
                                sx={{ color: '#38bdf8', borderColor: 'divider', textTransform: 'none' }}>
                                Sync Config
                            </Button>
                        </Box>
                    )}
                </Box>

                {status?.lastError && (
                    <Alert severity="warning" sx={{ mb: 2 }} variant="outlined">
                        {String(status.lastError)}
                    </Alert>
                )}

                <Grid container spacing={1.5}>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Device ID" value={status?.deviceId || '--'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Central URL" value={status?.centralUrl || '--'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Buffered Batches" value={fmtInt(status?.bufferedBatches)} color="warning.main" /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Buffered Points" value={fmtInt(status?.bufferedPoints)} color="warning.main" /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Sync Lag" value={status?.syncLagSec != null ? `${fmtInt(status.syncLagSec)} s` : '--'} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Last Sync" value={timeAgo(status?.lastSyncAt)} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Acked Batches" value={fmtInt(status?.ackedBatches)} color="success.main" /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Acked Points" value={fmtInt(status?.ackedPoints)} color="success.main" /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Dropped Batches" value={fmtInt(status?.droppedBatches)} color={status?.droppedBatches > 0 ? 'error.main' : undefined} /></Grid>
                </Grid>

                {!isAdmin && config && (
                    <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                            Configuration (read-only)
                        </Typography>
                        <Grid container spacing={1} sx={{ mt: 0.5 }}>
                            <Grid item xs={6} sm={3}><Typography variant="body2" sx={{ color: 'text.secondary' }}>Enabled: <b style={{ color: config.enabled ? '#22c55e' : '#94a3b8' }}>{config.enabled ? 'Yes' : 'No'}</b></Typography></Grid>
                            <Grid item xs={6} sm={3}><Typography variant="body2" sx={{ color: 'text.secondary' }}>Batch: <b>{config.batchSeconds}s</b></Typography></Grid>
                            <Grid item xs={6} sm={3}><Typography variant="body2" sx={{ color: 'text.secondary' }}>Flush: <b>{config.flushIntervalMs ?? '--'} ms</b></Typography></Grid>
                            <Grid item xs={6} sm={3}><Typography variant="body2" sx={{ color: 'text.secondary' }}>Max Buffer: <b>{config.maxBufferDays}d</b></Typography></Grid>
                            <Grid item xs={6} sm={3}><Typography variant="body2" sx={{ color: 'text.secondary' }}>Compression: <b>{config.compression ? 'On' : 'Off'}</b></Typography></Grid>
                            <Grid item xs={12}><Typography variant="body2" sx={{ color: 'text.secondary' }}>Device Token: <b>{config.deviceTokenSet ? 'set' : 'not set'}</b></Typography></Grid>
                        </Grid>
                    </Box>
                )}
            </Paper>

            {/* ---- Edge health panel ---- */}
            <Paper sx={{ p: 2, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                    <HeartPulse size={18} /> Edge Data Quality
                </Typography>
                <Grid container spacing={2} alignItems="center">
                    <Grid item xs={12} sm={4} md={3}>
                        <Box sx={{ textAlign: 'center', p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                            <Typography variant="h2" sx={{ fontWeight: 'bold', color: gradeToken(health?.grade), lineHeight: 1 }}>
                                {health?.score != null ? Math.round(health.score) : '--'}
                            </Typography>
                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>/ 100</Typography>
                            <Box sx={{ mt: 1 }}>
                                <Chip
                                    label={health?.grade || '--'}
                                    sx={{
                                        bgcolor: (t) => `${t.palette[gradeToken(health?.grade).split('.')[0]]?.main || '#64748b'}22`,
                                        color: gradeToken(health?.grade),
                                        fontWeight: 'bold',
                                        border: '1px solid',
                                        borderColor: gradeToken(health?.grade),
                                    }}
                                />
                            </Box>
                            {(health?.present != null && health?.expected != null) && (
                                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
                                    {health.present}/{health.expected} sources present
                                </Typography>
                            )}
                        </Box>
                    </Grid>
                    <Grid item xs={12} sm={8} md={9}>
                        <Grid container spacing={1.5}>
                            {components.map((c, i) => (
                                <Grid item xs={12} sm={6} md={4} key={`${c.name}-${i}`}>
                                    <Paper sx={{ p: 1.5, bgcolor: 'background.default', border: '1px solid', borderColor: 'divider', height: '100%' }}>
                                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1, mb: 0.5 }}>
                                            <Typography variant="subtitle2" sx={{ color: 'text.primary', fontWeight: 'bold' }}>{c.name}</Typography>
                                            <StatusChip status={c.status} />
                                        </Box>
                                        <Typography variant="h6" sx={{ color: statusToken(c.status), fontWeight: 'bold', lineHeight: 1.2 }}>
                                            {c.score != null ? Math.round(c.score) : '--'}
                                        </Typography>
                                        {c.detail && (
                                            <Typography variant="caption" sx={{ color: 'text.secondary' }}>{c.detail}</Typography>
                                        )}
                                    </Paper>
                                </Grid>
                            ))}
                            {components.length === 0 && (
                                <Grid item xs={12}>
                                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>No health components reported.</Typography>
                                </Grid>
                            )}
                        </Grid>
                    </Grid>
                </Grid>

                {missing.length > 0 && (
                    <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                        <Typography variant="caption" sx={{ color: 'warning.main', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 'bold' }}>
                            Missing Sources
                        </Typography>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
                            {missing.map((m, i) => (
                                <Chip key={`${m}-${i}`} label={String(m)} size="small"
                                    sx={{ bgcolor: 'warning.main', color: 'background.paper', fontWeight: 'bold', height: 22, opacity: 0.85 }} />
                            ))}
                        </Box>
                    </Box>
                )}
            </Paper>

            {/* ---- ETP 2.0 publisher panel ---- */}
            <Paper sx={{ p: 2, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 1 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Radio size={18} /> ETP 2.0 Publisher
                        </Typography>
                        <EtpStateChip status={etp} />
                    </Box>
                    {isAdmin && (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                            <Button
                                size="small"
                                variant="outlined"
                                startIcon={<Settings size={16} />}
                                onClick={openEtpConfig}
                                disabled={!etp || etpSaving}
                                sx={{ color: '#38bdf8', borderColor: 'divider', textTransform: 'none' }}
                            >
                                ETP Config
                            </Button>
                            <FormControlLabel
                                control={
                                    <Switch
                                        checked={!!etp?.enabled}
                                        disabled={etpSaving}
                                        onChange={(e) => toggleEtp(e.target.checked)}
                                    />
                                }
                                label={etp?.enabled ? 'Enabled' : 'Disabled'}
                                sx={{ color: 'text.secondary', mr: 0 }}
                            />
                        </Box>
                    )}
                </Box>

                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2 }}>
                    ETP 2.0 (Energistics) outbound channel streaming — JSON-encoded subset; read-only publish to the central CRMF.
                </Typography>

                {etp?.lastError && (
                    <Alert severity="warning" sx={{ mb: 2 }} variant="outlined">
                        {String(etp.lastError)}
                    </Alert>
                )}

                <Grid container spacing={1.5}>
                    <Grid item xs={12} sm={6} md={4}><StatTile label="URL" value={etp?.url || '--'} /></Grid>
                    <Grid item xs={6} sm={4} md={2}><StatTile label="Device ID" value={etp?.deviceId || '--'} /></Grid>
                    <Grid item xs={6} sm={4} md={2}><StatTile label="Token" value={etp?.tokenSet ? 'Set' : 'Not set'} /></Grid>
                    <Grid item xs={6} sm={4} md={2}><StatTile label="Subprotocol" value={etp?.subprotocol || '--'} /></Grid>
                    <Grid item xs={6} sm={4} md={2}><StatTile label="Channels" value={fmtInt(etp?.channels)} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Frames Sent" value={fmtInt(etp?.framesSent)} color="success.main" /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Data Points Sent" value={fmtInt(etp?.dataPointsSent)} color="success.main" /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Last Sent" value={timeAgo(etp?.lastSentAt)} /></Grid>
                    <Grid item xs={6} sm={4} md={3}><StatTile label="Stream Interval" value={etp?.streamSeconds != null ? `${fmtInt(etp.streamSeconds)} s` : '--'} /></Grid>
                </Grid>
            </Paper>

            {/* ---- WITSML export panel ---- */}
            <Paper sx={{ p: 2, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <Download size={18} /> WITSML 1.4.1 Export
                </Typography>
                <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
                    Download standards-compliant WITSML XML for the log (last N minutes) and the well header.
                </Typography>
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                    <TextField
                        label="Minutes"
                        type="number"
                        size="small"
                        value={minutes}
                        onChange={(e) => setMinutes(e.target.value)}
                        inputProps={{ min: 1, max: 60 }}
                        sx={{ ...fieldSx, width: 120 }}
                    />
                    <Button variant="outlined" startIcon={<Download size={16} />} onClick={downloadLog} disabled={downloading}
                        sx={{ color: '#38bdf8', borderColor: 'divider', textTransform: 'none' }}>
                        Download Log XML
                    </Button>
                    <Divider orientation="vertical" flexItem sx={{ borderColor: 'divider' }} />
                    <Button variant="outlined" startIcon={<Download size={16} />} onClick={downloadWell} disabled={downloading}
                        sx={{ color: '#38bdf8', borderColor: 'divider', textTransform: 'none' }}>
                        Download Well XML
                    </Button>
                </Box>
            </Paper>

            {/* ---- Sync config dialog (admin) ---- */}
            <Dialog open={cfgOpen} onClose={() => setCfgOpen(false)} PaperProps={{ sx: { bgcolor: 'background.paper', color: 'text.primary', minWidth: 440 } }}>
                <DialogTitle>Sync Configuration</DialogTitle>
                <DialogContent>
                    {cfgDraft && (
                        <Grid container spacing={2} sx={{ mt: 0.5 }}>
                            <Grid item xs={12}>
                                <FormControlLabel
                                    control={<Switch checked={cfgDraft.enabled} onChange={(e) => setCfgDraft((d) => ({ ...d, enabled: e.target.checked }))} />}
                                    label="Sync Enabled"
                                />
                            </Grid>
                            <Grid item xs={12}>
                                <TextField label="Central URL" fullWidth size="small"
                                    value={cfgDraft.centralUrl} onChange={(e) => setCfgDraft((d) => ({ ...d, centralUrl: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Device ID" fullWidth size="small"
                                    value={cfgDraft.deviceId} onChange={(e) => setCfgDraft((d) => ({ ...d, deviceId: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Device Token" type="password" fullWidth size="small"
                                    placeholder={config?.deviceTokenSet ? 'set — leave blank to keep' : 'not set'}
                                    InputLabelProps={{ shrink: true }}
                                    value={cfgDraft.deviceToken} onChange={(e) => setCfgDraft((d) => ({ ...d, deviceToken: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Batch Seconds" type="number" fullWidth size="small"
                                    inputProps={{ min: 1, step: 1 }}
                                    helperText="Minimum 1 second"
                                    value={cfgDraft.batchSeconds} onChange={(e) => setCfgDraft((d) => ({ ...d, batchSeconds: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Flush Interval (ms)" type="number" fullWidth size="small"
                                    inputProps={{ min: 1000, step: 100 }}
                                    helperText="Minimum 1000 ms"
                                    value={cfgDraft.flushIntervalMs} onChange={(e) => setCfgDraft((d) => ({ ...d, flushIntervalMs: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Max Buffer Days" type="number" fullWidth size="small"
                                    value={cfgDraft.maxBufferDays} onChange={(e) => setCfgDraft((d) => ({ ...d, maxBufferDays: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12}>
                                <FormControlLabel
                                    control={<Switch checked={cfgDraft.compression} onChange={(e) => setCfgDraft((d) => ({ ...d, compression: e.target.checked }))} />}
                                    label="Compression"
                                />
                            </Grid>
                        </Grid>
                    )}
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setCfgOpen(false)} sx={{ color: 'text.secondary' }}>Cancel</Button>
                    <Button onClick={saveConfig} variant="contained" disabled={saving}
                        sx={{ bgcolor: '#38bdf8', color: '#0f172a', '&:hover': { bgcolor: '#0ea5e9' } }}>
                        {saving ? 'Saving…' : 'Save'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* ---- ETP 2.0 config dialog (admin) ---- */}
            <Dialog open={etpCfgOpen} onClose={() => setEtpCfgOpen(false)} PaperProps={{ sx: { bgcolor: 'background.paper', color: 'text.primary', minWidth: 520 } }}>
                <DialogTitle>ETP 2.0 Publisher Configuration</DialogTitle>
                <DialogContent>
                    {etpCfgDraft && (
                        <Grid container spacing={2} sx={{ mt: 0.5 }}>
                            <Grid item xs={12}>
                                <FormControlLabel
                                    control={<Switch checked={etpCfgDraft.enabled} onChange={(e) => setEtpCfgDraft((d) => ({ ...d, enabled: e.target.checked }))} />}
                                    label="ETP Publisher Enabled"
                                />
                            </Grid>
                            <Grid item xs={12}>
                                <TextField label="Central Server URL" fullWidth size="small"
                                    placeholder="ws://10.207.104.70:6000"
                                    value={etpCfgDraft.url}
                                    onChange={(e) => setEtpCfgDraft((d) => ({ ...d, url: e.target.value }))}
                                    sx={fieldSx}
                                />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Device ID" fullWidth size="small"
                                    value={etpCfgDraft.deviceId}
                                    onChange={(e) => setEtpCfgDraft((d) => ({ ...d, deviceId: e.target.value }))}
                                    sx={fieldSx}
                                />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Central Server Token" type="password" fullWidth size="small"
                                    placeholder={etp?.tokenSet ? 'set — leave blank to keep' : 'not set'}
                                    InputLabelProps={{ shrink: true }}
                                    value={etpCfgDraft.token}
                                    onChange={(e) => setEtpCfgDraft((d) => ({ ...d, token: e.target.value }))}
                                    sx={fieldSx}
                                />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Stream Interval Seconds" type="number" fullWidth size="small"
                                    inputProps={{ min: 1, step: 1 }}
                                    helperText="Minimum 1 second"
                                    value={etpCfgDraft.streamSeconds}
                                    onChange={(e) => setEtpCfgDraft((d) => ({ ...d, streamSeconds: e.target.value }))}
                                    sx={fieldSx}
                                />
                            </Grid>
                        </Grid>
                    )}
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setEtpCfgOpen(false)} sx={{ color: 'text.secondary' }}>Cancel</Button>
                    <Button onClick={saveEtpConfig} variant="contained" disabled={etpSaving}
                        sx={{ bgcolor: '#38bdf8', color: '#0f172a', '&:hover': { bgcolor: '#0ea5e9' } }}>
                        {etpSaving ? 'Saving…' : 'Save'}
                    </Button>
                </DialogActions>
            </Dialog>

            <Snackbar open={notification.open} autoHideDuration={4000} onClose={() => setNotification({ ...notification, open: false })}>
                <Alert severity={notification.severity} variant="filled">{notification.message}</Alert>
            </Snackbar>
        </Box>
    );
}
