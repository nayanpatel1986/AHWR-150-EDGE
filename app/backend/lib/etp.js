'use strict';
// ETP v1.2 producer (Energistics Transfer Protocol) — outbound, read-only publish.
//
// The edge connects as the ETP client (WebSocket subprotocol etp12.energistics.org,
// binary Avro encoding with the official ETP v1.2 schemas in etp12/schemas.json)
// and plays the PRODUCER role of ChannelStreaming (Protocol 1, the "simple
// streamer"), asking the server to be the consumer. Per the specification:
//   RequestSession -> OpenSession; the consumer sends StartStreaming; the producer
//   then sends ChannelMetadata for every channel and streams ChannelData (each
//   sample once, time index = UTC microseconds); new channels get ChannelMetadata
//   before their first data; StopStreaming stops the data. Client message IDs are
//   non-zero, even and increasing; every message carries the FIN bit (0x02).
// Never writes to a PLC.
const crypto = require('crypto');
const WebSocket = require('ws');
const avro = require('avsc');
const { getRecent } = require('./sync');
const { readJson, writeJson } = require('./persist');
const transport = require('./transport');
const witsml = require('./witsml');
const bundle = require('./etp12/schemas.json');

const SUBPROTOCOL = 'etp12.energistics.org';
const VERSION = { major: 1, minor: 2, revision: 0, patch: 0 };
const FIN = 0x02;
const CONFIG_FILE = 'etp_config.json';
const APP_VERSION = (() => { try { return require('../package.json').version; } catch { return '1.0'; } })();

// ---- Codec ------------------------------------------------------------------
const types = new Map();   // "protocol:messageType" -> { name, type }
let headerType = null;
for (const m of bundle.messages) {
    const type = avro.Type.forSchema(m.schema, { wrapUnions: true });
    if (m.name === 'MessageHeader') headerType = type;
    else types.set(`${m.protocol}:${m.messageType}`, { name: m.name, type });
}
const MSG = {
    RequestSession: [0, 1], OpenSession: [0, 2], CloseSession: [0, 5], Ping: [0, 8], Pong: [0, 9],
    ProtocolException: [0, 1000], Acknowledge: [0, 1001],
    ChannelMetadata: [1, 1], ChannelData: [1, 2], StartStreaming: [1, 3], StopStreaming: [1, 4], TruncateChannels: [1, 5],
};

function encode(name, body, messageId, correlationId = 0, flags = FIN) {
    const [protocol, messageType] = MSG[name];
    const header = headerType.toBuffer({ protocol, messageType, correlationId, messageId, messageFlags: flags });
    return Buffer.concat([header, types.get(`${protocol}:${messageType}`).type.toBuffer(body)]);
}

function decode(buf) {
    const h = headerType.decode(buf, 0);
    const header = h.value;
    const t = types.get(`${header.protocol}:${header.messageType}`);
    if (!t) return { header, name: null, body: null };
    return { header, name: t.name, body: t.type.decode(buf, h.offset).value };
}

// Deterministic RFC 4122 (name-based, SHA-1) UUIDs: stable per device / channel.
function uuidFrom(name) {
    const b = crypto.createHash('sha1').update(`ahwr-edge:${name}`).digest().subarray(0, 16);
    b[6] = (b[6] & 0x0f) | 0x50;
    b[8] = (b[8] & 0x3f) | 0x80;
    return b;
}
const uuidString = (b) => {
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const micros = (iso) => Date.parse(iso) * 1000;

// ---- State -----------------------------------------------------------------
const defaultConfig = {
    enabled: process.env.ETP_ENABLED === 'true',
    url: process.env.ETP_URL || '',
    deviceId: process.env.DEVICE_ID || 'AHWR-50-EDGE',
    token: process.env.DEVICE_TOKEN || '',
    streamSeconds: Number(process.env.ETP_STREAM_SECONDS || 1),
};
let config = { ...defaultConfig, ...readJson(CONFIG_FILE, {}) };
let io = null;
let describeMetric = () => ({});
let ws = null;
let messageId = 0;
let sessionId = null;
let streaming = false;
let streamTimer = null;
let reconnectTimer = null;
let lastSentMs = 0;                // last snapshot time already streamed
const channels = new Map();        // metric -> { id, uri, mnemonic, uom, label, announced }
let state = { connected: false, sessionEstablished: false, framesSent: 0, dataPointsSent: 0, lastSentAt: null, lastError: null, serverApplication: null };

const nextId = () => { messageId += 2; return messageId; };   // client: even, increasing
const emit = () => { if (io) try { io.emit('etp_status', getStatus()); } catch { /* ignore */ } };

function send(name, body, correlationId = 0) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(encode(name, body, nextId(), correlationId));
    return true;
}

