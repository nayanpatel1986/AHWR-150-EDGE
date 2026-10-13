// ETP v1.2 client: codec, identifiers, and both modes against local endpoints
// (ChannelStreaming consumer; Store + ChannelDataLoad store). The historian is
// replaced by an in-memory fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ahwr-etp-'));
process.env.DEVICE_ID = 'AHWR-TEST-ETP';
process.env.ETP_ENABLED = 'false';
process.env.PERSIST_BACKEND = 'file';
// Tiny catch-up reads: exercises reads that end part-way through a timestamp.
process.env.ETP_BACKFILL_ROWS = '3';

// ---- Fake historian --------------------------------------------------------------
const T0 = Math.floor(Date.now() / 1000) * 1000 - 120000;   // two minutes ago
const telemetry = [];
for (let i = 0; i < 5; i++) {
  telemetry.push({ ts: new Date(T0 + i * 1000), metric: 'drawworks.hook_load', value: 60 + i });
  telemetry.push({ ts: new Date(T0 + i * 1000), metric: 'mudpump.pressure', value: 100 + i });
}
const fakeTsdb = {
  async query(sql, params = []) {
    if (/FROM telemetry\s+WHERE rig_id = \$1 AND ts > \$2 AND ts <= \$4 ORDER BY ts LIMIT \$3/.test(sql)) {
      const after = new Date(params[1]).getTime();
      const upTo = new Date(params[3]).getTime();
      return { rows: telemetry.filter((r) => r.ts.getTime() > after && r.ts.getTime() <= upTo).sort((a, b) => a.ts - b.ts).slice(0, params[2]) };
    }
    if (/FROM channels/.test(sql)) return { rows: [] };
    if (/FROM well_runs/.test(sql)) return { rows: [] };
    return { rows: [] };
  },
};
require.cache[require.resolve('../lib/tsdb')] = { id: 'tsdb', filename: 'tsdb', loaded: true, exports: fakeTsdb };

const WebSocket = require('ws');
const codec = require('../lib/etp12/codec');
const { EtpSession } = require('../lib/etp12/session');
const uri = require('../lib/etp12/uri');
const ids = require('../lib/ids');
const channels = require('../lib/channels');
const energistics = require('../lib/energistics');
const etp = require('../lib/etp');

const dict = channels.buildDictionary({
  rigId: 'AHWR-TEST-ETP',
  rows: [
    { metric: 'drawworks.hook_load', label: 'Hook Load', unit: 't' },
    { metric: 'mudpump.pressure', label: 'Pump Pressure', unit: 'bar' },
    { metric: 'hpu.oil_temp', label: 'HPU Oil Temperature', unit: '°C' },   // never has data
  ],
});
energistics.configure({ getRigId: () => 'AHWR-TEST-ETP', getDictionary: () => dict, getWells: () => [] });
etp.start(null, {
  getChannels: () => dict,
  readTelemetry: async (afterMs, uptoMs, limit) => telemetry.filter((r) => r.ts.getTime() > afterMs && r.ts.getTime() <= uptoMs).sort((a, b) => a.ts - b.ts).slice(0, limit),
  listObjects: () => energistics.listObjects(),
});

test('codec: every protocol message round-trips; exceptions travel in any protocol', () => {
  const ping = codec.decode(codec.encode(0, 'Ping', { currentDateTime: 1791700000000000 }, { messageId: 4 }));
  assert.equal(ping.name, 'Ping');
  assert.deepEqual({ ...ping.header }, { protocol: 0, messageType: 8, correlationId: 0, messageId: 4, messageFlags: 2 });
  const data = codec.decode(codec.encode(22, 'ChannelData', { data: [{ channelId: 7, indexes: [codec.indexValue(T0)], value: { item: { double: 61.5 } }, valueAttributes: [] }] }, { messageId: 6 }));
  assert.deepEqual([data.protocol, data.name, data.header.messageType], [22, 'ChannelData', 4]);
  assert.equal(codec.indexOf(data.body.data[0].indexes[0]), T0 * 1000);
  const pe = codec.decode(codec.encode(3, 'ProtocolException', { error: codec.errorInfo(11, 'not found'), errors: {} }, { messageId: 3, correlationId: 2 }));
  assert.deepEqual([pe.protocol, pe.name, pe.header.messageType], [3, 'ProtocolException', 1000]);
});

