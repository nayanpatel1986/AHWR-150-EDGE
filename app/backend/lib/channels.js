'use strict';
// Channel dictionary: the Energistics identity and metadata of every metric the
// edge records, as WITSML 2.1 Channel objects and ETP v1.2 channel metadata need
// them (and as the CMF receives them with the sync batches):
//   uuid            name-based UUID (lib/ids.js), identical at the edge and the CMF
//   mnemonic        standard drilling mnemonic or a unique one derived from the metric
//   uom             Energistics unit of the PRESENTED values (lib/units.js: standpipe
//                   pressure is stored in bar and presented in psi)
//   storedUnit      unit of the values in the historian
//   factor          presented = stored * factor
//   propertyKind    Energistics PWLS property kind (lib/propertyKinds.json)
//   unitSource      how the unit was found: catalog | plc-bit (S7 .X / coil / limit
//                   switch) | plc-enum-flag ("0=..., 1=...") | label (unit written in the
//                   PLC tag name) | status (enumerated or status code) | unknown
const ids = require('./ids');
const units = require('./units');
const witsml = require('./witsml');
const PWLS = require('./propertyKinds.json');

const kind = (title) => {
    const k = PWLS.kinds[title];
    if (!k) throw new Error(`property kind not in lib/propertyKinds.json: ${title}`);
    return { uuid: k.uuid, title: k.title };
};

