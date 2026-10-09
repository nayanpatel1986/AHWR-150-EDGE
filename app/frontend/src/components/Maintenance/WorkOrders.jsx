import React, { useState, useEffect, useCallback } from 'react';
import {
    Box, Paper, Typography, Button, Table, TableBody, TableCell, TableContainer, TableHead,
    TableRow, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
    Select, FormControl, InputLabel, IconButton, Tooltip, Collapse, useTheme
} from '@mui/material';
import { Plus, Wrench, ChevronDown, ChevronRight } from 'lucide-react';
import axios from '../../api';

// Work-order register: preventive, breakdown (corrective), overhaul and
// inspection jobs in one list, with the full OPEN -> COMPLETED lifecycle,
// labour hours, spares consumed and failure analysis.

const STATUS_COLOR = {
    OPEN: '#38bdf8', IN_PROGRESS: '#f59e0b', ON_HOLD: '#a78bfa',
    COMPLETED: '#4ade80', CANCELLED: '#64748b',
};
const TYPE_COLOR = {
    PREVENTIVE: '#4ade80', BREAKDOWN: '#ef4444', OVERHAUL: '#a78bfa', INSPECTION: '#38bdf8',
};
const PRIORITY_COLOR = { P1: '#ef4444', P2: '#f59e0b', P3: '#eab308' };

const fmtTs = (ts) => {
    if (!ts) return '--';
    const d = new Date(ts);
    return isNaN(d) ? '--' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
};

