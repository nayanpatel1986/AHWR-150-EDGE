'use strict';
// AHWR edge backend. Started by server.js once the operating records have
// been loaded from the database (lib/persist.js).
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const https = require('https');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const auth = require('./lib/auth');
const validate = require('./lib/validate');
const ldap = require('./lib/ldap');
const alarms = require('./lib/alarms');
const workover = require('./lib/workover');
const maintenance = require('./lib/maintenance');
const cmms = require('./lib/cmms');
const instruments = require('./lib/instruments');
const runlog = require('./lib/runlog');
const variables = require('./lib/variables');
const sync = require('./lib/sync');
const health = require('./lib/health');
const witsml = require('./lib/witsml');
const etp = require('./lib/etp');
const efficiency = require('./lib/efficiency');
const wells = require('./lib/wells');
const wellArchive = require('./lib/wellArchive');
const wellReport = require('./lib/wellReport');
const centralMessages = require('./lib/centralMessages');
const tsdb = require('./lib/tsdb');
const telemetryMap = require('./lib/telemetryMap');
const telegrafConfig = require('./lib/telegrafConfig');
const persist = require('./lib/persist');
const edrCatalog = require('../shared/edrMetrics.json');

const PORT = Number(process.env.PORT || 5000);
// HOST: bind one interface (e.g. the rig-LAN address); default all interfaces.
// TLS_CERT_FILE + TLS_KEY_FILE: serve the HMI and API over HTTPS (with HSTS).
const HOST = process.env.HOST || undefined;
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || '';
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || '';
const TLS_ON = !!(TLS_CERT_FILE && TLS_KEY_FILE);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const FRONTEND_DIST_DIR = process.env.FRONTEND_DIST_DIR || '';
const FRONTEND_INDEX_PATH = FRONTEND_DIST_DIR ? path.join(FRONTEND_DIST_DIR, 'index.html') : '';

// --- SEED DEFAULTS ON FIRST BOOT ---
const DEFAULTS_DIR = path.join(__dirname, 'defaults');
if (fs.existsSync(DEFAULTS_DIR)) {
    const filesToSeed = ['plc_config.json', 'bop_config.json', 'users.json', 'dashboard_layout.json', 'alarms_config.json'];
    for (const file of filesToSeed) {
        const defaultPath = path.join(DEFAULTS_DIR, file);
        if (fs.existsSync(defaultPath) && !persist.exists(file)) {
            try {
                persist.writeJsonSync(file, persist.parseJson(fs.readFileSync(defaultPath, 'utf8')));
                console.log(`Seeded default ${file} (${persist.backendName()} store)`);
            } catch (err) {
                console.error(`Failed to seed ${file}:`, err.message);
            }
        }
    }
}
// -----------------------------------

const DATA_SOURCE = process.env.DATA_SOURCE || 'plc';
const MAX_WELL_DEPTH = Number(process.env.MAX_WELL_DEPTH_M || 100000); // sanity clamp (m)
const FRESH_MS = Number(process.env.DATA_FRESH_MS || 5000);          // data older than this = stale

if (!process.env.PGPASSWORD) {
    console.error('FATAL: PGPASSWORD (the ahwr_app database password) is required. Refusing to start.');
    process.exit(1);
}

// Allowed browser origins. Same-origin (served behind nginx) needs no entry;
// set CORS_ORIGIN (comma-separated) only for cross-origin dev access.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigin = CORS_ORIGINS.length ? CORS_ORIGINS : false;

const app = express();
// Express 4 does not route a rejected async handler to the error middleware:
// the request hung and the rejection was only logged. Wrap every handler.
const wrapAsync = (fn) => (typeof fn !== 'function' || fn.length > 3) ? fn
    : function wrapped(req, res, next) {
        try {
            const out = fn(req, res, next);
            if (out && typeof out.catch === 'function') out.catch(next);
            return out;
        } catch (err) { return next(err); }
    };
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = app[method].bind(app);
    app[method] = (route, ...handlers) => (handlers.length ? original(route, ...handlers.map(wrapAsync)) : original(route));
}
app.set('trust proxy', FRONTEND_DIST_DIR ? false : 1); // trust nginx only in the Docker deployment
const server = TLS_ON
    ? https.createServer({ cert: fs.readFileSync(TLS_CERT_FILE), key: fs.readFileSync(TLS_KEY_FILE) }, app)
    : http.createServer(app);
const io = new Server(server, { cors: { origin: allowedOrigin, methods: ['GET', 'POST'], credentials: true } });

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            upgradeInsecureRequests: null,
        },
    },
    hsts: TLS_ON ? { maxAge: 15552000, includeSubDomains: false } : false,
}));
app.use(cors({ origin: allowedOrigin, methods: ['GET', 'POST'], credentials: true }));
// The history import route installs its own larger parser; the global 1 MB
// parser must not consume (and 413) that body first.
const defaultJsonParser = express.json({ limit: '1mb' });
app.use((req, res, next) => (req.path === '/api/wells/import' ? next() : defaultJsonParser(req, res, next)));

// Unauthenticated health checks (used by the Docker healthcheck / probes).
app.get('/', (req, res) => {
    if (FRONTEND_INDEX_PATH && fs.existsSync(FRONTEND_INDEX_PATH)) return res.sendFile(FRONTEND_INDEX_PATH);
    return res.send('ROM-II Backend is running');
});
app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Require a valid JWT on the Socket.io handshake before any telemetry streams.
io.use(auth.socketAuth);
io.on('connection', (socket) => {
    socket.emit('rig_data', latestRigData);            // prime newly-connected clients
    socket.emit('dashboard_layout_update', getDashboardConfig());
    socket.emit('alarms', alarms.snapshot());          // prime the alarm banner/list
    socket.emit('sync_status', sync.getStatus());      // prime the edge-sync page
    socket.emit('etp_status', etp.getStatus());
    socket.emit('central_messages_update', centralMessages.snapshot());
});

// Start the store-and-forward sync agent + ETP 2.0 publisher (outbound only).
sync.start(io);
etp.start(io);
centralMessages.start(io);

// Rig identity in the historian = the CMF device id (sync config, else DEVICE_ID).
const currentRigId = () => (sync.getStatus() && sync.getStatus().deviceId) || process.env.DEVICE_ID || 'AHWR-50-EDGE';
wellArchive.configure({ getRigId: currentRigId });

// --- Operating records (lib/persist.js: database documents, or files) ------
// The *_FILE paths below name documents by their file name in DATA_DIR.
const writeJsonAtomic = (file, obj) => persist.writeJson(path.basename(file), obj);
const readJsonSync = (file, fallback) => persist.readJson(path.basename(file), fallback);

// --- Drilling Physics Engine ---
const DRILLING_STATE_FILE = path.join(DATA_DIR, 'drilling_state.json');
let drillingState = {
    stringWeight: 0,     // tonnes-force (tare/string weight captured at zero-WOB)
    totalDepth: 304.8,   // m (seed = 1000 ft)
    bitDepth: 0,         // m
    lastBlockPosition: 0 // ft (block position is in feet)
};

// Reject NaN/negative/absurd depths; bound to a configured maximum well depth.
function clampDepth(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, MAX_WELL_DEPTH);
}

// Load state from disk if present, then clamp any out-of-range persisted values.
{
    const saved = readJsonSync(DRILLING_STATE_FILE, null);
    if (saved) drillingState = { ...drillingState, ...saved };
    drillingState.bitDepth = clampDepth(drillingState.bitDepth);
    drillingState.totalDepth = clampDepth(drillingState.totalDepth);
}

// Persistence is decoupled from the 1 Hz poll loop: mark dirty, flush async.
let drillingDirty = false;
const markDrillingDirty = () => { drillingDirty = true; };
const flushDrillingState = async () => {
    if (!drillingDirty) return;
    drillingDirty = false;
    try { await writeJsonAtomic(DRILLING_STATE_FILE, drillingState); }
    catch (e) { console.error('Failed to persist drilling state:', e.message); drillingDirty = true; }
};

// --- PLC / S7 Configuration API ---
// GET: any authenticated user may view the current device config.
app.get('/api/config/plc', auth.requireAuth, (req, res) => {
    res.json(getModbusConfig());
});

// POST: admin-only. Validates the payload (stops TOML/config injection),
// rewrites the managed telegraf.d/plc.conf (PLC inputs + telemetry mapping),
// and lets Telegraf hot-reload it via `--watch-config`. No restart involved.
app.post('/api/config/plc', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try {
        const config = validate.validatePlcConfig(req.body);
        telegrafConfig.buildManagedConfig(config, { rigId: currentRigId(), starPath: 'check.star' }); // fail before saving
        await saveModbusConfig(config);
        applyTelegrafConfig(config);

        res.json({ success: true, message: 'Configuration saved. Telegraf will hot-reload automatically.' });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('Error saving PLC config:', err);
        res.status(status).json({ success: false, error: err.message });
    }
});

// --- VersaMax / KEPServerEX OPC UA BOP configuration API ------------------
const BOP_CONFIG_FILE = path.join(DATA_DIR, 'bop_config.json');
const defaultBopConfig = () => ({
    enabled: true,
    endpoint: 'opc.tcp://host.docker.internal:49320',
    securityMode: 'None',
    securityPolicy: 'None',
    tags: [
        ['annular_open', 'Annular Open'], ['annular_close', 'Annular Close'],
        ['upper_ram_open', 'Upper Ram Open'], ['upper_ram_close', 'Upper Ram Close'],
        ['lower_ram_open', 'Lower Pipe Ram Open'], ['lower_ram_close', 'Lower Pipe Ram Close'],
        ['blind_ram_open', 'Blind Ram Open'], ['blind_ram_close', 'Blind Ram Close'],
        ['accumulator_pressure', 'Accumulator Pressure'], ['manifold_pressure', 'Manifold Pressure'],
        ['annular_pressure', 'Annular Pressure'], ['air_pressure', 'Air Pressure']
    ].map(([field, name]) => ({ name, field, nodeId: '', unit: '', enabled: true }))
});
const getBopConfig = () => {
    const config = readJsonSync(BOP_CONFIG_FILE, defaultBopConfig());
    return {
        ...config,
        tags: (config.tags || []).map((tag) => tag.field === 'lower_ram_open'
            ? { ...tag, name: 'Lower Pipe Ram Open' }
            : tag.field === 'lower_ram_close'
                ? { ...tag, name: 'Lower Pipe Ram Close' }
                : tag)
    };
};

