// Standpipe pressure: stored in bar (PLC tag SPP-Bar, as at the CMF), presented
// in psi by alarms, the WITSML export and the ETP stream.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ahwr-units-'));
process.env.DATA_DIR = DATA_DIR;
// An alarm config saved before this change, with standpipe limits in bar.
fs.writeFileSync(path.join(DATA_DIR, 'alarms_config.json'), JSON.stringify([
  { key: 'spp_hi', dataKey: 'mudpump.pressure', label: 'SPP High', unit: 'bar', hi: 240, hiHi: 300, deadband: 5, onDelaySec: 0, priority: 'P2', enabled: true },
  { key: 'tubing_hi', dataKey: 'wellhead.tubing_pressure', label: 'Tubing High', unit: 'bar', hi: 200, deadband: 5, onDelaySec: 0, priority: 'P1', enabled: true },
]));
const units = require('../lib/units');
const witsml = require('../lib/witsml');
const alarms = require('../lib/alarms');

test('units: standpipe pressure is stored in bar and presented in psi', () => {
  assert.equal(units.storedUnit('mudpump.pressure'), 'bar');
  assert.equal(units.presentation('mudpump.pressure').unit, 'psi');
  assert.equal(units.present('mudpump.pressure', 100), 1450.37738);
  assert.equal(units.present('htd.torque', 100), 100);
  assert.equal(units.present('mudpump.pressure', null), null);
  assert.equal(units.storedUnit('drawworks.hook_load'), 't');
  assert.equal(units.storedUnit('htd.torque'), null); // the catalog unit applies
});

test('alarms: bar limits saved earlier become the same thresholds in psi; other alarms untouched', async () => {
  const cfg = alarms.getConfig();
  const spp = cfg.find((c) => c.key === 'spp_hi');
  assert.deepEqual({ unit: spp.unit, hi: spp.hi, hiHi: spp.hiHi, deadband: spp.deadband }, { unit: 'psi', hi: 3481, hiHi: 4351, deadband: 73 });
  assert.equal(cfg.find((c) => c.key === 'tubing_hi').unit, 'bar');
  await new Promise((r) => setTimeout(r, 200)); // the file store writes asynchronously
  const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'alarms_config.json'), 'utf8'));
  assert.equal(saved.find((c) => c.key === 'spp_hi').unit, 'psi');
  // 250 bar = 3626 psi: above HI (3481 psi), below HIHI.
  const now = Date.now();
  alarms.evaluate({ mudpump: { pressure: 250 } }, now);
  const r = alarms.evaluate({ mudpump: { pressure: 250 } }, now + 1000);
  const a = r.active.find((x) => x.id === 'spp_hi');
  assert.ok(a, 'spp_hi raised');
  assert.equal(a.condition, 'HI');
  assert.equal(Math.round(a.value), 3626);
});

test('WITSML log: standpipe pressure exported in psi, envelope curves too', () => {
  const xml = witsml.logs({ name: 'W' }, [
    { metric: 'mudpump.pressure', unit: 'bar' },
    { metric: 'mudpump.pressure_max', unit: 'bar' },
    { metric: 'htd.torque', unit: 'daN.m' },
  ], [{ time: '2026-10-01T00:00:00.000Z', 'mudpump.pressure': 100, 'mudpump.pressure_max': 200, 'htd.torque': 50 }]);
  assert.match(xml, /<unitList>s,psi,psi,daN.m<\/unitList>/);
  assert.match(xml, /<data>2026-10-01T00:00:00.000Z,1450.37738,2900.75476,50<\/data>/);
});
