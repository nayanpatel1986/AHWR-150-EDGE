'use strict';
// Sync Agent — Store & Forward (rig edge -> central CRMF).
// Batches live telemetry + events, gzip-compresses, buffers to disk (capped by age),
// and forwards to the central ingest endpoint over HTTP. On WAN/central outage it keeps
// buffering and AUTOMATICALLY REPLAYS oldest-first on restoration (back-pressure aware).
// OUTBOUND ONLY — read-only telemetry publish; never writes to the PLC (monitoring-only).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const https = require('https');
const { readJson, writeJson, DATA_DIR } = require('./persist');
const wells = require('./wells');

const SCHEMA_VERSION = '1.0';
const CONFIG_FILE = 'sync_config.json';
const STATE_FILE = 'sync_state.json';
const BUFFER_DIR = path.join(DATA_DIR, 'sync_buffer');
const DEADLETTER_DIR = path.join(DATA_DIR, 'sync_deadletter');
// Max transient (network/5xx) attempts on a single batch before it is dead-lettered,
// so a poison batch can't wedge the oldest-first queue forever. Reset on restart.
const SYNC_MAX_ATTEMPTS = Math.max(1, Number(process.env.SYNC_MAX_ATTEMPTS || 50));
const SYNC_REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.SYNC_REQUEST_TIMEOUT_MS || 15000));
const MIN_SYNC_INTERVAL_MS = 1000;

const normalizeFlushIntervalMs = (value, fallbackMs = 5000) => {
    const n = Number(value);
    return Math.max(MIN_SYNC_INTERVAL_MS, Number.isFinite(n) ? n : fallbackMs);
};

const defaultFlushIntervalMs = normalizeFlushIntervalMs(
    process.env.SYNC_FLUSH_INTERVAL_MS
        ?? (process.env.SYNC_FLUSH_INTERVAL_SEC ? Number(process.env.SYNC_FLUSH_INTERVAL_SEC) * 1000 : undefined),
    1000
);

const DEFAULTS = {
    enabled: process.env.SYNC_ENABLED === 'true',
    centralUrl: process.env.CENTRAL_URL || '',
    deviceId: process.env.DEVICE_ID || 'AHWR-50-EDGE',
    deviceToken: process.env.DEVICE_TOKEN || '',
    batchSeconds: Number(process.env.SYNC_BATCH_SECONDS || 10),
    maxBufferDays: Number(process.env.SYNC_BUFFER_DAYS || 15),
    flushIntervalMs: defaultFlushIntervalMs,
    flushBatchesPerCycle: 25,   // back-pressure: bound replay burst
    maxBufferFiles: 200000,
    compression: true,
};

let config = { ...DEFAULTS, ...(readJson(CONFIG_FILE, {}) || {}) };
config.flushIntervalMs = normalizeFlushIntervalMs(config.flushIntervalMs ?? (Number(config.flushIntervalSec) * 1000), defaultFlushIntervalMs);
delete config.flushIntervalSec;
let st = readJson(STATE_FILE, null) || { nextSeq: 1, droppedBatches: 0, deadLetteredBatches: 0, sentBatches: 0, ackedBatches: 0, ackedPoints: 0 };
let connected = false;
let lastSyncAt = null;     // last successful ack time
let lastError = null;
let currentBatch = { channels: [], events: [] };
let lastSealMs = Date.now();
const recent = [];         // ring of recent flattened snapshots (for WITSML export)
const RECENT_MAX = 600;
let io = null;
let flushing = false;
let flushTimer = null;
let sealTimer = null;
const attempts = new Map();   // batch filename -> transient failed-attempt count (in-memory)

try { fs.mkdirSync(BUFFER_DIR, { recursive: true }); } catch { /* ignore */ }
const persistState = () => writeJson(STATE_FILE, st).catch(() => {});

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// Flatten the live payload to {measurement.field: value} for finite numerics only.
function flatten(data) {
    const out = {};
    for (const [meas, fields] of Object.entries(data || {})) {
        if (meas.startsWith('_') || !fields || typeof fields !== 'object') continue;
        for (const [f, v] of Object.entries(fields)) {
            const n = num(v);
            if (n !== null) out[`${meas}.${f}`] = n;
        }
    }
    return out;
}

