import React, { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import {
    LayoutDashboard,
    Activity,
    ShieldAlert,
    LineChart as ChartIcon,
    Settings,
    Edit2,
    Anchor,
    LogOut,
    ChevronDown,
    Database,
    Bell,
    Wrench,
    FileText,
    HeartPulse,
    Cable,
    RefreshCw,
    ClipboardList,
    Gauge,
    MapPin
} from 'lucide-react';
import {
    Box,
    AppBar,
    Toolbar,
    Typography,
    IconButton,
    CssBaseline,
    Dialog,
    DialogTitle,
    DialogContent,
    TextField,
    DialogActions,
    Button,
    Alert,
    Popover,
    List,
    ListItem,
    ListItemButton,
    ListItemIcon,
    ListItemText
} from '@mui/material';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { isLiveRigPayload, socket, connectSocket } from '../../socket';
import AlarmStrip from '../Alarms/AlarmStrip';
import ThemeSwitcher from './ThemeSwitcher';
import axios from '../../api';
import CentralMessages from '../Messages/CentralMessages';

const menuItems = [
    { text: 'Rig Overview', icon: <LayoutDashboard size={20} />, path: '/' },
    { text: 'EDR', icon: <Activity size={20} />, path: '/edr' },
    { text: 'Equipment', icon: <Database size={20} />, path: '/equipment' },
    { text: 'Activity', icon: <Activity size={20} />, path: '/activity' },
    { text: 'Alarms', icon: <Bell size={20} />, path: '/alarms' },
    { text: 'Operations', icon: <ClipboardList size={20} />, path: '/operations' },
    { text: 'Well', icon: <MapPin size={20} />, path: '/well' },
    { text: 'Reports', icon: <FileText size={20} />, path: '/reports' },
    { text: 'Maintenance', icon: <HeartPulse size={20} />, path: '/maintenance' },
    { text: 'Efficiency', icon: <Gauge size={20} />, path: '/efficiency' },
    { text: 'Edge Sync', icon: <RefreshCw size={20} />, path: '/sync' },
    { text: 'Settings', icon: <Settings size={20} />, path: '/settings' },
];

export default function Layout() {
    const location = useLocation();
    const { logout, user } = useAuth();
    const navigate = useNavigate();

    const [menuAnchor, setMenuAnchor] = useState(null);
    const [connected, setConnected] = useState(socket.connected);

    // Live rig parameters for the top bar
    const [liveParams, setLiveParams] = useState({ opMode: 0, acsStatus: 0, holeDepth: 0, bitDepth: 0 });

    const getOpModeLabel = (code) => {
        switch (Number(code)) {
            case 1: return "DRILLING";
            case 2: return "TRIP IN";
            case 3: return "TRIP OUT";
            case 4: return "CASING";
            default: return "IDLE";
        }
    };

    const getAcsStatusLabel = (code) => {
        switch (Number(code)) {
            case 1: return "ON";
            case 2: return "OFF";
            case 3: return "DISABLE";
            default: return "UNKNOWN";
        }
    };

    const getOpModeColor = (code) => Number(code) === 1 ? '#4ade80' : '#38bdf8';
    const getAcsColor = (code) => Number(code) === 1 ? '#4ade80' : (Number(code) === 2 ? '#ef4444' : '#94a3b8');

    const navItems = menuItems.filter(item => item.path !== '/settings' || user?.role === 'admin');

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    // Well & Rig State
    const [wellInfo, setWellInfo] = useState({ well: 'WELL-001', rig: 'RIG-ALPHA' });
    // Active well from the Well registry — drives the top-bar RIG/WELL display when set.
    const [activeWell, setActiveWell] = useState(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [tempInfo, setTempInfo] = useState({ well: '', rig: '' });
    const [infoError, setInfoError] = useState('');

    useEffect(() => {
        // Layout owns the socket connection lifecycle (persistent shell, post-auth).
        // It is NOT disconnected when feature pages unmount — only on logout.
        connectSocket();

        // Initial Load
        axios.get(`/api/dashboard/layout?t=${Date.now()}`, { timeout: 3000 })
            .then(({ data: config }) => {
                if (config.wellInfo) setWellInfo(config.wellInfo);
            })
            .catch(err => console.error("Failed to load rig info:", err));

        // Active well: drives the top-bar RIG/WELL when a well is started.
        // Poll it (no socket event for it) so the bar reflects start/complete.
        const loadActiveWell = () => {
            axios.get('/api/wells/active', { timeout: 3000 })
                .then(({ data }) => setActiveWell(data || null))
                .catch(err => console.error("Failed to load active well:", err));
        };
        loadActiveWell();
        const activeWellPoll = setInterval(loadActiveWell, 5000);
        window.addEventListener('well-active-changed', loadActiveWell);

        // Real-time Updates
        const handleLayoutUpdate = (config) => {
            if (config.wellInfo) setWellInfo(config.wellInfo);
        };
        socket.on('dashboard_layout_update', handleLayoutUpdate);

        // Live connection-state indicator.
        const handleConnect = () => setConnected(true);
        const handleDisconnect = () => setConnected(false);
        const handleConnectError = () => setConnected(false);
        socket.on('connect', handleConnect);
        socket.on('disconnect', handleDisconnect);
        socket.on('connect_error', handleConnectError);
        setConnected(socket.connected);

        // Live rig parameters for top bar
        const handleRigData = (data) => {
            if (!isLiveRigPayload(data)) {
                setLiveParams({
                    opMode: 0,
                    acsStatus: 0,
                    holeDepth: null,
                    bitDepth: null,
                });
                return;
            }
            setLiveParams({
                opMode: data.drilling?.operation_mode || 0,
                acsStatus: data.acs?.status || 0,
                holeDepth: data.drilling?.hole_depth || 0,
                bitDepth: data.drilling?.bit_depth || 0,
            });
        };
        socket.on('rig_data', handleRigData);

        return () => {
            // Remove ONLY our own handlers; do NOT disconnect the shared socket here.
            clearInterval(activeWellPoll);
            window.removeEventListener('well-active-changed', loadActiveWell);
            socket.off('dashboard_layout_update', handleLayoutUpdate);
            socket.off('connect', handleConnect);
            socket.off('disconnect', handleDisconnect);
            socket.off('connect_error', handleConnectError);
            socket.off('rig_data', handleRigData);
        };
    }, []);

    const handleEditClick = () => {
        if (user?.role !== 'admin') return;
        setTempInfo(wellInfo);
        setInfoError('');
        setIsDialogOpen(true);
    };

    const handleSaveInfo = async () => {
        if (user?.role !== 'admin') return;
        const nextInfo = {
            rig: tempInfo.rig.trim(),
            well: tempInfo.well.trim()
        };
        if (!nextInfo.rig || !nextInfo.well) {
            setInfoError('Rig name and well name are required.');
            return;
        }

        try {
            const { data } = await axios.post('/api/dashboard/layout', { wellInfo: nextInfo });
            setWellInfo(data?.config?.wellInfo || nextInfo);
            setIsDialogOpen(false);
        } catch (e) {
            console.error("Failed to save rig info", e);
            setInfoError(e.response?.data?.error || 'Failed to save rig details.');
        }
    };

    const handleMenuOpen = (event) => {
        setMenuAnchor(event.currentTarget);
    };

    const handleMenuClose = () => {
        setMenuAnchor(null);
    };

    const handleNavClick = (path) => {
        navigate(path);
        setMenuAnchor(null);
    };

    const currentPage = navItems.find(item => item.path === location.pathname);

    // When a well is active in the Well registry, the top bar reflects it.
    // Otherwise fall back to the admin-editable dashboard wellInfo.
    const displayWell = activeWell?.name || wellInfo.well;
    const displayRig = activeWell?.rig || wellInfo.rig;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
            <CssBaseline />

            {/* Top AppBar */}
            <AppBar
                position="sticky"
                sx={{
                    top: 0,
                    bgcolor: '#0f172a',
                    borderBottom: '1px solid #334155',
                    boxShadow: 'none',
                    zIndex: (theme) => theme.zIndex.drawer + 1
                }}
            >
                <Toolbar
                    sx={{
                        gap: { xs: 1, md: 2 },
                        alignItems: 'center',
                        flexWrap: { xs: 'wrap', md: 'nowrap' },
                        minHeight: { xs: 'auto', md: 64 },
                        py: { xs: 1, md: 0 },
                        px: { xs: 1.5, sm: 2, md: 3 }
                    }}
                >
                    {/* App Name */}
                    <Typography
                        variant="h6"
                        noWrap
                        onClick={() => navigate('/')}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                navigate('/');
                            }
                        }}
                        title="Open Rig Overview"
                        sx={{
                            fontWeight: 'bold',
                            color: '#38bdf8',
                            mr: { xs: 0.5, md: 1 },
                            fontSize: { xs: '1rem', sm: '1.25rem' },
                            cursor: 'pointer',
                            userSelect: 'none',
                            '&:hover': { color: '#7dd3fc' }
                        }}
                    >
                        AHWR-150 Twin
                    </Typography>

                    {/* Navigation Dropdown Button */}
                    <Button
                        onClick={handleMenuOpen}
                        sx={{
                            color: 'white',
                            textTransform: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            px: { xs: 1, sm: 2 },
                            py: 0.8,
                            borderRadius: 1,
                            minWidth: 0,
                            maxWidth: { xs: 150, sm: 'none' },
                            bgcolor: menuAnchor ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255,255,255,0.05)',
                            border: '1px solid #334155',
                            '&:hover': { bgcolor: 'rgba(56, 189, 248, 0.1)', borderColor: '#38bdf8' }
                        }}
                    >
                        {currentPage?.icon}
                        {!currentPage?.hideCurrentLabel && (
                            <Typography variant="body1" noWrap sx={{ fontWeight: 'bold', fontSize: { xs: 13, sm: 16 } }}>
                                {currentPage?.text || 'Rig Overview'}
                            </Typography>
                        )}
                        <ChevronDown size={16} style={{ transform: menuAnchor ? 'rotate(180deg)' : 'rotate(0deg)', transition: '0.2s' }} />
                    </Button>

                    {/* Dropdown Menu */}
                    <Popover
                        open={Boolean(menuAnchor)}
                        anchorEl={menuAnchor}
                        onClose={handleMenuClose}
                        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
                        PaperProps={{
                            sx: {
                                bgcolor: '#1e293b',
                                border: '1px solid #334155',
                                borderRadius: 2,
                                minWidth: 220,
                                mt: 0.5,
                                boxShadow: '0 4px 20px rgba(0,0,0,0.4)'
                            }
                        }}
                    >
                        <List sx={{ py: 0.5 }}>
                            {navItems.map((item) => {
                                const isActive = location.pathname === item.path;
                                return (
                                    <ListItem key={item.text} disablePadding>
                                        <ListItemButton
                                            onClick={() => handleNavClick(item.path)}
                                            sx={{
                                                px: 2, py: 1,
                                                bgcolor: isActive ? 'rgba(56, 189, 248, 0.1)' : 'transparent',
                                                borderLeft: isActive ? '3px solid #38bdf8' : '3px solid transparent',
                                                '&:hover': { bgcolor: 'rgba(56, 189, 248, 0.08)' }
                                            }}
                                        >
                                            <ListItemIcon sx={{ color: isActive ? '#38bdf8' : '#94a3b8', minWidth: 36 }}>
                                                {item.icon}
                                            </ListItemIcon>
                                            <ListItemText
                                                primary={item.text}
                                                primaryTypographyProps={{
                                                    sx: { color: isActive ? '#38bdf8' : 'white', fontWeight: isActive ? 'bold' : 'normal', fontSize: 14 }
                                                }}
                                            />
                                        </ListItemButton>
                                    </ListItem>
                                );
                            })}
                        </List>
                    </Popover>

                    {/* Live Rig Parameters */}
                    <Box sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: { xs: 0.5, xl: 2 },
                        flexGrow: 1,
                        ml: { xs: 1, md: 2 },
                        mr: { xs: 1, md: 2 },
                        flexWrap: 'nowrap',
                        overflow: 'hidden',
                    }}>
                        {/* OP.MODE */}
                        <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', bgcolor: '#1e293b', px: { xs: 1, sm: 3 }, height: 60, borderRadius: 1, border: '1px solid #334155', minWidth: 100 }}>
                            <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>OP.MODE</Typography>
                            <Typography variant="subtitle2" sx={{ color: getOpModeColor(liveParams.opMode), fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>
                                {getOpModeLabel(liveParams.opMode)}
                            </Typography>
                        </Box>
                        {/* ACS */}
                        <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', bgcolor: '#1e293b', px: { xs: 1, sm: 3 }, height: 60, borderRadius: 1, border: '1px solid #334155', minWidth: 90 }}>
                            <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>ACS</Typography>
                            <Typography variant="subtitle2" sx={{ color: getAcsColor(liveParams.acsStatus), fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>
                                {getAcsStatusLabel(liveParams.acsStatus)}
                            </Typography>
                        </Box>
                        {/* TOTAL BIT DEPTH */}
                        <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', bgcolor: '#1e293b', px: { xs: 1, sm: 3 }, height: 60, borderRadius: 1, border: '1px solid #334155', minWidth: 110 }}>
                            <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>HOLE DEPTH</Typography>
                            <Typography variant="subtitle2" sx={{ color: '#4ade80', fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>
                                {liveParams.holeDepth != null && Number.isFinite(Number(liveParams.holeDepth)) ? Number(liveParams.holeDepth).toFixed(2) : '--'}
                                <Typography component="span" variant="caption" sx={{ ml: 0.5, color: '#64748b', fontSize: 11 }}>m</Typography>
                            </Typography>
                        </Box>
                        {/* BIT DEPTH */}
                        <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', bgcolor: '#1e293b', px: { xs: 1, sm: 3 }, height: 60, borderRadius: 1, border: '1px solid #334155', minWidth: 110 }}>
                            <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>BIT DEPTH</Typography>
                            <Typography variant="subtitle2" sx={{ color: '#38bdf8', fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>
                                {liveParams.bitDepth != null && Number.isFinite(Number(liveParams.bitDepth)) ? Number(liveParams.bitDepth).toFixed(2) : '--'}
                                <Typography component="span" variant="caption" sx={{ ml: 0.5, color: '#64748b', fontSize: 11 }}>m</Typography>
                            </Typography>
                        </Box>
                    </Box>



                    {/* Right side - Connection status, Rig/Well info & Logout */}
                    <Box sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: { xs: 'flex-start', md: 'flex-end' },
                        gap: { xs: 1, md: 2 },
                        flexWrap: 'wrap',
                        flex: { xs: '1 1 auto', md: '0 0 auto' },
                        minWidth: 0
                    }}>
                        {/* Rig / Well Info */}
                        <Box
                            onClick={user?.role === 'admin' ? handleEditClick : undefined}
                            title={user?.role === 'admin' ? 'Edit rig and well details' : undefined}
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: { xs: 1, sm: 3 },
                                bgcolor: '#1e293b',
                                px: { xs: 1, sm: 3 },
                                height: 60,
                                borderRadius: 1,
                                minWidth: 0,
                                cursor: user?.role === 'admin' ? 'pointer' : 'default',
                                border: user?.role === 'admin' ? '1px solid rgba(56, 189, 248, 0.4)' : '1px solid #334155',
                                '&:hover': user?.role === 'admin' ? { borderColor: 'rgba(56, 189, 248, 0.8)' } : undefined
                            }}
                        >
                            <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>RIG</Typography>
                                <Typography variant="subtitle2" sx={{ color: '#38bdf8', fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>{displayRig}</Typography>
                            </Box>
                            <Box sx={{ width: '1px', height: '32px', bgcolor: '#334155' }} />
                            <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>WELL</Typography>
                                <Typography variant="subtitle2" sx={{ color: activeWell ? '#4ade80' : '#38bdf8', fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>{displayWell}</Typography>
                            </Box>
                            {user?.role === 'admin' && (
                                <IconButton size="small" onClick={(event) => { event.stopPropagation(); handleEditClick(); }} sx={{ color: '#38bdf8', bgcolor: 'rgba(56, 189, 248, 0.1)', ml: { xs: 0, sm: 1 }, '&:hover': { bgcolor: 'rgba(56, 189, 248, 0.2)' } }}>
                                    <Edit2 size={14} />
                                </IconButton>
                            )}
                        </Box>
                        
                        <ThemeSwitcher />

                        <IconButton onClick={handleLogout} sx={{ color: '#ef4444', '&:hover': { bgcolor: 'rgba(239, 68, 68, 0.1)' } }} title="Logout">
                            <LogOut size={20} />
                        </IconButton>
                    </Box>
                </Toolbar>
            </AppBar>

            {/* Persistent global alarm strip — shown on every route, directly below the AppBar. */}
            {location.pathname !== '/' && location.pathname !== '/edr' && (
            <Box
                sx={{
                    position: 'sticky',
                    top: { xs: 'auto', md: 64 },
                    zIndex: (theme) => theme.zIndex.drawer,
                }}
            >
                <AlarmStrip />
            </Box>
            )}
            <CentralMessages />

            {/* Edit Details Dialog */}
            <Dialog open={isDialogOpen} onClose={() => setIsDialogOpen(false)} PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 400 } }}>
                <DialogTitle>Edit Rig / Well Details</DialogTitle>
                <DialogContent>
                    {infoError && (
                        <Alert severity="error" sx={{ mb: 2, bgcolor: 'rgba(127, 29, 29, 0.45)', color: '#fecaca' }}>
                            {infoError}
                        </Alert>
                    )}
                    <TextField
                        autoFocus
                        margin="dense"
                        label="Rig Name"
                        fullWidth
                        variant="outlined"
                        value={tempInfo.rig}
                        onChange={(e) => setTempInfo({ ...tempInfo, rig: e.target.value })}
                        helperText="Admin editable"
                        sx={{
                            mb: 2,
                            '& .MuiOutlinedInput-root': { color: 'white', '& fieldset': { borderColor: '#334155' } },
                            '& .MuiInputLabel-root': { color: '#94a3b8' },
                            '& .MuiFormHelperText-root': { color: '#64748b' }
                        }}
                    />
                    <TextField
                        margin="dense"
                        label="Well Name"
                        fullWidth
                        variant="outlined"
                        value={tempInfo.well}
                        onChange={(e) => setTempInfo({ ...tempInfo, well: e.target.value })}
                        sx={{
                            '& .MuiOutlinedInput-root': { color: 'white', '& fieldset': { borderColor: '#334155' } },
                            '& .MuiInputLabel-root': { color: '#94a3b8' }
                        }}
                    />
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 3 }}>
                    <Button onClick={() => setIsDialogOpen(false)} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button onClick={handleSaveInfo} variant="contained" sx={{ bgcolor: '#38bdf8', color: '#0f172a', '&:hover': { bgcolor: '#0ea5e9' } }}>Save Changes</Button>
                </DialogActions>
            </Dialog>

            {/* Main Content */}
            <Box
                component="main"
                sx={{
                    flexGrow: 1,
                    p: { xs: 2, sm: 3 },
                    // Honor the active theme so the shell background changes when the theme switches.
                    bgcolor: 'background.default',
                    minHeight: '100vh',
                    color: 'text.primary',
                    overflowX: 'hidden'
                }}
            >
                <Outlet />
            </Box>
        </Box>
    );
}
