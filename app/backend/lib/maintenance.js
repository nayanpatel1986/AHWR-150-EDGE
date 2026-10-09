'use strict';
// Maintenance & asset-health: per-asset run-hours (live or derived), preventive-
// maintenance schedule with due/overdue tracking, calibration history, and a
// downtime/failure log with reason codes. State persists under DATA_DIR.
const { readJson, writeJson, resolvePath } = require('./persist');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const nowIso = (ms) => new Date(ms).toISOString();
const today = () => nowIso(Date.now()).slice(0, 10);
let _id = 0;
const uid = (p) => `${p}_${nowIso(Date.now()).replace(/[^0-9]/g, '')}_${++_id}`;

const REASON_CODES = ['MECHANICAL', 'ELECTRICAL', 'HYDRAULIC', 'INSTRUMENTATION', 'WAITING_PARTS', 'SCHEDULED_MAINT', 'OTHER'];

// Asset registry. hoursKey = dotted path to a cumulative run-hours tag (authoritative);
// derived assets accrue demo time while their condition holds.
const ASSETS = [
    { id: 'engine', name: 'CAT Engine', category: 'Power', hoursKey: 'cat_engine.run_hours', health: [['Coolant °C', 'cat_engine.coolant_temp'], ['Oil bar', 'cat_engine.oil_pressure']] },
    { id: 'hpu', name: 'Hydraulic Power Unit', category: 'Hydraulics', hoursKey: 'hpu.run_hours', health: [['Oil Temp °C', 'hpu.oil_temp'], ['Disch bar', 'hpu.discharge_pressure']] },
    { id: 'topdrive', name: 'Top Drive (HTD)', category: 'Rotary', hoursKey: 'htd.working_hours', health: [['RPM', 'htd.rpm'], ['Torque', 'htd.torque']] },
    { id: 'drawworks', name: 'Drawworks', category: 'Hoisting', hoursKey: null, seedHours: 3850, accrue: 'hoisting', health: [['Hook Load t', 'drawworks.hook_load'], ['Rope wear', 'drawworks.rope_wear']] },
    { id: 'mudpump', name: 'Mud Pump', category: 'Circulating', hoursKey: null, seedHours: 3620, accrue: 'pumping', health: [['SPP bar', 'mudpump.pressure'], ['SPM', 'mudpump.spm']] },
];
const ASSET = Object.fromEntries(ASSETS.map((a) => [a.id, a]));

const PM_SEED = [
    { id: 'pm_eng_oil', assetId: 'engine', name: 'Engine Oil & Filter', intervalHours: 250, lastServiceHours: 3980, lastServiceDate: '2026-05-22' },
    { id: 'pm_eng_major', assetId: 'engine', name: 'Engine Major Service', intervalHours: 1000, lastServiceHours: 3600, lastServiceDate: '2026-02-18' },
    { id: 'pm_hpu_filter', assetId: 'hpu', name: 'HPU Hydraulic Filter', intervalHours: 350, lastServiceHours: 2950, lastServiceDate: '2026-03-30' },
    { id: 'pm_td_gear', assetId: 'topdrive', name: 'Top Drive Gearbox Oil', intervalHours: 750, lastServiceHours: 2150, lastServiceDate: '2026-01-15' },
    { id: 'pm_dw_brake', assetId: 'drawworks', name: 'Drawworks Brake Inspection', intervalHours: 200, lastServiceHours: 3680, lastServiceDate: '2026-05-28' },
    { id: 'pm_dw_line', assetId: 'drawworks', name: 'Drill-Line Slip & Cut', intervalHours: 150, lastServiceHours: 3800, lastServiceDate: '2026-06-02' },
    { id: 'pm_mp_liner', assetId: 'mudpump', name: 'Mud Pump Liners & Valves', intervalHours: 300, lastServiceHours: 3300, lastServiceDate: '2026-04-12' },
];

const STATE = 'maintenance_state.json';
const PM = 'maintenance_pm.json';
const CALIB = 'calibration_log.json';
const DOWNTIME = 'downtime_log.json';
const MAX = 5000;

