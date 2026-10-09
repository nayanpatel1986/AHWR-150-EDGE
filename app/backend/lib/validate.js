'use strict';
// Input-validation helpers. Used to stop Flux injection (/api/history),
// TOML/config injection (telegraf.conf generation) and bad numeric writes
// (drilling calibration), all of which were previously unvalidated.

class ValidationError extends Error {
    constructor(message) { super(message); this.name = 'ValidationError'; this.status = 400; }
}

// ---- Flux time inputs ----------------------------------------------------
// Relative duration token, e.g. -30s, -7d, -6mo, 1h
const DURATION_RE = /^-?\d+(ns|us|ms|s|m|h|d|w|mo|y)$/;
// RFC3339 / ISO-8601 instant, e.g. 2024-01-02T03:04:05Z or with offset/millis
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const isFluxRange = (s) => typeof s === 'string' && DURATION_RE.test(s);
const isFluxInstant = (s) => typeof s === 'string' && (INSTANT_RE.test(s) || DURATION_RE.test(s));

// ---- PLC / Telegraf config ----------------------------------------------
const HOST_RE = /^[A-Za-z0-9.\-]{1,253}$/;          // IPv4 or hostname
const S7_ADDR_RE = /^DB\d+\.[A-Za-z]+\d+(\.\d+)?$/; // e.g. DB3191.R0, DB244.X106.0
const MODBUS_ADDR_RE = /^\d+(\s*,\s*\d+)*$/;        // e.g. 0  or  0, 1
const DATA_TYPE_RE = /^(INT16|UINT16|INT32|UINT32|INT64|UINT64|FLOAT32|FLOAT64)$/i;
const REG_TYPE_RE = /^(discrete_input|coil|holding_register|input_register)$/;
const OPCUA_SECURITY_MODE_RE = /^(None|Sign|SignAndEncrypt)$/;
const OPCUA_SECURITY_POLICY_RE = /^(|None|Basic128Rsa15|Basic256|Basic256Sha256|Aes128_Sha256_RsaOaep|Aes256_Sha256_RsaPss)$/;
const OPCUA_NODE_ID_RE = /^(|ns=\d+;[isgbd]=.+)$/;

// A free-text name (slave/metric/field name) that will be embedded inside a
// double-quoted TOML string. Reject anything that could break out of the quote
// or inject a new TOML stanza/line.
function assertTomlSafe(name, label) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 256) {
        throw new ValidationError(`${label} must be a non-empty string <=256 chars`);
    }
    if (/["\\\r\n\[\]]/.test(name)) {
        throw new ValidationError(`${label} contains illegal characters (" \\ [ ] or newline)`);
    }
    return name;
}

function toInt(v, label, { min = -Infinity, max = Infinity, def } = {}) {
    if (v === undefined || v === null || v === '') {
        if (def !== undefined) return def;
        throw new ValidationError(`${label} is required`);
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
        throw new ValidationError(`${label} must be an integer in [${min}, ${max}]`);
    }
    return n;
}