export default function WorkOrders({ meta, canWrite, onChanged, showNote }) {
    const theme = useTheme();
    const [rows, setRows] = useState([]);
    const [filter, setFilter] = useState({ status: '', type: '' });
    const [expanded, setExpanded] = useState(null);
    const [createOpen, setCreateOpen] = useState(false);
    const [draft, setDraft] = useState({ type: 'BREAKDOWN', assetId: '', title: '', description: '', priority: 'P2', failureCode: 'UNKNOWN', assignedTo: '' });
    const [edit, setEdit] = useState(null);

    const headSx = { color: theme.palette.text.secondary, fontWeight: 'bold', borderColor: theme.palette.divider, whiteSpace: 'nowrap', fontSize: 12 };
    const cellSx = { color: theme.palette.text.primary, borderColor: theme.palette.divider, fontSize: 13 };

    const load = useCallback(() => {
        const p = new URLSearchParams();
        if (filter.status) p.set('status', filter.status);
        if (filter.type) p.set('type', filter.type);
        axios.get(`/api/cmms/work-orders?${p.toString()}`)
            .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
            .catch((e) => console.error('work orders load failed', e));
    }, [filter.status, filter.type]);
    useEffect(() => { load(); }, [load]);

    const create = async () => {
        try {
            await axios.post('/api/cmms/work-orders', draft);
            setCreateOpen(false);
            setDraft({ type: 'BREAKDOWN', assetId: '', title: '', description: '', priority: 'P2', failureCode: 'UNKNOWN', assignedTo: '' });
            load(); onChanged?.();
            showNote?.('Work order raised', 'success');
        } catch (e) { showNote?.(e.response?.data?.error || 'Could not raise work order', 'error'); }
    };

    const patch = async (id, body) => {
        try {
            await axios.patch(`/api/cmms/work-orders/${id}`, body);
            load(); onChanged?.();
        } catch (e) { showNote?.(e.response?.data?.error || 'Update failed', 'error'); }
    };

    const saveEdit = async () => {
        if (!edit) return;
        const spares = String(edit.sparesText || '')
            .split('\n').map((l) => l.trim()).filter(Boolean)
            .map((l) => { const m = l.match(/^(.*?)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?$/i); return { part: (m?.[1] || l).trim(), qty: Number(m?.[2] || 1), uom: 'ea' }; });
        await patch(edit.id, {
            status: edit.status, priority: edit.priority, assignedTo: edit.assignedTo,
            resolution: edit.resolution, labourHours: edit.labourHours, downtimeMin: edit.downtimeMin,
            failureCode: edit.failureCode || null, spares,
        });
        setEdit(null);
    };

    const sel = { minWidth: 128 };

    return (
        <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 2, flexWrap: 'wrap' }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Wrench size={18} /> Work Orders ({rows.length})
                </Typography>
                <Box sx={{ flexGrow: 1 }} />
                <FormControl size="small" sx={sel}>
                    <InputLabel>Type</InputLabel>
                    <Select label="Type" value={filter.type} onChange={(e) => setFilter((f) => ({ ...f, type: e.target.value }))}>
                        <MenuItem value="">All types</MenuItem>
                        {(meta.woTypes || []).map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                    </Select>
                </FormControl>
                <FormControl size="small" sx={sel}>
                    <InputLabel>Status</InputLabel>
                    <Select label="Status" value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}>
                        <MenuItem value="">All statuses</MenuItem>
                        {(meta.woStatus || []).map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
                    </Select>
                </FormControl>
                {canWrite && (
                    <Button variant="contained" size="small" startIcon={<Plus size={16} />} onClick={() => setCreateOpen(true)} sx={{ textTransform: 'none', fontWeight: 'bold' }}>
                        Raise WO
                    </Button>
                )}
            </Box>

            <TableContainer>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell sx={headSx} />
                            <TableCell sx={headSx}>WO No.</TableCell>
                            <TableCell sx={headSx}>Type</TableCell>
                            <TableCell sx={headSx}>Asset</TableCell>
                            <TableCell sx={headSx}>Title</TableCell>
                            <TableCell sx={headSx}>Pri</TableCell>
                            <TableCell sx={headSx}>Status</TableCell>
                            <TableCell sx={headSx}>Raised</TableCell>
                            <TableCell sx={headSx}>Assigned</TableCell>
                            {canWrite && <TableCell sx={headSx} align="right">Action</TableCell>}
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map((w) => (
                            <React.Fragment key={w.id}>
                                <TableRow hover>
                                    <TableCell sx={{ ...cellSx, width: 34 }}>
                                        <IconButton size="small" onClick={() => setExpanded(expanded === w.id ? null : w.id)} sx={{ color: theme.palette.text.secondary }}>
                                            {expanded === w.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                                        </IconButton>
                                    </TableCell>
                                    <TableCell sx={{ ...cellSx, fontFamily: 'monospace', fontWeight: 700 }}>{w.no}</TableCell>
                                    <TableCell sx={cellSx}>
                                        <Chip label={w.type} size="small" sx={{ height: 20, fontSize: 10, fontWeight: 800, bgcolor: `${TYPE_COLOR[w.type]}22`, color: TYPE_COLOR[w.type] }} />
                                    </TableCell>
                                    <TableCell sx={cellSx}>{w.assetName}</TableCell>
                                    <TableCell sx={cellSx}>{w.title}</TableCell>
                                    <TableCell sx={{ ...cellSx, color: PRIORITY_COLOR[w.priority], fontWeight: 800 }}>{w.priority}</TableCell>
                                    <TableCell sx={cellSx}>
                                        <Chip label={w.status.replace('_', ' ')} size="small" sx={{ height: 20, fontSize: 10, fontWeight: 800, bgcolor: `${STATUS_COLOR[w.status]}22`, color: STATUS_COLOR[w.status] }} />
                                    </TableCell>
                                    <TableCell sx={{ ...cellSx, whiteSpace: 'nowrap' }}>{fmtTs(w.raisedAt)}</TableCell>
                                    <TableCell sx={cellSx}>{w.assignedTo || '--'}</TableCell>
                                    {canWrite && (
                                        <TableCell sx={cellSx} align="right">
                                            <Button size="small" onClick={() => setEdit({ ...w, sparesText: (w.spares || []).map((s) => `${s.part} x${s.qty}`).join('\n') })} sx={{ textTransform: 'none' }}>
                                                Update
                                            </Button>
                                        </TableCell>
                                    )}
                                </TableRow>
                                <TableRow>
                                    <TableCell sx={{ p: 0, borderBottom: expanded === w.id ? `1px solid ${theme.palette.divider}` : 'none' }} colSpan={canWrite ? 10 : 9}>
                                        <Collapse in={expanded === w.id} unmountOnExit>
                                            <Box sx={{ px: 3, py: 2, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '2fr 1fr' }, gap: 2 }}>
                                                <Box>
                                                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontWeight: 700 }}>DESCRIPTION</Typography>
                                                    <Typography variant="body2" sx={{ mb: 1.5 }}>{w.description || '--'}</Typography>
                                                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontWeight: 700 }}>RESOLUTION</Typography>
                                                    <Typography variant="body2">{w.resolution || '--'}</Typography>
                                                </Box>
                                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
                                                    {[
                                                        ['Failure code', w.failureCode || '--'],
                                                        ['Labour hours', w.labourHours ?? 0],
                                                        ['Downtime (min)', w.downtimeMin ?? 0],
                                                        ['Started', fmtTs(w.startedAt)],
                                                        ['Completed', fmtTs(w.completedAt)],
                                                        ['Spares', (w.spares || []).length ? (w.spares || []).map((s) => `${s.part} ×${s.qty}`).join(', ') : '--'],
                                                    ].map(([k, v]) => (
                                                        <Box key={k} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                                                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>{k}</Typography>
                                                            <Typography variant="caption" sx={{ fontWeight: 700, textAlign: 'right' }}>{String(v)}</Typography>
                                                        </Box>
                                                    ))}
                                                </Box>
                                            </Box>
                                        </Collapse>
                                    </TableCell>
                                </TableRow>
                            </React.Fragment>
                        ))}
                        {rows.length === 0 && (
                            <TableRow><TableCell colSpan={canWrite ? 10 : 9} align="center" sx={{ py: 4, color: theme.palette.text.secondary, borderColor: theme.palette.divider }}>
                                No work orders match this filter.
                            </TableCell></TableRow>
                        )}
                    </TableBody>
                </Table>
            </TableContainer>

            {/* Raise */}
            <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
                <DialogTitle sx={{ fontWeight: 'bold' }}>Raise Work Order</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <FormControl fullWidth size="small">
                                <InputLabel>Type</InputLabel>
                                <Select label="Type" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                                    {(meta.woTypes || []).map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
                                </Select>
                            </FormControl>
                            <FormControl fullWidth size="small">
                                <InputLabel>Priority</InputLabel>
                                <Select label="Priority" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>
                                    {(meta.woPriority || []).map((p) => <MenuItem key={p} value={p}>{p}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Box>
                        <FormControl fullWidth size="small">
                            <InputLabel>Asset</InputLabel>
                            <Select label="Asset" value={draft.assetId} onChange={(e) => setDraft({ ...draft, assetId: e.target.value })}>
                                <MenuItem value="">(none)</MenuItem>
                                {(meta.assets || []).map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
                            </Select>
                        </FormControl>
                        <TextField label="Title" size="small" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus />
                        <TextField label="Description" size="small" multiline rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                        {draft.type === 'BREAKDOWN' && (
                            <FormControl fullWidth size="small">
                                <InputLabel>Failure code</InputLabel>
                                <Select label="Failure code" value={draft.failureCode} onChange={(e) => setDraft({ ...draft, failureCode: e.target.value })}>
                                    {(meta.failureCodes || []).map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
                                </Select>
                            </FormControl>
                        )}
                        <TextField label="Assign to" size="small" value={draft.assignedTo} onChange={(e) => setDraft({ ...draft, assignedTo: e.target.value })} />
                    </Box>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setCreateOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
                    <Button variant="contained" onClick={create} disabled={!draft.title.trim()} sx={{ textTransform: 'none', fontWeight: 'bold' }}>Raise</Button>
                </DialogActions>
            </Dialog>

            {/* Update */}
            <Dialog open={!!edit} onClose={() => setEdit(null)} maxWidth="sm" fullWidth>
                <DialogTitle sx={{ fontWeight: 'bold' }}>{edit?.no} · {edit?.title}</DialogTitle>
                <DialogContent>
                    {edit && (
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                            <Box sx={{ display: 'flex', gap: 2 }}>
                                <FormControl fullWidth size="small">
                                    <InputLabel>Status</InputLabel>
                                    <Select label="Status" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>
                                        {(meta.woStatus || []).map((s) => <MenuItem key={s} value={s}>{s.replace('_', ' ')}</MenuItem>)}
                                    </Select>
                                </FormControl>
                                <FormControl fullWidth size="small">
                                    <InputLabel>Priority</InputLabel>
                                    <Select label="Priority" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })}>
                                        {(meta.woPriority || []).map((p) => <MenuItem key={p} value={p}>{p}</MenuItem>)}
                                    </Select>
                                </FormControl>
                            </Box>
                            <Box sx={{ display: 'flex', gap: 2 }}>
                                <TextField label="Labour hours" type="number" size="small" fullWidth value={edit.labourHours ?? 0} onChange={(e) => setEdit({ ...edit, labourHours: e.target.value })} />
                                <TextField label="Downtime (min)" type="number" size="small" fullWidth value={edit.downtimeMin ?? 0} onChange={(e) => setEdit({ ...edit, downtimeMin: e.target.value })} />
                            </Box>
                            <FormControl fullWidth size="small">
                                <InputLabel>Failure code</InputLabel>
                                <Select label="Failure code" value={edit.failureCode || ''} onChange={(e) => setEdit({ ...edit, failureCode: e.target.value })}>
                                    <MenuItem value="">(none)</MenuItem>
                                    {(meta.failureCodes || []).map((f) => <MenuItem key={f} value={f}>{f}</MenuItem>)}
                                </Select>
                            </FormControl>
                            <TextField label="Assigned to" size="small" value={edit.assignedTo || ''} onChange={(e) => setEdit({ ...edit, assignedTo: e.target.value })} />
                            <TextField label="Spares used (one per line, e.g. “Liner 6in x1”)" size="small" multiline rows={3}
                                value={edit.sparesText || ''} onChange={(e) => setEdit({ ...edit, sparesText: e.target.value })} />
                            <TextField label="Resolution / work done" size="small" multiline rows={3} value={edit.resolution || ''} onChange={(e) => setEdit({ ...edit, resolution: e.target.value })} />
                        </Box>
                    )}
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setEdit(null)} sx={{ textTransform: 'none' }}>Cancel</Button>
                    <Button variant="contained" onClick={saveEdit} sx={{ textTransform: 'none', fontWeight: 'bold' }}>Save</Button>
                </DialogActions>
            </Dialog>
        </Paper>
    );
}
