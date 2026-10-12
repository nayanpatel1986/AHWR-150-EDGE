#!/usr/bin/env node
'use strict';
// InfluxDB 2.x -> TimescaleDB (CMF canonical schema) history migration.
//
// Runs once per rig, after the TimescaleDB edition is installed. It can run
// while the new stack is live: it only migrates time BEFORE the first sample
// already in TimescaleDB for this rig, so it never touches live data.
//
//   Phase raw     raw bucket points within --raw-days -> telemetry (full rate),
//                 mapped exactly like Telegraf maps live PLC data
//   Phase rollup  raw bucket points older than that -> telemetry_1m_legacy
//                 (1-minute mean/min/max computed inside InfluxDB)
//   Phase wells   per-well archive buckets (well_*) for periods older than the
//                 raw bucket -> telemetry_1m_legacy
//   Phase imports import_* buckets -> telemetry_import
//
// Resumable: progress is kept in edge_migration_progress; re-running continues
// where it stopped. Every phase is idempotent.
//
// Environment:
//   INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET   the old historian
//   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD         TimescaleDB, as postgres
//                                                         (needs refresh_continuous_aggregate)
//   DEVICE_ID      the rig id used in TimescaleDB (same as the backend)
//   DATA_DIR       folder with plc_config.json (for the tag mapping)
//
// Options: --raw-days N (default 90)  --slice-hours N (default 1)  --dry-run
//          --skip raw,rollup,wells,imports
const fs = require('fs');
const path = require('path');
const { InfluxDB } = require('@influxdata/influxdb-client');
const { Pool } = require('pg');
const { buildMapping, mapPoint } = require('../lib/telemetryMap');

const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
};
const RAW_DAYS = Number(arg('raw-days', 90));
const SLICE_MS = Number(arg('slice-hours', 1)) * 3600000;
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP = new Set(String(arg('skip', '')).split(',').filter(Boolean));
const BATCH = 20000;

const need = (name) => {
    if (!process.env[name]) { console.error(`Missing ${name}`); process.exit(2); }
    return process.env[name];
};
const INFLUX_URL = process.env.INFLUX_URL || 'http://127.0.0.1:8086';
const INFLUX_TOKEN = need('INFLUX_TOKEN');
const INFLUX_ORG = process.env.INFLUX_ORG || 'romii_org';
const RAW_BUCKET = process.env.INFLUX_BUCKET || 'romii_bucket';
const RIG_ID = need('DEVICE_ID');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');

const plcConfig = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'plc_config.json'), 'utf8').replace(/^\uFEFF/, ''));
const mapping = buildMapping(plcConfig);
const influx = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN, timeout: 600000 });
const queryApi = influx.getQueryApi(INFLUX_ORG);
const pg = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'ahwr_edge',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    max: 2,
});

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);
const fluxStr = (s) => JSON.stringify(String(s));
const isoOf = (ms) => new Date(ms).toISOString();

async function progress(source) {
    const { rows } = await pg.query('SELECT done_until, rows_copied FROM edge_migration_progress WHERE source = $1', [source]);
    return rows[0] ? { doneUntil: rows[0].done_until ? rows[0].done_until.getTime() : null, rows: Number(rows[0].rows_copied) } : { doneUntil: null, rows: 0 };
}
async function saveProgress(source, doneUntilMs, rows) {
    if (DRY_RUN) return;
    await pg.query(
        `INSERT INTO edge_migration_progress (source, done_until, rows_copied, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (source) DO UPDATE SET done_until = EXCLUDED.done_until, rows_copied = EXCLUDED.rows_copied, updated_at = now()`,
        [source, doneUntilMs == null ? null : isoOf(doneUntilMs), rows]);
}

// Extent of a bucket: [first, last] point time in ms (null when empty).
async function bucketExtent(bucket) {
    const out = { first: null, last: null };
    for (const fn of ['first', 'last']) {
        const flux = `from(bucket: ${fluxStr(bucket)}) |> range(start: 0) |> filter(fn: (r) => r._measurement !~ /^internal/)
            |> ${fn}() |> keep(columns: ["_time"]) |> group() |> ${fn === 'first' ? 'min' : 'max'}(column: "_time")`;
        for await (const { values, tableMeta } of queryApi.iterateRows(flux)) {
            const t = Date.parse(tableMeta.toObject(values)._time);
            if (Number.isFinite(t)) out[fn] = t;
        }
    }
    return out;
}

