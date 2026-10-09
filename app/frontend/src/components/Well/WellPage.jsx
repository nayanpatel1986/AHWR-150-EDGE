import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Box, Typography, Paper, Grid, Button, TextField, Table, TableBody,
    TableCell, TableContainer, TableHead, TableRow, Dialog, DialogTitle,
    DialogContent, DialogActions, Snackbar, Alert, Chip, MenuItem,
    FormControl, InputLabel, Select, Tooltip, Divider, Tabs, Tab
} from '@mui/material';
import { useTheme, alpha } from '@mui/material/styles';
import {
    MapPin, Plus, Play, CheckCircle, Edit2, Target, Clock, Ruler, Layers, Activity,
    Database, FileText
} from 'lucide-react';
import axios from '../../api';
import { useAuth } from '../../context/AuthContext';
import { secondsSince, formatDuration } from '../../utils/format';
import WellDataArchive from './WellDataArchive';
import WellReport from './WellReport';

const POLL_MS = 5000;

// Lifecycle status -> semantic color. These carry meaning, so they stay literal
// (like the Maintenance page) and read fine across all four themes.
const STATUS_COLOR = { planned: '#94a3b8', active: '#22c55e', complete: '#3b82f6' };
const STATUS_LABEL = { planned: 'Planned', active: 'Active', complete: 'Complete' };

function statusColor(s) { return STATUS_COLOR[s] || '#64748b'; }

function StatusChip({ status }) {
    const c = statusColor(status);
    return (
        <Chip
            label={STATUS_LABEL[status] || status || '--'}
            size="small"
            sx={{ bgcolor: alpha(c, 0.18), color: c, fontWeight: 'bold', height: 22, border: `1px solid ${c}` }}
        />
    );
}

// Local date+time string from an ISO/epoch timestamp.
function formatTimestamp(ts) {
    if (!ts) return '--';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '--';
    return d.toLocaleString('en-US', {
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
}

// Seconds -> hours, one decimal.
function secToHours(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n)) return '--';
    return (n / 3600).toFixed(1);
}

const EMPTY_FORM = {
    name: '', uwi: '', field: '', operator: '', rig: '', location: '',
    country: '', serviceType: '', jobNo: '', objective: '', companyMan: '',
    toolpusher: '', plannedTdM: '', spudDate: '',
};

