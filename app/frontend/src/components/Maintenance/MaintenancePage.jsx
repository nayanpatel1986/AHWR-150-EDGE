import React, { useState, useEffect, useCallback } from 'react';
import {
    Box, Typography, Paper, Grid, Button, TextField, Table, TableBody,
    TableCell, TableContainer, TableHead, TableRow, Dialog, DialogTitle,
    DialogContent, DialogActions, Snackbar, Alert, Chip, MenuItem,
    FormControl, InputLabel, Select, Tabs, Tab
} from '@mui/material';
import { HeartPulse, Wrench, SlidersHorizontal, AlertTriangle, Plus, BookOpen, Hammer, ClipboardList, Gauge, Activity } from 'lucide-react';
import axios from '../../api';
import { useAuth } from '../../context/AuthContext';
import { isLiveRigPayload } from '../../socket';
import { formatHours } from '../../utils/format';
import WorkOrders from './WorkOrders';
import Logbook from './Logbook';
import Overhauls from './Overhauls';
import RunHours from './RunHours';
import Instruments from './Instruments';

const POLL_MS = 12000;

const headSx = { color: '#94a3b8', fontWeight: 'bold', borderColor: '#334155', whiteSpace: 'nowrap' };
const cellSx = { color: 'white', borderColor: '#1e293b' };
const fieldSx = {
    bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' },
    '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' },
    '.MuiSvgIcon-root': { color: '#94a3b8' }, '.MuiSelect-select': { color: 'white' },
};

// PM status -> color. overdue red, due-soon amber, ok green.
const STATUS_COLOR = { overdue: '#ef4444', 'due-soon': '#f59e0b', ok: '#22c55e' };
const STATUS_LABEL = { overdue: 'Overdue', 'due-soon': 'Due Soon', ok: 'OK' };
const SEVERITY_COLOR = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };

function statusColor(s) { return STATUS_COLOR[s] || '#64748b'; }

