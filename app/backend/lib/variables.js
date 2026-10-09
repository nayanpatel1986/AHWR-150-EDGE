'use strict';
// Variables-mapping registry (protocol-aware). Every application variable
// (measurement.field) is mapped to a SOURCE with per-protocol connection config:
// s7comm / modbus / opcua / mqtt / derived / manual. Admins can edit any
// mapping, change its source, and ADD or DELETE variables. The registry can also
// GENERATE collector (Telegraf) input config per protocol. READ-ONLY ingestion —
// the app never writes to a PLC (monitoring-only).
const { readJson, writeJson } = require('./persist');
const { FIELD_MAP } = require('./fieldmap');

const MAP_FILE = 'variables_map.json';

// Source types + the editable connection fields the UI should render for each.
const SOURCE_SCHEMAS = {
    s7comm: { label: 'Siemens S7comm', fields: [{ key: 'endpoint', label: 'PLC endpoint', placeholder: '192.168.0.11:102' }, { key: 'address', label: 'DB address', placeholder: 'DB244.R72' }] },
    modbus: { label: 'Modbus TCP', fields: [{ key: 'host', label: 'Host' }, { key: 'port', label: 'Port', type: 'number', placeholder: '502' }, { key: 'registerType', label: 'Register type', type: 'select', options: ['holding', 'input', 'coil', 'discrete'] }, { key: 'register', label: 'Register', type: 'number' }, { key: 'dataType', label: 'Data type', type: 'select', options: ['INT16', 'UINT16', 'INT32', 'UINT32', 'FLOAT32'] }] },
    opcua: { label: 'OPC UA', fields: [{ key: 'endpoint', label: 'Endpoint', placeholder: 'opc.tcp://host:50000' }, { key: 'namespace', label: 'Namespace', placeholder: '3' }, { key: 'nodeId', label: 'Node identifier', placeholder: 'FastUInt1' }, { key: 'securityPolicy', label: 'Security policy', type: 'select', options: ['None', 'Basic256Sha256'] }] },
    mqtt: { label: 'MQTT', fields: [{ key: 'broker', label: 'Broker', placeholder: 'tcp://broker:1883' }, { key: 'topic', label: 'Topic' }, { key: 'jsonPath', label: 'JSON path', placeholder: '$.value' }] },
    derived: { label: 'Derived / computed', fields: [{ key: 'expression', label: 'Formula / note', placeholder: '(physics engine)' }] },
    manual: { label: 'Manual entry', fields: [] },
};
const SOURCE_TYPES = Object.keys(SOURCE_SCHEMAS);

// Physics-engine / computed outputs (not a raw sensor read).
const DERIVED = new Set(['drilling.wob', 'drilling.bit_depth', 'drilling.hole_depth']);

// Demo OPC UA nodes (served by the opc-plc simulator via the opcua collector).
const OPCUA_SEED = [
    { field: 'fast_counter', label: 'OPC UA Fast Counter', unit: '', node: 'FastUInt1' },
    { field: 'slow_counter', label: 'OPC UA Slow Counter', unit: '', node: 'SlowUInt1' },
    { field: 'random_uint', label: 'OPC UA Random Uint', unit: '', node: 'RandomUnsignedInt32' },
    { field: 'spike', label: 'OPC UA Spike Signal', unit: '', node: 'SpikeData' },
    { field: 'dip', label: 'OPC UA Dip Signal', unit: '', node: 'DipData' },
];

const UNIT_RULES = [
    [/-Ton\b/i, 't'], [/m\^3/i, 'm³'], [/-Bar\b/i, 'bar'], [/in bar\b/i, 'bar'],
    [/daN\*m/i, 'daN·m'], [/DaNm/i, 'daN·m'], [/-RPM\b|\brpm\b/i, 'rpm'], [/-m\/h\b/i, 'm/h'],
    [/Lt\/min/i, 'L/min'], [/-SPM\b/i, 'spm'], [/-Count\b/i, 'count'], [/in c\b/i, '°C'],
    [/-%|in %/i, '%'], [/\bmm\b/i, 'mm'], [/-m\b/i, 'm'], [/ton\/km/i, 't/km'],
];
function parseMeta(tagName) {
    const isEnum = /\d\s*=/.test(tagName);
    let unit = '';
    if (!isEnum) { for (const [re, u] of UNIT_RULES) if (re.test(tagName)) { unit = u; break; } }
    return { unit, kind: isEnum ? 'status' : 'analog' };
}
const titleCase = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// {tagName -> S7 address} from the persisted PLC config (shape-agnostic).
function addressMap() {
    const cfg = readJson('plc_config.json', null); const out = {};
    const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (typeof o.name === 'string' && typeof o.address === 'string') out[o.name] = o.address; Object.values(o).forEach(walk); } };
    if (cfg) walk(cfg); return out;
}

