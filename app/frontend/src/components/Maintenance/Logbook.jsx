import React, { useState, useEffect, useCallback } from 'react';
import {
    Box, Paper, Typography, Button, TextField, MenuItem, Select, FormControl, InputLabel,
    Chip, Divider, useTheme
} from '@mui/material';
import { BookOpen, Plus } from 'lucide-react';
import axios from '../../api';

// Shift / tour logbook — the running written record of what each crew did and
// handed over. Entries are immutable once written (append-only), which is what
// makes a logbook trustworthy for handover and incident reconstruction.
//
// OPERATIONS and MAINTENANCE are SEPARATE streams (`logType`): different crews
// write them and different people review them, so mixing them makes both harder
// to audit. This component renders one stream, selected by the `logType` prop.

const CAT_COLOR = {
    // --- workover operations ---
    RIG_UP: '#4ade80', RIG_DOWN: '#4ade80',
    RUNNING_IN: '#38bdf8', RUNNING_OUT: '#f97316',
    CIRCULATION: '#22d3ee', WELL_KILL: '#ef4444',
    CDR: '#a78bfa', WOC: '#fbbf24', CEMENTING: '#a78bfa',
    PERFORATION: '#ef4444', ACTIVATION: '#4ade80', SWABBING: '#22d3ee',
    PACKER: '#a78bfa', SCRAPING: '#94a3b8', FISHING: '#f97316', LOGGING: '#38bdf8',
    STIMULATION: '#eab308', WELL_TESTING: '#38bdf8',
    BOP_NU_ND: '#ef4444', RIGGING_OPS: '#94a3b8',
    HANDOVER: '#a78bfa', SAFETY: '#ef4444', INCIDENT: '#f97316', NPT: '#fbbf24', OTHER: '#64748b',
    // --- maintenance ---
    MAINTENANCE: '#4ade80', INSPECTION: '#eab308', BREAKDOWN: '#ef4444',
    CALIBRATION: '#22d3ee', SPARES: '#a78bfa', LUBRICATION: '#38bdf8', OVERHAUL: '#f97316',
};

const fmtTs = (ts) => {
    const d = new Date(ts);
    return isNaN(d) ? '--' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
};

