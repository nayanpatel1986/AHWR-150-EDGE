import React, { useState, useEffect, useMemo } from 'react';
import { Grid, Paper, Typography, Box, IconButton, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, MenuItem, Select, InputLabel, FormControl, useTheme, alpha } from '@mui/material';
import { socket } from '../../socket';
import AnalogGauge from '../Common/AnalogGauge';
import RigVisualizer from './RigVisualizer';
import axios from '../../api';
import { useAuth } from '../../context/AuthContext';
import { Responsive, WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const ResponsiveGridLayout = WidthProvider(Responsive);
const GRID_BREAKPOINTS = ['lg', 'md', 'sm', 'xs', 'xxs'];

const cloneGridItem = (item) => ({ ...item });
import {
    Settings,
    Edit2,
    Plus,
    Trash2,
    Check,
    X,
    Activity,
    ShieldCheck,
    Droplets,
    Zap,
    Clock3,
    Bell
} from 'lucide-react';

// Default Config with Layout Props
const DEFAULT_DASHBOARD_GAUGES = [
    { id: 'd1', label: 'WOH', dataKey: 'hook_load', min: 0, max: 100, unit: 'ton', color: '#3182ce', majorTicks: 10, minorTicks: 4, layout: { i: 'd1', x: 0, y: 0, w: 4, h: 4, minW: 3, minH: 3 } },
    { id: 'd2', label: 'SPP', dataKey: 'SPP-Bar', min: 0, max: 5000, unit: 'psi', color: '#fbbf24', majorTicks: 5, minorTicks: 4, layout: { i: 'd2', x: 4, y: 0, w: 4, h: 4, minW: 3, minH: 3 } },
    { id: 'd6', label: 'HTD', dataKey: 'htd_rpm', min: 0, max: 200, unit: 'RPM', color: '#4ade80', layout: { i: 'd6', x: 8, y: 0, w: 4, h: 4, minW: 3, minH: 3 } },
];
const LONG_TREND_HISTORY_RANGE = '-24h';
const LONG_TREND_LIVE_INTERVAL_MS = 60 * 1000;
const LONG_TREND_MAX_POINTS = 24 * 60;

const DEFAULT_BOTTOM_STATS = [
    {
        id: 'p1',
        title: 'DRILLING PARAMETERS',
        layout: { i: 'p1', x: 0, y: 4, w: 3, h: 4, minW: 2, minH: 3 },
        params: [
            { id: 'p1_1', label: 'FLOW IN', dataKey: 'flow_in', unit: 'Lt/min' },
            { id: 'p1_2', label: 'FLOW OUT', dataKey: 'flow_out', unit: '%' },
            { id: 'p1_3', label: 'ROP', dataKey: 'rop', unit: 'm/h' },
            { id: 'p1_4', label: 'SPP', dataKey: 'pump_pressure', unit: 'Bar' },
            { id: 'p1_5', label: 'TOTAL STROKES', dataKey: 'total_strokes', unit: '' }
        ]
    },
    {
        id: 'p2',
        title: 'HTD STATUS',
        layout: { i: 'p2', x: 3, y: 4, w: 3, h: 4, minW: 2, minH: 3 },
        params: [
            { id: 'p2_1', label: 'IBOP', dataKey: 'ibop_status', unit: '' },
            { id: 'p2_2', label: 'ELEVATOR', dataKey: 'elevator_status', unit: '' },
            { id: 'p2_3', label: 'BREAK', dataKey: 'brake_status', unit: '' },
            { id: 'p2_4', label: 'SPEED', dataKey: 'vertical_speed', unit: 'mm/sec' },
            { id: 'p2_5', label: 'LINK TILT', dataKey: 'tilt_status', unit: '' }
        ]
    },
    {
        id: 'p3',
        title: 'EQUIPMENT STATUS',
        layout: { i: 'p3', x: 6, y: 4, w: 3, h: 4, minW: 2, minH: 3 },
        params: [
            { id: 'p3_1', label: 'HPU', dataKey: 'hpu_status', unit: '' },
            { id: 'p3_2', label: 'HTD', dataKey: 'htd_status', unit: '' },
            { id: 'p3_3', label: 'PCT', dataKey: 'pct_status', unit: '' },
            { id: 'p3_4', label: 'CAT ENGINE', dataKey: 'engine_status', unit: '' },
            { id: 'p3_5', label: 'CWK', dataKey: 'cwk_status', unit: '' }
        ]
    },
    {
        id: 'p5',
        title: 'CAT ENG',
        layout: { i: 'p5', x: 9, y: 4, w: 3, h: 2, minW: 2, minH: 2 },
        params: [
            { id: 'p5_1', label: 'RPM', dataKey: 'cat_rpm', unit: 'RPM' },
            { id: 'p5_2', label: 'OIL P.', dataKey: 'cat_oil_press', unit: 'bar' }
        ]
    }
];

export default function RigOverview() {
    const { user } = useAuth();
    const theme = useTheme();
    const canEditLayout = user?.role === 'admin';

    // --- State ---
    const [rigData, setRigData] = useState({
        hook_load: 0, pump_pressure: 0, torque: 0,
        block_position: 0, flow_in: 0, flow_out: 0,
        wob: 0, bit_depth: 0, hole_depth: 0,
        slip_in_raw: 0, slip_out_raw: 0,
        trip_tank: 0, total_active_volume: 0,
        htd_rpm: 0, htd_torque: 0, ahtd_torque: 0,
        htd_work_mode: 0, htd_rotation_status: 0, htd_gear_status: 0,
        pct_torque: 0, pct_last_torque: 0,
        pct_rotation_pressure: 0, pct_accumulator_pressure: 0, pct_op_mode: 0,
        pct_clamp_up_status: 0, pct_clamp_low_status: 0, pct_dolly_status: 0,
        crownsaver_threshold: 40000, floorsaver_threshold: 2000,
        crownsaverOn: false, floorsaverOn: false,
        travelling_up: false, travelling_down: false,
        slips_in: false, // no dedicated slips sensor mapped on this rig; defined to avoid undefined access
        acs_status: 0,
        cat_load: 0,
        hpu_discharge_pressure: 0, hpu_aux_pressure: 0,
        hpu_oil_temp: 0, hpu_oil_level: 0,
        hpu_pdw_status: 0, hpu_pdw_flow_sp: 0, hpu_pdw_flow: 0, hpu_pdw_press_sp: 0, hpu_pdw_press: 0,
        hpu_htd1_status: 0, hpu_htd1_flow_sp: 0, hpu_htd1_flow: 0, hpu_htd1_press_sp: 0, hpu_htd1_press: 0,
        hpu_htd2_status: 0, hpu_htd2_flow_sp: 0, hpu_htd2_flow: 0, hpu_htd2_press_sp: 0, hpu_htd2_press: 0,
        hpu_filter_1: 0, hpu_filter_2: 0, hpu_filter_3: 0
        ,bop: { connected: false, quality: 'disconnected' }
    });
    const [trendData, setTrendData] = useState({
        hook_load: [],
        htd_rpm: [],
        cat_rpm: [],
        cat_load: []
    });

    const prevBlockPosRef = React.useRef(0);
    const lastLongTrendAppendAtRef = React.useRef(0);

    useEffect(() => {
        let cancelled = false;
        const params = new URLSearchParams({
            range: LONG_TREND_HISTORY_RANGE,
            metrics: 'drawworks.hook_load,htd.rpm'
        });
        axios.get(`/api/history?${params.toString()}`)
            .then(({ data }) => {
                if (cancelled || !Array.isArray(data)) return;
                const hookLoad = data
                    .map(row => Number(row['drawworks.hook_load']))
                    .filter(value => Number.isFinite(value));
                const htdRpm = data
                    .map(row => Number(row['htd.rpm']))
                    .filter(value => Number.isFinite(value));
                setTrendData(prev => ({
                    ...prev,
                    hook_load: hookLoad.length ? hookLoad.slice(-LONG_TREND_MAX_POINTS) : prev.hook_load,
                    htd_rpm: htdRpm.length ? htdRpm.slice(-LONG_TREND_MAX_POINTS) : prev.htd_rpm
                }));
                lastLongTrendAppendAtRef.current = Date.now();
            })
            .catch(err => console.error('Failed to load 24h gauge trends:', err));
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        const now = Date.now();
        const shouldAppendLongTrend = now - lastLongTrendAppendAtRef.current >= LONG_TREND_LIVE_INTERVAL_MS;
        setTrendData(prev => {
            const append = (key, maxPoints = 48) => [...prev[key], Number(rigData[key]) || 0].slice(-maxPoints);
            if (shouldAppendLongTrend) lastLongTrendAppendAtRef.current = now;
            return {
                hook_load: shouldAppendLongTrend ? append('hook_load', LONG_TREND_MAX_POINTS) : prev.hook_load,
                htd_rpm: shouldAppendLongTrend ? append('htd_rpm', LONG_TREND_MAX_POINTS) : prev.htd_rpm,
                cat_rpm: append('cat_rpm'),
                cat_load: append('cat_load')
            };
        });
    }, [rigData.hook_load, rigData.htd_rpm, rigData.cat_rpm, rigData.cat_load]);

    const [gauges, setGauges] = useState(DEFAULT_DASHBOARD_GAUGES);
    const [bottomStats, setBottomStats] = useState(DEFAULT_BOTTOM_STATS);
    const [layoutLoaded, setLayoutLoaded] = useState(false);
    const [editMode, setEditMode] = useState(false);
    const [editingGauge, setEditingGauge] = useState(null);
    const [editingBottomStat, setEditingBottomStat] = useState(null);
    const [visualizerLayout, setVisualizerLayout] = useState({ i: 'rig-visualizer', x: 0, y: 0, w: 3, h: 8, minW: 2, minH: 4 });

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

    const getStatusLabel = (key, value) => {
        const val = Number(value);
        if (key === 'hpu_status' || key === 'htd_status' || key === 'pct_status') {
            switch (val) {
                case 0: return { label: "OFF", color: "#ef4444" };
                case 1: return { label: "ON IDLE", color: "#fbbf24" };
                case 2: return { label: "ON", color: "#4ade80" };
                default: return { label: "UNKNOWN", color: "#94a3b8" };
            }
        }
        if (key === 'engine_status') {
            switch (val) {
                case -1: return { label: "UNKNOWN", color: "#94a3b8" };
                case 0: return { label: "READY", color: "#38bdf8" };
                case 1: return { label: "IN PROGRESS", color: "#fbbf24" };
                case 2: return { label: "DONE", color: "#4ade80" };
                case 3: return { label: "EMG NOT OK", color: "#ef4444" };
                case 4: return { label: "NOT READY", color: "#ef4444" };
                case 5: return { label: "FAULT", color: "#ef4444" };
                case 6: return { label: "RUN+FAULT", color: "#f97316" };
                case 7: return { label: "STOP FORCED", color: "#ef4444" };
                default: return { label: "UNKNOWN", color: "#94a3b8" };
            }
        }
        if (key === 'cwk_status') {
            return val === 1 ? { label: "PARKED", color: "#4ade80" } : { label: "NOT PARKED", color: "#fbbf24" };
        }
        if (key === 'ibop_status' || key === 'elevator_status') {
            switch (val) {
                case 1: return { label: "OPENING", color: "#fbbf24" };
                case 2: return { label: "CLOSING", color: "#fbbf24" };
                case 3: return { label: "OPEN", color: "#4ade80" };
                case 4: return { label: "CLOSE", color: "#ef4444" };
                case 5: return { label: "FAULT", color: "#ef4444" };
                default: return { label: "UNKNOWN", color: "#94a3b8" };
            }
        }
        if (key === 'brake_status') {
            switch (val) {
                case 1: return { label: "CLOSING", color: "#fbbf24" };
                case 2: return { label: "CLOSED", color: "#ef4444" };
                case 3: return { label: "OPENING", color: "#fbbf24" };
                case 4: return { label: "OPEN", color: "#4ade80" };
                case 5: return { label: "FAULT", color: "#ef4444" };
                default: return { label: "UNKNOWN", color: "#94a3b8" };
            }
        }
        if (key === 'tilt_status') {
            switch (val) {
                case 1: return { label: "FLOAT ON", color: "#38bdf8" };
                case 2: return { label: "VERTICAL", color: "#4ade80" };
                case 3: return { label: "FLOAT OFF", color: "#94a3b8" };
                case 4: return { label: "EXTEND", color: "#fbbf24" };
                case 5: return { label: "RETRACT", color: "#fbbf24" };
                case 6: return { label: "FAULT", color: "#ef4444" };
                default: return { label: "NONE/UNKNOWN", color: "#94a3b8" };
            }
        }
        if (key === 'pct_sequence') {
            switch (val) {
                case 1: return { label: "MAKE-UP", color: "#4ade80" };
                case 2: return { label: "BREAK-OUT", color: "#fbbf24" };
                case 3: return { label: "RESET", color: "#38bdf8" };
                case 4: return { label: "FAULT", color: "#ef4444" };
                default: return { label: "OFF", color: "#94a3b8" };
            }
        }
        if (key === 'spinner_floating') {
            switch (val) {
                case 1: return { label: "ON", color: "#4ade80" };
                case 10: return { label: "NO SPIN", color: "#94a3b8" };
                default: return { label: "OFF", color: "#ef4444" };
            }
        }
        if (key === 'cwk_clamp_status') {
            switch (val) {
                case 1: return { label: "OPENING", color: "#fbbf24" };
                case 2: return { label: "CLOSING", color: "#fbbf24" };
                case 3: return { label: "OPEN", color: "#4ade80" };
                case 4: return { label: "CLOSE", color: "#ef4444" };
                case 5: return { label: "FAULT", color: "#ef4444" };
                default: return { label: "NONE", color: "#94a3b8" };
            }
        }
        return null;
    };
    const [isDialogOpen, setIsDialogOpen] = useState(false);

    // Drag State for Visual Feedback


    // Unit State
    // Unit State
    const [units, setUnits] = useState({ wob: 'tonnes', depth: 'm' });

    const [tempStatKey, setTempStatKey] = useState('');

    // Live-data freshness / connection state (so a dead feed looks different from an idle rig).
    const [feedState, setFeedState] = useState({
        socketConnected: socket.connected,
        liveConnected: false,
        stale: false,
        hasData: false
    });

    // --- Effects ---
    useEffect(() => {
        if (import.meta.env.DEV) console.log("Fetching dashboard layout and latest data...");
        // Load Global Layout from Backend
        axios.get(`/api/dashboard/layout?t=${Date.now()}`)
            .then(({ data: config }) => {
                if (config.gauges) setGauges(config.gauges);
                if (config.units) setUnits(config.units);
                if (config.bottomStats) setBottomStats(config.bottomStats);
                if (config.visualizerLayout) setVisualizerLayout(config.visualizerLayout);
            })
            .catch(err => console.error("Failed to load dashboard layout:", err))
            .finally(() => setLayoutLoaded(true));

        // Fetch Latest Data for immediate display
        axios.get('/api/rig/latest')
            .then(({ data: newData }) => {
                if (newData && Object.keys(newData).length > 0) {
                    processRigData(newData);
                }
            })
            .catch(err => console.error("Failed to fetch latest rig data:", err));
    }, []);

    const processRigData = (newData) => {
        const flattened = {
            hook_load: newData.drawworks?.hook_load || 0,
            block_position: newData.drawworks?.block_position || 0,
            pump_pressure: newData.mudpump?.pressure || 0,
            torque: newData.drilling?.torque || 0,

            flow_in: newData.mudpump?.flow_in || 0,
            flow_out: newData.mudpump?.flow_out || 0,
            spm: newData.mudpump?.spm || 0,
            total_strokes: newData.mudpump?.total_spm || 0,

            // Physics & Drilling Data
            wob: newData.drilling?.wob !== undefined ? newData.drilling.wob : 0,
            bit_depth: newData.drilling?.bit_depth || 0,
            hole_depth: newData.drilling?.hole_depth || 0,
            rop: newData.drilling?.rop || 0,
            operation_mode: newData.drilling?.operation_mode || 0,
            slip_in_raw: Number(newData.acs?.slip_in) || 0,
            slip_out_raw: Number(newData.acs?.slip_out) || 0,
            slips_in: Number(newData.acs?.slip_in) > 0
                ? true
                : (Number(newData.acs?.slip_out) > 0 ? false : false),

            // HTD Data
            htd_rpm: newData.htd?.rpm || 0,
            htd_torque: newData.htd?.torque_command || 0,
            ahtd_torque: newData.htd?.torque || 0,
            htd_status: newData.htd?.status || 0,
            htd_work_mode: newData.htd?.work_mode || 0,
            htd_rotation_status: newData.htd?.rotation_status || 0,
            htd_gear_status: newData.htd?.gear_status || 0,
            ibop_status: newData.htd?.ibop_status || 0,
            elevator_status: newData.htd?.elevator_status || 0,
            brake_status: newData.htd?.brake_status || 0,
            vertical_speed: newData.htd?.vertical_speed || 0,
            tilt_status: newData.htd?.tilt_status || 0,

            // PCT Data
            pct_torque: newData.pct?.makeup_torque || 0,
            pct_last_torque: newData.pct?.last_makeup_torque || 0,
            pct_status: newData.pct?.status || 0,
            pct_sequence: newData.pct?.sequence || 0,
            spinner_floating: newData.pct?.spinner_floating || 0,
            spinner_makeup_torque: newData.pct?.spinner_makeup_torque || 0,
            pct_rotation_pressure: newData.pct?.rotation_makeup_pressure || 0,
            pct_accumulator_pressure: newData.pct?.clamp_up_pressure || 0,
            pct_op_mode: newData.pct?.op_mode || 0,
            pct_clamp_up_status: newData.pct?.clamp_up_status || 0,
            pct_clamp_low_status: newData.pct?.clamp_low_status || 0,
            pct_dolly_status: newData.pct?.dolly_status || 0,

            // HPU Data
            hpu_status: newData.hpu?.status || 0,
            hpu_discharge_pressure: newData.hpu?.discharge_pressure || 0,
            hpu_aux_pressure: newData.hpu?.aux_pressure || 0,
            hpu_oil_temp: newData.hpu?.oil_temp || 0,
            hpu_oil_level: newData.hpu?.oil_level || 0,
            hpu_pdw_status: newData.hpu?.pdw_pump_status || 0,
            hpu_pdw_flow_sp: newData.hpu?.pdw_pump_flow_sp || 0,
            hpu_pdw_flow: newData.hpu?.pdw_pump_flow || 0,
            hpu_pdw_press_sp: newData.hpu?.pdw_pump_press_sp || 0,
            hpu_pdw_press: newData.hpu?.pdw_pump_press || 0,
            hpu_htd1_status: newData.hpu?.htd_pump1_status || 0,
            hpu_htd1_flow_sp: newData.hpu?.htd_pump1_flow_sp || 0,
            hpu_htd1_flow: newData.hpu?.htd_pump1_flow || 0,
            hpu_htd1_press_sp: newData.hpu?.htd_pump1_press_sp || 0,
            hpu_htd1_press: newData.hpu?.htd_pump1_press || 0,
            hpu_htd2_status: newData.hpu?.htd_pump2_status || 0,
            hpu_htd2_flow_sp: newData.hpu?.htd_pump2_flow_sp || 0,
            hpu_htd2_flow: newData.hpu?.htd_pump2_flow || 0,
            hpu_htd2_press_sp: newData.hpu?.htd_pump2_press_sp || 0,
            hpu_htd2_press: newData.hpu?.htd_pump2_press || 0,
            hpu_filter_1: newData.hpu?.oil_filter_1 || 0,
            hpu_filter_2: newData.hpu?.oil_filter_2 || 0,
            hpu_filter_3: newData.hpu?.oil_filter_3 || 0,

            // CAT Engine
            engine_status: newData.cat_engine?.status || 0,
            cat_rpm: newData.cat_engine?.rpm || 0,
            cat_oil_press: newData.cat_engine?.oil_pressure || 0,
            cat_load: newData.cat_engine?.load || 0,

            // CWK Data
            cwk_status: newData.cwk?.status || 0,
            cwk_clamp_status: newData.cwk?.clamp_status || 0,
            cwk_clamp_pressure: newData.cwk?.clamp_pressure || 0,

            // Fluid System
            trip_tank: newData.fluid?.trip_tank || 0,
            total_active_volume: newData.fluid?.total_tank_volume || 0,

            // Safety Thresholds from ACS
            crownsaver_threshold: newData.acs?.crownsaver || 40000,
            floorsaver_threshold: newData.acs?.floorsaver || 2000,
            acs_status: newData.acs?.status || 0,

            // Digital Inputs - Calculated locally below
            bop: newData.bop || { connected: false, quality: 'disconnected' },
        };

        // Local status calculation
        const currentBlockPos = flattened.block_position;
        const prevBlockPos = prevBlockPosRef.current;
        const delta = currentBlockPos - prevBlockPos;

        flattened.travelling_up = delta > 0.05;
        flattened.travelling_down = delta < -0.05;
        flattened.crownsaverOn = (currentBlockPos * 1000) >= flattened.crownsaver_threshold;
        flattened.floorsaverOn = (currentBlockPos * 1000) <= flattened.floorsaver_threshold;

        prevBlockPosRef.current = currentBlockPos;

        setRigData(prev => ({ ...prev, ...flattened }));
    };



    // --- Effects ---
    // (Consolidated above)

    useEffect(() => {
        // Real-time Layout Updates
        const handleLayoutUpdate = (config) => {
            if (import.meta.env.DEV) console.log("Received real-time layout update:", config);
            if (config.gauges) setGauges(config.gauges);
            if (config.units) setUnits(config.units);
            if (config.bottomStats) setBottomStats(config.bottomStats);
            if (config.visualizerLayout) setVisualizerLayout(config.visualizerLayout);
        };
        socket.on('dashboard_layout_update', handleLayoutUpdate);

        const handleRigData = (newData) => {
            // Track feed freshness from server metadata (when present).
            const meta = newData && newData._meta;
            setFeedState(prev => ({
                socketConnected: socket.connected,
                liveConnected: meta ? !!meta.connected : prev.liveConnected,
                stale: meta ? !!meta.stale : prev.stale,
                hasData: meta ? !!meta.connected : prev.hasData
            }));

            // If we receive an empty object or null, force release to zero
            if (!newData || Object.keys(newData).length === 0) {
                setRigData(prev => ({
                    ...prev,
                    hook_load: 0, pump_pressure: 0, torque: 0,
                    block_position: 0, flow_in: 0, flow_out: 0,
                    wob: 0, trip_tank: 0, total_active_volume: 0, spm: 0, total_strokes: 0,
                    htd_rpm: 0, htd_torque: 0, ahtd_torque: 0,
                    pct_torque: 0, pct_last_torque: 0,
                    pct_sequence: 0, spinner_floating: 0,
                    spinner_makeup_torque: 0,
                    cwk_clamp_status: 0, cwk_clamp_pressure: 0,
                }));
                return;
            }
            processRigData(newData);
        };
        socket.on('rig_data', handleRigData);

        const handleConnect = () => setFeedState(prev => ({ ...prev, socketConnected: true }));
        const handleDisconnect = () => setFeedState(prev => ({ ...prev, socketConnected: false, liveConnected: false }));
        socket.on('connect', handleConnect);
        socket.on('disconnect', handleDisconnect);

        return () => {
            socket.off('dashboard_layout_update', handleLayoutUpdate);
            socket.off('rig_data', handleRigData);
            socket.off('connect', handleConnect);
            socket.off('disconnect', handleDisconnect);
        };
    }, []);

    // --- Helpers ---
    const saveLayout = (newGauges, newBottomStats, newVisualizerLayout) => {
        const payload = {
            gauges: newGauges || gauges,
            bottomStats: newBottomStats || bottomStats,
            visualizerLayout: newVisualizerLayout || visualizerLayout,
            units
        };
        axios.post('/api/dashboard/layout', payload)
            .catch(e => console.error("Failed to save layout", e));
    };

    const saveGauges = (newGauges) => {
        setGauges(newGauges);
        saveLayout(newGauges, null, null);
    };

    const saveBottomStats = (newBottomStats) => {
        setBottomStats(newBottomStats);
        saveLayout(null, newBottomStats, null);
    };

    const saveVisualizerLayout = (newVisLayout) => {
        setVisualizerLayout(newVisLayout);
        saveLayout(null, null, newVisLayout);
    };

    const saveUnits = (newUnits) => {
        setUnits(newUnits);
        if (canEditLayout) {
            axios.post('/api/dashboard/layout', { gauges, bottomStats, units: newUnits })
                .catch(e => console.error("Failed to save layout", e));
        }
    };

    const formatWOB = (val) => {
        const wob = Number(val) || 0;
        if (units.wob === 'lbs') return (wob * 2204.6226218).toFixed(2);
        if (units.wob === 'kips') return (wob * 2.2046226218).toFixed(2);
        return wob.toFixed(2); // tonnes
    };

    const wobUnitLabel = units.wob === 'tonnes' ? 'ton' : units.wob;

    // --- Handlers ---
    const handleAddGauge = () => {
        if (gauges.length >= 5) return;
        const newId = `d-${Date.now()}`;
        const newGauge = {
            id: newId,
            label: 'NEW GAUGE',
            dataKey: 'hook_load',
            min: 0, max: 100,
            unit: 'unit',
            color: '#3182ce',
            gridWidth: 3,
            size: 160
        };
        saveGauges([...gauges, newGauge]);
    };

    const handleRemoveGauge = (id) => {
        if (window.confirm("Delete this gauge?")) {
            saveGauges(gauges.filter(g => g.id !== id));
        }
    };

    const handleEditSave = () => {
        const newGauges = gauges.map(g => g.id === editingGauge.id ? editingGauge : g);
        saveGauges(newGauges);
        setIsDialogOpen(false);
    };

    const handleBottomStatEditSave = () => {
        const newStats = bottomStats.map(s => s.id === editingBottomStat.id ? editingBottomStat : s);
        saveBottomStats(newStats);
        setEditingBottomStat(null);
    };

    const handleReset = () => {
        if (window.confirm("Reset dashboard to default CENTERED layout?")) {
            saveGauges(DEFAULT_DASHBOARD_GAUGES);
        }
    };

    // --- Digital Inputs are now directly parsed from Rig Data ---

    const feedAlert = !feedState.socketConnected
        ? { text: 'BACKEND SOCKET DISCONNECTED', color: '#ef4444' }
        : (!feedState.hasData || !feedState.liveConnected
            ? { text: 'NO PLC DATA - CHECK PLC IP / PORT 102', color: '#ef4444' }
            : (feedState.stale
                ? { text: 'STALE PLC DATA - FEED NOT UPDATING', color: '#fbbf24' }
                : null));

    const responsiveLayouts = useMemo(() => {
        const layoutItems = [
            visualizerLayout,
            ...gauges.map(g => g.layout || { i: g.id, x: 0, y: 0, w: 4, h: 4 }),
            ...bottomStats.map(s => s.layout || { i: s.id, x: 0, y: 4, w: 3, h: 4 })
        ];

        return Object.fromEntries(
            GRID_BREAKPOINTS.map(breakpoint => [
                breakpoint,
                layoutItems.map(cloneGridItem)
            ])
        );
    }, [bottomStats, gauges, visualizerLayout]);

    const statusCellSx = {
        minWidth: 0,
        minHeight: { xs: 78, sm: 74 },
        p: { xs: 1, sm: 1.25 },
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 0.75,
        border: '1px solid #334155',
        borderRadius: 1,
        bgcolor: 'rgba(15, 23, 42, 0.25)'
    };

    const statusValueSx = {
        fontWeight: 'bold',
        mt: 0.5,
        lineHeight: 1.1,
        fontSize: { xs: '1rem', sm: '1.35rem', md: '1.5rem' },
        overflowWrap: 'anywhere'
    };

    const renderStatPanel = (panel, index) => (
        <Paper
            sx={{
                p: 2.5,
                height: '100%',
                bgcolor: 'rgba(15, 23, 42, 0.6)',
                backdropFilter: 'blur(12px)',
                border: editMode ? '1px dashed #475569' : '1px solid rgba(56, 189, 248, 0.2)',
                borderRadius: 3,
                boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                position: 'relative',
                overflow: 'hidden',
                transition: 'all 0.2s',
                ...(editMode && {
                    '&:hover': {
                        bgcolor: '#1e293b',
                        boxShadow: '0 0 0 2px #334155'
                    },
                    '&::before': {
                        content: '""',
                        position: 'absolute',
                        top: 0, left: 0, right: 0, height: '4px',
                        bgcolor: '#fbbf24',
                        opacity: 0.6
                    }
                })
            }}
        >
                <Typography
                    variant="subtitle2"
                    sx={{
                        color: '#38bdf8',
                        fontWeight: '800',
                        mb: 2.5,
                        letterSpacing: 1.5,
                        textAlign: 'center',
                        textShadow: '0 0 10px rgba(56, 189, 248, 0.3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 1
                    }}
                >
                    {panel.title}
                    {editMode && (
                        <IconButton
                            size="small"
                            onClick={() => setEditingBottomStat(panel)}
                            sx={{ color: '#fbbf24', p: 0.5 }}
                        >
                            <Edit2 size={14} />
                        </IconButton>
                    )}
                </Typography>

                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    {panel.params.map((s, sIdx) => {
                        const status = getStatusLabel(s.dataKey, rigData[s.dataKey]);
                        const isCatEnginePanel = panel.id === 'p5';
                        const hideLabel = isCatEnginePanel && s.dataKey === 'cat_rpm';
                        return (
                            <Box
                                key={s.id || sIdx}
                                sx={{
                                    p: isCatEnginePanel ? 1.5 : 2,
                                    bgcolor: 'rgba(30, 41, 59, 0.5)',
                                    borderRadius: 2,
                                    border: '1px solid rgba(148, 163, 184, 0.1)',
                                    display: 'flex',
                                    justifyContent: hideLabel ? 'center' : 'space-between',
                                    alignItems: 'center',
                                    gap: 1,
                                    minWidth: 0,
                                    boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.2)'
                                }}
                            >
                                {!hideLabel && (
                                    <Typography
                                        variant="body1"
                                        sx={{
                                            color: '#cbd5e1',
                                            fontWeight: '600',
                                            letterSpacing: isCatEnginePanel ? 0.2 : 0.5,
                                            fontSize: isCatEnginePanel ? '0.9rem' : undefined,
                                            whiteSpace: 'nowrap',
                                            flexShrink: 0
                                        }}
                                    >
                                        {s.label}
                                    </Typography>
                                )}
                                {status ? (
                                    <Typography sx={{ color: status.color, fontWeight: '800', fontSize: '1.1rem', textShadow: `0 0 8px ${status.color}40` }}>
                                        {status.label}
                                    </Typography>
                                ) : (
                                    <Typography
                                        sx={{
                                            color: '#38bdf8',
                                            fontWeight: '800',
                                            fontSize: isCatEnginePanel ? '1.1rem' : '1.25rem',
                                            textShadow: '0 0 10px rgba(56,189,248,0.3)',
                                            display: 'flex',
                                            alignItems: 'baseline',
                                            justifyContent: hideLabel ? 'center' : 'flex-end',
                                            gap: 0.5,
                                            minWidth: 0,
                                            whiteSpace: 'nowrap'
                                        }}
                                    >
                                        {['cat_rpm', 'htd_rpm', 'cat_load', 'htd_torque', 'ahtd_torque', 'spm', 'rop', 'SPP-Bar', 'pump_pressure', 'block_position'].includes(s.dataKey) ? Math.round(Number(rigData[s.dataKey] || 0)) : Number(rigData[s.dataKey] || 0).toFixed(2)}
                                        <span style={{ color: '#94a3b8', fontSize: '0.8rem', fontWeight: '600' }}>
                                            {s.unit}
                                        </span>
                                    </Typography>
                                )}
                            </Box>
                        );
                    })}
                </Box>
            </Paper>
    );

    const primaryGauges = [
        gauges.find(g => g.dataKey === 'hook_load') || DEFAULT_DASHBOARD_GAUGES[0],
        gauges.find(g => g.dataKey === 'htd_rpm') || DEFAULT_DASHBOARD_GAUGES[2],
        gauges.find(g => g.dataKey === 'SPP-Bar') || DEFAULT_DASHBOARD_GAUGES[1]
    ];

    const Sparkline = ({ values, color, height = 64 }) => {
        const safeValues = values.length > 1 ? values : [0, ...(values || [])];
        const min = Math.min(...safeValues);
        const max = Math.max(...safeValues);
        const isFlat = max === min;
        const range = Math.max(max - min, 1);
        const points = safeValues.map((value, index) => {
            const x = (index / Math.max(safeValues.length - 1, 1)) * 100;
            const y = isFlat ? 65 : 88 - ((value - min) / range) * 70;
            return `${x},${y}`;
        }).join(' ');
        const gradientId = `spark-${color.replace('#', '')}-${String(height).replace(/[^a-z0-9]/gi, '')}`;

        return (
            <Box sx={{ width: '100%', height, minHeight: 0 }}>
                <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
                    <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity="0.45" />
                            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
                        </linearGradient>
                    </defs>
                    <path d="M0 25H100 M0 50H100 M0 75H100" stroke="#1e3449" strokeWidth="0.5" strokeDasharray="2 3" />
                    <polygon points={`0,100 ${points} 100,100`} fill={`url(#${gradientId})`} />
                    <polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
                </svg>
            </Box>
        );
    };

    const TrendStrip = ({ label, value, unit, values, color, large = false, graphOnly = false }) => (
        <Box sx={{
            width: '100%',
            height: large ? 112 : 86,
            minHeight: 0,
            px: large ? 1.25 : 1,
            pt: large ? 1 : 0.65,
            pb: large ? 0.5 : 0.25,
            border: '1px solid #26384d',
            borderRadius: 1.25,
            bgcolor: '#07111d',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: `inset 0 0 24px ${color}0a`
        }}>
            {!graphOnly && (
                <>
                    <Typography sx={{ color, fontSize: large ? 13 : 10, lineHeight: 1, fontWeight: 900, letterSpacing: 0.5 }}>{label}</Typography>
                    <Box sx={{
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: large ? 'center' : 'flex-end',
                        gap: large ? 0.75 : 0.35,
                        mt: large ? 0.7 : -1.1
                    }}>
                        <Typography sx={{ color, fontSize: large ? 32 : 17, lineHeight: 1, fontWeight: 900, textShadow: `0 0 12px ${color}55` }}>
                            {value}
                        </Typography>
                        <Typography component="span" sx={{ color: '#e2e8f0', fontSize: large ? 14 : 9, fontWeight: 800 }}>{unit}</Typography>
                    </Box>
                </>
            )}
            <Box sx={{ flex: 1, minHeight: 0, mt: large ? 0.25 : 0 }}>
                <Sparkline values={values} color={color} height="100%" />
            </Box>
        </Box>
    );

    const renderGaugeCard = (g) => {
        const isSppGauge = g.dataKey === 'SPP-Bar';
        const trendConfig = g.dataKey === 'hook_load'
            ? { values: trendData.hook_load, color: g.color }
            : (g.dataKey === 'htd_rpm'
                ? { values: trendData.htd_rpm, color: g.color }
                : null);

        return (
        <Paper
            key={g.id}
            sx={{
                p: 1.25,
                minWidth: 0,
                height: { xs: 320, lg: '100%' },
                minHeight: { lg: 440 },
                bgcolor: 'rgba(3, 10, 20, 0.88)',
                border: '1px solid #26384d',
                borderRadius: 2,
                color: 'white',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                justifyContent: 'flex-start',
                position: 'relative',
                overflow: 'hidden',
                boxShadow: 'inset 0 0 35px rgba(2, 132, 199, 0.04)'
            }}
        >
            <Box sx={{ flex: isSppGauge ? { xs: '1 1 auto', lg: '0 0 326px' } : '1 1 auto', minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <AnalogGauge
                value={isSppGauge
                    ? (Number(rigData.pump_pressure) * 14.50377) || 0
                    : Number(rigData[g.dataKey]) || 0}
                max={Number(g.max)}
                min={Number(g.min)}
                label={g.dataKey === 'htd_rpm' ? 'HTD' : g.label}
                unit={g.unit}
                size="fill"
                minSize={(trendConfig || isSppGauge) ? 230 : 240}
                maxSize={(trendConfig || isSppGauge) ? 310 : 330}
                color={g.color}
                majorTicks={g.majorTicks || 5}
                minorTicks={g.minorTicks || 4}
                valueDecimals={g.dataKey === 'hook_load' ? 1 : 0}
                subValue={g.dataKey === 'hook_load'
                    ? formatWOB(rigData.wob)
                    : (g.dataKey === 'htd_rpm' ? Math.round(Number(rigData.ahtd_torque || 0)) : ((g.dataKey === 'SPP-Bar' || g.dataKey === 'pump_pressure') ? Math.round(Number(rigData.spm || 0)) : undefined))}
                subLabel={g.dataKey === 'hook_load'
                    ? `WOB (${units.wob === 'tonnes' ? 'ton' : units.wob})`
                    : (g.dataKey === 'htd_rpm' ? 'TORQUE (daN·m)' : ((g.dataKey === 'SPP-Bar' || g.dataKey === 'pump_pressure') ? 'SPM' : undefined))}
                subValueInside
                />
            </Box>
            {trendConfig && (
                <Box
                    sx={{
                        flex: { xs: '0 0 72px', lg: '0 0 96px' },
                        mt: 0.75,
                        p: 0.75,
                        border: '1px solid #26384d',
                        borderRadius: 1,
                        bgcolor: '#07111d',
                        overflow: 'hidden',
                        boxShadow: `inset 0 0 18px ${trendConfig.color}12`
                    }}
                >
                    <Sparkline values={trendConfig.values} color={trendConfig.color} height="100%" />
                </Box>
            )}
            {isSppGauge && (
                <Box sx={{
                    flex: { xs: '0 0 72px', lg: '0 0 96px' },
                    mt: 0.75,
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 0.5
                }}>
                    {[
                        ['TOTAL STROKES', Math.round(Number(rigData.total_strokes || 0)), ''],
                        ['ROP', Math.round(Number(rigData.rop || 0)), 'm/hr'],
                        ['FLOW IN', Number(rigData.flow_in || 0).toFixed(0), 'L/min'],
                        ['FLOW OUT', Math.round(Number(rigData.flow_out || 0)), '%']
                    ].map(([label, value, unit]) => (
                        <Box key={label} sx={{ border: '1px solid #26384d', borderRadius: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', bgcolor: '#07111d' }}>
                            <Typography sx={{ color: '#fbbf24', fontSize: 11, fontWeight: 800 }}>{label}</Typography>
                            <Typography sx={{ fontSize: 22, lineHeight: 1, fontWeight: 900, mt: 0.25 }}>
                                {value} {unit && <Box component="span" sx={{ color: '#94a3b8', fontSize: 12 }}>{unit}</Box>}
                            </Typography>
                        </Box>
                    ))}
                </Box>
            )}
        </Paper>
        );
    };

    const panelSx = {
        p: 1.25,
        bgcolor: 'rgba(3, 10, 20, 0.9)',
        border: '1px solid #26384d',
        borderRadius: 2,
        color: 'white',
        minWidth: 0
    };

    const statusRow = (label, value, color = '#38bdf8') => (
        <Box key={label} sx={{ px: 1.1, py: 0.85, border: '1px solid #26384d', borderRadius: 1, bgcolor: '#07111d', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Typography sx={{ color: '#e2e8f0', fontSize: 12, fontWeight: 700 }}>{label}</Typography>
            <Typography sx={{ color, fontSize: 12, fontWeight: 900, textAlign: 'right' }}>{value}</Typography>
        </Box>
    );

    const pumpStatus = (value) => {
        switch (Number(value)) {
            case 1: return { label: 'READY', color: '#38bdf8' };
            case 2: return { label: 'ENABLE', color: '#22c55e' };
            default: return { label: 'NOT READY', color: '#fbbf24' };
        }
    };

    const clampStatus = getStatusLabel('cwk_clamp_status', rigData.pct_clamp_up_status)
        || { label: 'UNKNOWN', color: '#94a3b8' };
    const pctMode = Number(rigData.pct_op_mode) === 1 ? 'NORMAL' : (Number(rigData.pct_op_mode) === 2 ? 'MANUAL' : 'UNKNOWN');
    const htdStatus = getStatusLabel('htd_status', rigData.htd_status) || { label: 'UNKNOWN', color: '#94a3b8' };
    const pctStatus = getStatusLabel('pct_status', rigData.pct_status) || { label: 'OFF', color: '#ef4444' };
    const engineStatus = getStatusLabel('engine_status', rigData.engine_status) || { label: 'UNKNOWN', color: '#94a3b8' };
    const bopQuality = rigData.bop?.quality || 'disconnected';
    const bopQualityLabel = bopQuality === 'good' ? 'GOOD' : (bopQuality === 'stale' ? 'STALE' : (bopQuality === 'bad_quality' ? 'BAD QUALITY' : 'DISCONNECTED'));
    const bopQualityColor = bopQuality === 'good' ? '#22c55e' : (bopQuality === 'stale' ? '#fbbf24' : '#ef4444');
    const bopNumber = (key, unit = '') => {
        const value = Number(rigData.bop?.[key]);
        return Number.isFinite(value) ? `${value.toFixed(2)}${unit ? ` ${unit}` : ''}` : '--';
    };
    const bopBool = (key) => rigData.bop?.[key] === null || rigData.bop?.[key] === undefined ? '--' : (Number(rigData.bop[key]) > 0 ? 'OPEN' : 'CLOSED');
    const pctClampStatus = (value) => getStatusLabel('cwk_clamp_status', value) || { label: 'NONE', color: '#94a3b8' };
    const dollyValue = Number(rigData.pct_dolly_status);
    const dollyLabels = ['NONE', 'OUT PARK', 'MOVE WORK', 'MOVE PARK', 'IN PARK', 'FAULT', 'IN WORK'];
    const dollyStatus = {
        label: dollyLabels[dollyValue] || 'UNKNOWN',
        color: dollyValue === 5 ? '#ef4444' : (dollyValue === 4 || dollyValue === 6 ? '#22c55e' : '#fbbf24')
    };
    const workMode = ['UNKNOWN', 'DRILL', 'SPIN', 'TORQUE'][Number(rigData.htd_work_mode)] || 'UNKNOWN';
    const rotationStatus = ['STAND STILL', 'FWD', 'BWD', 'NEUTRAL'][Number(rigData.htd_rotation_status)] || 'UNKNOWN';
    const gearValue = Number(rigData.htd_gear_status);
    const gearStatus = gearValue === -1
        ? 'FAULT'
        : (gearValue >= 1 && gearValue <= 4
            ? `GEAR ${gearValue}`
            : (gearValue >= 5 && gearValue <= 8 ? `GEAR ${gearValue - 4} REGEN` : 'UNKNOWN'));
    const ibopState = getStatusLabel('ibop_status', rigData.ibop_status) || { label: 'UNKNOWN', color: '#94a3b8' };
    const elevatorState = getStatusLabel('elevator_status', rigData.elevator_status) || { label: 'UNKNOWN', color: '#94a3b8' };

    const stateTile = (label, value, color = '#38bdf8', unit = '') => (
        <Box key={label} sx={{ p: 0.8, minWidth: 0, minHeight: 60, border: '1px solid #26384d', borderRadius: 1.25, bgcolor: '#07111d', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <Typography noWrap sx={{ color: '#ffffff', fontSize: 10, fontWeight: 800, letterSpacing: 0.45 }}>{label}</Typography>
            <Typography noWrap sx={{ color: '#4ade80', mt: 0.25, fontSize: 14, lineHeight: 1.05, fontWeight: 900 }}>
                {value} {unit && <Box component="span" sx={{ color: '#94a3b8', fontSize: 10 }}>{unit}</Box>}
            </Typography>
        </Box>
    );

    const equipmentPanel = (name, status, tiles, accent) => (
        <Paper sx={{ ...panelSx, p: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.75 }}>
                <Typography sx={{ color: accent, fontWeight: 900, fontSize: 14 }}>{name}</Typography>
                <Typography sx={{ color: status.color, border: `1px solid ${status.color}`, borderRadius: 1, px: 0.75, py: 0.15, fontSize: 10, fontWeight: 900 }}>
                    {status.label}
                </Typography>
            </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 0.6 }}>
                {tiles}
            </Box>
        </Paper>
    );

    const renderPumpRow = (label, statusKey, flowKey, pressKey, fill = false, flowSpKey = null, pressSpKey = null) => {
        const pump = pumpStatus(rigData[statusKey]);
        const pumpValueSx = {
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: 0.25,
            whiteSpace: 'nowrap'
        };
        const pumpLabelSx = {
            overflow: 'hidden',
            whiteSpace: 'nowrap'
        };
        return (
            <Box key={label} sx={{ p: fill ? 1.05 : 0.85, minHeight: 0, border: '1px solid #26384d', borderRadius: 1, bgcolor: '#07111d', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                    <Typography sx={{ color: '#94a3b8', fontSize: fill ? 14 : 12, fontWeight: 900 }}>{label}</Typography>
                    <Typography sx={{ color: pump.color, fontSize: fill ? 13 : 11, fontWeight: 900 }}>{pump.label}</Typography>
                </Box>
                <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1.25fr)', mt: fill ? 0.55 : 0.25, columnGap: 0.65, rowGap: 0.2 }}>
                    <Typography sx={{ ...pumpLabelSx, fontSize: fill ? 11 : 10, fontWeight: 800, color: '#ffffff' }}>FLOW SP: <Box component="span" sx={{ ...pumpValueSx, color: '#38bdf8', fontSize: fill ? 12 : 11 }}>{Number(rigData[flowSpKey] || 0).toFixed(2)} %</Box></Typography>
                    <Typography sx={{ ...pumpLabelSx, fontSize: fill ? 11 : 10, fontWeight: 800, color: '#ffffff' }}>PRESS SP: <Box component="span" sx={{ ...pumpValueSx, color: '#38bdf8', fontSize: fill ? 12 : 11 }}>{Number(rigData[pressSpKey] || 0).toFixed(2)} bar</Box></Typography>
                    <Typography sx={{ ...pumpLabelSx, fontSize: fill ? 12 : 11, fontWeight: fill ? 700 : 400, color: '#ffffff' }}>FLOW: <Box component="span" sx={{ ...pumpValueSx, color: '#4ade80', fontSize: fill ? 13 : 12 }}>{Number(rigData[flowKey] || 0).toFixed(2)} %</Box></Typography>
                    <Typography sx={{ ...pumpLabelSx, fontSize: fill ? 12 : 11, fontWeight: fill ? 700 : 400, color: '#ffffff' }}>PRESS: <Box component="span" sx={{ ...pumpValueSx, color: '#4ade80', fontSize: fill ? 13 : 12 }}>{Number(rigData[pressKey] || 0).toFixed(2)} bar</Box></Typography>
                </Box>
            </Box>
        );
    };

    const consoleLayout = (
        <>
            <Box sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: '250px repeat(2, minmax(0, 1fr))', lg: '250px repeat(3, minmax(0, 1fr))' },
                gap: 1.5,
                mb: 1.5
            }}>
                <Box sx={{ minWidth: 0, height: { xs: 440, lg: 440 } }}>
                    <RigVisualizer
                        blockPosition={rigData.block_position}
                        slipsIn={rigData.slips_in}
                        slipInRaw={rigData.slip_in_raw}
                        slipOutRaw={rigData.slip_out_raw}
                        height="100%"
                    />
                </Box>
                {primaryGauges.map(renderGaugeCard)}
            </Box>

            <Box sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: '1fr 2fr', lg: '1.05fr 2.3fr 3fr' },
                gap: 1.5,
                mb: 1.5,
                '& > *': { minHeight: 310 }
            }}>
                <Paper sx={{ ...panelSx, display: 'flex', flexDirection: 'column' }}>
                    <Box sx={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Typography sx={{ fontWeight: 900, fontSize: 14 }}>CAT ENGINE</Typography>
                        <Typography sx={{ color: engineStatus.color, border: `1px solid ${engineStatus.color}`, borderRadius: 1, px: 0.75, py: 0.2, fontSize: 11, fontWeight: 900 }}>
                            {engineStatus.label}
                        </Typography>
                    </Box>
                    <Box sx={{ my: 0.8, color: '#0ea5e9', display: 'flex', justifyContent: 'center' }}>
                        <svg width="52" height="36" viewBox="0 0 82 58" fill="none">
                            <path d="M12 22h10l6-8h24l7 8h11v25H12V22Zm16-8V8h22v6M7 29H1m75 0h5M25 47v7m32-7v7" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
                        </svg>
                    </Box>
                    <Box sx={{ display: 'grid', gridTemplateRows: '1fr 1fr', gap: 1, flex: 1, minHeight: 0 }}>
                        <TrendStrip
                            label=""
                            value={Math.round(Number(rigData.cat_rpm || 0))}
                            unit="RPM"
                            values={trendData.cat_rpm}
                            color="#0ea5e9"
                            large
                        />
                        <TrendStrip
                            label="LOAD"
                            value={Math.round(Number(rigData.cat_load || 0))}
                            unit="%"
                            values={trendData.cat_load}
                            color="#22c55e"
                            large
                        />
                    </Box>
                </Paper>

                <Box sx={{ display: 'grid', gridTemplateRows: '1fr 1fr', gap: 1.5, minWidth: 0 }}>
                    {equipmentPanel('PCT', pctStatus, [
                        stateTile('SEQUENCE', getStatusLabel('pct_sequence', rigData.pct_sequence)?.label || 'OFF', getStatusLabel('pct_sequence', rigData.pct_sequence)?.color),
                        stateTile('MAKE-UP TORQUE', Number(rigData.pct_torque || 0).toFixed(2), '#4ade80', 'daN*m'),
                        stateTile('SPINNER MU TORQUE', Number(rigData.spinner_makeup_torque || 0).toFixed(2), '#4ade80', 'daN*m'),
                        stateTile('DOLLY STATUS', dollyStatus.label, dollyStatus.color),
                        stateTile('LOW CLAMP STATUS', pctClampStatus(rigData.pct_clamp_low_status).label, pctClampStatus(rigData.pct_clamp_low_status).color),
                        stateTile('UPPER CLAMP STATUS', pctClampStatus(rigData.pct_clamp_up_status).label, pctClampStatus(rigData.pct_clamp_up_status).color)
                    ], '#a855f7')}

                    {equipmentPanel('HTD', htdStatus, [
                        stateTile('WORK MODE', workMode, workMode === 'UNKNOWN' ? '#94a3b8' : '#22c55e'),
                        stateTile('ROTATION', rotationStatus, rotationStatus === 'UNKNOWN' ? '#94a3b8' : '#38bdf8'),
                        stateTile('BRAKE', getStatusLabel('brake_status', rigData.brake_status)?.label || 'UNKNOWN', getStatusLabel('brake_status', rigData.brake_status)?.color),
                        stateTile('IBOP / ELEVATOR', `${ibopState.label} / ${elevatorState.label}`, ibopState.color),
                        stateTile('GEAR SELECTION', gearStatus, gearStatus === 'FAULT' ? '#ef4444' : (gearStatus === 'UNKNOWN' ? '#94a3b8' : '#22c55e')),
                        stateTile('V-SPEED', Number(rigData.vertical_speed || 0).toFixed(2), '#4ade80', 'mm/sec')
                    ], '#22c55e')}
                </Box>

                <Paper sx={{ ...panelSx, display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.25, flexShrink: 0 }}>
                        <Typography sx={{ color: '#38bdf8', fontWeight: 900, fontSize: 16 }}>HPU (HYDRAULIC POWER UNIT)</Typography>
                        <Typography component="span" sx={{ color: getStatusLabel('hpu_status', rigData.hpu_status)?.color, border: '1px solid currentColor', borderRadius: 1, px: 1, py: 0.3, fontSize: 12, fontWeight: 900 }}>{getStatusLabel('hpu_status', rigData.hpu_status)?.label}</Typography>
                    </Box>
                    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1.35fr 1fr' }, gap: 1.25, flex: 1, minHeight: 0 }}>
                        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                            <Typography sx={{ color: '#94a3b8', border: '1px solid #26384d', borderRadius: 1, px: 1.25, py: 0.65, fontWeight: 900, fontSize: 14, flexShrink: 0 }}>HYDRAULIC PUMPS</Typography>
                            <Box sx={{ display: 'grid', gridTemplateRows: 'repeat(3, minmax(0, 1fr))', gap: 0.85, mt: 0.85, flex: 1, minHeight: 0 }}>
                                {renderPumpRow('PUMP-3 PDW', 'hpu_pdw_status', 'hpu_pdw_flow', 'hpu_pdw_press', true, 'hpu_pdw_flow_sp', 'hpu_pdw_press_sp')}
                                {renderPumpRow('HTD PUMP-2', 'hpu_htd1_status', 'hpu_htd1_flow', 'hpu_htd1_press', true, 'hpu_htd1_flow_sp', 'hpu_htd1_press_sp')}
                                {renderPumpRow('HTD PUMP-4', 'hpu_htd2_status', 'hpu_htd2_flow', 'hpu_htd2_press', true, 'hpu_htd2_flow_sp', 'hpu_htd2_press_sp')}
                            </Box>
                        </Box>
                        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                            <Typography sx={{ color: '#94a3b8', border: '1px solid #26384d', borderRadius: 1, px: 1.25, py: 0.65, fontWeight: 900, fontSize: 14, flexShrink: 0 }}>OTHER PARAMETERS</Typography>
                            <Box sx={{ display: 'grid', gridTemplateRows: 'repeat(4, minmax(0, 1fr))', gap: 0.85, mt: 0.85, flex: 1, minHeight: 0 }}>
                                {[
                                    ['DIS PRESS', `${Number(rigData.hpu_discharge_pressure || 0).toFixed(2)} bar`, '#4ade80'],
                                    ['AUX PRESS', `${Number(rigData.hpu_aux_pressure || 0).toFixed(2)} bar`, '#4ade80'],
                                    ['OIL TEMP', `${Number(rigData.hpu_oil_temp || 0).toFixed(2)} °C`, '#4ade80'],
                                    ['OIL LEVEL', `${Number(rigData.hpu_oil_level || 0).toFixed(2)} %`, '#4ade80']
                                ].map(([label, value, color]) => (
                                    <Box key={label} sx={{ px: 1.25, py: 0.8, minHeight: 0, border: '1px solid #26384d', borderRadius: 1, bgcolor: '#07111d', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                                        <Typography sx={{ color: '#e2e8f0', fontSize: 13, fontWeight: 800 }}>{label}</Typography>
                                        <Typography sx={{ color, fontSize: 17, fontWeight: 900, textAlign: 'right', whiteSpace: 'nowrap' }}>{value}</Typography>
                                    </Box>
                                ))}
                            </Box>
                        </Box>
                    </Box>
                </Paper>

                <Paper sx={{ ...panelSx, display: 'flex', flexDirection: 'column', height: '100%' }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.25 }}>
                        <Typography sx={{ color: '#fbbf24', fontWeight: 900, fontSize: 16 }}>WELL CONTROL / BOP</Typography>
                        <Typography component="span" sx={{ color: bopQualityColor, border: `1px solid ${bopQualityColor}`, borderRadius: 1, px: 1, py: 0.3, fontSize: 11, fontWeight: 900 }}>{bopQualityLabel}</Typography>
                    </Box>
                    <Typography sx={{ color: '#64748b', fontSize: 11, mb: 1 }}>SOURCE: {String(rigData.bop?.source || 'VERSAMAX').toUpperCase()}</Typography>
                    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.85, flex: 1 }}>
                        {[
                            ['ANNULAR', bopBool('annular_close')],
                            ['UPPER RAM', bopBool('upper_ram_close')],
                            ['LOWER RAM', bopBool('lower_ram_close')],
                            ['ACCUMULATOR', bopNumber('accumulator_pressure', 'PSI')],
                            ['MANIFOLD', bopNumber('manifold_pressure', 'PSI')],
                            ['ANNULAR PRESS', bopNumber('annular_pressure', 'PSI')]
                        ].map(([label, display]) => (
                            <Box key={label} sx={{ px: 1, py: 0.8, border: '1px solid #26384d', borderRadius: 1, bgcolor: '#07111d', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                                <Typography sx={{ color: '#94a3b8', fontSize: 10, fontWeight: 800 }}>{label}</Typography>
                                <Typography sx={{ color: bopQuality === 'good' ? '#4ade80' : '#64748b', fontSize: 15, fontWeight: 900 }}>{display}</Typography>
                            </Box>
                        ))}
                    </Box>
                </Paper>
            </Box>

            <Paper sx={{
                p: 1.25,
                bgcolor: 'rgba(3, 10, 20, 0.92)',
                border: '1px solid #26384d',
                borderRadius: 2,
                display: 'grid',
                gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(6, 1fr)' },
                gap: 1
            }}>
                {[
                    [ShieldCheck, 'SYSTEM HEALTH', feedAlert ? 'CHECK' : 'GOOD', feedAlert ? '#fbbf24' : '#22c55e'],
                    [Droplets, 'FLOW IN', `${Number(rigData.flow_in || 0).toFixed(2)} Lt/min`, '#38bdf8'],
                    [Activity, 'BLOCK POSITION', `${Math.round(Number(rigData.block_position || 0))} mm`, '#38bdf8'],
                    [Zap, 'POWER STATUS', Number(rigData.engine_status) === 5 ? 'FAULT' : 'NORMAL', Number(rigData.engine_status) === 5 ? '#ef4444' : '#22c55e'],
                    [Clock3, 'DATE & TIME', new Date().toLocaleString(), '#cbd5e1'],
                    [Bell, 'ALERTS', feedAlert ? '1 ACTIVE' : '0 ACTIVE', feedAlert ? '#fbbf24' : '#22c55e']
                ].map(([Icon, label, value, color]) => (
                    <Box key={label} sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1, minWidth: 0 }}>
                        <Icon size={24} color={color} />
                        <Box sx={{ minWidth: 0 }}>
                            <Typography sx={{ color: '#94a3b8', fontSize: 10, letterSpacing: 0.7 }}>{label}</Typography>
                            <Typography noWrap sx={{ color, fontSize: 14, fontWeight: 900 }}>{value}</Typography>
                        </Box>
                    </Box>
                ))}
            </Paper>
        </>
    );

    return (
        <Box sx={{ position: 'relative', maxWidth: '100%', overflowX: 'hidden' }}>
            {consoleLayout}

            {false && (
            <>
            {/* Absolute positioned controls to reclaim vertical space */}
            {canEditLayout && (
            <Box sx={{ position: { xs: 'static', sm: 'absolute' }, top: -16, right: 0, zIndex: 10, display: 'flex', justifyContent: 'flex-end', gap: 1, mb: { xs: 1, sm: 0 } }}>
                {editMode && gauges.length < 5 && (
                    <Button
                        variant="contained"
                        startIcon={<Plus size={18} />}
                        onClick={handleAddGauge}
                        sx={{ bgcolor: '#3b82f6', '&:hover': { bgcolor: '#2563eb' } }}
                    >
                        Add Gauge
                    </Button>
                )}
                <Box sx={{ display: 'flex', bgcolor: '#1e293b', borderRadius: 1 }}>
                    <IconButton
                        size="small"
                        onClick={() => {
                            if (editMode) {
                                saveLayout(gauges, bottomStats, visualizerLayout);
                            }
                            setEditMode(!editMode);
                        }}
                        sx={{ color: editMode ? '#fbbf24' : '#94a3b8' }}
                        title={editMode ? "Save Layout" : "Edit Layout"}
                    >
                        {editMode ? <Check size={18} /> : <Edit2 size={18} />}
                    </IconButton>
                    {editMode && (
                        <IconButton size="small" onClick={handleReset} sx={{ color: '#ef4444' }} title="Reset Defaults">
                            <X size={18} />
                        </IconButton>
                    )}
                </Box>
            </Box>
            )}

            <Box sx={{ flexGrow: 1, position: 'relative' }}>
                {layoutLoaded && (
                <ResponsiveGridLayout
                    className="layout"
                    layouts={responsiveLayouts}
                    breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
                    cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
                    rowHeight={50}
                    margin={[16, 16]}
                    isDraggable={editMode}
                    isResizable={editMode}
                    compactType="vertical"
                    useCSSTransforms={true}
                    onLayoutChange={(currentLayout) => {
                        if (!editMode) return;
                        
                        const visL = currentLayout.find(item => item.i === 'rig-visualizer');
                        if (visL) setVisualizerLayout({ i: 'rig-visualizer', x: visL.x, y: visL.y, w: visL.w, h: visL.h, minW: 2, minH: 4 });

                        const newGauges = gauges.map(g => {
                            const l = currentLayout.find(item => item.i === g.id);
                            return l ? { ...g, layout: { i: g.id, x: l.x, y: l.y, w: l.w, h: l.h, minW: 3, minH: 3 } } : g;
                        });

                        const newStats = bottomStats.map(s => {
                            const l = currentLayout.find(item => item.i === s.id);
                            return l ? { ...s, layout: { i: s.id, x: l.x, y: l.y, w: l.w, h: l.h, minW: 2, minH: 3 } } : s;
                        });

                        setGauges(newGauges);
                        setBottomStats(newStats);
                    }}
                >
                    <div key="rig-visualizer" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ flexGrow: 1, position: 'relative', width: '100%', height: '100%' }}>
                            <RigVisualizer
                                blockPosition={rigData.block_position}
                                slipsIn={rigData.slips_in}
                                slipInRaw={rigData.slip_in_raw}
                                slipOutRaw={rigData.slip_out_raw}
                            />
                        </div>
                    </div>
                    {gauges.map((g) => (
                        <div key={g.id} style={{ height: '100%' }}>
                            <Paper
                                sx={{
                                    p: 2.5,
                                    bgcolor: 'rgba(15, 23, 42, 0.6)',
                                    backdropFilter: 'blur(12px)',
                                    border: editMode ? '1px dashed #475569' : '1px solid rgba(56, 189, 248, 0.2)',
                                    borderRadius: 3,
                                    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                                    color: 'white',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    position: 'relative',
                                    height: '100%',
                                    width: '100%',
                                    transition: 'all 0.2s',
                                    '&:hover': {
                                        bgcolor: editMode ? '#1e293b' : 'rgba(15, 23, 42, 0.8)',
                                        boxShadow: editMode ? '0 0 0 2px #334155' : '0 8px 32px rgba(0,0,0,0.4)'
                                    }
                                }}
                            >
                                <AnalogGauge
                                    value={(g.unit === 'psi' && g.dataKey === 'SPP-Bar') ? (Number(rigData[g.dataKey]) * 14.50377) || 0 : Number(rigData[g.dataKey]) || 0}
                                    max={Number(g.max)}
                                    min={Number(g.min)}
                                    label={g.dataKey === 'htd_rpm' ? 'HTD' : g.label}
                                    unit={g.unit}
                                    size="fill"
                                    minSize={150}
                                    maxSize={800}
                                    color={g.color}
                                    majorTicks={g.majorTicks || 5}
                                    minorTicks={g.minorTicks || 4}
                                    valueDecimals={g.dataKey === 'hook_load' ? 1 : 0}
                                    subValue={g.dataKey === 'hook_load' ? formatWOB(rigData.wob) : (g.dataKey === 'htd_rpm' ? Math.round(Number(rigData.ahtd_torque || 0)) : (g.dataKey === 'pct_torque' ? Number(rigData.pct_last_torque || 0).toFixed(2) : ((g.dataKey === 'SPP-Bar' || g.dataKey === 'pump_pressure') ? Math.round(Number(rigData.spm || 0)) : undefined)))}
                                    subLabel={g.dataKey === 'hook_load' ? `WOB (${units.wob === 'tonnes' ? 'ton' : units.wob})` : (g.dataKey === 'htd_rpm' ? 'TORQUE (daN·m)' : (g.dataKey === 'pct_torque' ? 'LAST TORQUE (daN·m)' : ((g.dataKey === 'SPP-Bar' || g.dataKey === 'pump_pressure') ? 'SPM' : undefined)))}
                                    subValueInside
                                />

                                {editMode && (
                                    <Box sx={{
                                        position: 'absolute', top: 0, right: 0, p: 1,
                                        display: 'flex', gap: 1, zIndex: 10
                                    }}>
                                        <IconButton
                                            size="small"
                                            onClick={(e) => { e.stopPropagation(); setEditingGauge({ ...g }); setIsDialogOpen(true); }}
                                            sx={{ bgcolor: '#fbbf24', color: 'black', '&:hover': { bgcolor: '#f59e0b' } }}
                                            title="Edit Settings"
                                        >
                                            <Settings size={14} />
                                        </IconButton>
                                        <IconButton
                                            size="small"
                                            onClick={(e) => { e.stopPropagation(); handleRemoveGauge(g.id); }}
                                            sx={{ color: 'white', bgcolor: '#ef4444', '&:hover': { bgcolor: '#dc2626' } }}
                                            title="Remove"
                                        >
                                            <Trash2 size={14} />
                                        </IconButton>
                                    </Box>
                                )}

                                {editMode && (
                                    <Box sx={{ position: 'absolute', bottom: 5, left: '50%', transform: 'translateX(-50%)', color: '#64748b', pointerEvents: 'none' }}>
                                        <Typography variant="caption" sx={{ fontSize: 10 }}>DRAG TO MOVE</Typography>
                                    </Box>
                                )}
                            </Paper>
                        </div>
                    ))}
                    {bottomStats.map((panel, idx) => (
                        <div key={panel.id} style={{ height: '100%' }}>
                            {renderStatPanel(panel, idx)}
                        </div>
                    ))}
                </ResponsiveGridLayout>
                )}
            </Box>
            </>
            )}

            {/* Edit Dialog - Gauge Configuration */}
            <Dialog
                open={isDialogOpen}
                onClose={() => setIsDialogOpen(false)}
                PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 400 } }}
            >
                <DialogTitle>Edit Gauge</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                        <TextField
                            label="Data Source" select
                            value={editingGauge?.dataKey || ''}
                            onChange={(e) => setEditingGauge({ ...editingGauge, dataKey: e.target.value })}
                            fullWidth size="small"
                            sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' }, '& .MuiSelect-select': { color: 'white' } }}
                        >
                            <MenuItem value="hook_load">Hook Load (WOH)</MenuItem>
                            <MenuItem value="wob">Weight on Bit (WOB)</MenuItem>
                            <MenuItem value="htd_rpm">HTD RPM</MenuItem>
                            <MenuItem value="SPP-Bar">SPP (Standpipe Pressure)</MenuItem>
                            <MenuItem value="pct_torque">PCT Torque</MenuItem>
                        </TextField>

                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField
                                label="Label"
                                value={editingGauge?.label || ''}
                                onChange={(e) => setEditingGauge({ ...editingGauge, label: e.target.value })}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                            <TextField
                                label="Unit"
                                value={editingGauge?.unit || ''}
                                onChange={(e) => setEditingGauge({ ...editingGauge, unit: e.target.value })}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                        </Box>

                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField
                                label="Min" type="number"
                                value={editingGauge?.min}
                                onChange={(e) => setEditingGauge({ ...editingGauge, min: e.target.value })}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                            <TextField
                                label="Max" type="number"
                                value={editingGauge?.max}
                                onChange={(e) => setEditingGauge({ ...editingGauge, max: e.target.value })}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                        </Box>

                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <FormControl fullWidth size="small">
                                <InputLabel sx={{ color: '#94a3b8' }}>Grid Width</InputLabel>
                                <Select
                                    value={editingGauge?.gridWidth || 3}
                                    label="Grid Width"
                                    onChange={(e) => setEditingGauge({ ...editingGauge, gridWidth: Number(e.target.value) })}
                                    sx={{ color: 'white', '.MuiOutlinedInput-notchedOutline': { borderColor: '#94a3b8' } }}
                                >
                                    <MenuItem value={3}>Small (1/4)</MenuItem>
                                    <MenuItem value={4}>Medium (1/3)</MenuItem>
                                    <MenuItem value={6}>Half (1/2)</MenuItem>
                                    <MenuItem value={8}>Large (2/3)</MenuItem>
                                    <MenuItem value={12}>Full Width</MenuItem>
                                </Select>
                            </FormControl>
                            <FormControl fullWidth size="small">
                                <InputLabel sx={{ color: '#94a3b8' }}>Gauge Size</InputLabel>
                                <Select
                                    value={editingGauge?.size || 160}
                                    label="Gauge Size"
                                    onChange={(e) => setEditingGauge({ ...editingGauge, size: Number(e.target.value) })}
                                    sx={{ color: 'white', '.MuiOutlinedInput-notchedOutline': { borderColor: '#94a3b8' } }}
                                >
                                    <MenuItem value={140}>Tiny (140px)</MenuItem>
                                    <MenuItem value={160}>Small (160px)</MenuItem>
                                    <MenuItem value={220}>Medium (220px)</MenuItem>
                                    <MenuItem value={300}>Large (300px)</MenuItem>
                                    <MenuItem value={380}>Huge (380px)</MenuItem>
                                </Select>
                            </FormControl>
                        </Box>
                    </Box>
                </DialogContent>
            </Dialog>

            {/* Bottom Stat Edit Dialog */}
            <Dialog
                open={Boolean(editingBottomStat)}
                onClose={() => setEditingBottomStat(null)}
                PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 500 } }}
            >
                <DialogTitle sx={{ borderBottom: '1px solid #334155', mb: 2 }}>Edit Bottom Stat Panel</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 1 }}>
                        <TextField
                            label="Panel Title"
                            value={editingBottomStat?.title || ''}
                            onChange={(e) => setEditingBottomStat({ ...editingBottomStat, title: e.target.value })}
                            fullWidth size="small"
                            sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#fbbf24' } }}
                        />

                        {editingBottomStat?.params.map((p, idx) => (
                            <Box key={idx} sx={{ p: 2, border: '1px solid #334155', borderRadius: 2, position: 'relative' }}>
                                <Typography variant="caption" sx={{ position: 'absolute', top: -10, left: 10, bgcolor: '#1e293b', px: 1, color: '#94a3b8' }}>
                                    Slot {idx + 1}
                                </Typography>
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                    <TextField
                                        label="Data Source" select
                                        value={p.dataKey || ''}
                                        onChange={(e) => {
                                            const newParams = [...editingBottomStat.params];
                                            newParams[idx] = { ...p, dataKey: e.target.value };
                                            setEditingBottomStat({ ...editingBottomStat, params: newParams });
                                        }}
                                        fullWidth size="small"
                                        sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' }, '& .MuiSelect-select': { color: 'white' } }}
                                    >
                                        <MenuItem value="flow_in">Flow In</MenuItem>
                                        <MenuItem value="flow_out">Flow Out</MenuItem>
                                        <MenuItem value="rop">ROP</MenuItem>
                                        <MenuItem value="bit_depth">Bit Depth</MenuItem>
                                        <MenuItem value="hole_depth">Total Depth</MenuItem>
                                        <MenuItem value="trip_tank">Trip Tank</MenuItem>
                                        <MenuItem value="total_active_volume">Total Volume</MenuItem>
                                        <MenuItem value="pump_pressure">SPP</MenuItem>
                                        <MenuItem value="torque">Torque</MenuItem>
                                        <MenuItem value="htd_rpm">HTD RPM</MenuItem>
                                        <MenuItem value="SPP-Bar">SPP (Standpipe Pressure)</MenuItem>
                                        <MenuItem value="pct_torque">PCT Torque</MenuItem>
                                        <MenuItem value="hook_load">Hook Load</MenuItem>
                                        <MenuItem value="wob">WOB</MenuItem>
                                    </TextField>
                                    <Box sx={{ display: 'flex', gap: 2 }}>
                                        <TextField
                                            label="Label"
                                            value={p.label || ''}
                                            onChange={(e) => {
                                                const newParams = [...editingBottomStat.params];
                                                newParams[idx] = { ...p, label: e.target.value };
                                                setEditingBottomStat({ ...editingBottomStat, params: newParams });
                                            }}
                                            fullWidth size="small"
                                            sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                                        />
                                        <TextField
                                            label="Unit"
                                            value={p.unit || ''}
                                            onChange={(e) => {
                                                const newParams = [...editingBottomStat.params];
                                                newParams[idx] = { ...p, unit: e.target.value };
                                                setEditingBottomStat({ ...editingBottomStat, params: newParams });
                                            }}
                                            fullWidth size="small"
                                            sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                                        />
                                    </Box>
                                </Box>
                            </Box>
                        ))}
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setEditingBottomStat(null)} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button onClick={handleBottomStatEditSave} variant="contained" sx={{ bgcolor: '#fbbf24', color: 'black' }}>Save</Button>
                </DialogActions>
            </Dialog>

        </Box>
    );
}