async function insertTelemetry(client, rows) {
    if (!rows.length || DRY_RUN) return;
    await client.query(
        `INSERT INTO telemetry (ts, rig_id, metric, value)
         SELECT u.ts, $2, u.metric, u.value FROM unnest($1::timestamptz[], $3::text[], $4::float8[]) AS u(ts, metric, value)`,
        [rows.map((r) => r.ts), RIG_ID, rows.map((r) => r.metric), rows.map((r) => r.value)]);
}

async function insertLegacy(rows, source) {
    if (!rows.length || DRY_RUN) return;
    await pg.query(
        `INSERT INTO telemetry_1m_legacy (bucket, rig_id, metric, avg, min, max, source)
         SELECT u.b, $2, u.metric, u.avg, u.min, u.max, $3
         FROM unnest($1::timestamptz[], $4::text[], $5::float8[], $6::float8[], $7::float8[]) AS u(b, metric, avg, min, max)
         ON CONFLICT (rig_id, metric, bucket) DO NOTHING`,
        [rows.map((r) => r.bucket), RIG_ID, source, rows.map((r) => r.metric), rows.map((r) => r.avg), rows.map((r) => r.min), rows.map((r) => r.max)]);
}

// Phase raw: full-rate points -> telemetry, one slice per transaction.
async function migrateRaw(fromMs, toMs) {
    const source = `influx:${RAW_BUCKET}:raw`;
    const p = await progress(source);
    let t = Math.max(fromMs, p.doneUntil || fromMs);
    let total = p.rows;
    log(`raw: ${isoOf(t)} .. ${isoOf(toMs)} (resume from ${p.doneUntil ? isoOf(p.doneUntil) : 'start'})`);
    while (t < toMs) {
        const end = Math.min(toMs, t + SLICE_MS);
        const client = await pg.connect();
        let n = 0;
        try {
            await client.query('BEGIN');
            // A crash mid-slice left nothing committed, but be explicit anyway.
            if (!DRY_RUN) await client.query('DELETE FROM telemetry WHERE rig_id = $1 AND ts >= $2 AND ts < $3', [RIG_ID, isoOf(t), isoOf(end)]);
            const flux = `from(bucket: ${fluxStr(RAW_BUCKET)})
                |> range(start: ${isoOf(t)}, stop: ${isoOf(end)})
                |> filter(fn: (r) => r._measurement !~ /^internal/)`;
            let buf = [];
            for await (const { values, tableMeta } of queryApi.iterateRows(flux)) {
                const o = tableMeta.toObject(values);
                const m = mapPoint(mapping, o._measurement, o._field, o._value);
                if (!m) continue;
                buf.push({ ts: o._time, metric: m.metric, value: m.value });
                if (buf.length >= BATCH) { await insertTelemetry(client, buf); n += buf.length; buf = []; }
            }
            await insertTelemetry(client, buf); n += buf.length;
            await client.query(DRY_RUN ? 'ROLLBACK' : 'COMMIT');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            throw e;
        } finally {
            client.release();
        }
        total += n;
        await saveProgress(source, end, total);
        log(`raw: ${isoOf(t)} .. ${isoOf(end)}  ${n} rows  (total ${total})`);
        // Materialise the 1-minute rollup for this slice before raw retention can drop it.
        if (!DRY_RUN && n) await pg.query(`CALL refresh_continuous_aggregate('telemetry_1m', $1::timestamptz, $2::timestamptz)`, [isoOf(t), isoOf(end)]);
        t = end;
    }
    return total;
}

