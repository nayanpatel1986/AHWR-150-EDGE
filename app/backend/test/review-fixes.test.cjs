// Regression tests for live-data integrity and access-control fixes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolated data dir; must be set before any module that reads DATA_DIR loads.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ahwr-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.AUTH_MODE = 'ldap';
process.env.LDAP_URL = 'ldap://dc.invalid';
process.env.LDAP_ROLE_ADMIN = 'RigAdmins';
process.env.LDAP_ROLE_OPERATOR = 'RigOperators';
delete process.env.INFLUX_TOKEN;

const persist = require('../lib/persist');
const alarms = require('../lib/alarms');
const { assertQueryWindow } = require('../lib/wellArchive');
const { mapRole } = require('../lib/ldap');

const validAlarm = (over = {}) => ({ key: 'k1', dataKey: 'drawworks.hook_load', label: 'Hook', unit: 't', hi: 10, deadband: 1, onDelaySec: 0, priority: 'P1', enabled: true, ...over });

test('alarm config: malformed entries are rejected with 400 instead of breaking evaluation', async () => {
  for (const bad of [
    validAlarm({ dataKey: undefined }),
    validAlarm({ dataKey: 'nodot' }),
    validAlarm({ priority: 'P9' }),
    validAlarm({ hi: '10' }),
    validAlarm({ hi: undefined }),
    validAlarm({ deadband: -1 }),
    validAlarm({ enabled: 'yes' }),
  ]) {
    await assert.rejects(alarms.setConfig([bad]), (e) => e.status === 400);
  }
  await assert.rejects(alarms.setConfig([validAlarm(), validAlarm()]), /duplicate alarm key/);
  await alarms.setConfig([validAlarm()]);
  const r = alarms.evaluate({ drawworks: { hook_load: 50 } }, Date.now());
  assert.equal(typeof r.counts.active, 'number');
});

test('alarm config: shipped defaults pass validation', async () => {
  const defaults = require('../defaults/alarms_config.json');
  await alarms.setConfig(defaults);
});

test('persist: overlapping writes to one file stay valid JSON, land in order, leave no temp files', async () => {
  const writes = [];
  for (let i = 0; i < 50; i++) writes.push(persist.writeJson('race.json', { i, pad: 'x'.repeat(i % 7 === 0 ? 5000 : 3) }));
  await Promise.all(writes);
  const final = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'race.json'), 'utf8'));
  assert.equal(final.i, 49);
  assert.deepEqual(fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.tmp')), []);
});

test('archive query window: only instants, durations and now() reach Flux', () => {
  assertQueryWindow({ start: '-100y', stop: 'now()' });
  assertQueryWindow({ start: '2026-01-01T00:00:00Z', stop: '2026-01-02T00:00:00.000Z', every: '1m' });
  for (const bad of [
    { start: 'yesterday', stop: 'now()' },
    { start: '-1h', stop: 'now()) |> yield(' },
    { start: '-1h) |> drop(', stop: 'now()' },
    { start: '-1h', stop: 'now()', every: '1m)' },
  ]) {
    assert.throws(() => assertQueryWindow(bad), (e) => e.status === 400);
  }
});

test('ldap: roles require an exact group DN or CN match', () => {
  assert.equal(mapRole(['CN=RigAdmins,OU=Groups,DC=corp,DC=example,DC=com']), 'admin');
  assert.equal(mapRole(['CN=RigOperators,OU=Groups,DC=corp']), 'operator');
  assert.equal(mapRole(['CN=RigAdmins-ReadOnly,OU=Groups,DC=corp']), 'viewer');
  assert.equal(mapRole(['CN=Staff,OU=RigAdmins,DC=corp']), 'viewer');
  assert.equal(mapRole([]), 'viewer');
});
