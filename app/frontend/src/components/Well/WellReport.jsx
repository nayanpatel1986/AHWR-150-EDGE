import React, { useState, useEffect, useMemo } from 'react';
import {
    Box, Paper, Typography, Button, Stack, MenuItem, TextField, Chip, Divider,
    Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    Accordion, AccordionSummary, AccordionDetails, LinearProgress, Alert, Grid,
} from '@mui/material';
import { useTheme, alpha } from '@mui/material/styles';
import {
    FileText, ChevronRight, Wrench, ClipboardList, HeartPulse, Printer, Download,
} from 'lucide-react';
import axios from '../../api';

const secToH = (s) => (s == null ? '--' : (Number(s) / 3600).toFixed(1));
const fmtDate = (d) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '--');
const fmtTs = (t) => (t ? new Date(t).toLocaleString('en-GB', { hour12: false }) : '--');

const PM_COLOR = { overdue: '#ef4444', 'due-soon': '#f59e0b', ok: '#34d399' };

/** Flatten the report into one CSV so it can be filed with the job papers. */
function reportToCsv(rep) {
    const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const out = [];
    out.push(['WELL REPORT', rep.well.name].map(esc).join(','));
    out.push(['Job No', rep.well.jobNo || '', 'Service', rep.well.serviceType || ''].map(esc).join(','));
    out.push(['From', rep.window.from, 'To', rep.window.to, 'Elapsed h', rep.window.elapsedHrs].map(esc).join(','));
    out.push('');
    out.push('DAILY LOG');
    out.push(['Date', 'Type', 'Time', 'Shift', 'Category', 'Equipment', 'Entry', 'By'].join(','));
    rep.days.forEach((d) => {
        [...d.operations.map((l) => ['OPERATIONS', l]), ...d.maintenance.map((l) => ['MAINTENANCE', l])]
            .forEach(([type, l]) => out.push([d.date, type, fmtTs(l.ts), l.shift || '', l.categoryLabel || l.category || '', l.assetName || '', l.entry, l.by || ''].map(esc).join(',')));
    });
    out.push('');
    out.push('DAILY TOTALS');
    out.push(['Date', 'Productive h', 'NPT h', 'Joints', 'Depth progress m', 'Run hours (all equipment)'].join(','));
    rep.days.forEach((d) => out.push([d.date, secToH(d.productiveSec), secToH(d.nptSec), d.connections.run, d.depthProgress, d.runHoursTotal].map(esc).join(',')));
    out.push('');
    out.push('EQUIPMENT HEALTH');
    out.push(['Equipment', 'Category', 'Run h (job)', 'Total h', 'Starts', 'Breakdowns', 'Downtime h', 'MTBF h', 'Open WOs'].join(','));
    rep.equipmentHealth.forEach((e) => out.push([e.name, e.category, e.runHoursInJob, e.totalHours ?? '', e.starts, e.breakdowns, e.downtimeHrs, e.mtbfHrs ?? '', e.openWorkOrders].map(esc).join(',')));
    return out.join('\n');
}

