import React, { useState, useEffect, useCallback } from 'react';
import {
    Box, Paper, Typography, Button, Table, TableBody, TableCell, TableContainer, TableHead,
    TableRow, Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
    Select, FormControl, InputLabel, Grid, IconButton, Divider, useTheme
} from '@mui/material';
import { Ruler, Plus, X, SlidersHorizontal } from 'lucide-react';
import axios from '../../api';

// Instrument register + calibration control.
//
// Every measuring device on the rig is listed with its range, accuracy and
// calibration interval; status (VALID / DUE SOON / OVERDUE) is derived from the
// last calibration date, so nothing has to be tracked by hand. Recording a
// calibration captures the as-found / as-left pair, the reference standard,
// the result and the certificate number — and resets the instrument's clock.

const CAL_COLOR = {
    VALID: '#4ade80', DUE_SOON: '#f59e0b', OVERDUE: '#ef4444',
    OUT_OF_SERVICE: '#64748b', UNKNOWN: '#94a3b8',
};
const RESULT_COLOR = { PASS: '#4ade80', ADJUSTED: '#38bdf8', FAIL: '#ef4444', LIMITED_USE: '#f59e0b' };
const pretty = (s) => String(s || '').replace(/_/g, ' ');
const fmtDate = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '--');

const BLANK_INSTR = {
    tag: '', name: '', type: 'PRESSURE_GAUGE', assetId: '', make: '', model: '', serial: '',
    rangeMin: '', rangeMax: '', unit: '', accuracy: '', location: '', intervalDays: 365, lastCalDate: '',
};
const BLANK_CAL = {
    date: '', result: 'PASS', asFound: '', asLeft: '', referenceStd: '', certificateNo: '', calibratedBy: '', notes: '',
};

