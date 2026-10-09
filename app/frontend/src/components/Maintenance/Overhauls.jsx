import React, { useState, useEffect, useCallback } from 'react';
import {
    Box, Paper, Typography, Button, TextField, MenuItem, Select, FormControl, InputLabel,
    Chip, Dialog, DialogTitle, DialogContent, DialogActions, LinearProgress, Checkbox,
    FormControlLabel, Divider, useTheme
} from '@mui/material';
import { Hammer, Plus } from 'lucide-react';
import axios from '../../api';

// Major overhaul campaigns — long-running jobs (engine top-end, drawworks
// rebuild, mast recertification) tracked with planned vs actual dates and
// milestone progress, rather than as a single work order.

const STATUS_COLOR = {
    PLANNED: '#38bdf8', IN_PROGRESS: '#f59e0b', ON_HOLD: '#a78bfa',
    COMPLETED: '#4ade80', CANCELLED: '#64748b',
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '--');

export default function Overhauls({ meta, canWrite, onChanged, showNote }) {
    const theme = useTheme();
    const [rows, setRows] = useState([]);
    const [createOpen, setCreateOpen] = useState(false);
    const [draft, setDraft] = useState({ assetId: '', title: '', scope: '', plannedStart: '', plannedEnd: '', atHours: '', contractor: '' });

    const load = useCallback(() => {
        axios.get('/api/cmms/overhauls')
            .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
            .catch((e) => console.error('overhauls load failed', e));
    }, []);
    useEffect(() => { load(); }, [load]);

    const create = async () => {
        try {
            await axios.post('/api/cmms/overhauls', draft);
            setCreateOpen(false);
            setDraft({ assetId: '', title: '', scope: '', plannedStart: '', plannedEnd: '', atHours: '', contractor: '' });
            load(); onChanged?.();
            showNote?.('Overhaul planned', 'success');
        } catch (e) { showNote?.(e.response?.data?.error || 'Could not create overhaul', 'error'); }
    };

    const patch = async (id, body) => {
        try { await axios.patch(`/api/cmms/overhauls/${id}`, body); load(); onChanged?.(); }
        catch (e) { showNote?.(e.response?.data?.error || 'Update failed', 'error'); }
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Hammer size={18} /> Major Overhauls ({rows.length})
                </Typography>
                <Box sx={{ flexGrow: 1 }} />
                {canWrite && (
                    <Button variant="contained" size="small" startIcon={<Plus size={16} />} onClick={() => setCreateOpen(true)} sx={{ textTransform: 'none', fontWeight: 'bold' }}>
                        Plan overhaul
                    </Button>
                )}
            </Box>

            {rows.map((o) => (
                <Paper key={o.id} sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, borderLeft: `4px solid ${STATUS_COLOR[o.status]}` }}>
                    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, flexWrap: 'wrap' }}>
                        <Box sx={{ minWidth: 0, flex: 1 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                                <Typography sx={{ fontFamily: 'monospace', fontWeight: 800, color: theme.palette.text.secondary, fontSize: 12 }}>{o.no}</Typography>
                                <Typography sx={{ fontWeight: 'bold' }}>{o.title}</Typography>
                                <Chip label={o.status.replace('_', ' ')} size="small" sx={{ height: 20, fontSize: 10, fontWeight: 800, bgcolor: `${STATUS_COLOR[o.status]}22`, color: STATUS_COLOR[o.status] }} />
                            </Box>
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                {o.assetName}
                                {o.atHours != null ? ` · at ${o.atHours} h` : ''}
                                {o.contractor ? ` · ${o.contractor}` : ''}
                            </Typography>
                            {o.scope && <Typography variant="body2" sx={{ mt: 0.75 }}>{o.scope}</Typography>}
                        </Box>
                        {canWrite && (
                            <FormControl size="small" sx={{ minWidth: 150 }}>
                                <InputLabel>Status</InputLabel>
                                <Select label="Status" value={o.status} onChange={(e) => patch(o.id, { status: e.target.value })}>
                                    {(meta.overhaulStatus || []).map((s) => <MenuItem key={s} value={s}>{s.replace('_', ' ')}</MenuItem>)}
                                </Select>
                            </FormControl>
                        )}
                    </Box>

                    {/* Planned vs actual */}
                    <Box sx={{ display: 'flex', gap: 3, mt: 1.5, flexWrap: 'wrap' }}>
                        {[
                            ['Planned start', fmtDate(o.plannedStart)],
                            ['Planned end', fmtDate(o.plannedEnd)],
                            ['Actual start', fmtDate(o.actualStart)],
                            ['Actual end', fmtDate(o.actualEnd)],
                        ].map(([k, v]) => (
                            <Box key={k}>
                                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, display: 'block', fontSize: 10, letterSpacing: 0.5 }}>{k.toUpperCase()}</Typography>
                                <Typography variant="body2" sx={{ fontWeight: 700 }}>{v}</Typography>
                            </Box>
                        ))}
                    </Box>

                    {/* Milestone progress */}
                    <Box sx={{ mt: 1.75 }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontWeight: 700 }}>
                                MILESTONES {o.milestonesDone}/{o.milestonesTotal}
                            </Typography>
                            <Typography variant="caption" sx={{ fontWeight: 800, color: STATUS_COLOR[o.status] }}>{o.progressPct}%</Typography>
                        </Box>
                        <LinearProgress variant="determinate" value={o.progressPct}
                            sx={{ height: 6, borderRadius: 3, bgcolor: theme.palette.action.hover, '& .MuiLinearProgress-bar': { bgcolor: STATUS_COLOR[o.status] } }} />
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                            {(o.milestones || []).map((m) => (
                                <FormControlLabel
                                    key={m.id}
                                    control={
                                        <Checkbox
                                            size="small" checked={!!m.done} disabled={!canWrite}
                                            onChange={(e) => patch(o.id, { milestoneId: m.id, milestoneDone: e.target.checked })}
                                        />
                                    }
                                    label={<Typography variant="caption" sx={{ textDecoration: m.done ? 'line-through' : 'none', color: m.done ? theme.palette.text.secondary : theme.palette.text.primary }}>{m.name}</Typography>}
                                    sx={{ mr: 1.5 }}
                                />
                            ))}
                        </Box>
                    </Box>

                    {o.findings && (
                        <>
                            <Divider sx={{ my: 1.5, borderColor: theme.palette.divider }} />
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontWeight: 700 }}>FINDINGS</Typography>
                            <Typography variant="body2">{o.findings}</Typography>
                        </>
                    )}
                </Paper>
            ))}

            {rows.length === 0 && (
                <Paper sx={{ p: 4, textAlign: 'center', color: theme.palette.text.secondary, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                    No overhauls planned.
                </Paper>
            )}

            <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
                <DialogTitle sx={{ fontWeight: 'bold' }}>Plan Major Overhaul</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                        <FormControl fullWidth size="small">
                            <InputLabel>Asset</InputLabel>
                            <Select label="Asset" value={draft.assetId} onChange={(e) => setDraft({ ...draft, assetId: e.target.value })}>
                                <MenuItem value="">(none)</MenuItem>
                                {(meta.assets || []).map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
                            </Select>
                        </FormControl>
                        <TextField label="Title" size="small" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus />
                        <TextField label="Scope" size="small" multiline rows={3} value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })} />
                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField label="Planned start" type="date" size="small" fullWidth InputLabelProps={{ shrink: true }}
                                value={draft.plannedStart} onChange={(e) => setDraft({ ...draft, plannedStart: e.target.value })} />
                            <TextField label="Planned end" type="date" size="small" fullWidth InputLabelProps={{ shrink: true }}
                                value={draft.plannedEnd} onChange={(e) => setDraft({ ...draft, plannedEnd: e.target.value })} />
                        </Box>
                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField label="At running hours" type="number" size="small" fullWidth value={draft.atHours} onChange={(e) => setDraft({ ...draft, atHours: e.target.value })} />
                            <TextField label="Contractor" size="small" fullWidth value={draft.contractor} onChange={(e) => setDraft({ ...draft, contractor: e.target.value })} />
                        </Box>
                        <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                            Standard milestones (planning, isolate &amp; strip, inspect, rebuild, commission) are created automatically and can be ticked off as work progresses.
                        </Typography>
                    </Box>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setCreateOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
                    <Button variant="contained" onClick={create} disabled={!draft.title.trim()} sx={{ textTransform: 'none', fontWeight: 'bold' }}>Create</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
