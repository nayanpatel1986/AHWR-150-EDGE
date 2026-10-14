import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Checkbox, FormControl, ListItemText, ListSubheader, MenuItem, Select, useTheme } from '@mui/material';
import { SlidersHorizontal } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getLatestAlarms, getLatestRigData, isLiveRigPayload, socket } from '../../socket';
import axios from '../../api';
import { useAlarms, ALARM_BLINK } from '../../context/AlarmContext';
import { priorityColor } from '../../utils/alarms';

// ===========================================================================
// RigConsoleOverview -- WORKOVER / well-service rig console.
//
// This rig is a workover (well-service) unit, NOT a drilling rig: a telescoping
// guyed mast, a hydraulic top drive (HTD), a power casing tong (PCT), a catwalk
// (CWK), an anti-collision/travel-limit system (ACS), an HPU and a CAT genset.
// The layout is: annunciator ticker - string & activity column - workover mast
// schematic flanked by equipment summary cards - well-control bar - primary
// instruments - working-day (06:00->06:00 IST) trend ribbons.
//
// Data:
//   live      -> socket 'rig_data' (+ /api/rig/latest), incl. server-computed
//                `_activity`, `_kpi`, `_efficiency`
//   alarms    -> socket 'alarms' (+ /api/alarms), per-parameter blink/latch
//   history   -> /api/history seeds the working-day trends from 06:00 IST
//   rig/well  -> /api/dashboard/layout (wellInfo) + /api/wells/active
//
// Honesty rules (repo README):
//   * Safety-critical signals are never fabricated -- `sv()` renders "--" when
//     the feed is stale/dead, and well-control values are additionally gated on
//     `well_control.available`.
//   * Nothing without a real tag is invented. Formation layers, choke/kill
//     manifolds and a synthesized kill pressure were REMOVED for this reason.
//   * ACS savers are shown as raw clearances (mm) and are NOT threshold-
//     coloured, because no acs.* alarm rule exists in the backend config.
// ===========================================================================

const DARK = { bg: '#0f1726', bg2: '#172236', bg3: '#1e2b42', line: '#33445f', line2: '#4a5b75', txt: '#f4f8ff', txt2: '#b8c6dc', txt3: '#8797b0' };
const LIGHT = { bg: '#eef1f6', bg2: '#ffffff', bg3: '#f4f7fb', line: '#dce2ec', line2: '#c6cedb', txt: '#0d1320', txt2: '#4b566a', txt3: '#8a96aa' };
const ACCENT = { a1: '#ff9d2e', a2: '#27cfe6', b1: '#a9ef34', b2: '#9a8bff', ok: '#23dd86', warn: '#ffc24b', crit: '#ff4a60', info: '#46a6ff' };

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif";
const VALUE_FONT = "'Segoe UI', Arial, sans-serif";
const BAR_TO_PSI = 14.5037738;

// drawworks.block_position is already in millimetres from the PLC/backend.
// CONFIGURED mast display travel -- drawing scale only.
// 0 mm starts at the lower pink/string area, 500 mm sits near the floor zone,
// and 15000 mm reaches the crown envelope.
const MAST_BLOCK_MIN_MM = 0;
const MAST_BLOCK_FLOOR_MM = 500;
const MAST_BLOCK_MAX_MM = 15000;
const MAST_BLOCK_ZERO_Y = 107;
const MAST_BLOCK_FLOOR_Y = 101;
const MAST_BLOCK_CROWN_Y = 13;

// Workover activity codes (backend/lib/workover.js).
const ACT_COLOR = {
    RIH: ACCENT.a2, POOH: ACCENT.a1, MAKE_UP: ACCENT.b1, BREAK_OUT: ACCENT.warn,
    CIRCULATE: ACCENT.info, SWAB: ACCENT.b2, FISHING: ACCENT.b2,
    RIG_UP: ACCENT.ok, RIG_DOWN: ACCENT.ok, IDLE: '#7c8aa0', WAIT: ACCENT.crit,
};

// ---- math helpers ---------------------------------------------------------
const polar = (cx, cy, r, deg) => { const a = (deg - 90) * Math.PI / 180; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; };
const arc = (cx, cy, r, a0, a1) => {
    const s = polar(cx, cy, r, a1), e = polar(cx, cy, r, a0);
    const large = (a1 - a0) <= 180 ? 0 : 1;
    return ['M', s.x.toFixed(2), s.y.toFixed(2), 'A', r, r, 0, large, 0, e.x.toFixed(2), e.y.toFixed(2)].join(' ');
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const fmt = (v, d = 0) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '--';
    if (Object.is(n, -0) || Math.abs(n) < 0.5 * Math.pow(10, -Math.max(0, d))) return '0';
    return n.toFixed(d);
};
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const hhmmss = (iso) => { const d = iso ? new Date(iso) : null; return (!d || isNaN(d.getTime())) ? '--:--:--' : d.toLocaleTimeString('en-GB', { hour12: false }); };

// Sparkline over a FIXED time domain [t0,t1] (the working day), so the trace
// fills in left-to-right across the tour instead of rescaling to "since load".
const sparkDay = (pts, w, h, t0, t1) => {
    if (!Array.isArray(pts) || pts.length < 2) return { line: '', area: '' };
    const vs = pts.map((p) => p.v);
    const min = Math.min(...vs), max = Math.max(...vs), rng = (max - min) || 1;
    const span = (t1 - t0) || 1;
    const xy = pts.map((p) => [
        clamp01((p.t - t0) / span) * w,
        h - ((p.v - min) / rng) * (h - 3) - 1.5,
    ]);
    const line = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const lastX = xy[xy.length - 1][0];
    return { line, area: `${line} L ${lastX.toFixed(1)} ${h} L ${xy[0][0].toFixed(1)} ${h} Z` };
};