// Phase rollup: older raw points -> 1-minute mean/min/max (computed by InfluxDB).
async function migrateRollup(fromMs, toMs) {
    const source = `influx:${RAW_BUCKET}:rollup`;
    const p = await progress(source);
    let t = Math.max(fromMs, p.doneUntil || fromMs);
    let total = p.rows;
    log(`rollup: ${isoOf(t)} .. ${isoOf(toMs)}`);
    while (t < toMs) {
        const end = Math.min(toMs, t + 86400000);
        const acc = new Map(); // `${bucket}|${metric}` -> row
        for (const fn of ['mean', 'min', 'max']) {
            const flux = `import "types"
                from(bucket: ${fluxStr(RAW_BUCKET)})
                |> range(start: ${isoOf(t)}, stop: ${isoOf(end)})
                |> filter(fn: (r) => r._measurement !~ /^internal/ and not types.isType(v: r._value, type: "string"))
                |> toFloat()
                |> aggregateWindow(every: 1m, fn: ${fn}, createEmpty: false, timeSrc: "_start")`;
            for await (const { values, tableMeta } of queryApi.iterateRows(flux)) {
                const o = tableMeta.toObject(values);
                const m = mapPoint(mapping, o._measurement, o._field, o._value);
                if (!m) continue;
                const key = `${o._time}|${m.metric}`;
                if (!acc.has(key)) acc.set(key, { bucket: o._time, metric: m.metric, avg: null, min: null, max: null });
                acc.get(key)[fn === 'mean' ? 'avg' : fn] = m.value;
            }
        }
        const rows = [...acc.values()];
        for (let i = 0; i < rows.length; i += BATCH) await insertLegacy(rows.slice(i, i + BATCH), `influx:${RAW_BUCKET}`);
        total += rows.length;
        await saveProgress(source, end, total);
        log(`rollup: ${isoOf(t)} .. ${isoOf(end)}  ${rows.length} minute-rows`);
        t = end;
    }
    return total;
}

// Phase wells: per-well 1-minute archive buckets, only periods before the raw bucket.
async function migrateWellBuckets(beforeMs) {
    const buckets = await listBuckets('well_');
    let total = 0;
    for (const bucket of buckets) {
        const source = `influx:${bucket}`;
        if ((await progress(source)).doneUntil) { log(`wells: ${bucket} already migrated`); continue; }
        const flux = `from(bucket: ${fluxStr(bucket)}) |> range(start: 0, stop: ${isoOf(beforeMs)})`;
        const acc = new Map();
        for await (const { values, tableMeta } of queryApi.iterateRows(flux)) {
            const o = tableMeta.toObject(values);
            const suffix = /_(min|max)$/.exec(o._field);
            const field = suffix ? o._field.slice(0, -suffix[0].length) : o._field;
            const m = mapPoint(mapping, o._measurement, field, o._value);
            if (!m) continue;
            // InfluxDB stamped each minute at its end; the rollup stamps the start.
            const b = new Date(Date.parse(o._time) - 60000).toISOString();
            const key = `${b}|${m.metric}`;
            if (!acc.has(key)) acc.set(key, { bucket: b, metric: m.metric, avg: null, min: null, max: null });
            acc.get(key)[suffix ? suffix[1] : 'avg'] = m.value;
        }
        const rows = [...acc.values()];
        for (let i = 0; i < rows.length; i += BATCH) await insertLegacy(rows.slice(i, i + BATCH), source);
        total += rows.length;
        await saveProgress(source, beforeMs, rows.length);
        log(`wells: ${bucket}  ${rows.length} minute-rows before ${isoOf(beforeMs)}`);
    }
    return total;
}

