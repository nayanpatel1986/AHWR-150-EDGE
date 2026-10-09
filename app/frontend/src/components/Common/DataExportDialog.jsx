import React, { useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Checkbox,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    Paper,
    TextField,
    Typography
} from '@mui/material';
import { Download, FileSpreadsheet, FileText, Image as ImageIcon, X } from 'lucide-react';
import axios from '../../api';
import { downloadCsv, downloadGraphPng, downloadXlsx } from './dataExport';

const FORMATS = [
    { id: 'xlsx', label: 'EXCEL (.XLSX)', icon: FileSpreadsheet, color: '#22c55e' },
    { id: 'csv', label: 'CSV (.CSV)', icon: FileText, color: '#38bdf8' },
    { id: 'png', label: 'GRAPH (.PNG)', icon: ImageIcon, color: '#f59e0b' }
];

const QUICK_RANGES = [
    { value: '-15m', label: 'LAST 15 MIN', summary: 'last 15 minutes' },
    { value: '-1h', label: 'LAST 1 HOUR', summary: 'last 1 hour' },
    { value: '-6h', label: 'LAST 6 HOURS', summary: 'last 6 hours' },
    { value: '-12h', label: 'LAST 12 HOURS', summary: 'last 12 hours' },
    { value: '-24h', label: 'LAST 24 HOURS', summary: 'last 24 hours' },
    { value: '-3d', label: 'LAST 3 DAYS', summary: 'last 3 days' },
    { value: '-7d', label: 'LAST 7 DAYS', summary: 'last 7 days' },
    { value: '-30d', label: 'LAST 30 DAYS', summary: 'last 30 days' }
];

const RANGE_MS = {
    '-15m': 15 * 60 * 1000,
    '-1h': 60 * 60 * 1000,
    '-6h': 6 * 60 * 60 * 1000,
    '-12h': 12 * 60 * 60 * 1000,
    '-24h': 24 * 60 * 60 * 1000,
    '-3d': 3 * 24 * 60 * 60 * 1000,
    '-7d': 7 * 24 * 60 * 60 * 1000,
    '-30d': 30 * 24 * 60 * 60 * 1000
};

const fileTimestamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export default function DataExportDialog({
    open,
    onClose,
    title,
    filePrefix,
    parameters,
    defaultSelected = [],
    fallbackRows = []
}) {
    const [format, setFormat] = useState('xlsx');
    const [selectedKeys, setSelectedKeys] = useState([]);
    const [range, setRange] = useState('-1h');
    const [customRange, setCustomRange] = useState({ start: '', end: '' });
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const parameterMap = useMemo(
        () => new Map(parameters.map(parameter => [parameter.key, parameter])),
        [parameters]
    );
    const selectedParameters = useMemo(
        () => selectedKeys.map(key => parameterMap.get(key)).filter(Boolean),
        [parameterMap, selectedKeys]
    );
    const groupedParameters = useMemo(() => {
        const groups = new Map();
        parameters.forEach(parameter => {
            const group = parameter.group || 'Parameters';
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(parameter);
        });
        return Array.from(groups.entries());
    }, [parameters]);

    useEffect(() => {
        if (!open) return;
        const available = new Set(parameters.map(parameter => parameter.key));
        const initial = [...new Set(defaultSelected)].filter(key => available.has(key));
        setSelectedKeys(initial.length > 0 ? initial : parameters.slice(0, 6).map(parameter => parameter.key));
        setFormat('xlsx');
        setRange('-1h');
        setCustomRange({ start: '', end: '' });
        setError('');
    }, [defaultSelected, open, parameters]);

    const isCustom = range === 'custom';
    const selectedRange = QUICK_RANGES.find(option => option.value === range);
    const rangeSummary = isCustom
        ? (customRange.start && customRange.end
            ? `${new Date(customRange.start).toLocaleString()} to ${new Date(customRange.end).toLocaleString()}`
            : 'custom date range')
        : (selectedRange?.summary || 'selected range');

    const toggleParameter = key => {
        setSelectedKeys(current => (
            current.includes(key) ? current.filter(item => item !== key) : [...current, key]
        ));
    };

    const visibleFallbackRows = () => {
        const end = isCustom ? new Date(customRange.end).getTime() : Date.now();
        const start = isCustom
            ? new Date(customRange.start).getTime()
            : end - (RANGE_MS[range] || 0);
        return fallbackRows.filter(row => {
            const timestamp = Number(row.timestamp);
            return Number.isFinite(timestamp) && timestamp >= start && timestamp <= end;
        });
    };

    const handleDownload = async () => {
        if (selectedParameters.length === 0) {
            setError('Select at least one parameter.');
            return;
        }
        if (isCustom) {
            const start = new Date(customRange.start).getTime();
            const end = new Date(customRange.end).getTime();
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
                setError('Select a valid custom range with the To date after the From date.');
                return;
            }
        }

        setLoading(true);
        setError('');
        try {
            const params = new URLSearchParams();
            if (isCustom) {
                params.set('start', new Date(customRange.start).toISOString());
                params.set('stop', new Date(customRange.end).toISOString());
            } else {
                params.set('range', range);
            }
            params.set('metrics', selectedParameters.map(parameter => parameter.key).join(','));
            const response = await axios.get(`/api/history?${params.toString()}`);
            const mergedRows = new Map();
            [...(Array.isArray(response.data) ? response.data : []), ...visibleFallbackRows()].forEach(row => {
                const timestamp = Number(row.timestamp);
                if (!Number.isFinite(timestamp)) return;
                mergedRows.set(timestamp, { ...(mergedRows.get(timestamp) || {}), ...row, timestamp });
            });
            const rows = Array.from(mergedRows.values()).sort((a, b) => a.timestamp - b.timestamp);
            if (rows.length === 0) throw new Error('No historical data is available for the selected range.');

            const filename = `${filePrefix}-${fileTimestamp()}.${format}`;
            if (format === 'csv') {
                downloadCsv(rows, selectedParameters, filename);
            } else if (format === 'png') {
                await downloadGraphPng(rows, selectedParameters, filename, title, rangeSummary);
            } else {
                downloadXlsx(rows, selectedParameters, filename);
            }
        } catch (downloadError) {
            setError(downloadError.response?.data?.error || downloadError.message || 'Export failed.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={loading ? undefined : onClose}
            fullWidth
            maxWidth="lg"
            PaperProps={{ sx: { bgcolor: '#364154', color: '#f8fafc', border: '1px solid #64748b' } }}
        >
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1.5, fontSize: '1.8rem', fontWeight: 900, borderBottom: '1px solid #475569' }}>
                <Download color="#fbbf24" />
                Export Data
                <Button onClick={onClose} disabled={loading} sx={{ ml: 'auto', minWidth: 40, color: '#94a3b8' }}>
                    <X />
                </Button>
            </DialogTitle>
            <DialogContent sx={{ pt: '28px !important' }}>
                <Typography sx={{ color: '#aeb8c8', fontWeight: 900, letterSpacing: 1.5, mb: 1.5 }}>EXPORT FORMAT</Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, gap: 2, mb: 4 }}>
                    {FORMATS.map(option => {
                        const Icon = option.icon;
                        const active = format === option.id;
                        return (
                            <Button
                                key={option.id}
                                onClick={() => setFormat(option.id)}
                                startIcon={<Icon size={23} />}
                                sx={{
                                    py: 1.8,
                                    fontSize: '1rem',
                                    fontWeight: 900,
                                    color: active ? '#fff' : '#aeb8c8',
                                    bgcolor: active ? option.color : 'transparent',
                                    border: `1px solid ${active ? option.color : '#718096'}`,
                                    '&:hover': { bgcolor: active ? option.color : '#465267' }
                                }}
                            >
                                {option.label}
                            </Button>
                        );
                    })}
                </Box>

                <Typography sx={{ color: '#aeb8c8', fontWeight: 900, letterSpacing: 1.5 }}>SELECT PARAMETERS TO EXPORT</Typography>
                <Box sx={{ display: 'flex', gap: 1, my: 1.5 }}>
                    <Button size="small" onClick={() => setSelectedKeys(parameters.map(parameter => parameter.key))} sx={{ bgcolor: '#475569', color: '#fff', fontWeight: 700 }}>Select All</Button>
                    <Button size="small" onClick={() => setSelectedKeys([])} sx={{ bgcolor: '#475569', color: '#fff', fontWeight: 700 }}>Deselect All</Button>
                </Box>
                <Paper sx={{ bgcolor: '#273449', border: '1px solid #43516a', p: 1.5, maxHeight: 270, overflowY: 'auto', mb: 4 }}>
                    {groupedParameters.map(([group, items]) => (
                        <Box key={group} sx={{ mb: 1.5 }}>
                            <Typography variant="caption" sx={{ color: '#38bdf8', fontWeight: 900, letterSpacing: 1 }}>{group.toUpperCase()}</Typography>
                            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' }, gap: 0.7, mt: 0.5 }}>
                                {items.map(parameter => {
                                    const checked = selectedKeys.includes(parameter.key);
                                    return (
                                        <FormControlLabel
                                            key={parameter.key}
                                            sx={{
                                                m: 0,
                                                px: 0.7,
                                                borderRadius: 1,
                                                border: `1px solid ${checked ? '#d6a712' : 'transparent'}`,
                                                bgcolor: checked ? 'rgba(214, 167, 18, 0.12)' : 'transparent'
                                            }}
                                            control={
                                                <Checkbox
                                                    size="small"
                                                    checked={checked}
                                                    onChange={() => toggleParameter(parameter.key)}
                                                    sx={{ color: '#718096', '&.Mui-checked': { color: '#fbbf24' } }}
                                                />
                                            }
                                            label={
                                                <Typography variant="body2" sx={{ color: checked ? '#fbbf24' : '#b8c1cf', fontWeight: checked ? 800 : 500 }}>
                                                    {parameter.label}{parameter.unit ? ` (${parameter.unit})` : ''}
                                                </Typography>
                                            }
                                        />
                                    );
                                })}
                            </Box>
                        </Box>
                    ))}
                </Paper>

                <Typography sx={{ color: '#aeb8c8', fontWeight: 900, letterSpacing: 1.5, mb: 1.5 }}>QUICK SELECT</Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' }, gap: 1.5, mb: 4 }}>
                    {QUICK_RANGES.map(option => {
                        const active = range === option.value;
                        return (
                            <Button
                                key={option.value}
                                onClick={() => setRange(option.value)}
                                sx={{
                                    py: 1.25,
                                    fontWeight: 800,
                                    color: active ? '#111827' : '#cbd5e1',
                                    bgcolor: active ? '#fbbf24' : 'transparent',
                                    border: `1px solid ${active ? '#fbbf24' : '#64748b'}`,
                                    '&:hover': { bgcolor: active ? '#fbbf24' : '#465267' }
                                }}
                            >
                                {option.label}
                            </Button>
                        );
                    })}
                </Box>

                <Typography sx={{ color: '#aeb8c8', fontWeight: 900, letterSpacing: 1.5, mb: 1.5 }}>CUSTOM DATE RANGE</Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2, mb: 3 }}>
                    <TextField
                        type="datetime-local"
                        label="From"
                        value={customRange.start}
                        onFocus={() => setRange('custom')}
                        onChange={event => {
                            setRange('custom');
                            setCustomRange(current => ({ ...current, start: event.target.value }));
                        }}
                        InputLabelProps={{ shrink: true }}
                        sx={{ '& .MuiInputBase-root': { bgcolor: '#1f2a3b', color: '#fff' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                    />
                    <TextField
                        type="datetime-local"
                        label="To"
                        value={customRange.end}
                        onFocus={() => setRange('custom')}
                        onChange={event => {
                            setRange('custom');
                            setCustomRange(current => ({ ...current, end: event.target.value }));
                        }}
                        InputLabelProps={{ shrink: true }}
                        sx={{ '& .MuiInputBase-root': { bgcolor: '#1f2a3b', color: '#fff' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                    />
                </Box>

                {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
                <Box sx={{ p: 2.2, bgcolor: '#101827', borderRadius: 2, display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Download color="#94a3b8" />
                    <Typography sx={{ color: '#d6deea' }}>
                        Will export <strong style={{ color: '#fbbf24' }}>{rangeSummary}</strong> of data for{' '}
                        <strong style={{ color: '#60a5fa' }}>{selectedParameters.length} selected parameters</strong>.
                    </Typography>
                </Box>
            </DialogContent>
            <DialogActions sx={{ px: 3, pb: 3, gap: 1.5 }}>
                <Button onClick={onClose} disabled={loading} sx={{ color: '#cbd5e1', fontWeight: 800 }}>Cancel</Button>
                <Button
                    variant="contained"
                    onClick={handleDownload}
                    disabled={loading || selectedParameters.length === 0}
                    startIcon={loading ? <CircularProgress size={18} color="inherit" /> : <Download />}
                    sx={{ minWidth: 205, bgcolor: '#22c55e', color: '#07140b', fontWeight: 900, '&:hover': { bgcolor: '#16a34a' } }}
                >
                    {loading ? 'PREPARING...' : `DOWNLOAD .${format.toUpperCase()}`}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