// Convenience display fields derived from the source object.
function display(v) {
    const s = v.source || {};
    let sourceName = '', address = '';
    switch (v.sourceType) {
        case 's7comm': sourceName = s.tag || v.sourceName || ''; address = s.address || ''; break;
        case 'opcua': sourceName = s.nodeId ? `ns=${s.namespace || '?'};s=${s.nodeId}` : ''; address = s.endpoint || ''; break;
        case 'modbus': sourceName = s.registerType ? `${s.registerType}:${s.register}` : ''; address = s.host ? `${s.host}:${s.port || 502}` : ''; break;
        case 'mqtt': sourceName = s.topic || ''; address = s.broker || ''; break;
        case 'derived': sourceName = s.expression || '(computed)'; break;
        default: break;
    }
    return { ...v, sourceName, address };
}

function buildSeed() {
    const addr = addressMap();
    const fromFieldMap = Object.entries(FIELD_MAP).map(([tag, m]) => {
        const id = `${m.meas}.${m.field}`;
        const { unit, kind } = parseMeta(tag);
        if (DERIVED.has(id)) return { id, measurement: m.meas, field: m.field, label: titleCase(m.field), unit, kind, sourceType: 'derived', source: { expression: '(physics engine)' }, scale: 1, offset: 0, enabled: true, custom: false };
        return { id, measurement: m.meas, field: m.field, label: titleCase(m.field), unit, kind, sourceType: 's7comm', source: { endpoint: '192.168.0.11:102', tag, address: addr[tag] || '' }, scale: 1, offset: 0, enabled: true, custom: false };
    });
    const fromOpcua = OPCUA_SEED.map((o) => ({ id: `opcua_demo.${o.field}`, measurement: 'opcua_demo', field: o.field, label: o.label, unit: o.unit, kind: 'analog', sourceType: 'opcua', source: { endpoint: 'opc.tcp://opc-plc:50000', namespace: '3', nodeId: o.node, securityPolicy: 'None' }, scale: 1, offset: 0, enabled: true, custom: false }));
    return [...fromFieldMap, ...fromOpcua];
}
const SEED_IDS = new Set(buildSeed().map((v) => v.id));

function getVariables() {
    const seed = buildSeed();
    const saved = readJson(MAP_FILE, null);
    if (!Array.isArray(saved)) return seed.map(display);
    const savedIds = new Set(saved.map((v) => v.id));
    const result = saved.slice();
    for (const s of seed) if (!savedIds.has(s.id)) result.push(s); // add new built-ins on upgrade
    return result.map(display);
}

function validate(v) {
    if (!v || typeof v !== 'object') throw Object.assign(new Error('variable must be an object'), { status: 400 });
    if (!v.id || typeof v.id !== 'string') throw Object.assign(new Error('variable needs an id (measurement.field)'), { status: 400 });
    if (!v.measurement || !v.field) throw Object.assign(new Error('variable needs measurement and field'), { status: 400 });
    if (!SOURCE_TYPES.includes(v.sourceType)) throw Object.assign(new Error(`invalid sourceType: ${v.sourceType}`), { status: 400 });
    return {
        id: v.id, measurement: v.measurement, field: v.field,
        label: v.label || titleCase(v.field), unit: v.unit || '', kind: v.kind === 'status' ? 'status' : 'analog',
        sourceType: v.sourceType, source: (v.source && typeof v.source === 'object') ? v.source : {},
        scale: Number.isFinite(Number(v.scale)) ? Number(v.scale) : 1,
        offset: Number.isFinite(Number(v.offset)) ? Number(v.offset) : 0,
        enabled: v.enabled !== false, custom: !!v.custom || !SEED_IDS.has(v.id),
    };
}