app.get('/api/config/bop', auth.requireAuth, (req, res) => {
    res.json(getBopConfig());
});

app.post('/api/config/bop', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try {
        const config = validate.validateBopConfig(req.body);
        await writeJsonAtomic(BOP_CONFIG_FILE, config);
        res.json({ success: true, message: 'OPC UA BOP configuration saved.' });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('Error saving BOP config:', err);
        res.status(status).json({ success: false, error: err.message });
    }
});

// Physics loop (runs on each data update). All weights are in tonnes-force
// (consistent with the PLC "Weight on Hook -Ton" tag); depths are in metres.
const updatePhysics = (rigData) => {
    const currentHookLoad = Number(rigData.drawworks?.hook_load) || 0;
    const currentBlockPos = Number(rigData.drawworks?.block_position) || 0;

    // Prefer PLC-supplied depth as source of truth. 0 is a VALID reading
    // (bit at surface), so test for finiteness, not truthiness.
    const plcBitDepth = rigData.drilling?.bit_depth;
    const plcHoleDepth = rigData.drilling?.hole_depth;
    const hasPlcBit = Number.isFinite(plcBitDepth);
    const hasPlcHole = Number.isFinite(plcHoleDepth);

    if (hasPlcBit) drillingState.bitDepth = clampDepth(plcBitDepth);
    if (hasPlcHole) drillingState.totalDepth = clampDepth(plcHoleDepth);

    // WOB = string/tare weight currently NOT carried by the hook (tonnes-force).
    const wob = Math.max(0, drillingState.stringWeight - currentHookLoad);

    // Local dead-reckoning fallback ONLY when the PLC isn't supplying bit depth.
    if (!hasPlcBit) {
        const deltaBlock = drillingState.lastBlockPosition - currentBlockPos; // +ve = moving down (ft)
        const deltaBlockMeters = deltaBlock * 0.3048;
        const newBitDepth = clampDepth(drillingState.bitDepth + deltaBlockMeters);

        const WOB_THRESHOLD = 1.0; // tonnes-force; on-bottom (drilling) threshold
        if (wob > WOB_THRESHOLD) {
            drillingState.bitDepth = newBitDepth;
            if (drillingState.bitDepth > drillingState.totalDepth) {
                drillingState.totalDepth = clampDepth(drillingState.bitDepth);
            }
        } else {
            drillingState.bitDepth = Math.min(newBitDepth, drillingState.totalDepth);
        }
    }

    drillingState.lastBlockPosition = currentBlockPos;
    markDrillingDirty();

    return {
        wob: Number(wob.toFixed(1)),
        bit_depth: Number(drillingState.bitDepth.toFixed(2)),
        hole_depth: Number(drillingState.totalDepth.toFixed(2))
    };
};

// --- APIs for Calibration (operator or admin) ---
app.post('/api/drilling/zero-wob', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const stringWeight = validate.num(req.body.currentHookLoad, 'currentHookLoad', { min: 0, max: 5000 });
        drillingState.stringWeight = stringWeight;
        markDrillingDirty();
        maintenance.logCalibration({ type: 'Weight Indicator (Zero-WOB)', asset: 'drawworks', value: `${stringWeight} t tare`, by: req.user.username });
        res.json({ success: true, stringWeight });
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
    }
});

app.post('/api/drilling/set-depth', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const { bitDepth, holeDepth } = req.body;
        if (bitDepth !== undefined) drillingState.bitDepth = clampDepth(validate.num(bitDepth, 'bitDepth', { min: 0, max: MAX_WELL_DEPTH }));
        if (holeDepth !== undefined) drillingState.totalDepth = clampDepth(validate.num(holeDepth, 'holeDepth', { min: 0, max: MAX_WELL_DEPTH }));
        markDrillingDirty();
        maintenance.logCalibration({ type: 'Depth / Block Encoder (Set-Depth)', asset: 'drawworks', value: `bit ${drillingState.bitDepth?.toFixed?.(1) ?? '—'} m`, by: req.user.username });
        res.json({ success: true, state: drillingState });
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
    }
});

app.get('/api/drilling/state', auth.requireAuth, (req, res) => {
    res.json(drillingState);
});

app.get('/api/central-messages', auth.requireAuth, (req, res) => {
    res.json(centralMessages.snapshot());
});

// Acknowledging, replying to or dismissing a central-room message speaks for the
// rig, so viewers may read messages but not answer them.
app.post('/api/central-messages/:id/ack', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    const row = centralMessages.acknowledge(req.params.id, req.user);
    if (!row) return res.status(404).json({ error: 'message not found' });
    res.json(row);
});

app.post('/api/central-messages/:id/reply', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const row = centralMessages.reply(req.params.id, req.body?.text, req.user);
        if (!row) return res.status(404).json({ error: 'message not found' });
        res.json(row);
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
    }
});

app.post('/api/central-messages/:id/dismiss', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    const row = centralMessages.dismiss(req.params.id);
    if (!row) return res.status(404).json({ error: 'message not found' });
    res.json(row);
});

// --- Main Socket & Data Loop ---

// Telegraf managed config (telegraf.d/plc.conf) + device-config persistence.
const CONFIG_PATH = process.env.TELEGRAF_CONFIG_PATH || path.join(__dirname, '..', 'telegraf', 'telegraf.d', 'plc.conf');
const DB_PATH = path.join(DATA_DIR, 'plc_config.json');

const getModbusConfig = () => readJsonSync(DB_PATH, { slaves: [] });
const saveModbusConfig = (config) => writeJsonAtomic(DB_PATH, config);

// PLC tag -> CMF metric mapping. Telegraf applies it when writing; the live view
// uses it to turn PLC-bit metrics (stored as 1/0) back into booleans.
let tagMapping = telemetryMap.buildMapping(getModbusConfig());

// Rewrite telegraf.d/plc.conf for a PLC config (Telegraf hot-reloads it).
function applyTelegrafConfig(config = getModbusConfig()) {
    tagMapping = telemetryMap.buildMapping(config);
    if (telegrafConfig.writeManagedConfig(CONFIG_PATH, config, { rigId: currentRigId(), scriptPath: process.env.TELEGRAF_SCRIPT_PATH })) {
        console.log(`Telegraf PLC config written to ${CONFIG_PATH} (Telegraf hot-reloads it).`);
    }
}

const { FIELD_MAP } = require('./lib/fieldmap');

// Metrics the history API serves: the EDR catalog plus every mapped PLC metric.
const HISTORY_METRICS = new Set(edrCatalog.categories.flatMap(category =>
    category.fields.map(field => `${category.id}.${field.id}`)
));
Object.values(FIELD_MAP).forEach((mapped) => HISTORY_METRICS.add(`${mapped.meas}.${mapped.field}`));

const getFluxDurationMs = (range) => {
    const match = /^-(\d+)(ns|us|ms|s|m|h|d|w|mo|y)$/.exec(range || '');
    if (!match) return null;
    const value = Number(match[1]);
    const unitMs = {
        ns: 1 / 1e6,
        us: 1 / 1e3,
        ms: 1,
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000,
        mo: 30 * 24 * 60 * 60 * 1000,
        y: 365 * 24 * 60 * 60 * 1000
    };
    return value * unitMs[match[2]];
};

const getHistoryWindowPeriod = (durationMs) => {
    if (durationMs <= 60 * 1000) return '1s';
    if (durationMs <= 5 * 60 * 1000) return '2s';
    if (durationMs <= 15 * 60 * 1000) return '5s';
    if (durationMs <= 30 * 60 * 1000) return '15s';
    if (durationMs <= 60 * 60 * 1000) return '1m';
    if (durationMs <= 2 * 60 * 60 * 1000) return '2m';
    if (durationMs <= 4 * 60 * 60 * 1000) return '5m';
    if (durationMs <= 6 * 60 * 60 * 1000) return '10m';
    if (durationMs <= 12 * 60 * 60 * 1000) return '15m';
    if (durationMs <= 24 * 60 * 60 * 1000) return '30m';
    if (durationMs <= 3 * 24 * 60 * 60 * 1000) return '1h';
    if (durationMs <= 7 * 24 * 60 * 60 * 1000) return '2h';
    if (durationMs <= 30 * 24 * 60 * 60 * 1000) return '6h';
    return '24h';
};

// Cache TTL scales with query duration — larger windows change less often.
const getHistoryCacheTtl = (durationMs) => {
    if (durationMs <= 5 * 60 * 1000) return 15 * 1000;       // 5m window -> 15s cache
    if (durationMs <= 30 * 60 * 1000) return 30 * 1000;      // 30m window -> 30s cache
    if (durationMs <= 2 * 60 * 60 * 1000) return 60 * 1000;  // 2h window -> 1m cache
    if (durationMs <= 6 * 60 * 60 * 1000) return 2 * 60 * 1000;  // 6h -> 2m cache
    if (durationMs <= 12 * 60 * 60 * 1000) return 3 * 60 * 1000; // 12h -> 3m cache
    return 5 * 60 * 1000;                                    // 24h+ -> 5m cache
};

// Response cache for /api/history: bounded (oldest evicted) and purged of
// expired entries, so arbitrary start/stop keys cannot grow it without limit.
const HISTORY_CACHE_MAX = Number(process.env.HISTORY_CACHE_MAX || 200);
const historyResponseCache = new Map();
const historyInflight = new Map();
const cacheHistory = (key, rows, ttlMs) => {
    const now = Date.now();
    for (const [k, v] of historyResponseCache) if (now - v.at > v.ttl) historyResponseCache.delete(k);
    historyResponseCache.delete(key);
    historyResponseCache.set(key, { at: now, ttl: ttlMs, rows });
    while (historyResponseCache.size > HISTORY_CACHE_MAX) historyResponseCache.delete(historyResponseCache.keys().next().value);
};

const buildHistoryCacheKey = ({ range, start, stop, metrics, windowPeriod }) => JSON.stringify({
    range: range || null,
    start: start || null,
    stop: stop || null,
    metrics,
    windowPeriod
});

