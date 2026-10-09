'use strict';
// Workover domain logic: activity/NPT tracking, torque-turn + connection tally,
// and daily-report aggregation. All state persists under DATA_DIR.
const { readJson, writeJson } = require('./persist');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const nowIso = (ms) => new Date(ms).toISOString();
const dayOf = (iso) => iso.slice(0, 10);

// ---------------------------------------------------------------------------
// Activity / NPT
// ---------------------------------------------------------------------------
const CODES = [
    { code: 'DRILLING', label: 'Drilling', productive: true },
    { code: 'TRIP_IN', label: 'Trip In', productive: true },
    { code: 'TRIP_OUT', label: 'Trip Out', productive: true },
    { code: 'CASING', label: 'Casing', productive: true },
    { code: 'RIH', label: 'Running In Hole', productive: true },
    { code: 'POOH', label: 'Pulling Out Of Hole', productive: true },
    { code: 'MAKE_UP', label: 'Make-Up Connection', productive: true },
    { code: 'BREAK_OUT', label: 'Break-Out Connection', productive: true },
    { code: 'CIRCULATE', label: 'Circulating', productive: true },
    { code: 'SWAB', label: 'Swabbing', productive: true },
    { code: 'FISHING', label: 'Fishing / Milling', productive: true },
    { code: 'RIG_UP', label: 'Rig Up', productive: true },
    { code: 'RIG_DOWN', label: 'Rig Down', productive: true },
    { code: 'IDLE', label: 'Idle', productive: true },
    { code: 'WAIT', label: 'Waiting (NPT)', productive: false },
];
const LABEL = Object.fromEntries(CODES.map((c) => [c.code, c]));
const NPT_REASONS = ['Weather', 'Equipment Failure', 'Waiting on Parts', 'Waiting on Orders', 'Waiting on Crew', 'Well Control', 'Other'];

const ACTIVITY_LOG = 'activity_log.json';
const ACTIVITY_STATE = 'activity_state.json';
const MAX_LOG = 5000;

let state = readJson(ACTIVITY_STATE, null) || { current: null, manualOverride: null, lastBlock: null };
let log = readJson(ACTIVITY_LOG, []);
if (!Array.isArray(log)) log = [];

const persistActivity = () => { writeJson(ACTIVITY_STATE, state).catch(() => {}); writeJson(ACTIVITY_LOG, log).catch(() => {}); };

function autoClassify(data) {
    const spm = num(data.mudpump?.spm);
    const pumping = Number.isFinite(spm) && spm > 10;
    const seq = num(data.pct?.sequence);
    const opMode = num(data.drilling?.operation_mode);
    const blk = num(data.drawworks?.block_position);
    let movedDown = 0;
    if (Number.isFinite(blk) && Number.isFinite(state.lastBlock)) movedDown = state.lastBlock - blk; // +ve = moving down (RIH)
    if (Number.isFinite(blk)) state.lastBlock = blk;

    if (seq === 1) return 'MAKE_UP';
    if (seq === 2) return 'BREAK_OUT';
    if (opMode === 1) return 'DRILLING';
    if (opMode === 2) return 'TRIP_IN';
    if (opMode === 3) return 'TRIP_OUT';
    if (opMode === 4) return 'CASING';
    if (movedDown > 1.0) return 'RIH';
    if (movedDown < -1.0) return 'POOH';
    if (pumping) return 'CIRCULATE';
    return 'IDLE';
}

// Called each tick. Returns the current activity state (with auto suggestion).
function updateActivity(data, nowMs = Date.now()) {
    const suggested = autoClassify(data);
    const override = state.manualOverride;
    const effectiveCode = override ? override.code : suggested;
    const meta = LABEL[effectiveCode] || LABEL.IDLE;
    const productive = override && override.npt ? false : meta.productive;
    const npt = override && override.npt ? override.npt : (productive ? null : { reason: 'Unspecified' });

    if (!state.current || state.current.code !== effectiveCode || JSON.stringify(state.current.npt) !== JSON.stringify(npt)) {
        // close previous open log entry
        const open = log.find((e) => !e.end);
        if (open) { open.end = nowIso(nowMs); open.durationSec = Math.round((nowMs - Date.parse(open.start)) / 1000); }
        const depth = num(data.drilling?.hole_depth);
        const entry = { code: effectiveCode, label: meta.label, productive, npt, source: override ? 'manual' : 'auto', start: nowIso(nowMs), end: null, durationSec: null, depth: Number.isFinite(depth) ? depth : null };
        log.push(entry);
        if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
        state.current = { code: effectiveCode, label: meta.label, productive, npt, source: entry.source, since: entry.start, suggested };
        persistActivity();
    } else {
        state.current.suggested = suggested; // refresh suggestion without churning the log
    }
    return state.current;
}

