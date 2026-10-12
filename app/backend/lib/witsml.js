'use strict';
// WITSML 1.4.1.1 export (edge -> operator / office / CMF hand-over). Export only.
//
// Documents: wells, wellbores, logs (time-indexed, from the TimescaleDB
// historian), messages (alarm history) and opsReports (daily activity report).
// Element order follows the 1.4.1.1 XSD sequences; the test suite validates
// the output against the official Energistics schemas.
const NS = 'http://www.witsml.org/schemas/1series';
const VER = '1.4.1.1';

const esc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
// uid attributes: no spaces, at most 64 characters.
const uidOf = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64);
// nameString is limited to 64 characters, descriptionString to 256.
const nm = (s) => (s === undefined || s === null ? s : String(s).slice(0, 64));
const el = (name, value, attrs = '') => (value === undefined || value === null || value === '' ? '' : `<${name}${attrs}>${esc(value)}</${name}>`);
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const measure = (name, value, uom) => (num(value) === null ? '' : `<${name} uom="${esc(uom)}">${Number(value)}</${name}>`);

/** Offset of this PC's clock, as a WITSML timeZone ("Z" or "+05:30"). */
function localTimeZone(date = new Date()) {
    const off = -date.getTimezoneOffset();
    if (off === 0) return 'Z';
    const a = Math.abs(off);
    return `${off > 0 ? '+' : '-'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** WITSML timestamp (requires a zone). Date-only input becomes local midnight. */
function timestamp(value, tz = localTimeZone()) {
    if (!value) return null;
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00${tz}`;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// App unit -> Energistics unit-of-measure symbol. Tonne-force is "Mgf"
// (megagram-force); there is no bare "tonf" in the dictionary.
const UOM = {
    t: 'Mgf', ton: 'Mgf', tons: 'Mgf', tonne: 'Mgf', tonnes: 'Mgf',
    'daN.m': 'daN.m', 'daN*m': 'daN.m', 'daN·m': 'daN.m', DaNm: 'daN.m', 'kN.m': 'kN.m', 'N.m': 'N.m',
    bar: 'bar', psi: 'psi', kPa: 'kPa', MPa: 'MPa',
    rpm: 'rpm', spm: '1/min',
    m: 'm', mm: 'mm', ft: 'ft', 'm/h': 'm/h', 'mm/sec': 'mm/s', 'mm/s': 'mm/s',
    m3: 'm3', 'm³': 'm3', 'm^3': 'm3', L: 'L', 'L/min': 'L/min', 'Lt/min': 'L/min', 'L/h': 'L/h',
    C: 'degC', '°C': 'degC', degC: 'degC',
    '%': '%', h: 'h', s: 's', min: 'min', V: 'V', A: 'A', kW: 'kW', Hz: 'Hz',
};
const uomOf = (unit) => (unit ? (UOM[unit] || UOM[String(unit).trim()] || String(unit).trim()) : '');

// Common drilling mnemonics for the headline channels; everything else gets a
// generated mnemonic derived from its metric name.
const MNEMONICS = {
    'drawworks.hook_load': 'HKLA', 'drawworks.block_position': 'BPOS', 'drilling.wob': 'WOBA',
    'drilling.rop': 'ROPA', 'drilling.hole_depth': 'DMEA', 'drilling.bit_depth': 'DBTM',
    'htd.rpm': 'RPMA', 'htd.torque': 'TQA', 'drilling.torque': 'STQA',
    'mudpump.pressure': 'SPPA', 'mudpump.spm': 'SPMT', 'mudpump.flow_in': 'MFIA', 'mudpump.flow_out': 'MFOP',
    'fluid.total_tank_volume': 'TVA', 'fluid.tank_gain_loss': 'TVGL', 'fluid.trip_tank': 'TTVA',
    'wellhead.tubing_pressure': 'TBGP', 'wellhead.casing_pressure': 'CSGP', 'wellhead.wellhead_pressure': 'WHP',
    'bop.accumulator_pressure': 'ACCP', 'bop.manifold_pressure': 'MANP', 'bop.annular_pressure': 'ANNP',
};
// Default channel set for a log when none is requested.
const DEFAULT_LOG_METRICS = Object.keys(MNEMONICS);

/** Unique WITSML mnemonics (<= 32 chars) for a list of metric names. */
function mnemonicsFor(metrics) {
    const used = new Set(['TIME']);
    const out = new Map();
    for (const metric of metrics) {
        const suffix = /_(min|max)$/.exec(metric);
        const base = suffix ? metric.slice(0, -suffix[0].length) : metric;
        let m = MNEMONICS[base] || base.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (suffix) m = `${m}_${suffix[1].toUpperCase()}`;
        m = m.slice(0, 32);
        let candidate = m;
        for (let i = 2; used.has(candidate); i++) candidate = `${m.slice(0, 32 - String(i).length - 1)}_${i}`;
        used.add(candidate);
        out.set(metric, candidate);
    }
    return out;
}

const doc = (root, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<${root} xmlns="${NS}" version="${VER}">\n${body}\n</${root}>\n`;

// ---- well / wellbore ------------------------------------------------------
// `well` is an edge well record (wells.json): { id, name, uwi, field, operator,
// country, spudDate, plannedTdM, status, ... }.
const wellUid = (well) => uidOf(well.id || well.name);
const wellboreUid = (well) => `${wellUid(well)}-wb1`;

function wells(well, { timeZone = localTimeZone() } = {}) {
    const w = well || {};
    const statusWell = w.status === 'active' ? 'working over' : 'unknown';
    const parts = [
        el('name', nm(w.name || 'UNNAMED')),
        el('numGovt', w.uwi),
        el('field', nm(w.field)),
        el('country', w.country ? String(w.country).slice(0, 32) : ''),
        el('timeZone', timeZone),
        el('operator', nm(w.operator)),
        el('statusWell', statusWell),
        el('dTimSpud', timestamp(w.spudDate, timeZone)),
    ];
    return doc('wells', `  <well uid="${wellUid(w)}">${parts.join('')}</well>`);
}

/** One wellbore per edge well (workover rigs work the existing hole). */
function wellbores(well, { holeDepthM, bitDepthM } = {}) {
    const w = well || {};
    const parts = [
        el('nameWell', nm(w.name || 'UNNAMED')),
        el('name', nm(w.name || 'UNNAMED')),
        el('statusWellbore', w.status === 'active' ? 'working over' : 'unknown'),
        el('isActive', w.status === 'active' ? 'true' : 'false'),
        measure('md', holeDepthM, 'm'),
        measure('mdBit', bitDepthM, 'm'),
        measure('mdPlanned', w.plannedTdM, 'm'),
    ];
    return doc('wellbores', `  <wellbore uidWell="${wellUid(w)}" uid="${wellboreUid(w)}">${parts.join('')}</wellbore>`);
}

// ---- log ------------------------------------------------------------------
/**
 * Time-indexed log.
 * @param well   edge well record (or a header-like object with a name)
 * @param channels [{ metric, unit, label }]
 * @param rows   wide rows [{ time, [metric]: value }] in time order
 */
function logs(well, channels, rows, { name = 'Edge time log', uid, serviceCompany, intervalLabel } = {}) {
    const w = well || {};
    const mnem = mnemonicsFor(channels.map((c) => c.metric));
    const first = rows.length ? rows[0].time : null;
    const last = rows.length ? rows[rows.length - 1].time : null;
    const curveInfo = [
        `<logCurveInfo uid="TIME"><mnemonic>TIME</mnemonic><unit>s</unit>${el('minDateTimeIndex', first)}${el('maxDateTimeIndex', last)}`
        + '<curveDescription>Time index</curveDescription><typeLogData>date time</typeLogData></logCurveInfo>',
        ...channels.map((c) => {
            const m = mnem.get(c.metric);
            return `<logCurveInfo uid="${uidOf(m)}"><mnemonic>${esc(m)}</mnemonic>${el('unit', uomOf(c.unit))}`
                + `${el('curveDescription', `${c.label || c.metric} [${c.metric}]`.slice(0, 256))}<typeLogData>double</typeLogData></logCurveInfo>`;
        }),
    ];
    const mnemonicList = ['TIME', ...channels.map((c) => mnem.get(c.metric))].join(',');
    const unitList = ['s', ...channels.map((c) => uomOf(c.unit))].join(',');
    const data = rows.map((r) => `<data>${[r.time, ...channels.map((c) => {
        const v = num(r[c.metric]);
        return v === null ? '' : String(Number(v.toFixed(6)));
    })].join(',')}</data>`);
    const body = [
        el('nameWell', nm(w.name || 'UNNAMED')),
        el('nameWellbore', nm(w.name || 'UNNAMED')),
        el('name', nm(name)),
        el('objectGrowing', 'false'),
        el('serviceCompany', nm(serviceCompany)),
        el('creationDate', new Date().toISOString()),
        el('description', intervalLabel),
        el('indexType', 'date time'),
        el('startDateTimeIndex', first),
        el('endDateTimeIndex', last),
        el('direction', 'increasing'),
        el('indexCurve', 'TIME'),
        ...curveInfo,
        `<logData><mnemonicList>${esc(mnemonicList)}</mnemonicList><unitList>${esc(unitList)}</unitList>\n${data.join('\n')}\n</logData>`,
    ].join('');
    return doc('logs', `  <log uidWell="${wellUid(w)}" uidWellbore="${wellboreUid(w)}" uid="${uidOf(uid || `log-${wellUid(w)}`)}">${body}</log>`);
}

// ---- messages (alarm history) ----------------------------------------------
const SEVERITY = { P1: 'major', P2: 'minor', P3: 'minor' };
/** events: alarm history entries { ts, type: RAISE|ACK|RTN|RTN_UNACK, key, label, priority, condition, value, limit, by } */
function messages(well, events) {
    const w = well || {};
    const items = (events || []).filter((e) => timestamp(e.ts)).map((e, i) => {
        const raised = e.type === 'RAISE';
        const text = raised
            ? `${e.label || e.key}: ${e.condition || 'ALARM'}${e.value != null ? ` value ${e.value}` : ''}${e.limit != null ? ` limit ${e.limit}` : ''}`
            : `${e.label || e.key}: ${e.type === 'ACK' ? `acknowledged${e.by ? ` by ${e.by}` : ''}` : 'returned to normal'}`;
        const parts = [
            el('nameWell', nm(w.name || 'UNNAMED')),
            el('nameWellbore', nm(w.name || 'UNNAMED')),
            el('name', nm(`${e.type} ${e.key || ''}`.trim())),
            el('dTim', timestamp(e.ts)),
            el('typeMessage', raised ? 'alarm' : 'event'),
            el('messageText', text),
            el('severity', raised ? (SEVERITY[e.priority] || 'unknown') : ''),
        ];
        const uid = uidOf(`msg-${Date.parse(e.ts)}-${e.key || i}-${e.type || ''}`);
        return `  <message uidWell="${wellUid(w)}" uidWellbore="${wellboreUid(w)}" uid="${uid}">${parts.join('')}</message>`;
    });
    return doc('messages', items.join('\n'));
}

// ---- opsReport (daily activity report) ---------------------------------------
/**
 * @param report workover daily report { date, entries: [{code,label,productive,npt,start,end,durationSec,depth,source}], header }
 */
function opsReports(well, report, { rigName, holeDepthM, timeZone = localTimeZone() } = {}) {
    const w = well || {};
    const r = report || {};
    const entries = Array.isArray(r.entries) ? r.entries : [];
    const nptHours = entries.filter((e) => !e.productive).reduce((s, e) => s + (e.durationSec || 0), 0) / 3600;
    const prodHours = entries.filter((e) => e.productive).reduce((s, e) => s + (e.durationSec || 0), 0) / 3600;
    const activities = entries.map((e, i) => {
        const parts = [
            el('dTimStart', timestamp(e.start)),
            el('dTimEnd', timestamp(e.end)),
            measure('duration', e.durationSec, 's'),
            measure('md', e.depth, 'm'),
            `<proprietaryCode namingSystem="AHWR-EDGE">${esc(e.code)}</proprietaryCode>`,
            el('detailActivity', e.label ? String(e.label).slice(0, 50) : ''),
            el('typeActivityClass', e.productive ? 'planned' : 'downtime'),
            el('productive', e.productive ? 'true' : 'false'),
            el('itemState', 'actual'),
            el('comments', e.npt && e.npt.reason ? `NPT: ${e.npt.reason}${e.source ? ` (${e.source})` : ''}` : (e.source ? `source: ${e.source}` : '')),
        ];
        return `<activity uid="act-${i + 1}">${parts.join('')}</activity>`;
    });
    const date = r.date || new Date().toISOString().slice(0, 10);
    const body = [
        el('nameWell', nm(w.name || 'UNNAMED')),
        el('nameWellbore', nm(w.name || 'UNNAMED')),
        el('name', `Daily operations ${date}`),
        el('rig', nm(rigName)),
        el('dTim', timestamp(date, timeZone)),
        measure('mdReport', holeDepthM, 'm'),
        ...activities,
        el('numAFE', w.jobNo ? String(w.jobNo).slice(0, 32) : ''),
        el('sum24Hr', `${entries.length} activities; productive ${prodHours.toFixed(1)} h, NPT ${nptHours.toFixed(1)} h`),
    ].join('');
    return doc('opsReports', `  <opsReport uidWell="${wellUid(w)}" uidWellbore="${wellboreUid(w)}" uid="${uidOf(`ops-${wellUid(w)}-${date}`)}">${body}</opsReport>`);
}

module.exports = {
    wells, wellbores, logs, messages, opsReports,
    mnemonicsFor, uomOf, localTimeZone, timestamp, DEFAULT_LOG_METRICS, MNEMONICS,
};