let state = readJson(STATE, null) || { derivedHours: {}, lastTickMs: null };
for (const a of ASSETS) if (!a.hoursKey && state.derivedHours[a.id] == null) state.derivedHours[a.id] = a.seedHours;
let pm = readJson(PM, null); if (!Array.isArray(pm)) { pm = PM_SEED; writeJson(PM, pm).catch(() => {}); }
let calib = readJson(CALIB, null);
let downtime = readJson(DOWNTIME, null);
const lastHours = {}; // assetId -> latest computed cumulative hours

if (!Array.isArray(calib)) {
    calib = [
        { id: uid('cal'), type: 'Weight Indicator', asset: 'drawworks', value: '0 t tare', by: 'seed', ts: nowIso(Date.now() - 86400000 * 2) },
        { id: uid('cal'), type: 'Depth / Block Encoder', asset: 'drawworks', value: '1500.0 m', by: 'seed', ts: nowIso(Date.now() - 86400000) },
    ];
    writeJson(CALIB, calib).catch(() => {});
}
if (!Array.isArray(downtime)) {
    downtime = [
        { id: uid('dt'), assetId: 'mudpump', reasonCode: 'MECHANICAL', severity: 'medium', notes: 'Pump #1 liner wash — changed liner', by: 'seed', start: nowIso(Date.now() - 86400000), end: nowIso(Date.now() - 86400000 + 5400000) },
        { id: uid('dt'), assetId: 'hpu', reasonCode: 'HYDRAULIC', severity: 'low', notes: 'Filter ΔP high — monitoring', by: 'seed', start: nowIso(Date.now() - 3600000), end: null },
    ];
    writeJson(DOWNTIME, downtime).catch(() => {});
}

const persistState = () => writeJson(STATE, state).catch(() => {});
let lastPersist = 0;

function assetHours(a, data) {
    if (a.hoursKey) { const h = num(resolvePath(data, a.hoursKey)); if (Number.isFinite(h)) return h; return lastHours[a.id] || 0; }
    return state.derivedHours[a.id] || a.seedHours || 0;
}

// Accrue derived run-hours and cache current hours each tick.
function updateHours(data, nowMs = Date.now()) {
    if (state.lastTickMs) {
        const dtH = (nowMs - state.lastTickMs) / 3600000;
        if (dtH > 0 && dtH < 0.25) { // ignore large gaps (restart/downtime)
            const spm = num(data.mudpump?.spm);
            const pumping = Number.isFinite(spm) && spm > 10;
            const act = data._activity && data._activity.code;
            const hoisting = act === 'RIH' || act === 'POOH';
            if (pumping) state.derivedHours.mudpump = (state.derivedHours.mudpump || 0) + dtH;
            if (hoisting) state.derivedHours.drawworks = (state.derivedHours.drawworks || 0) + dtH;
        }
    }
    state.lastTickMs = nowMs;
    for (const a of ASSETS) lastHours[a.id] = assetHours(a, data);
    if (nowMs - lastPersist > 30000) { lastPersist = nowMs; persistState(); }
}

function pmStatus(task, hours) {
    const nextHours = task.lastServiceHours + task.intervalHours;
    const dueInHours = Number((nextHours - hours).toFixed(1));
    const status = dueInHours < 0 ? 'overdue' : (dueInHours <= task.intervalHours * 0.2 ? 'due-soon' : 'ok');
    return { ...task, currentHours: Number(hours.toFixed(1)), nextHours: Number(nextHours.toFixed(1)), dueInHours, status };
}
const RANK = { overdue: 0, 'due-soon': 1, ok: 2 };

function getPM(data) {
    const rows = pm.map((t) => pmStatus(t, lastHours[t.assetId] != null ? lastHours[t.assetId] : assetHours(ASSET[t.assetId], data || {})));
    rows.sort((a, b) => RANK[a.status] - RANK[b.status] || a.dueInHours - b.dueInHours);
    return rows;
}