let lastDataAt = 0; // epoch ms of the last tick that returned sensor data

// Metrics the backend derives itself (depth from the block encoder, WOB from the
// hook-load tare). Stored in telemetry only when the PLC does not supply them.
const DERIVED_METRICS = ['drilling.wob', 'drilling.bit_depth', 'drilling.hole_depth'];
let lastDerivedWriteError = 0;

function recordDerived(data, nowMs, fromHistorian) {
    const ts = new Date(nowMs).toISOString();
    const rows = [];
    for (const metric of DERIVED_METRICS) {
        if (fromHistorian.has(metric)) continue;
        const [meas, f] = metric.split('.');
        const value = Number(data[meas] && data[meas][f]);
        if (Number.isFinite(value)) rows.push({ ts, metric, value });
    }
    if (!rows.length) return;
    tsdb.insertTelemetry(currentRigId(), rows).catch((err) => {
        if (Date.now() - lastDerivedWriteError > 60000) {
            lastDerivedWriteError = Date.now();
            console.error('Derived telemetry write failed:', err.message);
        }
    });
}

// Every event queued for the CMF is also kept locally in the CMF events table
// (connections additionally in connections), whether or not sync is enabled.
function recordEvent(type, payload, nowMs = Date.now()) {
    sync.enqueueEvent(type, payload, nowMs);
    tsdb.insertEvent(currentRigId(), new Date(nowMs).toISOString(), type, payload)
        .catch((err) => console.error(`Event write failed (${type}):`, err.message));
}

const queryData = async () => {
    try {
        // Latest sample of every metric for this rig over the last 10 s.
        const { rows } = await tsdb.query(
            `SELECT DISTINCT ON (metric) metric, value, ts
             FROM telemetry
             WHERE rig_id = $1 AND ts > now() - interval '10 seconds'
             ORDER BY metric, ts DESC`,
            [currentRigId()]);
        const data = {};
        const fromHistorian = new Set();
        for (const row of rows) {
            const dot = row.metric.indexOf('.');
            if (dot <= 0) continue;
            const meas = row.metric.slice(0, dot);
            const f = row.metric.slice(dot + 1);
            if (!data[meas]) data[meas] = {};
            data[meas][f] = telemetryMap.isBooleanMetric(tagMapping, row.metric) ? row.value !== 0 : row.value;
            if (!data._fieldTimes) data._fieldTimes = {};
            data._fieldTimes[row.metric] = new Date(row.ts).toISOString();
            fromHistorian.add(row.metric);
        }

        const hasBopData = !!(data.bop && Object.keys(data.bop).length > 0);
        const hasRigSensorData = !!(data.drawworks || data.engine || data.mudpump || data.drilling || data.AHWR || data.hpu || data.cat_engine || data.cat_engine_2);
        const now = Date.now();
        // Freshness comes from the newest rig SAMPLE time, not from "a row came back":
        // the -10s window + last() keeps returning a point for ~10 s after the feed
        // stops, which delayed the stale flag to ~15 s.
        if (hasRigSensorData) {
            const newestRigSample = Object.entries(data._fieldTimes || {})
                .filter(([key]) => !key.startsWith('bop.') && !key.startsWith('wellcontrol.'))
                .reduce((max, [, t]) => Math.max(max, Date.parse(t) || 0), 0);
            lastDataAt = Math.max(lastDataAt, Math.min(newestRigSample || now, now));
        }
        const stale = (now - lastDataAt) > FRESH_MS;

        if (hasRigSensorData) {
            const physicsData = updatePhysics(data);
            const plcWob = data.drilling ? data.drilling.wob : undefined;
            if (data.drawworks?.block_position !== undefined) {
                data.acs = {
                    ...(data.acs || {}),
                    block_position: data.drawworks.block_position
                };
            }
            // Depth always comes from the clamped physics state (which itself
            // prefers PLC depth). WOB prefers the real PLC measurement when present.
            data.drilling = {
                ...(data.drilling || {}),            // keep PLC rop, rpm, torque, operation_mode, ...
                bit_depth: physicsData.bit_depth,
                hole_depth: physicsData.hole_depth,
                wob: Number.isFinite(plcWob) ? plcWob : physicsData.wob
            };
            // Keep the historian complete: derived depth/WOB are stored when the
            // PLC does not supply them (never while the feed is stale).
            if (!stale) recordDerived(data, now, fromHistorian);
        } else if (!hasBopData) {
            // No live feed: do NOT fabricate zeros or clear the UI during a
            // Telegraf reload/config save. Keep the last-good values visible and
            // mark the packet stale so the header still shows the PLC issue.
            Object.assign(data, JSON.parse(JSON.stringify(latestRigData || {})));
            data.drilling = {
                ...(data.drilling || {}),
                bit_depth: Number(drillingState.bitDepth.toFixed(2)),
                hole_depth: Number(drillingState.totalDepth.toFixed(2))
            };
        }

        // Well control / BOP: present ONLY when a real source exists. Never
        // coalesce safety-critical ram/pressure signals to a benign false/0 state.
        // Gate on hasBopData (this cycle's query), NOT on data.bop: when the feed is
        // down, data.bop is the carried-forward copy of the last packet and must not
        // be re-stamped as connected/good.
        const wc = data.wellcontrol;
        const bop = data.bop;
        if (hasBopData) {
            const bopSampleMs = Object.entries(data._fieldTimes || {})
                .filter(([key]) => key.startsWith('bop.'))
                .reduce((max, [, t]) => Math.max(max, Date.parse(t) || 0), 0);
            const bopFresh = bopSampleMs > 0 && (now - bopSampleMs) <= FRESH_MS;
            data.bop = {
                annular_open: bop.annular_open ?? null,
                annular_close: bop.annular_close ?? null,
                upper_ram_open: bop.upper_ram_open ?? null,
                upper_ram_close: bop.upper_ram_close ?? null,
                lower_ram_open: bop.lower_ram_open ?? null,
                lower_ram_close: bop.lower_ram_close ?? null,
                blind_ram_open: bop.blind_ram_open ?? null,
                blind_ram_close: bop.blind_ram_close ?? null,
                accumulator_pressure: bop.accumulator_pressure ?? null,
                manifold_pressure: bop.manifold_pressure ?? null,
                annular_pressure: bop.annular_pressure ?? null,
                air_pressure: bop.air_pressure ?? null,
                source: 'versamax',
                connected: true,
                quality: bopFresh ? 'good' : 'stale',
                lastUpdate: bopSampleMs ? new Date(bopSampleMs).toISOString() : null
            };
            // Keep the existing Well Control contract so current screens and
            // consumers continue to work while BOP gets its own namespace.
            data.well_control = {
                available: true,
                annular_pressure: data.bop.annular_pressure,
                manifold_pressure: data.bop.manifold_pressure,
                accumulator_pressure: data.bop.accumulator_pressure,
                annular_open: data.bop.annular_open,
                annular_close: data.bop.annular_close,
                pipe_ram_open: data.bop.lower_ram_open,
                pipe_ram_close: data.bop.lower_ram_close,
                blind_ram_open: data.bop.blind_ram_open,
                blind_ram_close: data.bop.blind_ram_close,
                shear_ram_open: null,
                source: 'versamax'
            };
        } else if (wc && Object.keys(wc).length > 0) {
            data.well_control = {
                available: true,
                annular_pressure: wc.annular_pressure ?? null,
                manifold_pressure: wc.manifold_pressure ?? null,
                accumulator_pressure: wc.accumulator_pressure ?? null,
                annular_open: wc.annular_open ?? null,
                annular_close: wc.annular_close ?? null,
                pipe_ram_open: wc.pipe_ram_open ?? null,
                pipe_ram_close: wc.pipe_ram_close ?? null,
                blind_ram_open: wc.blind_ram_open ?? null,
                blind_ram_close: wc.blind_ram_close ?? null,
                shear_ram_open: wc.shear_ram_open ?? null
            };
            data.bop = {
                source: 'unknown',
                connected: false,
                quality: 'disconnected',
                lastUpdate: null
            };
        } else {
            data.well_control = { available: false };
            data.bop = {
                source: 'versamax',
                connected: false,
                quality: 'disconnected',
                lastUpdate: null
            };
        }
        delete data.wellcontrol;

        data._meta = {
            ts: new Date(now).toISOString(),
            source: hasRigSensorData ? DATA_SOURCE : (hasBopData ? 'versamax' : 'none'),
            stale,
            bop_live: hasBopData,
            age_ms: lastDataAt ? (now - lastDataAt) : null,
            connected: hasRigSensorData
        };

        // --- Workover layer: activity/NPT, torque-turn, alarms ---
        // Isolated: an exception here (e.g. a bad alarm/efficiency config) must
        // never stop the live packet from being emitted.
        try {
            if (hasRigSensorData) {
                data._activity = workover.updateActivity(data, now);
                const tt = workover.updateTorqueTurn(data, now);
                if (tt.connectionMade) io.emit('connection_made', tt.connectionMade);
                data._torqueturn = workover.getTorqueTurnLive();
                const al = alarms.evaluate(data, now);
                data._alarms = al.counts;
                if (al.changed) io.emit('alarms', al);
                maintenance.updateHours(data, now);
                runlog.update(data, maintenance.getHours(), now);
                data._efficiency = efficiency.update(data, now, { jointMade: !!tt.connectionMade });
                // Store-and-forward: queue telemetry + events for sync to central
                sync.enqueueTelemetry(data, now);
                if (al.changed) recordEvent('alarm', al.counts, now);
                if (tt.connectionMade) recordEvent('connection', tt.connectionMade, now);
            } else {
                data._activity = workover.getCurrent();
                data._alarms = alarms.snapshot().counts;
                data._efficiency = efficiency.compute(data);
            }
        } catch (err) {
            console.error('Derived-data layer failed (live packet still sent):', err.message);
            data._meta.derived_error = err.message;
        }

        latestRigData = data;
        io.emit('rig_data', data);
    } catch (err) {
        console.error('Live data cycle failed:', err.message);
        emitStalePacket(err);
    }
};

