import React, { useState, useEffect } from 'react';
import { Box, Typography, Tabs, Tab, Paper, TextField, Button, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, IconButton, Select, MenuItem, InputLabel, FormControl, Grid, Alert, Snackbar, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';
import { Trash2, Save, Plus, AlertCircle, RefreshCw, Edit2 } from 'lucide-react';
import axios from '../../api';
import { useAuth } from '../../context/AuthContext';

function TabPanel(props) {
    const { children, value, index, ...other } = props;

    return (
        <div
            role="tabpanel"
            hidden={value !== index}
            id={`simple-tabpanel-${index}`}
            aria-labelledby={`simple-tab-${index}`}
            {...other}
        >
            {value === index && (
                <Box sx={{ p: 3 }}>
                    {children}
                </Box>
            )}
        </div>
    );
}

import db119Catalog from '../../../../shared/db119Catalog.json';

export default function AdminPanel() {
    const { user } = useAuth();
    // Defense-in-depth: this panel mutates users / PLC config (admin-only). It is
    // reached via the admin-gated Settings tab, but guard here too so a non-admin
    // can never render it via a direct route/import (backend also enforces 403).
    if (user?.role !== 'admin') {
        return (
            <Box sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
                <AlertCircle size={32} style={{ marginBottom: 8 }} />
                <Typography>Administrator access required.</Typography>
            </Box>
        );
    }
    const [value, setValue] = useState(0);
    const [config, setConfig] = useState({ slaves: [] });
    const [bopConfig, setBopConfig] = useState({
        enabled: true,
        endpoint: 'opc.tcp://host.docker.internal:49320',
        securityMode: 'None',
        securityPolicy: 'None',
        tags: []
    });
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(false);
    const [notification, setNotification] = useState({ open: false, message: '', severity: 'success' });

    // User Dialog State
    const [openUserDialog, setOpenUserDialog] = useState(false);
    const [currentUser, setCurrentUser] = useState({ username: '', password: '', role: 'operator', status: 'active' });
    const [isEditingUser, setIsEditingUser] = useState(false);

    const normalizeS7Scales = (plcConfig) => ({
        ...plcConfig,
        slaves: (plcConfig.slaves || []).map((slave) => {
            if ((slave.protocol || 'modbus') !== 's7comm') return slave;
            return {
                ...slave,
                metrics: (slave.metrics || []).map((metric) => ({
                    ...metric,
                    fields: (metric.fields || []).map((field) => ({
                        ...field,
                        scale: field.scale ?? 1
                    }))
                }))
            };
        })
    });

    // --- S7-1500 Default Template ---
    const loadS7Defaults = (slaveIndex) => {
        const s7Defaults = normalizeS7Scales({
            slaves: [{
            protocol: 's7comm',
            ip: '192.168.0.13',
            port: 102,
            rack: 0,
            slot: 0,
            metrics: [
                {
                    name: "AHWR",
                    tags: { equipment: "DAS" },
                    fields: [
                        { name: "Total Active Tank Volume-m^3", address: "DB5380.R40" },
                        { name: "Active Tank Volume Gain/Loss -m^3", address: "DB5380.R50" },
                        { name: "Trip Tank Active Mud Volume -m^3", address: "DB5380.R56" },
                        { name: "Active TripTank Volume Gain/Loss -%", address: "DB5380.R78" },
                        { name: "Mud Tank 1 Volume -m^3", address: "DB5380.R378" },
                        { name: "Mud Tank 2 Volume -m^3", address: "DB5380.R388" },
                        { name: "Mud Tank 3 Volume -m^3", address: "DB5380.R398" },
                        { name: "Mud Tank 4 Volume -m^3", address: "DB5380.R408" },
                        { name: "Mud Return Flow -%", address: "DB5380.R666" },
                        { name: "Mud Pump Inlet Flow-Lt/min", address: "DB259.R6" },
                        { name: "Mud Pumps Total SPM-SPM", address: "DB416.R2" },
                        { name: "SpeedFdbk_SPM", address: "DB416.R2" },
                        { name: "Mud Pumps Total SPM Backup-SPM", address: "DB416.R114" },
                        { name: "Mud Pumps Total SPM DB166-SPM", address: "DB166.R0" },
                        { name: "Mud Pumps Totals Strokes-Count", address: "DB166.DI56" }
                    ]
                },
                {
                    name: "AHWR",
                    tags: { equipment: "Drilling" },
                    fields: [
                        { name: "Weight on Hook -Ton", address: "DB3191.R0" },
                        { name: "Weight on Bit -Ton", address: "DB3191.R10" },
                        { name: "Bit Depth-m", address: "DB3191.R20" },
                        { name: "TOTAL BIT Depth-m", address: "DB3191.R26" },
                        { name: "Operation-1=DRILLING, 2=TRIP IN, 3=TRIP OUT, 4=CASING", address: "DB3191.B52" },
                        { name: "SLIP IN", address: "DB709.X14.0" },
                        { name: "SLIP OUT", address: "DB709.X14.1" },
                        { name: "SPP-Bar", address: "DB3191.R72" },
                        { name: "Delta SPP-Bar", address: "DB3191.R84" },
                        { name: "ROP-m/h", address: "DB3191.R96" },
                        { name: "Ropes Wear-ton/km", address: "DB3191.R106" },
                        { name: "Delta Torque-daN*m", address: "DB3191.R116" },
                        { name: "Drill String Speed-RPM", address: "DB3191.R128" },
                        { name: "Drill String Torque-daN*m", address: "DB3191.R134" }
                    ]
                },
                {
                    name: "AHWR",
                    tags: { equipment: "CAT" },
                    fields: [
                        { name: "CAT Engine speed RPM", address: "DB119.R100" },
                        { name: "CAT Engine OilPressure", address: "DB119.R128" },
                        { name: "CAT Engine CoolantTemperature", address: "DB119.R116" },
                        { name: "CAT Engine ElectricalPotential", address: "DB119.R140" },
                        { name: "CAT Engine FuelRate", address: "DB119.R136" }
                    ]
                },
                {
                    name: "AHWR",
                    tags: { equipment: "ACS" },
                    fields: [
                        { name: "ACS status-0=UNKNONE, 1=ON, 2=OFF, 3=DISABLE ", address: "DB3591.B0" },
                        { name: "ACS Actual Block Position", address: "DB174.R150" },
                        { name: "ACS Crownsaver in mm", address: "DB65.R6" },
                        { name: "ACS Floorsaver in mm", address: "DB65.R12" },
                        { name: "ACS Bottomsaver in mm", address: "DB65.R18" },
                        { name: "CWK Clamp close pressure", address: "DB2780.R54" },
                        { name: "CWK Clamp-0=NONE, 1=OPENING, 2=CLOSING, 3=IS OPEN, 4=IS CLOSE, 5=FAULT", address: "DB2780.B52" }
                    ]
                },
                {
                    name: "AHWR",
                    tags: { equipment: "HTD" },
                    fields: [
                        { name: "HTD IBOP Status-0= Uncknown, 1 = Opening, 2 = Closing, 3 = Open, 4 = Close, 5 = Fault", address: "DB436.B150" },
                        { name: "HTD Elevator Status-0= Uncknown, 1 = Opening, 2 = Closing, 3 = Open, 4 = Close, 5 = Fault", address: "DB436.B140" },
                        { name: "HTD Brake Status-0=Unknown, 1 = Closing, 2 = Closed, 3 = Opening, 4 = Open, 5 = Fault", address: "DB436.B130" },
                        { name: "HTD vertical speed", address: "DB174.R160" },
                        { name: "HTD Link Tilt status-0 = None, 1 = Float ON, 2 = Vertical, 3 = Float OFF, 4 = Extend, 5 = Retract, 6 = Fault", address: "DB436.B178" },
                        { name: "PCT Sequence-0=OFF, 1=MAKE-UP, 2=BREAK-OUT, 3=RESET, 4=FAULT", address: "DB244.B184" },
                        { name: "PCT SPINNER FLOATING-0=OFF, 1=ON, 10=SPINNER NOT MOUNTED", address: "DB244.B96" },
                        { name: "PCT SpinnerActMakeUpTorque-daN*m", address: "DB244.R72" }
                    ]
                }
            ]
            }]
        }).slaves[0];

        s7Defaults.metrics = s7Defaults.metrics.filter(m => m.tags?.equipment !== 'CAT');
        for (const group of ['CAT ENG-1', 'CAT ENG-2', 'HPU']) {
            s7Defaults.metrics.push({name:'AHWR', tags:{equipment:group, db:'DB119'}, fields:db119Catalog.filter(f=>f.group===group).map(f=>({name:f.name,address:f.address,scale:1}))});
        }
        const newSlaves = [...config.slaves];
        newSlaves[slaveIndex] = { ...newSlaves[slaveIndex], ...s7Defaults };
        setConfig({ ...config, slaves: newSlaves });
        showNotification('S7-1500 Default Configuration Loaded!');
    };

    // Helper to fetch data
    const fetchConfig = async () => {
        try {
            setLoading(true);
            const res = await axios.get('/api/config/plc');
            const data = res.data.slaves ? res.data : { slaves: [] };
            setConfig(normalizeS7Scales(data));
        } catch (err) {
            console.error(err);
            showNotification('Failed to load configuration', 'error');
        } finally {
            setLoading(false);
        }
    };

    const fetchUsers = async () => {
        try {
            setLoading(true);
            const res = await axios.get('/api/users');
            setUsers(res.data);
        } catch (err) {
            console.error(err);
            showNotification('Failed to load users', 'error');
        } finally {
            setLoading(false);
        }
    };

    const fetchBopConfig = async () => {
        try {
            setLoading(true);
            const res = await axios.get('/api/config/bop');
            setBopConfig(res.data);
        } catch (err) {
            console.error(err);
            showNotification('Failed to load OPC UA BOP configuration', 'error');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (value === 0) fetchConfig();
        if (value === 1) fetchBopConfig();
        if (value === 2) fetchUsers();
    }, [value]);

    const handleChange = (event, newValue) => {
        setValue(newValue);
    };

    const showNotification = (msg, severity = 'success') => {
        setNotification({ open: true, message: msg, severity });
    };

    // --- User Actions ---
    const handleOpenUserDialog = (user = null) => {
        if (user) {
            setCurrentUser({ ...user, password: '' }); // Don't show password
            setIsEditingUser(true);
        } else {
            setCurrentUser({ username: '', password: '', role: 'operator', status: 'active' });
            setIsEditingUser(false);
        }
        setOpenUserDialog(true);
    };

    const handleSaveUser = async () => {
        try {
            if (isEditingUser) {
                const payload = { ...currentUser };
                if (!payload.password) delete payload.password; // Don't send empty password if not changing
                await axios.put(`/api/users/${currentUser.id}`, payload);
                showNotification('User updated successfully');
            } else {
                await axios.post('/api/users', currentUser);
                showNotification('User created successfully');
            }
            setOpenUserDialog(false);
            fetchUsers();
        } catch (err) {
            console.error(err);
            showNotification(err.response?.data?.error || 'Failed to save user', 'error');
        }
    };

    const handleDeleteUser = async (id) => {
        if (!window.confirm('Are you sure you want to delete this user?')) return;
        try {
            await axios.delete(`/api/users/${id}`);
            showNotification('User deleted successfully');
            fetchUsers();
        } catch (err) {
            console.error(err);
            showNotification('Failed to delete user', 'error');
        }
    };

    // --- Device Actions ---
    const addSlave = () => {
        const newSlave = {
            id: Date.now(),
            name: `PLC_${config.slaves.length + 1}`,
            protocol: 's7comm',
            ip: '192.168.0.10',
            port: 102,
            rack: 0,
            slot: 0,
            metrics: []
        };
        setConfig({ ...config, slaves: [...config.slaves, newSlave] });
    };

    const removeSlave = (index) => {
        const newSlaves = [...config.slaves];
        newSlaves.splice(index, 1);
        setConfig({ ...config, slaves: newSlaves });
    };

    const updateSlave = (index, field, val) => {
        const newSlaves = [...config.slaves];
        newSlaves[index][field] = val;

        // Default ports when switching protocol
        if (field === 'protocol') {
            newSlaves[index].port = val === 's7comm' ? 102 : 502;
            if (val === 's7comm' && !newSlaves[index].metrics) {
                newSlaves[index].metrics = [];
            }
        }

        setConfig({ ...config, slaves: newSlaves });
    };

    // Modbus Specific
    const addRegister = (slaveIndex) => {
        const newRegister = { name: 'NEW_TAG', address: 40001, type: 'holding_register', dataType: 'INT16', scale: 1.0 };
        const newSlaves = [...config.slaves];
        newSlaves[slaveIndex].registers.push(newRegister);
        setConfig({ ...config, slaves: newSlaves });
    };

    const removeRegister = (slaveIndex, regIndex) => {
        const newSlaves = [...config.slaves];
        newSlaves[slaveIndex].registers.splice(regIndex, 1);
        setConfig({ ...config, slaves: newSlaves });
    };

    const updateRegister = (slaveIndex, regIndex, field, val) => {
        const newSlaves = [...config.slaves];
        newSlaves[slaveIndex].registers[regIndex][field] = val;
        setConfig({ ...config, slaves: newSlaves });
    };

    // S7comm Specific
    const addMetric = (slaveIndex) => {
        const newMetric = { name: 'AHWR', tags: { equipment: 'DAS' }, fields: [] };
        const newSlaves = [...config.slaves];
        if (!newSlaves[slaveIndex].metrics) newSlaves[slaveIndex].metrics = [];
        newSlaves[slaveIndex].metrics.push(newMetric);
        setConfig({ ...config, slaves: newSlaves });
    };

    const addS7Field = (slaveIndex, metricIndex) => {
        const newField = { name: 'NEW_S7_TAG', address: 'DB1.R0', scale: 1 };
        const newSlaves = [...config.slaves];
        newSlaves[slaveIndex].metrics[metricIndex].fields.push(newField);
        setConfig({ ...config, slaves: newSlaves });
    };

    const updateS7Field = (slaveIndex, metricIndex, fieldIndex, field, val) => {
        const newSlaves = [...config.slaves];
        newSlaves[slaveIndex].metrics[metricIndex].fields[fieldIndex] = {
            ...newSlaves[slaveIndex].metrics[metricIndex].fields[fieldIndex],
            [field]: val
        };
        setConfig({ ...config, slaves: newSlaves });
    };

    const saveConfiguration = async () => {
        try {
            setLoading(true);
            const nextConfig = normalizeS7Scales(config);
            const res = await axios.post('/api/config/plc', nextConfig);
            if (res.data.success) {
                setConfig(nextConfig);
                showNotification('Configuration saved and Telegraf restarted!');
            }
        } catch (err) {
            console.error(err);
            showNotification('Failed to save configuration', 'error');
        } finally {
            setLoading(false);
        }
    };

    const updateBop = (field, nextValue) => setBopConfig(prev => ({ ...prev, [field]: nextValue }));
    const updateBopTag = (index, field, nextValue) => {
        setBopConfig(prev => ({
            ...prev,
            tags: prev.tags.map((tag, i) => i === index ? { ...tag, [field]: nextValue } : tag)
        }));
    };
    const saveBopConfiguration = async () => {
        try {
            setLoading(true);
            const res = await axios.post('/api/config/bop', bopConfig);
            if (res.data.success) showNotification('OPC UA BOP configuration saved');
        } catch (err) {
            console.error(err);
            showNotification(err.response?.data?.error || 'Failed to save OPC UA BOP configuration', 'error');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Box sx={{ width: '100%' }}>
            <Box sx={{ borderBottom: 1, borderColor: '#334155' }}>
                <Tabs value={value} onChange={handleChange} textColor="primary" indicatorColor="primary">
                    <Tab label="PLC & S7 Configuration" sx={{ color: '#38bdf8', fontWeight: 'bold' }} />
                    <Tab label="OPC UA / BOP Configuration" sx={{ color: '#fbbf24', fontWeight: 'bold' }} />
                    <Tab label="User Management" sx={{ color: '#94a3b8' }} />
                </Tabs>
            </Box>

            {/* TAB 0: PLC & S7 Configuration */}
            <TabPanel value={value} index={0}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3 }}>
                    <Box>
                        <Typography variant="h5" sx={{ fontWeight: 'bold', mb: 0.5 }}>PLC & Siemens S7 Communication</Typography>
                        <Typography variant="body2" sx={{ color: '#94a3b8' }}>Configure Siemens S7comm protocol data ingestion and scaling.</Typography>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 2 }}>
                        <Button variant="outlined" startIcon={<RefreshCw />} onClick={fetchConfig} sx={{ color: '#38bdf8', borderColor: '#334155' }}>
                            Reload
                        </Button>
                        <Button variant="contained" startIcon={<Save />} onClick={saveConfiguration} disabled={loading} sx={{ bgcolor: '#34d399', '&:hover': { bgcolor: '#10b981' } }}>
                            {loading ? 'Saving...' : 'Save & Apply'}
                        </Button>
                    </Box>
                </Box>

                {config.slaves.map((slave, sIndex) => (
                    <Paper key={slave.id || sIndex} sx={{ p: 3, mb: 3, bgcolor: '#1e293b', border: '1px solid #334155' }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2, alignItems: 'center' }}>
                            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8' }}>
                                    Device #{sIndex + 1}
                                </Typography>
                                <Select
                                    value={slave.protocol || 's7comm'} size="small"
                                    onChange={(e) => updateSlave(sIndex, 'protocol', e.target.value)}
                                    sx={{ bgcolor: '#0f172a', color: 'white', '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' }, '.MuiSvgIcon-root': { color: 'white' } }}
                                >
                                    <MenuItem value="s7comm">Siemens S7comm</MenuItem>
                                </Select>
                                {slave.protocol === 's7comm' && (
                                    <Button size="small" variant="outlined" onClick={() => loadS7Defaults(sIndex)} sx={{ color: '#fbbf24', borderColor: '#fbbf24', '&:hover': { borderColor: '#eab308' } }}>
                                        Load S7-1500 Defaults
                                    </Button>
                                )}
                            </Box>
                            <IconButton size="small" onClick={() => removeSlave(sIndex)} sx={{ color: '#ef4444' }}>
                                <Trash2 size={18} />
                            </IconButton>
                        </Box>

                        <Grid container spacing={2} sx={{ mb: 3 }}>
                            <Grid item xs={12} md={3}>
                                <TextField
                                    label="Name" fullWidth size="small"
                                    value={slave.name} onChange={(e) => updateSlave(sIndex, 'name', e.target.value)}
                                    sx={{ bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                                />
                            </Grid>
                            <Grid item xs={12} md={3}>
                                <TextField
                                    label="IP Address" fullWidth size="small"
                                    value={slave.ip} onChange={(e) => updateSlave(sIndex, 'ip', e.target.value)}
                                    sx={{ bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                                />
                            </Grid>
                            <Grid item xs={12} md={1}>
                                <TextField
                                    label="Port" type="number" fullWidth size="small"
                                    value={slave.port} onChange={(e) => updateSlave(sIndex, 'port', parseInt(e.target.value))}
                                    sx={{ bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                                />
                            </Grid>

                            {slave.protocol === 'modbus' ? (
                                <Grid item xs={12} md={1}>
                                    <TextField
                                        label="Slave ID" type="number" fullWidth size="small"
                                        value={slave.slaveId} onChange={(e) => updateSlave(sIndex, 'slaveId', parseInt(e.target.value))}
                                        sx={{ bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                                    />
                                </Grid>
                            ) : (
                                <>
                                    <Grid item xs={12} md={1}>
                                        <TextField
                                            label="Rack" type="number" fullWidth size="small"
                                            value={slave.rack || 0} onChange={(e) => updateSlave(sIndex, 'rack', parseInt(e.target.value))}
                                            sx={{ bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                                        />
                                    </Grid>
                                    <Grid item xs={12} md={1}>
                                        <TextField
                                            label="Slot" type="number" fullWidth size="small"
                                            value={slave.slot || 0} onChange={(e) => updateSlave(sIndex, 'slot', parseInt(e.target.value))}
                                            sx={{ bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                                        />
                                    </Grid>
                                </>
                            )}
                        </Grid>

                        {slave.protocol === 'modbus' ? (
                            <>
                                <Typography variant="subtitle2" sx={{ mb: 1, color: '#94a3b8' }}>Modbus Registers</Typography>
                                <TableContainer component={Paper} sx={{ bgcolor: '#0f172a', mb: 2, border: '1px solid #334155' }}>
                                    <Table size="small">
                                        <TableHead>
                                            <TableRow>
                                                <TableCell sx={{ color: '#94a3b8' }}>Name</TableCell>
                                                <TableCell sx={{ color: '#94a3b8' }}>Type</TableCell>
                                                <TableCell sx={{ color: '#94a3b8' }}>Addr</TableCell>
                                                <TableCell sx={{ color: '#94a3b8' }}>Data Type</TableCell>
                                                <TableCell sx={{ color: '#94a3b8' }}>Scale</TableCell>
                                                <TableCell align="right"></TableCell>
                                            </TableRow>
                                        </TableHead>
                                        <TableBody>
                                            {slave.registers?.map((reg, rIndex) => (
                                                <TableRow key={rIndex}>
                                                    <TableCell sx={{ color: 'white' }}>
                                                        <TextField
                                                            variant="standard" size="small" fullWidth
                                                            value={reg.name} onChange={(e) => updateRegister(sIndex, rIndex, 'name', e.target.value)}
                                                            InputProps={{ disableUnderline: true, sx: { color: 'white' } }}
                                                        />
                                                    </TableCell>
                                                    <TableCell sx={{ color: 'white' }}>
                                                        <Select
                                                            value={reg.type}
                                                            onChange={(e) => updateRegister(sIndex, rIndex, 'type', e.target.value)}
                                                            variant="standard" size="small" fullWidth disableUnderline
                                                            sx={{ color: 'white', '.MuiSelect-icon': { color: 'white' } }}
                                                        >
                                                            <MenuItem value="holding_register">Holding</MenuItem>
                                                            <MenuItem value="input_register">Input</MenuItem>
                                                            <MenuItem value="coil">Coil</MenuItem>
                                                            <MenuItem value="discrete_input">Discrete</MenuItem>
                                                        </Select>
                                                    </TableCell>
                                                    <TableCell>
                                                        <TextField
                                                            type="number" variant="standard"
                                                            value={reg.address} onChange={(e) => updateRegister(sIndex, rIndex, 'address', parseInt(e.target.value))}
                                                            InputProps={{ disableUnderline: true, sx: { color: 'white' } }}
                                                        />
                                                    </TableCell>
                                                    <TableCell>
                                                        <Select
                                                            value={reg.dataType}
                                                            onChange={(e) => updateRegister(sIndex, rIndex, 'dataType', e.target.value)}
                                                            variant="standard" size="small" fullWidth disableUnderline
                                                            sx={{ color: 'white', '.MuiSelect-icon': { color: 'white' } }}
                                                        >
                                                            <MenuItem value="INT16">INT16</MenuItem>
                                                            <MenuItem value="UINT16">UINT16</MenuItem>
                                                            <MenuItem value="FLOAT32">FLOAT32</MenuItem>
                                                            <MenuItem value="FLOAT32-IEEE">FLOAT32-IEEE</MenuItem>
                                                            <MenuItem value="BOOL">BOOL</MenuItem>
                                                        </Select>
                                                    </TableCell>
                                                    <TableCell>
                                                        <TextField
                                                            type="number" variant="standard"
                                                            value={reg.scale} onChange={(e) => updateRegister(sIndex, rIndex, 'scale', parseFloat(e.target.value))}
                                                            InputProps={{ disableUnderline: true, sx: { color: 'white' } }}
                                                        />
                                                    </TableCell>
                                                    <TableCell align="right">
                                                        <IconButton size="small" onClick={() => removeRegister(sIndex, rIndex)} sx={{ color: '#64748b', '&:hover': { color: '#ef4444' } }}>
                                                            <Trash2 size={14} />
                                                        </IconButton>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </TableContainer>
                                <Button startIcon={<Plus size={16} />} onClick={() => addRegister(sIndex)} sx={{ color: '#38bdf8' }}>
                                    Add Modbus Tag
                                </Button>
                            </>
                        ) : (
                            <>
                                <Typography variant="subtitle2" sx={{ mb: 1, color: '#FBBC24' }}>S7comm Metrics & Tags</Typography>
                                <Typography variant="caption" sx={{ display: 'block', mb: 2, color: '#94a3b8' }}>
                                    Scale factor multiplies the PLC value in live and history screens. Use 1 for no scaling.
                                </Typography>
                                {slave.metrics?.map((metric, mIndex) => (
                                    <Box key={mIndex} sx={{ mb: 2, p: 2, bgcolor: '#0f172a', borderRadius: 1, border: '1px solid #334155' }}>
                                        <Box sx={{ display: 'flex', gap: 2, mb: 1, alignItems: 'center' }}>
                                            <TextField
                                                size="small" label="Metric Name"
                                                value={metric.name} onChange={(e) => {
                                                    const newSlaves = [...config.slaves];
                                                    newSlaves[sIndex].metrics[mIndex].name = e.target.value;
                                                    setConfig({ ...config, slaves: newSlaves });
                                                }}
                                                sx={{ input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                                            />
                                            <TextField
                                                size="small" label="Equipment Tag"
                                                value={metric.tags?.equipment || ''} onChange={(e) => {
                                                    const newSlaves = [...config.slaves];
                                                    newSlaves[sIndex].metrics[mIndex].tags = { ...newSlaves[sIndex].metrics[mIndex].tags, equipment: e.target.value };
                                                    setConfig({ ...config, slaves: newSlaves });
                                                }}
                                                sx={{ input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                                            />
                                        </Box>
                                        <TableContainer sx={{ overflowX: 'auto' }}>
                                            <Table size="small" sx={{ minWidth: 760 }}>
                                                <TableHead>
                                                    <TableRow>
                                                        <TableCell sx={{ color: '#94a3b8' }}>Field Name</TableCell>
                                                        <TableCell sx={{ color: '#94a3b8' }}>Address (DB#.Type#)</TableCell>
                                                        <TableCell sx={{ color: '#94a3b8', width: 140 }}>Scale Factor</TableCell>
                                                        <TableCell align="right"></TableCell>
                                                    </TableRow>
                                                </TableHead>
                                                <TableBody>
                                                    {metric.fields?.map((f, fIndex) => (
                                                        <TableRow key={fIndex}>
                                                            <TableCell>
                                                                <TextField
                                                                    variant="standard" value={f.name} fullWidth size="small"
                                                                    InputProps={{ disableUnderline: true, sx: { color: 'white' } }}
                                                                    onChange={(e) => updateS7Field(sIndex, mIndex, fIndex, 'name', e.target.value)}
                                                                />
                                                            </TableCell>
                                                            <TableCell>
                                                                <TextField
                                                                    variant="standard" value={f.address} fullWidth size="small"
                                                                    InputProps={{ disableUnderline: true, sx: { color: 'white' } }}
                                                                    onChange={(e) => updateS7Field(sIndex, mIndex, fIndex, 'address', e.target.value)}
                                                                />
                                                            </TableCell>
                                                            <TableCell>
                                                                <TextField
                                                                    type="number"
                                                                    variant="standard"
                                                                    value={f.scale ?? 1}
                                                                    fullWidth
                                                                    size="small"
                                                                    inputProps={{ step: 'any' }}
                                                                    InputProps={{ disableUnderline: true, sx: { color: 'white' } }}
                                                                    onChange={(e) => updateS7Field(sIndex, mIndex, fIndex, 'scale', e.target.value)}
                                                                />
                                                            </TableCell>
                                                            <TableCell align="right">
                                                                <IconButton size="small" sx={{ color: '#64748b', '&:hover': { color: '#ef4444' } }} onClick={() => {
                                                                    const newSlaves = [...config.slaves];
                                                                    newSlaves[sIndex].metrics[mIndex].fields.splice(fIndex, 1);
                                                                    setConfig({ ...config, slaves: newSlaves });
                                                                }}>
                                                                    <Trash2 size={14} />
                                                                </IconButton>
                                                            </TableCell>
                                                        </TableRow>
                                                    ))}
                                                </TableBody>
                                            </Table>
                                        </TableContainer>
                                        <Button size="small" startIcon={<Plus size={14} />} onClick={() => addS7Field(sIndex, mIndex)} sx={{ color: '#fbbf24', mt: 1, '&:hover': { bgcolor: 'rgba(251, 188, 36, 0.08)' } }}>
                                            Add S7 Tag
                                        </Button>
                                    </Box>
                                ))}
                                <Button startIcon={<Plus size={16} />} onClick={() => addMetric(sIndex)} sx={{ color: '#fbbf24', '&:hover': { bgcolor: 'rgba(251, 188, 36, 0.08)' } }}>
                                    Add S7 Metric Group
                                </Button>
                            </>
                        )}
                    </Paper>
                ))}

                <Button variant="outlined" startIcon={<Plus />} onClick={addSlave} sx={{ color: 'white', borderColor: '#334155', borderStyle: 'dashed', width: '100%', py: 2, '&:hover': { borderColor: '#94a3b8' } }}>
                    Add New PLC Device
                </Button>
            </TabPanel>

            {/* TAB 1: VersaMax / KEPServerEX OPC UA BOP Configuration */}
            <TabPanel value={value} index={1}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3, gap: 2, alignItems: 'flex-start' }}>
                    <Box sx={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                        <Button variant="outlined" startIcon={<RefreshCw />} onClick={fetchBopConfig} sx={{ color: '#38bdf8', borderColor: '#334155' }}>Reload</Button>
                        <Button variant="contained" startIcon={<Save />} onClick={saveBopConfiguration} disabled={loading} sx={{ bgcolor: '#34d399', '&:hover': { bgcolor: '#10b981' } }}>
                            {loading ? 'Saving...' : 'Save BOP Settings'}
                        </Button>
                    </Box>
                </Box>

                <Paper sx={{ p: 3, mb: 3, bgcolor: '#1e293b', border: '1px solid #334155' }}>
                    <Typography variant="subtitle1" sx={{ color: '#fbbf24', fontWeight: 'bold', mb: 2 }}>KEPServerEX OPC UA Connection</Typography>
                    <Grid container spacing={2}>
                        <Grid item xs={12} md={6}>
                            <TextField label="OPC UA Endpoint" fullWidth size="small" value={bopConfig.endpoint || ''} onChange={(e) => updateBop('endpoint', e.target.value)} placeholder="opc.tcp://host.docker.internal:49320" sx={{ bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }} />
                        </Grid>
                        <Grid item xs={12} md={2}>
                            <FormControl fullWidth size="small">
                                <InputLabel sx={{ color: '#94a3b8' }}>Enabled</InputLabel>
                                <Select label="Enabled" value={bopConfig.enabled ? 'true' : 'false'} onChange={(e) => updateBop('enabled', e.target.value === 'true')} sx={{ bgcolor: '#0f172a', color: 'white', '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' }, '.MuiSvgIcon-root': { color: 'white' } }}>
                                    <MenuItem value="true">Yes</MenuItem><MenuItem value="false">No</MenuItem>
                                </Select>
                            </FormControl>
                        </Grid>
                        <Grid item xs={12} md={2}>
                            <FormControl fullWidth size="small">
                                <InputLabel sx={{ color: '#94a3b8' }}>Security Mode</InputLabel>
                                <Select label="Security Mode" value={bopConfig.securityMode || 'None'} onChange={(e) => updateBop('securityMode', e.target.value)} sx={{ bgcolor: '#0f172a', color: 'white', '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' }, '.MuiSvgIcon-root': { color: 'white' } }}>
                                    <MenuItem value="None">None</MenuItem><MenuItem value="Sign">Sign</MenuItem><MenuItem value="SignAndEncrypt">Sign & Encrypt</MenuItem>
                                </Select>
                            </FormControl>
                        </Grid>
                        <Grid item xs={12} md={2}>
                            <FormControl fullWidth size="small">
                                <InputLabel sx={{ color: '#94a3b8' }}>Security Policy</InputLabel>
                                <Select label="Security Policy" value={bopConfig.securityPolicy || 'None'} onChange={(e) => updateBop('securityPolicy', e.target.value)} sx={{ bgcolor: '#0f172a', color: 'white', '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' }, '.MuiSvgIcon-root': { color: 'white' } }}>
                                    <MenuItem value="None">None</MenuItem><MenuItem value="Basic256Sha256">Basic256Sha256</MenuItem><MenuItem value="Aes128_Sha256_RsaOaep">Aes128-Sha256</MenuItem><MenuItem value="Aes256_Sha256_RsaPss">Aes256-Sha256</MenuItem>
                                </Select>
                            </FormControl>
                        </Grid>
                    </Grid>
                </Paper>

                <Paper sx={{ p: 3, bgcolor: '#1e293b', border: '1px solid #334155' }}>
                    <Typography variant="subtitle1" sx={{ color: '#fbbf24', fontWeight: 'bold', mb: 1 }}>BOP Parameters</Typography>
                    <Typography variant="caption" sx={{ display: 'block', mb: 2, color: '#94a3b8' }}>Node IDs are intentionally blank until confirmed in KEPServerEX. Blank rows are retained as placeholders and will not be read.</Typography>
                    <TableContainer sx={{ overflowX: 'auto' }}>
                        <Table size="small" sx={{ minWidth: 920 }}>
                            <TableHead><TableRow>
                                <TableCell sx={{ color: '#94a3b8' }}>Enabled</TableCell><TableCell sx={{ color: '#94a3b8' }}>Parameter</TableCell><TableCell sx={{ color: '#94a3b8' }}>Field</TableCell><TableCell sx={{ color: '#94a3b8' }}>Kepware Node ID</TableCell><TableCell sx={{ color: '#94a3b8' }}>Unit</TableCell>
                            </TableRow></TableHead>
                            <TableBody>{(bopConfig.tags || []).map((tag, index) => <TableRow key={tag.field || index}>
                                <TableCell><Select variant="standard" value={tag.enabled ? 'true' : 'false'} onChange={(e) => updateBopTag(index, 'enabled', e.target.value === 'true')} sx={{ color: 'white', minWidth: 70 }}><MenuItem value="true">Yes</MenuItem><MenuItem value="false">No</MenuItem></Select></TableCell>
                                <TableCell><TextField variant="standard" fullWidth size="small" value={tag.name || ''} onChange={(e) => updateBopTag(index, 'name', e.target.value)} InputProps={{ disableUnderline: true, sx: { color: 'white' } }} /></TableCell>
                                <TableCell><TextField variant="standard" fullWidth size="small" value={tag.field || ''} onChange={(e) => updateBopTag(index, 'field', e.target.value)} InputProps={{ disableUnderline: true, sx: { color: '#94a3b8', fontFamily: 'monospace' } }} /></TableCell>
                                <TableCell><TextField variant="standard" fullWidth size="small" value={tag.nodeId || ''} onChange={(e) => updateBopTag(index, 'nodeId', e.target.value)} placeholder="ns=2;s=..." InputProps={{ disableUnderline: true, sx: { color: 'white', fontFamily: 'monospace' } }} /></TableCell>
                                <TableCell><TextField variant="standard" size="small" value={tag.unit || ''} onChange={(e) => updateBopTag(index, 'unit', e.target.value)} placeholder="bar / state" InputProps={{ disableUnderline: true, sx: { color: 'white' } }} /></TableCell>
                            </TableRow>)}</TableBody>
                        </Table>
                    </TableContainer>
                </Paper>
            </TabPanel>

            <TabPanel value={value} index={2}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2, alignItems: 'center' }}>
                    <Typography variant="h6">User Management</Typography>
                    <Button variant="contained" startIcon={<Plus size={16} />} onClick={() => handleOpenUserDialog()} sx={{ bgcolor: '#38bdf8', '&:hover': { bgcolor: '#0ea5e9' } }}>
                        Add User
                    </Button>
                </Box>

                <Paper sx={{ width: '100%', mb: 2, bgcolor: '#1e293b', overflow: 'hidden', border: '1px solid #334155' }}>
                    <TableContainer>
                        <Table>
                            <TableHead>
                                <TableRow>
                                    <TableCell sx={{ color: '#94a3b8' }}>Username</TableCell>
                                    <TableCell sx={{ color: '#94a3b8' }}>Role</TableCell>
                                    <TableCell sx={{ color: '#94a3b8' }}>Status</TableCell>
                                    <TableCell sx={{ color: '#94a3b8' }} align="right">Actions</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {users.map((user) => (
                                    <TableRow hover key={user.id}>
                                        <TableCell sx={{ color: 'white' }}>{user.username}</TableCell>
                                        <TableCell sx={{ color: 'white' }}>{user.role}</TableCell>
                                        <TableCell>
                                            <span style={{
                                                color: user.status === 'active' ? '#4ade80' : '#ef4444',
                                                textTransform: 'capitalize'
                                            }}>
                                                {user.status}
                                            </span>
                                        </TableCell>
                                        <TableCell align="right">
                                            <IconButton size="small" onClick={() => handleOpenUserDialog(user)} sx={{ color: '#38bdf8', mr: 1 }}>
                                                <Edit2 size={16} />
                                            </IconButton>
                                            <IconButton size="small" onClick={() => handleDeleteUser(user.id)} sx={{ color: '#ef4444' }}>
                                                <Trash2 size={16} />
                                            </IconButton>
                                        </TableCell>
                                    </TableRow>
                                ))}
                                {users.length === 0 && (
                                    <TableRow>
                                        <TableCell colSpan={4} align="center" sx={{ color: '#94a3b8', py: 3 }}>
                                            No users found.
                                        </TableCell>
                                    </TableRow>
                                )}
                            </TableBody>
                        </Table>
                    </TableContainer>
                </Paper>
            </TabPanel>

            <Snackbar
                open={notification.open}
                autoHideDuration={6000}
                onClose={() => setNotification({ ...notification, open: false })}
            >
                <Alert severity={notification.severity} variant="filled">
                    {notification.message}
                </Alert>
            </Snackbar>

            {/* Add/Edit User Dialog */}
            <Dialog open={openUserDialog} onClose={() => setOpenUserDialog(false)} PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: '400px' } }}>
                <DialogTitle>{isEditingUser ? 'Edit User' : 'Add User'}</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        margin="dense"
                        label="Username"
                        type="text"
                        fullWidth
                        variant="outlined"
                        value={currentUser.username}
                        onChange={(e) => setCurrentUser({ ...currentUser, username: e.target.value })}
                        sx={{ mt: 2, bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                    />
                    <TextField
                        margin="dense"
                        label={isEditingUser ? "Password (leave blank to keep)" : "Password"}
                        type="password"
                        fullWidth
                        variant="outlined"
                        value={currentUser.password}
                        onChange={(e) => setCurrentUser({ ...currentUser, password: e.target.value })}
                        sx={{ mt: 2, bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                    />
                    <FormControl fullWidth sx={{ mt: 2 }}>
                        <InputLabel sx={{ color: '#94a3b8' }}>Role</InputLabel>
                        <Select
                            value={currentUser.role}
                            label="Role"
                            onChange={(e) => setCurrentUser({ ...currentUser, role: e.target.value })}
                            sx={{ bgcolor: '#0f172a', color: 'white', '.MuiSvgIcon-root': { color: 'white' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                        >
                            <MenuItem value="admin">Admin</MenuItem>
                            <MenuItem value="operator">Operator</MenuItem>
                            <MenuItem value="viewer">Viewer</MenuItem>
                        </Select>
                    </FormControl>
                    <FormControl fullWidth sx={{ mt: 2 }}>
                        <InputLabel sx={{ color: '#94a3b8' }}>Status</InputLabel>
                        <Select
                            value={currentUser.status}
                            label="Status"
                            onChange={(e) => setCurrentUser({ ...currentUser, status: e.target.value })}
                            sx={{ bgcolor: '#0f172a', color: 'white', '.MuiSvgIcon-root': { color: 'white' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                        >
                            <MenuItem value="active">Active</MenuItem>
                            <MenuItem value="inactive">Inactive</MenuItem>
                        </Select>
                    </FormControl>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setOpenUserDialog(false)} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button onClick={handleSaveUser} variant="contained" sx={{ bgcolor: '#38bdf8' }}>
                        {isEditingUser ? 'Update' : 'Create'}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