function activeWellPayload() {
    const well = wells.getActiveWell();
    if (!well) return null;
    const summary = well.startedAt ? wells.getWellSummary(well.id) : null;
    return {
        id: well.id,
        wellId: well.name,
        name: well.name,
        wellName: well.name,
        uwi: well.uwi || '',
        field: well.field || '',
        operator: well.operator || '',
        rig: well.rig || config.deviceId,
        location: well.location || '',
        country: well.country || '',
        serviceType: well.serviceType || '',
        jobNo: well.jobNo || '',
        objective: well.objective || '',
        companyMan: well.companyMan || '',
        toolpusher: well.toolpusher || '',
        plannedTdM: well.plannedTdM ?? null,
        spudDate: well.spudDate || '',
        status: well.status,
        startedAt: well.startedAt || '',
        startedBy: well.startedBy || '',
        completedAt: well.completedAt || '',
        completedBy: well.completedBy || '',
        joints: summary?.connections?.count ?? summary?.joints ?? null,
        depthDelta: summary?.depthDeltaM ?? summary?.depthDelta ?? null,
        productiveSec: summary?.activity?.productiveSec ?? summary?.productiveSec ?? null,
        nptSec: summary?.activity?.nptSec ?? summary?.nptSec ?? null,
    };
}

const bufferFiles = () => {
    try {
        return fs.readdirSync(BUFFER_DIR).filter((f) => f.startsWith('batch-') && f.endsWith('.json.gz'))
            .sort(); // zero-padded seq -> lexical == chronological
    } catch { return []; }
};
const pointsOf = (fname) => { const m = fname.match(/batch-\d+-(\d+)\.json\.gz$/); return m ? Number(m[1]) : 0; };

// Called every tick with the live rig payload.
function enqueueTelemetry(data, nowMs = Date.now()) {
    const values = flatten(data);
    const activeWell = activeWellPayload();
    if (activeWell) values.well = activeWell;
    const snap = { ts: new Date(nowMs).toISOString(), values };
    recent.push(snap);
    if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
    if (!config.enabled) return;
    currentBatch.channels.push(snap);
    if ((nowMs - lastSealMs) >= config.batchSeconds * 1000 || currentBatch.channels.length >= config.batchSeconds) {
        seal(nowMs);
    }
}

function enqueueEvent(type, payload, nowMs = Date.now()) {
    if (!config.enabled) return;
    currentBatch.events.push({ ts: new Date(nowMs).toISOString(), type, payload });
    if (currentBatch.events.length > 500) currentBatch.events.splice(0, currentBatch.events.length - 500);
}

function seal(nowMs = Date.now()) {
    if (!config.enabled) return;
    lastSealMs = nowMs;
    if (!currentBatch.channels.length && !currentBatch.events.length) return;
    const seq = st.nextSeq++;
    const points = currentBatch.channels.length;
    const batch = {
        seq, deviceId: config.deviceId, schemaVersion: SCHEMA_VERSION,
        createdAt: new Date(nowMs).toISOString(),
        channels: currentBatch.channels, events: currentBatch.events,
    };
    const fname = `batch-${String(seq).padStart(9, '0')}-${String(points).padStart(6, '0')}.json.gz`;
    try {
        const body = config.compression ? zlib.gzipSync(Buffer.from(JSON.stringify(batch))) : Buffer.from(JSON.stringify(batch));
        fs.writeFileSync(path.join(BUFFER_DIR, fname), body);
    } catch (e) { lastError = `buffer write: ${e.message}`; }
    currentBatch = { channels: [], events: [] };
    persistState();
    prune();
}

function prune() {
    const cutoff = Date.now() - config.maxBufferDays * 86400000;
    const files = bufferFiles();
    let dropped = 0;
    for (const f of files) {
        const p = path.join(BUFFER_DIR, f);
        try {
            const old = fs.statSync(p).mtimeMs < cutoff;
            const over = (files.length - dropped) > config.maxBufferFiles;
            if (old || over) { fs.unlinkSync(p); attempts.delete(f); dropped++; }
        } catch { /* ignore */ }
    }
    if (dropped) { st.droppedBatches += dropped; persistState(); }
}

function postBatch(buf, seq) {
    return new Promise((resolve) => {
        let u; try { u = new URL('/ingest', config.centralUrl); } catch { return resolve({ ok: false, err: 'bad centralUrl' }); }
        const lib = u.protocol === 'https:' ? https : http;
        const headers = {
            'Content-Type': 'application/json', 'Content-Encoding': config.compression ? 'gzip' : 'identity',
            'X-Device-Id': config.deviceId, 'X-Schema-Version': SCHEMA_VERSION, 'Content-Length': buf.length,
        };
        if (config.deviceToken) headers['Authorization'] = `Bearer ${config.deviceToken}`;
        const req = lib.request(u, { method: 'POST', headers, timeout: SYNC_REQUEST_TIMEOUT_MS }, (res) => {
            const c = []; res.on('data', (d) => c.push(d));
            res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: Buffer.concat(c).toString() }));
        });
        req.on('error', (e) => resolve({ ok: false, err: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
        req.end(buf);
    });
}