// When a cycle fails (historian down/timeout, unexpected error), clients must be
// told the feed is stale. Otherwise they keep showing the last packet as live.
const emitStalePacket = (err) => {
    const now = Date.now();
    const data = JSON.parse(JSON.stringify(latestRigData || {}));
    data.well_control = { available: false };
    data.bop = { source: 'versamax', connected: false, quality: 'disconnected', lastUpdate: null };
    data._meta = {
        ...(data._meta || {}),
        ts: new Date(now).toISOString(),
        source: 'none',
        stale: true,
        bop_live: false,
        connected: false,
        age_ms: lastDataAt ? (now - lastDataAt) : null,
        error: 'Live data unavailable: ' + (err && err.message ? err.message : 'unknown error'),
    };
    latestRigData = data;
    io.emit('rig_data', data);
};

// Global cache for the latest data
let latestRigData = {};

// API: Get Latest Rig Data
app.get('/api/rig/latest', auth.requireAuth, (req, res) => {
    res.json(latestRigData);
});

// Self-scheduling poll loop with an in-flight guard so a slow Influx query
// can never let invocations overlap and stack up on shared mutable state.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1000);
let pollTimer = null;
let pollStopped = false;
const scheduleNextPoll = () => {
    if (pollStopped) return;
    pollTimer = setTimeout(async () => {
        try { await queryData(); } finally { scheduleNextPoll(); }
    }, POLL_INTERVAL_MS);
};

// API: Get Historical Data
// API: Get Historical Data
app.get('/api/history', auth.requireAuth, async (req, res) => {
    const { range, start, stop, metrics } = req.query;

    // Validate time inputs (relative durations and RFC3339 instants only). They
    // reach the database as bind parameters.
    if (start !== undefined || stop !== undefined) {
        if (!validate.isFluxInstant(start) || !validate.isFluxInstant(stop)) {
            return res.status(400).json({ error: 'Invalid start/stop (use RFC3339 timestamps)' });
        }
    } else if (range !== undefined && !validate.isFluxRange(range)) {
        return res.status(400).json({ error: 'Invalid range (use a relative duration like -1h, -7d)' });
    }

    const requestedMetrics = typeof metrics === 'string'
        ? [...new Set(metrics.split(',').map(metric => metric.trim()).filter(Boolean))]
        : [];
    if (requestedMetrics.length > 64 || requestedMetrics.some(metric => !HISTORY_METRICS.has(metric))) {
        return res.status(400).json({ error: 'Invalid history metrics' });
    }

    let durationMs;
    if (start && stop) {
        durationMs = new Date(stop).getTime() - new Date(start).getTime();
        if (!Number.isFinite(durationMs) || durationMs <= 0) {
            return res.status(400).json({ error: 'History stop time must be after start time' });
        }
    } else {
        durationMs = getFluxDurationMs(range || '-30s');
    }
    const windowPeriod = getHistoryWindowPeriod(durationMs || 30 * 1000);
    const cacheEligible = requestedMetrics.length > 0;
    const cacheKey = buildHistoryCacheKey({
        range,
        start,
        stop,
        metrics: requestedMetrics,
        windowPeriod
    });

    // Determine if we need date in the time label
    const needsDate = range?.includes('24h') || range?.includes('d') || range?.includes('mo') || (start && stop);
    const cacheTtl = getHistoryCacheTtl(durationMs || 30 * 1000);

    try {
        if (cacheEligible) {
            const cached = historyResponseCache.get(cacheKey);
            if (cached && (Date.now() - cached.at) <= cacheTtl) {
                return res.json(cached.rows);
            }
            const inflight = historyInflight.get(cacheKey);
            if (inflight) {
                return res.json(await inflight);
            }
        }

        const loadHistory = async () => {
        // Last value per window, stamped at the window end (as Flux aggregateWindow
        // did). Windows of a minute or more read the 1-minute rollup, which also
        // reaches back beyond the raw retention window.
        const params = [currentRigId()];
        const from = tsdb.timeBound(start && stop ? start : (range || '-30s'), params);
        const to = start && stop ? tsdb.timeBound(stop, params) : 'now()';
        params.push(tsdb.durationToInterval(windowPeriod));
        const every = `$${params.length}::interval`;
        let metricFilter = '';
        if (requestedMetrics.length) {
            params.push(requestedMetrics);
            metricFilter = `AND metric = ANY($${params.length})`;
        }
        const useRollup = durationMs > 30 * 60 * 1000;
        const sql = useRollup
            ? `SELECT time_bucket(${every}, bucket) + ${every} AS t, metric, last(avg, bucket) AS v
               FROM telemetry_1m_all
               WHERE rig_id = $1 AND bucket >= ${from} AND bucket < ${to} ${metricFilter}
               GROUP BY 1, 2 ORDER BY 1`
            : `SELECT time_bucket(${every}, ts) + ${every} AS t, metric, last(value, ts) AS v
               FROM telemetry
               WHERE rig_id = $1 AND ts >= ${from} AND ts < ${to} ${metricFilter}
               GROUP BY 1, 2 ORDER BY 1`;
        const { rows: points } = await tsdb.query(sql, params);
        const history = points.map((p) => ({ time: p.t, metric: p.metric, value: p.v }));

        // Group by timestamp for the chart
        const grouped = {};
        history.forEach(pt => {
            const t = new Date(pt.time).getTime(); // Use numeric timestamp as key
            if (!grouped[t]) {
                const d = new Date(pt.time);
                let label;
                if (needsDate) {
                    label = d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
                } else {
                    label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                }
                grouped[t] = { name: label, timestamp: t };
            }
            grouped[t][pt.metric] = pt.value;
        });

        // Sort by numeric timestamp (not string)
            return Object.values(grouped).sort((a, b) => a.timestamp - b.timestamp);
        };

        const rowsPromise = loadHistory();
        if (cacheEligible) {
            historyInflight.set(cacheKey, rowsPromise);
        }
        const rows = await rowsPromise;
        if (cacheEligible) {
            cacheHistory(cacheKey, rows, cacheTtl);
            historyInflight.delete(cacheKey);
        }
        res.json(rows);
    } catch (error) {
        if (cacheEligible) historyInflight.delete(cacheKey);
        res.status(500).json({ error: error.message });
    }
});

// Redundant endpoints removed (consolidated to /api/config/plc)

// --- User Management ---
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = [];

const saveUsers = () => writeJsonAtomic(USERS_FILE, users);

// Load users; migrate any legacy plaintext passwords to bcrypt hashes; seed the
// initial admin from env (ADMIN_USERNAME / ADMIN_PASSWORD) when no store exists.
const loadUsers = () => {
    const saved = readJsonSync(USERS_FILE, null);
    if (Array.isArray(saved) && saved.length) {
        let migrated = false;
        users = saved.map(u => {
            if (u.password && !auth.isHashed(u.password)) {
                migrated = true;
                return { ...u, password: auth.hashPassword(u.password) };
            }
            return u;
        });
        if (migrated) { saveUsers(); console.log('Migrated legacy plaintext passwords to bcrypt hashes.'); }
        return;
    }
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD;
    if (!adminPass) {
        console.error('FATAL: no users.json present and ADMIN_PASSWORD env is not set; cannot seed initial admin.');
        process.exit(1);
    }
    users = [{ id: 1, username: adminUser, password: auth.hashPassword(adminPass), role: 'admin', status: 'active' }];
    saveUsers();
    console.log(`Seeded initial admin user "${adminUser}" from environment.`);
};

loadUsers();

// Re-check every request/socket against the live user store (deactivation,
// deletion and role changes take effect immediately, not at token expiry).
auth.setUserResolver((claims) => users.find(u => String(u.id) === String(claims.sub)) || null);

// Drop live telemetry sockets held by a user whose access was just revoked.
const disconnectUserSockets = (id) => {
    for (const socket of io.sockets.sockets.values()) {
        if (String(socket.user?.sub) === String(id)) socket.disconnect(true);
    }
};

const sanitizeUser = ({ password, ...u }) => u;
const activeAdminCount = () => users.filter(u => u.role === 'admin' && u.status !== 'inactive').length;

// Just-in-time provisioning for a directory (LDAP/AD) user. Mirrors the AD
// account into the local store so roles/status/audit work. An admin can lock a
// role locally (roleLocked) or deactivate the account to block sign-in.
const upsertLdapUser = async (dir) => {
    let u = users.find(x => x.username.toLowerCase() === dir.username.toLowerCase());
    // Never let a directory login take over (and re-role) a local account, e.g. the
    // break-glass admin, just because the names match case-insensitively.
    if (u && u.source !== 'ldap') return { conflict: true };
    if (u) {
        if (u.status === 'inactive') return null; // locally disabled -> blocked
        if (!u.roleLocked) u.role = dir.role;      // refresh role from directory groups
        u.displayName = dir.displayName;
        u.source = 'ldap';
    } else {
        u = { id: Date.now(), username: dir.username, displayName: dir.displayName, role: dir.role, status: 'active', source: 'ldap' };
        users.push(u);
    }
    await saveUsers();
    return u;
};

// API: List Users (admin)
app.get('/api/users', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
    res.json(users.map(sanitizeUser));
});

// API: Add User (admin)
app.post('/api/users', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const { username, password, role } = req.body;
    if (!validate.USERNAME_RE.test(String(username || ''))) {
        return res.status(400).json({ error: 'Username must be 3-40 chars [A-Za-z0-9_.-]' });
    }
    if (!password || String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const newRole = role || 'operator';
    if (!validate.ROLES.includes(newRole)) return res.status(400).json({ error: 'Invalid role' });
    if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'Username already exists' });
    }
    const newUser = { id: Date.now(), username, password: auth.hashPassword(password), role: newRole, status: 'active' };
    users.push(newUser);
    await saveUsers();
    res.json({ success: true, user: sanitizeUser(newUser) });
});

// API: Update User (admin)
app.put('/api/users/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { username, password, role, status } = req.body;
    const index = users.findIndex(u => u.id == id);
    if (index === -1) return res.status(404).json({ error: 'User not found' });

    if (username !== undefined) {
        if (!validate.USERNAME_RE.test(String(username))) return res.status(400).json({ error: 'Invalid username' });
        users[index].username = username;
    }
    if (password !== undefined && password !== '') {
        if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        users[index].password = auth.hashPassword(password);
    }
    // Guard: never let the last active admin be demoted or deactivated.
    const wouldDropAdmin = (role && role !== 'admin') || (status === 'inactive');
    if (users[index].role === 'admin' && wouldDropAdmin && activeAdminCount() <= 1) {
        return res.status(400).json({ error: 'Cannot demote or deactivate the last active admin' });
    }
    if (role !== undefined) {
        if (!validate.ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
        users[index].role = role;
    }
    if (status !== undefined) users[index].status = status;
    await saveUsers();
    if (users[index].status === 'inactive') disconnectUserSockets(users[index].id);
    res.json({ success: true, user: sanitizeUser(users[index]) });
});