// ---- status decoders (mirror the equipment dashboards exactly) ------------
const UNK = { text: '---', color: '#64748b' };
const dec = (map) => (v) => map[Number(v)] || UNK;
const S = {
    // 0 OFF / 1 ON IDLE / 2 ON  (HPU, HTD, PCT)
    onIdleOn: dec({ 0: { text: 'OFF', color: '#64748b' }, 1: { text: 'IDLE', color: '#38bdf8' }, 2: { text: 'ON', color: '#4ade80' } }),
    engine: dec({
        [-1]: UNK, 0: { text: 'READY', color: '#38bdf8' }, 1: { text: 'RUNNING', color: '#38bdf8' },
        2: { text: 'DONE', color: '#4ade80' }, 3: { text: 'EMERGENCY', color: '#ef4444' },
        4: { text: 'NOT READY', color: '#fbbf24' }, 5: { text: 'FAULT', color: '#ef4444' },
        6: { text: 'RUN+FAULT', color: '#f97316' }, 7: { text: 'STOP FORCED', color: '#ef4444' },
    }),
    pctSeq: dec({
        0: { text: 'OFF', color: '#64748b' }, 1: { text: 'MAKE-UP', color: '#38bdf8' },
        2: { text: 'BREAK-OUT', color: '#fbbf24' }, 3: { text: 'RESET', color: '#94a3b8' },
        4: { text: 'FAULT', color: '#ef4444' },
    }),
    pctDolly: dec({
        0: { text: 'NONE', color: '#64748b' }, 1: { text: 'OUT PARK', color: '#fbbf24' },
        2: { text: 'MOVE WORK', color: '#38bdf8' }, 3: { text: 'MOVE PARK', color: '#fbbf24' },
        4: { text: 'IN PARK', color: '#fbbf24' }, 5: { text: 'FAULT', color: '#ef4444' },
        6: { text: 'IN WORK', color: '#22d3ee' },
    }),
    pctSpinner: dec({
        0: { text: 'NO CMD', color: '#64748b' }, 1: { text: 'FULLY UP', color: '#4ade80' },
        2: { text: 'FULLY DN', color: '#4ade80' }, 3: { text: 'MAKE-UP', color: '#38bdf8' },
        4: { text: 'BREAK-OUT', color: '#fbbf24' }, 10: { text: 'NOT MTD', color: '#64748b' },
    }),
    cwkPark: dec({ 0: { text: 'NOT IN PARK', color: '#fbbf24' }, 1: { text: 'PARKED', color: '#4ade80' } }),
    carrier: dec({
        1: { text: 'STOP', color: '#94a3b8' }, 2: { text: 'PARK POS', color: '#4ade80' },
        3: { text: 'WORK POS', color: '#4ade80' }, 4: { text: 'LIFTING', color: '#38bdf8' },
        5: { text: 'LOWERING', color: '#38bdf8' }, 6: { text: 'FAULT', color: '#ef4444' },
    }),
    slide: dec({
        1: { text: 'IDLE', color: '#94a3b8' }, 2: { text: 'PARK POS', color: '#4ade80' },
        3: { text: 'FWD', color: '#38bdf8' }, 4: { text: 'BWD', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' },
    }),
    clamp: dec({
        0: { text: 'NONE', color: '#64748b' }, 1: { text: 'OPENING', color: '#38bdf8' },
        2: { text: 'CLOSING', color: '#38bdf8' }, 3: { text: 'OPEN', color: '#4ade80' },
        4: { text: 'CLOSED', color: '#fbbf24' }, 5: { text: 'FAULT', color: '#ef4444' },
    }),
    elevator: dec({
        0: UNK, 1: { text: 'OPENING', color: '#38bdf8' }, 2: { text: 'CLOSING', color: '#38bdf8' },
        3: { text: 'OPEN', color: '#4ade80' }, 4: { text: 'CLOSED', color: '#fbbf24' }, 5: { text: 'FAULT', color: '#ef4444' },
    }),
    rotation: dec({ 0: { text: 'STOPPED', color: '#94a3b8' }, 1: { text: 'FWD', color: '#4ade80' }, 2: { text: 'BWD', color: '#fbbf24' }, 3: { text: 'NEUTRAL', color: '#94a3b8' } }),
    acs: dec({ 0: UNK, 1: { text: 'ON', color: '#4ade80' }, 2: { text: 'OFF', color: '#64748b' }, 3: { text: 'DISABLED', color: '#ef4444' } }),
    acsCal: dec({
        [-1]: UNK, 1: { text: 'CALIBRATING', color: '#38bdf8' }, 2: { text: 'NOT CALIBRATED', color: '#fbbf24' },
        3: { text: 'CALIBRATED', color: '#4ade80' }, 10: { text: 'MOVE UP', color: '#38bdf8' }, 11: { text: 'MOVE DOWN', color: '#38bdf8' },
    }),
    gear: (v) => {
        const n = Number(v);
        if (n === -1) return { text: 'FAULT', color: '#ef4444' };
        if (n >= 1 && n <= 4) return { text: `GEAR ${n}`, color: '#4ade80' };
        if (n >= 5 && n <= 8) return { text: `G${n - 4} REGEN`, color: '#38bdf8' };
        return UNK;
    },
};

// Working-day trend ribbons. `metric` is the backend /api/history key
// (measurement.field); `get` reads the same signal from the live payload so
// live samples can be appended on top of the seeded history.
const TREND_DEFS = [
    { id: 'hookLoad', label: 'HOOK LOAD', unit: 't', color: ACCENT.a1, d: 0, metric: 'drawworks.hook_load', get: (r) => num(r.drawworks?.hook_load) },
    { id: 'wob', label: 'WOB', unit: 't', color: '#f97316', d: 1, metric: 'drilling.wob', get: (r) => num(r.drilling?.wob) },
    { id: 'blockPos', label: 'BLOCK POS', unit: 'mm', color: ACCENT.a2, d: 0, metric: 'drawworks.block_position', get: (r) => num(r.drawworks?.block_position) },
    { id: 'htdRpm', label: 'HTD RPM', unit: 'rpm', color: ACCENT.ok, d: 0, metric: 'htd.rpm', get: (r) => num(r.htd?.rpm) },
    { id: 'htdTorque', label: 'HTD TORQUE', unit: 'daN-m', color: ACCENT.b2, d: 0, metric: 'htd.torque', get: (r) => num(r.htd?.torque) },
    { id: 'htdStatus', label: 'HTD STATUS', unit: 'code', color: '#c084fc', d: 0, metric: 'htd.status', get: (r) => num(r.htd?.status) },
    { id: 'htdGear', label: 'HTD GEAR', unit: 'code', color: '#a78bfa', d: 0, metric: 'htd.gear_status', get: (r) => num(r.htd?.gear_status) },
    { id: 'htdElevator', label: 'HTD ELEVATOR', unit: 'code', color: '#8b5cf6', d: 0, metric: 'htd.elevator_status', get: (r) => num(r.htd?.elevator_status) },
    { id: 'pctTorque', label: 'PCT MAKE-UP', unit: 'daN-m', color: ACCENT.b1, d: 0, metric: 'pct.makeup_torque', get: (r) => num(r.pct?.makeup_torque) },
    { id: 'pctLastTorque', label: 'PCT LAST TORQUE', unit: 'daN-m', color: '#bef264', d: 0, metric: 'pct.last_makeup_torque', get: (r) => num(r.pct?.last_makeup_torque) },
    { id: 'pctStatus', label: 'PCT STATUS', unit: 'code', color: '#22d3ee', d: 0, metric: 'pct.status', get: (r) => num(r.pct?.status) },
    { id: 'pctSequence', label: 'PCT SEQUENCE', unit: 'code', color: '#06b6d4', d: 0, metric: 'pct.sequence', get: (r) => num(r.pct?.sequence) },
    { id: 'pctDolly', label: 'PCT DOLLY', unit: 'code', color: '#0891b2', d: 0, metric: 'pct.dolly_status', get: (r) => num(r.pct?.dolly_status) },
    { id: 'pctClampUpP', label: 'PCT UP CLAMP P', unit: 'bar', color: '#67e8f9', d: 1, metric: 'pct.clamp_up_pressure', get: (r) => num(r.pct?.clamp_up_pressure) },
    { id: 'pctClampLowP', label: 'PCT LOW CLAMP P', unit: 'bar', color: '#0e7490', d: 1, metric: 'pct.clamp_low_pressure', get: (r) => num(r.pct?.clamp_low_pressure) },
    { id: 'hpuPress', label: 'HPU PRESS', unit: 'bar', color: ACCENT.info, d: 0, metric: 'hpu.discharge_pressure', get: (r) => num(r.hpu?.discharge_pressure) },
    { id: 'hpuAuxPress', label: 'HPU AUX PRESS', unit: 'bar', color: '#60a5fa', d: 1, metric: 'hpu.aux_pressure', get: (r) => num(r.hpu?.aux_pressure) },
    { id: 'hpuOilTemp', label: 'HPU OIL TEMP', unit: 'degC', color: '#fb923c', d: 1, metric: 'hpu.oil_temp', get: (r) => num(r.hpu?.oil_temp) },
    { id: 'hpuOilLevel', label: 'HPU OIL LEVEL', unit: '%', color: '#4ade80', d: 0, metric: 'hpu.oil_level', get: (r) => num(r.hpu?.oil_level) },
    { id: 'hpuStatus', label: 'HPU STATUS', unit: 'code', color: '#16a34a', d: 0, metric: 'hpu.status', get: (r) => num(r.hpu?.status) },
    { id: 'genLoad', label: 'GENSET LOAD', unit: '%', color: ACCENT.warn, d: 0, metric: 'cat_engine.load', get: (r) => num(r.cat_engine?.load) },
    { id: 'genRpm', label: 'CAT ENG RPM', unit: 'rpm', color: '#facc15', d: 0, metric: 'cat_engine.rpm', get: (r) => num(r.cat_engine?.rpm) },
    { id: 'genCoolant', label: 'CAT COOLANT', unit: 'degC', color: '#38bdf8', d: 0, metric: 'cat_engine.coolant_temp', get: (r) => num(r.cat_engine?.coolant_temp) },
    { id: 'genOilPress', label: 'CAT OIL PRESS', unit: 'bar', color: '#eab308', d: 1, metric: 'cat_engine.oil_pressure', get: (r) => num(r.cat_engine?.oil_pressure) },
    { id: 'genStatus', label: 'CAT STATUS', unit: 'code', color: '#f59e0b', d: 0, metric: 'cat_engine.status', get: (r) => num(r.cat_engine?.status) },
    { id: 'circPress', label: 'CIRC PRESS', unit: 'psi', color: '#84cc16', d: 0, metric: 'mudpump.pressure', scale: BAR_TO_PSI, get: (r) => num(r.mudpump?.pressure) * BAR_TO_PSI },
    { id: 'spm', label: 'SPM', unit: 'spm', color: '#22c55e', d: 1, metric: 'mudpump.spm', get: (r) => num(r.mudpump?.spm) },
    { id: 'flowIn', label: 'FLOW IN', unit: 'L/min', color: '#8b5cf6', d: 0, metric: 'mudpump.flow_in', get: (r) => num(r.mudpump?.flow_in) },
    { id: 'flowOut', label: 'FLOW OUT', unit: '%', color: '#10b981', d: 1, metric: 'fluid.flow_out', get: (r) => num(r.fluid?.flow_out) },
    { id: 'tripTank', label: 'TRIP TANK', unit: 'm3', color: '#14b8a6', d: 1, metric: 'fluid.trip_tank', get: (r) => num(r.fluid?.trip_tank) },
    { id: 'gainLoss', label: 'GAIN/LOSS', unit: 'm3', color: '#2dd4bf', d: 2, metric: 'fluid.tank_gain_loss', get: (r) => num(r.fluid?.tank_gain_loss) },
    { id: 'cwkStatus', label: 'CATWALK STATUS', unit: 'code', color: '#fbbf24', d: 0, metric: 'cwk.status', get: (r) => num(r.cwk?.status) },
    { id: 'cwkCarrier', label: 'CWK CARRIER', unit: 'code', color: '#fde047', d: 0, metric: 'cwk.carrier_status', get: (r) => num(r.cwk?.carrier_status) },
    { id: 'cwkClamp', label: 'CWK CLAMP', unit: 'code', color: '#facc15', d: 0, metric: 'cwk.clamp_status', get: (r) => num(r.cwk?.clamp_status) },
    { id: 'cwkClampP', label: 'CWK CLAMP P', unit: 'bar', color: '#fcd34d', d: 1, metric: 'cwk.clamp_pressure', get: (r) => num(r.cwk?.clamp_pressure) },
    { id: 'cwkClampF', label: 'CWK CLAMP F', unit: 'daN', color: '#ca8a04', d: 1, metric: 'cwk.clamp_force', get: (r) => num(r.cwk?.clamp_force) },
    { id: 'acsCrown', label: 'ACS CROWNSAVER', unit: 'mm', color: '#fb7185', d: 0, metric: 'acs.crownsaver', get: (r) => num(r.acs?.crownsaver) },
    { id: 'acsFloor', label: 'ACS FLOORSAVER', unit: 'mm', color: '#f43f5e', d: 0, metric: 'acs.floorsaver', get: (r) => num(r.acs?.floorsaver) },
    { id: 'acsBottom', label: 'ACS BOTTOMSAVER', unit: 'mm', color: '#e11d48', d: 0, metric: 'acs.bottomsaver', get: (r) => num(r.acs?.bottomsaver) },
    { id: 'acsStatus', label: 'ACS STATUS', unit: 'code', color: '#be123c', d: 0, metric: 'acs.status', get: (r) => num(r.acs?.status) },
    { id: 'tubingP', label: 'TUBING PRESS', unit: 'bar', color: ACCENT.crit, d: 0, metric: 'wellhead.tubing_pressure', get: (r) => num(r.wellhead?.tubing_pressure) },
    { id: 'casingP', label: 'CASING PRESS', unit: 'bar', color: '#f472b6', d: 0, metric: 'wellhead.casing_pressure', get: (r) => num(r.wellhead?.casing_pressure) },
    { id: 'accumP', label: 'ACCUM PRESS', unit: 'psi', color: '#ec4899', d: 0, metric: 'well_control.accumulator_pressure', get: (r) => num(r.well_control?.accumulator_pressure) },
    { id: 'annularP', label: 'ANNULAR PRESS', unit: 'psi', color: '#db2777', d: 0, metric: 'well_control.annular_pressure', get: (r) => num(r.well_control?.annular_pressure) },
    { id: 'holeDepth', label: 'HOLE DEPTH', unit: 'm', color: '#06b6d4', d: 1, metric: 'drilling.hole_depth', get: (r) => num(r.drilling?.hole_depth ?? r.hole_depth) },
    { id: 'bitDepth', label: 'BIT DEPTH', unit: 'm', color: '#38bdf8', d: 1, metric: 'drilling.bit_depth', get: (r) => num(r.drilling?.bit_depth ?? r.bit_depth) },
    { id: 'rop', label: 'ROP', unit: 'm/hr', color: '#0ea5e9', d: 1, metric: 'drilling.rop', get: (r) => num(r.drilling?.rop) },
];
const TREND_MAX_POINTS = 1500;
const OVERVIEW_TREND_SELECTION_KEY = 'rig-overview-last12h-trends';
const DEFAULT_OVERVIEW_TREND_IDS = ['hookLoad', 'blockPos', 'htdRpm', 'htdTorque', 'pctTorque', 'hpuPress', 'genLoad'];
const TREND_GROUP_LABELS = {
    drawworks: 'Drawworks', drilling: 'Drilling', htd: 'HTD', pct: 'PCT', hpu: 'HPU',
    cat_engine: 'CAT Engine', mudpump: 'Mud Pump', fluid: 'Fluid', cwk: 'Catwalk',
    acs: 'ACS', wellhead: 'Wellhead', well_control: 'Well Control'
};
const TREND_GROUPS = Object.entries(TREND_GROUP_LABELS).map(([id, label]) => ({
    id,
    label,
    fields: TREND_DEFS.filter((definition) => definition.metric.startsWith(`${id}.`))
})).filter((group) => group.fields.length);
const loadTrendSelection = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(OVERVIEW_TREND_SELECTION_KEY) || '[]');
        const valid = new Set(TREND_DEFS.map((t) => t.id));
        const selected = Array.isArray(parsed) ? parsed.filter((id) => valid.has(id)) : [];
        return selected.length ? selected : DEFAULT_OVERVIEW_TREND_IDS;
    } catch {
        return DEFAULT_OVERVIEW_TREND_IDS;
    }
};
// --- Last-12-hour overview trend window -----------------------------------
// Fill the full trend area with the recent operating window instead of
// compressing today's samples inside a fixed 06:00->06:00 tour.
const TREND_WINDOW_MS = 12 * 60 * 60 * 1000;
const computeWorkingDay = (nowMs = Date.now()) => {
    return { dayStart: nowMs - TREND_WINDOW_MS, dayEnd: nowMs };
};

const getViewportWidth = () => {
    if (typeof window === 'undefined') return 1600;
    return window.visualViewport?.width || window.innerWidth || 1600;
};

const getViewportHeight = () => {
    if (typeof window === 'undefined') return 900;
    return window.visualViewport?.height || window.innerHeight || 900;
};

const overviewScaleForWidth = (width) => {
    if (width >= 1500) return 1;
    return Math.max(0.66, Math.min(1, (width - 12) / 1820));
};

