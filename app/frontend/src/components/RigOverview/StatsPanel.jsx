import React, { useState, useEffect } from 'react';
import { Box, Paper, Typography, IconButton, Grid, Dialog, DialogTitle, DialogContent, FormControl, InputLabel, Select, MenuItem, Button, DialogActions } from '@mui/material';
import { Settings, Edit2, Plus, Trash2 } from 'lucide-react';

const AVAILABLE_METRICS = [
    { key: 'hook_load', label: 'WOH', unit: 'tons' },
    { key: 'wob', label: 'WOB', unit: 'kips' },
    { key: 'rop', label: 'Rate of Penetration', unit: 'm/h' },
    { key: 'bit_depth', label: 'Bit Depth', unit: 'm' },
    { key: 'hole_depth', label: 'TOTAL DEPTH', unit: 'm' },
    { key: 'block_position', label: 'Block Position', unit: 'mm' },
    { key: 'pump_pressure', label: 'SPP', unit: 'Bar' },
    { key: 'torque', label: 'Drill String Torque', unit: 'daN·m' },
    { key: 'flow_in', label: 'Flow In', unit: 'Lt/min' },
    { key: 'flow_out', label: 'Flow Out', unit: '%' },
    { key: 'trip_tank', label: 'Trip Tank', unit: 'm³' },
    { key: 'total_active_volume', label: 'Total Active Volume', unit: 'm³' },
    { key: 'htd_rpm', label: 'HTD RPM', unit: 'RPM' },
    { key: 'htd_torque', label: 'HTD Torque', unit: 'Nm' },
    { key: 'pct_torque', label: 'PCT Torque', unit: 'daN·m' },
    { key: 'acs_status', label: 'ACS', unit: '' },
];

const DEFAULT_CONFIG = [
    { key: 'hook_load', label: 'HOOK LOAD', unit: 'tons' },
    { key: 'bit_depth', label: 'BIT DEPTH', unit: 'm' },
    { key: 'wob', label: 'WOB', unit: 'kips' },
    { key: 'hole_depth', label: 'TOTAL DEPTH', unit: 'm' },
    { key: 'pump_pressure', label: 'SPP', unit: 'Bar' },
    { key: 'torque', label: 'TORQUE', unit: 'daN·m' },
    { key: 'htd_rpm', label: 'HTD RPM', unit: 'RPM' },
    { key: 'flow_in', label: 'FLOW IN', unit: 'Lt/min' },
    { key: 'flow_out', label: 'FLOW OUT', unit: '%' },
    { key: 'trip_tank', label: 'TRIP TANK', unit: 'm³' },
    { key: 'total_active_volume', label: 'TOTAL VOLUME', unit: 'm³' },
    { key: 'rop', label: 'ROP', unit: 'm/h' },
    { key: 'block_position', label: 'BLOCK POS', unit: 'mm' }
];

const MAX_SLOTS = 18;

// Helper to ensure config has exactly MAX_SLOTS
const padConfig = (cfg) => {
    const padded = [...cfg];
    while (padded.length < MAX_SLOTS) {
        padded.push(null);
    }
    return padded.slice(0, MAX_SLOTS);
};

