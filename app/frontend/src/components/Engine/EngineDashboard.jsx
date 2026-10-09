import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box } from '@mui/material';
import { Gauge, Thermometer, Droplets, Battery, Activity } from 'lucide-react';
import { getLatestRigData, isLiveRigPayload, socket } from '../../socket';
import MaintenancePanel from './MaintenancePanel';
import axios from '../../api';

function MetricCard({ title, value, unit, icon: Icon, color = '#38bdf8' }) {
    return (
        <Paper sx={{ p: 2, bgcolor: '#1e293b', color: 'white', display: 'flex', alignItems: 'center', gap: 2 }}>
            <Box sx={{ p: 1.5, borderRadius: '50%', bgcolor: `${color}20`, color: color }}>
                <Icon size={24} />
            </Box>
            <Box>
                <Typography variant="subtitle2" sx={{ color: '#94a3b8' }}>{title}</Typography>
                <Typography variant="h5" sx={{ fontWeight: 'bold' }}>
                    {value} <span style={{ fontSize: '0.9rem', color: '#64748b' }}>{unit}</span>
                </Typography>
            </Box>
        </Paper>
    );
}

export default function EngineDashboard() {
    const [engineData, setEngineData] = useState({});

    useEffect(() => {
        const cached = getLatestRigData();
        if (isLiveRigPayload(cached) && cached?.cat_engine) {
            setEngineData(cached.cat_engine);
        }
        // Fetch latest data on mount
        axios.get('/api/rig/latest')
            .then(({ data }) => {
                if (!isLiveRigPayload(data)) { setEngineData({}); return; }
                if (data.cat_engine) {
                    setEngineData(data.cat_engine);
                }
            })
            .catch(err => console.error("Failed to fetch latest engine data:", err));

        const handler = (data) => {
            if (!isLiveRigPayload(data)) { setEngineData({}); return; }
            if (data.cat_engine) {
                setEngineData(data.cat_engine);
            }
        };
        socket.on('rig_data', handler);

        return () => {
            socket.off('rig_data', handler);
        };
    }, []);

    return (
        <Box>
            <Typography variant="h5" sx={{ mb: 3, fontWeight: 'bold' }}>Caterpillar Engine 1 Monitoring</Typography>

            <Grid container spacing={3}>
                {/* Column 1: Monitoring */}
                <Grid item xs={12} md={3}>
                    <Typography variant="h6" sx={{ mb: 2 }}>Monitoring</Typography>
                    <Grid container spacing={2}>
                        <Grid item xs={12}>
                            <MetricCard
                                title="ENGINE RPM"
                                value={engineData.rpm}
                                unit="RPM"
                                icon={Activity}
                                color="#ec4899"
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <MetricCard
                                title="BATTERY VOLTAGE"
                                value={engineData.battery_voltage}
                                unit="V"
                                icon={Battery}
                                color="#eab308"
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <MetricCard
                                title="FUEL LEVEL"
                                value={engineData.fuel_level}
                                unit="%"
                                icon={Droplets}
                                color="#3b82f6"
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <MetricCard
                                title="OIL PRESSURE"
                                value={engineData.oil_pressure}
                                unit="psi"
                                icon={Gauge}
                                color="#f43f5e"
                            />
                        </Grid>
                    </Grid>
                </Grid>

                {/* Column 2: Temperature Diagnostics */}
                <Grid item xs={12} md={3}>
                    <Typography variant="h6" sx={{ mb: 2 }}>Temperature Diagnostics</Typography>
                    <Grid container spacing={2}>
                        <Grid item xs={12}>
                            <MetricCard
                                title="COOLANT TEMP"
                                value={engineData.coolant_temp}
                                unit="°C"
                                icon={Thermometer}
                                color="#34d399"
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <MetricCard
                                title="OIL TEMP"
                                value={engineData.oil_temp}
                                unit="°C"
                                icon={Thermometer}
                                color="#f97316"
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <MetricCard
                                title="EXHAUST TEMP"
                                value={engineData.exhaust_temp}
                                unit="°C"
                                icon={Thermometer}
                                color="#ef4444"
                            />
                        </Grid>
                    </Grid>
                </Grid>

                {/* Column 3: Scheduled Maintenance */}
                <Grid item xs={12} md={6}>
                    <MaintenancePanel engineData={engineData} />
                </Grid>
            </Grid>
        </Box>
    );
}