// API: Delete User (admin)
app.delete('/api/users/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const target = users.find(u => u.id == id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' && activeAdminCount() <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last active admin' });
    }
    users = users.filter(u => u.id != id);
    await saveUsers();
    disconnectUserSockets(target.id);
    res.json({ success: true });
});

// --- Dashboard Persistence ---
const DASHBOARD_FULL_CONFIG_FILE = path.join(DATA_DIR, 'dashboard_layout.json');
const DASHBOARD_AUDIT_FILE = path.join(DATA_DIR, 'dashboard_layout_audit.json');
const DASHBOARD_AUDIT_LIMIT = 500;

const EDR_STRIP_LIMITS = { min: 1, max: 6 };
const EDR_PEN_LIMITS = { min: 1, max: 4 };
const EDR_COLOR_RE = /^#[0-9a-f]{6}$/i;
const EDR_METRICS = edrCatalog.categories.flatMap(category =>
    category.fields.map(field => ({
        ...field,
        value: `${category.id}.${field.id}`,
        category: category.id,
        categoryLabel: category.label
    }))
);
const EDR_METRIC_BY_VALUE = new Map(EDR_METRICS.map(metric => [metric.value, metric]));
const DEFAULT_EDR_CONFIG = edrCatalog.defaultLayout;

// Default Layout (Fallback)
const DEFAULT_DASHBOARD_CONFIG = {
    gauges: [
        { id: 'd1', label: 'WOH', dataKey: 'hook_load', min: 0, max: 100, unit: 'ton', color: '#3182ce', gridWidth: 3, size: 160, majorTicks: 10, minorTicks: 4 },
        { id: 'd2', label: 'SPP', dataKey: 'SPP-Bar', min: 0, max: 5000, unit: 'psi', color: '#fbbf24', gridWidth: 3, size: 160, majorTicks: 5, minorTicks: 4 },
        { id: 'd6', label: 'HTD', dataKey: 'htd_rpm', min: 0, max: 200, unit: 'RPM', color: '#4ade80', gridWidth: 3, size: 160 },
    ],
    sideStats: [
        { key: 'pump_pressure', label: 'SPP', unit: 'psi', min: 0, max: 5000 },
        { key: 'torque', label: 'Drill String Torque', unit: 'daN·m', min: 0, max: 20000 }
    ],
    _meta: { version: 1, updatedAt: null, updatedBy: 'system', updatedByRole: 'system' },
    edr: DEFAULT_EDR_CONFIG,
    units: { wob: 'tonnes', depth: 'm' },
    wellInfo: { well: 'WELL-001', rig: 'RIG-ALPHA' },
    bottomStats: [
        {
            id: 'p1',
            title: 'DRILLING PARAMETERS',
            params: [
                { id: 'p1_1', label: 'FLOW IN', dataKey: 'flow_in', unit: 'Lt/min' },
                { id: 'p1_2', label: 'FLOW OUT', dataKey: 'flow_out', unit: '%' },
                { id: 'p1_3', label: 'ROP', dataKey: 'rop', unit: 'm/h' },
                { id: 'p1_4', label: 'SPP', dataKey: 'pump_pressure', unit: 'psi' },
                { id: 'p1_5', label: 'SPM', dataKey: 'spm', unit: 'SPM' }
            ]
        },
        {
            id: 'p2',
            title: 'HTD STATUS',
            params: [
                { id: 'p2_1', label: 'IBOP', dataKey: 'ibop_status', unit: '' },
                { id: 'p2_2', label: 'ELEVATOR', dataKey: 'elevator_status', unit: '' },
                { id: 'p2_3', label: 'BREAK', dataKey: 'brake_status', unit: '' },
                { id: 'p2_4', label: 'SPEED', dataKey: 'vertical_speed', unit: 'm/s' },
                { id: 'p2_5', label: 'LINK TILT', dataKey: 'tilt_status', unit: '' }
            ]
        },
        {
            id: 'p3',
            title: 'EQUIPMENT STATUS',
            params: [
                { id: 'p3_1', label: 'HPU', dataKey: 'hpu_status', unit: '' },
                { id: 'p3_2', label: 'HTD', dataKey: 'htd_status', unit: '' },
                { id: 'p3_3', label: 'PCT', dataKey: 'pct_status', unit: '' },
                { id: 'p3_4', label: 'CAT ENGINE', dataKey: 'engine_status', unit: '' },
                { id: 'p3_5', label: 'CWK', dataKey: 'cwk_status', unit: '' }
            ]
        },
        {
            id: 'p4',
            title: 'PCT & CWK',
            params: [
                { id: 'p4_1', label: 'SEQUENCE', dataKey: 'pct_sequence', unit: '' },
                { id: 'p4_2', label: 'SPINNER', dataKey: 'spinner_floating', unit: '' },
                { id: 'p4_3', label: 'CLAMP FORCE', dataKey: 'cwk_clamp_pressure', unit: 'Bar' },
                { id: 'p4_4', label: 'CLAMP', dataKey: 'cwk_clamp_status', unit: '' },
                { id: 'p4_5', label: 'SPINNER TORQUE', dataKey: 'spinner_makeup_torque', unit: 'daN*m' }
            ]
        }
    ]
};