// Local date + time string from an ISO/epoch timestamp.
function formatTimestamp(ts) {
    if (!ts) return '--';
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleString('en-US', {
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
}

function StatusChip({ status }) {
    const c = statusColor(status);
    return (
        <Chip label={STATUS_LABEL[status] || status || '--'} size="small"
            sx={{ bgcolor: `${c}22`, color: c, fontWeight: 'bold', height: 22, border: `1px solid ${c}` }} />
    );
}

function KpiCard({ label, value, color }) {
    const display = value == null ? '--' : value;
    return (
        <Paper sx={{ p: 2, bgcolor: '#1e293b', border: `1px solid ${color}`, textAlign: 'center' }}>
            <Typography variant="caption" sx={{ color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</Typography>
            <Typography variant="h4" sx={{ color, fontWeight: 'bold', lineHeight: 1.2 }}>{display}</Typography>
        </Paper>
    );
}

function AssetCard({ asset }) {
    const c = statusColor(asset.pmStatus);
    return (
        <Paper sx={{ p: 2, bgcolor: '#1e293b', border: '1px solid #334155', height: '100%', display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 1 }}>
                <Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: 'white', lineHeight: 1.2 }}>{asset.name}</Typography>
                    <Typography variant="caption" sx={{ color: '#94a3b8' }}>{asset.category}</Typography>
                </Box>
                <StatusChip status={asset.pmStatus} />
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="h6" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{formatHours(asset.hours)}</Typography>
                <Chip label={asset.source === 'measured' ? 'measured' : 'derived'} size="small"
                    sx={{
                        height: 18, fontSize: 11,
                        bgcolor: asset.source === 'measured' ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)',
                        color: asset.source === 'measured' ? '#22c55e' : '#94a3b8',
                    }} />
            </Box>

            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                <Typography variant="body2" sx={{ color: '#94a3b8' }}>
                    next due in <span style={{ color: c, fontWeight: 'bold' }}>{formatHours(asset.nextDueInHours)}</span>
                </Typography>
                {asset.openDowntime > 0 && (
                    <Chip label={`${asset.openDowntime} open DT`} size="small"
                        sx={{ height: 20, bgcolor: 'rgba(239,68,68,0.15)', color: '#ef4444', fontWeight: 'bold' }} />
                )}
            </Box>

            {Array.isArray(asset.health) && asset.health.length > 0 && (
                <Box sx={{ mt: 0.5, pt: 1, borderTop: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {asset.health.map((h, i) => (
                        <Box key={`${h.label}-${i}`} sx={{ display: 'flex', justifyContent: 'space-between' }}>
                            <Typography variant="caption" sx={{ color: '#94a3b8' }}>{h.label}</Typography>
                            <Typography variant="caption" sx={{ color: 'white', fontWeight: 'bold' }}>{h.value}</Typography>
                        </Box>
                    ))}
                </Box>
            )}

            {asset.pmTasks != null && (
                <Typography variant="caption" sx={{ color: '#64748b', mt: 'auto' }}>{asset.pmTasks} PM task(s)</Typography>
            )}
        </Paper>
    );
}

export default function MaintenancePage() {
    const { user } = useAuth();
    const canWrite = user?.role === 'admin' || user?.role === 'operator';

    const [summary, setSummary] = useState({ counts: { overdue: null, dueSoon: null, openDowntime: null }, assets: [] });
    const [pm, setPm] = useState([]);
    const [calibrations, setCalibrations] = useState([]);
    const [downtime, setDowntime] = useState([]);
    const [reasonCodes, setReasonCodes] = useState([]);
    const [notification, setNotification] = useState({ open: false, message: '', severity: 'success' });
    // CMMS: tab selection, vocabularies and roll-up counters.
    const [tab, setTab] = useState(0);
    const [cmmsMeta, setCmmsMeta] = useState({});
    const [cmms, setCmms] = useState({ workOrders: {}, overhauls: {}, logbook: {} });

    // Dialog state.
    const [serviceTask, setServiceTask] = useState(null);
    const [serviceDraft, setServiceDraft] = useState({ hours: '', date: '', notes: '' });
    const [calOpen, setCalOpen] = useState(false);
    const [calDraft, setCalDraft] = useState({ asset: '', value: '' });
    const [dtOpen, setDtOpen] = useState(false);
    const [dtDraft, setDtDraft] = useState({ reasonCode: '', severity: 'medium', assetId: '', notes: '' });

    const showNote = (message, severity = 'success') => setNotification({ open: true, message, severity });

    const refresh = useCallback(() => {
        axios.get('/api/rig/latest', { timeout: 4500 })
            .then(({ data }) => {
                if (!isLiveRigPayload(data)) {
                    setSummary({ assets: [], counts: { overdue: null, dueSoon: null, openDowntime: null } });
                    setPm([]);
                    setCmms({ workOrders: {}, overhauls: {}, logbook: {} });
                    return;
                }
                axios.get('/api/maintenance/summary', { timeout: 4500 }).then((r) => setSummary(r.data)).catch((e) => console.error('summary load failed:', e));
                axios.get('/api/maintenance/pm', { timeout: 4500 }).then((r) => setPm(r.data || [])).catch((e) => console.error('pm load failed:', e));
                axios.get('/api/cmms/summary', { timeout: 4500 }).then((r) => setCmms(r.data || {})).catch((e) => console.error('cmms summary load failed:', e));
            })
            .catch(() => {
                setSummary({ assets: [], counts: { overdue: null, dueSoon: null, openDowntime: null } });
                setPm([]);
                setCmms({ workOrders: {}, overhauls: {}, logbook: {} });
            });
        axios.get('/api/maintenance/calibrations', { timeout: 4500 }).then((r) => setCalibrations(r.data || [])).catch((e) => console.error('calibrations load failed:', e));
        axios.get('/api/maintenance/downtime', { timeout: 4500 }).then((r) => setDowntime(r.data || [])).catch((e) => console.error('downtime load failed:', e));
    }, []);

    useEffect(() => {
        refresh();
        axios.get('/api/maintenance/reason-codes', { timeout: 4500 }).then((r) => setReasonCodes(r.data || [])).catch((e) => console.error('reason-codes load failed:', e));
        axios.get('/api/cmms/meta', { timeout: 4500 }).then((r) => setCmmsMeta(r.data || {})).catch((e) => console.error('cmms meta load failed:', e));
        const id = setInterval(refresh, POLL_MS);
        return () => clearInterval(id);
    }, [refresh]);

    const assets = summary.assets || [];
    const counts = summary.counts || { overdue: null, dueSoon: null, openDowntime: null };

    // ---- Write actions ----
    const openService = (task) => {
        setServiceTask(task);
        setServiceDraft({ hours: '', date: '', notes: '' });
    };

    const submitService = async () => {
        if (!serviceTask) return;
        const body = {};
        if (serviceDraft.hours !== '') body.hours = Number(serviceDraft.hours);
        if (serviceDraft.date) body.date = serviceDraft.date;
        if (serviceDraft.notes) body.notes = serviceDraft.notes;
        try {
            await axios.post(`/api/maintenance/pm/${serviceTask.id}/service`, body);
            showNote(`Service recorded for ${serviceTask.name}`);
            setServiceTask(null);
            refresh();
        } catch (err) {
            console.error('record service failed:', err);
            showNote(err.response?.data?.error || 'Failed to record service', 'error');
        }
    };

    const submitCalibration = async () => {
        const body = { type: 'Calibration' };
        if (calDraft.asset) body.asset = calDraft.asset;
        if (calDraft.value !== '') body.value = calDraft.value;
        try {
            await axios.post('/api/maintenance/calibrations', body);
            showNote('Calibration logged');
            setCalOpen(false);
            setCalDraft({ asset: '', value: '' });
            refresh();
        } catch (err) {
            console.error('log calibration failed:', err);
            showNote(err.response?.data?.error || 'Failed to log calibration', 'error');
        }
    };

    const submitDowntime = async () => {
        if (!dtDraft.reasonCode) { showNote('Reason code is required', 'error'); return; }
        const body = { reasonCode: dtDraft.reasonCode, severity: dtDraft.severity };
        if (dtDraft.assetId) body.assetId = dtDraft.assetId;
        if (dtDraft.notes) body.notes = dtDraft.notes;
        try {
            await axios.post('/api/maintenance/downtime', body);
            showNote('Downtime logged');
            setDtOpen(false);
            setDtDraft({ reasonCode: '', severity: 'medium', assetId: '', notes: '' });
            refresh();
        } catch (err) {
            console.error('log downtime failed:', err);
            showNote(err.response?.data?.error || 'Failed to log downtime', 'error');
        }
    };

    const closeDowntime = async (row) => {
        try {
            await axios.post(`/api/maintenance/downtime/${row.id}/close`);
            showNote('Downtime closed');
            refresh();
        } catch (err) {
            console.error('close downtime failed:', err);
            showNote(err.response?.data?.error || 'Failed to close downtime', 'error');
        }
    };

    const assetName = (id) => assets.find((a) => a.id === id)?.name || id || '--';

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                <HeartPulse size={22} /> Maintenance Management (CMMS)
            </Typography>

            {/* KPI row */}
            <Grid container spacing={2}>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="PM Overdue" value={counts.overdue} color="#ef4444" /></Grid>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="PM Due Soon" value={counts.dueSoon} color="#f59e0b" /></Grid>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="Open WOs" value={cmms.workOrders?.open} color="#38bdf8" /></Grid>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="Breakdowns" value={cmms.workOrders?.breakdownOpen} color="#ef4444" /></Grid>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="Overhauls" value={cmms.overhauls ? (cmms.overhauls.active ?? 0) + (cmms.overhauls.planned ?? 0) : null} color="#a78bfa" /></Grid>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="Open Downtime" value={counts.openDowntime} color="#f97316" /></Grid>
            </Grid>

            {/* CMMS module tabs */}
            <Box sx={{ borderBottom: 1, borderColor: '#334155' }}>
                <Tabs value={tab} onChange={(e, v) => setTab(v)} textColor="primary" indicatorColor="primary" variant="scrollable" scrollButtons="auto">
                    <Tab icon={<HeartPulse size={16} />} iconPosition="start" label="Asset Health & PM" sx={{ color: tab === 0 ? '#38bdf8' : '#94a3b8', textTransform: 'none', minHeight: 46 }} />
                    <Tab icon={<ClipboardList size={16} />} iconPosition="start" label="Work Orders" sx={{ color: tab === 1 ? '#38bdf8' : '#94a3b8', textTransform: 'none', minHeight: 46 }} />
                    <Tab icon={<Hammer size={16} />} iconPosition="start" label="Major Overhauls" sx={{ color: tab === 2 ? '#38bdf8' : '#94a3b8', textTransform: 'none', minHeight: 46 }} />
                    <Tab icon={<Gauge size={16} />} iconPosition="start" label="Run Hours" sx={{ color: tab === 3 ? '#38bdf8' : '#94a3b8', textTransform: 'none', minHeight: 46 }} />
                    <Tab icon={<SlidersHorizontal size={16} />} iconPosition="start" label="Instruments" sx={{ color: tab === 4 ? '#38bdf8' : '#94a3b8', textTransform: 'none', minHeight: 46 }} />
                    <Tab icon={<Activity size={16} />} iconPosition="start" label="Operations Log" sx={{ color: tab === 5 ? '#38bdf8' : '#94a3b8', textTransform: 'none', minHeight: 46 }} />
                    <Tab icon={<BookOpen size={16} />} iconPosition="start" label="Maintenance Log" sx={{ color: tab === 6 ? '#38bdf8' : '#94a3b8', textTransform: 'none', minHeight: 46 }} />
                </Tabs>
            </Box>

            {tab === 1 && <WorkOrders meta={cmmsMeta} canWrite={canWrite} onChanged={refresh} showNote={showNote} />}
            {tab === 2 && <Overhauls meta={cmmsMeta} canWrite={canWrite} onChanged={refresh} showNote={showNote} />}
            {tab === 3 && <RunHours />}
            {tab === 4 && <Instruments canWrite={canWrite} showNote={showNote} />}
            {tab === 5 && <Logbook logType="OPERATIONS" meta={cmmsMeta} canWrite={canWrite} onChanged={refresh} showNote={showNote} />}
            {tab === 6 && <Logbook logType="MAINTENANCE" meta={cmmsMeta} canWrite={canWrite} onChanged={refresh} showNote={showNote} />}

            {tab === 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>

            {/* Asset health cards */}
            <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <HeartPulse size={18} /> Asset Health
                </Typography>
                <Grid container spacing={2}>
                    {assets.map((a) => (
                        <Grid item xs={12} sm={6} md={4} lg={3} key={a.id}><AssetCard asset={a} /></Grid>
                    ))}
                    {assets.length === 0 && (
                        <Grid item xs={12}>
                            <Paper sx={{ p: 3, bgcolor: '#1e293b', border: '1px solid #334155', textAlign: 'center', color: '#94a3b8' }}>
                                No assets reported.
                            </Paper>
                        </Grid>
                    )}
                </Grid>
            </Box>

            {/* PM schedule */}
            <Paper sx={{ bgcolor: '#1e293b', border: '1px solid #334155' }}>
                <Box sx={{ p: 2 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Wrench size={18} /> Preventive Maintenance Schedule
                    </Typography>
                </Box>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell sx={headSx}>Task</TableCell>
                                <TableCell sx={headSx}>Asset</TableCell>
                                <TableCell sx={headSx} align="right">Interval</TableCell>
                                <TableCell sx={headSx} align="right">Current</TableCell>
                                <TableCell sx={headSx} align="right">Next</TableCell>
                                <TableCell sx={headSx} align="right">Due In</TableCell>
                                <TableCell sx={headSx}>Status</TableCell>
                                {canWrite && <TableCell sx={headSx} align="right">Action</TableCell>}
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {pm.map((t) => (
                                <TableRow key={t.id} hover>
                                    <TableCell sx={cellSx}>{t.name}</TableCell>
                                    <TableCell sx={cellSx}>{assetName(t.assetId)}</TableCell>
                                    <TableCell sx={cellSx} align="right">{formatHours(t.intervalHours)}</TableCell>
                                    <TableCell sx={cellSx} align="right">{formatHours(t.currentHours)}</TableCell>
                                    <TableCell sx={cellSx} align="right">{formatHours(t.nextHours)}</TableCell>
                                    <TableCell sx={cellSx} align="right">
                                        <span style={{ color: statusColor(t.status), fontWeight: 'bold' }}>{formatHours(t.dueInHours)}</span>
                                    </TableCell>
                                    <TableCell sx={cellSx}><StatusChip status={t.status} /></TableCell>
                                    {canWrite && (
                                        <TableCell sx={cellSx} align="right">
                                            <Button size="small" variant="outlined" startIcon={<Wrench size={14} />} onClick={() => openService(t)}
                                                sx={{ color: '#38bdf8', borderColor: '#334155', textTransform: 'none' }}>
                                                Service
                                            </Button>
                                        </TableCell>
                                    )}
                                </TableRow>
                            ))}
                            {pm.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={canWrite ? 8 : 7} align="center" sx={{ color: '#94a3b8', py: 4, borderColor: '#1e293b' }}>
                                        No PM tasks.
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* Calibration history */}
            <Paper sx={{ bgcolor: '#1e293b', border: '1px solid #334155' }}>
                <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                        <SlidersHorizontal size={18} /> Calibration History
                    </Typography>
                    {canWrite && (
                        <Button size="small" variant="outlined" startIcon={<Plus size={16} />} onClick={() => setCalOpen(true)}
                            sx={{ color: '#38bdf8', borderColor: '#334155', textTransform: 'none' }}>
                            Add Calibration
                        </Button>
                    )}
                </Box>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell sx={headSx}>Type</TableCell>
                                <TableCell sx={headSx}>Asset</TableCell>
                                <TableCell sx={headSx}>Value</TableCell>
                                <TableCell sx={headSx}>By</TableCell>
                                <TableCell sx={headSx}>Time</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {calibrations.map((c) => (
                                <TableRow key={c.id} hover>
                                    <TableCell sx={cellSx}>{c.type}</TableCell>
                                    <TableCell sx={cellSx}>{c.asset || '--'}</TableCell>
                                    <TableCell sx={cellSx}>{c.value != null && c.value !== '' ? c.value : '--'}</TableCell>
                                    <TableCell sx={cellSx}>{c.by || '--'}</TableCell>
                                    <TableCell sx={cellSx}>{formatTimestamp(c.ts)}</TableCell>
                                </TableRow>
                            ))}
                            {calibrations.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={5} align="center" sx={{ color: '#94a3b8', py: 4, borderColor: '#1e293b' }}>
                                        No calibrations recorded.
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* Downtime / failure log */}
            <Paper sx={{ bgcolor: '#1e293b', border: '1px solid #334155' }}>
                <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                        <AlertTriangle size={18} /> Downtime / Failure Log
                    </Typography>
                    {canWrite && (
                        <Button size="small" variant="outlined" startIcon={<Plus size={16} />} onClick={() => setDtOpen(true)}
                            sx={{ color: '#f59e0b', borderColor: '#334155', textTransform: 'none' }}>
                            Log Downtime
                        </Button>
                    )}
                </Box>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell sx={headSx}>Asset</TableCell>
                                <TableCell sx={headSx}>Reason</TableCell>
                                <TableCell sx={headSx}>Severity</TableCell>
                                <TableCell sx={headSx}>Start</TableCell>
                                <TableCell sx={headSx}>End</TableCell>
                                <TableCell sx={headSx} align="right">Duration</TableCell>
                                <TableCell sx={headSx}>Notes</TableCell>
                                <TableCell sx={headSx}>By</TableCell>
                                {canWrite && <TableCell sx={headSx} align="right">Action</TableCell>}
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {downtime.map((d) => {
                                const open = d.end == null;
                                const sc = SEVERITY_COLOR[d.severity] || '#64748b';
                                return (
                                    <TableRow key={d.id} hover>
                                        <TableCell sx={cellSx}>{assetName(d.assetId)}</TableCell>
                                        <TableCell sx={cellSx}>{d.reasonCode}</TableCell>
                                        <TableCell sx={cellSx}>
                                            <Chip label={d.severity || '--'} size="small"
                                                sx={{ bgcolor: `${sc}22`, color: sc, fontWeight: 'bold', height: 20, textTransform: 'capitalize' }} />
                                        </TableCell>
                                        <TableCell sx={cellSx}>{formatTimestamp(d.start)}</TableCell>
                                        <TableCell sx={cellSx}>
                                            {open
                                                ? <Chip label="OPEN" size="small" sx={{ bgcolor: 'rgba(239,68,68,0.15)', color: '#ef4444', fontWeight: 'bold', height: 20 }} />
                                                : formatTimestamp(d.end)}
                                        </TableCell>
                                        <TableCell sx={cellSx} align="right">{d.durationMin != null ? `${d.durationMin} min` : '--'}</TableCell>
                                        <TableCell sx={cellSx}>{d.notes || '--'}</TableCell>
                                        <TableCell sx={cellSx}>{d.by || '--'}</TableCell>
                                        {canWrite && (
                                            <TableCell sx={cellSx} align="right">
                                                {open && (
                                                    <Button size="small" variant="outlined" onClick={() => closeDowntime(d)}
                                                        sx={{ color: '#22c55e', borderColor: '#334155', textTransform: 'none' }}>
                                                        Close
                                                    </Button>
                                                )}
                                            </TableCell>
                                        )}
                                    </TableRow>
                                );
                            })}
                            {downtime.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={canWrite ? 9 : 8} align="center" sx={{ color: '#94a3b8', py: 4, borderColor: '#1e293b' }}>
                                        No downtime recorded.
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>
            </Box>
            )}

            {/* Service dialog */}
            <Dialog open={Boolean(serviceTask)} onClose={() => setServiceTask(null)} PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 420 } }}>
                <DialogTitle>Record Service{serviceTask ? ` — ${serviceTask.name}` : ''}</DialogTitle>
                <DialogContent>
                    <Grid container spacing={2} sx={{ mt: 0.5 }}>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Service Hours (optional)" type="number" fullWidth size="small"
                                value={serviceDraft.hours} onChange={(e) => setServiceDraft((d) => ({ ...d, hours: e.target.value }))} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Date (optional)" type="date" fullWidth size="small" InputLabelProps={{ shrink: true }}
                                value={serviceDraft.date} onChange={(e) => setServiceDraft((d) => ({ ...d, date: e.target.value }))} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField label="Notes (optional)" fullWidth size="small" multiline minRows={2}
                                value={serviceDraft.notes} onChange={(e) => setServiceDraft((d) => ({ ...d, notes: e.target.value }))}
                                sx={{ ...fieldSx, textarea: { color: 'white' } }} />
                        </Grid>
                    </Grid>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setServiceTask(null)} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button onClick={submitService} variant="contained" sx={{ bgcolor: '#38bdf8', color: '#0f172a', '&:hover': { bgcolor: '#0ea5e9' } }}>Record</Button>
                </DialogActions>
            </Dialog>

            {/* Add calibration dialog */}
            <Dialog open={calOpen} onClose={() => setCalOpen(false)} PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 420 } }}>
                <DialogTitle>Add Calibration</DialogTitle>
                <DialogContent>
                    <Grid container spacing={2} sx={{ mt: 0.5 }}>
                        <Grid item xs={12}>
                            <FormControl fullWidth size="small" sx={fieldSx}>
                                <InputLabel sx={{ color: '#94a3b8' }}>Asset (optional)</InputLabel>
                                <Select label="Asset (optional)" value={calDraft.asset}
                                    onChange={(e) => setCalDraft((d) => ({ ...d, asset: e.target.value }))}
                                    MenuProps={{ PaperProps: { sx: { bgcolor: '#1e293b', color: 'white' } } }}>
                                    <MenuItem value=""><em>None</em></MenuItem>
                                    {assets.map((a) => <MenuItem key={a.id} value={a.name}>{a.name}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Grid>
                        <Grid item xs={12}>
                            <TextField label="Value (optional)" fullWidth size="small"
                                value={calDraft.value} onChange={(e) => setCalDraft((d) => ({ ...d, value: e.target.value }))} sx={fieldSx} />
                        </Grid>
                    </Grid>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setCalOpen(false)} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button onClick={submitCalibration} variant="contained" sx={{ bgcolor: '#38bdf8', color: '#0f172a', '&:hover': { bgcolor: '#0ea5e9' } }}>Add</Button>
                </DialogActions>
            </Dialog>

            {/* Log downtime dialog */}
            <Dialog open={dtOpen} onClose={() => setDtOpen(false)} PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 420 } }}>
                <DialogTitle>Log Downtime</DialogTitle>
                <DialogContent>
                    <Grid container spacing={2} sx={{ mt: 0.5 }}>
                        <Grid item xs={12} sm={6}>
                            <FormControl fullWidth size="small" required sx={fieldSx}>
                                <InputLabel sx={{ color: '#94a3b8' }}>Reason Code</InputLabel>
                                <Select label="Reason Code" value={dtDraft.reasonCode}
                                    onChange={(e) => setDtDraft((d) => ({ ...d, reasonCode: e.target.value }))}
                                    MenuProps={{ PaperProps: { sx: { bgcolor: '#1e293b', color: 'white' } } }}>
                                    {reasonCodes.map((rc) => <MenuItem key={rc} value={rc}>{rc}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <FormControl fullWidth size="small" sx={fieldSx}>
                                <InputLabel sx={{ color: '#94a3b8' }}>Severity</InputLabel>
                                <Select label="Severity" value={dtDraft.severity}
                                    onChange={(e) => setDtDraft((d) => ({ ...d, severity: e.target.value }))}
                                    MenuProps={{ PaperProps: { sx: { bgcolor: '#1e293b', color: 'white' } } }}>
                                    <MenuItem value="low">Low</MenuItem>
                                    <MenuItem value="medium">Medium</MenuItem>
                                    <MenuItem value="high">High</MenuItem>
                                </Select>
                            </FormControl>
                        </Grid>
                        <Grid item xs={12}>
                            <FormControl fullWidth size="small" sx={fieldSx}>
                                <InputLabel sx={{ color: '#94a3b8' }}>Asset (optional)</InputLabel>
                                <Select label="Asset (optional)" value={dtDraft.assetId}
                                    onChange={(e) => setDtDraft((d) => ({ ...d, assetId: e.target.value }))}
                                    MenuProps={{ PaperProps: { sx: { bgcolor: '#1e293b', color: 'white' } } }}>
                                    <MenuItem value=""><em>None</em></MenuItem>
                                    {assets.map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Grid>
                        <Grid item xs={12}>
                            <TextField label="Notes (optional)" fullWidth size="small" multiline minRows={2}
                                value={dtDraft.notes} onChange={(e) => setDtDraft((d) => ({ ...d, notes: e.target.value }))}
                                sx={{ ...fieldSx, textarea: { color: 'white' } }} />
                        </Grid>
                    </Grid>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setDtOpen(false)} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button onClick={submitDowntime} variant="contained" sx={{ bgcolor: '#f59e0b', color: '#0f172a', '&:hover': { bgcolor: '#d97706' } }}>Log</Button>
                </DialogActions>
            </Dialog>

            <Snackbar open={notification.open} autoHideDuration={4000} onClose={() => setNotification({ ...notification, open: false })}>
                <Alert severity={notification.severity} variant="filled">{notification.message}</Alert>
            </Snackbar>
        </Box>
    );
}
