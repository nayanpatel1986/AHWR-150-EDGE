'use strict';
// Alarm management engine (ISA-18.2-flavoured, sized for a workover rig).
// Per-tag setpoints (HiHi/Hi/Lo/LoLo) with deadband + on-delay, a state machine
// (UNACK -> ACK -> return-to-normal), acknowledge, first-out, and an event log.
const { readJson, writeJson, resolvePath } = require('./persist');

const CONFIG_FILE = 'alarms_config.json';
const EVENTS_FILE = 'alarms_events.json';
const MAX_EVENTS = 5000;
const PRIORITY_RANK = { P1: 1, P2: 2, P3: 3 };

// Default workover alarm set. dataKey is a dotted path into the rig-data payload.
const DEFAULT_CONFIG = [
    // Safety status (read-only PLC inputs) — top-priority, no on-delay, no deadband.
    { key: 'esd_active', dataKey: 'safety.esd_active', label: 'EMERGENCY SHUTDOWN ACTIVE', unit: '', hi: 1, deadband: 0, onDelaySec: 0, priority: 'P1', enabled: true },
    { key: 'lockout_active', dataKey: 'safety.lockout_active', label: 'EQUIPMENT LOCKOUT ACTIVE', unit: '', hi: 1, deadband: 0, onDelaySec: 0, priority: 'P1', enabled: true },
    { key: 'hookload_hi', dataKey: 'drawworks.hook_load', label: 'Hook Load High', unit: 't', hi: 180, hiHi: 200, deadband: 2, onDelaySec: 2, priority: 'P1', enabled: true },
    { key: 'spp_hi', dataKey: 'mudpump.pressure', label: 'Pump / Standpipe Pressure High', unit: 'bar', hi: 240, hiHi: 300, deadband: 5, onDelaySec: 2, priority: 'P2', enabled: true },
    { key: 'tubing_hi', dataKey: 'wellhead.tubing_pressure', label: 'Tubing Pressure High', unit: 'bar', hi: 200, hiHi: 250, deadband: 5, onDelaySec: 2, priority: 'P1', enabled: true },
    { key: 'casing_hi', dataKey: 'wellhead.casing_pressure', label: 'Casing Pressure High', unit: 'bar', hi: 150, hiHi: 200, deadband: 5, onDelaySec: 2, priority: 'P1', enabled: true },
    { key: 'accumulator_lo', dataKey: 'well_control.accumulator_pressure', label: 'BOP Accumulator Low', unit: 'psi', lo: 2800, loLo: 2500, deadband: 25, onDelaySec: 3, priority: 'P1', enabled: true },
    { key: 'pit_gainloss', dataKey: 'fluid.tank_gain_loss', label: 'Pit Gain / Loss', unit: 'm³', hi: 1.5, hiHi: 3, lo: -1.5, loLo: -3, deadband: 0.2, onDelaySec: 2, priority: 'P1', enabled: true },
    { key: 'hpu_oiltemp_hi', dataKey: 'hpu.oil_temp', label: 'HPU Oil Temperature High', unit: '°C', hi: 60, hiHi: 70, deadband: 1, onDelaySec: 5, priority: 'P3', enabled: true },
    { key: 'eng_oilpress_lo', dataKey: 'cat_engine.oil_pressure', label: 'Engine Oil Pressure Low', unit: 'bar', lo: 30, loLo: 20, deadband: 1, onDelaySec: 3, priority: 'P2', enabled: true },
    { key: 'eng_coolant_hi', dataKey: 'cat_engine.coolant_temp', label: 'Engine Coolant Temp High', unit: '°C', hi: 100, hiHi: 110, deadband: 1, onDelaySec: 5, priority: 'P2', enabled: true },
];

const LIMIT_KEYS = ['hi', 'hiHi', 'lo', 'loLo'];