// App / PLC unit spellings -> Energistics unit symbols (UnitOfMeasure, common v2.3).
const UOM = {
    t: 'Mgf', ton: 'Mgf', tons: 'Mgf', tonne: 'Mgf', tonnes: 'Mgf', Ton: 'Mgf',   // tonne-force
    'daN.m': 'daN.m', 'daN*m': 'daN.m', 'daN·m': 'daN.m', daNm: 'daN.m', DaNm: 'daN.m', 'kN.m': 'kN.m', 'N.m': 'N.m',
    kN: 'kN', kgf: 'kgf',
    bar: 'bar', Bar: 'bar', psi: 'psi', kPa: 'kPa', MPa: 'MPa',
    rpm: 'rpm', RPM: 'rpm', spm: '1/min', SPM: '1/min', '1/min': '1/min',
    m: 'm', mm: 'mm', ft: 'ft', 'm/h': 'm/h', 'mm/sec': 'mm/s', 'mm/s': 'mm/s',
    m3: 'm3', 'm³': 'm3', 'm^3': 'm3', L: 'L', 'L/min': 'L/min', 'Lt/min': 'L/min', 'L/h': 'L/h',
    C: 'degC', '°C': 'degC', degC: 'degC', DegC: 'degC',
    '%': '%', h: 'h', hrs: 'h', Hours: 'h', s: 's', min: 'min',
    V: 'V', A: 'A', kW: 'kW', Hz: 'Hz', deg: 'dega', dega: 'dega',
    state: 'Euc', code: 'Euc', Euc: 'Euc',
};
// Quantity class of each Energistics unit used here (for the fallback property kind).
const QUANTITY = {
    bar: 'pressure', psi: 'pressure', kPa: 'pressure', MPa: 'pressure',
    Mgf: 'force', kN: 'force', kgf: 'force',
    m: 'length', mm: 'length', ft: 'length', m3: 'volume', L: 'volume',
    degC: 'temperature', rpm: 'angular velocity', h: 'time', min: 'time', s: 'time',
    kW: 'power', Hz: 'frequency', '1/min': 'frequency', V: 'electric potential', A: 'electric current',
    'L/min': 'flowrate', 'L/h': 'flowrate', 'm/h': 'velocity', 'mm/s': 'velocity',
    '%': 'fraction', 'daN.m': 'torque', 'kN.m': 'torque', 'N.m': 'torque',
};
// Property kinds for known metrics (PWLS titles).
const METRIC_KIND = {
    'drawworks.hook_load': 'hook load', 'drilling.hook_load': 'hook load',
    'drilling.wob': 'weight on bit',
    'drawworks.block_position': 'block height', 'acs.block_position': 'block height',
    'drilling.hole_depth': 'measured depth', 'drilling.bit_depth': 'bit depth',
    'drilling.rop': 'penetration rate',
    'htd.rpm': 'rotary speed', 'drilling.rpm': 'rotary speed',
    'htd.torque': 'surface torque', 'drilling.torque': 'surface torque',
    'pct.makeup_torque': 'makeup torque', 'pct.last_torque': 'makeup torque',
    'mudpump.pressure': 'standpipe pressure', 'mudpump.delta_pressure': 'differential pressure',
    'mudpump.spm': 'stroke rate', 'mudpump.flow_in': 'mud flow in',
    'fluid.total_tank_volume': 'mud tank volume',
    'wellhead.wellhead_pressure': 'wellhead pressure',
};
const PATTERN_KIND = [
    [/^cat_engine(_\d+)?\.oil_pressure$/, 'engine oil pressure'],
    [/^cat_engine(_\d+)?\.oil_temp$/, 'engine oil temperature'],
    [/^cat_engine(_\d+)?\.coolant_temp$/, 'coolant temperature'],
    [/^cat_engine(_\d+)?\.rpm$/, 'motor speed'],
    [/(run_hours|working_hours)$/, 'operating time'],
];
// A unit written at the end of a PLC tag name or label: "Pump2_1_Press_SP-bar",
// "HPU Pilot ActLSPress bar", "ACS Crownsaver in mm".
const LABEL_UNIT_RE = /(?:[-_ ]|\bin\s)(bar|psi|%|rpm|degC|°C|mm\/sec|mm|m3|m³|Lt\/min|L\/min|L\/h|m\/h|kW|kN|Ton|daN\*m|daNm|spm|Hz|hr)\s*$/i;
// An enumeration in a PLC tag name: "Emergency Stop-0=NORMAL, 1=ESD ACTIVE".
const ENUM_RE = /(?:^|[-\s,(:])(-?\d+)\s*=\s*[A-Za-z]/g;
const LABEL_UNIT_CANON = { bar: 'bar', psi: 'psi', '%': '%', rpm: 'rpm', degc: 'degC', '°c': 'degC', 'mm/sec': 'mm/s', mm: 'mm', m3: 'm3', 'm³': 'm3', 'lt/min': 'L/min', 'l/min': 'L/min', 'l/h': 'L/h', 'm/h': 'm/h', kw: 'kW', kn: 'kN', ton: 'Mgf', 'dan*m': 'daN.m', danm: 'daN.m', spm: '1/min', hz: 'Hz', hr: 'h' };
// Integer status / mode / code words.
const STATUS_RE = /(status|statuscode|state|mode|code|step|stage|sequence|counter)(\d*)$/i;

function unitOf(metric, row, isBoolean) {
    const stored = units.storedUnit(metric) || row.unit || null;
    if (stored && UOM[stored]) return { stored, uom: UOM[stored], source: 'catalog' };
    if (isBoolean) return { stored: null, uom: 'Euc', source: 'plc-bit' };
    const texts = [row.plcTag, row.label].filter(Boolean).map(String);
    // Enumerated values: two states (0/1) are a flag, more are a status code.
    for (const t of texts) {
        const values = new Set([...t.matchAll(ENUM_RE)].map((x) => Number(x[1])));
        if (values.size) {
            const flag = [...values].every((v) => v === 0 || v === 1);
            return { stored: null, uom: 'Euc', source: flag ? 'plc-enum-flag' : 'status' };
        }
    }
    for (const t of [...texts, metric.replace(/_/g, ' ')]) {
        const m = LABEL_UNIT_RE.exec(t);
        const u = m && LABEL_UNIT_CANON[m[1].toLowerCase()];
        if (u) return { stored: u === 'Mgf' ? 't' : u, uom: u, source: 'label' };
    }
    const tail = metric.split('.').pop();
    if (STATUS_RE.test(tail) || texts.some((t) => STATUS_RE.test(t.replace(/\s+/g, '')))) return { stored: null, uom: 'Euc', source: 'status' };
    return { stored: stored || null, uom: 'Euc', source: 'unknown' };
}

function propertyKindOf(metric, unit) {
    if (METRIC_KIND[metric]) return kind(METRIC_KIND[metric]);
    for (const [re, title] of PATTERN_KIND) if (re.test(metric)) return kind(title);
    if (unit.source === 'plc-bit' || unit.source === 'plc-enum-flag') return kind('flag');
    if (unit.source === 'status') return kind('status');
    const q = QUANTITY[unit.uom];
    return kind(q || 'unknown');
}

/**
 * The tag rows every recorded metric comes from: the EDR catalog (display label,
 * catalog unit, raw PLC tag name), the PLC field map, and any configured PLC tag
 * without a mapping (stored as "<group>.<tag>").
 * @returns [{ metric, label, unit, group, plcTag }]
 */
function tagRows({ catalog, fieldMap = {}, mapping = null }) {
    const rows = new Map();
    for (const category of (catalog && catalog.categories) || []) {
        for (const field of category.fields || []) {
            // The catalog unit is the display unit; tags hold the stored unit (as at the CMF).
            const metric = `${category.id}.${field.id}`;
            rows.set(metric, { metric, label: field.label, unit: units.storedUnit(metric) || field.unit || null, group: category.label, plcTag: field.plcTag || null });
        }
    }
    for (const [raw, mapped] of Object.entries(fieldMap)) {
        const metric = `${mapped.meas}.${mapped.field}`;
        if (!rows.has(metric)) rows.set(metric, { metric, label: raw, unit: units.storedUnit(metric), group: mapped.meas, plcTag: raw });
    }
    for (const [raw, e] of (mapping && mapping.entries) || []) {
        if (!rows.has(e.metric)) rows.set(e.metric, { metric: e.metric, label: raw, unit: null, group: e.metric.split('.')[0], plcTag: raw });
    }
    return [...rows.values()];
}

/**
 * Build the dictionary.
 * @param rigId      the rig's DEVICE_ID
 * @param rows       [{ metric, label, unit, group }] (the tag dictionary)
 * @param isBoolean  (metric) -> true when the metric is a PLC bit / limit switch
 * @returns Map metric -> entry
 */
function buildDictionary({ rigId, rows, isBoolean = () => false }) {
    const unique = new Map();
    for (const r of rows) if (r && r.metric && !unique.has(r.metric)) unique.set(r.metric, r);
    const mnemonics = witsml.mnemonicsFor([...unique.keys()]);
    const out = new Map();
    for (const [metric, row] of unique) {
        const bool = !!isBoolean(metric);
        const unit = unitOf(metric, row, bool);
        const p = units.presentation(metric);
        const uom = p ? UOM[p.unit] : unit.uom;
        out.set(metric, {
            metric,
            uuid: ids.channel(rigId, metric),
            mnemonic: mnemonics.get(metric),
            label: row.label || metric,
            group: row.group || metric.split('.')[0],
            storedUnit: unit.stored,
            uom,
            factor: p ? p.factor : 1,
            dataKind: 'double',
            isBoolean: bool,
            propertyKind: propertyKindOf(metric, { ...unit, uom }),
            unitSource: unit.source,
        });
    }
    return out;
}

/** The PWLS property kinds referenced by a dictionary, with their ancestors. */
function propertyKindsUsed(dictionary) {
    const titles = new Set();
    const add = (t) => {
        if (titles.has(t)) return;
        titles.add(t);
        const k = PWLS.kinds[t];
        if (k && k.parent.title !== t) add(k.parent.title);
    };
    for (const e of dictionary.values()) add(e.propertyKind.title);
    return [...titles].map((t) => PWLS.kinds[t]);
}

module.exports = { tagRows, buildDictionary, propertyKindsUsed, UOM, QUANTITY, PWLS, kind };
