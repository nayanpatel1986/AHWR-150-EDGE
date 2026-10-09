import React, { useEffect, useMemo, useState } from 'react';
import { Paper, Typography, Box, Button, useTheme } from '@mui/material';
import { useLocation, useNavigate } from 'react-router-dom';
import {
    Gauge, Activity, Droplets, ShieldAlert, Anchor,
    LayoutDashboard
} from 'lucide-react';

// Import child dashboards
import PctDashboard from './PctDashboard';
import AcsDashboard from './AcsDashboard';
import CwkDashboard from './CwkDashboard';
import HtdDashboard from './HtdDashboard';
import HpuDashboard from './HpuDashboard';
import CatEngineDashboard from './CatEngineDashboard';
import MudPumpDashboard from '../MudPump/MudPumpDashboard';

export default function EquipmentHub() {
    const theme = useTheme();
    const location = useLocation();
    const navigate = useNavigate();
    const surface = theme.palette.background.paper;
    const border = theme.palette.divider;
    const validViews = useMemo(() => new Set(['cat-engine', 'hpu', 'htd', 'mud-pump', 'acs', 'cwk', 'pct']), []);
    const tabFromUrl = useMemo(() => {
        const tab = new URLSearchParams(location.search).get('tab');
        return validViews.has(tab) ? tab : 'cat-engine';
    }, [location.search, validViews]);
    const [view, setView] = useState(tabFromUrl); // Default directly to Cat Engine

    useEffect(() => {
        setView(tabFromUrl);
    }, [tabFromUrl]);

    const selectView = (id) => {
        setView(id);
        navigate(`/equipment?tab=${id}`, { replace: true });
    };

    const renderContent = () => {
        switch (view) {
            case 'pct': return <PctDashboard />;
            case 'acs': return <AcsDashboard />;
            case 'cwk': return <CwkDashboard />;
            case 'htd': return <HtdDashboard />;
            case 'hpu': return <HpuDashboard />;
            case 'cat-engine': {
                const engineId = new URLSearchParams(location.search).get('engine') === 'engine2' ? 'engine2' : 'engine1';
                return <CatEngineDashboard key={engineId} engineId={engineId} />;
            }
            case 'mud-pump': return <MudPumpDashboard />;
            default: return <CatEngineDashboard />;
        }
    };

    const equipments = [
        { id: 'cat-engine', title: 'CAT ENGINE', icon: Gauge, color: '#38bdf8', desc: 'Propulsion & Power Generation' },
        { id: 'hpu', title: 'HPU SYSTEM', icon: Activity, color: '#4ade80', desc: 'Hydraulic Power Unit Monitoring' },
        { id: 'htd', title: 'HTD DRIVE', icon: Droplets, color: '#a78bfa', desc: 'Top Drive Operations' },
        { id: 'mud-pump', title: 'MUD PUMP', icon: Droplets, color: '#3b82f6', desc: 'Mud Pump Monitoring' },
        { id: 'acs', title: 'ACS SYSTEM', icon: ShieldAlert, color: '#ef4444', desc: 'Automatic Control System' },
        { id: 'cwk', title: 'CATWALK', icon: LayoutDashboard, color: '#fbbf24', desc: 'Pipe Handling & Catwalk' },
        { id: 'pct', title: 'PCT TONG', icon: Anchor, color: '#22d3ee', desc: 'Power Casing Tong' }
    ];

    const active = equipments.find(eq => eq.id === view) || equipments[0];

    return (
        <Box sx={{ minHeight: '100%', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* Top navigation: dense, full-width, theme-aware equipment selector. */}
            <Paper
                elevation={0}
                sx={{
                    p: 1,
                    display: 'grid',
                    gridTemplateColumns: { xs: 'repeat(3, 1fr)', sm: 'repeat(4, 1fr)', md: `repeat(${equipments.length}, 1fr)` },
                    gap: 1,
                    bgcolor: surface,
                    borderRadius: 2,
                    border: `1px solid ${border}`,
                    position: 'sticky',
                    top: 0,
                    zIndex: 100
                }}
            >
                {equipments.map((eq) => {
                    const isActive = view === eq.id;
                    const Icon = eq.icon;
                    return (
                        <Button
                            key={eq.id}
                            variant={isActive ? 'contained' : 'text'}
                            onClick={() => selectView(eq.id)}
                            startIcon={<Icon size={18} />}
                            sx={{
                                color: isActive ? theme.palette.getContrastText(eq.color) : 'text.secondary',
                                bgcolor: isActive ? eq.color : 'transparent',
                                border: `1px solid ${isActive ? eq.color : 'transparent'}`,
                                justifyContent: 'center',
                                '&:hover': {
                                    bgcolor: isActive ? eq.color : `${eq.color}1a`,
                                    borderColor: isActive ? eq.color : `${eq.color}66`,
                                    color: isActive ? theme.palette.getContrastText(eq.color) : eq.color,
                                    opacity: isActive ? 0.92 : 1
                                },
                                fontWeight: isActive ? 'bold' : 'medium',
                                px: 1.25,
                                minWidth: 0,
                                whiteSpace: 'nowrap'
                            }}
                        >
                            {eq.title.split(' ')[0]}
                        </Button>
                    );
                })}
            </Paper>


            <Box sx={{ flexGrow: 1 }}>
                {renderContent()}
            </Box>
        </Box>
    );
}