function normalizeBatchBuffer(buf) {
    try {
        let raw = buf;
        try { raw = zlib.gunzipSync(buf); } catch { /* already plain JSON */ }
        const batch = JSON.parse(raw.toString('utf8'));
        batch.deviceId = config.deviceId;
        batch.schemaVersion = batch.schemaVersion || SCHEMA_VERSION;
        const body = Buffer.from(JSON.stringify(batch));
        return config.compression ? zlib.gzipSync(body) : body;
    } catch (e) {
        lastError = `batch normalize: ${e.message}`;
        return buf;
    }
}

// Move a poison/refused batch out of the replay queue so it can't block later batches.
function deadLetter(f, reason) {
    const src = path.join(BUFFER_DIR, f);
    try {
        fs.mkdirSync(DEADLETTER_DIR, { recursive: true });
        fs.renameSync(src, path.join(DEADLETTER_DIR, f));
    } catch {
        try { fs.unlinkSync(src); } catch { /* ignore */ } // last resort: don't let it wedge the queue
    }
    attempts.delete(f);
    st.deadLetteredBatches = (st.deadLetteredBatches || 0) + 1;
    console.error(`[sync] dead-lettered ${f}: ${reason} -> ${DEADLETTER_DIR}`);
}

// Drain oldest-first, bounded per cycle. Failure handling distinguishes the BATCH being
// bad from the LINK being down, so a WAN outage never loses good data:
//   - 4xx (central refused the payload): dead-letter that batch and CONTINUE.
//   - 5xx (central reached but errored): back-pressure + bounded retry; dead-letter only
//     after SYNC_MAX_ATTEMPTS so a poison batch the server chokes on can't wedge forever.
//   - network error / timeout (link DOWN): back-pressure ONLY — never dead-letter; the
//     day-based buffer cap (maxBufferDays) is the sole bound, so the buffer replays IN
//     FULL when the link returns.
async function flush(options = {}) {
    if (flushing || !config.enabled) return;
    flushing = true;
    try {
        const files = bufferFiles().slice(0, config.flushBatchesPerCycle);
        let ackedThisCycle = false;
        if (!files.length && options.heartbeatWhenEmpty) {
            const seq = st.nextSeq++;
            const heartbeat = {
                seq, deviceId: config.deviceId, schemaVersion: SCHEMA_VERSION,
                createdAt: new Date().toISOString(),
                channels: [],
                events: [{ ts: new Date().toISOString(), type: 'heartbeat', payload: { source: 'edge-sync' } }],
            };
            const body = Buffer.from(JSON.stringify(heartbeat));
            const buf = config.compression ? zlib.gzipSync(body) : body;
            const r = await postBatch(buf, seq);
            if (r.ok) {
                st.sentBatches += 1; st.ackedBatches += 1;
                connected = true; lastSyncAt = new Date().toISOString(); lastError = null;
            } else {
                connected = false;
                lastError = typeof r.status === 'number' ? `HTTP ${r.status} (check central URL/token)` : (r.err || 'unreachable');
            }
            persistState();
            return;
        }
        for (const f of files) {
            const p = path.join(BUFFER_DIR, f);
            let buf; try { buf = fs.readFileSync(p); } catch { continue; }
            buf = normalizeBatchBuffer(buf);
            const r = await postBatch(buf, f);
            if (r.ok) {
                try { fs.unlinkSync(p); } catch { /* ignore */ }
                attempts.delete(f);
                st.sentBatches += 1; st.ackedBatches += 1; st.ackedPoints += pointsOf(f);
                ackedThisCycle = true;
                connected = true; lastSyncAt = new Date().toISOString(); lastError = null;
            } else if (typeof r.status === 'number' && [400, 413, 422].includes(r.status)) {
                // Permanent: central refused the payload itself (400/413/422/401...). The
                // BATCH is the problem — dead-letter it and keep draining the rest.
                connected = false; lastError = `HTTP ${r.status} (rejected)`;
                deadLetter(f, lastError);
                continue;
            } else if (typeof r.status === 'number' && r.status >= 400 && r.status < 500) {
                connected = false; lastError = `HTTP ${r.status} (check central URL/token)`;
                attempts.delete(f);
                break;
            } else if (typeof r.status === 'number' && r.status >= 500) {
                // Central was REACHED but errored (5xx): a transient central issue, or a
                // batch it consistently chokes on. Bound the retries so a poison batch
                // can't wedge replay forever, but keep back-pressure meanwhile.
                connected = ackedThisCycle; lastError = ackedThisCycle ? `draining backlog: HTTP ${r.status}` : `HTTP ${r.status}`;
                const n = (attempts.get(f) || 0) + 1;
                attempts.set(f, n);
                if (n >= SYNC_MAX_ATTEMPTS) { deadLetter(f, `${lastError} after ${n} attempts`); continue; }
                break;
            } else {
                // Could NOT reach central (network error / timeout): the LINK is down, not
                // the batch. NEVER dead-letter here — keep the data so a multi-hour outage
                // replays IN FULL on restore; the only bound is the day-based buffer cap
                // (maxBufferDays). Clear any prior 5xx streak so it doesn't carry over.
                connected = ackedThisCycle; lastError = ackedThisCycle ? `draining backlog: ${r.err || 'unreachable'}` : (r.err || 'unreachable');
                attempts.delete(f);
                break; // back-pressure: don't hammer a down link
            }
        }
        persistState();
    } finally { flushing = false; emit(); }
}

