// WITSML 1.4.1.1 export. Structure and units are checked here; when
// WITSML_XSD_DIR points at the official 1.4.1.1 xsd_schemas folder and xmllint
// is installed, every document is also validated against the schemas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const witsml = require('../lib/witsml');

const well = {
  id: 'well_abc_1', name: 'GS-11#4', uwi: 'UWI-123', field: 'Ankleshwar', operator: 'ONGC', country: 'India',
  spudDate: '2026-09-01', plannedTdM: 1800, status: 'active', jobNo: 'JOB-77',
  startedAt: '2026-10-01T00:00:00.000Z',
};
const channels = [
  { metric: 'drawworks.hook_load', unit: 'ton', label: 'Hook Load' },
  { metric: 'drawworks.block_position', unit: 'mm', label: 'Block Position' },
  { metric: 'htd.torque', unit: 'daN.m', label: 'HTD Torque' },
  { metric: 'hpu.some_really_long_metric_name_that_exceeds_the_mnemonic_limit', unit: 'bar' },
];
const rows = [
  { time: '2026-10-01T00:00:00.000Z', 'drawworks.hook_load': 60.5, 'drawworks.block_position': 1200, 'htd.torque': 81 },
  { time: '2026-10-01T00:00:01.000Z', 'drawworks.hook_load': 61 },
];
const docs = {
  obj_well: witsml.wells(well, { timeZone: '+05:30' }),
  obj_wellbore: witsml.wellbores(well, { holeDepthM: 1600, bitDepthM: 1500.5 }),
  obj_log: witsml.logs(well, channels, rows, { uid: 'log-1' }),
  obj_message: witsml.messages(well, [
    { ts: '2026-10-01T01:00:00Z', type: 'RAISE', key: 'esd_active', label: 'EMERGENCY SHUTDOWN ACTIVE', priority: 'P1', condition: 'HI', value: 1, limit: 1 },
    { ts: '2026-10-01T01:00:05Z', type: 'ACK', key: 'esd_active', by: 'admin' },
  ]),
  obj_opsReport: witsml.opsReports(well, { date: '2026-10-01', entries: [
    { code: 'TRIP_IN', label: 'Trip In', productive: true, start: '2026-10-01T00:00:00Z', end: '2026-10-01T02:00:00Z', durationSec: 7200, depth: 1500, source: 'auto' },
    { code: 'WAIT', label: 'Waiting (NPT)', productive: false, npt: { reason: 'Weather' }, start: '2026-10-01T02:00:00Z', end: null, durationSec: null, depth: null, source: 'manual' },
  ] }, { rigName: 'AHWR-50-III', holeDepthM: 1600, timeZone: '+05:30' }),
};

test('well and wellbore are separate objects; the wellbore is not the rig', () => {
  assert.doesNotMatch(docs.obj_well, /<wellbore/);
  assert.match(docs.obj_well, /<well uid="well_abc_1"><name>GS-11#4<\/name><numGovt>UWI-123<\/numGovt><field>Ankleshwar<\/field><country>India<\/country><timeZone>\+05:30<\/timeZone><operator>ONGC<\/operator><statusWell>working over<\/statusWell><dTimSpud>2026-09-01T00:00:00\+05:30<\/dTimSpud><\/well>/);
  assert.doesNotMatch(docs.obj_well, /numLicense/);
  assert.match(docs.obj_wellbore, /<wellbore uidWell="well_abc_1" uid="well_abc_1-wb1"><nameWell>GS-11#4<\/nameWell><name>GS-11#4<\/name>/);
  assert.match(docs.obj_wellbore, /<md uom="m">1600<\/md><mdBit uom="m">1500.5<\/mdBit><mdPlanned uom="m">1800<\/mdPlanned>/);
});

test('log: Energistics units, standard and bounded mnemonics, no columnIndex', () => {
  assert.match(docs.obj_log, /<mnemonic>HKLA<\/mnemonic><unit>Mgf<\/unit>/);
  assert.match(docs.obj_log, /<mnemonic>BPOS<\/mnemonic><unit>mm<\/unit>/);
  assert.match(docs.obj_log, /<mnemonic>TQA<\/mnemonic><unit>daN.m<\/unit>/);
  assert.doesNotMatch(docs.obj_log, /columnIndex/);
  for (const m of docs.obj_log.match(/<mnemonic>[^<]*<\/mnemonic>/g)) assert.ok(m.length - 21 <= 32, m);
  assert.match(docs.obj_log, /<mnemonicList>TIME,HKLA,BPOS,TQA,HPU_SOME_REALLY_LONG_METRIC_NAME<\/mnemonicList><unitList>s,Mgf,mm,daN.m,bar<\/unitList>/);
  assert.match(docs.obj_log, /<data>2026-10-01T00:00:01.000Z,61,,,<\/data>/);
});

test('messages and opsReport carry alarm and activity history', () => {
  assert.match(docs.obj_message, /<typeMessage>alarm<\/typeMessage><messageText>EMERGENCY SHUTDOWN ACTIVE: HI value 1 limit 1<\/messageText><severity>major<\/severity>/);
  assert.match(docs.obj_message, /<typeMessage>event<\/typeMessage><messageText>esd_active: acknowledged by admin<\/messageText>/);
  assert.match(docs.obj_opsReport, /<proprietaryCode namingSystem="AHWR-EDGE">TRIP_IN<\/proprietaryCode>/);
  assert.match(docs.obj_opsReport, /<typeActivityClass>downtime<\/typeActivityClass><productive>false<\/productive><itemState>actual<\/itemState><comments>NPT: Weather \(manual\)<\/comments>/);
  assert.match(docs.obj_opsReport, /<numAFE>JOB-77<\/numAFE><sum24Hr>2 activities; productive 2.0 h, NPT 0.0 h<\/sum24Hr>/);
});

test('documents validate against the WITSML 1.4.1.1 schemas (WITSML_XSD_DIR)', (t) => {
  const dir = process.env.WITSML_XSD_DIR;
  if (!dir) return t.skip('set WITSML_XSD_DIR to the 1.4.1.1 xsd_schemas folder to validate');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'witsml-'));
  for (const [schema, xml] of Object.entries(docs)) {
    const file = path.join(tmp, `${schema}.xml`);
    fs.writeFileSync(file, xml);
    execFileSync('xmllint', ['--noout', '--schema', path.join(dir, `${schema}.xsd`), file], { stdio: 'pipe' });
  }
});
