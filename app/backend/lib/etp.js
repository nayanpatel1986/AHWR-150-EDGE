'use strict';
// ETP 2.0 publisher (Energistics Transfer Protocol) — pragmatic JSON-encoded subset.
// Connects to an ETP server over WebSocket, performs the Session handshake
// (RequestSession -> OpenSession), advertises channel metadata, then streams
// ChannelData frames from the live rig payload. OUTBOUND ONLY (read-only publish).
//
// Scope note: this implements ETP 2.0's message envelope + ChannelStreaming flow with
// the JSON encoding ("application/x-etp-message+json"). Full Avro binary encoding and
// the complete protocol-capability set are the documented next step.
const WebSocket = require('ws'); // present via socket.io's dependency tree
const { getRecent } = require('./sync');
const { readJson, writeJson } = require('./persist');

const ETP_SUBPROTOCOL = 'etp12.energistics.org';
const CONFIG_FILE = 'etp_config.json';
// ETP message envelope protocols/messageTypes used here
const P = { Core: 0, ChannelStreaming: 1 };
const MT = { RequestSession: 1, OpenSession: 2, CloseSession: 5, ChannelMetadata: 1, ChannelData: 3 };

// Seed channels preserve the original IDs for compatibility; all other live
// numeric tags are discovered from the shared sync ring and appended dynamically.
const SEEDED_CHANNELS = [
    { id: 1, mnem: 'HKLD', key: 'drawworks.hook_load', uom: 't' },
    { id: 2, mnem: 'BPOS', key: 'drawworks.block_position', uom: 'ft' },
    { id: 3, mnem: 'WOB', key: 'drilling.wob', uom: 't' },
    { id: 4, mnem: 'SPPA', key: 'mudpump.pressure', uom: 'bar' },
    { id: 5, mnem: 'TUBP', key: 'wellhead.tubing_pressure', uom: 'bar' },
    { id: 6, mnem: 'CASP', key: 'wellhead.casing_pressure', uom: 'bar' },
    { id: 7, mnem: 'DMEA', key: 'drilling.hole_depth', uom: 'm' },
    { id: 8, mnem: 'CAT_ENGINE_RPM', key: 'cat_engine.rpm', uom: 'rpm' },
    { id: 9, mnem: 'CAT_ENGINE_LOAD', key: 'cat_engine.load', uom: '%' },
    { id: 10, mnem: 'CAT_ENGINE_OIL_PRESSURE', key: 'cat_engine.oil_pressure', uom: 'bar' },
    { id: 11, mnem: 'CAT_ENGINE_PEDAL_POSITION', key: 'cat_engine.pedal_position', uom: '%' },
];
const channelByKey = new Map(SEEDED_CHANNELS.map((channel) => [channel.key, channel]));
let nextChannelId = Math.max(...SEEDED_CHANNELS.map((channel) => channel.id)) + 1;

const defaultConfig = {
    enabled: process.env.ETP_ENABLED === 'true' || (process.env.ETP_URL ? true : false),
    url: process.env.ETP_URL || '',
    deviceId: process.env.DEVICE_ID || 'AHWR-50-EDGE',
    token: process.env.DEVICE_TOKEN || '',
    streamSeconds: Number(process.env.ETP_STREAM_SECONDS || 5),
};
let config = { ...defaultConfig, ...readJson(CONFIG_FILE, {}) };
let ws = null, io = null, sessionId = null, msgId = 1;
let state = { connected: false, sessionEstablished: false, framesSent: 0, dataPointsSent: 0, lastSentAt: null, lastError: null };
let streamTimer = null, reconnectTimer = null;

const nextMsgId = () => msgId++;
const emit = () => { if (io) try { io.emit('etp_status', getStatus()); } catch { /* ignore */ } };

function tagMnemonic(key) {
    return String(key || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || `TAG_${nextChannelId}`;
}

function tagUnit(key) {
    const lower = String(key || '').toLowerCase();
    if (lower.includes('rpm')) return 'rpm';
    if (lower.includes('torque')) return 'daN.m';
    if (lower.includes('pressure') || lower.includes('press')) return 'bar';
    if (lower.includes('temperature') || lower.includes('temp')) return 'degC';
    if (lower.includes('depth')) return 'm';
    if (lower.includes('position')) return lower.includes('block') ? 'mm' : 'm';
    if (lower.includes('hook') || lower.includes('load') || lower.includes('wob')) return 't';
    if (lower.includes('flow')) return lower.includes('percent') || lower.endsWith('.flow') || lower.includes('flow_out') ? '%' : 'L/min';
    if (lower.includes('speed')) return 'mm/sec';
    if (lower.includes('level') || lower.includes('percent') || lower.includes('_pct') || lower.includes('.pct')) return '%';
    if (lower.includes('stroke')) return 'count';
    return '';
}

function registerChannel(key) {
    if (channelByKey.has(key)) return false;
    channelByKey.set(key, { id: nextChannelId++, mnem: tagMnemonic(key), key, uom: tagUnit(key) });
    return true;
}

function channels() {
    return Array.from(channelByKey.values()).sort((a, b) => a.id - b.id);
}

function send(protocol, messageType, body) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const message = { header: { protocol, messageType, correlationId: 0, messageId: nextMsgId(), messageFlags: 0 }, body };
    ws.send(JSON.stringify(message));
}