function channelFor(metric) {
    let c = channels.get(metric);
    if (!c) {
        const info = describeMetric(metric) || {};
        c = {
            id: channels.size + 1,     // smallest available integer, unique for the session
            uri: `eml:///witsml21.Channel(${uuidString(uuidFrom(`${config.deviceId}:${metric}`))})`,
            mnemonic: null,
            uom: witsml.uomOf(info.unit),
            label: info.label || metric,
            announced: false,
        };
        channels.set(metric, c);
        const names = witsml.mnemonicsFor([...channels.keys()]);
        for (const [m, ch] of channels) ch.mnemonic = names.get(m);
    }
    return c;
}

function metadataRecord(metric, c, startMicros, endMicros) {
    return {
        uri: c.uri,
        id: c.id,
        indexes: [{
            indexKind: 'DateTime',
            interval: { startIndex: { item: { long: startMicros } }, endIndex: { item: { long: endMicros } }, uom: '', depthDatum: '' },
            direction: 'Increasing',
            name: 'TIME',
            uom: '',
            depthDatum: '',
            indexPropertyKindUri: '',
            filterable: true,
        }],
        channelName: c.mnemonic,
        dataKind: 'typeDouble',
        uom: c.uom,
        depthDatum: '',
        channelClassUri: '',
        status: 'Active',
        source: `AHWR-150 EDGE ${config.deviceId}: ${c.label} [${metric}]`.slice(0, 256),
        axisVectorLengths: [],
        attributeMetadata: [],
        customData: {},
    };
}

// Announce channels not yet described, then stream every new snapshot once.
function streamData() {
    if (!streaming) return;
    const snaps = getRecent(600).filter((s) => Date.parse(s.ts) > lastSentMs);
    if (!snaps.length) return;
    const pending = [];
    for (const s of snaps) {
        for (const [metric, raw] of Object.entries(s.values || {})) {
            if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
            const c = channelFor(metric);
            if (!c.announced) pending.push([metric, c]);
        }
    }
    if (pending.length) {
        const unique = [...new Map(pending).entries()];
        const start = micros(snaps[0].ts);
        const end = micros(snaps[snaps.length - 1].ts);
        send('ChannelMetadata', { channels: unique.map(([m, c]) => metadataRecord(m, c, start, end)) });
        unique.forEach(([, c]) => { c.announced = true; });
    }
    const data = [];
    for (const s of snaps) {
        const t = micros(s.ts);
        for (const [metric, raw] of Object.entries(s.values || {})) {
            if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
            data.push({ channelId: channelFor(metric).id, indexes: [{ item: { long: t } }], value: { item: { double: raw } }, valueAttributes: [] });
        }
    }
    lastSentMs = Date.parse(snaps[snaps.length - 1].ts);
    if (!data.length) return;
    if (send('ChannelData', { data })) {
        state.framesSent += 1; state.dataPointsSent += data.length; state.lastSentAt = new Date().toISOString();
        emit();
    }
}

function startStreaming() {
    streaming = true;
    // Spec: on StartStreaming the producer MUST send ChannelMetadata first.
    for (const c of channels.values()) c.announced = false;
    lastSentMs = Date.now() - config.streamSeconds * 1000;   // begin from the "current" index
    clearInterval(streamTimer);
    streamTimer = setInterval(streamData, Math.max(1, config.streamSeconds) * 1000);
    streamData();
    emit();
}

function stopStreaming() {
    streaming = false;
    clearInterval(streamTimer);
    streamTimer = null;
    emit();
}

function onMessage(raw, isBinary) {
    let msg;
    try {
        if (!isBinary) throw new Error('text frame received; only binary encoding is used');
        msg = decode(Buffer.from(raw));
    } catch (e) {
        state.lastError = `undecodable message: ${e.message}`;
        return emit();
    }
    const { header, name, body } = msg;
    switch (name) {
        case 'OpenSession':
            sessionId = uuidString(Buffer.from(body.sessionId));
            state.sessionEstablished = true; state.lastError = null;
            state.serverApplication = `${body.applicationName} ${body.applicationVersion}`;
            if (!body.supportedProtocols.some((p) => p.protocol === 1)) {
                state.lastError = 'server did not accept ChannelStreaming (Protocol 1) as consumer';
            }
            break;
        case 'StartStreaming': startStreaming(); break;
        case 'StopStreaming': stopStreaming(); break;
        case 'Ping': send('Pong', { currentDateTime: Date.now() * 1000 }, header.messageId); break;
        case 'CloseSession': disconnect(); scheduleReconnect(); break;
        case 'ProtocolException': {
            const e = body.error && (body.error['Energistics.Etp.v12.Datatypes.ErrorInfo'] || body.error);
            state.lastError = `ProtocolException ${e && e.code}: ${e && e.message}`;
            break;
        }
        default: break; // Acknowledge, Pong, others: nothing to do
    }
    emit();
}

