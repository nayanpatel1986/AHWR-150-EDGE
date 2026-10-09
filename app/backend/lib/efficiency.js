'use strict';
// Hydraulic efficiency & energy analytics (edge, read-only/derived).
// Computes what the mapped sensors actually support:
//   P_hyd (kW) = p(bar) × Q(l/min) / 600   — exact for the mud circuit (real flow),
//   estimated for HPU/HTD circuits where pump flow is a % of a configurable rated l/min.
//   Rotation mechanical power = T(N·m)·n(rpm)/9550 from htd.torque (daN·m ×10) and htd.rpm.
//   LS margin = HPU discharge − pilot/LS pressure.
//   Specific energy = engine fuel / shaft-energy accrued over the working day, per joint / per metre.
// The cooler heat-balance method (P_loss = K·Q_cooler·ΔT) needs cooler ΔT + flow which are
// NOT mapped — it is surfaced as an instrumentation gap, never fabricated.
const { readJson, writeJson } = require('./persist');

const CONFIG_FILE = 'efficiency_config.json';
const STATE_FILE = 'efficiency_state.json';
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const kW = (bar, lpm) => (bar > 0 && lpm > 0 ? (bar * lpm) / 600 : 0);

const DEFAULTS = {
    engineRatedKw: 800,        // total prime-mover capacity (drives mud pump + HPU pumps)
    htdPumpRatedLpm: 420,      // per HTD main pump at rated rpm (PV270-class); override per rig.
                               // Pumps are sized for the heaviest function, so a single circuit
                               // (rotation) draws a fraction → the excess is LS/metering loss.
    pdwPumpRatedLpm: 200,
    pumpVolEff: 0.95,
    lineLossBar: 10,           // pump→actuator line/valve drop estimate
    coolerOilK: 0.027,         // mineral-oil constant for P_loss = K·Q·ΔT (display only)
};

let config = { ...DEFAULTS, ...(readJson(CONFIG_FILE, {}) || {}) };
let st = readJson(STATE_FILE, null) || null;
let lastMs = null, lastPersist = 0;
let emaMech = null, emaHyd = null, lastInstant = null; // EMA smooths the rotation circuit (noisy/uncoupled signals)
const ema = (prev, x, a = 0.06) => (prev == null ? x : prev + a * (x - prev));

// Instrumentation the analytics would need to go from "estimated" to "exact"/complete.
const INSTRUMENTATION = [
    { item: 'Inline/clamp flow meters (l/min) on main delivery + return header', unlocks: 'Exact circuit flow (HPU/HTD pump flows are % today) → exact circuit η', status: 'recommended' },
    { item: 'Cooler ΔT (inlet/outlet temp) + cooler flow', unlocks: 'Heat-balance system efficiency: P_loss = 0.027·Q·ΔT (Method 2)', status: 'required for heat-balance' },
    { item: 'Torque sub / motor Δp+speed; cylinder load-cell + stroke; winch line-pull + drum rpm', unlocks: 'Circuit η for tong / cylinders / winch (only top-drive rotation is measurable now)', status: 'recommended' },
];

function workingDayStart(nowMs) {
    const d = new Date(nowMs); const s = new Date(d); s.setHours(6, 0, 0, 0);
    if (d.getHours() < 6) s.setDate(s.getDate() - 1);
    return s.getTime();
}
function freshState(nowMs, holeDepth) {
    return { dayStart: workingDayStart(nowMs), fuelLiters: 0, energyKwh: 0, productiveKwh: 0, nptKwh: 0, joints: 0, depthStart: Number.isFinite(holeDepth) ? holeDepth : null, depthLast: Number.isFinite(holeDepth) ? holeDepth : null };
}

// Instant derived metrics from one rig-data snapshot.
function compute(data) {
    data = data || {};
    const mudP = num(data.mudpump?.pressure), mudQ = num(data.mudpump?.flow_in);
    const hydMud = kW(mudP, mudQ);

    const tHtd = num(data.htd?.torque), nHtd = num(data.htd?.rpm);
    const pMechHtd = (Number.isFinite(tHtd) && Number.isFinite(nHtd)) ? (tHtd * 10 * nHtd) / 9550 : 0; // daN·m→N·m
    const p1 = num(data.hpu?.htd_pump1_press), f1 = num(data.hpu?.htd_pump1_flow);
    const p2 = num(data.hpu?.htd_pump2_press), f2 = num(data.hpu?.htd_pump2_flow);
    const q1 = Number.isFinite(f1) ? (f1 / 100) * config.htdPumpRatedLpm : 0;
    const q2 = Number.isFinite(f2) ? (f2 / 100) * config.htdPumpRatedLpm : 0;
    const hydHtd = kW(p1, q1) + kW(p2, q2);
    const etaRot = (hydHtd > 0 && pMechHtd > 0) ? Math.min(1, pMechHtd / hydHtd) : null;

    const pdwP = num(data.hpu?.pdw_pump_press ?? data.hpu?.discharge_pressure), pdwF = num(data.hpu?.pdw_pump_flow);
    const hydPdw = kW(pdwP, Number.isFinite(pdwF) ? (pdwF / 100) * config.pdwPumpRatedLpm : 0);

    const lsMargin = (Number.isFinite(num(data.hpu?.discharge_pressure)) && Number.isFinite(num(data.hpu?.pilot_pressure)))
        ? Number((num(data.hpu.discharge_pressure) - num(data.hpu.pilot_pressure)).toFixed(1)) : null;

    const loadPct = num(data.cat_engine?.load);
    const engineKw = Number.isFinite(loadPct) ? (loadPct / 100) * config.engineRatedKw : null;
    const fuelLph = num(data.cat_engine?.fuel_rate);
    const totalHyd = hydMud + hydHtd + hydPdw;
    const conversion = (engineKw > 0) ? Math.min(1, totalHyd / engineKw) : null; // delivered-hyd ÷ engine shaft

    const r = (x) => (x == null ? null : Number(x.toFixed(1)));
    return {
        _raw: { htdMech: pMechHtd, htdHyd: hydHtd },
        circuits: [
            { id: 'mud', label: 'Mud / circulating pump', hydraulicKw: r(hydMud), usefulKw: null, efficiency: null, status: 'computed', note: 'p×Q, Q = real flow meter (Lt/min)' },
            { id: 'htd_rot', label: 'Top-drive rotation (HTD)', hydraulicKw: r(hydHtd), usefulKw: r(pMechHtd), efficiency: etaRot == null ? null : Number((etaRot * 100).toFixed(1)), status: 'estimated', note: 'mech = T·n/9550; Q from pump % × rated l/min (rolling avg)' },
            { id: 'pdw', label: 'Pulldown / hoist (PDW)', hydraulicKw: r(hydPdw), usefulKw: null, efficiency: null, status: 'estimated', note: 'Q from pump % × rated l/min; add load-cell+stroke for η' },
            { id: 'tong', label: 'Power tong / winch / cylinders', hydraulicKw: null, usefulKw: null, efficiency: null, status: 'needs-instrument', note: 'needs torque-sub / load-cell + velocity' },
        ],
        lsMargin, engineKw: r(engineKw), fuelLph: r(fuelLph),
        totalHydraulicKw: r(totalHyd), conversionPct: conversion == null ? null : Number((conversion * 100).toFixed(1)),
        oilTempC: r(num(data.hpu?.oil_temp)),
        heatBalance: { available: false, oilTempC: r(num(data.hpu?.oil_temp)), formula: 'P_loss (kW) ≈ 0.027 × Q_cooler(l/min) × ΔT(°C)', note: 'requires cooler ΔT + flow instrumentation' },
    };
}

