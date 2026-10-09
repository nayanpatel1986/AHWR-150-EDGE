import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box, useTheme } from '@mui/material';
import { Activity, Droplets } from 'lucide-react';
import { getLatestRigData, isLiveRigPayload, socket } from '../../socket';
import axios from '../../api';
import EdrView from '../EDR/EdrView';

// ---- Local reusable presentational helper: compact value tile (flat, dense) ----
// Big numeric value + unit + small label, with an optional thin range bar that
// turns amber/red near the configured thresholds, or a colored value accent.
function ValueTile({ label, value, unit, decimals = 0, color = '#38bdf8', min = 0, max, warn, crit, sub, surface, border }) {
    const num = Number(value);
    const has = Number.isFinite(num);
    const display = has ? num.toFixed(decimals) : '--';

    let accent = color;
    let ratio = null;
    if (has && Number.isFinite(max) && max > min) {
        ratio = Math.min(Math.max((num - min) / (max - min), 0), 1);
        const wr = warn != null ? (warn - min) / (max - min) : null;
        const cr = crit != null ? (crit - min) / (max - min) : null;
        if (cr != null && ratio >= cr) accent = '#ef4444';
        else if (wr != null && ratio >= wr) accent = '#fbbf24';
    }

    return (
        <Paper sx={{ p: 1.5, bgcolor: surface, border: `1px solid ${border}`, borderRadius: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', fontSize: '0.66rem' }} noWrap>{label}</Typography>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mt: 0.25 }}>
                <Typography sx={{ color: accent, fontWeight: 800, fontSize: '1.7rem', lineHeight: 1.05 }}>{display}</Typography>
                {unit && <Typography sx={{ color: 'text.secondary', fontWeight: 600, fontSize: '0.78rem' }}>{unit}</Typography>}
            </Box>
            {ratio != null && (
                <Box sx={{ mt: 'auto', pt: 1 }}>
                    <Box sx={{ height: 5, borderRadius: 3, bgcolor: 'action.hover', overflow: 'hidden' }}>
                        <Box sx={{ width: `${ratio * 100}%`, height: '100%', bgcolor: accent, borderRadius: 3, transition: 'width .4s ease' }} />
                    </Box>
                </Box>
            )}
            {sub && <Typography variant="caption" sx={{ color: 'text.secondary', mt: ratio != null ? 0.5 : 'auto', pt: ratio != null ? 0 : 1, fontSize: '0.62rem' }} noWrap>{sub}</Typography>}
        </Paper>
    );
}

const SectionTitle = ({ icon: Icon, children }) => (
    <Typography variant="h6" sx={{ mb: 1.5, fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
        {Icon && <Icon size={20} />} {children}
    </Typography>
);

// EDR side-strip config — pump (spm, pressure, flow_in) and fluid (tank volume,
// gain/loss, trip tank) analogs are all catalogued in shared/edrMetrics.json.
// min/max are from the catalog defaults.
const EDR_CHANNELS = [
    'mudpump.delta_pressure',
    'mudpump.flow_in',
    'mudpump.flow_out_percentage',
    'mudpump.flow_out',
    'mudpump.pressure',
    'mudpump.spm',
    'mudpump.total_spm',
    'fluid.trip_tank_percentage',
    'fluid.tank_1',
    'fluid.tank_2',
    'fluid.tank_3',
    'fluid.tank_4',
    'fluid.tank_gain_loss',
    'fluid.total_tank_volume',
    'fluid.trip_tank'
];
const EDR_STRIPS = [
    {
        title: 'Pump',
        pens: [
            { channelId: 'mudpump.pressure', color: '#ef4444', min: 0, max: 7500, scaleUnit: 'psi', enabled: true },
            { channelId: 'mudpump.spm', color: '#ec4899', min: 0, max: 200, enabled: true },
            { channelId: 'mudpump.flow_in', color: '#3b82f6', min: 0, max: 1200, enabled: true }
        ]
    }
];

export default function MudPumpDashboard() {
    const theme = useTheme();
    const surface = theme.palette.background.paper;
    const inset = theme.palette.background.default;
    const border = theme.palette.divider;
    const [pumpData, setPumpData] = useState({});
    const [fluidData, setFluidData] = useState({});
    useEffect(() => {
        const cached = getLatestRigData();
        if (isLiveRigPayload(cached)) {
            if (cached.mudpump) processMudPumpData(cached.mudpump);
            if (cached.fluid) setFluidData(prev => ({ ...prev, ...cached.fluid }));
        }
        // Fetch latest data on mount
        axios.get('/api/rig/latest')
            .then(({ data }) => {
                if (!isLiveRigPayload(data)) { setPumpData({}); setFluidData({}); return; }
                if (data.mudpump) processMudPumpData(data.mudpump);
                if (data.fluid) setFluidData(prev => ({ ...prev, ...data.fluid }));
            })
            .catch(err => console.error("Failed to fetch latest mudpump data:", err));

        const handler = (data) => {
            if (!isLiveRigPayload(data)) { setPumpData({}); setFluidData({}); return; }
            if (data.mudpump) {
                processMudPumpData(data.mudpump);
            }
            if (data.fluid) {
                setFluidData(prev => ({ ...prev, ...data.fluid }));
            }
        };
        socket.on('rig_data', handler);

        return () => {
            socket.off('rig_data', handler);
        };
    }, []);

    const processMudPumpData = (mudpumpData) => {
        setPumpData(mudpumpData);

    };

    return (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 2 }}>
            {/* Main content */}
            <Box sx={{ flex: '1 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
                {/* --- SECTION 1: PUMP SYSTEMS --- */}
                <Box>
                    <SectionTitle icon={Activity}>Pump Systems</SectionTitle>
                    <Grid container spacing={1.5}>
                        <Grid item xs={6} sm={4} md={2}>
                            <ValueTile label="Pump SPM" value={pumpData.spm} unit="SPM" color="#ec4899" min={0} max={200} surface={surface} border={border} />
                        </Grid>
                        <Grid item xs={6} sm={4} md={2}>
                            <ValueTile label="Pressure" value={pumpData.pressure} unit="bar" color="#ef4444" min={0} max={500} warn={350} crit={420} surface={surface} border={border} />
                        </Grid>
                        <Grid item xs={6} sm={4} md={2}>
                            <ValueTile label="FLOW OUT" value={pumpData.flow_out} unit="%" color="#22c55e" min={0} max={100} surface={surface} border={border} />
                        </Grid>
                        <Grid item xs={6} sm={4} md={2}>
                            <ValueTile label="Inlet Flow" value={pumpData.flow_in} unit="Lt/min" color="#3b82f6" min={0} max={1200} surface={surface} border={border} />
                        </Grid>
                        <Grid item xs={6} sm={4} md={2}>
                            <ValueTile label="Total Strokes" value={pumpData.total_spm} unit="ct" color="#a78bfa" sub="Lifetime count" surface={surface} border={border} />
                        </Grid>
                    </Grid>
                </Box>

                {/* --- SECTION 2: TANK & FLUID SYSTEMS --- */}
                <Box>
                    <SectionTitle icon={Droplets}>Tank & Fluid Systems</SectionTitle>
                    <Grid container spacing={1.5}>
                        <Grid item xs={6} sm={6} md={3}>
                            <ValueTile label="Active Volume" value={fluidData.total_tank_volume} unit="m³" decimals={1} color="#0ea5e9" surface={surface} border={border} />
                        </Grid>
                        <Grid item xs={6} sm={6} md={3}>
                            <ValueTile label="Volume Gain/Loss" value={fluidData.tank_gain_loss} unit="m³" decimals={2}
                                color={Number(fluidData.tank_gain_loss) >= 0 ? '#22c55e' : '#ef4444'} surface={surface} border={border}
                                sub={Number(fluidData.tank_gain_loss) >= 0 ? 'Gaining' : 'Losing'} />
                        </Grid>
                        <Grid item xs={6} sm={6} md={3}>
                            <ValueTile label="Trip Tank Volume" value={fluidData.trip_tank} unit="m³" decimals={1} color="#6366f1" surface={surface} border={border} />
                        </Grid>
                        <Grid item xs={6} sm={6} md={3}>
                            <ValueTile label="Trip Gain/Loss" value={fluidData.trip_tank_percentage} unit="%" decimals={1}
                                color={Number(fluidData.trip_tank_percentage) >= 0 ? '#22c55e' : '#ef4444'} surface={surface} border={border} />
                        </Grid>

                        {/* Individual Tank Status */}
                        <Grid item xs={12}>
                            <Box sx={{ p: 1.75, bgcolor: inset, borderRadius: 2, border: `1px solid ${border}` }}>
                                <Typography variant="subtitle2" sx={{ color: 'text.secondary', mb: 1.5, textTransform: 'uppercase', letterSpacing: 1 }}>
                                    Mud Tank Individual Volumes
                                </Typography>
                                <Grid container spacing={1.5}>
                                    {[1, 2, 3, 4].map(num => (
                                        <Grid item xs={6} sm={3} key={num}>
                                            <Box sx={{ p: 1.5, bgcolor: surface, borderRadius: 1, textAlign: 'center', border: `1px solid ${border}` }}>
                                                <Typography variant="caption" sx={{ color: '#64748b', display: 'block', fontWeight: 700, fontSize: '0.62rem' }}>TANK {num}</Typography>
                                                <Typography variant="h6" sx={{ color: 'text.primary', fontWeight: 'bold' }}>
                                                    {Number(fluidData[`tank_${num}`] || 0).toFixed(2)} <span style={{ fontSize: '0.7rem', color: '#64748b' }}>m³</span>
                                                </Typography>
                                            </Box>
                                        </Grid>
                                    ))}
                                </Grid>
                            </Box>
                        </Grid>
                    </Grid>
                </Box>
            </Box>

            {/* Persistent EDR side strip */}
            <Box
                sx={{
                    flex: { xs: '1 1 100%', lg: '0 0 400px' },
                    width: { xs: '100%', lg: 400 },
                    minHeight: { xs: 420, lg: 560 },
                    height: { lg: 'calc(100vh - 220px)' },
                    display: 'flex',
                    flexDirection: 'column'
                }}
            >
                <Paper sx={{ flex: 1, minHeight: 0, p: 1.25, bgcolor: surface, border: `1px solid ${border}`, borderRadius: 2, display: 'flex', flexDirection: 'column' }}>
                    <Typography sx={{ color: 'text.secondary', fontSize: '0.72rem', fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', mb: 0.75 }}>
                        Mud Pump & Pit Trends
                    </Typography>
                    <Box sx={{ flex: 1, minHeight: 0 }}>
                        <EdrView mode="compact" storageKey="edr-mudpump-1" defaultStrips={EDR_STRIPS} channels={EDR_CHANNELS} />
                    </Box>
                </Paper>
            </Box>
        </Box>
    );
}
