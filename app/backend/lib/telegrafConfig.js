'use strict';
// Telegraf configuration managed by the backend.
//
// The backend owns telegraf.d/plc.conf (TELEGRAF_CONFIG_PATH): the PLC inputs
// generated from plc_config.json, the rig_id global tag, and a Starlark
// processor that maps every PLC tag to its CMF telemetry metric (the map
// itself is written next to it as ahwr-telemetry.star). Telegraf runs with
// --watch-config and reloads within seconds when plc.conf changes.
//
// Read-only collection: only input plugins are generated here.
const fs = require('fs');
const path = require('path');
const { buildMapping, starlarkSource, hashOf } = require('./telemetryMap');

const STAR_FILE = 'ahwr-telemetry.star';
const RIG_ID_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

const generateTelegrafConfig = (config) => {
    let toml = '';

    // Slaves are now treated as "Devices" which can be Modbus or S7comm
    config.slaves.forEach(slave => {
        const protocol = slave.protocol || 'modbus';

        if (protocol === 'modbus') {
            toml += `[[inputs.modbus]]\n`;
            toml += `  name = "${slave.name}"\n`;
            toml += `  slave_id = ${Number(slave.slaveId) || 1}\n`;
            toml += `  timeout = "1s"\n`;
            toml += `  controller = "tcp://${slave.ip}:${slave.port || 502}"\n`;
            toml += `  configuration_type = "register"\n`;
            toml += `  optimization = "none"\n\n`;

            // Discrete Inputs
            const registers = slave.registers || [];
            const discretes = registers.filter(r => r.type === 'discrete_input' && r.address !== null && r.address !== undefined && r.address !== "");
            if (discretes.length > 0) {
                toml += `  discrete_inputs = [\n`;
                discretes.forEach(r => {
                    toml += `    { name = "${r.name}", address = [${r.address}] },\n`;
                });
                toml += `  ]\n`;
            }

            // Coils
            const coils = registers.filter(r => r.type === 'coil' && r.address !== null && r.address !== undefined && r.address !== "");
            if (coils.length > 0) {
                toml += `  coils = [\n`;
                coils.forEach(r => {
                    toml += `    { name = "${r.name}", address = [${r.address}] },\n`;
                });
                toml += `  ]\n`;
            }

            // Holding Registers
            const holding = registers.filter(r => (r.type === 'holding_register' || r.type === 'input_register') && r.address !== null && r.address !== undefined && r.address !== "");
            if (holding.length > 0) {
                toml += `  holding_registers = [\n`;
                holding.forEach(r => {
                    let scaleVal = r.scale !== undefined && r.scale !== null && r.scale !== "" ? Number(r.scale) : 1.0;
                    let scaleStr = Number.isInteger(scaleVal) ? scaleVal.toFixed(1) : String(scaleVal);
                    const byteOrder = (r.dataType === 'INT16' || r.dataType === 'UINT16') ? 'AB' : 'ABCD';
                    toml += `    { name = "${r.name}", byte_order = "${byteOrder}", data_type = "${r.dataType}", scale = ${scaleStr}, address = [${r.address}] },\n`;
                });
                toml += `  ]\n`;
            }
        } else if (protocol === 's7comm') {
            // S7 input collection only. CMD-named fields are read-back values.
            toml += '# RIG PLC: read-only S7 input collection, including CMD tag read-back.\n';
            toml += `[[inputs.s7comm]]\n`;
            toml += `  server = "${slave.ip}:${slave.port || 102}"\n`;
            toml += `  rack = ${slave.rack || 0}\n`;
            toml += `  slot = ${slave.slot || 0}\n`;

            // S7comm uses metrics which group fields together
            if (slave.metrics && slave.metrics.length > 0) {
                slave.metrics.forEach(metric => {
                    toml += `  [[inputs.s7comm.metric]]\n`;
                    toml += `    name = "${metric.name || 'AHWR'}"\n`;
                    toml += `    fields = [\n`;
                    metric.fields.forEach(f => {
                        toml += `      {name="${f.name}", address="${f.address}"},\n`;
                    });
                    toml += `    ]\n`;
                    if (metric.tags) {
                        toml += `    [inputs.s7comm.metric.tags]\n`;
                        Object.entries(metric.tags).forEach(([k, v]) => {
                            toml += `      ${k} = "${v}"\n`;
                        });
                    }
                });
            }
        }
        toml += `\n`;
    });
    return toml;
};

const assertRigId = (rigId) => {
    if (!RIG_ID_RE.test(String(rigId || ''))) {
        throw Object.assign(new Error(`Invalid rig id "${rigId}" (1-64 chars: letters, digits, . _ -)`), { status: 400 });
    }
    return String(rigId);
};

/** Contents of the managed plc.conf and its Starlark map for a PLC config. */
function buildManagedConfig(config, { rigId, starPath }) {
    const star = starlarkSource(buildMapping(config));
    const inputs = generateTelegrafConfig(config);
    const hash = hashOf(star + inputs + rigId);
    const conf = [
        '# =============================================================================',
        '# MANAGED BY THE AHWR BACKEND — replaced at backend start and whenever the PLC',
        '# map is saved (Settings > Administration > S7 PLC). Do not hand-edit.',
        '# RIG PLC: read-only collection. Nothing in this file writes to a PLC.',
        `# map-hash: ${hash}`,
        '# =============================================================================',
        '[global_tags]',
        `  rig_id = "${assertRigId(rigId)}"`,
        '',
        '# Every PLC/BOP metric becomes CMF telemetry rows (ts, rig_id, metric, value).',
        '[[processors.starlark]]',
        `  script = '${starPath.replace(/\\/g, '/')}'`,
        '',
        inputs.trimEnd(),
        '',
    ].join('\n');
    return { conf, star, hash };
}

/**
 * Write plc.conf (and the Starlark map before it, so a reload always sees a
 * matching map). Skips the write when nothing changed. Returns true if written.
 */
function writeManagedConfig(confPath, config, { rigId, scriptPath }) {
    const starPath = path.join(path.dirname(confPath), STAR_FILE);
    // scriptPath: where Telegraf sees the map, if its filesystem differs (containers).
    const { conf, star } = buildManagedConfig(config, { rigId, starPath: scriptPath || starPath });
    const current = fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';
    const currentStar = fs.existsSync(starPath) ? fs.readFileSync(starPath, 'utf8') : '';
    if (current === conf && currentStar === star) return false;
    const writeAtomic = (file, text) => {
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, file);
    };
    writeAtomic(starPath, star);
    writeAtomic(confPath, conf);
    return true;
}

module.exports = { generateTelegrafConfig, buildManagedConfig, writeManagedConfig, assertRigId, STAR_FILE };