// Accrue working-day energy/fuel/specific-energy. opts.jointMade = a connection completed this tick.
function update(data, nowMs = Date.now(), opts = {}) {
    const inst = compute(data);
    const holeDepth = num(data.drilling?.hole_depth);
    if (!st || st.dayStart !== workingDayStart(nowMs)) st = freshState(nowMs, holeDepth);

    if (lastMs) {
        const dtH = (nowMs - lastMs) / 3600000;
        if (dtH > 0 && dtH < 0.25) {
            if (Number.isFinite(inst.fuelLph)) st.fuelLiters += inst.fuelLph * dtH;
            if (Number.isFinite(inst.engineKw)) {
                st.energyKwh += inst.engineKw * dtH;
                const productive = data._activity ? data._activity.productive !== false : true;
                if (productive) st.productiveKwh += inst.engineKw * dtH; else st.nptKwh += inst.engineKw * dtH;
            }
        }
    }
    lastMs = nowMs;
    if (opts.jointMade) st.joints += 1;
    if (Number.isFinite(holeDepth)) st.depthLast = holeDepth;
    if (nowMs - lastPersist > 30000) { lastPersist = nowMs; writeJson(STATE_FILE, st).catch(() => {}); }

    // Smooth the rotation circuit (torque/rpm/pump-flow are independent signals, so the
    // instantaneous ratio is noisy) and present a stable rolling-average efficiency.
    if (inst._raw) {
        emaMech = ema(emaMech, inst._raw.htdMech);
        emaHyd = ema(emaHyd, inst._raw.htdHyd);
        const rot = inst.circuits.find((c) => c.id === 'htd_rot');
        if (rot) {
            rot.usefulKw = emaMech == null ? null : Number(emaMech.toFixed(1));
            rot.hydraulicKw = emaHyd == null ? null : Number(emaHyd.toFixed(1));
            rot.efficiency = (emaHyd > 0 && emaMech > 0) ? Number(Math.min(100, (emaMech / emaHyd) * 100).toFixed(1)) : null;
        }
    }
    delete inst._raw;
    lastInstant = inst;
    return inst;
}

function getDaily() {
    if (!st) return null;
    const metres = (st.depthStart != null && st.depthLast != null) ? Number((st.depthLast - st.depthStart).toFixed(1)) : null;
    const per = (n, d) => (d && d > 0 ? Number((n / d).toFixed(2)) : null);
    return {
        dayStart: new Date(st.dayStart).toISOString(),
        fuelLiters: Number(st.fuelLiters.toFixed(1)), energyKwh: Number(st.energyKwh.toFixed(1)),
        productiveKwh: Number(st.productiveKwh.toFixed(1)), nptKwh: Number(st.nptKwh.toFixed(1)),
        joints: st.joints, metres,
        litresPerJoint: per(st.fuelLiters, st.joints), kwhPerJoint: per(st.energyKwh, st.joints),
        litresPerMetre: per(st.fuelLiters, metres),
        productiveSharePct: st.energyKwh > 0 ? Number((100 * st.productiveKwh / st.energyKwh).toFixed(0)) : null,
    };
}

const snapshot = (data) => compute(data);
const getConfig = () => ({ ...config });
async function setConfig(next) {
    for (const k of Object.keys(DEFAULTS)) if (k in (next || {}) && Number.isFinite(Number(next[k]))) config[k] = Number(next[k]);
    await writeJson(CONFIG_FILE, config);
    return getConfig();
}
const getFull = (data) => ({ instant: lastInstant || compute(data), daily: getDaily(), config: getConfig(), instrumentation: INSTRUMENTATION });

module.exports = { compute, update, snapshot, getDaily, getConfig, setConfig, getFull, INSTRUMENTATION };
