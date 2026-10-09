'use strict';
// Instrument register + calibration control.
//
// A workover rig's readings are only as trustworthy as the instruments behind
// them, so this module keeps a register of every measuring device (tag, type,
// make/model, serial, range, accuracy, the asset it serves) and its calibration
// history. Each calibration record captures the classic as-found / as-left
// pair, the reference standard used, the result and the certificate number —
// which is what an audit actually asks for.
//
// Calibration status is derived from the last calibration date and the
// instrument's interval, so "due soon" and "overdue" need no manual upkeep.
const { readJson, writeJson } = require('./persist');
const { ASSETS } = require('./maintenance');

const INSTR_FILE = 'instruments.json';
const CAL_FILE = 'instrument_calibrations.json';
const MAX = 5000;

const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const today = () => nowIso().slice(0, 10);
let _id = 0;
const uid = (p) => `${p}_${Date.now().toString(36)}_${(++_id).toString(36)}`;
const str = (v, max = 200) => (v == null ? '' : String(v).slice(0, max));
const numOrNull = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

const INSTRUMENT_TYPES = [
    'PRESSURE_GAUGE', 'PRESSURE_TRANSMITTER', 'LOAD_CELL', 'WEIGHT_INDICATOR',
    'FLOW_METER', 'LEVEL_TRANSMITTER', 'TEMPERATURE_SENSOR', 'RPM_SENSOR',
    'TORQUE_SENSOR', 'DEPTH_ENCODER', 'GAS_DETECTOR', 'PRESSURE_RELIEF_VALVE',
    'MULTIMETER', 'TEST_GAUGE', 'OTHER',
];
const CAL_RESULTS = ['PASS', 'ADJUSTED', 'FAIL', 'LIMITED_USE'];
const INSTRUMENT_STATUS = ['ACTIVE', 'OUT_OF_SERVICE', 'REMOVED'];
const DUE_SOON_DAYS = 30;

let instruments = readJson(INSTR_FILE, null);
let calibrations = readJson(CAL_FILE, null);

const saveInstr = () => writeJson(INSTR_FILE, instruments).catch(() => {});
const saveCal = () => writeJson(CAL_FILE, calibrations).catch(() => {});

// A small, clearly-labelled starter register so the module is explorable.
if (!Array.isArray(instruments)) {
    const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    instruments = [
        { id: uid('ins'), tag: 'PI-101', name: 'Standpipe Pressure Gauge', type: 'PRESSURE_GAUGE', assetId: 'mudpump', make: 'WIKA', model: '232.50', serial: 'WK-88213', rangeMin: 0, rangeMax: 400, unit: 'bar', accuracy: '±1.0 % FS', location: 'Standpipe manifold', intervalDays: 365, lastCalDate: ago(200), status: 'ACTIVE', by: 'seed', createdAt: nowIso() },
        { id: uid('ins'), tag: 'WI-201', name: 'Weight Indicator / Load Cell', type: 'LOAD_CELL', assetId: 'drawworks', make: 'Martin-Decker', model: 'MD-500', serial: 'MD-4471', rangeMin: 0, rangeMax: 250, unit: 't', accuracy: '±0.5 % FS', location: 'Deadline anchor', intervalDays: 180, lastCalDate: ago(170), status: 'ACTIVE', by: 'seed', createdAt: nowIso() },
        { id: uid('ins'), tag: 'TI-301', name: 'HPU Oil Temperature Sensor', type: 'TEMPERATURE_SENSOR', assetId: 'hpu', make: 'Pt100', model: 'RTD-4W', serial: 'RT-9920', rangeMin: -20, rangeMax: 150, unit: '°C', accuracy: '±0.5 °C', location: 'HPU reservoir', intervalDays: 365, lastCalDate: ago(400), status: 'ACTIVE', by: 'seed', createdAt: nowIso() },
    ];
    saveInstr();
}
if (!Array.isArray(calibrations)) {
    calibrations = [];
    saveCal();
}

const assetName = (id) => (ASSETS.find((a) => a.id === id) || {}).name || null;
const addDays = (dateStr, days) => {
    const t = Date.parse(`${dateStr}T00:00:00Z`);
    if (!Number.isFinite(t)) return null;
    return new Date(t + days * 86400000).toISOString().slice(0, 10);
};