function LogTable({ rows, empty }) {
    const theme = useTheme();
    if (!rows.length) {
        return <Typography sx={{ fontSize: 12.5, color: 'text.secondary', py: 1.5 }}>{empty}</Typography>;
    }
    const cell = { fontSize: 12.5, py: 0.75, borderColor: alpha(theme.palette.divider, 0.5) };
    return (
        <TableContainer>
            <Table size="small">
                <TableHead>
                    <TableRow>
                        {['Time', 'Shift', 'Category', 'Equipment', 'Entry', 'By'].map((h) => (
                            <TableCell key={h} sx={{ ...cell, fontSize: 10.5, letterSpacing: 0.5, color: 'text.secondary', textTransform: 'uppercase' }}>{h}</TableCell>
                        ))}
                    </TableRow>
                </TableHead>
                <TableBody>
                    {rows.map((l) => (
                        <TableRow key={l.id} hover>
                            <TableCell sx={{ ...cell, whiteSpace: 'nowrap' }}>{new Date(l.ts).toLocaleTimeString('en-GB', { hour12: false })}</TableCell>
                            <TableCell sx={cell}>{l.shift || '--'}</TableCell>
                            <TableCell sx={cell}><Chip size="small" variant="outlined" label={l.categoryLabel || l.category} sx={{ height: 18, fontSize: 10 }} /></TableCell>
                            <TableCell sx={cell}>{l.assetName || '--'}</TableCell>
                            <TableCell sx={cell}>{l.entry}{l.workOrderNo ? ` (${l.workOrderNo})` : ''}</TableCell>
                            <TableCell sx={cell}>{l.by || '--'}</TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </TableContainer>
    );
}

export default function WellReport({ wells = [] }) {
    const theme = useTheme();
    const [wellId, setWellId] = useState('');
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!wellId && wells.length) {
            // Default to the well that is running, else the most recent one.
            const active = wells.find((w) => w.status === 'active');
            setWellId((active || wells[0]).id);
        }
    }, [wells, wellId]);

    useEffect(() => {
        if (!wellId) return;
        setLoading(true); setError(null); setReport(null);
        axios.get(`/api/wells/${wellId}/report`)
            .then((r) => setReport(r.data))
            .catch((e) => setError(e.response?.data?.error || e.message))
            .finally(() => setLoading(false));
    }, [wellId]);

    const downloadCsv = () => {
        const blob = new Blob([reportToCsv(report)], { type: 'text/csv;charset=utf-8' });
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = `${report.well.name}_well_report.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
    };

    const totals = useMemo(() => {
        if (!report) return null;
        const prod = report.days.reduce((s, d) => s + d.productiveSec, 0);
        const npt = report.days.reduce((s, d) => s + d.nptSec, 0);
        return {
            prod, npt,
            nptPct: prod + npt > 0 ? ((npt / (prod + npt)) * 100).toFixed(1) : null,
            runH: report.days.reduce((s, d) => s + d.runHoursTotal, 0).toFixed(1),
        };
    }, [report]);

    const paperSx = { p: 2, bgcolor: alpha(theme.palette.background.paper, 0.6), border: `1px solid ${theme.palette.divider}` };
    const statSx = { fontSize: 10.5, letterSpacing: 0.6, color: 'text.secondary', textTransform: 'uppercase' };

    return (
        <Stack spacing={2}>
            <Paper sx={paperSx}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
                    <Stack direction="row" alignItems="center" spacing={1}>
                        <FileText size={16} color={theme.palette.primary.main} />
                        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>Well report</Typography>
                    </Stack>
                    <TextField
                        select size="small" sx={{ minWidth: 240 }} value={wellId}
                        onChange={(e) => setWellId(e.target.value)}
                    >
                        {wells.map((w) => (
                            <MenuItem key={w.id} value={w.id}>{w.name}{w.jobNo ? ` — ${w.jobNo}` : ''}</MenuItem>
                        ))}
                    </TextField>
                    <Box sx={{ flex: 1 }} />
                    <Button size="small" startIcon={<Download size={14} />} disabled={!report} onClick={downloadCsv}>CSV</Button>
                    <Button size="small" startIcon={<Printer size={14} />} disabled={!report} onClick={() => window.print()}>Print</Button>
                </Stack>
            </Paper>

            {loading && <LinearProgress />}
            {error && <Alert severity="error">{error}</Alert>}

            {report && (
                <>
                    {/* ---- Job header ---- */}
                    <Paper sx={paperSx}>
                        <Grid container spacing={2}>
                            {[
                                ['Well', report.well.name],
                                ['Job No', report.well.jobNo || '--'],
                                ['Service', report.well.serviceType || '--'],
                                ['Status', report.well.status],
                                ['Started', fmtTs(report.well.startedAt)],
                                ['Completed', report.well.completedAt ? fmtTs(report.well.completedAt) : 'in progress'],
                                ['Elapsed', `${report.window.elapsedHrs} h`],
                                ['Days', report.window.days],
                            ].map(([k, v]) => (
                                <Grid item xs={6} sm={3} key={k}>
                                    <Typography sx={statSx}>{k}</Typography>
                                    <Typography sx={{ fontWeight: 600, fontSize: 13.5 }}>{v}</Typography>
                                </Grid>
                            ))}
                        </Grid>
                        <Divider sx={{ my: 2 }} />
                        <Grid container spacing={2}>
                            {[
                                ['Productive', `${secToH(totals.prod)} h`, theme.palette.success.main],
                                ['NPT', `${secToH(totals.npt)} h${totals.nptPct ? ` (${totals.nptPct}%)` : ''}`, '#f59e0b'],
                                ['Joints', report.summary.joints ?? '--', theme.palette.primary.main],
                                ['Equipment run hours', `${totals.runH} h`, theme.palette.primary.main],
                                ['Operations entries', report.summary.operations, theme.palette.text.primary],
                                ['Maintenance entries', report.summary.maintenance, theme.palette.text.primary],
                                ['Diesel', report.summary.consumption?.dieselLitres != null
                                    ? `${report.summary.consumption.dieselLitres.toFixed(1)} L` : 'no data', theme.palette.text.primary],
                                ['Instruments overdue', report.instruments.overdue, report.instruments.overdue ? '#ef4444' : theme.palette.text.primary],
                            ].map(([k, v, c]) => (
                                <Grid item xs={6} sm={3} key={k}>
                                    <Typography sx={statSx}>{k}</Typography>
                                    <Typography sx={{ fontWeight: 700, fontSize: 15, color: c }}>{v}</Typography>
                                </Grid>
                            ))}
                        </Grid>
                        {report.summary.consumption?.source === 'unavailable' && (
                            <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 1.5 }}>
                                Diesel consumption is not available for this window — no engine totaliser data was recorded.
                            </Typography>
                        )}
                    </Paper>

                    {/* ---- Day by day ---- */}
                    <Paper sx={paperSx}>
                        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                            <ClipboardList size={16} color={theme.palette.primary.main} />
                            <Typography sx={{ fontWeight: 600, fontSize: 14 }}>Day-wise log</Typography>
                            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>({report.window.dayBoundary})</Typography>
                        </Stack>
                        {report.days.map((d) => (
                            <Accordion
                                key={d.date} disableGutters
                                defaultExpanded={report.days.length <= 3}
                                sx={{ bgcolor: 'transparent', '&:before': { display: 'none' }, borderTop: `1px solid ${alpha(theme.palette.divider, 0.6)}` }}
                            >
                                <AccordionSummary expandIcon={<ChevronRight size={16} />} sx={{ '& .MuiAccordionSummary-expandIconWrapper.Mui-expanded': { transform: 'rotate(90deg)' } }}>
                                    <Stack direction="row" alignItems="center" spacing={1.5} sx={{ flexWrap: 'wrap', gap: 0.75 }}>
                                        <Typography sx={{ fontWeight: 600, fontSize: 13, minWidth: 120 }}>{fmtDate(d.date)}</Typography>
                                        {d.partial && <Chip size="small" variant="outlined" label="partial day" sx={{ height: 18, fontSize: 9.5 }} />}
                                        <Chip size="small" label={`${d.operations.length} ops`} sx={{ height: 19, fontSize: 10.5 }} />
                                        <Chip size="small" label={`${d.maintenance.length} maint`} sx={{ height: 19, fontSize: 10.5 }} color={d.maintenance.length ? 'warning' : 'default'} variant="outlined" />
                                        <Chip size="small" variant="outlined" label={`NPT ${secToH(d.nptSec)} h`} sx={{ height: 19, fontSize: 10.5 }} />
                                        <Chip size="small" variant="outlined" label={`run ${d.runHoursTotal.toFixed(1)} h`} sx={{ height: 19, fontSize: 10.5 }} />
                                        {!!d.connections.run && <Chip size="small" variant="outlined" label={`${d.connections.run} joints`} sx={{ height: 19, fontSize: 10.5 }} />}
                                    </Stack>
                                </AccordionSummary>
                                <AccordionDetails sx={{ pt: 0 }}>
                                    <Typography sx={{ ...statSx, mt: 1 }}>Operations log</Typography>
                                    <LogTable rows={d.operations} empty="No operations entries logged for this day." />

                                    <Typography sx={{ ...statSx, mt: 2 }}>Maintenance log</Typography>
                                    <LogTable rows={d.maintenance} empty="No maintenance entries logged for this day." />

                                    {(d.workOrdersRaised.length > 0 || d.workOrdersClosed.length > 0) && (
                                        <>
                                            <Typography sx={{ ...statSx, mt: 2 }}>Work orders</Typography>
                                            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 0.75, mt: 0.5 }}>
                                                {d.workOrdersRaised.map((w) => (
                                                    <Chip key={`r${w.no}`} size="small" color="warning" variant="outlined"
                                                        label={`raised ${w.no} · ${w.title}`} sx={{ fontSize: 10.5 }} />
                                                ))}
                                                {d.workOrdersClosed.map((w) => (
                                                    <Chip key={`c${w.no}`} size="small" color="success" variant="outlined"
                                                        label={`closed ${w.no} · ${w.title}`} sx={{ fontSize: 10.5 }} />
                                                ))}
                                            </Stack>
                                        </>
                                    )}

                                    {d.activity.length > 0 && (
                                        <>
                                            <Typography sx={{ ...statSx, mt: 2 }}>Activity breakdown</Typography>
                                            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 0.75, mt: 0.5 }}>
                                                {d.activity.map((a) => (
                                                    <Chip
                                                        key={a.code} size="small" variant="outlined"
                                                        label={`${a.label} ${(a.durationSec / 3600).toFixed(1)} h`}
                                                        sx={{ fontSize: 10.5, borderColor: a.productive ? alpha(theme.palette.success.main, 0.6) : alpha('#f59e0b', 0.6) }}
                                                    />
                                                ))}
                                            </Stack>
                                        </>
                                    )}

                                    {Object.keys(d.runHours).length > 0 && (
                                        <>
                                            <Typography sx={{ ...statSx, mt: 2 }}>Equipment run hours</Typography>
                                            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 0.75, mt: 0.5 }}>
                                                {Object.entries(d.runHours).map(([id, h]) => (
                                                    <Chip key={id} size="small" variant="outlined" label={`${id}: ${Number(h).toFixed(1)} h`} sx={{ fontSize: 10.5 }} />
                                                ))}
                                            </Stack>
                                        </>
                                    )}
                                </AccordionDetails>
                            </Accordion>
                        ))}
                        {report.days.length === 0 && (
                            <Typography sx={{ fontSize: 13, color: 'text.secondary', py: 3, textAlign: 'center' }}>
                                No days in this well's window yet.
                            </Typography>
                        )}
                    </Paper>

                    {/* ---- Equipment health ---- */}
                    <Paper sx={paperSx}>
                        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
                            <HeartPulse size={16} color={theme.palette.primary.main} />
                            <Typography sx={{ fontWeight: 600, fontSize: 14 }}>Equipment health summary</Typography>
                        </Stack>
                        <TableContainer>
                            <Table size="small">
                                <TableHead>
                                    <TableRow>
                                        {['Equipment', 'Run h (this job)', 'Total h', 'Starts', 'Breakdowns', 'Downtime h', 'MTBF h', 'Open WOs', 'PM status', 'Latest health snapshot'].map((h) => (
                                            <TableCell key={h} sx={{ fontSize: 10.5, letterSpacing: 0.5, color: 'text.secondary', textTransform: 'uppercase', borderColor: alpha(theme.palette.divider, 0.5) }}>{h}</TableCell>
                                        ))}
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {report.equipmentHealth.map((e) => (
                                        <TableRow key={e.assetId} hover>
                                            <TableCell sx={{ fontSize: 12.5, borderColor: alpha(theme.palette.divider, 0.5) }}>
                                                <Stack direction="row" alignItems="center" spacing={0.75}>
                                                    <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: e.running ? theme.palette.success.main : theme.palette.text.disabled }} />
                                                    <span>{e.name}</span>
                                                </Stack>
                                                <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>{e.category}</Typography>
                                            </TableCell>
                                            <TableCell sx={{ fontSize: 12.5, borderColor: alpha(theme.palette.divider, 0.5) }}>{e.runHoursInJob}</TableCell>
                                            <TableCell sx={{ fontSize: 12.5, borderColor: alpha(theme.palette.divider, 0.5) }}>{e.totalHours ?? '--'}</TableCell>
                                            <TableCell sx={{ fontSize: 12.5, borderColor: alpha(theme.palette.divider, 0.5) }}>
                                                {e.starts}{e.shortRuns ? ` (${e.shortRuns} short)` : ''}
                                            </TableCell>
                                            <TableCell sx={{ fontSize: 12.5, borderColor: alpha(theme.palette.divider, 0.5), color: e.breakdowns ? '#ef4444' : undefined }}>{e.breakdowns}</TableCell>
                                            <TableCell sx={{ fontSize: 12.5, borderColor: alpha(theme.palette.divider, 0.5) }}>{e.downtimeHrs}</TableCell>
                                            <TableCell sx={{ fontSize: 12.5, borderColor: alpha(theme.palette.divider, 0.5) }}>{e.mtbfHrs ?? '--'}</TableCell>
                                            <TableCell sx={{ fontSize: 12.5, borderColor: alpha(theme.palette.divider, 0.5) }}>{e.openWorkOrders}</TableCell>
                                            <TableCell sx={{ borderColor: alpha(theme.palette.divider, 0.5) }}>
                                                <Stack spacing={0.25}>
                                                    {e.pm.map((p) => (
                                                        <Typography key={p.name} sx={{ fontSize: 10.5, color: PM_COLOR[p.status] || 'text.secondary' }}>
                                                            {p.name}: {p.dueInHours < 0 ? `${Math.abs(p.dueInHours)} h overdue` : `${p.dueInHours} h`}
                                                        </Typography>
                                                    ))}
                                                    {!e.pm.length && <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>--</Typography>}
                                                </Stack>
                                            </TableCell>
                                            <TableCell sx={{ borderColor: alpha(theme.palette.divider, 0.5) }}>
                                                {e.lastSnapshot ? (
                                                    <Stack spacing={0.25}>
                                                        <Typography sx={{ fontSize: 10, color: 'text.secondary' }}>{fmtTs(e.lastSnapshot.ts)}</Typography>
                                                        {Object.entries(e.lastSnapshot.params || {}).map(([k, v]) => (
                                                            <Typography key={k} sx={{ fontSize: 10.5 }}>
                                                                {k}: <strong>{v == null ? '--' : Number(v).toFixed(1)}</strong>
                                                                {e.firstSnapshot && e.firstSnapshot.params?.[k] != null && v != null && (
                                                                    <span style={{ color: theme.palette.text.secondary }}>
                                                                        {' '}(start {Number(e.firstSnapshot.params[k]).toFixed(1)})
                                                                    </span>
                                                                )}
                                                            </Typography>
                                                        ))}
                                                    </Stack>
                                                ) : (
                                                    <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>
                                                        no settled snapshot
                                                    </Typography>
                                                )}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                        <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 1.5, display: 'flex', alignItems: 'center', gap: 0.75 }}>
                            <Wrench size={12} />
                            Snapshots are taken once per equipment start, five minutes after it settles. MTBF is over this job only
                            and is blank until a breakdown has been recorded.
                        </Typography>
                    </Paper>
                </>
            )}
        </Stack>
    );
}
