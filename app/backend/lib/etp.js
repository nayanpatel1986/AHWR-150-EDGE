'use strict';
// ETP v1.2 client of the edge (Energistics Transfer Protocol), outbound only.
// WebSocket subprotocol etp12.energistics.org, binary Avro with the official
// v1.2 schemas (lib/etp12). Two modes:
//
//   store     (default for the CMF) the edge is the CUSTOMER of a store:
//             Store (Protocol 4) PutDataObjects for the rig's WITSML 2.1 objects
//             (Rig, Well, Wellbore, RigUtilization, Channels, BusinessAssociates,
//             PWLS PropertyKinds), then ChannelDataLoad (Protocol 22):
//             OpenChannels -> the store returns each channel's last index ->
//             the edge sends everything after it from the historian, then new
//             data as Telegraf writes it. Lossless across outages (the ETP v1.2
//             spec requires Protocols 21/22 when no data may be lost).
//   producer  ChannelStreaming (Protocol 1), the "simple streamer": on
//             StartStreaming the edge announces its channels (ChannelMetadata) and
//             streams new values; no resume after a disconnect.
//
// The data source and the object list are supplied by the application (start()):
//   readTelemetry(afterMs, uptoMs, limit) -> [{ ts, metric, value (stored unit) }] oldest first
//   listObjects() -> lib/energistics.js descriptors
// (AHWR-150 EDGE: the TimescaleDB historian; an edge without one can pass a
// memory-backed reader, which limits how far back store mode can resume.)
//
// Channel identity and metadata come from the channel dictionary (lib/channels.js):
// canonical URI eml:///witsml21.Channel(<uuid>), Energistics unit of the
// presented values, PWLS property kind (channelClassUri). Time index: UTC
// microseconds. Never writes to a PLC.
const WebSocket = require('ws');
const codec = require('./etp12/codec');
const { EtpSession } = require('./etp12/session');
const uri = require('./etp12/uri');
const ids = require('./ids');
const { readJson, writeJson } = require('./persist');
const transport = require('./transport');

const { PROTOCOL: P, VERSION } = codec;
const CONFIG_FILE = 'etp_config.json';
const APP_VERSION = (() => { try { return require('../package.json').version; } catch { return '1.0'; } })();
const PUT_BATCH = 50;
const OPEN_BATCH = 500;
const ITEMS_PER_MESSAGE = 5000;
const BACKFILL_ROWS = Number(process.env.ETP_BACKFILL_ROWS || 50000);   // rows per catch-up query
const MAX_BUFFERED = 8 * 1024 * 1024;   // pause sending above this WebSocket backlog
// Only data at least this old is sent: Telegraf commits the points of one second
// in several writes, so the newest second may still be incomplete when read.
const TAIL_LAG_MS = Number(process.env.ETP_TAIL_LAG_SECONDS || 5) * 1000;


const defaultConfig = {
    enabled: process.env.ETP_ENABLED === 'true',
    url: process.env.ETP_URL || '',
    mode: process.env.ETP_MODE === 'producer' ? 'producer' : 'store',
    deviceId: process.env.DEVICE_ID || 'AHWR-50-EDGE',
    token: process.env.DEVICE_TOKEN || '',
    // basic: "<device id>:<token>" (the CMF's per-rig credential); bearer: the token.
    authScheme: process.env.ETP_AUTH === 'bearer' ? 'bearer' : 'basic',
    streamSeconds: Number(process.env.ETP_STREAM_SECONDS || 1),
    backfillHours: Number(process.env.ETP_BACKFILL_HOURS || 24),
};
let config = { ...defaultConfig, ...readJson(CONFIG_FILE, {}) };
let io = null;
let getChannels = () => new Map();
let readTelemetry = async () => [];
let listObjects = async () => [];
let applicationName = 'AHWR-150 EDGE';
let session = null;
let reconnectTimer = null;
let loopTimer = null;
let runId = 0;                       // increments per connection; stale callbacks check it
// producer: metric -> { id, announced }; store: metric -> { id, cursor (ms) }
let channelIds = new Map();
let streaming = false;
let lastSentMs = 0;
let state = {};
const resetState = () => {
    state = {
        connected: false, sessionEstablished: false, sessionId: null, serverApplication: null, protocols: [],
        objectsPut: 0, objectErrors: 0, channelsOpen: 0, framesSent: 0, dataPointsSent: 0,
        backfilling: false, lastSentAt: null, lastDataTime: null, lastError: null,
    };
};
resetState();
const emit = () => { if (io) try { io.emit('etp_status', getStatus()); } catch { /* ignore */ } };
const fail = (msg) => { state.lastError = msg; emit(); };

