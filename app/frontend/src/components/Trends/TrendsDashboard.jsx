import React, { useState, useEffect } from 'react';
import { Box, Typography, Paper, Grid, Checkbox, FormControlLabel, FormGroup, Accordion, AccordionSummary, AccordionDetails, Button, ClickAwayListener } from '@mui/material';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { ChevronDown, RefreshCw, Download, Clock } from 'lucide-react';
import { isLiveRigPayload, socket } from '../../socket';
import axios from '../../api';
import DataExportDialog from '../Common/DataExportDialog';
import edrCatalog from '../../../../shared/edrMetrics.json';

const AVAILABLE_METRICS = {
    drilling: ['wob', 'bit_depth', 'hole_depth', 'rop', 'rpm', 'torque', 'delta_torque'],
    drawworks: ['hook_load', 'block_position'],
    mudpump: ['spm', 'pressure', 'total_spm', 'flow_in', 'flow_out'],
    fluid: ['total_tank_volume', 'tank_gain_loss', 'trip_tank'],
    cat_engine: ['rpm', 'load', 'coolant_temp', 'fuel_pressure', 'oil_pressure', 'battery_voltage', 'fuel_rate'],
    htd: ['rpm', 'torque', 'inclination', 'vertical_speed'],
    hpu: ['aux_pressure', 'discharge_pressure', 'oil_temp', 'oil_level'],
    pct: ['makeup_torque', 'last_makeup_torque', 'clamp_up_pressure', 'clamp_low_pressure', 'clamp_up_force', 'clamp_low_force'],
    cwk: ['clamp_pressure', 'clamp_force'],
    acs: ['crownsaver', 'floorsaver', 'bottomsaver', 'upper_tag', 'lower_tag']
};

const COLORS = [
    '#38bdf8', '#a78bfa', '#34d399', '#fb7185', '#fbbf24', '#e879f9', '#22c55e', '#ef4444', '#f59e0b', '#60a5fa'
];

const METRIC_ALIASES = {
    'drilling.hook_load': 'drawworks.hook_load',
    'mudpump.flow_out_percentage': 'mudpump.flow_out',
    'acs.block_position': 'drawworks.block_position'
};

const catalogMetrics = new Map(edrCatalog.categories.flatMap(category => (
    category.fields.map(field => [
        `${category.id}.${field.id}`,
        { ...field, group: category.label }
    ])
)));
const categoryLabels = new Map(edrCatalog.categories.map(category => [category.id, category.label]));

const EXPORT_META_ALIASES = {
    'mudpump.flow_out': 'mudpump.flow_out_percentage'
};

const titleCase = value => value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());

const TREND_EXPORT_PARAMETERS = Object.entries(AVAILABLE_METRICS).flatMap(([measurement, fields]) => (
    fields.map(field => {
        const key = `${measurement}.${field}`;
        const metadata = catalogMetrics.get(EXPORT_META_ALIASES[key] || key);
        return {
            key,
            label: metadata?.label || titleCase(field),
            group: metadata?.group || categoryLabels.get(measurement) || titleCase(measurement),
            unit: metadata?.unit || '',
            precision: 2
        };
    })
));

const formatTrendValue = (value, fallback = '---') => {
    if (value === null || value === undefined || value === '') return fallback;
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) return ['cat_rpm', 'htd_rpm', 'cat_load', 'htd_torque', 'ahtd_torque', 'spm', 'rop', 'SPP-Bar', 'pump_pressure', 'block_position'].includes(key) ? Math.round(numericValue).toString() : numericValue.toFixed(2);
    return value;
};