// Validate & normalize a PLC config payload ({ slaves: [...] }) before it is
// turned into telegraf.conf. Throws ValidationError on the first problem.
function validatePlcConfig(config) {
    if (!config || typeof config !== 'object' || !Array.isArray(config.slaves)) {
        throw new ValidationError('Body must be { slaves: [...] }');
    }
    if (config.slaves.length > 64) throw new ValidationError('Too many devices (max 64)');

    for (const slave of config.slaves) {
        if (!slave || typeof slave !== 'object') throw new ValidationError('Each device must be an object');
        assertTomlSafe(slave.name || 'device', 'device.name');
        const protocol = slave.protocol || 'modbus';
        if (protocol !== 'modbus' && protocol !== 's7comm') {
            throw new ValidationError(`Unsupported protocol: ${protocol}`);
        }
        if (!HOST_RE.test(String(slave.ip || ''))) throw new ValidationError(`Invalid device IP/host: ${slave.ip}`);
        toInt(slave.port, 'device.port', { min: 1, max: 65535, def: protocol === 's7comm' ? 102 : 502 });

        if (protocol === 'modbus') {
            const regs = Array.isArray(slave.registers) ? slave.registers : [];
            if (regs.length > 512) throw new ValidationError('Too many registers (max 512)');
            for (const r of regs) {
                assertTomlSafe(r.name, 'register.name');
                if (r.type !== undefined && !REG_TYPE_RE.test(String(r.type))) {
                    throw new ValidationError(`Invalid register type: ${r.type}`);
                }
                if (r.address !== null && r.address !== undefined && r.address !== '' &&
                    !MODBUS_ADDR_RE.test(String(r.address))) {
                    throw new ValidationError(`Invalid Modbus address: ${r.address}`);
                }
                if (r.dataType !== undefined && r.dataType !== '' && !DATA_TYPE_RE.test(String(r.dataType))) {
                    throw new ValidationError(`Invalid dataType: ${r.dataType}`);
                }
                if (r.scale !== undefined && r.scale !== null && r.scale !== '' && !Number.isFinite(Number(r.scale))) {
                    throw new ValidationError(`Invalid scale: ${r.scale}`);
                }
            }
        } else { // s7comm
            toInt(slave.rack, 'device.rack', { min: 0, max: 7, def: 0 });
            toInt(slave.slot, 'device.slot', { min: 0, max: 31, def: 0 });
            const metrics = Array.isArray(slave.metrics) ? slave.metrics : [];
            for (const m of metrics) {
                assertTomlSafe(m.name || 'AHWR', 'metric.name');
                const fields = Array.isArray(m.fields) ? m.fields : [];
                if (fields.length > 512) throw new ValidationError('Too many fields (max 512)');
                for (const f of fields) {
                    assertTomlSafe(f.name, 'field.name');
                    if (!S7_ADDR_RE.test(String(f.address || ''))) {
                        throw new ValidationError(`Invalid S7 address: ${f.address}`);
                    }
                    if (f.scale !== undefined && f.scale !== null && f.scale !== '' && !Number.isFinite(Number(f.scale))) {
                        throw new ValidationError(`Invalid S7 scale: ${f.scale}`);
                    }
                }
                if (m.tags && typeof m.tags === 'object') {
                    for (const [k, v] of Object.entries(m.tags)) {
                        assertTomlSafe(k, 'tag.key');
                        assertTomlSafe(String(v), 'tag.value');
                    }
                }
            }
        }
    }
    if (config.hpuAnalytics !== undefined) {
        const h = config.hpuAnalytics;
        if (!h || typeof h !== 'object' || Array.isArray(h)) throw new ValidationError('Invalid HPU analytics settings');
        for (const section of ['pressureSetpoints', 'ratedFlows', 'healthWeights']) {
            if (h[section] === undefined) continue;
            if (!h[section] || typeof h[section] !== 'object' || Array.isArray(h[section])) throw new ValidationError('Invalid HPU '+section);
            for (const value of Object.values(h[section])) {
                if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000)) throw new ValidationError('HPU '+section+' must contain non-negative finite numbers');
            }
        }
    }
    return config;
}

// Validate the admin-managed VersaMax / KEPServerEX OPC UA settings. Node IDs
// are intentionally optional so the UI can be prepared before Kepware tags are
// finalized; empty IDs are ignored by the collector.
function validateBopConfig(config) {
    if (!config || typeof config !== 'object') throw new ValidationError('BOP config must be an object');
    const endpoint = String(config.endpoint || '');
    if (!/^opc\.tcp:\/\/[^\s]+$/i.test(endpoint) || endpoint.length > 512) {
        throw new ValidationError('BOP endpoint must be a valid opc.tcp:// URL');
    }
    if (!OPCUA_SECURITY_MODE_RE.test(String(config.securityMode || 'None'))) {
        throw new ValidationError('Invalid OPC UA security mode');
    }
    if (!OPCUA_SECURITY_POLICY_RE.test(String(config.securityPolicy || 'None'))) {
        throw new ValidationError('Invalid OPC UA security policy');
    }
    if (typeof config.enabled !== 'boolean') throw new ValidationError('BOP enabled must be boolean');
    const tags = Array.isArray(config.tags) ? config.tags : [];
    if (tags.length > 64) throw new ValidationError('Too many BOP tags (max 64)');
    for (const tag of tags) {
        if (!tag || typeof tag !== 'object') throw new ValidationError('Each BOP tag must be an object');
        assertTomlSafe(String(tag.name || ''), 'BOP tag.name');
        assertTomlSafe(String(tag.field || ''), 'BOP tag.field');
        if (tag.unit !== undefined) assertTomlSafe(String(tag.unit), 'BOP tag.unit');
        if (!OPCUA_NODE_ID_RE.test(String(tag.nodeId || ''))) {
            throw new ValidationError(`Invalid OPC UA Node ID for ${tag.name}`);
        }
        if (typeof tag.enabled !== 'boolean') throw new ValidationError(`BOP tag.enabled must be boolean for ${tag.name}`);
    }
    return {
        ...config,
        endpoint,
        securityMode: String(config.securityMode || 'None'),
        securityPolicy: String(config.securityPolicy || 'None'),
        tags: tags.map(tag => ({ ...tag, nodeId: String(tag.nodeId || '') }))
    };
}

// Validate a finite number within bounds (drilling calibration inputs).
function num(v, label, { min = -Infinity, max = Infinity } = {}) {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ValidationError(`${label} must be a finite number`);
    if (n < min || n > max) throw new ValidationError(`${label} must be in [${min}, ${max}]`);
    return n;
}

const USERNAME_RE = /^[A-Za-z0-9_.\-]{3,40}$/;
const ROLES = ['admin', 'operator', 'viewer'];

module.exports = {
    ValidationError,
    isFluxRange, isFluxInstant,
    validatePlcConfig, validateBopConfig, assertTomlSafe,
    num, USERNAME_RE, ROLES,
};
