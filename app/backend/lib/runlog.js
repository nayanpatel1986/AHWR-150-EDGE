'use strict';
// Run-hour log with per-equipment run history and settled-condition snapshots.
//
// Model — one RUN SESSION per start/stop cycle, per equipment:
//   * an asset is judged RUNNING from live readings (never an operator toggle)
//   * when it starts, a session opens (start time + run-hours at start)
//   * exactly ONE health snapshot is taken SNAPSHOT_DELAY_MS (default 5 min)
//     after that start, so the machine has settled into steady running before
//     its vitals are recorded — a snapshot taken at the instant of start would
//     capture warm-up transients, not condition
//   * if the asset stops before the delay elapses, no snapshot is written (the
//     run was too short to characterise) and the session records that
//   * on stop, the session closes with end time, end hours and duration
//
// The result is an equipment-wise history: every restart, how long it ran, and
// its parameter fingerprint five minutes in — directly comparable across runs
// to spot degradation.
const { readJson, writeJson, resolvePath } = require('./persist');
const { ASSETS } = require('./maintenance');

const SESS_FILE = 'runhours_sessions.json';
const DAILY_FILE = 'runhours_daily.json';
// One snapshot per start, taken this long after the equipment starts.
const SNAPSHOT_DELAY_MS = Number(process.env.RUNLOG_SNAPSHOT_DELAY_MS || 5 * 60 * 1000);
const MAX_SESSIONS = 20000;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const dayKey = (ms = Date.now()) => nowIso(ms).slice(0, 10);
let _id = 0;
const uid = () => `rs_${Date.now().toString(36)}_${(++_id).toString(36)}`;

let sessions = readJson(SESS_FILE, null);
let daily = readJson(DAILY_FILE, null);
if (!Array.isArray(sessions)) sessions = [];
if (!daily || typeof daily !== 'object') daily = {};   // { 'YYYY-MM-DD': { assetId: hoursRun } }

const saveSessions = () => writeJson(SESS_FILE, sessions).catch(() => {});
const saveDaily = () => writeJson(DAILY_FILE, daily).catch(() => {});

const track = {};   // assetId -> { running, lastTickMs, openId }
let lastPersist = 0;

// A restart wipes `track`, so without this every restart would orphan the open
// session and open a duplicate — inflating starts and run hours without bound.
// Sessions carry `lastTickTs` (stamped while running) so a session interrupted
// by a restart can be closed at the last moment it was actually observed.
const RESUME_GRACE_MS = Number(process.env.RUNLOG_RESUME_GRACE_MS || 10 * 60 * 1000);

function closeOrphan(s, atMs, reason) {
    s.endTs = nowIso(atMs);
    s.durationH = Number(Math.max(0, (atMs - Date.parse(s.startTs)) / 3600000).toFixed(3));
    s.snapshotDue = null;
    s.closedBy = reason;
    if (!s.snapshotAt) s.snapshotSkipped = true;
}

// On boot, tidy anything the previous process left open. The newest open
// session per asset is kept as a resume candidate; older ones can only be
// duplicates from earlier restarts, so close them where they were last seen.
const resumable = {};
(function reconcileOnBoot() {
    let changed = false;
    for (const a of ASSETS) {
        const open = sessions.filter((s) => s.assetId === a.id && !s.endTs);
        if (!open.length) continue;
        const newest = open[open.length - 1];
        for (const s of open) {
            if (s === newest) continue;
            closeOrphan(s, Date.parse(s.lastTickTs || s.startTs), 'restart');
            changed = true;
        }
        resumable[a.id] = newest;
    }
    if (changed) saveSessions();
})();