export default function RigConsoleOverview() {
    const muiTheme = useTheme();
    const navigate = useNavigate();
    const isDark = muiTheme.palette.mode !== 'light';
    const c = isDark ? DARK : LIGHT;
    const A = ACCENT;

    // Per-parameter alarm overlay: a widget whose dataKey is in alarm shows the
    // priority colour and blinks while unacked/latched (steady once acknowledged).
    const { byDataKey } = useAlarms();
    const alarmFor = (dk) => {
        const a = dk && byDataKey[dk];
        if (!a) return null;
        const blink = a.state === 'UNACK' || a.state === 'RTN_UNACK';
        return { color: priorityColor(a.priority), blink, state: a.state, priority: a.priority, condition: a.condition };
    };
    const blinkAnim = (al) => (al && al.blink ? `${ALARM_BLINK} 1s steps(1, end) infinite` : 'none');

    const cachedRig = getLatestRigData();
    const cachedAlarms = getLatestAlarms();
    const cachedRigIsLive = isLiveRigPayload(cachedRig);
    const [raw, setRaw] = useState(() => cachedRigIsLive ? cachedRig : {});
    const [alarms, setAlarms] = useState(() => Array.isArray(cachedAlarms?.active) ? cachedAlarms.active : []);
    const [identity, setIdentity] = useState({ rig: '', well: '' });
    const [feed, setFeed] = useState(() => ({
        connected: socket.connected,
        stale: !cachedRigIsLive || !!cachedRig?._meta?.stale,
        hasData: cachedRigIsLive
    }));

    // Working-day trend series: { id: [{t,v}] }, seeded from /api/history.
    const [workingDay, setWorkingDay] = useState(() => computeWorkingDay());
    const [viewportWidth, setViewportWidth] = useState(getViewportWidth);
    const [viewportHeight, setViewportHeight] = useState(getViewportHeight);
    const [selectedTrendIds, setSelectedTrendIds] = useState(loadTrendSelection);
    const [trendSelectorOpen, setTrendSelectorOpen] = useState(false);
    const selectedTrendDefs = useMemo(() => {
        const selected = new Set(selectedTrendIds);
        const defs = TREND_DEFS.filter((t) => selected.has(t.id));
        return defs.length ? defs : TREND_DEFS.filter((t) => DEFAULT_OVERVIEW_TREND_IDS.includes(t.id));
    }, [selectedTrendIds]);
    const histRef = useRef(Object.fromEntries(TREND_DEFS.map((t) => [t.id, []])));
    const [, setTick] = useState(0);

    useEffect(() => {
        try { localStorage.setItem(OVERVIEW_TREND_SELECTION_KEY, JSON.stringify(selectedTrendIds)); } catch { /* best effort */ }
    }, [selectedTrendIds]);

    useEffect(() => {
        const updateViewportSize = () => {
            setViewportWidth(getViewportWidth());
            setViewportHeight(getViewportHeight());
        };
        window.addEventListener('resize', updateViewportSize);
        window.visualViewport?.addEventListener('resize', updateViewportSize);
        return () => {
            window.removeEventListener('resize', updateViewportSize);
            window.visualViewport?.removeEventListener('resize', updateViewportSize);
        };
    }, []);

    const handleTrendSelection = useCallback((event) => {
        const next = typeof event.target.value === 'string' ? event.target.value.split(',') : event.target.value;
        if (next.length) setSelectedTrendIds(TREND_DEFS.filter((definition) => next.includes(definition.id)).map((definition) => definition.id));
    }, []);

    const pushHist = useCallback((data) => {
        const now = Date.now();
        const h = histRef.current;
        TREND_DEFS.forEach((t) => {
            const v = t.get(data);
            if (!Number.isFinite(v)) return;
            const arr = h[t.id];
            arr.push({ t: now, v });
            while (arr.length && arr[0].t < now - TREND_WINDOW_MS) arr.shift();
            if (arr.length > TREND_MAX_POINTS) arr.shift();
        });
        setTick((x) => x + 1);
    }, []);

    // Keep the 12-hour trend window moving without a manual refresh.
    useEffect(() => {
        const id = setInterval(() => {
            const next = computeWorkingDay();
            setWorkingDay(next);
        }, 60 * 1000);
        return () => clearInterval(id);
    }, []);

    // Seed each ribbon once from the recent operating window. After that the
    // socket owns updates, so page navigation stays instant on slower edge PCs.
    useEffect(() => {
        let cancelled = false;
        let timer = null;
        const params = new URLSearchParams();
        params.set('range', '-12h');
        params.set('metrics', selectedTrendDefs.map((t) => t.metric).join(','));
        timer = setTimeout(() => axios.get(`/api/history?${params.toString()}`, { timeout: 4500 })
            .then(({ data: rows }) => {
                if (cancelled || !Array.isArray(rows)) return;
                const seeded = Object.fromEntries(selectedTrendDefs.map((t) => [t.id, []]));
                rows.forEach((row) => {
                    const t = Number(row.timestamp);
                    if (!Number.isFinite(t)) return;
                    selectedTrendDefs.forEach((d) => {
                        const v = Number(row[d.metric]) * (d.scale || 1);
                        if (row[d.metric] != null && Number.isFinite(v)) seeded[d.id].push({ t, v });
                    });
                });
                // Keep live samples already captured after the seeded window.
                const cutoff = rows.length ? Number(rows[rows.length - 1].timestamp) : workingDay.dayStart;
                selectedTrendDefs.forEach((d) => {
                    const liveTail = (histRef.current[d.id] || []).filter((p) => p.t > cutoff);
                    histRef.current[d.id] = seeded[d.id].concat(liveTail);
                });
                setTick((x) => x + 1);
            })
            .catch((e) => console.error('working-day history seed failed', e)), 750);
        return () => { cancelled = true; if (timer) clearTimeout(timer); };
    }, [selectedTrendDefs, workingDay.dayStart]);

    useEffect(() => {
        const cached = getLatestRigData();
        if (isLiveRigPayload(cached) && Object.keys(cached).length) {
            setRaw(cached);
            setFeed((p) => ({ ...p, hasData: true, stale: !!cached._meta?.stale }));
            pushHist(cached);
        }
        axios.get('/api/rig/latest', { timeout: 3000 })
            .then(({ data }) => {
                if (data && Object.keys(data).length) {
                    const livePayload = isLiveRigPayload(data);
                    setRaw(livePayload ? data : {});
                    setFeed((p) => ({ ...p, hasData: livePayload, stale: !livePayload || !!data._meta?.stale }));
                    if (livePayload) pushHist(data);
                }
            })
            .catch((e) => console.error('rig/latest failed', e));
        axios.get('/api/alarms', { timeout: 3000 }).then(({ data }) => setAlarms(Array.isArray(data?.active) ? data.active : [])).catch(() => {});
        axios.get(`/api/dashboard/layout?t=${Date.now()}`, { timeout: 3000 }).then(({ data }) => { if (data?.wellInfo) setIdentity((p) => ({ ...p, ...data.wellInfo })); }).catch(() => {});
        const loadWell = () => axios.get('/api/wells/active', { timeout: 3000 }).then(({ data }) => { if (data?.name) setIdentity((p) => ({ ...p, well: data.name })); }).catch(() => {});
        loadWell();
        const wellPoll = setInterval(loadWell, 5000);

        const onRig = (data) => {
            if (!data || !Object.keys(data).length) { setFeed((p) => ({ ...p, hasData: false })); return; }
            const livePayload = isLiveRigPayload(data);
            setRaw(livePayload ? data : {});
            setFeed({ connected: socket.connected, hasData: livePayload, stale: !livePayload || !!data._meta?.stale });
            if (livePayload) pushHist(data);
        };
        const onAlarms = (p) => setAlarms(Array.isArray(p?.active) ? p.active : []);
        const onConnect = () => setFeed((p) => ({ ...p, connected: true }));
        const onDisconnect = () => setFeed((p) => ({ ...p, connected: false }));
        socket.on('rig_data', onRig); socket.on('alarms', onAlarms); socket.on('connect', onConnect); socket.on('disconnect', onDisconnect);
        return () => { socket.off('rig_data', onRig); socket.off('alarms', onAlarms); socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); clearInterval(wellPoll); };
    }, [pushHist]);

    const live = feed.connected && feed.hasData && !feed.stale;
    // Safety/derived value: never fabricate a number on a dead, stale, or absent signal.
    const sv = (v, d = 0) => (live && Number.isFinite(Number(v)) ? fmt(v, d) : '--');

    // ---- alarms ------------------------------------------------------------
    const sevOf = (p) => (p === 'P1' ? A.crit : p === 'P2' ? A.warn : p === 'P3' ? A.info : A.ok);
    const tagOf = (a) => { const dk = a.dataKey || ''; const head = dk.includes('.') ? dk.split('.')[0] : (a.id || ''); return (head || 'SYS').toUpperCase().slice(0, 12); };
    const annun = [...alarms]
        .sort((x, y) => (Date.parse(y.raisedAt) || 0) - (Date.parse(x.raisedAt) || 0))
        .map((a) => ({ id: a.id, time: hhmmss(a.raisedAt), tag: tagOf(a), msg: a.label || a.id, sevColor: sevOf(a.priority) }));
    const activeCount = alarms.filter((a) => (a.priority === 'P1' || a.priority === 'P2') && a.state !== 'ACK').length;
    const ticker = annun.length ? annun.concat(annun) : [];

    // ---- reads -------------------------------------------------------------
    const d = raw.drilling || {}, dw = raw.drawworks || {}, mp = raw.mudpump || {}, fl = raw.fluid || {};
    const hpu = raw.hpu || {}, htd = raw.htd || {}, pct = raw.pct || {}, cat = raw.cat_engine || {}, cat2 = raw.cat_engine_2 || {}, cwk = raw.cwk || {};
    const acs = raw.acs || {}, wc = raw.well_control || {}, sf = raw.safety || {}, wh = raw.wellhead || {};
    const eff = raw._efficiency || {}, kpi = raw._kpi || {}, act = raw._activity || {}, tt = raw._torqueturn || {};

    const esd = num(sf.esd_active) === 1 || num(sf.lockout_active) === 1;
    // Well-control values are only trustworthy when the backend says a BOP source exists.
    const wcLive = live && wc.available !== false;
    const wcv = (v, dp = 0) => (wcLive && Number.isFinite(Number(v)) ? fmt(v, dp) : '--');

    const blockMm = num(dw.block_position);
    const circPressPsi = num(mp.pressure) * BAR_TO_PSI;
    const stringDepth = num(d.bit_depth);        // tubing/rod string depth on a workover rig
    const holeDepth = num(d.hole_depth);
    const acsCalibrated = num(acs.calibration_status) === 3;

    // ---- primary instruments (workover-relevant, real alarm setpoints) -----
    const A0 = -135, A1 = 135;
    const gaugeDefs = [
        { label: 'HOOK LOAD', unit: 't', dataKey: 'drawworks.hook_load', val: num(dw.hook_load), min: 0, max: 100, warn: 80, crit: 90, sub: ['WOB', sv(d.wob, 1), 't'], safety: true },
        { label: 'HTD', unit: 'rpm', dataKey: 'htd.rpm', val: num(htd.rpm), min: 0, max: 200, warn: 170, crit: 190, sub: ['TORQUE', sv(htd.torque, 0), 'daN-m'] },
        { label: 'SPP', unit: 'psi', dataKey: 'mudpump.pressure', val: circPressPsi, min: 0, max: 3000, warn: 2400, crit: 2700, sub: ['RATE', sv(mp.spm, 1), 'spm'] },
    ];
    const gauges = gaugeDefs.map((g) => {
        const pct01 = clamp01((g.val - g.min) / (g.max - g.min));
        const ang = A0 + pct01 * 270;
        const ticks = [];
        for (let i = 0; i <= 40; i++) { const dd = A0 + (i / 40) * 270, major = i % 5 === 0; const o = polar(100, 100, 84, dd), inn = polar(100, 100, major ? 70 : 76, dd); ticks.push({ x1: o.x, y1: o.y, x2: inn.x, y2: inn.y, w: major ? 2 : 1, col: major ? c.txt2 : c.txt3 }); }
        const labels = Array.from({ length: 6 }, (_, i) => {
            const labelVal = g.min + ((g.max - g.min) * i) / 5;
            const labelAng = A0 + (i / 5) * 270;
            const p = polar(100, 100, 55, labelAng);
            return { x: p.x, y: p.y, text: fmt(labelVal, labelVal >= 1000 ? 0 : 0) };
        });
        const over = g.val >= g.crit, near = g.val >= g.warn;
        const alarm = alarmFor(g.dataKey);
        const valColor = alarm ? alarm.color : (!live ? c.txt3 : over ? A.crit : near ? A.warn : A.ok);
        return {
            ...g, ang, valColor, alarm,
            valueStr: sv(g.val, 0),
            trackPath: arc(100, 100, 84, A0, A1), valuePath: arc(100, 100, 84, A0, live ? ang : A0),
            warnPath: arc(100, 100, 93, A0 + clamp01((g.warn - g.min) / (g.max - g.min)) * 270, A0 + clamp01((g.crit - g.min) / (g.max - g.min)) * 270),
            critPath: arc(100, 100, 93, A0 + clamp01((g.crit - g.min) / (g.max - g.min)) * 270, A1),
            ticks, labels, minStr: fmt(g.min), maxStr: fmt(g.max),
        };
    });

    const trends = selectedTrendDefs.map((t) => ({
        ...t,
        valueStr: live ? fmt(t.get(raw), t.d) : '--',
        ...sparkDay(histRef.current[t.id], 100, 24, workingDay.dayStart, workingDay.dayEnd),
    }));
    const workingDayLabel = `${new Date(workingDay.dayStart).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })} -> ${new Date(workingDay.dayEnd).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`;

    // ---- equipment summary cards (mirror the equipment dashboards) ---------
    const filterOk = [1, 2, 3, 4, 5, 6, 7, 8].filter((i) => hpu[`oil_filter_${i}`] != null && num(hpu[`oil_filter_${i}`]) !== 0).length;
    const filterMapped = [1, 2, 3, 4, 5, 6, 7, 8].filter((i) => hpu[`oil_filter_${i}`] != null).length;
    const hpuClog = filterMapped > 0 && filterOk < filterMapped;
    const hpuStat = hpuClog ? { text: 'FILTER CLOG', color: '#fbbf24' } : S.onIdleOn(hpu.status);

    // Circulating pump has no status enum anywhere -- derive it from the real alarm setpoints.
    const gl = Math.abs(num(fl.tank_gain_loss));
    const circStat = !live ? UNK
        : gl >= 3 ? { text: 'PIT ALARM', color: '#ef4444' }
            : gl >= 1.5 ? { text: 'GAIN/LOSS', color: '#fbbf24' }
                : num(mp.pressure) >= 300 ? { text: 'HIGH PRESS', color: '#ef4444' }
                    : num(mp.pressure) >= 240 ? { text: 'HIGH PRESS', color: '#fbbf24' }
                        : num(mp.spm) > 0 ? { text: 'CIRCULATING', color: '#4ade80' }
                            : { text: 'STOPPED', color: '#64748b' };

    const ramState = (closeFlag, openFlag) => (closeFlag ? 'CLOSED' : openFlag ? 'OPEN' : 'NO DATA');
    const rams = [
        { name: 'ANNULAR', state: wcLive ? ramState(wc.annular_close, wc.annular_open) : 'NO DATA' },
        { name: 'PIPE RAM', state: wcLive ? ramState(wc.pipe_ram_close, wc.pipe_ram_open) : 'NO DATA' },
        { name: 'BLIND RAM', state: wcLive ? ramState(wc.blind_ram_close, wc.blind_ram_open) : 'NO DATA' },
    ];
    const wcStat = !feed.connected ? { text: 'SOCKET DOWN', color: '#ef4444' }
        : wc.available === false ? { text: 'NO BOP SOURCE', color: '#ef4444' }
            : feed.stale ? { text: 'FEED STALE', color: '#fbbf24' }
                : esd ? { text: 'ESD ACTIVE', color: '#ef4444' }
                    : rams.some((r) => r.state === 'CLOSED') ? { text: 'CLOSED - MONITOR', color: '#fbbf24' }
                        : { text: 'NORMAL', color: '#4ade80' };

    const equipment = [
        {
            id: 'cat', label: 'CAT ENG', side: 'l', color: A.info, route: '/equipment?tab=cat-engine', stat: S.engine(cat.status),
            params: [
                { k: 'ENG1 RPM', v: cat.rpm == null ? '--' : sv(cat.rpm, 0), u: '', dk: 'cat_engine.rpm' },
                { k: 'ENG2 RPM', v: cat2.rpm == null ? '--' : sv(cat2.rpm, 0), u: '', dk: 'cat_engine_2.rpm' },
                { k: 'ENG1 OIL PRESS', v: cat.oil_pressure == null ? '--' : sv(cat.oil_pressure, 1), u: 'bar', dk: 'cat_engine.oil_pressure' },
                { k: 'ENG2 OIL PRESS', v: cat2.oil_pressure == null ? '--' : sv(cat2.oil_pressure, 1), u: 'bar', dk: 'cat_engine_2.oil_pressure' },
            ],
        },
        {
            id: 'hpu', label: 'HPU', side: 'l', color: A.ok, route: '/equipment?tab=hpu', stat: hpuStat,
            params: [
                { k: 'DISCHARGE', v: sv(hpu.discharge_pressure, 0), u: 'bar' },
                { k: 'OIL TEMP', v: sv(hpu.oil_temp, 1), u: 'degC', dk: 'hpu.oil_temp' },
                { k: 'OIL LEVEL', v: sv(hpu.oil_level, 0), u: '%' },
                { k: 'FILTERS', v: live && filterMapped ? `${filterOk}/${filterMapped}` : '--', u: '' },
            ],
        },
        {
            id: 'htd', label: 'HTD', side: 'l', color: A.b2, route: '/equipment?tab=htd', stat: S.onIdleOn(htd.status),
            params: [
                { k: 'RPM', v: sv(htd.rpm, 0), u: '' },
                { k: 'TORQUE', v: sv(htd.torque, 0), u: 'daN-m' },
                { k: 'GEAR', v: live ? S.gear(htd.gear_status).text : '--', u: '' },
                { k: 'ELEVATOR', v: live ? S.elevator(htd.elevator_status).text : '--', u: '' },
            ],
        },
        {
            id: 'pct', label: 'PCT', side: 'l', color: A.a2, route: '/equipment?tab=pct',
            stat: pct.sequence != null ? S.pctSeq(pct.sequence) : S.onIdleOn(pct.status),
            params: [
                { k: 'MAKE-UP', v: sv(pct.makeup_torque, 0), u: 'daN-m' },
                { k: 'LAST', v: sv(pct.last_makeup_torque, 0), u: 'daN-m' },
                { k: 'DOLLY', v: live ? S.pctDolly(pct.dolly_status).text : '---', u: '' },
                { k: 'UP CLAMP', v: sv(pct.clamp_up_pressure, 1), u: 'bar' },
                { k: 'LOW CLAMP', v: sv(pct.clamp_low_pressure, 1), u: 'bar' },
            ],
        },
        {
            id: 'acs', label: 'ACS', side: 'r', color: A.crit, route: '/equipment?tab=acs',
            stat: acsCalibrated ? S.acs(acs.status) : S.acsCal(acs.calibration_status),
            params: [
                { k: 'CROWNSAVER', v: sv(acs.crownsaver, 0), u: 'mm' },
                { k: 'FLOORSAVER', v: sv(acs.floorsaver, 0), u: 'mm' },
                { k: 'BOTTOMSAVER', v: sv(acs.bottomsaver, 0), u: 'mm' },
                { k: 'BLOCK POS', v: sv(blockMm, 0), u: 'mm' },
            ],
        },
        {
            id: 'circ', label: 'CIRC PUMP', side: 'r', color: A.b1, route: '/equipment?tab=mud-pump', stat: circStat,
            params: [
                { k: 'PRESS', v: sv(circPressPsi, 0), u: 'psi', dk: 'mudpump.pressure' },
                { k: 'RATE', v: sv(mp.spm, 1), u: 'spm' },
                { k: 'TRIP TANK', v: sv(fl.trip_tank, 1), u: 'm3' },
                { k: 'GAIN/LOSS', v: sv(fl.tank_gain_loss, 2), u: 'm3', dk: 'fluid.tank_gain_loss' },
            ],
        },
        {
            id: 'cwk', label: 'CATWALK', side: 'r', color: A.warn, route: '/equipment?tab=cwk', stat: S.cwkPark(cwk.status),
            params: [
                { k: 'CARRIER', v: live ? S.carrier(cwk.carrier_status).text : '--', u: '' },
                { k: 'CLAMP', v: live ? S.clamp(cwk.clamp_status).text : '--', u: '' },
                { k: 'CLAMP P', v: sv(cwk.clamp_pressure, 1), u: 'bar' },
                { k: 'CLAMP F', v: sv(cwk.clamp_force, 1), u: 'daN' },
            ],
        },
        {
            id: 'wctl', label: 'WELL CONTROL', side: 'r', color: A.crit, route: '/wellcontrol', stat: wcStat,
            params: [
                { k: 'TUBING P', v: sv(wh.tubing_pressure, 1), u: 'bar', dk: 'wellhead.tubing_pressure' },
                { k: 'CASING P', v: sv(wh.casing_pressure, 1), u: 'bar', dk: 'wellhead.casing_pressure' },
                { k: 'ACCUM', v: wcv(wc.accumulator_pressure, 0), u: 'psi', dk: 'well_control.accumulator_pressure' },
                { k: 'ANNULAR', v: wcv(wc.annular_pressure, 0), u: 'psi' },
            ],
        },
    ];

    // ---- shared style fragments -------------------------------------------
    const panelBg = isDark ? 'linear-gradient(145deg, #22304a 0%, #172236 54%, #111827 100%)' : c.bg2;
    const gaugeBg = isDark ? 'radial-gradient(circle at 50% 38%, #263956 0%, #1b2940 54%, #121b2c 100%)' : c.bg3;
    const card = { background: panelBg, border: `1px solid ${c.line}`, borderRadius: 10, boxShadow: isDark ? '0 10px 28px rgba(0,0,0,.26), inset 0 1px 0 rgba(255,255,255,.035)' : 'none' };
    const sectionLabel = { fontSize: 11, fontWeight: 700, letterSpacing: '.16em', color: c.txt2 };

    const Gauge = ({ g }) => (
        <div style={{ flex: '1 1 0', minWidth: 0, border: `1px solid ${g.alarm ? g.alarm.color : c.line}`, borderRadius: 9, background: gaugeBg, padding: overviewLayout.gaugePad, animation: blinkAnim(g.alarm), boxShadow: isDark ? 'inset 0 0 0 1px rgba(255,255,255,.025), 0 8px 18px rgba(0,0,0,.24)' : 'none' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'baseline', justifyContent: 'center', minHeight: 14 }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', color: c.txt2, textAlign: 'center' }}>{g.label}</span>
                {g.alarm && <span style={{ position: 'absolute', right: 0, fontSize: 9, fontWeight: 800, color: g.alarm.color }}>{g.alarm.priority} - {g.alarm.condition}</span>}
            </div>
            <div style={{ position: 'relative', width: overviewLayout.gaugeSize, height: overviewLayout.gaugeHeight, margin: '6px auto 0', maxWidth: '100%' }}>
                <svg viewBox="0 0 200 200" width={overviewLayout.gaugeSize} height={overviewLayout.gaugeSize} style={{ position: 'absolute', top: -2, left: '50%', transform: 'translateX(-50%)', overflow: 'visible', maxWidth: '100%' }}>
                    <path d={g.trackPath} fill="none" stroke={c.line2} strokeWidth="4" strokeLinecap="round" />
                    <path d={g.warnPath} fill="none" stroke={A.warn} strokeWidth="4" />
                    <path d={g.critPath} fill="none" stroke={A.crit} strokeWidth="4" strokeLinecap="round" />
                    {g.ticks.map((tk, i) => <line key={i} x1={tk.x1} y1={tk.y1} x2={tk.x2} y2={tk.y2} stroke={tk.col} strokeWidth={tk.w} />)}
                    {g.labels.map((lb, i) => (
                        <text
                            key={i}
                            x={lb.x}
                            y={lb.y + 3}
                            textAnchor="middle"
                            fontFamily={VALUE_FONT}
                            fontSize={i === 0 || i === g.labels.length - 1 ? 8.8 : 10.5}
                            fontWeight="900"
                            fill={c.txt2}
                            stroke={c.bg3}
                            strokeWidth="0.7"
                            paintOrder="stroke"
                        >
                            {lb.text}
                        </text>
                    ))}
                    <path d={g.valuePath} fill="none" stroke={g.valColor} strokeWidth="7" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 5px ${g.valColor})` }} />
                    {live && <g transform={`rotate(${g.ang.toFixed(2)} 100 100)`}><polygon points="100,30 96,104 104,104" fill={g.valColor} /></g>}
                    <circle cx="100" cy="100" r="9" fill={c.bg3} stroke={g.valColor} strokeWidth="3" />
                </svg>
                <div style={{ position: 'absolute', left: 0, right: 0, top: overviewLayout.gaugeValueTop, textAlign: 'center', fontFamily: VALUE_FONT, fontSize: g.valueStr.length > 4 ? overviewLayout.gaugeValueSmall : overviewLayout.gaugeValue, fontWeight: 900, lineHeight: 1, color: g.valColor, textShadow: '0 2px 8px rgba(0,0,0,.65)' }}>{g.valueStr}</div>
                <div style={{ position: 'absolute', left: 0, right: 0, top: overviewLayout.gaugeUnitTop, textAlign: 'center', fontSize: overviewLayout.gaugeUnitFont, fontWeight: 800, letterSpacing: '.08em', color: c.txt2 }}>{g.unit}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 6, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${c.line}` }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.08em', color: c.txt3 }}>{g.sub[0]}</span>
                <span style={{ fontFamily: VALUE_FONT, fontSize: 17, fontWeight: 800, color: c.txt }}>{g.sub[1]}</span>
                <span style={{ fontSize: 9, color: c.txt3 }}>{g.sub[2]}</span>
            </div>
        </div>
    );

    // Equipment summary card -- click-through to the full equipment page.
    const EquipCard = (e) => {
        return (
        <div
            key={e.id}
            onClick={(event) => {
                if (e.id === 'cat') {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    const engine = event.clientX < bounds.left + bounds.width / 2 ? 'engine1' : 'engine2';
                    navigate(e.route + '&engine=' + engine);
                } else navigate(e.route);
            }}
            role={e.id === 'cat' ? 'group' : 'button'} tabIndex={e.id === 'cat' ? undefined : 0}
            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') navigate(e.route); }}
            title={e.id === 'cat' ? 'Left: Engine 1 · Right: Engine 2' : `Open ${e.label}`}
            style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', background: panelBg, border: `1px solid ${c.line}`, borderLeft: `3px solid ${e.color}`, borderRadius: 8, padding: overviewLayout.cardPad, boxShadow: isDark ? '0 8px 20px rgba(0,0,0,.24), inset 0 1px 0 rgba(255,255,255,.035)' : '0 4px 16px rgba(0,0,0,.12)', cursor: 'pointer', overflow: 'hidden' }}
        >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ fontSize: overviewLayout.cardTitleFont, fontWeight: 900, letterSpacing: '.04em', color: c.txt }}>{e.label}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: e.stat.color, boxShadow: `0 0 5px ${e.stat.color}` }} />
                    <span style={{ fontSize: 9.5, fontWeight: 900, color: e.stat.color }}>{e.stat.text}</span>
                </span>
            </div>
            <div style={{ flex: 1, display: 'grid', gridTemplateColumns: overviewLayout.paramGrid, gap: overviewLayout.paramGap, marginTop: overviewLayout.paramTopGap, alignContent: 'center' }}>
                {e.params.map((p) => {
                    const pa = alarmFor(p.dk);
                    const isAcsReading = e.id === 'acs';
                    const isBlockPos = isAcsReading && p.k === 'BLOCK POS';
                    const valueColor = pa ? pa.color : isAcsReading ? A.ok : e.color;
                    return (
                        <div key={p.k} style={{ minWidth: 0 }}
                            role={e.id === 'cat' ? 'button' : undefined}
                            tabIndex={e.id === 'cat' ? 0 : undefined}
                            aria-label={e.id === 'cat' ? `Open Engine ${p.dk.startsWith('cat_engine_2.') ? '2' : '1'} — ${p.k}` : undefined}
                            onClick={e.id === 'cat' ? (event) => {
                                event.stopPropagation();
                                navigate(e.route + '&engine=' + (p.dk.startsWith('cat_engine_2.') ? 'engine2' : 'engine1'));
                            } : undefined}
                            onKeyDown={e.id === 'cat' ? (event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    navigate(e.route + '&engine=' + (p.dk.startsWith('cat_engine_2.') ? 'engine2' : 'engine1'));
                                }
                            } : undefined}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: overviewLayout.paramLabelFont, lineHeight: 1.12, fontWeight: 900, letterSpacing: '.035em', color: pa ? pa.color : c.txt2, textShadow: '0 1px 2px rgba(0,0,0,.45)', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                                {pa && <span style={{ width: 6, height: 6, borderRadius: '50%', background: pa.color, boxShadow: `0 0 5px ${pa.color}`, animation: blinkAnim(pa) }} />}
                                {e.id === 'acs' ? p.k.replace('CROWNSAVER', 'CROWN SAVER').replace('FLOORSAVER', 'FLOOR SAVER').replace('BOTTOMSAVER', 'BOTTOM SAVER') : p.k}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, marginTop: 2, animation: blinkAnim(pa) }}>
                                <span style={{ fontFamily: VALUE_FONT, fontSize: isBlockPos ? overviewLayout.paramBlockValueFont : overviewLayout.paramValueFont, fontWeight: 900, lineHeight: 1, color: valueColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.v}</span>
                                {p.u && <span style={{ fontSize: isBlockPos ? overviewLayout.paramBlockUnitFont : overviewLayout.paramUnitFont, fontWeight: 800, color: isAcsReading ? A.ok : c.txt2 }}>{p.u}</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
        );
    };

    // ---- workover mast geometry (drawing only; calibrated by marked points) --
    const blockY = blockMm <= MAST_BLOCK_FLOOR_MM
        ? MAST_BLOCK_ZERO_Y - clamp01((blockMm - MAST_BLOCK_MIN_MM) / (MAST_BLOCK_FLOOR_MM - MAST_BLOCK_MIN_MM)) * (MAST_BLOCK_ZERO_Y - MAST_BLOCK_FLOOR_Y)
        : MAST_BLOCK_FLOOR_Y - clamp01((blockMm - MAST_BLOCK_FLOOR_MM) / (MAST_BLOCK_MAX_MM - MAST_BLOCK_FLOOR_MM)) * (MAST_BLOCK_FLOOR_Y - MAST_BLOCK_CROWN_Y);
    const htdY = blockY - 9.5;
    const elevatorY = blockY;
    const htdStat = S.onIdleOn(htd.status);
    const elevStat = S.elevator(htd.elevator_status);
    const pctSeqStat = pct.sequence != null ? S.pctSeq(pct.sequence) : UNK;
    const pctDollyValue = num(pct.dolly_status);
    const pctDollyWork = pctDollyValue === 6;
    const pctDollyMovingWork = pctDollyValue === 2;
    const pctDollyMovingPark = pctDollyValue === 1 || pctDollyValue === 3;
    const pctDollyPark = pctDollyValue === 4 || pctDollyMovingPark;
    const pctDollyFault = pctDollyValue === 5;
    const pctDollyCenter = !pctDollyWork && !pctDollyMovingWork && !pctDollyPark && !pctDollyFault;
    const pctAccent = '#22d3ee';
    const pctDollyStat = pctDollyCenter ? { text: 'CENTER', color: pctAccent } : pctDollyWork ? { text: 'IN WORK', color: pctAccent } : S.pctDolly(pct.dolly_status);
    const pctTongX = pctDollyCenter ? 43.5 : (pctDollyWork || pctDollyMovingWork) ? 59 : (pctDollyPark || pctDollyFault) ? 74 : 59;
    const pctTongColor = !live ? c.line2 : pctDollyFault ? A.crit : pctDollyCenter ? pctAccent : (pctDollyWork || pctDollyMovingWork) ? pctAccent : pctDollyPark ? A.warn : pctSeqStat.color;
    const pctAssemblyVisible = live && (pctDollyCenter || pctDollyWork || pctDollyMovingWork || pctDollyPark);
    const pctAssemblyX = pctDollyCenter ? 41 : (pctDollyWork || pctDollyMovingWork) ? 56.5 : 72;
    const pctAssemblyY = 82.5;
    const pctCompactY = 94.5;
    const pctAssemblyW = 18;
    const pctAssemblyH = 21;
    const pctSectionH = pctAssemblyH / 3;
    const pctSubsystems = [
        { key: 'spinner', label: 'SPINNER', x: 22, stat: S.pctSpinner(pct.spinner_rotation_status) },
        { key: 'clampUp', label: 'CLAMP UP', x: 41.5, stat: S.clamp(pct.clamp_up_status) },
        { key: 'clampLow', label: 'CLAMP LOW', x: 61, stat: S.clamp(pct.clamp_low_status) },
    ];
    const cwkWorking = num(cwk.carrier_status) === 3;
    const cwkCarrierValue = num(cwk.carrier_status);
    const cwkSlideValue = num(cwk.slide_status ?? cwk.skate_status);
    const cwkCarrierStat = S.carrier(cwk.carrier_status);
    const cwkSlideStat = S.slide(cwk.slide_status ?? cwk.skate_status);
    const cwkClampStat = S.clamp(cwk.clamp_status);
    const cwkFault = cwkCarrierValue === 6 || cwkSlideValue === 5 || num(cwk.clamp_status) === 5;
    const cwkAngleRaw = Number(cwk.carrier_angle);
    const cwkLiftAngle = Number.isFinite(cwkAngleRaw) && Math.abs(cwkAngleRaw) > 0.01
        ? Math.max(0, Math.min(90, cwkAngleRaw))
        : cwkCarrierValue === 3 ? 68 : (cwkCarrierValue === 4 || cwkCarrierValue === 5) ? 38 : 0;
    const cwkCarrierColor = !live ? c.line2 : cwkFault ? A.crit : cwkCarrierValue === 4 || cwkCarrierValue === 5 ? A.info : cwkWorking ? A.warn : c.txt2;
    const cwkSlideOffset = cwkSlideValue === 3 ? 14 : cwkSlideValue === 4 ? -8 : cwkSlideValue === 2 ? -4 : 0;
    const cwkMoving = cwkCarrierValue === 4 || cwkCarrierValue === 5 || cwkSlideValue === 3 || cwkSlideValue === 4;
    const slipInRaw = acs.slip_in ?? raw.slips_in ?? raw.slips?.in ?? d.slips_in;
    const slipOutRaw = acs.slip_out ?? raw.slips_out ?? raw.slips?.out ?? d.slips_out;
    const slipStatusRaw = raw.slip_status ?? raw.slips?.status ?? d.slip_status;
    const slipInActive = slipInRaw === true || num(slipInRaw) === 1 || String(slipInRaw || '').toUpperCase() === 'IN';
    const slipOutActive = slipOutRaw === true || num(slipOutRaw) === 1 || String(slipOutRaw || '').toUpperCase() === 'OUT';
    const slipsIn = slipInActive || (!slipOutActive && (slipStatusRaw === true || num(slipStatusRaw) === 1 || String(slipStatusRaw || '').toUpperCase() === 'IN'));
    const slipStat = live
        ? { text: slipsIn ? 'SLIP IN' : 'SLIP OUT', color: slipsIn ? A.ok : A.warn }
        : { text: 'NO DATA', color: c.line2 };
const overviewScale = overviewScaleForWidth(viewportWidth);
const compactOverview = viewportWidth < 1500;
const overviewLayout = compactOverview
    ? { bodyGap: 12, bodyPad: 12, stringW: 132, workoverBasis: 745, rightBasis: 520, equipW: 202, mastMinW: 250, rigGap: 8, cardPad: '10px 10px 13px', cardTitleFont: 15, paramTopGap: 10, paramGap: '10px 10px', paramGrid: '1fr 1fr', paramLabelFont: 10.2, paramValueFont: 22, paramBlockValueFont: 28, paramUnitFont: 10.5, paramBlockUnitFont: 12, gaugePad: '9px 8px', gaugeSize: 154, gaugeHeight: 129, gaugeValueTop: 79, gaugeUnitTop: 102, gaugeValue: 25, gaugeValueSmall: 21, gaugeUnitFont: 10 }
    : { bodyGap: 16, bodyPad: 16, stringW: 150, workoverBasis: 620, rightBasis: 560, equipW: 220, mastMinW: 350, rigGap: 10, cardPad: '11px 12px 14px', cardTitleFont: 16, paramTopGap: 12, paramGap: '11px 12px', paramGrid: '1fr 1fr', paramLabelFont: 11, paramValueFont: 24, paramBlockValueFont: 30, paramUnitFont: 11, paramBlockUnitFont: 12.5, gaugePad: '10px 12px', gaugeSize: 188, gaugeHeight: 158, gaugeValueTop: 98, gaugeUnitTop: 125, gaugeValue: 29, gaugeValueSmall: 24, gaugeUnitFont: 11 };
const overviewBodyMinHeight = Math.max(compactOverview ? 780 : 830, Math.round((viewportHeight - 96) / overviewScale));
const workoverRigMinHeight = Math.max(compactOverview ? 635 : 685, overviewBodyMinHeight - 108);
const primaryPanelHeight = Math.round(overviewBodyMinHeight * (compactOverview ? 0.47 : 0.45));
    const scaledContentStyle = overviewScale < 1
        ? { zoom: overviewScale, minWidth: 1500 }
        : {};

    return (
        <div style={{ background: c.bg, color: c.txt, fontFamily: SANS, minHeight: '100%', margin: -24, display: 'flex', flexDirection: 'column', overflowX: 'auto' }}>
            <style>{`@keyframes annScroll{0%{transform:translateY(0)}100%{transform:translateY(-50%)}}@keyframes pulseDot{0%,100%{opacity:1}50%{opacity:.2}}@keyframes rigFlow{0%{stroke-dashoffset:0}100%{stroke-dashoffset:-10}}`}</style>
            <div style={scaledContentStyle}>

            {/* Brand / rig / well / activity / LIVE all live in the app top bar (Layout.jsx). */}

            {/* ---- annunciator ticker ---- */}
            <div onClick={() => navigate('/alarms')} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/alarms'); }}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'stretch', borderBottom: `1px solid ${c.line}`, background: c.bg2 }}>
                <div style={{ flex: 'none', width: 158, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, padding: '8px 16px', borderRight: `1px solid ${c.line}`, background: c.bg3 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', color: A.warn }}>ANNUNCIATOR</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: c.txt3 }}>{activeCount} active - view all {'>'}</span>
                </div>
                <div style={{ flex: 1, minWidth: 0, height: 56, overflow: 'hidden', position: 'relative' }}>
                    {ticker.length ? (
                        <div style={{ animation: 'annScroll 22s linear infinite' }}>
                            {ticker.map((a, i) => (
                                <div key={`${a.id}-${i}`} style={{ height: 28, display: 'flex', alignItems: 'center', gap: 11, padding: '0 16px', borderBottom: `1px solid ${c.line}` }}>
                                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: a.sevColor, flex: 'none', boxShadow: `0 0 6px ${a.sevColor}` }} />
                                    <span style={{ fontFamily: MONO, fontSize: 11, color: c.txt3, flex: 'none' }}>{a.time}</span>
                                    <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: a.sevColor, flex: 'none', width: 96 }}>{a.tag}</span>
                                    <span style={{ fontSize: 12, color: c.txt2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.msg}</span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div style={{ height: '100%', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 10 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: A.ok }} />
                            <span style={{ fontSize: 12, color: c.txt2, fontWeight: 600 }}>No active alarms</span>
                        </div>
                    )}
                </div>
            </div>

            {/* ---- body ---- */}
            <div style={{ display: 'flex', gap: overviewLayout.bodyGap, padding: overviewLayout.bodyPad, alignItems: 'stretch', flexWrap: 'wrap', minHeight: overviewBodyMinHeight }}>

                {/* STRING & ACTIVITY */}
                <div style={{ flex: `0 0 ${overviewLayout.stringW}px`, display: 'flex', flexDirection: 'column', minHeight: overviewBodyMinHeight }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', ...card, padding: '12px 12px 18px' }}>
                        <span style={{ ...sectionLabel, marginBottom: 10 }}>STRING &amp; ACTIVITY</span>

                        {/* Current workover activity (server-detected) */}
                        <div onClick={() => navigate('/activity')} role="button" tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/activity'); }}
                            title="Open activity log"
                            style={{ cursor: 'pointer', border: `1px solid ${c.line}`, borderRadius: 8, padding: '10px 11px', background: c.bg3, marginBottom: 10 }}>
                            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: c.txt3 }}>CURRENT ACTIVITY</div>
                            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: '.02em', marginTop: 3, color: live ? (ACT_COLOR[act.code] || c.txt) : c.txt3 }}>
                                {live ? (act.label || act.code || 'UNKNOWN').toUpperCase() : 'NO DATA'}
                            </div>
                            <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                {act.npt ? <span style={{ fontSize: 8, fontWeight: 800, color: A.crit, border: `1px solid ${A.crit}`, borderRadius: 4, padding: '1px 5px' }}>NPT - {String(act.npt).toUpperCase()}</span> : null}
                                {act.productive === false && !act.npt ? <span style={{ fontSize: 8, fontWeight: 800, color: A.warn }}>NON-PRODUCTIVE</span> : null}
                                {act.source ? <span style={{ fontSize: 8, color: c.txt3 }}>{act.source}</span> : null}
                            </div>
                        </div>

                        {/* String depth vs total depth */}
                        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                            <div style={{ flex: 1, border: `1px solid ${c.line}`, borderRadius: 7, padding: '8px 9px', background: c.bg2 }}>
                                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', color: c.txt3 }}>STRING</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}><span style={{ fontFamily: VALUE_FONT, fontSize: 20, fontWeight: 800, lineHeight: 1, color: A.a1 }}>{sv(stringDepth, 0)}</span><span style={{ fontSize: 9, color: c.txt3 }}>m</span></div>
                            </div>
                            <div style={{ flex: 1, border: `1px solid ${c.line}`, borderRadius: 7, padding: '8px 9px', background: c.bg2 }}>
                                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', color: c.txt3 }}>TOTAL</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}><span style={{ fontFamily: VALUE_FONT, fontSize: 20, fontWeight: 800, lineHeight: 1, color: c.txt }}>{sv(holeDepth, 0)}</span><span style={{ fontSize: 9, color: c.txt3 }}>m</span></div>
                            </div>
                        </div>

                        {/* Pipe / tubing depth track -- vertical section of the well
                            showing how much string is in the hole right now. */}
                        <div style={{ position: 'relative', flex: 1, minHeight: 210, marginBottom: 12, border: `1px solid ${c.line}`, borderRadius: 8, background: c.bg3, overflow: 'hidden' }}>
                            {(() => {
                                const scaleTd = Math.max(holeDepth, stringDepth, 1);
                                const pipePct = clamp01(stringDepth / scaleTd) * 100;
                                const holePct = clamp01(holeDepth / scaleTd) * 100;
                                // Depth gridlines every 25% of the well.
                                const grid = [0.25, 0.5, 0.75].map((f) => ({ f, d: scaleTd * f }));
                                return (
                                    <>
                                        {/* casing / open hole */}
                                        <div style={{ position: 'absolute', left: '50%', top: 0, height: `${holePct}%`, width: 26, transform: 'translateX(-50%)', background: `${A.info}14`, borderLeft: `2px solid ${A.info}66`, borderRight: `2px solid ${A.info}66` }} />
                                        {/* depth gridlines */}
                                        {grid.map((g) => (
                                            <div key={g.f} style={{ position: 'absolute', left: 0, right: 0, top: `${g.f * 100}%`, borderTop: `1px dashed ${c.line}` }}>
                <span style={{ position: 'absolute', right: 3, top: 1, fontFamily: VALUE_FONT, fontSize: 7.5, color: c.txt3 }}>{Math.round(g.d)}m</span>
                                            </div>
                                        ))}
                                        {/* the pipe/tubing string in the hole */}
                                        <div style={{ position: 'absolute', left: '50%', top: 0, height: live ? `${pipePct}%` : 0, width: 7, transform: 'translateX(-50%)', background: `linear-gradient(180deg, ${A.a1}, ${A.a1}bb)`, borderRadius: '0 0 2px 2px', transition: 'height .8s linear' }} />
                                        {/* string shoe / end-of-pipe marker */}
                                        {live && (
                                            <div style={{ position: 'absolute', left: 0, right: 0, top: `${pipePct}%`, transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px', transition: 'top .8s linear' }}>
                                                <span style={{ flex: 1, height: 2, background: A.a1, boxShadow: `0 0 8px ${A.a1}` }} />
                                                <span style={{ width: 10, height: 10, borderRadius: '50%', background: A.a1, boxShadow: `0 0 10px ${A.a1}`, flex: 'none' }} />
                                            </div>
                                        )}
                                        {/* labels */}
                <span style={{ position: 'absolute', left: 5, top: 4, fontFamily: VALUE_FONT, fontSize: 8, fontWeight: 700, color: c.txt3 }}>SURFACE 0m</span>
                    <span style={{ position: 'absolute', left: 5, top: `${pipePct}%`, transform: 'translateY(-50%) translateY(-11px)', fontFamily: VALUE_FONT, fontSize: 9.5, fontWeight: 800, color: A.a1 }}>
                                            PIPE {sv(stringDepth, 0)}m
                                        </span>
                                        <div style={{ position: 'absolute', left: 0, right: 0, top: `${holePct}%`, transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', padding: '0 4px' }}>
                                            <span style={{ flex: 1, height: 1, background: A.info, opacity: 0.65 }} />
                                        </div>
                    <span style={{ position: 'absolute', left: 5, top: `${holePct}%`, transform: 'translateY(-50%) translateY(9px)', fontFamily: VALUE_FONT, fontSize: 8, fontWeight: 700, color: A.info }}>
                                            TD {sv(holeDepth, 0)}m
                                        </span>
                                    </>
                                );
                            })()}
                        </div>

                        {/* Connections (torque-turn) */}
                        <div onClick={() => navigate('/workover')} role="button" tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/workover'); }}
                            title="Open workover / connections"
                            style={{ cursor: 'pointer', border: `1px solid ${c.line}`, borderRadius: 8, padding: '9px 10px', background: c.bg2, marginBottom: 10 }}>
                            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: c.txt3, marginBottom: 5 }}>CONNECTIONS</div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 8px' }}>
                                <div>
                                    <div style={{ fontSize: 8, fontWeight: 700, color: c.txt3 }}>TORQUE-TURN</div>
                                    <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 800, color: tt.active ? A.ok : c.txt3 }}>{tt.active ? 'ACTIVE' : 'IDLE'}</div>
                                </div>
                                <div>
                                    <div style={{ fontSize: 8, fontWeight: 700, color: c.txt3 }}>LAST MAKE-UP</div>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
                    <span style={{ fontFamily: VALUE_FONT, fontSize: 14, fontWeight: 800, color: A.b1 }}>{sv(pct.last_makeup_torque, 0)}</span>
                                        <span style={{ fontSize: 8, color: c.txt3 }}>daN-m</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                    </div>
                </div>

                {/* RIG FLOOR & EQUIPMENT */}
                <div style={{ flex: `1.12 1 ${overviewLayout.workoverBasis}px`, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: overviewBodyMinHeight }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', ...card, overflow: 'hidden', paddingBottom: 10 }}>
                        <span style={{ ...sectionLabel, fontSize: 13, padding: '12px 14px 3px' }}>WORKOVER RIG &amp; EQUIPMENT</span>
                        <div style={{ display: 'flex', gap: overviewLayout.rigGap, flex: 1, minHeight: workoverRigMinHeight, padding: '8px 10px 13px', alignItems: 'stretch' }}>
                            {/* Left equipment column */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 11, justifyContent: 'space-between', flex: `0 0 ${overviewLayout.equipW}px`, minWidth: 0 }}>
                                {equipment.filter((e) => e.side === 'l').map(EquipCard)}
                            </div>

                            {/* Centre: telescoping guyed workover mast */}
                            <div style={{ position: 'relative', flex: '2.2 1 0', minWidth: overviewLayout.mastMinW }}>
                                <svg viewBox="8 0 84 145" preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                                    <defs>
                                        <filter id="rigLiveGlow" x="-40%" y="-40%" width="180%" height="180%">
                                            <feDropShadow dx="0" dy="0" stdDeviation="1.1" floodColor={A.a1} floodOpacity="0.75" />
                                        </filter>
                                        <filter id="rigStatusGlow" x="-40%" y="-40%" width="180%" height="180%">
                                            <feDropShadow dx="0" dy="0" stdDeviation="0.9" floodColor={A.ok} floodOpacity="0.65" />
                                        </filter>
                                        <filter id="pctGlow" x="-45%" y="-45%" width="190%" height="190%">
                                            <feDropShadow dx="0" dy="0" stdDeviation="1.25" floodColor={pctAccent} floodOpacity="0.85" />
                                        </filter>
                                        <linearGradient id="mastSteel" x1="0" y1="0" x2="1" y2="1">
                                            <stop offset="0%" stopColor="#475569" />
                                            <stop offset="48%" stopColor="#1f2937" />
                                            <stop offset="100%" stopColor="#64748b" />
                                        </linearGradient>
                                        <linearGradient id="floorSteel" x1="0" y1="0" x2="1" y2="0">
                                            <stop offset="0%" stopColor="#111827" />
                                            <stop offset="50%" stopColor="#334155" />
                                            <stop offset="100%" stopColor="#111827" />
                                        </linearGradient>
                                        <radialGradient id="rigPanelWash" cx="50%" cy="53%" r="58%">
                                            <stop offset="0%" stopColor="#164e63" stopOpacity="0.22" />
                                            <stop offset="60%" stopColor="#0f172a" stopOpacity="0.08" />
                                            <stop offset="100%" stopColor="#020617" stopOpacity="0" />
                                        </radialGradient>
                                        <linearGradient id="travellingBlockFill" x1="0" y1="0" x2="1" y2="1">
                                            <stop offset="0%" stopColor="#fbbf24" />
                                            <stop offset="100%" stopColor="#fb923c" />
                                        </linearGradient>
                                    </defs>
                                    <rect x="8" y="1" width="84" height="142" rx="2" fill="url(#rigPanelWash)" />
                                    <path d="M50 10 L86 118 H14 Z" fill="#0f172a" opacity="0.16" stroke={A.info} strokeWidth="0.35" strokeDasharray="2.4 2.1" />
                                    {/* ground + rig floor + substructure */}
                                    <line x1="6" y1="118" x2="94" y2="118" stroke={c.line2} strokeWidth="1.15" />
                                    <polygon points="37,108 63,108 60,118 40,118" fill="url(#floorSteel)" stroke={c.line2} strokeWidth="0.85" />
                                    <rect x="34" y="103" width="32" height="5" rx="0.6" fill="url(#floorSteel)" stroke={c.line2} strokeWidth="0.95" />

                                    {/* guy lines + ground anchors (guyed mast, not a lattice derrick) */}
                                    <line x1="46.5" y1="46" x2="15" y2="118" stroke={c.line} strokeWidth="0.65" strokeDasharray="2 1.5" />
                                    <line x1="53.5" y1="46" x2="85" y2="118" stroke={c.line} strokeWidth="0.65" strokeDasharray="2 1.5" />
                                    <polygon points="13,118 17,118 15,114.5" fill={c.line2} />
                                    <polygon points="83,118 87,118 85,114.5" fill={c.line2} />

                                    {/* mast: outer (lower) section */}
                                    <line x1="41" y1="103" x2="44.5" y2="60" stroke="url(#mastSteel)" strokeWidth="2.25" />
                                    <line x1="59" y1="103" x2="55.5" y2="60" stroke="url(#mastSteel)" strokeWidth="2.25" />
                                    {/* telescoping splice */}
                                    <rect x="43" y="56.5" width="14" height="3.5" rx="0.6" fill="url(#floorSteel)" stroke={c.txt3} strokeWidth="0.7" />
                                    <text x="58.5" y="59.4" fontSize="3" fontWeight="700" fill={c.txt3} fontFamily={MONO}>TELESCOPING</text>
                                    {/* mast: inner (upper) section */}
                                    <line x1="45.5" y1="56.5" x2="47" y2="15" stroke="url(#mastSteel)" strokeWidth="1.75" />
                                    <line x1="54.5" y1="56.5" x2="53" y2="15" stroke="url(#mastSteel)" strokeWidth="1.75" />

                                    {/* crown block */}
                                    <rect x="43" y="9.5" width="14" height="5.5" rx="1" fill="url(#floorSteel)" stroke={c.txt3} strokeWidth="0.85" />
                                    <circle cx="46.8" cy="12.2" r="1.1" fill={c.txt3} />
                                    <circle cx="53.2" cy="12.2" r="1.1" fill={c.txt3} />
                                    <text x="41.5" y="13" fontSize="3.1" fontWeight="700" textAnchor="end" fill={c.txt3} fontFamily={MONO}>CROWN</text>

                                    {/* block position text follows the calibrated mast height: 0 mm floor/pink, 500 mm floor/yellow, 15000 mm crown */}
                    <text x="40.2" y={(elevatorY + 3.0).toFixed(1)} fontSize="3.05" fontWeight="900" textAnchor="end" fill={A.a1} fontFamily={VALUE_FONT}>{live ? `${fmt(blockMm, 0)} mm` : '--'}</text>

                                    {/* hydraulic top drive (HTD) hanging under the block */}
                                    <rect x="45" y={htdY.toFixed(1)} width="10" height="6.5" rx="0.8" fill={c.bg3} stroke={htdStat.color} strokeWidth="1.05" filter={live ? 'url(#rigStatusGlow)' : undefined} />
                                    <text x="50" y={(htdY + 4.2).toFixed(1)} fontSize="2.8" textAnchor="middle" fontWeight="800" fill={htdStat.color} fontFamily={MONO}>HTD</text>
                                    {/* front-layer green hoist lines from crown dots to HTD */}
                                    <line x1="46.8" y1="12.2" x2="46.8" y2={htdY.toFixed(1)} stroke="#22ff66" strokeWidth="0.35" opacity="1" />
                                    <line x1="53.2" y1="12.2" x2="53.2" y2={htdY.toFixed(1)} stroke="#22ff66" strokeWidth="0.35" opacity="1" />
                                    {/* elevator links + elevator */}
                                    <line x1="46.5" y1={(htdY + 6.5).toFixed(1)} x2="46.5" y2={elevatorY.toFixed(1)} stroke={c.txt3} strokeWidth="0.5" />
                                    <line x1="53.5" y1={(htdY + 6.5).toFixed(1)} x2="53.5" y2={elevatorY.toFixed(1)} stroke={c.txt3} strokeWidth="0.5" />
                                    <rect x="41.6" y={elevatorY.toFixed(1)} width="16.8" height="4.8" rx="0.8" fill={live ? `${elevStat.color}24` : c.bg3} stroke={elevStat.color} strokeWidth="1.05" filter={live ? 'url(#rigStatusGlow)' : undefined} />
                                    <text x="50" y={(elevatorY + 2.05).toFixed(1)} fontSize="1.8" textAnchor="middle" fontWeight="800" fill={elevStat.color} fontFamily={MONO}>ELEVATOR</text>
                                    <text x="50" y={(elevatorY + 4.1).toFixed(1)} fontSize="1.8" textAnchor="middle" fontWeight="800" fill={elevStat.color} fontFamily={MONO}>{live ? elevStat.text : 'NO DATA'}</text>

                                    {/* tubing string from elevator down through the floor */}
                                    <line x1="50" y1={(elevatorY + 4.8).toFixed(1)} x2="50" y2="118" stroke={A.a2} strokeWidth="1.2" opacity="0.9" strokeDasharray="6 4" filter={live ? 'url(#rigLiveGlow)' : undefined} style={{ animation: live ? 'rigFlow 1.25s linear infinite' : undefined }} />

                                    {/* PCT body follows active position: full stack only at CTR, single block at WORK/PARK. */}
                                    {pctAssemblyVisible && (
                                        <g>
                                            {pctDollyCenter ? (
                                                <>
                                                    <rect x={pctAssemblyX.toFixed(1)} y={pctAssemblyY.toFixed(1)} width={pctAssemblyW} height={pctAssemblyH} rx="1.2" fill={c.bg3} stroke={pctTongColor} strokeWidth="1.1" filter="url(#pctGlow)" />
                                                    {pctSubsystems.map((item, idx) => {
                                                        const color = item.stat.color;
                                                        const y = pctAssemblyY + idx * pctSectionH;
                                                        return (
                                                            <g key={item.key}>
                                                                {idx > 0 && <line x1={pctAssemblyX.toFixed(1)} y1={y.toFixed(2)} x2={(pctAssemblyX + pctAssemblyW).toFixed(1)} y2={y.toFixed(2)} stroke={pctTongColor} strokeWidth="0.45" />}
                                                                <rect x={(pctAssemblyX + 0.4).toFixed(1)} y={(y + 0.25).toFixed(2)} width={pctAssemblyW - 0.8} height={pctSectionH - 0.5} rx="0.7" fill={`${color}22`} stroke="none" />
                                                                <text x={(pctAssemblyX + pctAssemblyW / 2).toFixed(1)} y={(y + 2.85).toFixed(2)} fontSize="2.05" textAnchor="middle" fontWeight="900" fill={color} fontFamily={MONO}>{item.label}</text>
                                                                <text x={(pctAssemblyX + pctAssemblyW / 2).toFixed(1)} y={(y + 5.4).toFixed(2)} fontSize="1.65" textAnchor="middle" fontWeight="900" fill={color} fontFamily={MONO}>{item.stat.text}</text>
                                                            </g>
                                                        );
                                                    })}
                                                </>
                                            ) : (
                                                <>
                                                    <rect x={pctAssemblyX.toFixed(1)} y={pctCompactY.toFixed(1)} width={pctAssemblyW} height="5" rx="0.8" fill={c.bg3} stroke={pctTongColor} strokeWidth="1.15" filter="url(#pctGlow)" />
                                                    <text x={(pctAssemblyX + pctAssemblyW / 2).toFixed(1)} y={(pctCompactY + 3.8).toFixed(1)} fontSize="3.1" textAnchor="middle" fontWeight="900" fill={pctTongColor} fontFamily={MONO}>PCT</text>
                                                    <text x={(pctAssemblyX + pctAssemblyW / 2).toFixed(1)} y={(pctCompactY + 7.8).toFixed(1)} fontSize="2.6" textAnchor="middle" fontWeight="900" fill={pctTongColor} fontFamily={MONO}>
                                                        {pctDollyWork || pctDollyMovingWork ? 'WORK' : 'PARK'}
                                                    </text>
                                                </>
                                            )}
                                        </g>
                                    )}

                                    {/* catwalk carrier / slide / clamp assembly */}
                                    <g transform={`rotate(${cwkLiftAngle} 34 111)`} style={{ transition: 'transform .9s ease-in-out' }}>
                                        <polygon points="1,115 6,112.5 29,112.5 34,110.2 36.5,111.8 33.8,114.6 7,117.2" fill={c.bg3} stroke={cwkCarrierColor} strokeWidth="0.75" />
                                        <line x1="7.5" y1="114.7" x2="28" y2="114.7" stroke={cwkSlideStat.color} strokeWidth="0.85" strokeLinecap="round" />
                                        <g transform={`translate(${cwkSlideOffset} 0)`} style={{ transition: 'transform .7s ease-in-out' }}>
                                            <rect x="8.5" y="113.5" width="11.5" height="2.1" rx="0.45" fill={live ? `${cwkSlideStat.color}35` : c.bg2} stroke={cwkSlideStat.color} strokeWidth="0.55" />
                                            {(cwkSlideValue === 3 || cwkSlideValue === 4) && (
                                                <path d={cwkSlideValue === 3 ? 'M21 114.55 L25 112.9 L25 116.2 Z' : 'M7.5 114.55 L3.5 112.9 L3.5 116.2 Z'} fill={cwkSlideStat.color} opacity="0.9" />
                                            )}
                                        </g>
                                        <rect x="28" y="110.7" width="4.5" height="5.2" rx="0.55" fill={live ? `${cwkClampStat.color}30` : c.bg2} stroke={cwkClampStat.color} strokeWidth="0.8" />
                                        <text x="16.5" y="111.4" fontSize="2.05" textAnchor="middle" fontWeight="900" fill={cwkCarrierColor} fontFamily={MONO}>CARRIER</text>
                                        <text x="16.5" y="119.2" fontSize="2" textAnchor="middle" fontWeight="900" fill={cwkSlideStat.color} fontFamily={MONO}>{cwkSlideValue === 3 ? 'SLIDE FWD' : cwkSlideValue === 4 ? 'SLIDE BWD' : 'SLIDE'}</text>
                                        <text x="30.2" y="109.7" fontSize="1.8" textAnchor="middle" fontWeight="900" fill={cwkClampStat.color} fontFamily={MONO}>CLAMP</text>
                                        {cwkMoving && <circle cx="4.2" cy="113.4" r="1.15" fill={A.info} opacity="0.95" style={{ animation: 'pulseDot 1s ease-in-out infinite' }} />}
                                    </g>

                                    {/* slips status at rotary/floor area */}
                                    <text x="50" y="114.6" fontSize="2.8" textAnchor="middle" fontWeight="900" fill={slipStat.color} fontFamily={MONO}>{slipStat.text}</text>

                                    {/* wellhead: casing head + tubing head + wing valves */}
                                    <rect x="44" y="118" width="12" height="4.4" rx="0.6" fill={c.bg3} stroke={c.line2} strokeWidth="0.8" />
                                    <text x="57.5" y="121.4" fontSize="2.6" fontWeight="700" fill={c.txt3} fontFamily={MONO}>TUBING HEAD</text>
                                    <rect x="42.5" y="122.4" width="15" height="4.6" rx="0.6" fill={c.bg3} stroke={c.line2} strokeWidth="0.8" />
                                    <text x="59" y="125.8" fontSize="2.6" fontWeight="700" fill={c.txt3} fontFamily={MONO}>CASING HEAD</text>
                                    {/* wing valves */}
                                    <rect x="38.5" y="123.2" width="4" height="3" fill={c.bg3} stroke={c.line2} strokeWidth="0.6" />
                                    <rect x="57.5" y="123.2" width="4" height="3" fill={c.bg3} stroke={c.line2} strokeWidth="0.6" />
                                    <text x="50" y="131" fontSize="2.8" textAnchor="middle" fontWeight="800" fill={c.txt2} fontFamily={MONO}>
                                        TBG {wh.tubing_pressure != null && live ? `${fmt(wh.tubing_pressure, 0)}` : '--'} / CSG {wh.casing_pressure != null && live ? `${fmt(wh.casing_pressure, 0)}` : '--'} bar
                                    </text>

                                    {/* BOP / annular -- only drawn when a real source exists */}
                                    {wcLive ? (
                                        <>
                                            <rect x="43" y="133" width="14" height="4.6" rx="2" fill={rams[0].state === 'CLOSED' ? A.crit : 'transparent'} stroke={c.line2} strokeWidth="0.8" />
                                            <text x="50" y="136.3" fontSize="2.5" textAnchor="middle" fontWeight="800" fill={c.txt} fontFamily={MONO}>ANNULAR</text>
                                            <rect x="44" y="138" width="12" height="4.2" rx="0.8" fill={rams[1].state === 'CLOSED' ? A.crit : 'transparent'} stroke={c.line2} strokeWidth="0.8" />
                                            <text x="50" y="141" fontSize="2.4" textAnchor="middle" fontWeight="800" fill={c.txt} fontFamily={MONO}>PIPE</text>
                                        </>
                                    ) : (
                                        <>
                                            <rect x="43" y="133" width="14" height="9.2" rx="1" fill="none" stroke={c.line2} strokeWidth="0.7" strokeDasharray="1.5 1.5" />
                                            <text x="50" y="138.6" fontSize="2.4" textAnchor="middle" fontWeight="800" fill={c.txt3} fontFamily={MONO}>NO BOP SOURCE</text>
                                        </>
                                    )}
                                </svg>
                                <div style={{ position: 'absolute', left: '50%', bottom: 2, transform: 'translateX(-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                                    <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.18em', color: c.txt3, opacity: .6 }}>WORKOVER MAST - ACS ENVELOPE</div>
                                </div>
                            </div>

                            {/* Right equipment column */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 11, justifyContent: 'space-between', flex: `0 0 ${overviewLayout.equipW}px`, minWidth: 0 }}>
                                {equipment.filter((e) => e.side === 'r').map(EquipCard)}
                            </div>
                        </div>
                    </div>

                    {/* Well-control bar */}
                    <div onClick={() => navigate('/wellcontrol')} role="button" tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/wellcontrol'); }}
                        title="Open well control"
                        style={{ marginTop: 14, ...card, padding: '12px 16px 18px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', cursor: 'pointer' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: wcStat.color, boxShadow: `0 0 6px ${wcStat.color}` }} />
                            <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.1em', color: c.txt }}>WELL CONTROL</span>
                            <span style={{ fontSize: 10, fontWeight: 700, color: wcStat.color }}>{wcStat.text}</span>
                        </span>
                        <span style={{ width: 1, height: 26, background: c.line2 }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                            {[
                                { k: 'ACCUM', v: wcv(wc.accumulator_pressure, 0), u: 'psi', dk: 'well_control.accumulator_pressure' },
                                { k: 'ANNULAR', v: wcv(wc.annular_pressure, 0), u: 'psi' },
                                { k: 'MANIFOLD', v: wcv(wc.manifold_pressure, 0), u: 'psi' },
                                { k: 'TUBING', v: sv(wh.tubing_pressure, 1), u: 'bar', dk: 'wellhead.tubing_pressure' },
                                { k: 'CASING', v: sv(wh.casing_pressure, 1), u: 'bar', dk: 'wellhead.casing_pressure' },
                            ].map((p) => {
                                const pa = alarmFor(p.dk);
                                return (
                                    <span key={p.k} style={{ display: 'flex', flexDirection: 'column', gap: 2, animation: blinkAnim(pa) }}>
                                        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.1em', color: pa ? pa.color : c.txt3 }}>{p.k}{pa ? ` - ${pa.condition}` : ''}</span>
                                        <span style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
                                            <span style={{ fontFamily: VALUE_FONT, fontSize: 17, fontWeight: 800, lineHeight: 1, color: pa ? pa.color : A.info }}>{p.v}</span>
                                            <span style={{ fontSize: 8, color: c.txt3 }}>{p.u}</span>
                                        </span>
                                    </span>
                                );
                            })}
                        </div>
                        <span style={{ width: 1, height: 26, background: c.line2 }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            {rams.map((r) => {
                                const col = r.state === 'CLOSED' ? A.crit : r.state === 'OPEN' ? '#7c8aa0' : c.txt3;
                                return (
                                    <span key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, background: c.bg3, border: `1px solid ${c.line}` }}>
                                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: col, boxShadow: `0 0 5px ${col}` }} />
                                        <span style={{ fontSize: 9, fontWeight: 700, color: c.txt2 }}>{r.name}</span>
                                        <span style={{ fontSize: 9, fontWeight: 800, color: col }}>{r.state}</span>
                                    </span>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* PRIMARY INSTRUMENTS + TRENDS */}
                <div style={{ flex: `1 1 ${overviewLayout.rightBasis}px`, display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0, minHeight: overviewBodyMinHeight }}>
                    <div style={{ ...card, padding: '13px 14px 18px', flex: `0 0 ${primaryPanelHeight}px` }}>
                        <span style={sectionLabel}>PRIMARY INSTRUMENTS</span>
                        <div style={{ display: 'flex', gap: 12, marginTop: 11, flexWrap: 'wrap' }}>
                            {gauges.map((g) => <Gauge key={g.label} g={g} />)}
                        </div>
                    </div>

                    <div style={{ ...card, padding: '13px 14px 18px', flex: 1, minHeight: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                            <span style={sectionLabel}>LAST 12H TRENDS</span>
                            <FormControl size="small">
                                <Select
                                    multiple
                                    displayEmpty
                                    open={trendSelectorOpen}
                                    onOpen={() => setTrendSelectorOpen(true)}
                                    onClose={() => setTrendSelectorOpen(false)}
                                    value={selectedTrendIds}
                                    onChange={handleTrendSelection}
                                    IconComponent={() => null}
                                    inputProps={{ 'aria-label': 'Select trend parameters', title: 'Select trend parameters' }}
                                    renderValue={() => <SlidersHorizontal size={15} color={c.txt2} />}
                                    MenuProps={{ PaperProps: { sx: { maxHeight: 410, minWidth: 280, bgcolor: c.bg2, color: c.txt } } }}
                                    sx={{
                                        color: c.txt,
                                        bgcolor: c.bg3,
                                        '& .MuiSelect-select': { py: '5px', px: '9px' },
                                        '& .MuiOutlinedInput-notchedOutline': { borderColor: c.line },
                                        '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: ACCENT.info }
                                    }}
                                >
                                    <ListSubheader sx={{ bgcolor: c.bg2, color: c.txt2, fontWeight: 800, fontSize: 10, lineHeight: '28px', letterSpacing: '.06em' }}>
                                        PICK PARAMETERS ({selectedTrendIds.length})
                                    </ListSubheader>
                                    {TREND_GROUPS.flatMap((group) => [
                                        <ListSubheader key={`group-${group.id}`} sx={{ bgcolor: c.bg2, color: c.txt2, fontWeight: 900, fontSize: 11, lineHeight: '30px', letterSpacing: '.06em' }}>
                                            {group.label.toUpperCase()}
                                        </ListSubheader>,
                                        ...group.fields.map((definition) => (
                                            <MenuItem key={definition.id} value={definition.id} sx={{ py: 0.25, fontSize: 12 }}>
                                                <Checkbox size="small" checked={selectedTrendIds.includes(definition.id)} sx={{ p: 0.5, mr: 0.5, color: c.txt3, '&.Mui-checked': { color: definition.color } }} />
                                                <span style={{ width: 8, height: 8, flex: 'none', marginRight: 8, borderRadius: 2, background: definition.color }} />
                                                <ListItemText primary={`${definition.label}${definition.unit ? ` (${definition.unit})` : ''}`} primaryTypographyProps={{ sx: { fontSize: 12 } }} />
                                            </MenuItem>
                                        ))
                                    ])}
                                </Select>
                            </FormControl>
                            <span style={{ flex: 1, height: 1, background: c.line }} />
                            <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, color: c.txt3, whiteSpace: 'nowrap' }}>
                                {workingDayLabel} · last 12 hrs
                            </span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: 'calc(100% - 38px)', justifyContent: 'space-between' }}>
                            {trends.map((t) => (
                                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                                    <span style={{ width: 84, flex: 'none', fontSize: 9, fontWeight: 700, letterSpacing: '.06em', color: c.txt2 }}>{t.label}</span>
                                    <div style={{ flex: 1, height: 28, minWidth: 0, borderLeft: `1px solid ${c.line}`, borderRight: `1px solid ${c.line}` }}>
                                        <svg viewBox="0 0 100 24" width="100%" height="100%" preserveAspectRatio="none">
                                            {/* tour midpoint (18:00 IST) for orientation */}
                                            <line x1="50" y1="0" x2="50" y2="24" stroke={c.line} strokeWidth="0.5" />
                                            <path d={t.area} fill={t.color} opacity="0.16" />
                                            <path d={t.line} fill="none" stroke={t.color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                                        </svg>
                                    </div>
                                    <span style={{ width: 62, flex: 'none', textAlign: 'right', fontFamily: VALUE_FONT, fontSize: 14, fontWeight: 800, color: t.color }}>{t.valueStr}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
            </div>
        </div>
    );
}