// ---- Metadata ------------------------------------------------------------------
const indexInterval = (startMs, endMs) => ({
    startIndex: startMs ? codec.indexValue(startMs) : { item: null },
    endIndex: endMs ? codec.indexValue(endMs) : { item: null },
    uom: 'us', depthDatum: '',
});
function metadataRecord(c, id, startMs, endMs) {
    return {
        uri: uri.object('witsml21.Channel', c.uuid), id,
        indexes: [{
            indexKind: 'DateTime', interval: indexInterval(startMs, endMs), direction: 'Increasing', name: 'TIME',
            uom: 'us', depthDatum: '', indexPropertyKindUri: '', filterable: true,
        }],
        channelName: c.mnemonic, dataKind: 'typeDouble', uom: c.uom, depthDatum: '',
        channelClassUri: uri.object('eml23.PropertyKind', c.propertyKind.uuid),
        status: 'Active', source: `${applicationName} ${config.deviceId}: ${c.label} [${c.metric}]`.slice(0, 256),
        axisVectorLengths: [], attributeMetadata: [], customData: {},
    };
}
const dataItem = (id, tsMs, stored, factor) => ({
    channelId: id, indexes: [codec.indexValue(tsMs)], value: { item: { double: Number(stored) * (factor || 1) } }, valueAttributes: [],
});

function sendData(protocol, items) {
    for (let i = 0; i < items.length; i += ITEMS_PER_MESSAGE) {
        session.send(protocol, 'ChannelData', { data: items.slice(i, i + ITEMS_PER_MESSAGE) });
        state.framesSent += 1;
    }
    state.dataPointsSent += items.length;
    state.lastSentAt = new Date().toISOString();
}
const congested = () => session && session.ws.bufferedAmount > MAX_BUFFERED;

// ---- Producer mode (Protocol 1) ---------------------------------------------------
async function producerTick(myRun) {
    if (!streaming || myRun !== runId || congested()) return;
    const dict = getChannels();
    const rows = await readTelemetry(lastSentMs, Date.now() - TAIL_LAG_MS, ITEMS_PER_MESSAGE * 4);
    if (myRun !== runId || !rows.length) return;
    // A full read may end part-way through its last timestamp: send up to just
    // before it and read that timestamp again next time.
    const limit = ITEMS_PER_MESSAGE * 4;
    const lastTs = new Date(rows[rows.length - 1].ts).getTime();
    const batch = rows.length < limit ? rows : rows.filter((r) => new Date(r.ts).getTime() < lastTs);
    const announce = [];
    const items = [];
    for (const r of batch) {
        const c = dict.get(r.metric);
        if (!c) continue;                       // not described: no valid unit/property kind
        let ch = channelIds.get(r.metric);
        if (!ch) { ch = { id: channelIds.size + 1, announced: false }; channelIds.set(r.metric, ch); }
        if (!ch.announced) { announce.push(metadataRecord(c, ch.id, null, null)); ch.announced = true; }
        items.push(dataItem(ch.id, new Date(r.ts).getTime(), r.value, c.factor));
    }
    // New channels are described before their first data (spec 6.2.1.1 2b).
    if (announce.length) session.send(P.ChannelStreaming, 'ChannelMetadata', { channels: announce });
    if (items.length) sendData(P.ChannelStreaming, items);
    lastSentMs = rows.length < limit ? lastTs : lastTs - 1;
    state.lastDataTime = new Date(lastSentMs).toISOString();
    emit();
}

function startStreaming(myRun) {
    streaming = true;
    for (const ch of channelIds.values()) ch.announced = false;   // metadata first after StartStreaming
    lastSentMs = Date.now() - config.streamSeconds * 1000 - TAIL_LAG_MS;   // from the "current" index
    clearInterval(loopTimer);
    loopTimer = setInterval(() => producerTick(myRun).catch((e) => fail(`stream: ${e.message}`)), Math.max(1, config.streamSeconds) * 1000);
    emit();
}