function setActivity(code, npt) {
    if (code === 'AUTO') { state.manualOverride = null; }
    else {
        if (!LABEL[code]) throw Object.assign(new Error('Unknown activity code'), { status: 400 });
        state.manualOverride = { code, npt: npt && npt.reason ? { reason: npt.reason } : (code === 'WAIT' ? { reason: 'Unspecified' } : null), setAt: nowIso(Date.now()) };
    }
    persistActivity();
    return state.current;
}

const getCurrent = () => state.current;
const getCodes = () => ({ codes: CODES, nptReasons: NPT_REASONS });
function getLog(date) {
    const d = date || (new Date()).toISOString().slice(0, 10);
    return log.filter((e) => dayOf(e.start) === d).map((e) => ({
        ...e, durationSec: e.durationSec != null ? e.durationSec : Math.round((Date.now() - Date.parse(e.start)) / 1000),
    }));
}

// ---------------------------------------------------------------------------
// Torque-turn / connections
// ---------------------------------------------------------------------------
const CONNECTIONS = 'connections.json';
const TT_LIMITS = { minTorque: 8000, maxTorque: 16000, dumpTorque: 17000, unit: 'daN·m' };
const MAX_CONN = 5000;

let conn = readJson(CONNECTIONS, null) || { jointCounter: 0, records: [], limits: TT_LIMITS };
if (!conn.limits) conn.limits = TT_LIMITS;
let capture = { active: false, samples: [], startMs: 0 };

const persistConn = () => writeJson(CONNECTIONS, conn).catch(() => {});

// Called each tick. Detects a PCT make-up sequence, samples make-up torque, and
// on completion records a connection (peak torque + pass/fail + joint #).
function updateTorqueTurn(data, nowMs = Date.now()) {
    const seq = num(data.pct?.sequence);
    const torque = num(data.pct?.makeup_torque);
    let connectionMade = null;

    if (seq === 1) { // MAKE-UP in progress
        if (!capture.active) capture = { active: true, samples: [], startMs: nowMs, activity: state.current ? state.current.code : null };
        if (Number.isFinite(torque)) {
            capture.samples.push({ t: Math.round((nowMs - capture.startMs) / 1000 * 10) / 10, torque });
            if (capture.samples.length > 600) capture.samples = capture.samples.slice(-600);
        }
    } else if (capture.active) { // sequence ended -> finalize
        const peak = capture.samples.reduce((m, s) => Math.max(m, s.torque), 0);
        if (peak > 0 && capture.samples.length >= 2) {
            conn.jointCounter += 1;
            const result = (peak >= conn.limits.minTorque && peak <= conn.limits.maxTorque) ? 'PASS' : 'FAIL';
            connectionMade = {
                joint: conn.jointCounter, peakTorque: Math.round(peak), unit: conn.limits.unit,
                samples: capture.samples.length, durationSec: Math.round((nowMs - capture.startMs) / 1000),
                result, ts: nowIso(nowMs), activity: capture.activity || (state.current ? state.current.code : null),
            };
            conn.records.push(connectionMade);
            if (conn.records.length > MAX_CONN) conn.records = conn.records.slice(-MAX_CONN);
            persistConn();
        }
        capture = { active: false, samples: [], startMs: 0 };
    }
    return { connectionMade };
}

const getTorqueTurnLive = () => ({ active: capture.active, samples: capture.samples, limits: conn.limits });
function getConnections(date) {
    const recs = date ? conn.records.filter((r) => dayOf(r.ts) === date) : conn.records;
    const tally = { run: recs.length, pass: recs.filter((r) => r.result === 'PASS').length, fail: recs.filter((r) => r.result === 'FAIL').length };
    return { tally, limits: conn.limits, jointCounter: conn.jointCounter, records: recs.slice(-500).reverse() };
}