// Validate one alarm definition. Returns an error string, or null when valid.
// A malformed entry used to throw inside evaluate() on every poll cycle.
function alarmEntryError(c, index) {
    const at = `alarm[${index}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return `${at} must be an object`;
    if (typeof c.key !== 'string' || !c.key.trim()) return `${at}.key is required`;
    if (typeof c.dataKey !== 'string' || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(c.dataKey)) {
        return `${at}.dataKey must be a dotted path like drawworks.hook_load`;
    }
    if (!(c.priority in PRIORITY_RANK)) return `${at}.priority must be P1, P2 or P3`;
    for (const k of LIMIT_KEYS) {
        if (c[k] != null && !Number.isFinite(c[k])) return `${at}.${k} must be a number or null`;
    }
    if (!LIMIT_KEYS.some((k) => c[k] != null)) return `${at} needs at least one of hi, hiHi, lo, loLo`;
    for (const k of ['deadband', 'onDelaySec']) {
        if (c[k] != null && (!Number.isFinite(c[k]) || c[k] < 0)) return `${at}.${k} must be a non-negative number`;
    }
    if (typeof c.enabled !== 'boolean') return `${at}.enabled must be true or false`;
    return null;
}

let config = null;
const active = new Map();   // key -> alarm record
const pending = new Map();  // key -> { since, condition, value, limit } awaiting on-delay
let events = [];

function load() {
    config = readJson(CONFIG_FILE, null);
    if (!Array.isArray(config)) {
        config = DEFAULT_CONFIG;
        writeJson(CONFIG_FILE, config).catch(() => {});
    } else {
        // Merge in any new built-in alarms added since the config was last persisted
        // (e.g. ESD/lockout), without clobbering existing admin edits.
        const have = new Set(config.map((c) => c.key));
        const added = DEFAULT_CONFIG.filter((c) => !have.has(c.key));
        if (added.length) { config = [...added, ...config]; writeJson(CONFIG_FILE, config).catch(() => {}); }
    }
    // Never let a hand-edited/corrupt entry on disk break evaluation; skip it loudly.
    config = config.filter((c, i) => {
        const err = alarmEntryError(c, i);
        if (err) console.error(`Ignoring invalid alarm definition: ${err}`);
        return !err;
    });
    events = readJson(EVENTS_FILE, []);
    if (!Array.isArray(events)) events = [];
}
load();

const logEvent = (ev) => {
    events.push(ev);
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    writeJson(EVENTS_FILE, events).catch(() => {});
};

// Which limit (if any) is breached for a value, honouring deadband on clearing.
function evalCondition(c, value, wasActive) {
    const db = wasActive ? (c.deadband || 0) : 0; // hysteresis only while clearing
    if (c.hiHi != null && value >= c.hiHi) return { condition: 'HIHI', limit: c.hiHi };
    if (c.hi != null && value >= c.hi) return { condition: 'HI', limit: c.hi };
    if (c.loLo != null && value <= c.loLo) return { condition: 'LOLO', limit: c.loLo };
    if (c.lo != null && value <= c.lo) return { condition: 'LO', limit: c.lo };
    // still "in alarm" within the deadband band so it doesn't chatter
    if (wasActive) {
        if (c.hi != null && value >= c.hi - db) return { condition: 'HI', limit: c.hi };
        if (c.lo != null && value <= c.lo + db) return { condition: 'LO', limit: c.lo };
    }
    return null;
}

// Evaluate all configured tags against the latest rig data. Returns the active
// list, counts, and whether anything changed (so the server can emit).
function evaluate(data, nowMs) {
    let changed = false;
    for (const c of config) {
        if (!c.enabled) continue;
        const raw = resolvePath(data, c.dataKey);
        // Individual HPU points can stop updating while other equipment stays live.
        if (c.dataKey.startsWith('hpu.') && data._fieldTimes) {
            const at = Date.parse(data._fieldTimes[c.dataKey]);
            if (!Number.isFinite(at) || nowMs - at > 10000) continue;
        }
        const value = Number(raw);
        const existing = active.get(c.key);
        if (raw == null || !Number.isFinite(value)) { continue; } // no/stale data -> leave as-is

        const cond = evalCondition(c, value, !!existing);
        if (cond) {
            if (existing) {
                // update live value/condition; escalate severity if condition worsened
                if (existing.condition !== cond.condition || existing.value !== value) changed = true;
                existing.value = value; existing.condition = cond.condition; existing.limit = cond.limit;
                if (existing.state === 'RTN_UNACK') { existing.state = 'UNACK'; changed = true; } // re-alarmed
            } else {
                const p = pending.get(c.key);
                if (!p) { pending.set(c.key, { since: nowMs }); }
                else if ((nowMs - p.since) >= (c.onDelaySec || 0) * 1000) {
                    pending.delete(c.key);
                    const rec = { id: c.key, dataKey: c.dataKey, label: c.label, unit: c.unit, priority: c.priority, condition: cond.condition, value, limit: cond.limit, state: 'UNACK', raisedAt: new Date(nowMs).toISOString(), ackBy: null, ackAt: null };
                    active.set(c.key, rec); changed = true;
                    logEvent({ ts: rec.raisedAt, type: 'RAISE', key: c.key, label: c.label, priority: c.priority, condition: cond.condition, value, limit: cond.limit });
                }
            }
        } else {
            pending.delete(c.key);
            if (existing) {
                // returned to normal
                if (existing.state === 'ACK') {
                    active.delete(c.key); changed = true;
                    logEvent({ ts: new Date(nowMs).toISOString(), type: 'RTN', key: c.key, label: c.label, value });
                } else if (existing.state !== 'RTN_UNACK') {
                    existing.state = 'RTN_UNACK'; existing.value = value; changed = true;
                    logEvent({ ts: new Date(nowMs).toISOString(), type: 'RTN_UNACK', key: c.key, label: c.label, value });
                }
            }
        }
    }
    return { changed, ...snapshot() };
}

function snapshot() {
    const list = [...active.values()];
    // first-out = earliest still-unacknowledged alarm
    const unacked = list.filter(a => a.state === 'UNACK').sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
    const firstOutId = unacked.length ? unacked[0].id : null;
    const enriched = list.map(a => ({ ...a, firstOut: a.id === firstOutId }))
        .sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || a.raisedAt.localeCompare(b.raisedAt));
    const counts = { active: list.length, unack: unacked.length, p1: 0, p2: 0, p3: 0, highest: null };
    for (const a of list) counts[a.priority.toLowerCase()]++;
    counts.highest = list.length ? enriched[0].priority : null;
    return { active: enriched, counts };
}

function ack(id, user, nowMs = Date.now()) {
    const a = active.get(id);
    if (!a) return false;
    if (a.state === 'RTN_UNACK') { active.delete(id); }
    else { a.state = 'ACK'; a.ackBy = user; a.ackAt = new Date(nowMs).toISOString(); }
    logEvent({ ts: new Date(nowMs).toISOString(), type: 'ACK', key: id, by: user });
    return true;
}
function ackAll(user, nowMs = Date.now()) {
    let n = 0;
    for (const id of [...active.keys()]) if (ack(id, user, nowMs)) n++;
    return n;
}

const getActive = () => snapshot();
const getHistory = (limit = 200) => events.slice(-limit).reverse();
const getConfig = () => config;
async function setConfig(next) {
    if (!Array.isArray(next)) throw Object.assign(new Error('config must be an array'), { status: 400 });
    const seen = new Set();
    next.forEach((c, i) => {
        const err = alarmEntryError(c, i);
        if (err) throw Object.assign(new Error(err), { status: 400 });
        if (seen.has(c.key)) throw Object.assign(new Error(`duplicate alarm key: ${c.key}`), { status: 400 });
        seen.add(c.key);
    });
    config = next;
    await writeJson(CONFIG_FILE, config);
    return config;
}

module.exports = { evaluate, ack, ackAll, getActive, getHistory, getConfig, setConfig, snapshot };