// ---- Store mode (Protocols 4 + 22) --------------------------------------------------
async function putObjects(myRun) {
    const objects = (await listObjects()).filter((o) => o.type !== 'witsml21.Log' && o.type !== 'witsml21.ChannelSet');
    const order = ['eml23.BusinessAssociate', 'eml23.PropertyKind', 'witsml21.Rig', 'witsml21.Well', 'witsml21.Wellbore', 'witsml21.RigUtilization', 'witsml21.Channel'];
    objects.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    const dict = getChannels();
    for (let i = 0; i < objects.length; i += PUT_BATCH) {
        if (myRun !== runId) return;
        const dataObjects = {};
        for (const [k, o] of objects.slice(i, i + PUT_BATCH).entries()) {
            const c = o.metric ? dict.get(o.metric) : null;
            const customData = c ? {
                metric: { item: { string: c.metric } }, factor: { item: { double: c.factor } },
                storedUnit: { item: { string: c.storedUnit || '' } }, unitSource: { item: { string: c.unitSource } },
            } : {};
            const changed = o.lastChanged ? Date.parse(o.lastChanged) * 1000 : 0;
            dataObjects[String(k + 1)] = {
                resource: { uri: uri.object(o.type, o.uuid), alternateUris: [], name: String(o.title || o.uuid).slice(0, 2000),
                    sourceCount: null, targetCount: null, lastChanged: changed, storeLastWrite: 0, storeCreated: 0,
                    activeStatus: 'Active', customData },
                format: 'xml', blobId: null, data: Buffer.from(await o.xml(), 'utf8'),
            };
        }
        const r = await session.request(P.Store, 'PutDataObjects', { dataObjects, pruneContainedObjects: false });
        const errors = Object.values(r.errors);
        state.objectsPut += Object.keys(dataObjects).length - errors.length;
        state.objectErrors += errors.length;
        if (errors.length) state.lastError = `PutDataObjects: ${errors[0].message} (${errors[0].code})`;
    }
    emit();
}

async function openChannels(myRun) {
    const dict = [...getChannels().values()];
    const fresh = dict.filter((c) => !channelIds.has(c.metric));
    for (let i = 0; i < fresh.length; i += OPEN_BATCH) {
        if (myRun !== runId) return;
        const part = fresh.slice(i, i + OPEN_BATCH);
        const uris = Object.fromEntries(part.map((c, k) => [String(k + 1), uri.object('witsml21.Channel', c.uuid)]));
        const r = await session.request(P.ChannelDataLoad, 'OpenChannels', { uris });
        const defaultStart = Date.now() - config.backfillHours * 3600 * 1000;
        for (const msg of r.parts) {
            for (const [key, info] of Object.entries(msg.body.channels)) {
                const c = part[Number(key) - 1];
                const end = codec.indexOf(info.metadata.indexes[0].interval.endIndex);
                // Resume after the store's last point (never earlier than the backfill window).
                const cursor = end !== null ? Math.max(Math.floor(end / 1000), defaultStart) : defaultStart;
                channelIds.set(c.metric, { id: Number(info.metadata.id), cursor });
            }
        }
        const errors = Object.values(r.errors);
        if (errors.length) state.lastError = `OpenChannels: ${errors.length} channel(s) refused, e.g. ${errors[0].message}`;
    }
    state.channelsOpen = channelIds.size;
    emit();
}

/** Send everything after each channel's cursor, oldest first; repeats until caught up. */
async function loadTick(myRun) {
    if (myRun !== runId || !channelIds.size || congested()) return;
    const dict = getChannels();
    let from = Infinity;
    for (const ch of channelIds.values()) from = Math.min(from, ch.cursor);
    const rows = await readTelemetry(from, Date.now() - TAIL_LAG_MS, BACKFILL_ROWS);
    if (myRun !== runId) return;
    const items = [];
    for (const r of rows) {
        const ch = channelIds.get(r.metric);
        const c = dict.get(r.metric);
        const t = new Date(r.ts).getTime();
        if (!ch || !c || t <= ch.cursor) continue;
        items.push(dataItem(ch.id, t, r.value, c.factor));
        ch.cursor = t;
    }
    // Channels with nothing in what was read move up to it. A full read may end
    // part-way through the points of its last timestamp, so stop just before it.
    if (rows.length) {
        const last = new Date(rows[rows.length - 1].ts).getTime();
        const floor = rows.length < BACKFILL_ROWS ? last : last - 1;
        for (const ch of channelIds.values()) if (ch.cursor < floor) ch.cursor = floor;
        state.lastDataTime = new Date(last).toISOString();
    }
    if (items.length) sendData(P.ChannelDataLoad, items);
    if (state.lastError && state.lastError.startsWith('load:')) state.lastError = null;
    state.backfilling = rows.length === BACKFILL_ROWS;
    emit();
    if (state.backfilling) setImmediate(() => loadTick(myRun).catch((e) => fail(`load: ${e.message}`)));
}