export default function Instruments({ canWrite, showNote }) {
    const theme = useTheme();
    const [meta, setMeta] = useState({});
    const [rows, setRows] = useState([]);
    const [summary, setSummary] = useState({});
    const [filter, setFilter] = useState({ type: '', calStatus: '' });
    const [addOpen, setAddOpen] = useState(false);
    const [instr, setInstr] = useState(BLANK_INSTR);
    const [calFor, setCalFor] = useState(null);        // instrument being calibrated
    const [cal, setCal] = useState(BLANK_CAL);
    const [historyFor, setHistoryFor] = useState(null); // instrument whose history is open
    const [history, setHistory] = useState([]);

    const headSx = { color: theme.palette.text.secondary, fontWeight: 'bold', borderColor: theme.palette.divider, whiteSpace: 'nowrap', fontSize: 12 };
    const cellSx = { color: theme.palette.text.primary, borderColor: theme.palette.divider, fontSize: 13 };

    const load = useCallback(() => {
        const p = new URLSearchParams();
        if (filter.type) p.set('type', filter.type);
        if (filter.calStatus) p.set('calStatus', filter.calStatus);
        axios.get(`/api/cmms/instruments?${p.toString()}`).then((r) => setRows(r.data || [])).catch(() => {});
        axios.get('/api/cmms/instruments/summary').then((r) => setSummary(r.data || {})).catch(() => {});
    }, [filter.type, filter.calStatus]);

    useEffect(() => {
        axios.get('/api/cmms/instruments/meta').then((r) => setMeta(r.data || {})).catch(() => {});
    }, []);
    useEffect(() => { load(); }, [load]);

    // Calibration history for the selected instrument.
    useEffect(() => {
        if (!historyFor) { setHistory([]); return; }
        axios.get(`/api/cmms/instruments/${historyFor.id}/calibrations`)
            .then((r) => setHistory(r.data || [])).catch(() => {});
    }, [historyFor]);

    const createInstrument = async () => {
        try {
            await axios.post('/api/cmms/instruments', instr);
            setAddOpen(false); setInstr(BLANK_INSTR); load();
            showNote?.('Instrument added', 'success');
        } catch (e) { showNote?.(e.response?.data?.error || 'Could not add instrument', 'error'); }
    };

    const recordCalibration = async () => {
        try {
            await axios.post(`/api/cmms/instruments/${calFor.id}/calibrations`, cal);
            setCalFor(null); setCal(BLANK_CAL); load();
            if (historyFor) axios.get(`/api/cmms/instruments/${historyFor.id}/calibrations`).then((r) => setHistory(r.data || []));
            showNote?.('Calibration recorded', 'success');
        } catch (e) { showNote?.(e.response?.data?.error || 'Could not record calibration', 'error'); }
    };

    const Kpi = ({ label, value, color }) => (
        <Paper sx={{ p: 1.5, bgcolor: theme.palette.action.hover, border: `1px solid ${color || theme.palette.divider}`, textAlign: 'center' }}>
            <Typography variant="caption" sx={{ color: theme.palette.text.secondary, textTransform: 'uppercase', letterSpacing: 0.8, fontSize: 10 }}>{label}</Typography>
            <Typography sx={{ color: color || theme.palette.text.primary, fontWeight: 800, fontSize: 22, lineHeight: 1.3 }}>{value ?? 0}</Typography>
        </Paper>
    );

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Grid container spacing={1.5}>
                <Grid item xs={6} sm={3}><Kpi label="Instruments" value={summary.total} /></Grid>
                <Grid item xs={6} sm={3}><Kpi label="Cal. overdue" value={summary.overdue} color={CAL_COLOR.OVERDUE} /></Grid>
                <Grid item xs={6} sm={3}><Kpi label="Due soon" value={summary.dueSoon} color={CAL_COLOR.DUE_SOON} /></Grid>
                <Grid item xs={6} sm={3}><Kpi label="Valid" value={summary.valid} color={CAL_COLOR.VALID} /></Grid>
            </Grid>

            <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Ruler size={18} /> Instrument Register ({rows.length})
                    </Typography>
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>· click a row for calibration history</Typography>
                    <Box sx={{ flexGrow: 1 }} />
                    <FormControl size="small" sx={{ minWidth: 175 }}>
                        <InputLabel>Type</InputLabel>
                        <Select label="Type" value={filter.type} onChange={(e) => setFilter((f) => ({ ...f, type: e.target.value }))}>
                            <MenuItem value="">All types</MenuItem>
                            {(meta.types || []).map((t) => <MenuItem key={t} value={t}>{pretty(t)}</MenuItem>)}
                        </Select>
                    </FormControl>
                    <FormControl size="small" sx={{ minWidth: 160 }}>
                        <InputLabel>Cal. status</InputLabel>
                        <Select label="Cal. status" value={filter.calStatus} onChange={(e) => setFilter((f) => ({ ...f, calStatus: e.target.value }))}>
                            <MenuItem value="">All statuses</MenuItem>
                            {['VALID', 'DUE_SOON', 'OVERDUE', 'OUT_OF_SERVICE'].map((s) => <MenuItem key={s} value={s}>{pretty(s)}</MenuItem>)}
                        </Select>
                    </FormControl>
                    {canWrite && (
                        <Button variant="contained" size="small" startIcon={<Plus size={16} />} onClick={() => setAddOpen(true)} sx={{ textTransform: 'none', fontWeight: 'bold' }}>
                            Add instrument
                        </Button>
                    )}
                </Box>

                <TableContainer sx={{ maxHeight: '60vh' }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                {['Tag', 'Instrument', 'Type', 'Serves', 'Range', 'Accuracy', 'Last cal.', 'Next due', 'Status'].map((h) => (
                                    <TableCell key={h} sx={{ ...headSx, bgcolor: theme.palette.background.paper }}>{h}</TableCell>
                                ))}
                                {canWrite && <TableCell sx={{ ...headSx, bgcolor: theme.palette.background.paper }} align="right">Action</TableCell>}
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {rows.map((i) => (
                                <TableRow key={i.id} hover onClick={() => setHistoryFor(i)} sx={{ cursor: 'pointer' }} title={`Calibration history for ${i.tag}`}>
                                    <TableCell sx={{ ...cellSx, fontFamily: 'monospace', fontWeight: 800 }}>{i.tag}</TableCell>
                                    <TableCell sx={cellSx}>{i.name}
                                        {(i.make || i.serial) && (
                                            <Typography variant="caption" sx={{ display: 'block', color: theme.palette.text.secondary }}>
                                                {[i.make, i.model, i.serial && `S/N ${i.serial}`].filter(Boolean).join(' · ')}
                                            </Typography>
                                        )}
                                    </TableCell>
                                    <TableCell sx={{ ...cellSx, whiteSpace: 'nowrap' }}>{pretty(i.type)}</TableCell>
                                    <TableCell sx={{ ...cellSx, color: theme.palette.text.secondary }}>{i.assetName || '--'}</TableCell>
                                    <TableCell sx={{ ...cellSx, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                                        {i.rangeMin != null && i.rangeMax != null ? `${i.rangeMin}–${i.rangeMax} ${i.unit || ''}` : '--'}
                                    </TableCell>
                                    <TableCell sx={{ ...cellSx, color: theme.palette.text.secondary, whiteSpace: 'nowrap' }}>{i.accuracy || '--'}</TableCell>
                                    <TableCell sx={{ ...cellSx, whiteSpace: 'nowrap' }}>{fmtDate(i.lastCalDate)}</TableCell>
                                    <TableCell sx={{ ...cellSx, whiteSpace: 'nowrap' }}>
                                        {fmtDate(i.nextDueDate)}
                                        {i.daysToDue != null && (
                                            <Typography variant="caption" sx={{ display: 'block', color: CAL_COLOR[i.calStatus] }}>
                                                {i.daysToDue < 0 ? `${Math.abs(i.daysToDue)} d overdue` : `in ${i.daysToDue} d`}
                                            </Typography>
                                        )}
                                    </TableCell>
                                    <TableCell sx={cellSx}>
                                        <Chip label={pretty(i.calStatus)} size="small"
                                            sx={{ height: 20, fontSize: 10, fontWeight: 800, bgcolor: `${CAL_COLOR[i.calStatus]}22`, color: CAL_COLOR[i.calStatus] }} />
                                    </TableCell>
                                    {canWrite && (
                                        <TableCell sx={cellSx} align="right">
                                            <Button size="small" startIcon={<SlidersHorizontal size={14} />} sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}
                                                onClick={(e) => { e.stopPropagation(); setCalFor(i); setCal({ ...BLANK_CAL, date: new Date().toISOString().slice(0, 10) }); }}>
                                                Calibrate
                                            </Button>
                                        </TableCell>
                                    )}
                                </TableRow>
                            ))}
                            {rows.length === 0 && (
                                <TableRow><TableCell colSpan={canWrite ? 10 : 9} align="center" sx={{ py: 4, color: theme.palette.text.secondary, borderColor: theme.palette.divider }}>
                                    No instruments registered.
                                </TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* Add instrument */}
            <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="sm" fullWidth>
                <DialogTitle sx={{ fontWeight: 'bold' }}>Add Instrument</DialogTitle>
                <DialogContent>
                    <Grid container spacing={2} sx={{ mt: 0 }}>
                        <Grid item xs={5}><TextField label="Tag" size="small" fullWidth autoFocus value={instr.tag} onChange={(e) => setInstr({ ...instr, tag: e.target.value })} placeholder="PI-101" /></Grid>
                        <Grid item xs={7}><TextField label="Name" size="small" fullWidth value={instr.name} onChange={(e) => setInstr({ ...instr, name: e.target.value })} /></Grid>
                        <Grid item xs={7}>
                            <FormControl size="small" fullWidth>
                                <InputLabel>Type</InputLabel>
                                <Select label="Type" value={instr.type} onChange={(e) => setInstr({ ...instr, type: e.target.value })}>
                                    {(meta.types || []).map((t) => <MenuItem key={t} value={t}>{pretty(t)}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Grid>
                        <Grid item xs={5}>
                            <FormControl size="small" fullWidth>
                                <InputLabel>Serves equipment</InputLabel>
                                <Select label="Serves equipment" value={instr.assetId} onChange={(e) => setInstr({ ...instr, assetId: e.target.value })}>
                                    <MenuItem value="">(none)</MenuItem>
                                    {(meta.assets || []).map((a) => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Grid>
                        <Grid item xs={4}><TextField label="Make" size="small" fullWidth value={instr.make} onChange={(e) => setInstr({ ...instr, make: e.target.value })} /></Grid>
                        <Grid item xs={4}><TextField label="Model" size="small" fullWidth value={instr.model} onChange={(e) => setInstr({ ...instr, model: e.target.value })} /></Grid>
                        <Grid item xs={4}><TextField label="Serial no." size="small" fullWidth value={instr.serial} onChange={(e) => setInstr({ ...instr, serial: e.target.value })} /></Grid>
                        <Grid item xs={3}><TextField label="Range min" type="number" size="small" fullWidth value={instr.rangeMin} onChange={(e) => setInstr({ ...instr, rangeMin: e.target.value })} /></Grid>
                        <Grid item xs={3}><TextField label="Range max" type="number" size="small" fullWidth value={instr.rangeMax} onChange={(e) => setInstr({ ...instr, rangeMax: e.target.value })} /></Grid>
                        <Grid item xs={3}><TextField label="Unit" size="small" fullWidth value={instr.unit} onChange={(e) => setInstr({ ...instr, unit: e.target.value })} placeholder="bar" /></Grid>
                        <Grid item xs={3}><TextField label="Accuracy" size="small" fullWidth value={instr.accuracy} onChange={(e) => setInstr({ ...instr, accuracy: e.target.value })} placeholder="±1 % FS" /></Grid>
                        <Grid item xs={6}><TextField label="Location" size="small" fullWidth value={instr.location} onChange={(e) => setInstr({ ...instr, location: e.target.value })} /></Grid>
                        <Grid item xs={3}><TextField label="Interval (days)" type="number" size="small" fullWidth value={instr.intervalDays} onChange={(e) => setInstr({ ...instr, intervalDays: e.target.value })} /></Grid>
                        <Grid item xs={3}><TextField label="Last cal." type="date" size="small" fullWidth InputLabelProps={{ shrink: true }} value={instr.lastCalDate} onChange={(e) => setInstr({ ...instr, lastCalDate: e.target.value })} /></Grid>
                    </Grid>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setAddOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
                    <Button variant="contained" onClick={createInstrument} disabled={!instr.tag.trim()} sx={{ textTransform: 'none', fontWeight: 'bold' }}>Add</Button>
                </DialogActions>
            </Dialog>

            {/* Record calibration */}
            <Dialog open={!!calFor} onClose={() => setCalFor(null)} maxWidth="sm" fullWidth>
                <DialogTitle sx={{ fontWeight: 'bold' }}>
                    Record Calibration — {calFor?.tag}
                    <Typography variant="caption" sx={{ display: 'block', color: theme.palette.text.secondary, fontWeight: 400 }}>
                        {calFor?.name} · range {calFor?.rangeMin}–{calFor?.rangeMax} {calFor?.unit} · {calFor?.accuracy}
                    </Typography>
                </DialogTitle>
                <DialogContent>
                    <Grid container spacing={2} sx={{ mt: 0 }}>
                        <Grid item xs={6}><TextField label="Calibration date" type="date" size="small" fullWidth InputLabelProps={{ shrink: true }} value={cal.date} onChange={(e) => setCal({ ...cal, date: e.target.value })} /></Grid>
                        <Grid item xs={6}>
                            <FormControl size="small" fullWidth>
                                <InputLabel>Result</InputLabel>
                                <Select label="Result" value={cal.result} onChange={(e) => setCal({ ...cal, result: e.target.value })}>
                                    {(meta.results || []).map((r) => <MenuItem key={r} value={r}>{pretty(r)}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Grid>
                        <Grid item xs={6}><TextField label="As found" size="small" fullWidth value={cal.asFound} onChange={(e) => setCal({ ...cal, asFound: e.target.value })} placeholder="+1.2 bar @ 200 bar" /></Grid>
                        <Grid item xs={6}><TextField label="As left" size="small" fullWidth value={cal.asLeft} onChange={(e) => setCal({ ...cal, asLeft: e.target.value })} placeholder="±0.1 bar" /></Grid>
                        <Grid item xs={6}><TextField label="Reference standard" size="small" fullWidth value={cal.referenceStd} onChange={(e) => setCal({ ...cal, referenceStd: e.target.value })} placeholder="Dead-weight tester DWT-02" /></Grid>
                        <Grid item xs={6}><TextField label="Certificate no." size="small" fullWidth value={cal.certificateNo} onChange={(e) => setCal({ ...cal, certificateNo: e.target.value })} /></Grid>
                        <Grid item xs={12}><TextField label="Calibrated by" size="small" fullWidth value={cal.calibratedBy} onChange={(e) => setCal({ ...cal, calibratedBy: e.target.value })} placeholder="Technician / agency" /></Grid>
                        <Grid item xs={12}><TextField label="Notes" size="small" fullWidth multiline rows={2} value={cal.notes} onChange={(e) => setCal({ ...cal, notes: e.target.value })} /></Grid>
                        <Grid item xs={12}>
                            <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                                A PASS or ADJUSTED result resets the calibration due date. A FAIL puts the instrument out of service.
                            </Typography>
                        </Grid>
                    </Grid>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setCalFor(null)} sx={{ textTransform: 'none' }}>Cancel</Button>
                    <Button variant="contained" onClick={recordCalibration} sx={{ textTransform: 'none', fontWeight: 'bold' }}>Record</Button>
                </DialogActions>
            </Dialog>

            {/* Calibration history */}
            <Dialog open={!!historyFor} onClose={() => setHistoryFor(null)} maxWidth="md" fullWidth>
                <DialogTitle sx={{ fontWeight: 'bold', color: theme.palette.primary.main, pr: 6 }}>
                    {historyFor?.tag} — Calibration History
                    <Typography variant="caption" sx={{ display: 'block', color: theme.palette.text.secondary, fontWeight: 400 }}>
                        {historyFor?.name} · next due {fmtDate(historyFor?.nextDueDate)}
                    </Typography>
                    <IconButton onClick={() => setHistoryFor(null)} size="small" sx={{ position: 'absolute', right: 12, top: 12, color: theme.palette.text.secondary }}><X size={18} /></IconButton>
                </DialogTitle>
                <DialogContent dividers sx={{ p: 0 }}>
                    <TableContainer sx={{ maxHeight: '55vh' }}>
                        <Table size="small" stickyHeader>
                            <TableHead>
                                <TableRow>
                                    {['Date', 'Result', 'As found', 'As left', 'Reference std.', 'Certificate', 'By'].map((h) => (
                                        <TableCell key={h} sx={{ ...headSx, bgcolor: theme.palette.background.paper }}>{h}</TableCell>
                                    ))}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {history.map((c) => (
                                    <TableRow key={c.id} hover>
                                        <TableCell sx={{ ...cellSx, whiteSpace: 'nowrap' }}>{fmtDate(c.date)}</TableCell>
                                        <TableCell sx={cellSx}>
                                            <Chip label={pretty(c.result)} size="small" sx={{ height: 20, fontSize: 10, fontWeight: 800, bgcolor: `${RESULT_COLOR[c.result]}22`, color: RESULT_COLOR[c.result] }} />
                                        </TableCell>
                                        <TableCell sx={{ ...cellSx, fontFamily: 'monospace' }}>{c.asFound || '--'}</TableCell>
                                        <TableCell sx={{ ...cellSx, fontFamily: 'monospace' }}>{c.asLeft || '--'}</TableCell>
                                        <TableCell sx={{ ...cellSx, color: theme.palette.text.secondary }}>{c.referenceStd || '--'}</TableCell>
                                        <TableCell sx={{ ...cellSx, fontFamily: 'monospace' }}>{c.certificateNo || '--'}</TableCell>
                                        <TableCell sx={{ ...cellSx, color: theme.palette.text.secondary }}>{c.calibratedBy || c.by}</TableCell>
                                    </TableRow>
                                ))}
                                {history.length === 0 && (
                                    <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4, color: theme.palette.text.secondary, borderColor: theme.palette.divider }}>
                                        No calibrations recorded for this instrument yet.
                                    </TableCell></TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </TableContainer>
                </DialogContent>
                <DialogActions sx={{ px: 3, py: 1.5 }}>
                    {canWrite && historyFor && (
                        <Button variant="contained" startIcon={<SlidersHorizontal size={15} />} sx={{ textTransform: 'none', fontWeight: 'bold' }}
                            onClick={() => { setCalFor(historyFor); setCal({ ...BLANK_CAL, date: new Date().toISOString().slice(0, 10) }); }}>
                            Record calibration
                        </Button>
                    )}
                    <Box sx={{ flexGrow: 1 }} />
                    <Button onClick={() => setHistoryFor(null)} sx={{ textTransform: 'none' }}>Close</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
