import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    Box, Typography, Paper, Table, TableBody, TableCell, TableContainer,
    TableHead, TableRow, TablePagination, Dialog, DialogTitle, DialogContent,
    DialogActions, Snackbar, Alert, Chip, MenuItem, FormControl, InputLabel,
    Select, TextField, Switch, IconButton, InputAdornment, Tooltip, Grid, Button
} from '@mui/material';
import { Cable, Search, Pencil, Plus, Trash2, FileCode } from 'lucide-react';
import axios from '../../api';
import { useAuth } from '../../context/AuthContext';

const headSx = { color: '#94a3b8', fontWeight: 'bold', borderColor: '#334155', whiteSpace: 'nowrap', bgcolor: 'background.paper' };
const cellSx = { color: 'text.primary', borderColor: '#1e293b' };
const monoSx = { fontFamily: 'monospace', fontSize: 13 };
const fieldSx = {
    bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' },
    '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' },
    '.MuiSvgIcon-root': { color: '#94a3b8' }, '.MuiSelect-select': { color: 'white' },
};

// Source-type -> chip color family.
// s7comm/modbus blue-ish, opcua/mqtt teal, derived purple, manual grey.
const SOURCE_COLOR = {
    s7comm: '#38bdf8',
    modbus: '#3b82f6',
    opcua: '#14b8a6',
    mqtt: '#2dd4bf',
    derived: '#a855f7',
    manual: '#94a3b8',
};

function sourceColor(t) { return SOURCE_COLOR[t] || '#64748b'; }

function SourceChip({ type }) {
    const c = sourceColor(type);
    return (
        <Chip label={type || '--'} size="small"
            sx={{ bgcolor: `${c}22`, color: c, fontWeight: 'bold', height: 22, border: `1px solid ${c}`, textTransform: 'none' }} />
    );
}

const KIND_OPTIONS = ['analog', 'status'];

// A blank "add variable" draft.
const EMPTY_ADD = {
    measurement: '', field: '', label: '', unit: '', kind: 'analog',
    sourceType: '', source: {}, scale: 1, offset: 0, enabled: true,
};