const auditId = () => `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const appendDashboardAudit = async (record) => {
    const audit = readJsonSync(DASHBOARD_AUDIT_FILE, []);
    const rows = Array.isArray(audit) ? audit : [];
    rows.push(record);
    await writeJsonAtomic(DASHBOARD_AUDIT_FILE, rows.slice(-DASHBOARD_AUDIT_LIMIT));
};

const clampInteger = (value, fallback, min, max) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const numericOrFallback = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const sanitizeWellInfo = (info = {}) => {
    const fallback = DEFAULT_DASHBOARD_CONFIG.wellInfo;
    const rig = typeof info.rig === 'string' ? info.rig.trim().slice(0, 40) : '';
    const well = typeof info.well === 'string' ? info.well.trim().slice(0, 40) : '';
    return {
        rig: rig || fallback.rig,
        well: well || fallback.well
    };
};

const getDefaultEdrPen = (stripIndex, penIndex) => {
    const strip = DEFAULT_EDR_CONFIG.strips[stripIndex % DEFAULT_EDR_CONFIG.strips.length];
    return strip.pens[penIndex % strip.pens.length] || DEFAULT_EDR_CONFIG.strips[0].pens[0];
};

const sanitizeEdrPen = (pen, stripIndex, penIndex) => {
    const fallback = getDefaultEdrPen(stripIndex, penIndex);
    const source = pen && typeof pen === 'object' ? pen : {};
    const metric = EDR_METRIC_BY_VALUE.has(source.metric) ? source.metric : fallback.metric;
    const meta = EDR_METRIC_BY_VALUE.get(metric);
    const min = numericOrFallback(source.min, fallback.min ?? meta?.defaultMin ?? 0);
    let max = numericOrFallback(source.max, fallback.max ?? meta?.defaultMax ?? 1);
    if (max <= min) max = min + 1;

    return {
        id: typeof source.id === 'string' && source.id.trim() ? source.id.trim().slice(0, 40) : `s${stripIndex + 1}p${penIndex + 1}`,
        metric,
        min,
        max,
        color: EDR_COLOR_RE.test(source.color || '') ? source.color : fallback.color
    };
};

const normalizeLegacyEdrStrips = (config) => {
    if (Array.isArray(config?.strips)) return config.strips;
    if (!Array.isArray(config?.tracks)) return [];
    return config.tracks.map((track, stripIndex) => ({
        id: `strip-${stripIndex + 1}`,
        title: `Strip ${stripIndex + 1}`,
        pens: [track.left, track.right].filter(Boolean)
    }));
};

const sanitizeEdrPreset = (preset, index) => {
    const source = preset && typeof preset === 'object' ? preset : {};
    const configSource = source.config && typeof source.config === 'object' ? source.config : source;
    return {
        id: typeof source.id === 'string' && source.id.trim() ? source.id.trim().slice(0, 48) : `preset-${index + 1}`,
        name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 80) : `Preset ${index + 1}`,
        createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
        createdBy: typeof source.createdBy === 'string' ? source.createdBy.slice(0, 80) : 'unknown',
        config: sanitizeEdrConfig(configSource, { includePresets: false })
    };
};

const sanitizeEdrConfig = (config = {}, options = { includePresets: true }) => {
    const source = config && typeof config === 'object' ? config : {};
    const sourceStrips = normalizeLegacyEdrStrips(source);
    const stripCount = clampInteger(
        source.stripCount ?? sourceStrips.length,
        DEFAULT_EDR_CONFIG.stripCount,
        EDR_STRIP_LIMITS.min,
        EDR_STRIP_LIMITS.max
    );
    const pensPerStrip = clampInteger(
        source.pensPerStrip,
        DEFAULT_EDR_CONFIG.pensPerStrip,
        EDR_PEN_LIMITS.min,
        EDR_PEN_LIMITS.max
    );

    const result = {
        stripCount,
        pensPerStrip,
        strips: Array.from({ length: stripCount }, (_, stripIndex) => {
            const sourceStrip = sourceStrips[stripIndex] || DEFAULT_EDR_CONFIG.strips[stripIndex % DEFAULT_EDR_CONFIG.strips.length];
            return {
                id: typeof sourceStrip.id === 'string' && sourceStrip.id.trim() ? sourceStrip.id.trim().slice(0, 40) : `strip-${stripIndex + 1}`,
                title: typeof sourceStrip.title === 'string' && sourceStrip.title.trim() ? sourceStrip.title.trim().slice(0, 60) : `Strip ${stripIndex + 1}`,
                pens: Array.from({ length: pensPerStrip }, (_, penIndex) => (
                    sanitizeEdrPen(sourceStrip.pens?.[penIndex], stripIndex, penIndex)
                ))
            };
        })
    };
    if (options.includePresets !== false) {
        result.presets = Array.isArray(source.presets)
            ? source.presets.slice(0, 20).map((preset, index) => sanitizeEdrPreset(preset, index))
            : [];
    }
    return result;
};

const getDashboardConfig = () => {
    // Clone the default so we never mutate the shared constant by reference.
    const defaultConfig = JSON.parse(JSON.stringify(DEFAULT_DASHBOARD_CONFIG));
    let config = readJsonSync(DASHBOARD_FULL_CONFIG_FILE, null) || defaultConfig;
    config = { ...defaultConfig, ...config };

    // Migration: Enforce allowed gauges (WOH, WOB, HTD RPM, HTD TORQUE, PCT TORQUE) and max 5
    if (config.gauges) {
        const allowedKeys = ['hook_load', 'wob', 'htd_rpm', 'htd_torque', 'pct_torque', 'SPP-Bar'];
        config.gauges = config.gauges.filter(g => allowedKeys.includes(g.dataKey)).slice(0, 5);

        // If empty, restore defaults
        if (config.gauges.length === 0) {
            config.gauges = DEFAULT_DASHBOARD_CONFIG.gauges;
        }
    }

    // Migration: Ensure units are 'm' for depth
    if (config.units && config.units.depth === 'ft') {
        config.units.depth = 'm';
    }

    const version = Number(config._meta?.version);
    config._meta = {
        version: Number.isFinite(version) && version > 0 ? version : 1,
        updatedAt: config._meta?.updatedAt || null,
        updatedBy: config._meta?.updatedBy || 'system',
        updatedByRole: config._meta?.updatedByRole || 'system'
    };
    config.edr = sanitizeEdrConfig(config.edr);
    config.wellInfo = sanitizeWellInfo(config.wellInfo);

    return config;
};

const saveDashboardConfig = (config) => writeJsonAtomic(DASHBOARD_FULL_CONFIG_FILE, config);

// API: Get Dashboard Layout (any authenticated user)
app.get('/api/dashboard/layout', auth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.json(getDashboardConfig());
});

// API: Save Dashboard Layout (admin)
app.post('/api/dashboard/layout', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const incomingConfig = { ...(req.body || {}) };
    delete incomingConfig._meta;
    const existingConfig = getDashboardConfig();
    const changedSections = Object.keys(incomingConfig);

    // Migration: Sanitize incoming gauges (Allow WOH, WOB, HTD RPM, HTD TORQUE, PCT TORQUE) and limit to 5
    if (incomingConfig.gauges) {
        const allowedKeys = ['hook_load', 'wob', 'htd_rpm', 'htd_torque', 'pct_torque', 'SPP-Bar'];
        incomingConfig.gauges = incomingConfig.gauges.filter(g => allowedKeys.includes(g.dataKey)).slice(0, 5);
    }

    if (incomingConfig.edr) {
        incomingConfig.edr = sanitizeEdrConfig(incomingConfig.edr);
    }

    if (incomingConfig.wellInfo) {
        incomingConfig.wellInfo = sanitizeWellInfo(incomingConfig.wellInfo);
    }

    // Merge existing config with incoming updates
    const mergedConfig = {
        ...existingConfig,
        ...incomingConfig
    };
    mergedConfig.edr = sanitizeEdrConfig(mergedConfig.edr);
    mergedConfig._meta = {
        version: (Number(existingConfig._meta?.version) || 1) + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user?.username || 'unknown',
        updatedByRole: req.user?.role || 'unknown'
    };

    await saveDashboardConfig(mergedConfig);
    await appendDashboardAudit({
        id: auditId(),
        ts: mergedConfig._meta.updatedAt,
        version: mergedConfig._meta.version,
        by: mergedConfig._meta.updatedBy,
        role: mergedConfig._meta.updatedByRole,
        sections: changedSections,
        summary: {
            edr: incomingConfig.edr ? {
                stripCount: mergedConfig.edr.stripCount,
                pensPerStrip: mergedConfig.edr.pensPerStrip,
                metrics: mergedConfig.edr.strips.flatMap(strip => strip.pens.map(pen => pen.metric))
            } : undefined,
            wellInfo: incomingConfig.wellInfo || undefined
        }
    });
    // Real-time broadcast
    io.emit('dashboard_layout_update', mergedConfig);
    res.json({ success: true, config: mergedConfig });
});

// API: Dashboard layout audit (admin)
app.get('/api/dashboard/audit', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
    const section = typeof req.query.section === 'string' ? req.query.section : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const audit = readJsonSync(DASHBOARD_AUDIT_FILE, []);
    const rows = Array.isArray(audit) ? audit : [];
    const filtered = section ? rows.filter(row => row.sections?.includes(section)) : rows;
    res.json({ events: filtered.slice(-limit).reverse() });
});

// --- Workover: Activity / NPT ---
app.get('/api/activity/current', auth.requireAuth, (req, res) => res.json(workover.getCurrent() || {}));
app.get('/api/activity/codes', auth.requireAuth, (req, res) => res.json(workover.getCodes()));
app.get('/api/activity/log', auth.requireAuth, (req, res) => res.json(workover.getLog(req.query.date)));
app.post('/api/activity/set', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const { code, npt } = req.body || {};
        res.json({ success: true, current: workover.setActivity(code, npt) });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Workover: Alarm management ---
app.get('/api/alarms', auth.requireAuth, (req, res) => res.json(alarms.getActive()));
app.get('/api/alarms/history', auth.requireAuth, (req, res) => res.json(alarms.getHistory(Number(req.query.limit) || 200)));
app.post('/api/alarms/ack-all', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    const acknowledged = alarms.ackAll(req.user.username);
    const snap = alarms.snapshot(); io.emit('alarms', snap);
    res.json({ success: true, acknowledged, ...snap });
});
app.post('/api/alarms/:id/ack', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    const ok = alarms.ack(req.params.id, req.user.username);
    const snap = alarms.snapshot(); io.emit('alarms', snap);
    res.json({ success: ok, ...snap });
});
app.get('/api/alarms/config', auth.requireAuth, (req, res) => res.json(alarms.getConfig()));
app.put('/api/alarms/config', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, config: await alarms.setConfig(req.body) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Workover: Torque-turn / connections ---
app.get('/api/connections', auth.requireAuth, (req, res) => res.json(workover.getConnections(req.query.date)));
app.get('/api/torqueturn/current', auth.requireAuth, (req, res) => res.json(workover.getTorqueTurnLive()));

// --- Workover: Daily report ---
app.get('/api/report/daily', auth.requireAuth, (req, res) => {
    const rep = workover.getDailyReport(req.query.date);
    const wh = wells.getHeader();                 // active well overrides the manual header
    if (wh) rep.header = { ...rep.header, ...wh };
    res.json(rep);
});
app.get('/api/report/header', auth.requireAuth, (req, res) => res.json(wells.getHeader() || workover.getHeader()));
app.put('/api/report/header', auth.requireAuth, auth.requireRole('admin', 'operator'), async (req, res) => {
    res.json({ success: true, header: await workover.setHeader(req.body || {}) });
});

// --- Well registry + lifecycle (store data by well) ---
app.get('/api/wells', auth.requireAuth, (req, res) => res.json(wells.getWells()));
app.get('/api/wells/active', auth.requireAuth, (req, res) => res.json(wells.getActiveWell() || null));
app.get('/api/wells/service-types', auth.requireAuth, (req, res) => res.json(wells.getServiceTypes()));

// Well record: elapsed time / NPT / activity / joints / depth plus diesel and
// engine hours for the well, read from the historian.
app.get('/api/wells/:id/summary', auth.requireAuth, async (req, res) => {
    const summary = wells.getWellSummary(req.params.id);
    if (!summary) return res.json(null);
    if (req.query.light === '1' || req.query.light === 'true') {
        return res.json(summary);
    }
    const well = wells.getWell(req.params.id);
    let consumption = null;
    try { consumption = await wellArchive.getWellConsumption(well && well.startedAt, well && well.completedAt); }
    catch (e) { console.error('well consumption failed:', e.message); }
    res.json({ ...summary, consumption });
});

// Per-well 1-minute archive buckets.
app.get('/api/wells/archives', auth.requireAuth, async (req, res) => {
    try { res.json(await wellArchive.listArchives()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/wells/archive/status', auth.requireAuth, (req, res) => res.json(wellArchive.getStatus()));

// Exports stream slice by slice (no row cap, bounded memory). Once streaming
// has started an error can only abort the download.
const safeFilename = (name) => String(name).replace(/[^A-Za-z0-9_.\-]/g, '_');
const streamArchive = async (res, exp, filename, format) => {
    const json = format === 'json';
    res.setHeader('Content-Type', json ? 'application/json' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}.${json ? 'json' : 'csv'}"`);
    try {
        await wellArchive.streamExport(res, exp, json ? 'json' : 'csv');
    } catch (e) {
        console.error('Export failed mid-stream:', e.message);
        res.destroy(e);
    }
};