export default function TrendsDashboard() {
    const [data, setData] = useState([]);
    const [selectedMetrics, setSelectedMetrics] = useState(() => {
        const saved = localStorage.getItem('liveTrendsSelectedMetrics');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                const normalized = parsed.map(metric => METRIC_ALIASES[metric] || metric);
                // Filter out any metrics that are no longer in AVAILABLE_METRICS.
                return [...new Set(normalized)].filter(metric => {
                    const [meas, field] = metric.split('.');
                    return AVAILABLE_METRICS[meas]?.includes(field);
                });
            } catch (e) {
                console.error('Error parsing saved metrics', e);
            }
        }
        return [];
    });
    const [showParams, setShowParams] = useState(false);
    const [showCustomDate, setShowCustomDate] = useState(false);
    const [isExportOpen, setIsExportOpen] = useState(false);

    const [timeRange, setTimeRange] = useState(() => localStorage.getItem('liveTrendsTimeRange') || '-15m');
    const [customRange, setCustomRange] = useState(() => {
        const saved = localStorage.getItem('liveTrendsCustomRange');
        return saved ? JSON.parse(saved) : { start: '', end: '' };
    });
    const [isCustom, setIsCustom] = useState(() => localStorage.getItem('liveTrendsIsCustom') === 'true');

    // How many ms worth of data to keep for each range
    const getRangeMs = (range) => {
        if (range === '-1m') return 60 * 1000;
        if (range === '-5m') return 5 * 60 * 1000;
        if (range === '-10m') return 10 * 60 * 1000;
        if (range === '-15m') return 15 * 60 * 1000;
        if (range === '-1h') return 60 * 60 * 1000;
        if (range === '-12h') return 12 * 60 * 60 * 1000;
        if (range === '-24h') return 24 * 60 * 60 * 1000;
        return 15 * 60 * 1000;
    };

    // Fetch history from API
    const fetchHistory = async () => {
        try {
            let url = '/api/history';
            if (customRange.start && customRange.end) {
                url += `?start=${new Date(customRange.start).toISOString()}&stop=${new Date(customRange.end).toISOString()}`;
            } else {
                url += `?range=${timeRange}`;
            }

            const res = await axios.get(url);
            if (res.data && res.data.length > 0) {
                setData(prev => {
                    // Combine fetched history with any live data points that arrived while we were fetching
                    const merged = [...res.data, ...prev];

                    // Deduplicate by timestamp (live and history may have overlapping seconds)
                    const uniqueMap = new Map();
                    merged.forEach(item => {
                        if (!uniqueMap.has(item.timestamp)) {
                            uniqueMap.set(item.timestamp, item);
                        } else {
                            // If a point exists in both history and live stream, merge the object fields
                            // This ensures we get all fields (e.g. if one had missing parameters)
                            uniqueMap.set(item.timestamp, { ...uniqueMap.get(item.timestamp), ...item });
                        }
                    });

                    // Sort by timestamp
                    const uniqueArr = Array.from(uniqueMap.values());
                    return uniqueArr.sort((a, b) => a.timestamp - b.timestamp);
                });
            } else {
                if (isCustom || (customRange.start && customRange.end)) {
                    // Only clear data if we explicitly asked for a custom range and got nothing
                    setData([]);
                }
            }
        } catch (err) {
            console.error("Failed to fetch history", err);
            if (isCustom || (customRange.start && customRange.end)) {
                setData([]);
            }
        }
    };

    useEffect(() => {
        // Save selected metrics to localStorage whenever they change
        localStorage.setItem('liveTrendsSelectedMetrics', JSON.stringify(selectedMetrics));
    }, [selectedMetrics]);

    useEffect(() => {
        localStorage.setItem('liveTrendsTimeRange', timeRange);
    }, [timeRange]);

    useEffect(() => {
        localStorage.setItem('liveTrendsCustomRange', JSON.stringify(customRange));
    }, [customRange]);

    useEffect(() => {
        localStorage.setItem('liveTrendsIsCustom', isCustom.toString());
    }, [isCustom]);

    useEffect(() => {
        // Fetch historical data from API
        if (!isCustom) fetchHistory();

        // Always subscribe to live socket data for preset ranges
        if (!isCustom) {
            const handleSocketData = (newData) => {
                if (!isLiveRigPayload(newData)) { setData([]); return; }
                setData(prev => {
                    const now = new Date();
                    const newPoint = {
                        name: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
                        timestamp: now.getTime()
                    };

                    Object.keys(newData).forEach(measurement => {
                        if (typeof newData[measurement] === 'object' && newData[measurement] !== null) {
                            Object.keys(newData[measurement]).forEach(field => {
                                newPoint[`${measurement}.${field}`] = newData[measurement][field];
                            });
                        }
                    });

                    // Ensure all selected metrics have at least a 0 value if missing
                    selectedMetrics.forEach(metric => {
                        if (newPoint[metric] === undefined) {
                            newPoint[metric] = 0;
                        }
                    });

                    const updated = [...prev, newPoint];

                    // Ensure array is strictly sorted by timestamp for Recharts' time scale
                    const sorted = updated.sort((a, b) => a.timestamp - b.timestamp);

                    // Trim data older than the selected range
                    const cutoff = now.getTime() - getRangeMs(timeRange);
                    const trimmed = sorted.filter(pt => (pt.timestamp || 0) >= cutoff);

                    // Also cap at max 10000 points to prevent memory issues
                    if (trimmed.length > 10000) trimmed.splice(0, trimmed.length - 10000);

                    return trimmed;
                });
            };
            socket.on('rig_data', handleSocketData);
            return () => socket.off('rig_data', handleSocketData);
        }
    }, [timeRange, isCustom]);

    const applyCustomRange = () => {
        if (customRange.start && customRange.end) {
            setIsCustom(true);
            fetchHistory();
        }
    };

    const handlePresetClick = (val) => {
        setIsCustom(false);
        setTimeRange(val);
        setCustomRange({ start: '', end: '' });
    };

    const handleToggle = (measurement, field) => {
        const key = `${measurement}.${field}`;
        setSelectedMetrics(prev =>
            prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
        );
    };

    return (
        <Box sx={{ height: 'calc(100vh - 100px)', display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2, alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                <Typography variant="h5" sx={{ fontWeight: 'bold' }}>Live Parameter Trends</Typography>

                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    {/* Parameters Dropdown Button */}
                    <ClickAwayListener onClickAway={() => setShowParams(false)}>
                        <Box sx={{ position: 'relative' }}>
                            <Button
                                variant="outlined"
                                onClick={() => setShowParams(!showParams)}
                                endIcon={<ChevronDown />}
                                sx={{ color: 'white', borderColor: '#334155', height: '100%', bgcolor: '#1e293b' }}
                            >
                                PARAMETERS
                            </Button>
                            {showParams && (
                                <Paper sx={{ position: 'absolute', top: '100%', left: 0, mt: 1, p: 2, bgcolor: '#0f172a', border: '1px solid #334155', zIndex: 50, width: 'max-content', maxWidth: '80vw', maxHeight: '400px', overflowY: 'auto' }}>
                                    <FormGroup sx={{ gap: 0.5, flexDirection: 'column' }}>
                                        {Object.entries(AVAILABLE_METRICS).map(([measurement, fields]) => (
                                            <Box key={measurement} sx={{ mt: measurement === 'drilling' ? 0 : 2 }}>
                                                <Typography variant="caption" sx={{ color: '#38bdf8', fontWeight: 'bold', display: 'block', mb: 1, borderBottom: '1px solid #334155', pb: 0.5 }}>
                                                    {measurement.toUpperCase().replace(/_/g, ' ')}
                                                </Typography>
                                                {fields.map(field => {
                                                    const key = `${measurement}.${field}`;
                                                    return (
                                                        <FormControlLabel
                                                            key={key}
                                                            sx={{ minWidth: '200px', ml: 0 }}
                                                            control={
                                                                <Checkbox
                                                                    checked={selectedMetrics.includes(key)}
                                                                    onChange={() => handleToggle(measurement, field)}
                                                                    sx={{ color: '#94a3b8', '&.Mui-checked': { color: '#38bdf8' }, py: 0.5 }}
                                                                />
                                                            }
                                                            label={
                                                                <Typography variant="body2" sx={{ color: '#cbd5e1' }}>
                                                                    {field.replace(/_/g, ' ')}
                                                                </Typography>
                                                            }
                                                        />
                                                    );
                                                })}
                                            </Box>
                                        ))}
                                    </FormGroup>
                                </Paper>
                            )}
                        </Box>
                    </ClickAwayListener>

                    {/* Watch Symbol for Custom Range Dropdown */}
                    <Box sx={{ position: 'relative' }}>
                        <Button
                            variant="outlined"
                            onClick={() => setShowCustomDate(!showCustomDate)}
                            sx={{ color: 'white', borderColor: '#334155', height: '100%', bgcolor: '#1e293b', minWidth: '40px', px: 1 }}
                        >
                            <Clock size={20} />
                        </Button>
                        {showCustomDate && (
                            <Paper sx={{ position: 'absolute', top: '100%', left: 0, mt: 1, p: 2, bgcolor: '#0f172a', border: '1px solid #334155', zIndex: 50, width: 'max-content' }}>
                                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                                    <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem', fontWeight: 'bold' }}>CUSTOM RANGE</Typography>
                                    <input
                                        type="datetime-local"
                                        style={{ background: 'transparent', color: 'white', border: '1px solid #334155', borderRadius: '4px', padding: '4px', colorScheme: 'dark' }}
                                        onChange={(e) => setCustomRange(prev => ({ ...prev, start: e.target.value }))}
                                    />
                                    <span style={{ color: '#94a3b8' }}>-</span>
                                    <input
                                        type="datetime-local"
                                        style={{ background: 'transparent', color: 'white', border: '1px solid #334155', borderRadius: '4px', padding: '4px', colorScheme: 'dark' }}
                                        onChange={(e) => setCustomRange(prev => ({ ...prev, end: e.target.value }))}
                                    />
                                    <Button variant="contained" size="small" onClick={() => { applyCustomRange(); setShowCustomDate(false); }} sx={{ ml: 1 }}>Go</Button>
                                </Box>
                            </Paper>
                        )}
                    </Box>

                    <Box sx={{ width: '1px', height: '24px', bgcolor: '#334155', mx: 1 }} />

                    {[
                        { label: '1m', val: '-1m' },
                        { label: '5m', val: '-5m' },
                        { label: '10m', val: '-10m' },
                        { label: '15m', val: '-15m' },
                        { label: '1h', val: '-1h' },
                        { label: '12h', val: '-12h' },
                        { label: '24h', val: '-24h' }
                    ].map((opt) => (
                        <Button
                            key={opt.val}
                            variant={!isCustom && timeRange === opt.val ? "contained" : "outlined"}
                            onClick={() => handlePresetClick(opt.val)}
                            size="small"
                            sx={{
                                bgcolor: !isCustom && timeRange === opt.val ? '#38bdf8' : 'transparent',
                                color: !isCustom && timeRange === opt.val ? '#0f172a' : '#94a3b8',
                                borderColor: '#334155',
                                minWidth: '40px'
                            }}
                        >
                            {opt.label}
                        </Button>
                    ))}

                    <Button variant="outlined" startIcon={<Download />} onClick={() => setIsExportOpen(true)} sx={{ color: '#fbbf24', borderColor: '#fbbf24', ml: 2, '&:hover': { bgcolor: 'rgba(251, 191, 36, 0.1)' } }}>
                        Export
                    </Button>

                    <Button variant="outlined" startIcon={<RefreshCw />} onClick={fetchHistory} sx={{ color: '#38bdf8', borderColor: '#334155', ml: 1 }}>
                        Resync
                    </Button>
                </Box>
            </Box>

            <Grid container spacing={2} sx={{ flexGrow: 1, minHeight: 0 }}>
                {/* Vertical Parameter List (Left Sidebar) */}
                <Grid item xs={12} md={3} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%', overflowY: 'auto', border: '1px solid #334155' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2, fontWeight: 'bold' }}>SELECTED PARAMETERS</Typography>
                        {selectedMetrics.length === 0 ? (
                            <Typography variant="caption" sx={{ color: '#475569', fontStyle: 'italic' }}>No parameters selected. Use the dropdown above.</Typography>
                        ) : (
                            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                {selectedMetrics.map((key, index) => {
                                    const [meas, field] = key.split('.');
                                    const latestVal = data.length > 0 ? (data[data.length - 1][key] ?? '---') : '---';
                                    const color = COLORS[index % COLORS.length];

                                    return (
                                        <Box key={key} sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 2, borderLeft: `4px solid ${color}`, display: 'flex', flexDirection: 'column' }}>
                                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
                                                <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', fontSize: '0.65rem' }}>
                                                    {meas.toUpperCase().replace('_', ' ')}
                                                </Typography>
                                                <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: color, boxShadow: `0 0 8px ${color}` }} />
                                            </Box>
                                            <Typography variant="body2" sx={{ color: 'white', fontWeight: 'bold', mb: 0.5 }}>
                                                {field.replace(/_/g, ' ').toUpperCase()}
                                            </Typography>
                                            <Typography variant="h5" sx={{ color: color, fontWeight: 'bold', textAlign: 'right', fontFamily: '"Orbitron", sans-serif' }}>
                                                {formatTrendValue(latestVal)}
                                            </Typography>
                                        </Box>
                                    );
                                })}
                            </Box>
                        )}
                    </Paper>
                </Grid>

                {/* Main Chart (Right Side) */}
                <Grid item xs={12} md={9} sx={{ height: '100%' }}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%', position: 'relative', border: '1px solid #334155' }}>
                        {data.length === 0 && (
                            <Box sx={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', zIndex: 1, width: '80%' }}>
                                <Typography variant="h6" sx={{ color: '#64748b', mb: 1 }}>No Data Available {isCustom ? 'For This Custom Range' : ''}</Typography>
                                <Typography variant="body2" sx={{ color: '#475569' }}>
                                    {isCustom
                                        ? "There is no historical data recorded corresponding to the selected time range. Try a different range."
                                        : "Waiting for live data... Select parameters to begin tracking."}
                                </Typography>
                            </Box>
                        )}
                        {data.length > 0 && (
                            <Box sx={{ position: 'absolute', top: 8, right: 16, zIndex: 1, display: 'flex', gap: 2 }}>
                                <Typography variant="caption" sx={{ color: '#64748b' }}>
                                    {data.length} points
                                </Typography>
                            </Box>
                        )}
                        {data.length > 0 && (
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={data}>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                    <XAxis
                                        dataKey="timestamp"
                                        type="number"
                                        scale="time"
                                        domain={isCustom ? ['dataMin', 'dataMax'] : [
                                            data.length > 0 ? Math.max(data[0].timestamp, Date.now() - getRangeMs(timeRange)) : Date.now() - getRangeMs(timeRange),
                                            Date.now()
                                        ]}
                                        stroke="#94a3b8"
                                        tickFormatter={(unixTime) => {
                                            if (!unixTime || isNaN(unixTime)) return '';
                                            const date = new Date(unixTime);
                                            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                                        }}
                                        angle={-30}
                                        textAnchor="end"
                                        height={50}
                                        minTickGap={30}
                                        fontSize={11}
                                    />
                                    <YAxis stroke="#94a3b8" tickFormatter={(value) => formatTrendValue(value, '')} />
                                    <Tooltip
                                        labelFormatter={(unixTime) => {
                                            if (!unixTime || isNaN(unixTime)) return '';
                                            return new Date(unixTime).toLocaleString();
                                        }}
                                        formatter={(value, name) => [formatTrendValue(value), name]}
                                        contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 8 }}
                                        itemStyle={{ color: '#e2e8f0' }}
                                    />
                                    <Legend verticalAlign="top" height={36} />
                                    {selectedMetrics.map((key, index) => (
                                        <Line
                                            key={key}
                                            type="monotone"
                                            dataKey={key}
                                            name={`${key.split('.')[0].toUpperCase().replace('_', ' ')} - ${key.split('.')[1].replace(/_/g, ' ').toUpperCase()}`}
                                            stroke={COLORS[index % COLORS.length]}
                                            dot={false}
                                            strokeWidth={2}
                                            isAnimationActive={false}
                                            connectNulls={true}
                                        />
                                    ))}
                                </LineChart>
                            </ResponsiveContainer>
                        )}
                    </Paper>
                </Grid>
            </Grid>
            <DataExportDialog
                open={isExportOpen}
                onClose={() => setIsExportOpen(false)}
                title="Live Parameter Trends"
                filePrefix="AHWR-Live-Trends"
                parameters={TREND_EXPORT_PARAMETERS}
                defaultSelected={selectedMetrics}
                fallbackRows={data}
            />
        </Box>
    );
}