// Derive calibration status from the last calibration + interval.
function withStatus(i) {
    const nextDue = i.lastCalDate && i.intervalDays ? addDays(i.lastCalDate, i.intervalDays) : null;
    let calStatus = 'UNKNOWN';
    let daysToDue = null;
    if (nextDue) {
        daysToDue = Math.round((Date.parse(`${nextDue}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86400000);
        calStatus = daysToDue < 0 ? 'OVERDUE' : (daysToDue <= DUE_SOON_DAYS ? 'DUE_SOON' : 'VALID');
    }
    if (i.status !== 'ACTIVE') calStatus = 'OUT_OF_SERVICE';
    return {
        ...i,
        assetName: assetName(i.assetId),
        nextDueDate: nextDue,
        daysToDue,
        calStatus,
        calibrationCount: calibrations.filter((c) => c.instrumentId === i.id).length,
    };
}

const RANK = { OVERDUE: 0, DUE_SOON: 1, UNKNOWN: 2, VALID: 3, OUT_OF_SERVICE: 4 };

function listInstruments({ type, assetId, calStatus } = {}) {
    let rows = instruments.map(withStatus);
    if (type) rows = rows.filter((i) => i.type === type);
    if (assetId) rows = rows.filter((i) => i.assetId === assetId);
    if (calStatus) rows = rows.filter((i) => i.calStatus === calStatus);
    rows.sort((a, b) => (RANK[a.calStatus] - RANK[b.calStatus]) || String(a.tag).localeCompare(String(b.tag)));
    return rows;
}

function createInstrument(body = {}, by) {
    const tag = str(body.tag, 40).trim();
    if (!tag) throw Object.assign(new Error('instrument tag is required'), { status: 400 });
    if (instruments.some((i) => i.tag.toLowerCase() === tag.toLowerCase())) {
        throw Object.assign(new Error(`instrument tag ${tag} already exists`), { status: 400 });
    }
    if (body.type && !INSTRUMENT_TYPES.includes(body.type)) throw Object.assign(new Error('invalid instrument type'), { status: 400 });
    if (body.lastCalDate && !isDate(body.lastCalDate)) throw Object.assign(new Error('lastCalDate must be YYYY-MM-DD'), { status: 400 });
    const rec = {
        id: uid('ins'), tag,
        name: str(body.name, 120) || tag,
        type: body.type || 'OTHER',
        assetId: ASSETS.some((a) => a.id === body.assetId) ? body.assetId : null,
        make: str(body.make, 60), model: str(body.model, 60), serial: str(body.serial, 60),
        rangeMin: numOrNull(body.rangeMin), rangeMax: numOrNull(body.rangeMax),
        unit: str(body.unit, 16), accuracy: str(body.accuracy, 40),
        location: str(body.location, 120),
        intervalDays: Math.max(1, Number(body.intervalDays) || 365),
        lastCalDate: isDate(body.lastCalDate) ? body.lastCalDate : null,
        status: INSTRUMENT_STATUS.includes(body.status) ? body.status : 'ACTIVE',
        by: by || 'system', createdAt: nowIso(),
    };
    instruments.push(rec);
    if (instruments.length > MAX) instruments = instruments.slice(-MAX);
    saveInstr();
    return withStatus(rec);
}

function updateInstrument(id, patch = {}) {
    const i = instruments.find((x) => x.id === id);
    if (!i) throw Object.assign(new Error('Unknown instrument'), { status: 404 });
    if (patch.type !== undefined) {
        if (!INSTRUMENT_TYPES.includes(patch.type)) throw Object.assign(new Error('invalid instrument type'), { status: 400 });
        i.type = patch.type;
    }
    if (patch.status !== undefined) {
        if (!INSTRUMENT_STATUS.includes(patch.status)) throw Object.assign(new Error('invalid status'), { status: 400 });
        i.status = patch.status;
    }
    ['name', 'make', 'model', 'serial', 'unit', 'accuracy', 'location'].forEach((k) => {
        if (patch[k] !== undefined) i[k] = str(patch[k], 120);
    });
    if (patch.assetId !== undefined) i.assetId = ASSETS.some((a) => a.id === patch.assetId) ? patch.assetId : null;
    if (patch.rangeMin !== undefined) i.rangeMin = numOrNull(patch.rangeMin);
    if (patch.rangeMax !== undefined) i.rangeMax = numOrNull(patch.rangeMax);
    if (patch.intervalDays !== undefined) i.intervalDays = Math.max(1, Number(patch.intervalDays) || 365);
    saveInstr();
    return withStatus(i);
}

const listCalibrations = ({ instrumentId, limit = 300 } = {}) => {
    let rows = calibrations;
    if (instrumentId) rows = rows.filter((c) => c.instrumentId === instrumentId);
    return rows.slice(-Number(limit) || -300).reverse();
};

// Record a calibration: as-found / as-left, reference standard, result, cert.
function addCalibration(instrumentId, body = {}, by) {
    const i = instruments.find((x) => x.id === instrumentId);
    if (!i) throw Object.assign(new Error('Unknown instrument'), { status: 404 });
    const result = body.result || 'PASS';
    if (!CAL_RESULTS.includes(result)) throw Object.assign(new Error(`result must be one of ${CAL_RESULTS.join(', ')}`), { status: 400 });
    const date = isDate(body.date) ? body.date : today();

    const rec = {
        id: uid('cal'), instrumentId, instrumentTag: i.tag, instrumentName: i.name,
        date, result,
        asFound: str(body.asFound, 120), asLeft: str(body.asLeft, 120),
        referenceStd: str(body.referenceStd, 120),      // master gauge / standard used
        certificateNo: str(body.certificateNo, 60),
        calibratedBy: str(body.calibratedBy, 80) || (by || 'system'),
        points: Array.isArray(body.points)
            ? body.points.slice(0, 20).map((p) => ({
                applied: numOrNull(p.applied), found: numOrNull(p.found), left: numOrNull(p.left),
            })).filter((p) => p.applied != null)
            : [],
        notes: str(body.notes, 1000),
        by: by || 'system', ts: nowIso(),
    };
    calibrations.push(rec);
    if (calibrations.length > MAX) calibrations = calibrations.slice(-MAX);
    saveCal();

    // A calibration resets the instrument's clock (unless it failed outright).
    if (result !== 'FAIL') {
        i.lastCalDate = date;
    } else {
        i.status = 'OUT_OF_SERVICE';   // failed calibration -> pull it from service
    }
    saveInstr();

    return { calibration: rec, instrument: withStatus(i) };
}

function getSummary() {
    const rows = instruments.map(withStatus);
    return {
        total: rows.length,
        overdue: rows.filter((r) => r.calStatus === 'OVERDUE').length,
        dueSoon: rows.filter((r) => r.calStatus === 'DUE_SOON').length,
        valid: rows.filter((r) => r.calStatus === 'VALID').length,
        outOfService: rows.filter((r) => r.calStatus === 'OUT_OF_SERVICE').length,
    };
}

module.exports = {
    INSTRUMENT_TYPES, CAL_RESULTS, INSTRUMENT_STATUS, DUE_SOON_DAYS,
    listInstruments, createInstrument, updateInstrument,
    listCalibrations, addCalibration, getSummary,
};