// Is this asset actually turning/loaded right now? Derived from live tags only.
function isRunning(assetId, data) {
    const n = (p) => num(resolvePath(data, p));
    switch (assetId) {
        case 'engine':    return (n('cat_engine.rpm') || 0) > 400;
        case 'hpu':       return Number(n('hpu.status')) === 2 || (n('hpu.discharge_pressure') || 0) > 20;
        case 'topdrive':  return Math.abs(n('htd.rpm') || 0) > 1;
        case 'drawworks': {
            const act = data && data._activity && data._activity.code;
            return act === 'RIH' || act === 'POOH';
        }
        case 'mudpump':   return (n('mudpump.spm') || 0) > 1;
        default:          return false;
    }
}

// The asset's health parameters at this instant (from the asset registry).
function healthSnapshot(asset, data) {
    const out = {};
    (asset.health || []).forEach(([label, key]) => { out[label] = num(resolvePath(data, key)); });
    return out;
}

const openSession = (id) => sessions.find((s) => s.id === id && !s.endTs);

/**
 * Called once per telemetry tick from the server poll loop.
 * @param {object} data           latest rig payload
 * @param {object} hoursByAsset   assetId -> cumulative run hours (from maintenance.js)
 */
function update(data, hoursByAsset = {}, nowMs = Date.now()) {
    if (!data || typeof data !== 'object') return;
    let dirty = false;

    for (const a of ASSETS) {
        const t = track[a.id] || (track[a.id] = { running: false, lastTickMs: null, openId: null });
        const running = isRunning(a.id, data);
        const hours = hoursByAsset[a.id] != null ? Number(Number(hoursByAsset[a.id]).toFixed(1)) : null;

        // First tick after a restart: adopt the session left open if it was
        // seen recently and the asset is still running (a brief restart should
        // not fragment one continuous run into two), otherwise close it out.
        if (resumable[a.id]) {
            const s = resumable[a.id];
            delete resumable[a.id];
            const lastSeen = Date.parse(s.lastTickTs || s.startTs);
            if (running && Number.isFinite(lastSeen) && nowMs - lastSeen <= RESUME_GRACE_MS) {
                t.openId = s.id;
                t.running = true;
                s.resumed = (s.resumed || 0) + 1;
            } else {
                closeOrphan(s, Number.isFinite(lastSeen) ? lastSeen : nowMs, 'restart');
            }
            dirty = true;
        }

        // Accrue running time into the per-day ledger (ignore long gaps so a
        // restart or an outage does not book phantom hours).
        if (t.lastTickMs && t.running) {
            const dtH = (nowMs - t.lastTickMs) / 3600000;
            if (dtH > 0 && dtH < 0.25) {
                const d = dayKey(nowMs);
                daily[d] = daily[d] || {};
                daily[d][a.id] = Number(((daily[d][a.id] || 0) + dtH).toFixed(4));
                dirty = true;
            }
        }

        if (running && !t.running) {
            // --- START: open a new run session ---
            const rec = {
                id: uid(), assetId: a.id, assetName: a.name,
                startTs: nowIso(nowMs), endTs: null, lastTickTs: nowIso(nowMs),
                startHours: hours, endHours: null, durationH: null,
                snapshotAt: null, snapshotDue: nowMs + SNAPSHOT_DELAY_MS,
                params: null, snapshotHours: null, snapshotSkipped: false,
            };
            sessions.push(rec);
            t.openId = rec.id;
            dirty = true;
        } else if (!running && t.running) {
            // --- STOP: close the open session ---
            const s = openSession(t.openId);
            if (s) {
                s.endTs = nowIso(nowMs);
                s.endHours = hours;
                s.durationH = Number((((nowMs - Date.parse(s.startTs)) / 3600000)).toFixed(3));
                // Ran for less than the settling delay -> no representative snapshot.
                if (!s.snapshotAt) s.snapshotSkipped = true;
                s.snapshotDue = null;
            }
            t.openId = null;
            dirty = true;
        } else if (running && t.openId) {
            // --- RUNNING: take the single settled snapshot once the delay elapses ---
            const s = openSession(t.openId);
            // Remember when this run was last observed, so a restart can close
            // or resume it at the right moment rather than at "now".
            if (s) s.lastTickTs = nowIso(nowMs);
            if (s && s.snapshotDue && !s.snapshotAt && nowMs >= s.snapshotDue) {
                s.snapshotAt = nowIso(nowMs);
                s.snapshotHours = hours;
                s.params = healthSnapshot(a, data);
                s.snapshotDue = null;
                dirty = true;
            }
        }

        t.running = running;
        t.lastTickMs = nowMs;
    }

    if (sessions.length > MAX_SESSIONS) sessions = sessions.slice(-MAX_SESSIONS);
    if (dirty && nowMs - lastPersist > 20000) { lastPersist = nowMs; saveSessions(); saveDaily(); }
}