let objectsTimer = null;
async function startStore(myRun) {
    await putObjects(myRun);
    await openChannels(myRun);
    clearInterval(loopTimer);
    loopTimer = setInterval(() => loadTick(myRun).catch((e) => fail(`load: ${e.message}`)), Math.max(1, config.streamSeconds) * 1000);
    loadTick(myRun).catch((e) => fail(`load: ${e.message}`));
    // New wells, runs and channels reach the store within ten minutes.
    clearInterval(objectsTimer);
    objectsTimer = setInterval(() => {
        if (myRun !== runId) return;
        putObjects(myRun).then(() => openChannels(myRun)).catch((e) => fail(`objects: ${e.message}`));
    }, 10 * 60 * 1000);
}

// ---- Connection ------------------------------------------------------------------------
function requestedProtocols() {
    const p = (protocol, role) => ({ protocol, protocolVersion: VERSION, role, protocolCapabilities: {} });
    return config.mode === 'producer' ? [p(P.ChannelStreaming, 'consumer')] : [p(P.Store, 'store'), p(P.ChannelDataLoad, 'store')];
}

function connect() {
    if (!config.enabled) return;
    clearTimeout(reconnectTimer);
    if (!config.url) return fail('ETP URL not configured');
    const insecure = transport.insecureReason(config.url, transport.WS);
    if (insecure) return fail(`ETP URL refused: ${insecure}`);
    const headers = { 'etp-encoding': 'binary' };
    if (config.token) {
        headers.authorization = config.authScheme === 'bearer'
            ? `Bearer ${config.token}`
            : `Basic ${Buffer.from(`${config.deviceId}:${config.token}`).toString('base64')}`;
    }
    let ws;
    try {
        ws = new WebSocket(config.url, codec.SUBPROTOCOL, { headers, handshakeTimeout: 10000, perMessageDeflate: false });
    } catch (e) { fail(e.message); return scheduleReconnect(); }
    const myRun = ++runId;
    channelIds = new Map();
    streaming = false;
    resetState();
    const s = new EtpSession(ws, { side: 'client' });
    session = s;
    ws.on('unexpected-response', (req, res) => fail(`ETP connection refused: HTTP ${res.statusCode}`));
    ws.on('error', (e) => { state.lastError = e.message; });
    ws.on('open', () => {
        state.connected = true;
        s.request(P.Core, 'RequestSession', {
            applicationName, applicationVersion: APP_VERSION,
            clientInstanceId: ids.toBytes(ids.uuid5(`etp-client:${config.deviceId}`, ids.NAMESPACE)),
            requestedProtocols: requestedProtocols(),
            supportedDataObjects: ['witsml21.Well', 'witsml21.Wellbore', 'witsml21.Rig', 'witsml21.RigUtilization', 'witsml21.Channel',
                'eml23.BusinessAssociate', 'eml23.PropertyKind'].map((qualifiedType) => ({ qualifiedType, dataObjectCapabilities: {} })),
            supportedCompression: [], supportedFormats: ['xml'],
            currentDateTime: Date.now() * 1000, earliestRetainedChangeTime: 0,
            serverAuthorizationRequired: false, endpointCapabilities: {},
        }).then(({ parts }) => {
            const open = parts[0] && parts[0].body;
            if (myRun !== runId || !open) return;
            state.sessionEstablished = true;
            state.sessionId = ids.format(open.sessionId);
            state.serverApplication = `${open.applicationName} ${open.applicationVersion}`;
            state.protocols = open.supportedProtocols.map((x) => `${x.protocol}:${x.role}`);
            state.lastError = null;
            emit();
            const has = (pr) => open.supportedProtocols.some((x) => x.protocol === pr);
            if (config.mode === 'store') {
                if (!has(P.Store) || !has(P.ChannelDataLoad)) return fail('the server did not accept Store (4) and ChannelDataLoad (22) in the store role');
                return startStore(myRun).catch((e) => fail(`store: ${e.message}`));
            }
            if (!has(P.ChannelStreaming)) fail('the server did not accept ChannelStreaming (1) as consumer');
            return undefined;
        }).catch((e) => fail(`RequestSession: ${e.message}`));
    });
    s.on('message', (msg) => {
        if (myRun !== runId) return;
        if (msg.protocol === P.ChannelStreaming && msg.name === 'StartStreaming') startStreaming(myRun);
        else if (msg.protocol === P.ChannelStreaming && msg.name === 'StopStreaming') { streaming = false; clearInterval(loopTimer); emit(); }
        else if (msg.protocol === P.ChannelDataLoad && msg.name === 'ChannelsClosed') {
            for (const [metric, ch] of channelIds) if (Object.values(msg.body.id).map(Number).includes(ch.id)) channelIds.delete(metric);
            state.channelsOpen = channelIds.size;
        } else if (msg.name === 'ProtocolException') {
            const e = msg.body.error && (msg.body.error['Energistics.Etp.v12.Datatypes.ErrorInfo'] || msg.body.error);
            if (e) fail(`ProtocolException ${e.code}: ${e.message}`);
        } else if (msg.protocol === P.Core && msg.name === 'CloseSession') { s.close('server closed the session'); }
        emit();
    });
    s.on('close', () => {
        if (myRun !== runId) return;
        clearInterval(loopTimer); clearInterval(objectsTimer);
        streaming = false;
        state.connected = false; state.sessionEstablished = false;
        emit();
        scheduleReconnect();
    });
    return undefined;
}