export default function WellPage() {
    const theme = useTheme();
    const { user } = useAuth();
    const canWrite = user?.role === 'admin' || user?.role === 'operator';

    const [wells, setWells] = useState([]);
    const [activeWell, setActiveWell] = useState(null);
    const [summary, setSummary] = useState(null);
    const [tab, setTab] = useState(0);
    const [serviceTypes, setServiceTypes] = useState([]);
    const [notification, setNotification] = useState({ open: false, message: '', severity: 'success' });

    // Live elapsed ticker for the active well.
    const [nowTick, setNowTick] = useState(Date.now());

    // Form dialog (create + edit).
    const [formOpen, setFormOpen] = useState(false);
    const [editId, setEditId] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);

    // Confirm dialogs.
    const [completeTarget, setCompleteTarget] = useState(null);

    // Theme-derived style tokens (work across all four themes).
    const paperSx = { bgcolor: 'background.paper', border: `1px solid ${theme.palette.divider}` };
    const headSx = { color: 'text.secondary', fontWeight: 'bold', borderColor: theme.palette.divider, whiteSpace: 'nowrap' };
    const cellSx = { color: 'text.primary', borderColor: alpha(theme.palette.divider, 0.6) };
    const fieldSx = {
        bgcolor: 'background.default',
        input: { color: theme.palette.text.primary },
        textarea: { color: theme.palette.text.primary },
        label: { color: theme.palette.text.secondary },
        '.MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.divider },
        '.MuiSvgIcon-root': { color: theme.palette.text.secondary },
        '.MuiSelect-select': { color: theme.palette.text.primary },
    };

    const showNote = (message, severity = 'success') => setNotification({ open: true, message, severity });

    const refresh = useCallback(() => {
        axios.get('/api/wells', { timeout: 4500 })
            .then((r) => setWells(Array.isArray(r.data) ? r.data : []))
            .catch((e) => console.error('wells load failed:', e));
        axios.get('/api/wells/active', { timeout: 4500 })
            .then((r) => {
                const w = r.data || null;
                setActiveWell(w);
                if (w?.id) {
                    axios.get(`/api/wells/${w.id}/summary`, { params: { light: 1 }, timeout: 4500 })
                        .then((s) => setSummary(s.data))
                        .catch((e) => console.error('well summary load failed:', e));
                } else {
                    setSummary(null);
                }
            })
            .catch((e) => console.error('active well load failed:', e));
    }, []);

    useEffect(() => {
        refresh();
        axios.get('/api/wells/service-types', { timeout: 4500 })
            .then((r) => setServiceTypes(Array.isArray(r.data) ? r.data : []))
            .catch((e) => console.error('service-types load failed:', e));
        const id = setInterval(refresh, POLL_MS);
        return () => clearInterval(id);
    }, [refresh]);

    // 1s ticker so the active-well live elapsed updates between polls.
    useEffect(() => {
        if (!activeWell?.startedAt) return undefined;
        const id = setInterval(() => setNowTick(Date.now()), 1000);
        return () => clearInterval(id);
    }, [activeWell?.startedAt]);

    const hasActive = Boolean(activeWell);

    // ---- Form helpers ----
    const openCreate = () => {
        setEditId(null);
        setForm(EMPTY_FORM);
        setFormOpen(true);
    };

    const openEdit = (well) => {
        setEditId(well.id);
        setForm({
            name: well.name || '', uwi: well.uwi || '', field: well.field || '',
            operator: well.operator || '', rig: well.rig || '', location: well.location || '',
            country: well.country || '', serviceType: well.serviceType || '',
            jobNo: well.jobNo || '', objective: well.objective || '',
            companyMan: well.companyMan || '', toolpusher: well.toolpusher || '',
            plannedTdM: well.plannedTdM ?? '', spudDate: well.spudDate || '',
        });
        setFormOpen(true);
    };

    const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

    const submitForm = async () => {
        if (!form.name.trim()) { showNote('Well name is required', 'error'); return; }
        const body = {
            name: form.name.trim(),
            uwi: form.uwi.trim(),
            field: form.field.trim(),
            operator: form.operator.trim(),
            rig: form.rig.trim(),
            location: form.location.trim(),
            country: form.country.trim(),
            serviceType: form.serviceType || undefined,
            jobNo: form.jobNo.trim(),
            objective: form.objective.trim(),
            companyMan: form.companyMan.trim(),
            toolpusher: form.toolpusher.trim(),
            plannedTdM: form.plannedTdM === '' ? undefined : Number(form.plannedTdM),
            spudDate: form.spudDate || undefined,
        };
        try {
            if (editId) {
                await axios.put(`/api/wells/${editId}`, body);
                showNote(`Well "${body.name}" updated`);
            } else {
                await axios.post('/api/wells', body);
                showNote(`Well "${body.name}" created`);
            }
            setFormOpen(false);
            refresh();
        } catch (err) {
            console.error('save well failed:', err);
            showNote(err.response?.data?.error || 'Failed to save well', 'error');
        }
    };

    const startWell = async (well) => {
        try {
            await axios.post(`/api/wells/${well.id}/start`);
            showNote(`Well "${well.name}" started`);
            refresh();
        } catch (err) {
            console.error('start well failed:', err);
            showNote(err.response?.data?.error || 'Failed to start well', 'error');
        }
    };

    const completeWell = async () => {
        const well = completeTarget;
        if (!well) return;
        try {
            await axios.post(`/api/wells/${well.id}/complete`);
            showNote(`Well "${well.name}" completed`);
            setCompleteTarget(null);
            refresh();
        } catch (err) {
            console.error('complete well failed:', err);
            showNote(err.response?.data?.error || 'Failed to complete well', 'error');
            setCompleteTarget(null);
        }
    };

    // Live elapsed string for active well.
    const liveElapsed = useMemo(() => {
        if (!activeWell?.startedAt) return null;
        // nowTick is a dependency so this recomputes every second.
        void nowTick;
        return formatDuration(secondsSince(activeWell.startedAt));
    }, [activeWell?.startedAt, nowTick]);

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Header */}
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap' }}>
                <Box>
                    <Typography variant="h6" sx={{ fontWeight: 'bold', color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1 }}>
                        <MapPin size={22} /> Well Management
                    </Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
                        Plan, start and complete wells — telemetry, reports and WITSML are scoped to the active well.
                    </Typography>
                </Box>
                {canWrite && (
                    <Button variant="contained" startIcon={<Plus size={18} />} onClick={openCreate}
                        sx={{ bgcolor: 'primary.main', color: theme.palette.primary.contrastText, textTransform: 'none', fontWeight: 'bold' }}>
                        New Well
                    </Button>
                )}
            </Box>

            {/* Active Well card */}
            <Paper sx={{ ...paperSx, p: 0, overflow: 'hidden' }}>
                {hasActive ? (
                    <Box>
                        <Box sx={{ p: 2.5, borderLeft: `4px solid ${STATUS_COLOR.active}` }}>
                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap' }}>
                                <Box sx={{ minWidth: 0 }}>
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                                        <Typography variant="h5" sx={{ fontWeight: 'bold', color: 'text.primary', lineHeight: 1.2 }}>
                                            {activeWell.name}
                                        </Typography>
                                        <StatusChip status="active" />
                                        {activeWell.serviceType && (
                                            <Chip label={activeWell.serviceType} size="small"
                                                sx={{ bgcolor: alpha(theme.palette.primary.main, 0.18), color: 'primary.main', fontWeight: 'bold', height: 22 }} />
                                        )}
                                    </Box>
                                    <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
                                        {[activeWell.jobNo && `Job/AFE ${activeWell.jobNo}`, activeWell.operator, activeWell.field]
                                            .filter(Boolean).join('  •  ') || '—'}
                                    </Typography>
                                </Box>
                                {canWrite && (
                                    <Button variant="contained" startIcon={<CheckCircle size={18} />} onClick={() => setCompleteTarget(activeWell)}
                                        sx={{ bgcolor: STATUS_COLOR.complete, color: '#fff', textTransform: 'none', fontWeight: 'bold', '&:hover': { bgcolor: '#2563eb' } }}>
                                        Complete Well
                                    </Button>
                                )}
                            </Box>

                            {/* Started / elapsed / TD / objective */}
                            <Grid container spacing={2} sx={{ mt: 1 }}>
                                <Grid item xs={6} sm={3}>
                                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                        <Clock size={13} /> Started
                                    </Typography>
                                    <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 'bold' }}>
                                        {formatTimestamp(activeWell.startedAt)}
                                    </Typography>
                                </Grid>
                                <Grid item xs={6} sm={3}>
                                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>Elapsed</Typography>
                                    <Typography variant="body2" sx={{ color: STATUS_COLOR.active, fontWeight: 'bold', fontVariantNumeric: 'tabular-nums' }}>
                                        {liveElapsed || '--'}
                                    </Typography>
                                </Grid>
                                <Grid item xs={6} sm={3}>
                                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                        <Ruler size={13} /> Planned TD
                                    </Typography>
                                    <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 'bold' }}>
                                        {activeWell.plannedTdM != null && activeWell.plannedTdM !== '' ? `${activeWell.plannedTdM} m` : '--'}
                                    </Typography>
                                </Grid>
                                <Grid item xs={6} sm={3}>
                                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>Started By</Typography>
                                    <Typography variant="body2" sx={{ color: 'text.primary', fontWeight: 'bold' }}>
                                        {activeWell.startedBy || '--'}
                                    </Typography>
                                </Grid>
                                {activeWell.objective && (
                                    <Grid item xs={12}>
                                        <Typography variant="caption" sx={{ color: 'text.secondary' }}>Objective</Typography>
                                        <Typography variant="body2" sx={{ color: 'text.primary' }}>{activeWell.objective}</Typography>
                                    </Grid>
                                )}
                            </Grid>
                        </Box>

                        {/* Live summary strip */}
                        <Divider sx={{ borderColor: theme.palette.divider }} />
                        <Box sx={{ px: 2.5, py: 2, bgcolor: alpha(theme.palette.primary.main, 0.04) }}>
                            <Grid container spacing={2}>
                                <SummaryStat icon={<Clock size={16} />} label="Duration" value={summary ? `${secToHours(summary.durationHrs != null ? summary.durationHrs * 3600 : summary.productiveSec + summary.nptSec)} h` : '--'} color={theme.palette.primary.main} />
                                <SummaryStat icon={<Layers size={16} />} label="Joints" value={summary?.joints ?? '--'} color={theme.palette.primary.main} />
                                <SummaryStat icon={<Activity size={16} />} label="Productive" value={summary ? `${secToHours(summary.productiveSec)} h` : '--'} color={STATUS_COLOR.active} />
                                <SummaryStat icon={<Activity size={16} />} label="NPT" value={summary ? `${secToHours(summary.nptSec)} h` : '--'} color="#f59e0b" />
                                <SummaryStat icon={<Ruler size={16} />} label="Depth Δ" value={summary?.depthProgress != null ? `${Number(summary.depthProgress).toFixed(1)} m` : '--'} color={STATUS_COLOR.complete}
                                    sub={summary && summary.depthStart != null && summary.depthEnd != null ? `${Number(summary.depthStart).toFixed(0)} → ${Number(summary.depthEnd).toFixed(0)} m` : undefined} />
                            </Grid>
                        </Box>
                    </Box>
                ) : (
                    <Box sx={{ p: 4, textAlign: 'center' }}>
                        <MapPin size={28} style={{ color: theme.palette.text.secondary, opacity: 0.6 }} />
                        <Typography variant="body1" sx={{ color: 'text.secondary', mt: 1 }}>
                            No active well — start one from the list below or create a new well.
                        </Typography>
                    </Box>
                )}
            </Paper>

            {/* Well History table */}
            <Paper sx={paperSx}>
                <Box sx={{ p: 2 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Target size={18} /> Well History
                    </Typography>
                </Box>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell sx={headSx}>Well</TableCell>
                                <TableCell sx={headSx}>Status</TableCell>
                                <TableCell sx={headSx}>Service</TableCell>
                                <TableCell sx={headSx}>Job No</TableCell>
                                <TableCell sx={headSx}>Started</TableCell>
                                <TableCell sx={headSx}>Completed</TableCell>
                                <TableCell sx={headSx} align="right">Duration (h)</TableCell>
                                <TableCell sx={headSx} align="right">Depth Δ (m)</TableCell>
                                <TableCell sx={headSx} align="right">Joints</TableCell>
                                {canWrite && <TableCell sx={headSx} align="right">Actions</TableCell>}
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {wells.map((w) => {
                                const s = w.summary || null;
                                const durationH = s?.durationHrs != null
                                    ? Number(s.durationHrs).toFixed(1)
                                    : (w.status === 'active' && w.startedAt ? (secondsSince(w.startedAt) / 3600).toFixed(1) : '--');
                                const depthDelta = s?.depthProgress != null ? Number(s.depthProgress).toFixed(1) : '--';
                                const joints = s?.joints ?? '--';
                                return (
                                    <TableRow key={w.id} hover>
                                        <TableCell sx={cellSx}>
                                            <Typography variant="body2" sx={{ fontWeight: 'bold', color: 'text.primary' }}>{w.name}</Typography>
                                            {w.uwi && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{w.uwi}</Typography>}
                                        </TableCell>
                                        <TableCell sx={cellSx}><StatusChip status={w.status} /></TableCell>
                                        <TableCell sx={cellSx}>{w.serviceType || '--'}</TableCell>
                                        <TableCell sx={cellSx}>{w.jobNo || '--'}</TableCell>
                                        <TableCell sx={cellSx}>{formatTimestamp(w.startedAt)}</TableCell>
                                        <TableCell sx={cellSx}>{formatTimestamp(w.completedAt)}</TableCell>
                                        <TableCell sx={cellSx} align="right">{durationH}</TableCell>
                                        <TableCell sx={cellSx} align="right">{depthDelta}</TableCell>
                                        <TableCell sx={cellSx} align="right">{joints}</TableCell>
                                        {canWrite && (
                                            <TableCell sx={cellSx} align="right">
                                                <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                                    {w.status === 'planned' && (
                                                        hasActive ? (
                                                            <Tooltip title="complete the active well first">
                                                                <span>
                                                                    <Button size="small" variant="outlined" disabled startIcon={<Play size={14} />}
                                                                        sx={{ textTransform: 'none', borderColor: theme.palette.divider }}>
                                                                        Start
                                                                    </Button>
                                                                </span>
                                                            </Tooltip>
                                                        ) : (
                                                            <Button size="small" variant="outlined" startIcon={<Play size={14} />} onClick={() => startWell(w)}
                                                                sx={{ color: STATUS_COLOR.active, borderColor: alpha(STATUS_COLOR.active, 0.5), textTransform: 'none' }}>
                                                                Start
                                                            </Button>
                                                        )
                                                    )}
                                                    {w.status === 'active' && (
                                                        <Button size="small" variant="outlined" startIcon={<CheckCircle size={14} />} onClick={() => setCompleteTarget(w)}
                                                            sx={{ color: STATUS_COLOR.complete, borderColor: alpha(STATUS_COLOR.complete, 0.5), textTransform: 'none' }}>
                                                            Complete
                                                        </Button>
                                                    )}
                                                    <Button size="small" variant="outlined" startIcon={<Edit2 size={14} />} onClick={() => openEdit(w)}
                                                        sx={{ color: 'primary.main', borderColor: theme.palette.divider, textTransform: 'none' }}>
                                                        Edit
                                                    </Button>
                                                </Box>
                                            </TableCell>
                                        )}
                                    </TableRow>
                                );
                            })}
                            {wells.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={canWrite ? 10 : 9} align="center" sx={{ color: 'text.secondary', py: 4, borderColor: alpha(theme.palette.divider, 0.6) }}>
                                        No wells yet. {canWrite ? 'Create one to get started.' : ''}
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* Report and archive tools for the wells above */}
            <Paper sx={{ ...paperSx, px: 1 }}>
                <Tabs
                    value={tab} onChange={(e, v) => setTab(v)} variant="scrollable" scrollButtons="auto"
                    sx={{ minHeight: 42, '& .MuiTab-root': { minHeight: 42, fontSize: 12.5, textTransform: 'none' } }}
                >
                    <Tab icon={<FileText size={15} />} iconPosition="start" label="Well Report" />
                    <Tab icon={<Database size={15} />} iconPosition="start" label="Data Export & Archive" />
                </Tabs>
            </Paper>
            <Box sx={{ mt: -1 }}>
                {tab === 0 && <WellReport wells={wells} />}
                {tab === 1 && <WellDataArchive wells={wells} />}
            </Box>

            {/* New / Edit Well dialog */}
            <Dialog open={formOpen} onClose={() => setFormOpen(false)} maxWidth="md" fullWidth
                PaperProps={{ sx: { bgcolor: 'background.paper', color: 'text.primary', backgroundImage: 'none' } }}>
                <DialogTitle sx={{ color: 'primary.main', fontWeight: 'bold' }}>
                    {editId ? 'Edit Well' : 'New Well'}
                </DialogTitle>
                <DialogContent>
                    <Grid container spacing={2} sx={{ mt: 0.5 }}>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Well name" required fullWidth size="small" autoFocus
                                value={form.name} onChange={setField('name')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="UWI / API" fullWidth size="small"
                                value={form.uwi} onChange={setField('uwi')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Field" fullWidth size="small"
                                value={form.field} onChange={setField('field')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Operator" fullWidth size="small"
                                value={form.operator} onChange={setField('operator')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Rig" fullWidth size="small"
                                value={form.rig} onChange={setField('rig')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Location (block / lat-long)" fullWidth size="small"
                                value={form.location} onChange={setField('location')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Country" fullWidth size="small"
                                value={form.country} onChange={setField('country')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <FormControl fullWidth size="small" sx={fieldSx}>
                                <InputLabel sx={{ color: 'text.secondary' }}>Service Type</InputLabel>
                                <Select label="Service Type" value={form.serviceType} onChange={setField('serviceType')}
                                    MenuProps={{ PaperProps: { sx: { bgcolor: 'background.paper', color: 'text.primary' } } }}>
                                    <MenuItem value=""><em>None</em></MenuItem>
                                    {serviceTypes.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Job / AFE No" fullWidth size="small"
                                value={form.jobNo} onChange={setField('jobNo')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Planned TD (m)" type="number" fullWidth size="small"
                                value={form.plannedTdM} onChange={setField('plannedTdM')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Company Man" fullWidth size="small"
                                value={form.companyMan} onChange={setField('companyMan')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Toolpusher" fullWidth size="small"
                                value={form.toolpusher} onChange={setField('toolpusher')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Spud Date" type="date" fullWidth size="small" InputLabelProps={{ shrink: true }}
                                value={form.spudDate} onChange={setField('spudDate')} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField label="Objective" fullWidth size="small" multiline minRows={2}
                                value={form.objective} onChange={setField('objective')} sx={fieldSx} />
                        </Grid>
                    </Grid>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setFormOpen(false)} sx={{ color: 'text.secondary' }}>Cancel</Button>
                    <Button onClick={submitForm} variant="contained"
                        sx={{ bgcolor: 'primary.main', color: theme.palette.primary.contrastText, '&:hover': { bgcolor: 'primary.dark' } }}>
                        {editId ? 'Save Changes' : 'Create Well'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Complete confirm */}
            <Dialog open={Boolean(completeTarget)} onClose={() => setCompleteTarget(null)}
                PaperProps={{ sx: { bgcolor: 'background.paper', color: 'text.primary', backgroundImage: 'none', minWidth: 380 } }}>
                <DialogTitle sx={{ fontWeight: 'bold' }}>Complete Well</DialogTitle>
                <DialogContent>
                    <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                        Complete <strong style={{ color: theme.palette.text.primary }}>{completeTarget?.name}</strong>? This logs the end time and finalizes its summary. Telemetry and reports will no longer be scoped to this well.
                    </Typography>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setCompleteTarget(null)} sx={{ color: 'text.secondary' }}>Cancel</Button>
                    <Button onClick={completeWell} variant="contained"
                        sx={{ bgcolor: STATUS_COLOR.complete, color: '#fff', '&:hover': { bgcolor: '#2563eb' } }}>
                        Complete Well
                    </Button>
                </DialogActions>
            </Dialog>

            <Snackbar open={notification.open} autoHideDuration={4000} onClose={() => setNotification((n) => ({ ...n, open: false }))}>
                <Alert severity={notification.severity} variant="filled" onClose={() => setNotification((n) => ({ ...n, open: false }))}>
                    {notification.message}
                </Alert>
            </Snackbar>
        </Box>
    );
}

function SummaryStat({ icon, label, value, color, sub }) {
    return (
        <Grid item xs={6} sm={4} md={2.4}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'flex', alignItems: 'center', gap: 0.5, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {icon} {label}
                </Typography>
                <Typography variant="h6" sx={{ color, fontWeight: 'bold', lineHeight: 1.2 }}>{value}</Typography>
                {sub && <Typography variant="caption" sx={{ color: 'text.secondary' }}>{sub}</Typography>}
            </Box>
        </Grid>
    );
}