function connect() {
    if (!config.enabled) return;
    clearTimeout(reconnectTimer);
    if (!config.url) { state.lastError = 'ETP URL not configured'; emit(); return; }
    const insecure = transport.insecureReason(config.url, transport.WS);
    if (insecure) { state.lastError = `ETP URL refused: ${insecure}`; emit(); return; }
    const headers = { 'etp-encoding': 'binary' };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    let socket;
    try {
        socket = new WebSocket(config.url, SUBPROTOCOL, { headers, handshakeTimeout: 10000 });
    } catch (e) { state.lastError = e.message; scheduleReconnect(); return; }
    ws = socket;
    messageId = 0;
    channels.clear();
    socket.on('open', () => {
        state.connected = true; state.lastError = null;
        send('RequestSession', {
            applicationName: 'AHWR-150 EDGE',
            applicationVersion: APP_VERSION,
            clientInstanceId: uuidFrom(`client:${config.deviceId}`),
            requestedProtocols: [{ protocol: 1, protocolVersion: VERSION, role: 'consumer', protocolCapabilities: {} }],
            supportedDataObjects: [{ qualifiedType: 'witsml21.Channel', dataObjectCapabilities: {} }],
            supportedCompression: [],
            supportedFormats: ['xml'],
            currentDateTime: Date.now() * 1000,
            earliestRetainedChangeTime: 0,
            serverAuthorizationRequired: false,
            endpointCapabilities: {},
        });
        emit();
    });
    socket.on('message', (data, isBinary) => { if (ws === socket) onMessage(data, isBinary); });
    socket.on('error', (e) => { state.lastError = e.message; });
    socket.on('close', () => {
        if (ws !== socket) return;
        state.connected = false; state.sessionEstablished = false; sessionId = null;
        stopStreaming(); scheduleReconnect();
    });
}

function scheduleReconnect() {
    if (!config.enabled) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 8000);
}

function disconnect() {
    clearTimeout(reconnectTimer);
    stopStreaming();
    const old = ws;
    ws = null;
    if (old) {
        try { if (old.readyState === WebSocket.OPEN) old.send(encode('CloseSession', { reason: 'edge closing session' }, nextId())); } catch { /* ignore */ }
        try { old.close(1000); } catch { /* ignore */ }
    }
    state.connected = false; state.sessionEstablished = false; sessionId = null;
}

function getStatus() {
    return {
        protocol: 'ETP v1.2', subprotocol: SUBPROTOCOL, encoding: 'binary', role: 'producer (ChannelStreaming)',
        enabled: config.enabled, url: config.url, deviceId: config.deviceId, tokenSet: !!config.token,
        connected: state.connected, sessionEstablished: state.sessionEstablished, sessionId, streaming,
        serverApplication: state.serverApplication,
        channels: channels.size, framesSent: state.framesSent, dataPointsSent: state.dataPointsSent,
        lastSentAt: state.lastSentAt, lastError: state.lastError, streamSeconds: config.streamSeconds,
    };
}

async function setConfig(next) {
    if ('url' in next && next.url) transport.assertSecure(next.url, transport.WS, 'ETP URL');
    if ('enabled' in next) config.enabled = !!next.enabled;
    if ('url' in next) config.url = String(next.url || '').trim();
    if ('deviceId' in next) config.deviceId = String(next.deviceId || '').trim() || defaultConfig.deviceId;
    if ('token' in next) config.token = String(next.token || '');
    if ('streamSeconds' in next) config.streamSeconds = Math.max(1, Number(next.streamSeconds) || 1);
    await writeJson(CONFIG_FILE, config);
    disconnect();
    if (config.enabled) connect();
    emit();
    return getStatus();
}

/** @param ioRef socket.io server; opts.describeMetric(metric) -> { label, unit } */
function start(ioRef, opts = {}) {
    io = ioRef;
    if (typeof opts.describeMetric === 'function') describeMetric = opts.describeMetric;
    if (config.enabled) connect();
}

module.exports = { start, getStatus, setConfig, disconnect, _codec: { encode, decode, MSG, uuidFrom, uuidString } };