// NOTE: /api/wells/archive/* must be registered before /api/wells/:id/export.
app.get('/api/wells/archive/export', auth.requireAuth, async (req, res) => {
    try {
        const archive = await wellArchive.assertArchiveBucket(req.query.bucket);
        const exp = await wellArchive.exportArchive(archive, {
            metrics: req.query.metrics,
            start: req.query.start || '-100y',
            stop: req.query.stop || 'now()',
            every: req.query.every,
        });
        const filename = archive.kind === 'well' ? `${archive.well}_${archive.name}` : archive.name;
        await streamArchive(res, exp, filename, req.query.format === 'json' ? 'json' : 'csv');
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.get('/api/wells/archive/describe', auth.requireAuth, async (req, res) => {
    try { res.json(await wellArchive.describeArchive(req.query.bucket)); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/wells/archive/data', auth.requireAuth, async (req, res) => {
    try {
        const archive = await wellArchive.assertArchiveBucket(req.query.bucket);
        res.json(await wellArchive.queryWide(archive, {
            metrics: req.query.metrics,
            start: req.query.start || '-100y',
            stop: req.query.stop || 'now()',
            every: req.query.every,
        }));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.get('/api/wells/:id/export', auth.requireAuth, async (req, res) => {
    const well = wells.getWell(req.params.id);
    if (!well) return res.status(404).json({ error: 'well not found' });
    const format = req.query.format === 'json' ? 'json' : 'csv';
    const tier = req.query.tier === 'raw' ? 'raw' : 'archive';
    try {
        const exp = await wellArchive.exportWell(well, {
            tier,
            metrics: req.query.metrics,
            start: req.query.start,
            stop: req.query.stop,
            every: req.query.every,
        });
        const stamp = (exp.from || '').slice(0, 10);
        await streamArchive(res, exp, `${well.name}_${tier === 'raw' ? 'raw' : '1min'}_${stamp}`, format);
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.get('/api/wells/:id/report', auth.requireAuth, async (req, res) => {
    const well = wells.getWell(req.params.id);
    if (!well) return res.status(404).json({ error: 'well not found' });
    try {
        let consumption = null;
        try { consumption = await wellArchive.getWellConsumption(well.startedAt, well.completedAt); }
        catch (e) { console.error('report consumption failed:', e.message); }
        const report = wellReport.buildWellReport(well, {
            latestRigData,
            summary: wells.getWellSummary(req.params.id),
            consumption,
        });
        if (!report) return res.status(400).json({ error: 'well has not been started yet' });
        res.json(report);
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

app.post('/api/wells/import',
    auth.requireAuth, auth.requireRole('admin', 'operator'),
    express.json({ limit: process.env.IMPORT_MAX_SIZE || '64mb' }),
    async (req, res) => {
        try {
            const result = await wellArchive.importHistory({
                label: req.body.label,
                csv: req.body.csv,
                rows: req.body.rows,
            });
            console.log(`Historical import: ${result.pointsWritten} points -> ${result.bucket}`);
            res.json(result);
        } catch (e) {
            res.status(e.status || 500).json({ error: e.message });
        }
    });

app.post('/api/wells', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const well = wells.createWell(req.body || {}, req.user.username);
        recordEvent('well.created', { well, user: req.user.username });
        res.json({ success: true, well });
    }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.put('/api/wells/:id', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const well = wells.updateWell(req.params.id, req.body || {}, req.user.username);
        wellArchive.updateWellInfo(well).catch((e) => console.error('well registry write failed:', e.message));
        recordEvent('well.updated', { well, user: req.user.username });
        res.json({ success: true, well });
    }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.delete('/api/wells/:id', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        // The well's recorded runs stay in the historian (well_runs / telemetry_1m).
        const well = wells.deleteWell(req.params.id);
        recordEvent('well.deleted', { well, user: req.user.username });
        res.json({ success: true, well });
    }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/wells/:id/start', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const well = wells.startWell(req.params.id, req.user.username);
        wellArchive.startRun(well).catch((e) => console.error('well run start failed:', e.message));
        recordEvent('well.started', { well, user: req.user.username });
        res.json({ success: true, well });
    }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/wells/:id/complete', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const well = wells.completeWell(req.params.id, req.user.username);
        wellArchive.endRun(well).catch((e) => console.error('well run end failed:', e.message));
        recordEvent('well.completed', { well, user: req.user.username });
        res.json({ success: true, well });
    }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Sync agent (store-and-forward, outbound only) ---
app.get('/api/sync/status', auth.requireAuth, (req, res) => res.json(sync.getStatus()));
app.get('/api/sync/config', auth.requireAuth, (req, res) => res.json(sync.getConfig()));
app.put('/api/sync/config', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try {
        const body = req.body || {};
        // The device id is also the historian rig_id and a Telegraf tag value.
        if (body.deviceId !== undefined) telegrafConfig.assertRigId(body.deviceId);
        const before = currentRigId();
        const config = await sync.setConfig(body);
        centralMessages.reconnectNow();
        if (currentRigId() !== before) {
            try { applyTelegrafConfig(); } catch (e) { console.error('Telegraf rig_id update failed:', e.message); }
            tsdb.ensureRig(currentRigId()).catch((e) => console.error('rig registration failed:', e.message));
        }
        res.json({ success: true, config });
    }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/sync/flush', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    await sync.flush({ heartbeatWhenEmpty: true }); res.json({ success: true, status: sync.getStatus() });
});

// --- Edge health / data quality ---
app.get('/api/health/edge', auth.requireAuth, (req, res) => res.json(health.getEdgeHealth(latestRigData, sync.getStatus())));

// --- ETP 2.0 publisher (outbound only) ---
app.get('/api/etp/status', auth.requireAuth, (req, res) => res.json(etp.getStatus()));
app.put('/api/etp/config', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, status: await etp.setConfig(req.body || {}) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Hydraulic efficiency & energy (derived, read-only) ---
app.get('/api/efficiency', auth.requireAuth, (req, res) => res.json(efficiency.getFull(latestRigData)));
app.get('/api/efficiency/config', auth.requireAuth, (req, res) => res.json(efficiency.getConfig()));
app.put('/api/efficiency/config', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, config: await efficiency.setConfig(req.body || {}) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- WITSML 1.4.1 export (interoperability, export only) ---
// The well a WITSML document describes: ?well=<id>, else the active well, else
// the manual report header.
const witsmlWell = (req) => {
    if (req.query.well) {
        const w = wells.getWell(String(req.query.well));
        if (!w) throw Object.assign(new Error('well not found'), { status: 404 });
        return w;
    }
    const active = wells.getActiveWell();
    if (active) return active;
    const h = workover.getHeader() || {};
    return { id: h.well || 'WELL', name: h.well || 'WELL', field: h.field, operator: h.operator, jobNo: h.jobNo };
};
const WITSML_MAX_ROWS = Number(process.env.WITSML_MAX_ROWS || 50000);
const sendXml = (res, filename, xml) => {
    res.type('application/xml');
    if (filename) res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(filename)}.xml"`);
    res.send(xml);
};
const liveDepths = () => ({
    holeDepthM: latestRigData?.drilling?.hole_depth,
    bitDepthM: latestRigData?.drilling?.bit_depth,
});

app.get('/api/witsml/well', auth.requireAuth, (req, res) => {
    const well = witsmlWell(req);
    sendXml(res, null, witsml.wells(well));
});
app.get('/api/witsml/wellbore', auth.requireAuth, (req, res) => {
    const well = witsmlWell(req);
    sendXml(res, null, witsml.wellbores(well, well.status === 'active' ? liveDepths() : {}));
});
// Time log from the historian. ?minutes=N (recent raw data, as before), or a
// well window: ?well=<id>&tier=raw|1m [&start&stop] [&metrics=a,b] [&envelope=1].
app.get('/api/witsml/log', auth.requireAuth, async (req, res) => {
    const well = witsmlWell(req);
    const tier = req.query.tier === '1m' ? '1m' : 'raw';
    let start = req.query.start;
    let stop = req.query.stop;
    if (!start && req.query.well) { start = well.startedAt; stop = stop || well.completedAt || 'now()'; }
    if (!start) start = `-${Math.min(60, Math.max(1, Number(req.query.minutes) || 2))}m`;
    const requested = typeof req.query.metrics === 'string' && req.query.metrics.trim()
        ? req.query.metrics.split(',').map((m) => m.trim()).filter(Boolean)
        : witsml.DEFAULT_LOG_METRICS;
    const src = await wellArchive.telemetrySource({ tier, start, stop: stop || 'now()', metrics: requested.join(',') });
    const available = await src.columns();
    const envelope = tier === '1m' && req.query.envelope === '1';
    const metrics = available.filter((c) => !/_(min|max)$/.test(c) || envelope);
    const { rows, truncated } = await wellArchive.collect({ slices: src.slices.bind(src) });
    const meta = metrics.length ? (await tsdb.query('SELECT metric, label, unit FROM tags WHERE metric = ANY($1)',
        [metrics.map((m) => m.replace(/_(min|max)$/, ''))])).rows : [];
    const byMetric = new Map(meta.map((r) => [r.metric, r]));
    const channels = metrics.map((m) => {
        const t = byMetric.get(m.replace(/_(min|max)$/, '')) || {};
        return { metric: m, unit: t.unit, label: t.label };
    });
    if (truncated || rows.length > WITSML_MAX_ROWS) res.setHeader('X-Export-Truncated', 'true');
    sendXml(res, null, witsml.logs(well, channels, rows.slice(0, WITSML_MAX_ROWS), {
        name: tier === '1m' ? '1-minute summary log' : 'Edge time log',
        uid: `log-${well.id || well.name}-${tier}`,
        intervalLabel: `${tier === '1m' ? '1-minute mean' : 'full-rate'} data ${src.from} to ${src.to}`,
    }));
});
// Alarm history as WITSML messages (?well=<id> limits it to that well's window).
app.get('/api/witsml/messages', auth.requireAuth, (req, res) => {
    const well = witsmlWell(req);
    const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 1000));
    let events = alarms.getHistory(5000).slice().reverse();
    if (req.query.well && well.startedAt) {
        const from = Date.parse(well.startedAt);
        const to = well.completedAt ? Date.parse(well.completedAt) : Infinity;
        events = events.filter((e) => { const t = Date.parse(e.ts); return t >= from && t <= to; });
    }
    sendXml(res, null, witsml.messages(well, events.slice(-limit)));
});
// Daily operations report (activities with productive/NPT time) for ?date=YYYY-MM-DD.
app.get('/api/witsml/opsreport', auth.requireAuth, (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : new Date().toISOString().slice(0, 10);
    const well = witsmlWell(req);
    const header = wells.getHeader() || workover.getHeader() || {};
    const report = workover.getDailyReport(date);
    sendXml(res, null, witsml.opsReports(well, { date, entries: workover.getLog(date) }, {
        rigName: header.rig || currentRigId(),
        holeDepthM: report && report.depth ? report.depth.end ?? report.depth.max : undefined,
    }));
});

// --- Variables mapping (protocol-aware sources) ---
app.get('/api/variables', auth.requireAuth, (req, res) => res.json(variables.getVariables()));
app.get('/api/variables/source-types', auth.requireAuth, (req, res) => res.json(variables.getSourceTypes()));
app.get('/api/variables/collector-config', auth.requireAuth, (req, res) => res.json(variables.getCollectorConfig()));
app.put('/api/variables', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, variables: await variables.setVariables(req.body) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/variables', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, variable: await variables.addVariable(req.body || {}) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.delete('/api/variables/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, deleted: await variables.deleteVariable(req.params.id) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Maintenance & asset health ---
app.get('/api/maintenance/summary', auth.requireAuth, (req, res) => res.json(maintenance.getSummary(latestRigData)));
app.get('/api/maintenance/pm', auth.requireAuth, (req, res) => res.json(maintenance.getPM(latestRigData)));
app.post('/api/maintenance/pm/:id/service', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, task: maintenance.serviceTask(req.params.id, { ...req.body, by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.get('/api/maintenance/calibrations', auth.requireAuth, (req, res) => res.json(maintenance.getCalibrations(Number(req.query.limit) || 200)));
app.post('/api/maintenance/calibrations', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    res.json({ success: true, record: maintenance.logCalibration({ ...req.body, by: req.user.username }) });
});
app.get('/api/maintenance/downtime', auth.requireAuth, (req, res) => res.json(maintenance.getDowntime(Number(req.query.limit) || 200)));
app.get('/api/maintenance/reason-codes', auth.requireAuth, (req, res) => res.json(maintenance.REASON_CODES));
app.post('/api/maintenance/downtime', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, record: maintenance.logDowntime({ ...req.body, by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/maintenance/downtime/:id/close', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, record: maintenance.closeDowntime(req.params.id, { by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- CMMS: work orders, overhauls, run-hours, instruments and logbook ---
app.get('/api/cmms/meta', auth.requireAuth, (req, res) => res.json({
    assets: maintenance.ASSETS,
    woTypes: cmms.WO_TYPES,
    woStatus: cmms.WO_STATUS,
    woPriority: cmms.WO_PRIORITY,
    failureCodes: cmms.FAILURE_CODES,
    logCategories: cmms.LOG_CATEGORIES,
    logTypes: cmms.LOG_TYPES,
    logCategoriesByType: cmms.LOG_CATEGORIES_BY_TYPE,
    logCategoryLabels: cmms.LOG_CATEGORY_LABELS,
    shifts: cmms.SHIFTS,
    overhaulStatus: cmms.OVERHAUL_STATUS
}));
app.get('/api/cmms/summary', auth.requireAuth, (req, res) => res.json(cmms.getCmmsSummary()));

app.get('/api/cmms/work-orders', auth.requireAuth, (req, res) => res.json(cmms.listWorkOrders(req.query)));
app.post('/api/cmms/work-orders', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, workOrder: cmms.createWorkOrder({ ...req.body, by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.patch('/api/cmms/work-orders/:id', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, workOrder: cmms.updateWorkOrder(req.params.id, req.body, req.user.username) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

app.get('/api/cmms/overhauls', auth.requireAuth, (req, res) => res.json(cmms.listOverhauls(req.query)));
app.post('/api/cmms/overhauls', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, overhaul: cmms.createOverhaul({ ...req.body, by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.patch('/api/cmms/overhauls/:id', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, overhaul: cmms.updateOverhaul(req.params.id, req.body, req.user.username) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

app.get('/api/cmms/logbook', auth.requireAuth, (req, res) => res.json(cmms.listLogbook(req.query)));
app.post('/api/cmms/logbook', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, entry: cmms.addLogEntry({ ...req.body, by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

app.get('/api/cmms/runhours/status', auth.requireAuth, (req, res) => res.json(runlog.getStatus(maintenance.getHours())));
app.get('/api/cmms/runhours/daily', auth.requireAuth, (req, res) => res.json(runlog.listDaily({ days: Number(req.query.days) || 30 })));
app.get('/api/cmms/runhours/history/:assetId', auth.requireAuth, (req, res) => res.json(runlog.getAssetHistory(req.params.assetId)));
app.get('/api/cmms/runhours/sessions', auth.requireAuth, (req, res) => res.json(runlog.listSessions(req.query)));
app.get('/api/cmms/runhours/snapshots', auth.requireAuth, (req, res) => res.json(runlog.listSnapshots(req.query)));

app.get('/api/cmms/instruments/meta', auth.requireAuth, (req, res) => res.json({
    types: instruments.INSTRUMENT_TYPES,
    results: instruments.CAL_RESULTS,
    statuses: instruments.INSTRUMENT_STATUS,
    assets: maintenance.ASSETS
}));
app.get('/api/cmms/instruments/summary', auth.requireAuth, (req, res) => res.json(instruments.getSummary()));
app.get('/api/cmms/instruments', auth.requireAuth, (req, res) => res.json(instruments.listInstruments(req.query)));
app.post('/api/cmms/instruments', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, instrument: instruments.createInstrument(req.body, req.user.username) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.patch('/api/cmms/instruments/:id', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, instrument: instruments.updateInstrument(req.params.id, req.body) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.get('/api/cmms/instruments/:id/calibrations', auth.requireAuth, (req, res) => {
    res.json(instruments.listCalibrations({ instrumentId: req.params.id, limit: Number(req.query.limit) || 300 }));
});
app.post('/api/cmms/instruments/:id/calibrations', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, ...instruments.addCalibration(req.params.id, req.body, req.user.username) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Authentication API ---
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_LIMIT || 20),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many login attempts. Please try again later.' }
});

// Tells the login UI which providers are available (unauthenticated).
app.get('/api/auth/info', (req, res) => res.json(ldap.info()));

// Login supports local accounts and/or Windows-domain (LDAP/AD) accounts,
// selected by AUTH_MODE (local | ldap | both). In 'both', a local account is
// tried first (break-glass admin), then the directory.
app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    const mode = (process.env.AUTH_MODE || 'local').toLowerCase();

    // 1) Local authentication.
    if (mode === 'local' || mode === 'both') {
        const local = users.find(u => u.username === username && u.status !== 'inactive');
        if (local && local.password && auth.verifyPassword(password, local.password)) {
            return res.json({ success: true, token: auth.signToken(local), user: sanitizeUser(local) });
        }
        if (mode === 'local') {
            return res.status(401).json({ success: false, message: 'Invalid credentials or account inactive' });
        }
    }

    // 2) Windows domain (LDAP/Active Directory) authentication.
    if ((mode === 'ldap' || mode === 'both') && ldap.ldapEnabled()) {
        try {
            const dir = await ldap.authenticate(username, password);
            const u = await upsertLdapUser(dir);
            if (!u) return res.status(403).json({ success: false, message: 'Account disabled' });
            if (u.conflict) return res.status(409).json({ success: false, message: 'Domain account name conflicts with a local account; ask an administrator' });
            return res.json({ success: true, token: auth.signToken(u), user: sanitizeUser(u) });
        } catch (e) {
            return res.status(401).json({ success: false, message: 'Invalid domain credentials' });
        }
    }

    return res.status(401).json({ success: false, message: 'Invalid credentials or account inactive' });
});

// --- Error handling, startup & graceful shutdown ---------------------------
// Catch-all error middleware so a thrown error in any handler returns JSON
// instead of crashing or leaking a stack trace.
if (FRONTEND_DIST_DIR && fs.existsSync(FRONTEND_DIST_DIR)) {
    app.use(express.static(FRONTEND_DIST_DIR, { index: false, fallthrough: true }));
    app.use((req, res, next) => {
        if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/socket.io') && req.accepts('html') && fs.existsSync(FRONTEND_INDEX_PATH)) {
            return res.sendFile(FRONTEND_INDEX_PATH);
        }
        return next();
    });
}
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error('Unhandled error:', err.message);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

server.listen(PORT, HOST, () => {
    console.log(`ROM-II backend listening on ${TLS_ON ? 'https' : 'http'}://${HOST || '0.0.0.0'}:${PORT} (data source: ${DATA_SOURCE}, rig ${currentRigId()})`);
    historianStartup();
    queryData().finally(scheduleNextPoll);
});

// --- Historian start-up (TimescaleDB) ---------------------------------------
// Keep the managed Telegraf config in step with plc_config.json and this
// backend's mapping, register the rig, seed the tag dictionary and back-fill
// runs for wells started before the database existed. Retries until the
// database and schema are available (e.g. PostgreSQL still starting).
const tagDictionary = () => {
    const rows = new Map();
    for (const category of edrCatalog.categories) {
        for (const field of category.fields) {
            rows.set(`${category.id}.${field.id}`, { metric: `${category.id}.${field.id}`, label: field.label, unit: field.unit || null, group: category.label });
        }
    }
    for (const [raw, mapped] of Object.entries(FIELD_MAP)) {
        const metric = `${mapped.meas}.${mapped.field}`;
        if (!rows.has(metric)) rows.set(metric, { metric, label: raw, unit: null, group: mapped.meas });
    }
    return [...rows.values()];
};
let historianReady = false;
const historianStartup = async () => {
    if (historianReady || shuttingDown) return;
    try { applyTelegrafConfig(); } catch (e) { console.error('Failed to write Telegraf PLC config:', e.message); }
    if (!(await tsdb.checkSchema())) return;
    try {
        await tsdb.ensureRig(currentRigId());
        await tsdb.upsertTags(tagDictionary());
        const runs = await wellArchive.syncRegistry(wells.getWells());
        historianReady = true;
        console.log(`TimescaleDB historian ready (rig ${currentRigId()}, ${runs} well run(s) synced).`);
    } catch (e) {
        console.error('Historian start-up failed (will retry):', e.message);
    }
};
const historianTimer = setInterval(() => { if (!historianReady) historianStartup(); }, 30000);

// Periodically flush drilling state off the hot loop.
const flushTimer = setInterval(flushDrillingState, Number(process.env.STATE_FLUSH_MS || 5000));

process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));
// An uncaught exception leaves the process in an unknown state: save what can
// be saved and exit non-zero so the service manager restarts a clean process.
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception, restarting:', err);
    Promise.race([persist.flush(), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(1));
});

let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    pollStopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    clearInterval(flushTimer);
    clearInterval(historianTimer);
    try { await flushDrillingState(); } catch (e) { /* best effort */ }
    try { await persist.flush(); } catch (e) { /* best effort */ }
    io.close();
    tsdb.close().catch(() => {});
    server.close(() => { console.log('HTTP server closed.'); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref(); // hard cap
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