// Full run history, newest first. Filter by equipment for the per-asset view.
function listSessions({ assetId, withSnapshotOnly, limit = 200 } = {}) {
    let rows = sessions;
    if (assetId) rows = rows.filter((s) => s.assetId === assetId);
    if (String(withSnapshotOnly) === 'true') rows = rows.filter((s) => !!s.snapshotAt);
    return rows.slice(-Number(limit) || -200).reverse();
}

// Only the settled snapshots (one per run), newest first — the health record.
function listSnapshots({ assetId, limit = 200 } = {}) {
    return listSessions({ assetId, withSnapshotOnly: 'true', limit })
        .map((s) => ({
            id: s.id, ts: s.snapshotAt, assetId: s.assetId, assetName: s.assetName,
            hours: s.snapshotHours, params: s.params,
            startTs: s.startTs, minutesAfterStart: Math.round((Date.parse(s.snapshotAt) - Date.parse(s.startTs)) / 60000),
        }));
}

// Per-equipment roll-up: starts, total run time, last run, snapshot count.
function getAssetHistory(assetId) {
    const rows = sessions.filter((s) => s.assetId === assetId);
    const closed = rows.filter((s) => s.endTs);
    const totalH = closed.reduce((sum, s) => sum + (Number(s.durationH) || 0), 0);
    const last = rows[rows.length - 1] || null;
    return {
        assetId,
        assetName: (ASSETS.find((a) => a.id === assetId) || {}).name || assetId,
        starts: rows.length,
        completedRuns: closed.length,
        snapshots: rows.filter((s) => s.snapshotAt).length,
        shortRuns: rows.filter((s) => s.snapshotSkipped).length,
        totalRunHours: Number(totalH.toFixed(2)),
        avgRunHours: closed.length ? Number((totalH / closed.length).toFixed(2)) : null,
        lastStart: last ? last.startTs : null,
        running: !!(track[assetId] && track[assetId].running),
        sessions: rows.slice(-100).reverse(),
    };
}

function listDaily({ days = 30 } = {}) {
    return Object.keys(daily).sort().reverse().slice(0, Number(days) || 30).map((date) => {
        const assets = daily[date] || {};
        const total = Object.values(assets).reduce((s, v) => s + Number(v || 0), 0);
        return {
            date,
            assets: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, Number(Number(v).toFixed(2))])),
            total: Number(total.toFixed(2)),
        };
    });
}

// Current state + today's hours per asset, for the summary strip.
function getStatus(hoursByAsset = {}) {
    const d = dayKey();
    return ASSETS.map((a) => {
        const t = track[a.id] || {};
        const open = t.openId ? openSession(t.openId) : null;
        const mine = sessions.filter((s) => s.assetId === a.id);
        return {
            id: a.id, name: a.name, category: a.category,
            running: !!t.running,
            since: open ? open.startTs : null,
            snapshotPending: !!(open && open.snapshotDue && !open.snapshotAt),
            hours: hoursByAsset[a.id] != null ? Number(Number(hoursByAsset[a.id]).toFixed(1)) : null,
            hoursToday: Number(Number((daily[d] || {})[a.id] || 0).toFixed(2)),
            starts: mine.length,
            snapshots: mine.filter((s) => s.snapshotAt).length,
        };
    });
}

module.exports = {
    update, listSessions, listSnapshots, listDaily, getStatus, getAssetHistory, SNAPSHOT_DELAY_MS,
};