// ---------------------------------------------------------------------------
// Daily report
// ---------------------------------------------------------------------------
const HEADER = 'report_header.json';
const getHeader = () => readJson(HEADER, { well: 'WELL-001', rig: 'AHWR-01', operator: '', contractor: '', jobNo: '', field: '' });
async function setHeader(h) { const cur = getHeader(); const next = { ...cur, ...h }; await writeJson(HEADER, next); return next; }

function getDailyReport(date) {
    const d = date || (new Date()).toISOString().slice(0, 10);
    const entries = getLog(d);
    const byCode = {};
    let productiveSec = 0, nptSec = 0;
    for (const e of entries) {
        byCode[e.code] = byCode[e.code] || { code: e.code, label: e.label, durationSec: 0, productive: e.productive };
        byCode[e.code].durationSec += e.durationSec || 0;
        if (e.productive) productiveSec += e.durationSec || 0; else nptSec += e.durationSec || 0;
    }
    const depths = entries.map((e) => e.depth).filter((x) => x != null);
    const conns = getConnections(d);
    const events = readJson('alarms_events.json', []).filter((ev) => ev.type === 'RAISE' && dayOf(ev.ts) === d)
        .map((ev) => ({ ts: ev.ts, label: ev.label, priority: ev.priority, condition: ev.condition }));
    const nptByReason = {};
    for (const e of entries) if (!e.productive && e.npt) { const r = e.npt.reason || 'Unspecified'; nptByReason[r] = (nptByReason[r] || 0) + (e.durationSec || 0); }

    return {
        date: d,
        header: getHeader(),
        activitySummary: Object.values(byCode).sort((a, b) => b.durationSec - a.durationSec),
        totals: { productiveSec, nptSec, totalSec: productiveSec + nptSec },
        nptByReason,
        depth: { start: depths.length ? depths[0] : null, end: depths.length ? depths[depths.length - 1] : null, progress: depths.length ? Number((depths[depths.length - 1] - depths[0]).toFixed(2)) : 0 },
        connections: { ...conns.tally, jointCounter: conns.jointCounter },
        alarms: events,
        generatedAt: nowIso(Date.now()),
    };
}

// Aggregate activity + connections over an arbitrary window (used to summarise a WELL,
// which spans multiple days). startIso required; endIso defaults to now.
function windowSummary(startIso, endIso) {
    const startMs = Date.parse(startIso); const endMs = endIso ? Date.parse(endIso) : Date.now();
    if (!Number.isFinite(startMs)) return null;
    const inWin = (iso) => { const t = Date.parse(iso); return t >= startMs && t <= endMs; };
    const entries = log.filter((e) => inWin(e.start)).map((e) => ({ ...e, durationSec: e.durationSec != null ? e.durationSec : Math.round((Math.min(Date.now(), endMs) - Date.parse(e.start)) / 1000) }));
    const byCode = {}; let productiveSec = 0, nptSec = 0;
    for (const e of entries) {
        byCode[e.code] = byCode[e.code] || { code: e.code, label: e.label, durationSec: 0, productive: e.productive };
        byCode[e.code].durationSec += e.durationSec || 0;
        if (e.productive) productiveSec += e.durationSec || 0; else nptSec += e.durationSec || 0;
    }
    const depths = entries.map((e) => e.depth).filter((x) => x != null);
    const recs = conn.records.filter((r) => inWin(r.ts));
    return {
        startedAt: startIso, endedAt: endIso || nowIso(endMs),
        durationHrs: Number(((endMs - startMs) / 3600000).toFixed(2)),
        productiveSec, nptSec,
        activitySummary: Object.values(byCode).sort((a, b) => b.durationSec - a.durationSec),
        connections: { run: recs.length, pass: recs.filter((r) => r.result === 'PASS').length, fail: recs.filter((r) => r.result === 'FAIL').length },
        joints: recs.length,
        depthStart: depths.length ? depths[0] : null,
        depthEnd: depths.length ? depths[depths.length - 1] : null,
        depthProgress: depths.length ? Number((depths[depths.length - 1] - depths[0]).toFixed(2)) : 0,
    };
}

module.exports = {
    updateActivity, setActivity, getCurrent, getCodes, getLog,
    updateTorqueTurn, getTorqueTurnLive, getConnections,
    getDailyReport, getHeader, setHeader, windowSummary,
};
