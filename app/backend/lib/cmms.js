'use strict';
// CMMS layer on top of lib/maintenance.js (which owns assets, run-hours, the
// preventive-maintenance schedule, downtime and calibration).
//
// This adds the pieces a computerised maintenance management system needs:
//   * WORK ORDERS   — one register for every job: preventive, breakdown
//                     (corrective), overhaul and inspection. Full lifecycle
//                     OPEN -> IN_PROGRESS -> ON_HOLD -> COMPLETED / CANCELLED,
//                     with labour hours, spares consumed and failure analysis.
//   * LOGBOOK       — the shift/tour logbook: what each crew did and handed over.
//   * OVERHAULS     — major overhaul campaigns with planned vs actual dates and
//                     milestone tracking (a long-running job, not a work order).
//
// All state persists as JSON under DATA_DIR, mirroring the rest of the app.
const { readJson, writeJson } = require('./persist');
const { ASSETS } = require('./maintenance');

const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const today = () => nowIso().slice(0, 10);
let _seq = 0;
const uid = (p) => `${p}_${Date.now().toString(36)}_${(++_seq).toString(36)}`;
const str = (v, max = 2000) => (v == null ? '' : String(v).slice(0, max));
const numOr = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const MAX = 5000;

// ---- vocabularies ---------------------------------------------------------
const WO_TYPES = ['PREVENTIVE', 'BREAKDOWN', 'OVERHAUL', 'INSPECTION'];
const WO_STATUS = ['OPEN', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
const WO_PRIORITY = ['P1', 'P2', 'P3'];          // P1 = rig-stopping
const FAILURE_CODES = [
    'WEAR', 'FATIGUE', 'SEAL_LEAK', 'HOSE_BURST', 'BEARING', 'OVERHEAT',
    'ELECTRICAL_FAULT', 'SENSOR_FAULT', 'CONTROL_FAULT', 'LUBRICATION',
    'CORROSION', 'OPERATOR_ERROR', 'UNKNOWN',
];
// Two SEPARATE log streams. Operations records what the rig did; maintenance
// records what was done to the equipment. They are kept apart because they are
// written by different crews, reviewed by different people, and mixing them
// makes both harder to audit.
const LOG_TYPES = ['OPERATIONS', 'MAINTENANCE'];
// The operations log is categorised by the WORKOVER OPERATION being performed,
// so a tour's entries read as the job sequence rather than as generic notes.
const LOG_CATEGORIES_BY_TYPE = {
    OPERATIONS: [
        'RIG_UP', 'RIG_DOWN',
        'RUNNING_IN', 'RUNNING_OUT',
        'CIRCULATION', 'WELL_KILL',
        'CDR', 'WOC', 'CEMENTING',
        'PERFORATION', 'ACTIVATION', 'SWABBING',
        'PACKER', 'SCRAPING', 'FISHING', 'LOGGING',
        'STIMULATION', 'WELL_TESTING',
        'BOP_NU_ND', 'RIGGING_OPS',
        'HANDOVER', 'SAFETY', 'INCIDENT', 'NPT', 'OTHER',
    ],
    MAINTENANCE: ['MAINTENANCE', 'INSPECTION', 'BREAKDOWN', 'CALIBRATION', 'SPARES', 'LUBRICATION', 'OVERHAUL'],
};
// Human labels for the operation codes (UI dropdowns / log rendering).
const LOG_CATEGORY_LABELS = {
    RIG_UP: 'Rig Up', RIG_DOWN: 'Rig Down',
    RUNNING_IN: 'Running In Hole (RIH)', RUNNING_OUT: 'Running Out of Hole (POOH)',
    CIRCULATION: 'Circulation', WELL_KILL: 'Well Kill',
    CDR: 'CDR', WOC: 'Waiting on Cement (WOC)', CEMENTING: 'Cementing',
    PERFORATION: 'Perforation', ACTIVATION: 'Activation', SWABBING: 'Swabbing',
    PACKER: 'Packer Setting / Retrieval', SCRAPING: 'Scraping', FISHING: 'Fishing', LOGGING: 'Logging',
    STIMULATION: 'Stimulation / Acidising', WELL_TESTING: 'Well Testing',
    BOP_NU_ND: 'BOP Nipple Up / Down', RIGGING_OPS: 'Rigging Operations',
    HANDOVER: 'Handover', SAFETY: 'Safety', INCIDENT: 'Incident', NPT: 'Non-Productive Time', OTHER: 'Other',
    MAINTENANCE: 'Maintenance', INSPECTION: 'Inspection', BREAKDOWN: 'Breakdown',
    CALIBRATION: 'Calibration', SPARES: 'Spares', LUBRICATION: 'Lubrication', OVERHAUL: 'Overhaul',
};
// Union, kept for backwards compatibility with existing stored entries.
const LOG_CATEGORIES = [...new Set([...LOG_CATEGORIES_BY_TYPE.OPERATIONS, ...LOG_CATEGORIES_BY_TYPE.MAINTENANCE])];
const SHIFTS = ['DAY', 'NIGHT'];
const OVERHAUL_STATUS = ['PLANNED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];

const ASSET_IDS = new Set(ASSETS.map((a) => a.id));
const assetName = (id) => (ASSETS.find((a) => a.id === id) || {}).name || id || '—';

// ---- persistence ----------------------------------------------------------
const WO_FILE = 'cmms_work_orders.json';
const LOG_FILE = 'cmms_logbook.json';
const OVH_FILE = 'cmms_overhauls.json';

let workOrders = readJson(WO_FILE, null);
let logbook = readJson(LOG_FILE, null);
let overhauls = readJson(OVH_FILE, null);

const saveWO = () => writeJson(WO_FILE, workOrders).catch(() => {});
const saveLog = () => writeJson(LOG_FILE, logbook).catch(() => {});
const saveOvh = () => writeJson(OVH_FILE, overhauls).catch(() => {});

// Seed a small, clearly-labelled starter set so the module is explorable on a
// fresh install. Real deployments overwrite these as soon as work is logged.
if (!Array.isArray(workOrders)) {
    const d = (days) => nowIso(Date.now() - days * 86400000);
    workOrders = [
        {
            id: uid('wo'), no: 'WO-1001', type: 'BREAKDOWN', assetId: 'mudpump', title: 'Mud pump #1 liner washout',
            description: 'Liner washed out during circulation; pressure drop observed.', priority: 'P1', status: 'COMPLETED',
            failureCode: 'WEAR', raisedBy: 'seed', raisedAt: d(3), assignedTo: 'Mech. crew',
            startedAt: d(3), completedAt: d(2), labourHours: 5.5, downtimeMin: 320,
            spares: [{ part: 'Liner 6"', qty: 1, uom: 'ea' }, { part: 'Piston rubber', qty: 2, uom: 'ea' }],
            resolution: 'Liner and piston replaced, pressure tested OK.', history: [],
        },
        {
            id: uid('wo'), no: 'WO-1002', type: 'BREAKDOWN', assetId: 'hpu', title: 'HPU filter differential high',
            description: 'Filter ΔP alarm; suspect clogged return filter.', priority: 'P2', status: 'IN_PROGRESS',
            failureCode: 'LUBRICATION', raisedBy: 'seed', raisedAt: d(1), assignedTo: 'Hyd. technician',
            startedAt: d(1), completedAt: null, labourHours: 1.5, downtimeMin: 0,
            spares: [], resolution: '', history: [],
        },
        {
            id: uid('wo'), no: 'WO-1003', type: 'PREVENTIVE', assetId: 'engine', title: 'Engine oil & filter change (250 h)',
            description: 'Routine PM raised from the running-hours schedule.', priority: 'P3', status: 'OPEN',
            failureCode: null, raisedBy: 'seed', raisedAt: d(0), assignedTo: '', startedAt: null, completedAt: null,
            labourHours: 0, downtimeMin: 0, spares: [], resolution: '', history: [],
        },
    ];
    saveWO();
}
if (!Array.isArray(logbook)) {
    logbook = [
        { id: uid('log'), ts: nowIso(Date.now() - 3600000 * 10), date: today(), logType: 'OPERATIONS', shift: 'DAY', category: 'HANDOVER', assetId: null, entry: 'Handover: rig on tubing pull, 1450 m. No outstanding permits.', by: 'seed' },
        { id: uid('log'), ts: nowIso(Date.now() - 3600000 * 8), date: today(), logType: 'OPERATIONS', shift: 'DAY', category: 'RUNNING_OUT', assetId: null, entry: 'POOH continued; 42 stands pulled, hole taking correct fill.', by: 'seed' },
        { id: uid('log'), ts: nowIso(Date.now() - 3600000 * 6), date: today(), logType: 'OPERATIONS', shift: 'DAY', category: 'CIRCULATION', assetId: null, entry: 'Circulated bottoms up, returns clean.', by: 'seed' },
        { id: uid('log'), ts: nowIso(Date.now() - 3600000 * 5), date: today(), logType: 'MAINTENANCE', shift: 'DAY', category: 'MAINTENANCE', assetId: 'hpu', entry: 'HPU return filter ΔP rising — WO-1002 raised, monitoring.', workOrderNo: 'WO-1002', by: 'seed' },
        { id: uid('log'), ts: nowIso(Date.now() - 3600000 * 3), date: today(), logType: 'MAINTENANCE', shift: 'DAY', category: 'INSPECTION', assetId: 'drawworks', entry: 'Drawworks brake inspection carried out — pads within limits.', by: 'seed' },
    ];
    saveLog();
}
if (!Array.isArray(overhauls)) {
    overhauls = [
        {
            id: uid('ovh'), no: 'OVH-2026-01', assetId: 'engine', title: 'CAT engine top-end overhaul',
            scope: 'Head, injectors, turbo inspection and reconditioning at 4500 running hours.',
            status: 'PLANNED', plannedStart: today(), plannedEnd: null, actualStart: null, actualEnd: null,
            atHours: 4500, contractor: 'OEM service', cost: null, findings: '',
            milestones: [
                { id: uid('ms'), name: 'Spares mobilised', done: false, doneAt: null },
                { id: uid('ms'), name: 'Engine isolated & LOTO', done: false, doneAt: null },
                { id: uid('ms'), name: 'Strip & inspect', done: false, doneAt: null },
                { id: uid('ms'), name: 'Rebuild', done: false, doneAt: null },
                { id: uid('ms'), name: 'Commission & load test', done: false, doneAt: null },
            ],
            by: 'seed', createdAt: nowIso(),
        },
    ];
    saveOvh();
}

// ---- helpers --------------------------------------------------------------
const nextWoNo = () => {
    const nums = workOrders
        .map((w) => Number(String(w.no || '').replace(/[^0-9]/g, '')))
        .filter((n) => Number.isFinite(n));
    return `WO-${(nums.length ? Math.max(...nums) : 1000) + 1}`;
};
const nextOvhNo = () => {
    const yr = new Date().getFullYear();
    const n = overhauls.filter((o) => String(o.no || '').includes(String(yr))).length + 1;
    return `OVH-${yr}-${String(n).padStart(2, '0')}`;
};
const validAsset = (id) => (id && ASSET_IDS.has(id) ? id : null);
const trackHistory = (wo, action, by, note) => {
    wo.history = wo.history || [];
    wo.history.push({ ts: nowIso(), action, by: by || 'system', note: note || '' });
    if (wo.history.length > 200) wo.history = wo.history.slice(-200);
};

// ---- work orders ----------------------------------------------------------
function listWorkOrders({ status, type, assetId, limit = 300 } = {}) {
    let rows = workOrders.slice();
    if (status) rows = rows.filter((w) => w.status === status);
    if (type) rows = rows.filter((w) => w.type === type);
    if (assetId) rows = rows.filter((w) => w.assetId === assetId);
    // Open work first, then most recent.
    const OPEN_RANK = { OPEN: 0, IN_PROGRESS: 0, ON_HOLD: 1, COMPLETED: 2, CANCELLED: 3 };
    rows.sort((a, b) => (OPEN_RANK[a.status] - OPEN_RANK[b.status]) || (Date.parse(b.raisedAt) - Date.parse(a.raisedAt)));
    return rows.slice(0, limit).map((w) => ({ ...w, assetName: assetName(w.assetId) }));
}

function createWorkOrder({ type, assetId, title, description, priority, failureCode, assignedTo, by } = {}) {
    if (!WO_TYPES.includes(type)) throw Object.assign(new Error(`type must be one of ${WO_TYPES.join(', ')}`), { status: 400 });
    if (!str(title).trim()) throw Object.assign(new Error('title is required'), { status: 400 });
    if (priority && !WO_PRIORITY.includes(priority)) throw Object.assign(new Error('invalid priority'), { status: 400 });
    if (failureCode && !FAILURE_CODES.includes(failureCode)) throw Object.assign(new Error('invalid failure code'), { status: 400 });
    const wo = {
        id: uid('wo'), no: nextWoNo(), type, assetId: validAsset(assetId),
        title: str(title, 160), description: str(description), priority: priority || 'P3',
        status: 'OPEN', failureCode: type === 'BREAKDOWN' ? (failureCode || 'UNKNOWN') : (failureCode || null),
        raisedBy: by || 'system', raisedAt: nowIso(), assignedTo: str(assignedTo, 80),
        startedAt: null, completedAt: null, labourHours: 0, downtimeMin: 0,
        spares: [], resolution: '', history: [],
    };
    trackHistory(wo, 'RAISED', by);
    workOrders.push(wo);
    if (workOrders.length > MAX) workOrders = workOrders.slice(-MAX);
    saveWO();
    return { ...wo, assetName: assetName(wo.assetId) };
}

function updateWorkOrder(id, patch = {}, by) {
    const wo = workOrders.find((w) => w.id === id);
    if (!wo) throw Object.assign(new Error('Unknown work order'), { status: 404 });

    if (patch.status !== undefined) {
        if (!WO_STATUS.includes(patch.status)) throw Object.assign(new Error('invalid status'), { status: 400 });
        if (patch.status !== wo.status) {
            trackHistory(wo, `STATUS -> ${patch.status}`, by, str(patch.note, 300));
            if (patch.status === 'IN_PROGRESS' && !wo.startedAt) wo.startedAt = nowIso();
            if (patch.status === 'COMPLETED') wo.completedAt = nowIso();
            if (patch.status !== 'COMPLETED') wo.completedAt = null;
            wo.status = patch.status;
        }
    }
    if (patch.priority !== undefined) {
        if (!WO_PRIORITY.includes(patch.priority)) throw Object.assign(new Error('invalid priority'), { status: 400 });
        wo.priority = patch.priority;
    }
    if (patch.failureCode !== undefined) {
        if (patch.failureCode && !FAILURE_CODES.includes(patch.failureCode)) throw Object.assign(new Error('invalid failure code'), { status: 400 });
        wo.failureCode = patch.failureCode || null;
    }
    if (patch.assignedTo !== undefined) wo.assignedTo = str(patch.assignedTo, 80);
    if (patch.title !== undefined) wo.title = str(patch.title, 160);
    if (patch.description !== undefined) wo.description = str(patch.description);
    if (patch.resolution !== undefined) wo.resolution = str(patch.resolution);
    if (patch.labourHours !== undefined) wo.labourHours = Math.max(0, numOr(patch.labourHours));
    if (patch.downtimeMin !== undefined) wo.downtimeMin = Math.max(0, numOr(patch.downtimeMin));
    if (Array.isArray(patch.spares)) {
        wo.spares = patch.spares.slice(0, 50).map((s) => ({
            part: str(s.part, 80), qty: Math.max(0, numOr(s.qty, 1)), uom: str(s.uom, 12) || 'ea',
        })).filter((s) => s.part);
    }
    saveWO();
    return { ...wo, assetName: assetName(wo.assetId) };
}

// ---- logbook --------------------------------------------------------------
// Entries written before the operations/maintenance split are classified by
// their category so old records land in the right stream.
const inferLogType = (l) => l.logType
    || (LOG_CATEGORIES_BY_TYPE.MAINTENANCE.includes(l.category) ? 'MAINTENANCE' : 'OPERATIONS');
// Older entries used the generic 'OPERATIONS' category, which is no longer in
// the workover vocabulary — surface them as OTHER rather than dropping them.
const normalizeCategory = (l) => {
    const type = inferLogType(l);
    const allowed = LOG_CATEGORIES_BY_TYPE[type];
    return allowed.includes(l.category) ? l.category : (type === 'OPERATIONS' ? 'OTHER' : 'MAINTENANCE');
};

function listLogbook({ logType, date, shift, category, assetId, limit = 300 } = {}) {
    let rows = logbook.map((l) => ({ ...l, logType: inferLogType(l), category: normalizeCategory(l) }));
    if (logType) rows = rows.filter((l) => l.logType === logType);
    if (date) rows = rows.filter((l) => l.date === date);
    if (shift) rows = rows.filter((l) => l.shift === shift);
    if (category) rows = rows.filter((l) => l.category === category);
    if (assetId) rows = rows.filter((l) => l.assetId === assetId);
    rows.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return rows.slice(0, limit).map((l) => ({
        ...l,
        assetName: l.assetId ? assetName(l.assetId) : null,
        categoryLabel: LOG_CATEGORY_LABELS[l.category] || l.category,
    }));
}

function addLogEntry({ logType, date, shift, category, assetId, entry, by, workOrderNo } = {}) {
    if (!str(entry).trim()) throw Object.assign(new Error('entry text is required'), { status: 400 });
    const type = LOG_TYPES.includes(logType) ? logType : 'OPERATIONS';
    if (shift && !SHIFTS.includes(shift)) throw Object.assign(new Error('shift must be DAY or NIGHT'), { status: 400 });
    const allowed = LOG_CATEGORIES_BY_TYPE[type];
    const cat = category || allowed[0];
    if (!allowed.includes(cat)) {
        throw Object.assign(new Error(`category for a ${type} log must be one of ${allowed.join(', ')}`), { status: 400 });
    }
    const rec = {
        id: uid('log'), ts: nowIso(), date: /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : today(),
        logType: type, shift: shift || 'DAY', category: cat, assetId: validAsset(assetId),
        entry: str(entry, 4000), workOrderNo: str(workOrderNo, 20) || null, by: by || 'system',
    };
    logbook.push(rec);
    if (logbook.length > MAX) logbook = logbook.slice(-MAX);
    saveLog();
    return {
        ...rec,
        assetName: rec.assetId ? assetName(rec.assetId) : null,
        categoryLabel: LOG_CATEGORY_LABELS[rec.category] || rec.category,
    };
}

// ---- major overhauls ------------------------------------------------------
const withOvhProgress = (o) => {
    const ms = Array.isArray(o.milestones) ? o.milestones : [];
    const done = ms.filter((m) => m.done).length;
    return { ...o, assetName: assetName(o.assetId), milestonesDone: done, milestonesTotal: ms.length, progressPct: ms.length ? Math.round((done / ms.length) * 100) : 0 };
};

function listOverhauls({ status, assetId } = {}) {
    let rows = overhauls.slice();
    if (status) rows = rows.filter((o) => o.status === status);
    if (assetId) rows = rows.filter((o) => o.assetId === assetId);
    const RANK = { IN_PROGRESS: 0, PLANNED: 1, ON_HOLD: 2, COMPLETED: 3, CANCELLED: 4 };
    rows.sort((a, b) => (RANK[a.status] - RANK[b.status]) || String(a.plannedStart || '').localeCompare(String(b.plannedStart || '')));
    return rows.map(withOvhProgress);
}

function createOverhaul({ assetId, title, scope, plannedStart, plannedEnd, atHours, contractor, milestones, by } = {}) {
    if (!str(title).trim()) throw Object.assign(new Error('title is required'), { status: 400 });
    const ms = (Array.isArray(milestones) && milestones.length ? milestones : ['Planning & spares', 'Isolate & strip', 'Inspect', 'Rebuild', 'Commission'])
        .slice(0, 30)
        .map((m) => ({ id: uid('ms'), name: str(typeof m === 'string' ? m : m.name, 80), done: false, doneAt: null }))
        .filter((m) => m.name);
    const o = {
        id: uid('ovh'), no: nextOvhNo(), assetId: validAsset(assetId), title: str(title, 160), scope: str(scope),
        status: 'PLANNED', plannedStart: str(plannedStart, 10) || today(), plannedEnd: str(plannedEnd, 10) || null,
        actualStart: null, actualEnd: null, atHours: atHours != null ? numOr(atHours) : null,
        contractor: str(contractor, 80), cost: null, findings: '', milestones: ms,
        by: by || 'system', createdAt: nowIso(),
    };
    overhauls.push(o);
    saveOvh();
    return withOvhProgress(o);
}

function updateOverhaul(id, patch = {}, by) {
    const o = overhauls.find((x) => x.id === id);
    if (!o) throw Object.assign(new Error('Unknown overhaul'), { status: 404 });
    if (patch.status !== undefined) {
        if (!OVERHAUL_STATUS.includes(patch.status)) throw Object.assign(new Error('invalid status'), { status: 400 });
        if (patch.status === 'IN_PROGRESS' && !o.actualStart) o.actualStart = nowIso();
        if (patch.status === 'COMPLETED') o.actualEnd = nowIso();
        if (patch.status !== 'COMPLETED') o.actualEnd = null;
        o.status = patch.status;
    }
    if (patch.title !== undefined) o.title = str(patch.title, 160);
    if (patch.scope !== undefined) o.scope = str(patch.scope);
    if (patch.findings !== undefined) o.findings = str(patch.findings);
    if (patch.contractor !== undefined) o.contractor = str(patch.contractor, 80);
    if (patch.plannedStart !== undefined) o.plannedStart = str(patch.plannedStart, 10);
    if (patch.plannedEnd !== undefined) o.plannedEnd = str(patch.plannedEnd, 10) || null;
    if (patch.cost !== undefined) o.cost = patch.cost === null || patch.cost === '' ? null : numOr(patch.cost);
    // Toggle a single milestone by id.
    if (patch.milestoneId !== undefined) {
        const m = (o.milestones || []).find((x) => x.id === patch.milestoneId);
        if (!m) throw Object.assign(new Error('Unknown milestone'), { status: 404 });
        m.done = patch.milestoneDone !== undefined ? !!patch.milestoneDone : !m.done;
        m.doneAt = m.done ? nowIso() : null;
        m.by = by || 'system';
    }
    saveOvh();
    return withOvhProgress(o);
}

// ---- roll-up for the maintenance dashboard --------------------------------
function getCmmsSummary() {
    const open = workOrders.filter((w) => w.status === 'OPEN' || w.status === 'IN_PROGRESS');
    return {
        workOrders: {
            open: open.length,
            breakdownOpen: open.filter((w) => w.type === 'BREAKDOWN').length,
            preventiveOpen: open.filter((w) => w.type === 'PREVENTIVE').length,
            p1Open: open.filter((w) => w.priority === 'P1').length,
            completed30d: workOrders.filter((w) => w.status === 'COMPLETED' && Date.parse(w.completedAt || 0) > Date.now() - 30 * 86400000).length,
            totalDowntimeMin30d: workOrders
                .filter((w) => Date.parse(w.completedAt || 0) > Date.now() - 30 * 86400000)
                .reduce((s, w) => s + numOr(w.downtimeMin), 0),
        },
        overhauls: {
            active: overhauls.filter((o) => o.status === 'IN_PROGRESS').length,
            planned: overhauls.filter((o) => o.status === 'PLANNED').length,
        },
        logbook: {
            today: logbook.filter((l) => l.date === today()).length,
            operationsToday: logbook.filter((l) => l.date === today() && inferLogType(l) === 'OPERATIONS').length,
            maintenanceToday: logbook.filter((l) => l.date === today() && inferLogType(l) === 'MAINTENANCE').length,
        },
    };
}

module.exports = {
    WO_TYPES, WO_STATUS, WO_PRIORITY, FAILURE_CODES, LOG_CATEGORIES, LOG_TYPES,
    LOG_CATEGORIES_BY_TYPE, LOG_CATEGORY_LABELS, SHIFTS, OVERHAUL_STATUS,
    listWorkOrders, createWorkOrder, updateWorkOrder,
    listLogbook, addLogEntry,
    listOverhauls, createOverhaul, updateOverhaul,
    getCmmsSummary,
};