test('identifiers: RFC 4122 v5 and canonical URIs', () => {
  assert.equal(ids.uuid5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  const c = dict.get('drawworks.hook_load');
  assert.equal(c.uuid, ids.channel('AHWR-TEST-ETP', 'drawworks.hook_load'));
  assert.deepEqual(uri.parse(uri.object('witsml21.Channel', c.uuid)), { kind: 'object', dataspace: '', type: 'witsml21.Channel', uuid: c.uuid, version: null });
  assert.equal(uri.parse('eml://witsml21.Channel(x)'), null);
});

/** A local ETP endpoint: onSession(session, requestSessionMsg). */
async function endpoint(onSession) {
  const server = new WebSocket.Server({ port: 0, handleProtocols: (p) => (p.has(codec.SUBPROTOCOL) ? codec.SUBPROTOCOL : false) });
  const seen = [];
  server.on('connection', (ws, req) => {
    assert.equal(req.headers['etp-encoding'], 'binary');
    const s = new EtpSession(ws, { side: 'server' });
    s.on('message', (m) => { seen.push(m); if (m.name === 'RequestSession') onSession(s, m, req); else if (s.onMsg) s.onMsg(m); });
  });
  await new Promise((r) => server.on('listening', r));
  return { server, seen, url: `ws://127.0.0.1:${server.address().port}` };
}
const openSession = (s, m, protocols) => s.send(0, 'OpenSession', {
  applicationName: 'test store', applicationVersion: '1', serverInstanceId: Buffer.alloc(16, 1),
  supportedProtocols: protocols.map(([protocol, role]) => ({ protocol, protocolVersion: codec.VERSION, role, protocolCapabilities: {} })),
  supportedDataObjects: [], supportedCompression: '', supportedFormats: ['xml'],
  currentDateTime: Date.now() * 1000, earliestRetainedChangeTime: 0, sessionId: Buffer.alloc(16, 2), endpointCapabilities: {},
}, { correlationId: m.header.messageId });
const until = async (cond, ms = 8000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout: ' + JSON.stringify(etp.getStatus())); await new Promise((r) => setTimeout(r, 50)); } };

test('producer mode: StartStreaming, metadata with PWLS property kinds before data, presented units', async () => {
  const ep = await endpoint((s, m) => {
    assert.deepEqual(m.body.requestedProtocols.map((p) => [p.protocol, p.role]), [[1, 'consumer']]);
    openSession(s, m, [[1, 'consumer']]);
    setTimeout(() => s.send(1, 'StartStreaming', {}), 100);
  });
  telemetry.push({ ts: new Date(Date.now() - 4500), metric: 'mudpump.pressure', value: 120 });   // ages past the tail lag
  await etp.setConfig({ enabled: true, url: ep.url, mode: 'producer', token: '', streamSeconds: 1 });
  await until(() => ep.seen.some((m) => m.name === 'ChannelData'));
  etp.disconnect();
  telemetry.pop();
  await new Promise((r) => ep.server.close(r));
  const names = ep.seen.map((m) => m.name);
  assert.ok(names.indexOf('ChannelMetadata') > 0 && names.indexOf('ChannelMetadata') < names.indexOf('ChannelData'));
  const ids2 = ep.seen.map((m) => m.header.messageId);
  ids2.forEach((id, i) => { assert.equal(id % 2, 0); if (i) assert.ok(id > ids2[i - 1]); });
  ep.seen.forEach((m) => assert.ok(m.header.messageFlags & 0x02, `FIN on ${m.name}`));
  const meta = ep.seen.find((m) => m.name === 'ChannelMetadata').body.channels;
  const spp = meta.find((c) => c.channelName === 'SPPA');
  assert.equal(spp.uri, uri.object('witsml21.Channel', dict.get('mudpump.pressure').uuid));
  assert.equal(spp.uom, 'psi');
  assert.equal(spp.channelClassUri, 'eml:///eml23.PropertyKind(f001a670-584b-4527-9db5-89bc304b82a5)');   // PWLS standpipe pressure
  const data = ep.seen.find((m) => m.name === 'ChannelData').body.data;
  assert.ok(data.some((d) => d.channelId === spp.id && Math.abs(d.value.item.double - 120 * 14.5037738) < 1e-6));
});

test('store mode: puts objects, opens channels, resumes after the store\'s last index', async () => {
  const puts = [];
  const sent = [];
  const ep = await endpoint((s, m, req) => {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('AHWR-TEST-ETP:secret').toString('base64')}`);
    assert.deepEqual(m.body.requestedProtocols.map((p) => [p.protocol, p.role]), [[4, 'store'], [22, 'store']]);
    openSession(s, m, [[4, 'store'], [22, 'store']]);
    s.onMsg = (msg) => {
      if (msg.name === 'PutDataObjects') {
        for (const o of Object.values(msg.body.dataObjects)) puts.push([o.resource.uri, Buffer.from(o.data).toString('utf8'), o.resource.customData]);
        s.reply(msg, 'PutDataObjectsResponse', { success: Object.fromEntries(Object.keys(msg.body.dataObjects).map((k) => [k, { createdContainedObjectUris: [], deletedContainedObjectUris: [], joinedContainedObjectUris: [], unjoinedContainedObjectUris: [] }])) });
      } else if (msg.name === 'OpenChannels') {
        const channelsOut = {};
        for (const [k, u] of Object.entries(msg.body.uris)) {
          const c = [...dict.values()].find((x) => uri.object('witsml21.Channel', x.uuid) === u);
          // The store already holds hook load up to T0+2 s; pump pressure is empty.
          const end = c.metric === 'drawworks.hook_load' ? codec.indexValue(T0 + 2000) : { item: null };
          channelsOut[k] = { metadata: { uri: u, id: Number(k) + 100, indexes: [{ indexKind: 'DateTime', interval: { startIndex: { item: null }, endIndex: end, uom: 'us', depthDatum: '' }, direction: 'Increasing', name: 'TIME', uom: 'us', depthDatum: '', indexPropertyKindUri: '', filterable: true }],
            channelName: c.mnemonic, dataKind: 'typeDouble', uom: c.uom, depthDatum: '', channelClassUri: '', status: 'Active', source: '', axisVectorLengths: [], attributeMetadata: [], customData: {} }, preferRealtime: true, dataChanges: false };
        }
        s.reply(msg, 'OpenChannelsResponse', { channels: channelsOut });
      } else if (msg.name === 'ChannelData') {
        sent.push(...msg.body.data);
      }
    };
  });
  await etp.setConfig({ enabled: true, url: ep.url, mode: 'store', token: 'secret', authScheme: 'basic', deviceId: 'AHWR-TEST-ETP', backfillHours: 24 * 400, streamSeconds: 1 });
  await until(() => sent.length >= 7);   // hook load after T0+2 s (2) + pressure from the start (5)
  etp.disconnect();
  await new Promise((r) => ep.server.close(r));
  const channelPuts = puts.filter(([u]) => u.includes('witsml21.Channel('));
  assert.equal(channelPuts.length, 3);
  assert.match(channelPuts[0][1], /<witsml:Channel [^>]*schemaVersion="2.1"/);
  assert.equal(codec.dataValueOf(channelPuts.find(([u]) => u.includes(dict.get('mudpump.pressure').uuid))[2].factor), 14.5037738);
  assert.ok(puts.some(([u]) => u.includes('eml23.PropertyKind(f001a670-584b-4527-9db5-89bc304b82a5)')), 'PWLS property kind put');
  const hook = sent.filter((d) => [101, 102].includes(Number(d.channelId)) && Math.abs(d.value.item.double - 62) < 10 && d.value.item.double < 70);
  const times = hook.map((d) => codec.indexOf(d.indexes[0]) / 1000);
  assert.ok(times.every((t) => t > T0 + 2000), 'hook load resumes after the store\'s last index');
  assert.deepEqual(hook.map((d) => d.value.item.double), [63, 64]);
  const spp = sent.filter((d) => d.value.item.double > 1000).map((d) => d.value.item.double);
  assert.deepEqual(spp.slice(0, 5).map((v) => Math.round(v / 14.5037738)), [100, 101, 102, 103, 104], 'pressure backfilled from the start, in psi');
});