function requestSession() {
    send(P.Core, MT.RequestSession, {
        applicationName: 'AHWR-150 Edge Twin', applicationVersion: '1.0',
        clientInstanceId: config.deviceId,
        requestedProtocols: [{ protocol: P.ChannelStreaming, protocolVersion: { major: 1, minor: 1 }, role: 'producer' }],
        supportedDataObjects: [], supportedFormats: ['application/x-etp-message+json'],
    });
}

function publishMetadata() {
    send(P.ChannelStreaming, MT.ChannelMetadata, {
        channels: channels().map((c) => ({ channelId: c.id, channelName: c.mnem, uom: c.uom, dataType: 'double', indexes: [{ indexKind: 'time', uom: 's', direction: 'increasing' }] })),
    });
}

function streamData() {
    const snaps = getRecent(config.streamSeconds);
    if (!snaps.length) return;
    const data = [];
    let metadataChanged = false;
    for (const s of snaps) {
        for (const [key, raw] of Object.entries(s.values || {})) {
            const v = Number(raw);
            if (!Number.isFinite(v)) continue;
            metadataChanged = registerChannel(key) || metadataChanged;
            const c = channelByKey.get(key);
            data.push({ channelId: c.id, indexes: [Date.parse(s.ts)], value: { item: v } });
        }
    }
    if (!data.length) return;
    if (metadataChanged && state.sessionEstablished) publishMetadata();
    send(P.ChannelStreaming, MT.ChannelData, { data });
    state.framesSent += 1; state.dataPointsSent += data.length; state.lastSentAt = new Date().toISOString();
    emit();
}

function onMessage(raw) {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const { protocol, messageType } = m.header || {};
    if (protocol === P.Core && messageType === MT.OpenSession) {
        sessionId = (m.body && m.body.sessionId) || 'session';
        state.sessionEstablished = true; state.lastError = null;
        publishMetadata();
        clearInterval(streamTimer);
        streamTimer = setInterval(streamData, config.streamSeconds * 1000);
        emit();
    }
}

function connect() {
    if (!config.enabled) return;
    clearTimeout(reconnectTimer);
    if (!config.url) {
        state.lastError = 'ETP URL not configured';
        emit();
        return;
    }
    try {
        const headers = { 'X-Device-Id': config.deviceId };
        if (config.token) headers['Authorization'] = `Bearer ${config.token}`;
        ws = new WebSocket(config.url, ETP_SUBPROTOCOL, { headers, handshakeTimeout: 6000 });
    } catch (e) { state.lastError = e.message; scheduleReconnect(); return; }

    const socket = ws;
    socket.on('open', () => { state.connected = true; state.lastError = null; requestSession(); emit(); });
    socket.on('message', onMessage);
    socket.on('error', (e) => { state.lastError = e.message; });
    socket.on('close', () => {
        if (ws !== socket) return;
        state.connected = false; state.sessionEstablished = false; sessionId = null;
        clearInterval(streamTimer); emit(); scheduleReconnect();
    });
}
function scheduleReconnect() { if (config.enabled) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 8000); } }

function disconnect() {
    clearTimeout(reconnectTimer);
    clearInterval(streamTimer);
    streamTimer = null;
    state.connected = false;
    state.sessionEstablished = false;
    sessionId = null;
    if (ws) {
        const old = ws;
        ws = null;
        try { old.close(); } catch { /* ignore */ }
    }
}

function getStatus() {
    return {
        enabled: config.enabled, url: config.url, subprotocol: ETP_SUBPROTOCOL, encoding: 'application/x-etp-message+json',
        deviceId: config.deviceId, tokenSet: !!config.token,
        connected: state.connected, sessionEstablished: state.sessionEstablished, sessionId,
        channels: channelByKey.size, framesSent: state.framesSent, dataPointsSent: state.dataPointsSent,
        lastSentAt: state.lastSentAt, lastError: state.lastError, streamSeconds: config.streamSeconds,
    };
}

async function setConfig(next) {
    if ('enabled' in next) config.enabled = !!next.enabled;
    if ('url' in next) config.url = String(next.url || '').trim();
    if ('deviceId' in next) config.deviceId = String(next.deviceId || '').trim() || defaultConfig.deviceId;
    if ('token' in next) config.token = String(next.token || '');
    if ('streamSeconds' in next) config.streamSeconds = Math.max(1, Number(next.streamSeconds) || 5);
    await writeJson(CONFIG_FILE, config);
    disconnect();
    if (config.enabled) connect();
    emit();
    return getStatus();
}

function start(ioRef) { io = ioRef; if (config.enabled) connect(); }

module.exports = { start, getStatus, setConfig };