function scheduleReconnect() {
    if (!config.enabled) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 8000);
}

function disconnect() {
    clearTimeout(reconnectTimer);
    clearInterval(loopTimer); clearInterval(objectsTimer);
    runId += 1;
    streaming = false;
    const s = session;
    session = null;
    if (s) s.close('edge closing session');
    state.connected = false; state.sessionEstablished = false;
}

function getStatus() {
    return {
        protocol: 'ETP v1.2', subprotocol: codec.SUBPROTOCOL, encoding: 'binary',
        mode: config.mode,
        role: config.mode === 'producer' ? 'producer (ChannelStreaming, Protocol 1)' : 'customer (Store 4 + ChannelDataLoad 22)',
        enabled: config.enabled, url: config.url, deviceId: config.deviceId, tokenSet: !!config.token, authScheme: config.authScheme,
        ...state, streaming, channels: channelIds.size, streamSeconds: config.streamSeconds, backfillHours: config.backfillHours,
    };
}

async function setConfig(next) {
    if ('url' in next && next.url) transport.assertSecure(next.url, transport.WS, 'ETP URL');
    if ('enabled' in next) config.enabled = !!next.enabled;
    if ('url' in next) config.url = String(next.url || '').trim();
    if ('mode' in next) config.mode = next.mode === 'producer' ? 'producer' : 'store';
    if ('deviceId' in next) config.deviceId = String(next.deviceId || '').trim() || defaultConfig.deviceId;
    if ('token' in next) config.token = String(next.token || '');
    if ('authScheme' in next) config.authScheme = next.authScheme === 'bearer' ? 'bearer' : 'basic';
    if ('streamSeconds' in next) config.streamSeconds = Math.max(1, Number(next.streamSeconds) || 1);
    if ('backfillHours' in next) config.backfillHours = Math.min(24 * 30, Math.max(0, Number(next.backfillHours) || 0));
    await writeJson(CONFIG_FILE, config);
    disconnect();
    if (config.enabled) connect();
    emit();
    return getStatus();
}

/**
 * @param ioRef socket.io server
 * @param opts.getChannels()  Map metric -> channel dictionary entry
 * @param opts.readTelemetry(afterMs, uptoMs, limit)  stored points, oldest first
 * @param opts.listObjects()  the edge's data objects (lib/energistics.js)
 * @param opts.applicationName  name sent in RequestSession (default AHWR-150 EDGE)
 */
function start(ioRef, opts = {}) {
    io = ioRef;
    if (typeof opts.getChannels === 'function') getChannels = opts.getChannels;
    if (typeof opts.readTelemetry === 'function') readTelemetry = opts.readTelemetry;
    if (typeof opts.listObjects === 'function') listObjects = opts.listObjects;
    if (opts.applicationName) applicationName = String(opts.applicationName);
    if (config.enabled) connect();
}

module.exports = { start, getStatus, setConfig, disconnect };