const StatsPanel = ({ rigData }) => {
    const [config, setConfig] = useState(padConfig(DEFAULT_CONFIG));
    const [editMode, setEditMode] = useState(false);
    const [editingSlot, setEditingSlot] = useState(null); // Index of slot being edited
    const [isDialogOpen, setIsDialogOpen] = useState(false);

    // Drag state
    const [draggedIndex, setDraggedIndex] = useState(null);

    // Temporary state for the dialog
    const [tempConfig, setTempConfig] = useState({ key: '', label: '', unit: '' });

    useEffect(() => {
        const saved = localStorage.getItem('romii_stats_panel_config_v3');
        if (saved) {
            setConfig(padConfig(JSON.parse(saved)));
        }
    }, []);

    const saveConfig = (newConfig) => {
        const paddedConfig = padConfig(newConfig);
        setConfig(paddedConfig);
        localStorage.setItem('romii_stats_panel_config_v3', JSON.stringify(paddedConfig));
    };

    const handleEditClick = (index) => {
        if (!editMode) return;
        setEditingSlot(index);
        const current = config[index];
        setTempConfig(current);
        setIsDialogOpen(true);
    };

    const handleSaveSlot = () => {
        const newConfig = [...config];
        // Auto-set label and unit based on key if not manually overriden (simplification: just take defaults)
        const metric = AVAILABLE_METRICS.find(m => m.key === tempConfig.key);

        newConfig[editingSlot] = {
            key: tempConfig.key,
            label: metric ? metric.label.toUpperCase() : 'UNKNOWN',
            unit: metric ? metric.unit : ''
        };

        saveConfig(newConfig);
        setIsDialogOpen(false);
    };

    const handleRemoveSlot = () => {
        const newConfig = [...config];
        newConfig[editingSlot] = null;
        saveConfig(newConfig);
        setIsDialogOpen(false);
    };

    const handleAddSlot = (index) => {
        const newConfig = [...config];
        newConfig[index] = { key: 'hook_load', label: 'HOOK LOAD', unit: 'tons' };
        saveConfig(newConfig);

        // Open edit dialog immediately for the new slot
        setEditingSlot(index);
        setTempConfig(newConfig[index]);
        setIsDialogOpen(true);
    };

    // --- Drag & Drop Handlers ---
    const handleDragStart = (e, index) => {
        if (!editMode) return;
        setDraggedIndex(index);
        e.dataTransfer.effectAllowed = 'move';
        // Make it slightly transparent while dragging
        setTimeout(() => {
            if (e.target) e.target.style.opacity = '0.5';
        }, 0);
    };

    const handleDragOver = (e, index) => {
        e.preventDefault(); // Necessary to allow dropping
        e.dataTransfer.dropEffect = 'move';
    };

    const handleDragEnter = (e) => {
        e.preventDefault();
    };

    const handleDrop = (e, dropIndex) => {
        e.preventDefault();
        if (!editMode || draggedIndex === null || draggedIndex === dropIndex) return;

        const newConfig = [...config];

        // Swap dragged item with dropped slot
        const temp = newConfig[dropIndex];
        newConfig[dropIndex] = newConfig[draggedIndex];
        newConfig[draggedIndex] = temp;

        saveConfig(newConfig);
        setDraggedIndex(null);
    };

    const handleDragEnd = (e) => {
        if (e.target) e.target.style.opacity = '1';
        setDraggedIndex(null);
    };

    const getValue = (key) => {
        // Handle nested or flat data if needed, but rigData passed is usually flat from Dashboard
        let val = rigData[key];
        if (val === undefined || val === null) return '0';
        if (typeof val === 'number') {
            if (key === 'acs_status') {
                switch (val) {
                    case 1: return "ON";
                    case 2: return "OFF";
                    case 3: return "DISABLE";
                    default: return "UNKNOWN";
                }
            }
            if (['cat_rpm', 'htd_rpm', 'cat_load', 'htd_torque', 'ahtd_torque', 'spm', 'rop', 'SPP-Bar', 'pump_pressure', 'block_position'].includes(key)) return Math.round(val);
            if (key.includes('depth')) return val.toFixed(2);
            if (key === 'wob') return val.toFixed(2);
            return val.toFixed(2);
        }
        return val;
    };

    return (
        <Box sx={{ mb: 0 }}>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1, px: 1 }}>
                <IconButton
                    size="small"
                    onClick={() => setEditMode(!editMode)}
                    sx={{
                        color: editMode ? '#fbbf24' : '#64748b',
                        bgcolor: editMode ? 'rgba(251, 191, 36, 0.1)' : 'transparent',
                        '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' }
                    }}
                >
                    <Settings size={14} />
                </IconButton>
            </Box>

            <Grid container spacing={2} columns={{ xs: 2, sm: 3, md: 6 }}>
                {config.map((item, index) => {
                    const isEmpty = item === null;

                    if (isEmpty && !editMode) {
                        return <Grid item xs={1} key={index} sx={{ height: '86px' }} />;
                    }

                    if (isEmpty && editMode) {
                        return (
                            <Grid
                                item xs={1} key={index}
                                sx={{ display: 'flex' }}
                                onDragOver={(e) => handleDragOver(e, index)}
                                onDragEnter={handleDragEnter}
                                onDrop={(e) => handleDrop(e, index)}
                            >
                                <Paper
                                    onClick={() => handleAddSlot(index)}
                                    sx={{
                                        width: '100%',
                                        p: 1.5,
                                        bgcolor: 'transparent',
                                        color: '#64748b',
                                        textAlign: 'center',
                                        border: '1px dashed #475569',
                                        cursor: 'pointer',
                                        borderRadius: 2,
                                        height: '86px',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        justifyContent: 'center',
                                        alignItems: 'center',
                                        transition: 'all 0.2s',
                                        '&:hover': {
                                            bgcolor: 'rgba(255,255,255,0.05)',
                                            color: 'white',
                                            borderColor: '#64748b'
                                        }
                                    }}
                                >
                                    <Plus size={24} />
                                    <Typography variant="caption" sx={{ mt: 1, fontWeight: 'bold' }}>
                                        ADD PANEL
                                    </Typography>
                                </Paper>
                            </Grid>
                        );
                    }

                    return (
                        <Grid
                            item
                            xs={1}
                            key={index}
                            sx={{ display: 'flex' }}
                            draggable={editMode}
                            onDragStart={(e) => handleDragStart(e, index)}
                            onDragOver={(e) => handleDragOver(e, index)}
                            onDragEnter={handleDragEnter}
                            onDrop={(e) => handleDrop(e, index)}
                            onDragEnd={handleDragEnd}
                        >
                            <Paper
                                onClick={() => handleEditClick(index)}
                                sx={{
                                    width: '100%',
                                    p: 1.5,
                                    bgcolor: '#1e293b',
                                    color: 'white',
                                    textAlign: 'center',
                                    border: editMode ? '1px dashed #fbbf24' : '1px solid #334155',
                                    cursor: editMode ? 'pointer' : 'default',
                                    position: 'relative',
                                    borderRadius: 2,
                                    height: '86px',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    justifyContent: 'space-between',
                                    transition: 'all 0.2s',
                                    opacity: draggedIndex === index ? 0.3 : 1,
                                    '&:hover': {
                                        bgcolor: editMode ? '#334155' : '#1e293b',
                                        transform: editMode ? 'scale(1.02)' : 'none'
                                    }
                                }}
                            >
                                {editMode && (
                                    <Box sx={{ position: 'absolute', top: 5, right: 5, color: '#fbbf24' }}>
                                        <Edit2 size={12} />
                                    </Box>
                                )}
                                <Typography variant="caption" sx={{ color: '#94a3b8', letterSpacing: 1, fontWeight: 'bold' }}>
                                    {item.label}
                                </Typography>
                                <Box sx={{ mt: 'auto' }}>
                                    <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#38bdf8', mt: 0.5 }}>
                                        {getValue(item.key)}
                                        <Typography component="span" variant="caption" sx={{ ml: 0.5, color: '#64748b' }}>
                                            {item.unit}
                                        </Typography>
                                    </Typography>
                                </Box>
                            </Paper>
                        </Grid>
                    );
                })}
            </Grid>

            {/* Config Dialog */}
            <Dialog
                open={isDialogOpen}
                onClose={() => setIsDialogOpen(false)}
                PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 300 } }}
            >
                <DialogTitle>Configure Slot {editingSlot + 1}</DialogTitle>
                <DialogContent>
                    <FormControl fullWidth sx={{ mt: 2 }}>
                        <InputLabel sx={{ color: '#94a3b8' }}>Parameter</InputLabel>
                        <Select
                            value={tempConfig.key}
                            label="Parameter"
                            onChange={(e) => setTempConfig({ ...tempConfig, key: e.target.value })}
                            sx={{ color: 'white', '.MuiOutlinedInput-notchedOutline': { borderColor: '#475569' }, '& .MuiSvgIcon-root': { color: '#94a3b8' } }}
                        >
                            {AVAILABLE_METRICS.map((m) => (
                                <MenuItem key={m.key} value={m.key}>
                                    {m.label} ({m.unit})
                                </MenuItem>
                            ))}
                        </Select>
                    </FormControl>
                </DialogContent>
                <DialogActions sx={{ justifyContent: 'space-between', px: 3, pb: 2 }}>
                    <Button onClick={handleRemoveSlot} color="error" startIcon={<Trash2 size={16} />}>
                        Remove
                    </Button>
                    <Box>
                        <Button onClick={() => setIsDialogOpen(false)} sx={{ color: '#94a3b8', mr: 1 }}>Cancel</Button>
                        <Button onClick={handleSaveSlot} variant="contained" sx={{ bgcolor: '#38bdf8' }}>Save</Button>
                    </Box>
                </DialogActions>
            </Dialog>
        </Box>
    );
};

export default StatsPanel;
