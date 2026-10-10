// TimescaleDB edition: tag mapping, managed Telegraf config, time handling.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildMapping, mapPoint, isBooleanMetric, starlarkSource } = require('../lib/telemetryMap');
const { buildManagedConfig, writeManagedConfig, assertRigId } = require('../lib/telegrafConfig');
const { durationToInterval, timeBound } = require('../lib/tsdb');
const { splitCsvLine, cleanLabel } = require('../lib/wellArchive');
const { validatePlcConfig } = require('../lib/validate');

const plc = (fields, extra = {}) => ({
  slaves: [{ name: 'PLC', protocol: 's7comm', ip: '10.0.0.5', port: 102, rack: 0, slot: 0,
    metrics: [{ name: 'AHWR', fields, tags: { equipment: 'DAS' } }], ...extra }],
});

test('mapping: mapped tags get CMF metric names, unmapped keep group.tag, bits are booleans', () => {
  const m = buildMapping(plc([
    { name: 'Weight on Hook -Ton', address: 'DB244.R72' },
    { name: 'SLIP IN', address: 'DB244.X106.0' },
    { name: 'Some Unmapped Tag', address: 'DB244.R80', scale: '0.1' },
  ]));
  assert.equal(m.entries.get('Weight on Hook -Ton').metric, 'drawworks.hook_load');
  assert.equal(m.entries.get('Some Unmapped Tag').metric, 'AHWR.Some Unmapped Tag');
  assert.equal(m.entries.get('Some Unmapped Tag').scale, 0.1);
  const slip = m.entries.get('SLIP IN');
  assert.equal(slip.bit, true);
  assert.ok(isBooleanMetric(m, slip.metric));
  assert.ok(isBooleanMetric(m, 'bop.annular_open'));
  assert.ok(!isBooleanMetric(m, 'drawworks.hook_load'));
});

test('mapping: when two tags map to one metric the FIELD_MAP primary wins and the other is kept raw', () => {
  const m = buildMapping(plc([
    { name: 'SpeedFdbk_SPM', address: 'DB416.R2' },
    { name: 'Mud Pumps Total SPM-SPM', address: 'DB416.R2' },
  ]));
  assert.equal(m.entries.get('Mud Pumps Total SPM-SPM').metric, 'mudpump.spm');
  assert.equal(m.entries.get('SpeedFdbk_SPM').metric, 'AHWR.SpeedFdbk_SPM');
});

test('mapping: legacy points map like live ones; non-numeric values are dropped', () => {
  const m = buildMapping(plc([{ name: 'Scaled', address: 'DB1.R0', scale: 2 }]));
  assert.deepEqual(mapPoint(m, 'AHWR', 'Scaled', 21), { metric: 'AHWR.Scaled', value: 42 });
  assert.deepEqual(mapPoint(m, 'bop', 'annular_open', true), { metric: 'bop.annular_open', value: 1 });
  assert.deepEqual(mapPoint(m, 'drawworks', 'hook_load', 12.5), { metric: 'drawworks.hook_load', value: 12.5 });
  for (const v of [null, '', 'text', NaN, Infinity]) assert.equal(mapPoint(m, 'x', 'y', v), null);
});

test('starlark source: every configured tag is in MAP and names are safely quoted', () => {
  const m = buildMapping(plc([{ name: 'Odd "quoted" \\ tag', address: 'DB1.R0' }]));
  const src = starlarkSource(m);
  assert.match(src, /"Odd \\"quoted\\" \\\\ tag": \("AHWR\.Odd \\"quoted\\" \\\\ tag", 1\)/);
  assert.match(src, /row\.tags\["rig_id"\] = rig/);
  assert.match(src, /if metric\.name\.startswith\("internal"\):/);
});

test('managed plc.conf: rig_id tag, starlark processor, inputs; rewritten only on change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahwr-tg-'));
  const conf = path.join(dir, 'plc.conf');
  const cfg = plc([{ name: 'Weight on Hook -Ton', address: 'DB244.R72' }]);
  assert.equal(writeManagedConfig(conf, cfg, { rigId: 'AHWR-50-III' }), true);
  const text = fs.readFileSync(conf, 'utf8');
  assert.match(text, /\[global_tags\]\n  rig_id = "AHWR-50-III"/);
  assert.match(text, /\[\[processors\.starlark\]\]\n  script = '.*ahwr-telemetry\.star'/);
  assert.match(text, /\[\[inputs\.s7comm\]\]\n  server = "10\.0\.0\.5:102"/);
  assert.ok(fs.existsSync(path.join(dir, 'ahwr-telemetry.star')));
  assert.equal(writeManagedConfig(conf, cfg, { rigId: 'AHWR-50-III' }), false);
  const { conf: other } = buildManagedConfig(cfg, { rigId: 'AHWR-50-III', starPath: '/etc/telegraf/telegraf.d/ahwr-telemetry.star' });
  assert.match(other, /script = '\/etc\/telegraf\/telegraf\.d\/ahwr-telemetry\.star'/);
});

test('rig id and Modbus slaveId cannot inject TOML', () => {
  assert.equal(assertRigId('AHWR-50-III'), 'AHWR-50-III');
  for (const bad of ['', 'a"b', 'x\n[[outputs.exec]]', 'a b']) assert.throws(() => assertRigId(bad), (e) => e.status === 400);
  const modbus = { slaves: [{ name: 'M', protocol: 'modbus', ip: '10.0.0.6', slaveId: '1\n[[outputs.exec]]', registers: [] }] };
  assert.throws(() => validatePlcConfig(modbus), /slaveId/);
});

test('time inputs: durations become intervals; values are always bind parameters', () => {
  assert.equal(durationToInterval('-30s'), '-30 seconds');
  assert.equal(durationToInterval('-6mo'), '-6 months');
  assert.equal(durationToInterval('5m'), '5 minutes');
  assert.equal(durationToInterval('1500ns'), '2 microseconds');
  assert.equal(durationToInterval('1h; drop'), null);
  const params = [];
  assert.equal(timeBound('-1h', params), '(now() + $1::interval)');
  assert.equal(timeBound('2026-01-01T00:00:00Z', params), '$2::timestamptz');
  assert.equal(timeBound('now()', params), 'now()');
  assert.deepEqual(params, ['-1 hours', '2026-01-01T00:00:00Z']);
});

test('imports: quoted CSV cells and labels are handled safely', () => {
  assert.deepEqual(splitCsvLine('2026-01-01T00:00:00Z,"1,5","say ""hi"""'), ['2026-01-01T00:00:00Z', '1,5', 'say "hi"']);
  assert.equal(cleanLabel('well A/1 ; drop'), 'well_A_1_drop');
});
