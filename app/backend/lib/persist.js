'use strict';
// Operating-record persistence: users, work orders, logbook, calibrations,
// alarm settings and events, the well registry, dashboard layout, sync state…
// Each record set is one named JSON document (e.g. "users.json").
//
// Two backends:
//   db   (the running backend, after init()) — one row per document in
//        app.documents (PostgreSQL, database ahwr_edge). Every document is
//        loaded into memory at start, so reads stay synchronous; a write
//        updates memory at once and is written to the database in order
//        (latest value wins; at most one write per document every 2 s, 10 s for
//        documents over 256 KB; flushed on shutdown; retried if the database
//        is briefly unavailable). Backed up with Backup-AHWR-EDGE-Records.ps1.
//   file (tests and tools; PERSIST_BACKEND=file) — one JSON file per document
//        in DATA_DIR, written atomically.
//
// Documents that other processes read are also mirrored to DATA_DIR as files:
// bop_config.json (BOP collector) and plc_config.json (migration tool).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const full = (file) => path.join(DATA_DIR, file);
const MIRRORED = new Set(['bop_config.json', 'plc_config.json']);
const WRITE_MIN_INTERVAL_MS = Number(process.env.PERSIST_MIN_INTERVAL_MS || 2000);
const LARGE_DOC_CHARS = 256 * 1024;
const LARGE_DOC_INTERVAL_MS = Number(process.env.PERSIST_LARGE_INTERVAL_MS || 10000);

let backend = 'file';
let pool = null;
const docs = new Map();     // db backend: document name -> JSON text (authoritative copy)
const writers = new Map();  // db backend: document name -> pending write state
let lastErrorLogAt = 0;

// JSON text, tolerating a UTF-8 byte-order mark (Windows editors add one; a
// BOM made JSON.parse fail and the record silently fall back to its default).
const parseJson = (text) => JSON.parse(String(text).replace(/^\uFEFF/, ''));

// ---- File backend --------------------------------------------------------
// Unique temp name per write: a shared `<file>.<pid>.tmp` let two overlapping
// writes interleave into one temp file (corrupt JSON) or fail the second rename.
let tmpSeq = 0;
const tmpPath = (target) => `${target}.${process.pid}.${Date.now()}.${++tmpSeq}.tmp`;

// Writes to the same path are chained so they land in call order.
const writeChains = new Map();
const writeJsonFile = (target, obj) => {
    const body = JSON.stringify(obj, null, 2); // snapshot now, not when the chain runs
    const prev = writeChains.get(target) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
        const tmp = tmpPath(target);
        try {
            await fsp.writeFile(tmp, body);
            await fsp.rename(tmp, target);
        } catch (err) {
            fsp.unlink(tmp).catch(() => {});
            throw err;
        }
    });
    writeChains.set(target, run);
    run.finally(() => { if (writeChains.get(target) === run) writeChains.delete(target); }).catch(() => {});
    return run;
};
const writeFileSyncAtomic = (target, text) => {
    const tmp = tmpPath(target);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, target);
};

// ---- Database backend ----------------------------------------------------
const UPSERT = `INSERT INTO app.documents (name, body, updated_at) VALUES ($1, $2::jsonb, now())
                ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body, updated_at = now(),
                                                 version = app.documents.version + 1`;

function queueDbWrite(name, text) {
    let w = writers.get(name);
    if (!w) { w = { text: null, waiters: [], timer: null, running: false, lastAt: 0 }; writers.set(name, w); }
    w.text = text;
    const done = new Promise((resolve, reject) => w.waiters.push({ resolve, reject }));
    scheduleWrite(name, w);
    return done;
}

function scheduleWrite(name, w) {
    if (w.running || w.timer || w.text === null) return;
    const gap = w.text.length > LARGE_DOC_CHARS ? LARGE_DOC_INTERVAL_MS : WRITE_MIN_INTERVAL_MS;
    const wait = Math.max(0, w.lastAt + gap - Date.now());
    w.timer = setTimeout(() => { w.timer = null; runWrite(name, w); }, wait);
}