// Render the per-source-type config inputs dynamically from schemas[sourceType].fields.
// Each field is bound to source[field.key]; type drives text/number/select.
function SourceFields({ schema, source, onChange }) {
    const fields = schema?.fields || [];
    if (!fields.length) {
        return (
            <Grid item xs={12}>
                <Typography variant="caption" sx={{ color: '#64748b' }}>
                    {schema ? 'No connection config required for this source type.' : 'Select a source type to configure its connection.'}
                </Typography>
            </Grid>
        );
    }
    return (
        <>
            {fields.map((f) => {
                const val = source?.[f.key] ?? '';
                if (f.type === 'select') {
                    return (
                        <Grid item xs={12} sm={6} key={f.key}>
                            <FormControl fullWidth size="small" sx={fieldSx}>
                                <InputLabel sx={{ color: '#94a3b8' }}>{f.label}</InputLabel>
                                <Select label={f.label} value={val}
                                    onChange={(e) => onChange(f.key, e.target.value)}
                                    MenuProps={{ PaperProps: { sx: { bgcolor: '#1e293b', color: 'white' } } }}>
                                    {(f.options || []).map((o) => <MenuItem key={o} value={o}>{o}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Grid>
                    );
                }
                return (
                    <Grid item xs={12} sm={6} key={f.key}>
                        <TextField
                            label={f.label} fullWidth size="small"
                            type={f.type === 'number' ? 'number' : 'text'}
                            placeholder={f.placeholder || ''}
                            value={val}
                            onChange={(e) => onChange(f.key, e.target.value)}
                            sx={fieldSx}
                        />
                    </Grid>
                );
            })}
        </>
    );
}

export default function VariablesPage() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'admin';

    const [variables, setVariables] = useState([]);
    const [sourceTypes, setSourceTypes] = useState([]);      // string[] of type keys
    const [schemas, setSchemas] = useState({});              // { <type>: { label, fields:[...] } }
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [notification, setNotification] = useState({ open: false, message: '', severity: 'success' });

    // Filters.
    const [search, setSearch] = useState('');
    const [sourceFilter, setSourceFilter] = useState('all');
    const [measurementFilter, setMeasurementFilter] = useState('all');

    // Pagination (~150 rows -> default 25/page).
    const [page, setPage] = useState(0);
    const [rowsPerPage, setRowsPerPage] = useState(25);

    // Edit dialog.
    const [editing, setEditing] = useState(null); // the row being edited
    const [draft, setDraft] = useState(null);

    // Add dialog.
    const [addOpen, setAddOpen] = useState(false);
    const [addDraft, setAddDraft] = useState(EMPTY_ADD);

    // Collector-config dialog.
    const [cfgOpen, setCfgOpen] = useState(false);
    const [cfgLoading, setCfgLoading] = useState(false);
    const [collectorConfig, setCollectorConfig] = useState(null);

    const showNote = (message, severity = 'success') => setNotification({ open: true, message, severity });

    const load = useCallback(() => {
        setLoading(true);
        Promise.all([
            axios.get('/api/variables'),
            axios.get('/api/variables/source-types'),
        ])
            .then(([varsRes, typesRes]) => {
                setVariables(Array.isArray(varsRes.data) ? varsRes.data : []);
                const td = typesRes.data || {};
                setSourceTypes(Array.isArray(td.types) ? td.types : []);
                setSchemas(td.schemas && typeof td.schemas === 'object' ? td.schemas : {});
            })
            .catch((e) => {
                console.error('variables load failed:', e);
                showNote(e.response?.data?.error || 'Failed to load variables', 'error');
            })
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { load(); }, [load]);

    // Distinct measurements for the Measurement filter.
    const measurements = useMemo(() => {
        const set = new Set();
        variables.forEach((v) => { if (v.measurement) set.add(v.measurement); });
        return Array.from(set).sort();
    }, [variables]);

    // Counts by source type (over the full dataset, for the summary line).
    const sourceCounts = useMemo(() => {
        const counts = {};
        variables.forEach((v) => { counts[v.sourceType] = (counts[v.sourceType] || 0) + 1; });
        return counts;
    }, [variables]);

    // Apply filters.
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return variables.filter((v) => {
            if (sourceFilter !== 'all' && v.sourceType !== sourceFilter) return false;
            if (measurementFilter !== 'all' && v.measurement !== measurementFilter) return false;
            if (q) {
                const hay = `${v.id || ''} ${v.label || ''} ${v.sourceName || ''}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
    }, [variables, search, sourceFilter, measurementFilter]);

    // Reset to first page whenever filters change.
    useEffect(() => { setPage(0); }, [search, sourceFilter, measurementFilter]);

    const paged = useMemo(
        () => filtered.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage),
        [filtered, page, rowsPerPage]
    );

    // Strip display-only fields before sending a row back to the API.
    const toPayload = (v) => ({
        id: v.id, measurement: v.measurement, field: v.field, label: v.label, unit: v.unit,
        kind: v.kind, sourceType: v.sourceType, source: v.source || {},
        scale: v.scale, offset: v.offset, enabled: v.enabled,
    });

    // PUT the full (edited) array; server merges by id. Refresh from response.
    const persist = async (nextVariables, successMsg) => {
        setSaving(true);
        try {
            const { data } = await axios.put('/api/variables', nextVariables.map(toPayload));
            if (data && Array.isArray(data.variables)) {
                setVariables(data.variables);
            } else {
                setVariables(nextVariables);
            }
            showNote(successMsg);
            return true;
        } catch (err) {
            console.error('variables save failed:', err);
            showNote(err.response?.data?.error || 'Failed to save variables', 'error');
            return false;
        } finally {
            setSaving(false);
        }
    };

    // ---- Edit ----
    const openEdit = (row) => {
        setEditing(row);
        setDraft({
            label: row.label ?? '',
            unit: row.unit ?? '',
            kind: row.kind === 'status' ? 'status' : 'analog',
            sourceType: row.sourceType ?? '',
            source: { ...(row.source || {}) },
            scale: row.scale ?? 1,
            offset: row.offset ?? 0,
            enabled: !!row.enabled,
        });
    };

    const closeEdit = () => { setEditing(null); setDraft(null); };

    const setDraftSourceField = (key, value) =>
        setDraft((d) => ({ ...d, source: { ...d.source, [key]: value } }));

    // When the source type changes, keep any overlapping field keys but start fresh.
    const setDraftSourceType = (type) =>
        setDraft((d) => ({ ...d, sourceType: type, source: { ...d.source } }));

    const saveEdit = async () => {
        if (!editing || !draft) return;
        const next = variables.map((v) => v.id === editing.id ? {
            ...v,
            label: draft.label,
            unit: draft.unit,
            kind: draft.kind,
            sourceType: draft.sourceType,
            source: draft.source || {},
            scale: Number(draft.scale),
            offset: Number(draft.offset),
            enabled: !!draft.enabled,
        } : v);
        const ok = await persist(next, `Saved ${editing.id}`);
        if (ok) closeEdit();
    };

    // Inline enabled toggle (admin only) -> same PUT of the full array.
    const toggleEnabled = async (row) => {
        const next = variables.map((v) => v.id === row.id ? { ...v, enabled: !v.enabled } : v);
        await persist(next, `${row.id} ${!row.enabled ? 'enabled' : 'disabled'}`);
    };

    // ---- Add ----
    const openAdd = () => { setAddDraft(EMPTY_ADD); setAddOpen(true); };
    const closeAdd = () => setAddOpen(false);
    const setAddSourceField = (key, value) =>
        setAddDraft((d) => ({ ...d, source: { ...d.source, [key]: value } }));
    const setAddSourceType = (type) =>
        setAddDraft((d) => ({ ...d, sourceType: type, source: {} }));

    const newId = useMemo(() => {
        const m = addDraft.measurement.trim();
        const f = addDraft.field.trim();
        return m && f ? `${m}.${f}` : '';
    }, [addDraft.measurement, addDraft.field]);

    const saveAdd = async () => {
        const measurement = addDraft.measurement.trim();
        const field = addDraft.field.trim();
        if (!measurement || !field) { showNote('Measurement and field are required', 'error'); return; }
        if (!addDraft.sourceType) { showNote('Pick a source type', 'error'); return; }
        const body = {
            id: `${measurement}.${field}`,
            measurement, field,
            label: addDraft.label.trim() || field,
            unit: addDraft.unit.trim(),
            kind: addDraft.kind,
            sourceType: addDraft.sourceType,
            source: addDraft.source || {},
            scale: Number(addDraft.scale),
            offset: Number(addDraft.offset),
            enabled: !!addDraft.enabled,
        };
        setSaving(true);
        try {
            await axios.post('/api/variables', body);
            showNote(`Added ${body.id}`);
            setAddOpen(false);
            load();
        } catch (err) {
            console.error('add variable failed:', err);
            showNote(err.response?.data?.error || 'Failed to add variable', 'error');
        } finally {
            setSaving(false);
        }
    };

    // ---- Delete (custom variables only) ----
    const removeVariable = async (row) => {
        setSaving(true);
        try {
            await axios.delete(`/api/variables/${encodeURIComponent(row.id)}`);
            showNote(`Deleted ${row.id}`);
            load();
        } catch (err) {
            console.error('delete variable failed:', err);
            showNote(err.response?.data?.error || 'Failed to delete variable', 'error');
        } finally {
            setSaving(false);
        }
    };

    // ---- Collector config ----
    const openCollectorConfig = () => {
        setCfgOpen(true);
        setCfgLoading(true);
        setCollectorConfig(null);
        axios.get('/api/variables/collector-config')
            .then((r) => setCollectorConfig(r.data))
            .catch((e) => {
                console.error('collector config load failed:', e);
                showNote(e.response?.data?.error || 'Failed to load collector config', 'error');
            })
            .finally(() => setCfgLoading(false));
    };

    const colCount = isAdmin ? 12 : 10;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* Header */}
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap' }}>
                <Box>
                    <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Cable size={22} /> Variables Mapping
                    </Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
                        Protocol-aware source map (S7 / Modbus / OPC-UA / MQTT / derived) &mdash; monitoring only, no control write-back.
                    </Typography>
                </Box>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    <Button size="small" variant="outlined" startIcon={<FileCode size={16} />} onClick={openCollectorConfig}
                        sx={{ color: '#38bdf8', borderColor: '#334155', textTransform: 'none' }}>
                        View Collector Config
                    </Button>
                    {isAdmin && (
                        <Button size="small" variant="contained" startIcon={<Plus size={16} />} onClick={openAdd}
                            sx={{ bgcolor: '#38bdf8', color: '#0f172a', textTransform: 'none', '&:hover': { bgcolor: '#0ea5e9' } }}>
                            Add Variable
                        </Button>
                    )}
                </Box>
            </Box>

            {/* Toolbar / filters */}
            <Paper sx={{ p: 2, bgcolor: 'background.paper', border: '1px solid #334155' }}>
                <Grid container spacing={2} alignItems="center">
                    <Grid item xs={12} md={5}>
                        <TextField
                            fullWidth size="small" placeholder="Search id, label or source tag…"
                            value={search} onChange={(e) => setSearch(e.target.value)} sx={fieldSx}
                            InputProps={{
                                startAdornment: (
                                    <InputAdornment position="start">
                                        <Search size={16} color="#94a3b8" />
                                    </InputAdornment>
                                ),
                            }}
                        />
                    </Grid>
                    <Grid item xs={6} md={3}>
                        <FormControl fullWidth size="small" sx={fieldSx}>
                            <InputLabel sx={{ color: '#94a3b8' }}>Source Type</InputLabel>
                            <Select label="Source Type" value={sourceFilter}
                                onChange={(e) => setSourceFilter(e.target.value)}
                                MenuProps={{ PaperProps: { sx: { bgcolor: '#1e293b', color: 'white' } } }}>
                                <MenuItem value="all">All</MenuItem>
                                {sourceTypes.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                            </Select>
                        </FormControl>
                    </Grid>
                    <Grid item xs={6} md={4}>
                        <FormControl fullWidth size="small" sx={fieldSx}>
                            <InputLabel sx={{ color: '#94a3b8' }}>Measurement</InputLabel>
                            <Select label="Measurement" value={measurementFilter}
                                onChange={(e) => setMeasurementFilter(e.target.value)}
                                MenuProps={{ PaperProps: { sx: { bgcolor: '#1e293b', color: 'white', maxHeight: 400 } } }}>
                                <MenuItem value="all">All</MenuItem>
                                {measurements.map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
                            </Select>
                        </FormControl>
                    </Grid>
                </Grid>

                {/* Summary line */}
                <Box sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                        Showing <strong>{filtered.length}</strong> of <strong>{variables.length}</strong> variables
                    </Typography>
                    {sourceTypes.map((t) => (
                        <Chip key={t} size="small" label={`${t}: ${sourceCounts[t] || 0}`}
                            sx={{ height: 20, fontSize: 11, bgcolor: `${sourceColor(t)}22`, color: sourceColor(t), fontWeight: 'bold' }} />
                    ))}
                    {!isAdmin && (
                        <Typography variant="caption" sx={{ color: '#f59e0b', ml: 'auto' }}>
                            read-only (admin to edit)
                        </Typography>
                    )}
                </Box>
            </Paper>

            {/* Table */}
            <Paper sx={{ bgcolor: 'background.paper', border: '1px solid #334155' }}>
                <TableContainer>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell sx={headSx}>Variable</TableCell>
                                <TableCell sx={headSx}>Label</TableCell>
                                <TableCell sx={headSx}>Source Type</TableCell>
                                <TableCell sx={headSx}>Source Tag</TableCell>
                                <TableCell sx={headSx}>Address</TableCell>
                                <TableCell sx={headSx}>Unit</TableCell>
                                <TableCell sx={headSx}>Kind</TableCell>
                                <TableCell sx={headSx} align="right">Scale</TableCell>
                                <TableCell sx={headSx} align="right">Offset</TableCell>
                                <TableCell sx={headSx} align="center">Enabled</TableCell>
                                {isAdmin && <TableCell sx={headSx} align="center">Edit</TableCell>}
                                {isAdmin && <TableCell sx={headSx} align="center">Delete</TableCell>}
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {paged.map((v) => (
                                <TableRow key={v.id} hover>
                                    <TableCell sx={{ ...cellSx, ...monoSx }}>{v.measurement}.{v.field}</TableCell>
                                    <TableCell sx={cellSx}>{v.label}</TableCell>
                                    <TableCell sx={cellSx}><SourceChip type={v.sourceType} /></TableCell>
                                    <TableCell sx={cellSx}>{v.sourceName || '—'}</TableCell>
                                    <TableCell sx={{ ...cellSx, ...monoSx }}>{v.address == null || v.address === '' ? '—' : v.address}</TableCell>
                                    <TableCell sx={cellSx}>{v.unit || '—'}</TableCell>
                                    <TableCell sx={cellSx}>{v.kind}</TableCell>
                                    <TableCell sx={cellSx} align="right">{v.scale}</TableCell>
                                    <TableCell sx={cellSx} align="right">{v.offset}</TableCell>
                                    <TableCell sx={cellSx} align="center">
                                        <Switch
                                            checked={!!v.enabled}
                                            disabled={!isAdmin || saving}
                                            size="small"
                                            onChange={() => toggleEnabled(v)}
                                        />
                                    </TableCell>
                                    {isAdmin && (
                                        <TableCell sx={cellSx} align="center">
                                            <Tooltip title="Edit variable">
                                                <span>
                                                    <IconButton size="small" onClick={() => openEdit(v)} sx={{ color: '#38bdf8' }}>
                                                        <Pencil size={16} />
                                                    </IconButton>
                                                </span>
                                            </Tooltip>
                                        </TableCell>
                                    )}
                                    {isAdmin && (
                                        <TableCell sx={cellSx} align="center">
                                            {v.custom ? (
                                                <Tooltip title="Delete variable">
                                                    <span>
                                                        <IconButton size="small" disabled={saving} onClick={() => removeVariable(v)} sx={{ color: '#f87171' }}>
                                                            <Trash2 size={16} />
                                                        </IconButton>
                                                    </span>
                                                </Tooltip>
                                            ) : (
                                                <Tooltip title="Built-in variable — disable instead of deleting">
                                                    <span>
                                                        <IconButton size="small" disabled sx={{ color: '#334155' }}>
                                                            <Trash2 size={16} />
                                                        </IconButton>
                                                    </span>
                                                </Tooltip>
                                            )}
                                        </TableCell>
                                    )}
                                </TableRow>
                            ))}
                            {!loading && filtered.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={colCount} align="center" sx={{ color: '#94a3b8', py: 4, borderColor: '#1e293b' }}>
                                        No variables match the current filters.
                                    </TableCell>
                                </TableRow>
                            )}
                            {loading && (
                                <TableRow>
                                    <TableCell colSpan={colCount} align="center" sx={{ color: '#94a3b8', py: 4, borderColor: '#1e293b' }}>
                                        Loading variables…
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
                <TablePagination
                    component="div"
                    count={filtered.length}
                    page={page}
                    onPageChange={(_, p) => setPage(p)}
                    rowsPerPage={rowsPerPage}
                    onRowsPerPageChange={(e) => { setRowsPerPage(parseInt(e.target.value, 10)); setPage(0); }}
                    rowsPerPageOptions={[25, 50, 100]}
                    sx={{ color: 'text.primary', borderTop: '1px solid #334155', '.MuiSvgIcon-root': { color: '#94a3b8' } }}
                />
            </Paper>

            {/* Edit dialog (admin only) */}
            <Dialog open={Boolean(editing)} onClose={closeEdit} maxWidth="sm" fullWidth
                PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white' } }}>
                <DialogTitle>Edit Variable{editing ? ` — ${editing.measurement}.${editing.field}` : ''}</DialogTitle>
                <DialogContent>
                    <Typography variant="caption" sx={{ color: '#64748b', display: 'block', mb: 1.5, fontFamily: 'monospace' }}>
                        id: {editing?.id}
                    </Typography>
                    {draft && (
                        <Grid container spacing={2} sx={{ mt: 0.25 }}>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Measurement" fullWidth size="small" value={editing?.measurement ?? ''}
                                    InputProps={{ readOnly: true }} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Field" fullWidth size="small" value={editing?.field ?? ''}
                                    InputProps={{ readOnly: true }} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12}>
                                <TextField label="Label" fullWidth size="small" value={draft.label}
                                    onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={4}>
                                <TextField label="Unit" fullWidth size="small" value={draft.unit}
                                    onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={4}>
                                <FormControl fullWidth size="small" sx={fieldSx}>
                                    <InputLabel sx={{ color: '#94a3b8' }}>Kind</InputLabel>
                                    <Select label="Kind" value={draft.kind}
                                        onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
                                        MenuProps={{ PaperProps: { sx: { bgcolor: '#1e293b', color: 'white' } } }}>
                                        {KIND_OPTIONS.map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}
                                    </Select>
                                </FormControl>
                            </Grid>
                            <Grid item xs={12} sm={4}>
                                <FormControl fullWidth size="small" sx={fieldSx}>
                                    <InputLabel sx={{ color: '#94a3b8' }}>Source Type</InputLabel>
                                    <Select label="Source Type" value={draft.sourceType}
                                        onChange={(e) => setDraftSourceType(e.target.value)}
                                        MenuProps={{ PaperProps: { sx: { bgcolor: '#1e293b', color: 'white' } } }}>
                                        {sourceTypes.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                                    </Select>
                                </FormControl>
                            </Grid>

                            {/* Per-source connection config, rendered from schemas[sourceType].fields */}
                            <Grid item xs={12}>
                                <Typography variant="caption" sx={{ color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1 }}>
                                    {schemas[draft.sourceType]?.label || 'Source'} configuration
                                </Typography>
                            </Grid>
                            <SourceFields schema={schemas[draft.sourceType]} source={draft.source} onChange={setDraftSourceField} />

                            <Grid item xs={12} sm={6}>
                                <TextField label="Scale" type="number" fullWidth size="small" value={draft.scale}
                                    onChange={(e) => setDraft((d) => ({ ...d, scale: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12} sm={6}>
                                <TextField label="Offset" type="number" fullWidth size="small" value={draft.offset}
                                    onChange={(e) => setDraft((d) => ({ ...d, offset: e.target.value }))} sx={fieldSx} />
                            </Grid>
                            <Grid item xs={12}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                    <Switch checked={!!draft.enabled}
                                        onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))} />
                                    <Typography variant="body2" sx={{ color: '#94a3b8' }}>Enabled</Typography>
                                </Box>
                            </Grid>
                        </Grid>
                    )}
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={closeEdit} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button onClick={saveEdit} variant="contained" disabled={saving}
                        sx={{ bgcolor: '#38bdf8', color: '#0f172a', '&:hover': { bgcolor: '#0ea5e9' } }}>
                        {saving ? 'Saving…' : 'Save'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Add dialog (admin only) */}
            <Dialog open={addOpen} onClose={closeAdd} maxWidth="sm" fullWidth
                PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white' } }}>
                <DialogTitle>Add Variable</DialogTitle>
                <DialogContent>
                    <Typography variant="caption" sx={{ color: '#64748b', display: 'block', mb: 1.5, fontFamily: 'monospace' }}>
                        id: {newId || '<measurement>.<field>'}
                    </Typography>
                    <Grid container spacing={2} sx={{ mt: 0.25 }}>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Measurement" fullWidth size="small" value={addDraft.measurement}
                                onChange={(e) => setAddDraft((d) => ({ ...d, measurement: e.target.value }))} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Field" fullWidth size="small" value={addDraft.field}
                                onChange={(e) => setAddDraft((d) => ({ ...d, field: e.target.value }))} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField label="Label" fullWidth size="small" value={addDraft.label}
                                onChange={(e) => setAddDraft((d) => ({ ...d, label: e.target.value }))} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={4}>
                            <TextField label="Unit" fullWidth size="small" value={addDraft.unit}
                                onChange={(e) => setAddDraft((d) => ({ ...d, unit: e.target.value }))} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={4}>
                            <FormControl fullWidth size="small" sx={fieldSx}>
                                <InputLabel sx={{ color: '#94a3b8' }}>Kind</InputLabel>
                                <Select label="Kind" value={addDraft.kind}
                                    onChange={(e) => setAddDraft((d) => ({ ...d, kind: e.target.value }))}
                                    MenuProps={{ PaperProps: { sx: { bgcolor: '#1e293b', color: 'white' } } }}>
                                    {KIND_OPTIONS.map((k) => <MenuItem key={k} value={k}>{k}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Grid>
                        <Grid item xs={12} sm={4}>
                            <FormControl fullWidth size="small" sx={fieldSx}>
                                <InputLabel sx={{ color: '#94a3b8' }}>Source Type</InputLabel>
                                <Select label="Source Type" value={addDraft.sourceType}
                                    onChange={(e) => setAddSourceType(e.target.value)}
                                    MenuProps={{ PaperProps: { sx: { bgcolor: '#1e293b', color: 'white' } } }}>
                                    {sourceTypes.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Grid>

                        {/* Per-source connection config, rendered from schemas[sourceType].fields */}
                        <Grid item xs={12}>
                            <Typography variant="caption" sx={{ color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1 }}>
                                {schemas[addDraft.sourceType]?.label || 'Source'} configuration
                            </Typography>
                        </Grid>
                        <SourceFields schema={schemas[addDraft.sourceType]} source={addDraft.source} onChange={setAddSourceField} />

                        <Grid item xs={12} sm={6}>
                            <TextField label="Scale" type="number" fullWidth size="small" value={addDraft.scale}
                                onChange={(e) => setAddDraft((d) => ({ ...d, scale: e.target.value }))} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField label="Offset" type="number" fullWidth size="small" value={addDraft.offset}
                                onChange={(e) => setAddDraft((d) => ({ ...d, offset: e.target.value }))} sx={fieldSx} />
                        </Grid>
                        <Grid item xs={12}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                <Switch checked={!!addDraft.enabled}
                                    onChange={(e) => setAddDraft((d) => ({ ...d, enabled: e.target.checked }))} />
                                <Typography variant="body2" sx={{ color: '#94a3b8' }}>Enabled</Typography>
                            </Box>
                        </Grid>
                    </Grid>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={closeAdd} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button onClick={saveAdd} variant="contained" disabled={saving}
                        sx={{ bgcolor: '#38bdf8', color: '#0f172a', '&:hover': { bgcolor: '#0ea5e9' } }}>
                        {saving ? 'Adding…' : 'Add'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Collector config dialog (all roles) */}
            <Dialog open={cfgOpen} onClose={() => setCfgOpen(false)} maxWidth="md" fullWidth
                PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white' } }}>
                <DialogTitle>Collector Config (Telegraf input preview)</DialogTitle>
                <DialogContent>
                    <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mb: 1.5 }}>
                        Generated Telegraf input configuration for the enabled pollable sources (preview).
                        S7comm is applied via the PLC Config screen; derived/manual sources need no collector.
                    </Typography>
                    {cfgLoading && (
                        <Typography variant="body2" sx={{ color: '#94a3b8' }}>Loading collector config…</Typography>
                    )}
                    {!cfgLoading && collectorConfig && (
                        <>
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
                                {Object.entries(collectorConfig.counts || {}).map(([t, n]) => (
                                    <Chip key={t} size="small" label={`${t}: ${n}`}
                                        sx={{ height: 22, fontSize: 12, bgcolor: `${sourceColor(t)}22`, color: sourceColor(t), fontWeight: 'bold', border: `1px solid ${sourceColor(t)}` }} />
                                ))}
                            </Box>
                            <Box
                                component="pre"
                                sx={{
                                    m: 0, p: 1.5, bgcolor: '#0f172a', color: '#e2e8f0',
                                    border: '1px solid #334155', borderRadius: 1,
                                    fontFamily: 'monospace', fontSize: 12.5, lineHeight: 1.5,
                                    maxHeight: 420, overflow: 'auto', whiteSpace: 'pre',
                                }}
                            >
                                {collectorConfig.toml || '# (empty)'}
                            </Box>
                        </>
                    )}
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setCfgOpen(false)} sx={{ color: '#94a3b8' }}>Close</Button>
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