async function setVariables(arr) {
    if (!Array.isArray(arr)) throw Object.assign(new Error('variables must be an array'), { status: 400 });
    const clean = arr.map(validate);
    await writeJson(MAP_FILE, clean);
    return getVariables();
}

async function addVariable(v) {
    const list = getVariables();
    if (list.some((x) => x.id === v.id)) throw Object.assign(new Error(`variable "${v.id}" already exists`), { status: 409 });
    const rec = validate({ ...v, custom: true });
    await writeJson(MAP_FILE, [...list.map(strip), rec]);
    return rec;
}

async function deleteVariable(id) {
    if (SEED_IDS.has(id)) throw Object.assign(new Error('built-in variables cannot be deleted (disable instead)'), { status: 400 });
    const list = getVariables();
    if (!list.some((x) => x.id === id)) throw Object.assign(new Error('variable not found'), { status: 404 });
    await writeJson(MAP_FILE, list.filter((x) => x.id !== id).map(strip));
    return { id };
}
// drop the computed display fields before persisting
const strip = ({ sourceName, address, ...rest }) => ((rest.sourceType === 's7comm' || rest.sourceType === 'opcua' || rest.sourceType === 'modbus') ? rest : rest);

const getSourceTypes = () => ({ types: SOURCE_TYPES, schemas: SOURCE_SCHEMAS });

// Generate Telegraf input config (preview) from the enabled, non-derived mappings.
function getCollectorConfig() {
    const vars = getVariables().filter((v) => v.enabled);
    const blocks = [];
    // OPC UA — grouped by endpoint
    const opc = {};
    vars.filter((v) => v.sourceType === 'opcua').forEach((v) => { const e = v.source.endpoint || 'opc.tcp://host:50000'; (opc[e] = opc[e] || []).push(v); });
    for (const [endpoint, list] of Object.entries(opc)) {
        const nodes = list.map((v) => `    [[inputs.opcua.group.nodes]]\n      name = "${v.field}"\n      identifier = "${v.source.nodeId || ''}"`).join('\n');
        blocks.push(`[[inputs.opcua]]\n  endpoint = "${endpoint}"\n  security_policy = "${(list[0].source.securityPolicy) || 'None'}"\n  auth_method = "Anonymous"\n  [[inputs.opcua.group]]\n    namespace = "${list[0].source.namespace || '3'}"\n    identifier_type = "s"\n${nodes}`);
    }
    // Modbus — grouped by host:port
    const mb = {};
    vars.filter((v) => v.sourceType === 'modbus').forEach((v) => { const k = `${v.source.host}:${v.source.port || 502}`; (mb[k] = mb[k] || []).push(v); });
    for (const [hp, list] of Object.entries(mb)) {
        const [host, port] = hp.split(':');
        const regs = list.map((v) => `    { name = "${v.field}", ${v.source.registerType || 'holding'}_register_address = ${v.source.register || 0}, data_type = "${v.source.dataType || 'INT16'}" }`).join(',\n');
        blocks.push(`[[inputs.modbus]]\n  controller = "tcp://${host}:${port}"\n  # registers:\n${regs}`);
    }
    // MQTT — grouped by broker
    const mq = {};
    vars.filter((v) => v.sourceType === 'mqtt').forEach((v) => { const b = v.source.broker || 'tcp://broker:1883'; (mq[b] = mq[b] || []).push(v); });
    for (const [broker, list] of Object.entries(mq)) {
        const topics = [...new Set(list.map((v) => `"${v.source.topic || ''}"`))].join(', ');
        blocks.push(`[[inputs.mqtt_consumer]]\n  servers = ["${broker}"]\n  topics = [${topics}]\n  data_format = "json_v2"`);
    }
    const counts = SOURCE_TYPES.reduce((a, t) => { a[t] = vars.filter((v) => v.sourceType === t).length; return a; }, {});
    return { counts, toml: blocks.length ? blocks.join('\n\n') : '# No pollable (opcua/modbus/mqtt) sources configured.\n# S7comm is managed via the PLC Configuration screen; derived/manual need no collector.' };
}

module.exports = { getVariables, setVariables, addVariable, deleteVariable, getSourceTypes, getCollectorConfig, SOURCE_TYPES };
