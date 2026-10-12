// ETP v1.2 producer: codec round trips and the ChannelStreaming sequence
// against a local consumer endpoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ahwr-etp-'));
process.env.DEVICE_ID = 'AHWR-TEST-ETP';
process.env.ETP_ENABLED = 'false';
const WebSocket = require('ws');
const etp = require('../lib/etp');
const sync = require('../lib/sync');
const { encode, decode, uuidFrom, uuidString } = etp._codec;

test('codec: messages round-trip with the official v1.2 schemas', () => {
  const buf = encode('Ping', { currentDateTime: 1791700000000000 }, 4, 0);
  const msg = decode(buf);
  assert.equal(msg.name, 'Ping');
  assert.deepEqual({ ...msg.header }, { protocol: 0, messageType: 8, correlationId: 0, messageId: 4, messageFlags: 2 });
  assert.equal(msg.body.currentDateTime, 1791700000000000);
  const data = decode(encode('ChannelData', { data: [{ channelId: 7, indexes: [{ item: { long: 1791700000000000 } }], value: { item: { double: 61.5 } }, valueAttributes: [] }] }, 6));
  assert.equal(data.name, 'ChannelData');
  assert.deepEqual(data.header.messageType, 2);
  assert.equal(data.body.data[0].value.item.double, 61.5);
});

test('channel UUIDs are deterministic RFC 4122 name-based ids', () => {
  const a = uuidString(uuidFrom('AHWR-1:drawworks.hook_load'));
  assert.equal(a, uuidString(uuidFrom('AHWR-1:drawworks.hook_load')));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('ChannelStreaming: session, StartStreaming, metadata before data, StopStreaming', async () => {
  const server = new WebSocket.Server({ port: 0, handleProtocols: (protocols) => (protocols.has('etp12.energistics.org') ? 'etp12.energistics.org' : false) });
  const port = server.address().port;
  const seen = [];
  let serverId = -1;
  const out = (name, body, corr = 0) => { serverId += 2; return encode(name, body, serverId, corr); };
  const done = new Promise((resolve) => {
    server.on('connection', (ws, req) => {
      assert.equal(req.headers['etp-encoding'], 'binary');
      ws.on('message', (raw) => {
        const m = decode(Buffer.from(raw));
        seen.push(m);
        if (m.name === 'RequestSession') {
          assert.deepEqual(m.body.requestedProtocols.map((p) => [p.protocol, p.role]), [[1, 'consumer']]);
          ws.send(out('OpenSession', {
            applicationName: 'test', applicationVersion: '1', serverInstanceId: Buffer.alloc(16, 1),
            supportedProtocols: [{ protocol: 1, protocolVersion: { major: 1, minor: 2, revision: 0, patch: 0 }, role: 'consumer', protocolCapabilities: {} }],
            supportedDataObjects: [], supportedCompression: '', supportedFormats: ['xml'],
            currentDateTime: Date.now() * 1000, earliestRetainedChangeTime: 0, sessionId: Buffer.alloc(16, 2), endpointCapabilities: {},
          }, m.header.messageId));
          setTimeout(() => {
            sync.enqueueTelemetry({ drawworks: { hook_load: 60 }, mudpump: { pressure: 120 } }, Date.now() - 200);
            ws.send(out('StartStreaming', {}));
          }, 300);
        }
        if (m.name === 'ChannelData' && seen.filter((x) => x.name === 'ChannelData').length === 1) {
          ws.send(out('StopStreaming', {}));
          setTimeout(resolve, 300);
        }
      });
    });
  });
  await etp.setConfig({ enabled: true, url: `ws://127.0.0.1:${port}`, streamSeconds: 1 });
  await done;
  etp.disconnect();
  await new Promise((r) => server.close(r));

  const names = seen.map((m) => m.name);
  assert.equal(names[0], 'RequestSession');
  assert.ok(names.indexOf('ChannelMetadata') > 0 && names.indexOf('ChannelMetadata') < names.indexOf('ChannelData'));
  const ids = seen.map((m) => m.header.messageId);
  ids.forEach((id, i) => { assert.equal(id % 2, 0); if (i) assert.ok(id > ids[i - 1]); });
  seen.forEach((m) => assert.ok(m.header.messageFlags & 0x02, `FIN on ${m.name}`));
  const meta = seen.find((m) => m.name === 'ChannelMetadata').body.channels;
  const hook = meta.find((c) => c.channelName === 'HKLA');
  assert.ok(hook, 'hook load channel announced with its mnemonic');
  const data = seen.find((m) => m.name === 'ChannelData').body.data;
  assert.ok(data.some((d) => d.channelId === hook.id && d.value.item.double === 60));
});