export default function Logbook({ meta, canWrite, onChanged, showNote, logType = 'OPERATIONS' }) {
    const theme = useTheme();
    const [rows, setRows] = useState([]);
    const [filter, setFilter] = useState({ shift: '', category: '', assetId: '' });
    // Categories are per-stream: workover operations vs maintenance activities.
    const cats = (meta.logCategoriesByType || {})[logType] || [];
    const catLabel = (code) => (meta.logCategoryLabels || {})[code] || code;
    const [draft, setDraft] = useState({ shift: 'DAY', category: '', assetId: '', entry: '', workOrderNo: '' });
    const isMaint = logType === 'MAINTENANCE';

    // Default the category once the vocabulary arrives / the stream changes.
    useEffect(() => {
        setDraft((d) => ({ ...d, category: cats.includes(d.category) ? d.category : (cats[0] || '') }));
        setFilter({ shift: '', category: '', assetId: '' });
    }, [logType, cats.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

    const load = useCallback(() => {
        const p = new URLSearchParams();
        p.set('logType', logType);
        if (filter.shift) p.set('shift', filter.shift);
        if (filter.category) p.set('category', filter.category);
        if (filter.assetId) p.set('assetId', filter.assetId);
        axios.get(`/api/cmms/logbook?${p.toString()}`)
            .then((r) => setRows(Array.isArray(r.data) ? r.data : []))
            .catch((e) => console.error('logbook load failed', e));
    }, [logType, filter.shift, filter.category, filter.assetId]);
    useEffect(() => { load(); }, [load]);

    const add = async () => {
        if (!draft.entry.trim()) return;
        try {
            await axios.post('/api/cmms/logbook', { ...draft, logType });
            setDraft((d) => ({ ...d, entry: '', workOrderNo: '' }));
            load(); onChanged?.();
            showNote?.(`${isMaint ? 'Maintenance' : 'Operations'} log entry added`, 'success');
        } catch (e) { showNote?.(e.response?.data?.error || 'Could not add entry', 'error'); }
    };

    // Group by date for a diary-style read.
    const byDate = rows.reduce((acc, r) => { (acc[r.date] = acc[r.date] || []).push(r); return acc; }, {});
    const dates = Object.keys(byDate).sort().reverse();

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {canWrite && (
                <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                        <BookOpen size={18} /> New {isMaint ? 'Maintenance' : 'Operations'} Log Entry
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', mb: 1.5 }}>
                        <FormControl size="small" sx={{ minWidth: 110 }}>
                            <InputLabel>Shift</InputLabel>
                            <Select label="Shift" value={draft.shift} onChange={(e) => setDraft({ ...draft, shift: e.target.value })}>
                                {(meta.shifts || []).map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
                            </Select>
                        </FormControl>
                        <FormControl size="small" sx={{ minWidth: 210 }}>
                            <InputLabel>{isMaint ? 'Activity' : 'Operation'}</InputLabel>
                            <Select label={isMaint ? 'Activity' : 'Operation'} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>
                                {cats.map((cgy) => <MenuItem key={cgy} value={cgy}>{catLabel(cgy)}</MenuItem>)}
                            </Select>
                        </FormControl>
                        <FormControl size="small" sx={{ minWidth: 170 }}>
                            <InputLabel>{isMaint ? 'Asset' : 'Asset (optional)'}</InputLabel>
                            <Select label={isMaint ? 'Asset' : 'Asset (optional)'} value={draft.assetId} onChange={(e) => setDraft({ ...draft, assetId: e.target.value })}>
                                <MenuItem value="">(none)</MenuItem>
                                {(meta.assets || []).map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
                            </Select>
                        </FormControl>
                        {isMaint && (
                            <TextField label="WO ref (optional)" size="small" sx={{ minWidth: 140 }} placeholder="WO-1002"
                                value={draft.workOrderNo} onChange={(e) => setDraft({ ...draft, workOrderNo: e.target.value })} />
                        )}
                    </Box>
                    <TextField
                        fullWidth multiline rows={3} size="small"
                        placeholder={isMaint ? 'What was done to the equipment…' : 'What happened this shift…'}
                        value={draft.entry} onChange={(e) => setDraft({ ...draft, entry: e.target.value })}
                    />
                    <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
                        <Button variant="contained" size="small" startIcon={<Plus size={16} />} onClick={add} disabled={!draft.entry.trim()} sx={{ textTransform: 'none', fontWeight: 'bold' }}>
                            Add entry
                        </Button>
                    </Box>
                </Paper>
            )}

            <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 2, flexWrap: 'wrap' }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main }}>
                        {isMaint ? 'Maintenance Log' : 'Operations Log'} ({rows.length})
                    </Typography>
                    <Box sx={{ flexGrow: 1 }} />
                    <FormControl size="small" sx={{ minWidth: 120 }}>
                        <InputLabel>Shift</InputLabel>
                        <Select label="Shift" value={filter.shift} onChange={(e) => setFilter((f) => ({ ...f, shift: e.target.value }))}>
                            <MenuItem value="">All shifts</MenuItem>
                            {(meta.shifts || []).map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
                        </Select>
                    </FormControl>
                    <FormControl size="small" sx={{ minWidth: 200 }}>
                        <InputLabel>{isMaint ? 'Activity' : 'Operation'}</InputLabel>
                        <Select label={isMaint ? 'Activity' : 'Operation'} value={filter.category} onChange={(e) => setFilter((f) => ({ ...f, category: e.target.value }))}>
                            <MenuItem value="">{isMaint ? 'All activities' : 'All operations'}</MenuItem>
                            {cats.map((cgy) => <MenuItem key={cgy} value={cgy}>{catLabel(cgy)}</MenuItem>)}
                        </Select>
                    </FormControl>
                    {/* Equipment filter — essential for reading one machine's maintenance history. */}
                    <FormControl size="small" sx={{ minWidth: 180 }}>
                        <InputLabel>Equipment</InputLabel>
                        <Select label="Equipment" value={filter.assetId} onChange={(e) => setFilter((f) => ({ ...f, assetId: e.target.value }))}>
                            <MenuItem value="">All equipment</MenuItem>
                            {(meta.assets || []).map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
                        </Select>
                    </FormControl>
                </Box>
                <Divider sx={{ borderColor: theme.palette.divider }} />

                <Box sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2.5, maxHeight: '60vh', overflowY: 'auto' }}>
                    {dates.map((date) => (
                        <Box key={date}>
                            <Typography variant="caption" sx={{ fontWeight: 800, letterSpacing: 1, color: theme.palette.text.secondary }}>
                                {new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                            </Typography>
                            <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                                {byDate[date].map((l) => (
                                    <Box key={l.id} sx={{
                                        display: 'flex', gap: 1.5, p: 1.25, borderRadius: 1,
                                        bgcolor: theme.palette.action.hover,
                                        borderLeft: `3px solid ${CAT_COLOR[l.category] || '#64748b'}`,
                                    }}>
                                        <Box sx={{ minWidth: 0, flex: 1 }}>
                                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
                                                <Chip label={l.categoryLabel || catLabel(l.category)} size="small" sx={{ height: 18, fontSize: 9.5, fontWeight: 800, bgcolor: `${CAT_COLOR[l.category] || '#64748b'}22`, color: CAT_COLOR[l.category] || '#94a3b8' }} />
                                                <Chip label={l.shift} size="small" variant="outlined" sx={{ height: 18, fontSize: 9.5, fontWeight: 700 }} />
                                                {l.assetName && <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>{l.assetName}</Typography>}
                                                {l.workOrderNo && <Chip label={l.workOrderNo} size="small" variant="outlined" sx={{ height: 18, fontSize: 9.5, fontWeight: 700, fontFamily: 'monospace' }} />}
                                                <Box sx={{ flexGrow: 1 }} />
                                                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, fontFamily: 'monospace' }}>{fmtTs(l.ts)} · {l.by}</Typography>
                                            </Box>
                                            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{l.entry}</Typography>
                                        </Box>
                                    </Box>
                                ))}
                            </Box>
                        </Box>
                    ))}
                    {rows.length === 0 && (
                        <Typography align="center" sx={{ py: 4, color: theme.palette.text.secondary }}>No log entries yet.</Typography>
                    )}
                </Box>
            </Paper>
        </Box>
    );
}
