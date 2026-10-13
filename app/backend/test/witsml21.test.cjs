// WITSML 2.1 objects. Structure is checked here; when WITSML21_XSD_DIR points at
// the energyml/data folder of the official schemas (witsml/v2.1 + common/v2.3)
// and xmllint is installed, every object is validated against them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const w21 = require('../lib/witsml21');
const ids = require('../lib/ids');
const channels = require('../lib/channels');

const rigId = 'AHWR-50-III';
const well = {
  id: 'well_abc_1', name: 'GS-11#4', uwi: 'UWI-123', field: 'Ankleshwar', operator: 'ONGC', country: 'India',
  spudDate: '2026-09-01', plannedTdM: 1800, status: 'active', startedAt: '2026-10-01T00:00:00.000Z',
};
const run = { wellId: well.name, startedAt: well.startedAt, endedAt: null };
const dict = channels.buildDictionary({
  rigId,
  rows: [
    { metric: 'drawworks.hook_load', label: 'Hook Load', unit: 't' },
    { metric: 'mudpump.pressure', label: 'Pump Pressure', unit: 'bar' },
    { metric: 'hpu.fan1_groupfault', label: 'HPU Cooling Fan1_GroupFault' },
    { metric: 'cwk.indexer_dx', label: 'CWK Indexer DX', plcTag: 'CWK Indexer DX-1=UP, 2=DOWN, 3=FAULT' },
  ],
  isBoolean: (m) => m === 'hpu.fan1_groupfault',
});
const entries = [...dict.values()].map((c) => ({ ...c, firstTs: '2026-10-01T00:00:00Z', lastTs: '2026-10-01T00:00:02Z' }));
const rows = [
  { time: '2026-10-01T00:00:00.000Z', 'drawworks.hook_load': 60.5, 'mudpump.pressure': 100, 'hpu.fan1_groupfault': 0, 'cwk.indexer_dx': 1 },
  { time: '2026-10-01T00:00:01.000Z', 'drawworks.hook_load': 61 },
];
const opts = { rigId, loggingCompany: 'ONGC', start: '2026-10-01T00:00:00Z', end: '2026-10-01T00:00:01Z' };
const docs = {
  Well: w21.well(well, { timeZone: '+05:30', rigId }),
  Wellbore: w21.wellbore(well, { rigId, holeDepthM: 1600, bitDepthM: 1500.5 }),
  Rig: w21.rig(rigId, { owner: 'ONGC', creation: '2026-01-01T00:00:00Z' }),
  RigUtilization: w21.rigUtilization(run, { rigId, startHoleDepthM: 1590 }),
  Channel: w21.channel(entries[0], { rigId, loggingCompany: 'ONGC' }),
  ChannelSet: w21.channelSet(run, entries, { ...opts, rows }),
  Log: w21.log(run, entries, opts),
  BusinessAssociate: w21.businessAssociate('ONGC', { creation: '2026-01-01T00:00:00Z' }),
  PropertyKind: w21.propertyKind(channels.PWLS.kinds['hook load']),
};

test('identifiers are the documented name-based UUIDs', () => {
  assert.match(docs.Well, new RegExp(`<witsml:Well [^>]*uuid="${ids.well('GS-11#4')}" schemaVersion="2.1"`));
  assert.match(docs.Wellbore, new RegExp(`<witsml:Well><eml:Uuid>${ids.well('GS-11#4')}</eml:Uuid><eml:QualifiedType>witsml21.Well</eml:QualifiedType>`));
  assert.match(docs.Channel, new RegExp(`uuid="${ids.channel(rigId, 'drawworks.hook_load')}"`));
  assert.match(docs.RigUtilization, new RegExp(`uuid="${ids.rigUtilization(rigId, 'GS-11#4', '2026-10-01T00:00:00.000Z')}"`));
});

test('channels carry Energistics units and PWLS property kinds', () => {
  const hook = dict.get('drawworks.hook_load');
  assert.deepEqual([hook.mnemonic, hook.uom, hook.propertyKind.title], ['HKLA', 'Mgf', 'hook load']);
  assert.match(docs.Channel, /<witsml:Uom>Mgf<\/witsml:Uom>.*<witsml:ChannelPropertyKind><eml:Uuid>d0a7c1c5-73da-45b5-a762-eb49721d91e9<\/eml:Uuid><eml:QualifiedType>eml23.PropertyKind<\/eml:QualifiedType><eml:Title>hook load<\/eml:Title>/);
  const spp = dict.get('mudpump.pressure');
  assert.deepEqual([spp.uom, spp.factor, spp.storedUnit, spp.propertyKind.title], ['psi', 14.5037738, 'bar', 'standpipe pressure']);
  assert.deepEqual([dict.get('hpu.fan1_groupfault').uom, dict.get('hpu.fan1_groupfault').propertyKind.title], ['Euc', 'flag']);
  assert.deepEqual([dict.get('cwk.indexer_dx').uom, dict.get('cwk.indexer_dx').propertyKind.title], ['Euc', 'status']);
});

test('channel set data: WITSML JSON rows, presented units, null when absent', () => {
  assert.match(docs.ChannelSet, /\[\["2026-10-01T00:00:00.000Z"\],\[60.5,1450.37738,0,1\]\]/);
  assert.match(docs.ChannelSet, /\[\["2026-10-01T00:00:01.000Z"\],\[61,null,null,null\]\]/);
  assert.match(docs.Log, /<witsml:ChannelSet uuid="[^"]+" schemaVersion="2.1">/);
  assert.doesNotMatch(docs.Log, /<witsml:Data>/);
});

test('objects validate against the WITSML 2.1 / Energistics common 2.3 schemas (WITSML21_XSD_DIR)', (t) => {
  const dir = process.env.WITSML21_XSD_DIR;
  if (!dir) return t.skip('set WITSML21_XSD_DIR to the energyml/data folder of the official schemas');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'witsml21-'));
  for (const [name, xml] of Object.entries(docs)) {
    const xsd = ['BusinessAssociate', 'PropertyKind'].includes(name)
      ? path.join(dir, 'common/v2.3/xsd_schemas/EmlAllObjects.xsd')
      : path.join(dir, 'witsml/v2.1/xsd_schemas/WitsmlAllObjects.xsd');
    const file = path.join(tmp, `${name}.xml`);
    fs.writeFileSync(file, xml);
    try {
      execFileSync('xmllint', ['--noout', '--schema', xsd, file], { stdio: 'pipe' });
    } catch (e) {
      assert.fail(`${name} does not validate:\n${String(e.stderr || e.message).slice(0, 2000)}`);
    }
  }
});