async function runWrite(name, w) {
    if (w.text === null) return;
    const text = w.text;
    const waiters = w.waiters;
    w.text = null;
    w.waiters = [];
    w.running = true;
    try {
        await pool.query(UPSERT, [name, text]);
        waiters.forEach((x) => x.resolve());
    } catch (err) {
        // Memory already holds the value: keep it queued and retry, so a brief
        // database outage never loses a record. Callers still see the error.
        if (w.text === null) w.text = text;
        waiters.forEach((x) => x.reject(err));
        if (Date.now() - lastErrorLogAt > 60000) {
            lastErrorLogAt = Date.now();
            console.error(`Record write to database failed (${name}); retrying: ${err.message}`);
        }
    } finally {
        w.lastAt = Date.now();
        w.running = false;
        scheduleWrite(name, w);
    }
}

/** Write every pending document now (shutdown). */
async function flush() {
    if (backend !== 'db') return;
    const runs = [];
    for (const [name, w] of writers) {
        if (w.timer) { clearTimeout(w.timer); w.timer = null; }
        if (w.text !== null && !w.running) runs.push(runWrite(name, w));
    }
    await Promise.allSettled(runs);
}

const listJsonFiles = () => {
    try {
        return fs.readdirSync(DATA_DIR, { withFileTypes: true })
            .filter((d) => d.isFile() && /^[^.].*\.json$/.test(d.name))
            .map((d) => d.name);
    } catch { return []; }
};

/**
 * Switch to the database backend: load every document, import JSON files left
 * by the file-based edition (moved to DATA_DIR/imported-to-database-<stamp>/
 * afterwards), and refresh the mirrored files.
 */
async function init(pgPool) {
    pool = pgPool;
    const { rows } = await pool.query('SELECT name, body::text AS body FROM app.documents');
    docs.clear();
    for (const r of rows) docs.set(r.name, r.body);

    const imported = [];
    for (const name of listJsonFiles()) {
        if (docs.has(name)) continue;
        let text;
        try { text = JSON.stringify(parseJson(fs.readFileSync(full(name), 'utf8'))); } catch (e) {
            console.error(`Not importing ${name} into the database: ${e.message}`);
            continue;
        }
        await pool.query('INSERT INTO app.documents (name, body) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING', [name, text]);
        docs.set(name, text);
        imported.push(name);
    }
    const moved = imported.filter((n) => !MIRRORED.has(n));
    if (moved.length) {
        const dir = full(`imported-to-database-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        fs.mkdirSync(dir, { recursive: true });
        for (const name of moved) fs.renameSync(full(name), path.join(dir, name));
    }
    for (const name of MIRRORED) {
        if (docs.has(name)) writeFileSyncAtomic(full(name), JSON.stringify(JSON.parse(docs.get(name)), null, 2));
    }
    backend = 'db';
    return { documents: docs.size, imported };
}

// ---- Public API (same calls for both backends) ---------------------------
const readJson = (file, fallback) => {
    try {
        if (backend === 'db') return docs.has(file) ? JSON.parse(docs.get(file)) : fallback;
        return parseJson(fs.readFileSync(full(file), 'utf8'));
    } catch { return fallback; }
};

const exists = (file) => (backend === 'db' ? docs.has(file) : fs.existsSync(full(file)));

const writeJson = (file, obj) => {
    if (backend !== 'db') return writeJsonFile(full(file), obj);
    const text = JSON.stringify(obj);
    if (text === undefined) return Promise.reject(new Error(`cannot store ${file}: not JSON`));
    docs.set(file, text);
    const done = queueDbWrite(file, text);
    if (MIRRORED.has(file)) {
        return Promise.all([done, writeJsonFile(full(file), obj)]).then(() => undefined);
    }
    return done;
};

const writeJsonSync = (file, obj) => {
    if (backend !== 'db') return writeFileSyncAtomic(full(file), JSON.stringify(obj, null, 2));
    writeJson(file, obj).catch(() => { /* logged by the writer; retried */ });
    return undefined;
};

const backendName = () => backend;

// Resolve a dotted path like "drawworks.hook_load" against the rig-data object.
const resolvePath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

module.exports = {
    DATA_DIR, full, init, flush, backendName, exists, parseJson,
    readJson, writeJson, writeJsonSync, writeJsonFile, resolvePath,
};