function getSummary(data) {
    const openDt = downtime.filter((d) => !d.end);
    const pmRows = getPM(data);
    const assets = ASSETS.map((a) => {
        const hours = lastHours[a.id] != null ? lastHours[a.id] : assetHours(a, data || {});
        const tasks = pmRows.filter((t) => t.assetId === a.id);
        const worst = tasks.reduce((w, t) => (RANK[t.status] < RANK[w] ? t.status : w), 'ok');
        return {
            id: a.id, name: a.name, category: a.category, hours: Number(hours.toFixed(1)),
            source: a.hoursKey ? 'measured' : 'derived',
            health: a.health.map(([label, key]) => ({ label, value: data ? num(resolvePath(data, key)) : null })),
            pmStatus: tasks.length ? worst : 'ok', pmTasks: tasks.length,
            nextDueInHours: tasks.length ? Math.min(...tasks.map((t) => t.dueInHours)) : null,
            openDowntime: openDt.filter((d) => d.assetId === a.id).length,
        };
    });
    return {
        assets,
        counts: {
            overdue: pmRows.filter((t) => t.status === 'overdue').length,
            dueSoon: pmRows.filter((t) => t.status === 'due-soon').length,
            openDowntime: openDt.length,
        },
    };
}

function serviceTask(id, { hours, date, notes, by } = {}) {
    const t = pm.find((x) => x.id === id);
    if (!t) throw Object.assign(new Error('Unknown PM task'), { status: 404 });
    t.lastServiceHours = Number.isFinite(num(hours)) ? num(hours) : (lastHours[t.assetId] || t.lastServiceHours);
    t.lastServiceDate = date || today();
    if (notes) t.lastServiceNotes = notes;
    writeJson(PM, pm).catch(() => {});
    calib.push({ id: uid('svc'), type: `PM: ${t.name}`, asset: t.assetId, value: `serviced @ ${t.lastServiceHours.toFixed(0)} h`, by: by || 'system', ts: nowIso(Date.now()) });
    if (calib.length > MAX) calib = calib.slice(-MAX);
    writeJson(CALIB, calib).catch(() => {});
    return pmStatus(t, lastHours[t.assetId] || t.lastServiceHours);
}

function logCalibration({ type, asset, value, by }) {
    const rec = { id: uid('cal'), type: type || 'Calibration', asset: asset || null, value: value != null ? String(value) : '', by: by || 'system', ts: nowIso(Date.now()) };
    calib.push(rec); if (calib.length > MAX) calib = calib.slice(-MAX);
    writeJson(CALIB, calib).catch(() => {});
    return rec;
}
const getCalibrations = (limit = 200) => calib.slice(-limit).reverse();

function logDowntime({ assetId, reasonCode, severity, notes, by }) {
    if (!REASON_CODES.includes(reasonCode)) throw Object.assign(new Error('Invalid reason code'), { status: 400 });
    const rec = { id: uid('dt'), assetId: assetId || null, reasonCode, severity: severity || 'medium', notes: notes || '', by: by || 'system', start: nowIso(Date.now()), end: null };
    downtime.push(rec); if (downtime.length > MAX) downtime = downtime.slice(-MAX);
    writeJson(DOWNTIME, downtime).catch(() => {});
    return rec;
}
function closeDowntime(id, { by } = {}) {
    const d = downtime.find((x) => x.id === id);
    if (!d) throw Object.assign(new Error('Unknown downtime record'), { status: 404 });
    if (!d.end) { d.end = nowIso(Date.now()); d.closedBy = by || 'system'; d.durationMin = Math.round((Date.parse(d.end) - Date.parse(d.start)) / 60000); writeJson(DOWNTIME, downtime).catch(() => {}); }
    return d;
}
const getDowntime = (limit = 200) => downtime.slice(-limit).reverse();

const getHours = () => ({ ...lastHours });

module.exports = {
    REASON_CODES, ASSETS, updateHours, getSummary, getPM, serviceTask, getHours,
    logCalibration, getCalibrations, logDowntime, closeDowntime, getDowntime,
};