function getStatus() {
    const files = bufferFiles();
    const bufferedPoints = files.reduce((s, f) => s + pointsOf(f), 0);
    let oldestAgeSec = null;
    if (files.length) { try { oldestAgeSec = Math.round((Date.now() - fs.statSync(path.join(BUFFER_DIR, files[0])).mtimeMs) / 1000); } catch { /* ignore */ } }
    const syncLagSec = files.length ? oldestAgeSec : (lastSyncAt ? Math.round((Date.now() - Date.parse(lastSyncAt)) / 1000) : null);
    return {
        enabled: config.enabled,
        connected,
        deviceId: config.deviceId,
        centralUrl: config.centralUrl,
        batchSeconds: config.batchSeconds,
        flushIntervalMs: config.flushIntervalMs,
        flushIntervalSec: config.flushIntervalMs / 1000,
        maxBufferDays: config.maxBufferDays,
        compression: config.compression,
        bufferedBatches: files.length,
        bufferedPoints,
        oldestBufferedAgeSec: oldestAgeSec,
        syncLagSec,
        lastSyncAt,
        lastError,
        sentBatches: st.sentBatches,
        ackedBatches: st.ackedBatches,
        ackedPoints: st.ackedPoints,
        droppedBatches: st.droppedBatches,
        deadLetteredBatches: st.deadLetteredBatches || 0,
    };
}

function getConfig() { const { deviceToken, ...safe } = config; return { ...safe, deviceTokenSet: !!deviceToken }; }
async function setConfig(next) {
    const allow = ['enabled', 'centralUrl', 'deviceId', 'deviceToken', 'batchSeconds', 'maxBufferDays', 'compression', 'flushBatchesPerCycle', 'flushIntervalMs', 'flushIntervalSec'];
    for (const k of allow) if (k in (next || {})) config[k] = next[k];
    config.batchSeconds = Math.max(1, Number(config.batchSeconds) || 10);
    if ('flushIntervalSec' in (next || {}) && !('flushIntervalMs' in (next || {}))) {
        config.flushIntervalMs = Number(config.flushIntervalSec) * 1000;
    }
    config.flushIntervalMs = normalizeFlushIntervalMs(config.flushIntervalMs, defaultFlushIntervalMs);
    delete config.flushIntervalSec;
    config.maxBufferDays = Math.max(1, Number(config.maxBufferDays) || 15);
    await writeJson(CONFIG_FILE, config);
    scheduleTimers();
    emit();
    if (config.enabled && config.centralUrl) {
        setTimeout(() => { flush({ heartbeatWhenEmpty: true }).catch(() => {}); }, 100);
    }
    return getConfig();
}

const getRecent = (n = 300) => recent.slice(-n);

function emit() { if (io) { try { io.emit('sync_status', getStatus()); } catch { /* ignore */ } } }

function scheduleTimers() {
    if (flushTimer) clearInterval(flushTimer);
    if (sealTimer) clearInterval(sealTimer);
    flushTimer = setInterval(() => { flush().catch(() => {}); }, normalizeFlushIntervalMs(config.flushIntervalMs, defaultFlushIntervalMs));
    // periodic seal even if telemetry pauses, so buffered events are forwarded
    sealTimer = setInterval(() => { if (Date.now() - lastSealMs >= config.batchSeconds * 1000) seal(); }, Math.max(MIN_SYNC_INTERVAL_MS, config.batchSeconds * 1000));
}

function start(ioRef) {
    io = ioRef;
    if (config.enabled && config.centralUrl) {
        setTimeout(() => { flush({ heartbeatWhenEmpty: true }).catch(() => {}); }, 1000);
    }
    scheduleTimers();
}

module.exports = { start, enqueueTelemetry, enqueueEvent, flush, getStatus, getConfig, setConfig, getRecent };