// Phase imports: import_* buckets -> telemetry_import.
async function migrateImports() {
    const buckets = await listBuckets('import_');
    let total = 0;
    for (const bucket of buckets) {
        const label = bucket.replace(/^import_/, '').replace(/[^A-Za-z0-9_.\-]/g, '_').slice(0, 48);
        const source = `influx:${bucket}`;
        if ((await progress(source)).doneUntil) { log(`imports: ${bucket} already migrated`); continue; }
        const ts = [], metric = [], value = [];
        let first = null, last = null;
        for await (const { values, tableMeta } of queryApi.iterateRows(`from(bucket: ${fluxStr(bucket)}) |> range(start: 0)`)) {
            const o = tableMeta.toObject(values);
            const n = Number(o._value);
            if (!Number.isFinite(n)) continue;
            ts.push(o._time); metric.push(o._measurement === 'imported' ? `imported.${o._field}` : `${o._measurement}.${o._field}`); value.push(n);
            if (!first || o._time < first) first = o._time;
            if (!last || o._time > last) last = o._time;
        }
        if (!DRY_RUN) {
            const client = await pg.connect();
            try {
                await client.query('BEGIN');
                await client.query('DELETE FROM telemetry_import WHERE import_label = $1', [label]);
                for (let i = 0; i < ts.length; i += BATCH) {
                    await client.query(
                        `INSERT INTO telemetry_import (ts, import_label, rig_id, metric, value)
                         SELECT u.ts, $2, NULL, u.metric, u.value FROM unnest($1::timestamptz[], $3::text[], $4::float8[]) AS u(ts, metric, value)`,
                        [ts.slice(i, i + BATCH), label, metric.slice(i, i + BATCH), value.slice(i, i + BATCH)]);
                }
                await client.query(
                    `INSERT INTO telemetry_imports (import_label, created_at, rows_in, points, first_ts, last_ts)
                     VALUES ($1, now(), NULL, $2, $3, $4)
                     ON CONFLICT (import_label) DO UPDATE SET points = EXCLUDED.points, first_ts = EXCLUDED.first_ts, last_ts = EXCLUDED.last_ts`,
                    [label, ts.length, first, last]);
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                throw e;
            } finally {
                client.release();
            }
        }
        await saveProgress(source, Date.now(), ts.length);
        total += ts.length;
        log(`imports: ${bucket} -> ${label}  ${ts.length} points`);
    }
    return total;
}

async function listBuckets(prefix) {
    const res = await fetch(`${INFLUX_URL}/api/v2/buckets?limit=100`, { headers: { Authorization: `Token ${INFLUX_TOKEN}` } });
    if (!res.ok) throw new Error(`InfluxDB bucket list failed: HTTP ${res.status}`);
    return ((await res.json()).buckets || []).map((b) => b.name).filter((n) => n.startsWith(prefix)).sort();
}

async function main() {
    log(`InfluxDB ${INFLUX_URL} bucket ${RAW_BUCKET} -> TimescaleDB ${pg.options.host}/${pg.options.database} rig ${RIG_ID}${DRY_RUN ? '  (DRY RUN)' : ''}`);
    log(`tag mapping: ${mapping.entries.size} configured PLC tags`);
    await pg.query('SELECT 1 FROM edge_schema LIMIT 1');

    // Never overlap live data: stop at the first sample already in TimescaleDB.
    // The cut-over instant is fixed on the first run, so re-runs are not misled
    // by rows this tool has already migrated.
    const cutover = await progress(`influx:${RAW_BUCKET}:cutover`);
    let liveStart = cutover.doneUntil;
    if (!liveStart) {
        const { rows } = await pg.query('SELECT min(ts) AS t FROM telemetry WHERE rig_id = $1', [RIG_ID]);
        liveStart = rows[0].t ? rows[0].t.getTime() : Date.now();
        await saveProgress(`influx:${RAW_BUCKET}:cutover`, liveStart, 0);
    }
    const extent = await bucketExtent(RAW_BUCKET);
    log(`raw bucket: ${extent.first ? isoOf(extent.first) : 'empty'} .. ${extent.last ? isoOf(extent.last) : 'empty'};  TimescaleDB live data from ${isoOf(liveStart)}`);

    const summary = {};
    if (extent.first) {
        const until = Math.min(liveStart, extent.last + 1);
        const rawFrom = Math.max(extent.first, until - RAW_DAYS * 86400000);
        if (!SKIP.has('rollup') && extent.first < rawFrom) summary.rollupMinuteRows = await migrateRollup(extent.first, rawFrom);
        if (!SKIP.has('raw') && rawFrom < until) summary.rawRows = await migrateRaw(rawFrom, until);
    }
    if (!SKIP.has('wells')) summary.wellMinuteRows = await migrateWellBuckets(extent.first || liveStart);
    if (!SKIP.has('imports')) summary.importPoints = await migrateImports();
    log('done', JSON.stringify(summary));
    log('Start (or restart) the backend so it back-fills well runs from wells.json.');
}

main()
    .catch((e) => { console.error('Migration failed:', e.message); process.exitCode = 1; })
    .finally(() => pg.end());
