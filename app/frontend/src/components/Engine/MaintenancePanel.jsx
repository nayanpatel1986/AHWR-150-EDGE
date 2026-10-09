import React, { useState, useEffect } from 'react';
import { Box, Typography, Paper, Grid, LinearProgress, Button, Alert, Chip } from '@mui/material';
import { Wrench, AlertTriangle, CheckCircle, Clock } from 'lucide-react';

const MaintenancePanel = ({ engineData }) => {
    // Simulated State (In real app, fetch from backend DB)
    const [maintenanceState, setMaintenanceState] = useState({
        totalRunningHours: 4850, // Mock starting hours (close to Service A and B for demo)
        lastServicePM1: 4700,
        lastServicePM2: 4500,
        lastServicePM3: 4000,
        lastServicePM4: 2000,
        lastServicePM5: 0
    });

    const [alerts, setAlerts] = useState([]);

    // Intervals
    const INTERVAL_PM1 = 250;   // Routine Inspection
    const INTERVAL_PM2 = 500;   // Oil & Filter
    const INTERVAL_PM3 = 1000;  // Comprehensive
    const INTERVAL_PM4 = 2000;  // Top End
    const INTERVAL_PM5 = 10000; // Overhaul

    // Load from local storage on mount
    useEffect(() => {
        const saved = localStorage.getItem('romii_engine_maintenance');
        if (saved) {
            setMaintenanceState(JSON.parse(saved));
        }
    }, []);

    // Save to local storage on change
    useEffect(() => {
        localStorage.setItem('romii_engine_maintenance', JSON.stringify(maintenanceState));
    }, [maintenanceState]);

    // Simulate Running Hours (Increment when RPM > 0)
    useEffect(() => {
        let interval;
        if (engineData.rpm > 0) {
            interval = setInterval(() => {
                setMaintenanceState(prev => ({
                    ...prev,
                    totalRunningHours: prev.totalRunningHours + (1 / 60) // Add 1 minute of hours every real second (fast forward 60x for demo)
                }));
            }, 1000);
        }
        return () => clearInterval(interval);
    }, [engineData.rpm]);

    // Condition Monitoring Logic
    useEffect(() => {
        const newAlerts = [];

        // Oil Pressure Warning (Low while running)
        if (engineData.rpm > 600 && engineData.oil_pressure < 30) {
            newAlerts.push({ id: 'oil_low', severity: 'error', message: 'Low Oil Pressure - check pump/filter immediately.' });
        }

        // Coolant Temp Warning (High)
        if (engineData.coolant_temp > 100) {
            newAlerts.push({ id: 'coolant_high', severity: 'warning', message: 'High Coolant Temp - inspect cooling system.' });
        }

        // Filter Differential (Simulated via high oil temp + normal coolant)
        if (engineData.oil_temp > 110 && engineData.coolant_temp < 90) {
            newAlerts.push({ id: 'oil_filter', severity: 'info', message: 'Oil Filter Differential High - Replace Filter.' });
        }

        setAlerts(newAlerts);
    }, [engineData]);

    const performService = (type) => {
        if (window.confirm(`Confirm ${type} Service Completed?`)) {
            setMaintenanceState(prev => ({
                ...prev,
                [`lastService${type}`]: prev.totalRunningHours
            }));
        }
    };

    const ServiceCard = ({ type, label, interval, lastService }) => {
        const hoursSince = maintenanceState.totalRunningHours - lastService;
        const hoursRemaining = interval - hoursSince;
        const percent = Math.min(100, (hoursSince / interval) * 100);
        const isDue = hoursRemaining <= 0;
        const isClose = hoursRemaining <= (interval * 0.1); // 10% warning

        return (
            <Paper sx={{ p: 2, bgcolor: '#0f172a', border: '1px solid #334155', borderRadius: 2 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="subtitle2" sx={{ color: '#94a3b8' }}>{label} ({type})</Typography>
                    {isDue ?
                        <Chip size="small" label="DUE" color="error" icon={<AlertTriangle size={12} />} /> :
                        <Chip size="small" label="OK" color="success" icon={<CheckCircle size={12} />} variant="outlined" />
                    }
                </Box>

                <Box sx={{ mb: 2 }}>
                    <Typography variant="h4" sx={{ fontWeight: 'bold', color: 'white' }}>
                        {Math.max(0, hoursRemaining).toFixed(2)} <span style={{ fontSize: '0.6em', color: '#64748b' }}>hrs left</span>
                    </Typography>
                </Box>

                <LinearProgress
                    variant="determinate"
                    value={percent}
                    sx={{
                        mb: 2, height: 8, borderRadius: 1,
                        bgcolor: '#334155',
                        '& .MuiLinearProgress-bar': { bgcolor: isDue ? '#ef4444' : isClose ? '#f59e0b' : '#3b82f6' }
                    }}
                />

                <Button
                    fullWidth variant="outlined" size="small"
                    startIcon={<Wrench size={16} />}
                    onClick={() => performService(type)}
                    sx={{
                        color: isDue ? '#ef4444' : '#94a3b8',
                        borderColor: isDue ? '#ef4444' : '#475569',
                        '&:hover': { bgcolor: isDue ? 'rgba(239, 68, 68, 0.1)' : 'rgba(148, 163, 184, 0.1)' }
                    }}
                >
                    Log Service
                </Button>
            </Paper>
        );
    };

    return (
        <Paper sx={{ p: 3, bgcolor: '#1e293b', color: 'white', height: '100%' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
                <Typography variant="h6" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Clock size={20} color="#fbbf24" />
                    Scheduled Maintenance
                </Typography>
                <Typography variant="h6" sx={{ fontFamily: 'monospace', color: '#fbbf24' }}>
                    {maintenanceState.totalRunningHours.toFixed(2)} <span style={{ fontSize: '0.6em', color: '#94a3b8' }}>TOTAL HRS</span>
                </Typography>
            </Box>

            <Grid container spacing={2}>
                <Grid item xs={12}>
                    <ServiceCard type="PM1" label="Routine Inspection" interval={INTERVAL_PM1} lastService={maintenanceState.lastServicePM1} />
                </Grid>
                <Grid item xs={12}>
                    <ServiceCard type="PM2" label="Oil & Filter" interval={INTERVAL_PM2} lastService={maintenanceState.lastServicePM2} />
                </Grid>
                <Grid item xs={12}>
                    <ServiceCard type="PM3" label="Comprehensive" interval={INTERVAL_PM3} lastService={maintenanceState.lastServicePM3} />
                </Grid>
                <Grid item xs={12}>
                    <ServiceCard type="PM4" label="Top End" interval={INTERVAL_PM4} lastService={maintenanceState.lastServicePM4} />
                </Grid>
                <Grid item xs={12}>
                    <ServiceCard type="PM5" label="Overhaul" interval={INTERVAL_PM5} lastService={maintenanceState.lastServicePM5} />
                </Grid>
            </Grid>

            {/* Active Alerts Section */}
            {alerts.length > 0 && (
                <Box sx={{ mt: 4 }}>
                    <Typography variant="subtitle2" sx={{ color: '#ef4444', mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <AlertTriangle size={16} />
                        Condition Alerts
                    </Typography>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {alerts.map((alert, idx) => (
                            <Alert key={idx} severity={alert.severity} variant="filled" sx={{ borderRadius: 2 }}>
                                {alert.message}
                            </Alert>
                        ))}
                    </Box>
                </Box>
            )}
        </Paper>
    );
};

export default MaintenancePanel;
