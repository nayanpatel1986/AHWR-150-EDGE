'use strict';
// Per-well historian archive.
//
// Two tiers, deliberately separated:
//
//   RAW      — the main bucket. Every tag at full rate, 90-day retention.
//              For troubleshooting and incident review while it is recent.
//
//   PER-WELL — one bucket per well (`well_<NAME>`), 1-minute aggregated,
//              retained indefinitely. This is the well's permanent record:
//              it outlives the 90-day raw window, it is scoped to exactly one
//              job, and it can be handed over, exported or archived on its own
//              without dragging the whole fleet history with it.
//
// The collector (Telegraf) knows nothing about wells — it just writes raw.
// Well-scoping happens here, downstream, so the acquisition layer never has to
// be reconfigured when the rig moves to the next well.
//
// Each 1-minute window stores mean/min/max per field, so the archive keeps the
// shape of the data (peaks included), not just a sampled point.
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const { readJson, writeJson } = require('./persist');

const INFLUX_URL = process.env.INFLUX_URL || 'http://influxdb:8086';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN;
const INFLUX_ORG = process.env.INFLUX_ORG || 'romii_org';
const RAW_BUCKET = process.env.INFLUX_BUCKET || 'romii_bucket';
// 0s = keep forever. The well record should outlive the raw window.
const ARCHIVE_RETENTION_SECONDS = Number(process.env.WELL_ARCHIVE_RETENTION_SECONDS || 0);
const WINDOW = '1m';
const STATE_FILE = 'well_archive_state.json';
// Don't aggregate the most recent minute — it is still filling.
const LAG_MS = 90 * 1000;
// Cap how much we backfill in one pass so a long gap can't produce a huge query.
const MAX_CATCHUP_MS = 6 * 60 * 60 * 1000;

const influx = INFLUX_TOKEN ? new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN }) : null;
const queryApi = influx ? influx.getQueryApi(INFLUX_ORG) : null;

let state = readJson(STATE_FILE, null);
if (!state || typeof state !== 'object') state = { watermarks: {}, buckets: {} };
const saveState = () => writeJson(STATE_FILE, state).catch(() => {});

// InfluxDB bucket names: keep them predictable and safe.
const bucketNameFor = (wellName) => {
    const clean = String(wellName || '').replace(/[^A-Za-z0-9_.\-]/g, '_').replace(/_+/g, '_').slice(0, 48);
    return `well_${clean || 'UNNAMED'}`;
};

async function api(path, options = {}) {
    if (!INFLUX_TOKEN) throw new Error('INFLUX_TOKEN not configured');
    const res = await fetch(`${INFLUX_URL}${path}`, {
        ...options,
        headers: {
            Authorization: `Token ${INFLUX_TOKEN}`,
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Influx API ${options.method || 'GET'} ${path} -> ${res.status} ${body.slice(0, 200)}`);
    }
    return res.status === 204 ? null : res.json();
}

let _orgId = null;
async function orgId() {
    if (_orgId) return _orgId;
    const r = await api(`/api/v2/orgs?org=${encodeURIComponent(INFLUX_ORG)}`);
    _orgId = r && r.orgs && r.orgs[0] && r.orgs[0].id;
    if (!_orgId) throw new Error(`Influx org "${INFLUX_ORG}" not found`);
    return _orgId;
}

async function findBucket(name) {
    const r = await api(`/api/v2/buckets?name=${encodeURIComponent(name)}`);
    return (r && r.buckets && r.buckets[0]) || null;
}

/** Create (idempotently) the archive bucket for a well. */
async function ensureWellBucket(wellName) {
    const name = bucketNameFor(wellName);
    const existing = await findBucket(name);
    if (existing) {
        state.buckets[wellName] = name;
        saveState();
        return { bucket: name, created: false };
    }
    await api('/api/v2/buckets', {
        method: 'POST',
        body: JSON.stringify({
            orgID: await orgId(),
            name,
            description: `1-minute archive for well ${wellName} (raw stays in ${RAW_BUCKET})`,
            retentionRules: ARCHIVE_RETENTION_SECONDS > 0
                ? [{ type: 'expire', everySeconds: ARCHIVE_RETENTION_SECONDS }]
                : [],   // empty = infinite
        }),
    });
    state.buckets[wellName] = name;
    saveState();
    console.log(`Well archive bucket created: ${name} (1-minute, ${ARCHIVE_RETENTION_SECONDS ? ARCHIVE_RETENTION_SECONDS + 's' : 'infinite'} retention)`);
    return { bucket: name, created: true };
}

// Roll up [from, to) from the raw bucket into { key -> point } at 1-minute
// resolution, keeping mean/min/max so peaks survive the downsample.
async function rollup(fromIso, toIso) {
    const rows = new Map();   // `${time}|${meas}` -> Point fields
    const run = (fn, suffix) => new Promise((resolve, reject) => {
        const flux = `
            import "types"
            from(bucket: "${RAW_BUCKET}")
              |> range(start: ${fromIso}, stop: ${toIso})
              |> filter(fn: (r) => types.isType(v: r._value, type: "float") or types.isType(v: r._value, type: "int") or types.isType(v: r._value, type: "uint"))
              |> aggregateWindow(every: ${WINDOW}, fn: ${fn}, createEmpty: false)
              |> yield(name: "${fn}")`;
        queryApi.queryRows(flux, {
            next(row, meta) {
                const o = meta.toObject(row);
                if (!Number.isFinite(Number(o._value))) return;
                const key = `${o._time}|${o._measurement}`;
                if (!rows.has(key)) rows.set(key, { time: o._time, measurement: o._measurement, fields: {} });
                rows.get(key).fields[`${o._field}${suffix}`] = Number(o._value);
            },
            error: reject,
            complete: resolve,
        });
    });
    // mean is the representative value; min/max preserve the envelope.
    await run('mean', '');
    await Promise.all([run('min', '_min'), run('max', '_max')]);
    return [...rows.values()];
}

/**
 * Archive one slice for the active well. Safe to call on a timer; it advances a
 * persisted watermark so a restart never double-writes or skips.
 * @param {{name:string, startedAt:string}|null} activeWell
 */
async function archiveTick(activeWell) {
    if (!queryApi || !activeWell || !activeWell.name) return { skipped: true };
    const wellName = activeWell.name;
    const bucket = state.buckets[wellName] || (await ensureWellBucket(wellName)).bucket;

    const now = Date.now() - LAG_MS;
    const startedMs = Date.parse(activeWell.startedAt) || now;
    let fromMs = state.watermarks[wellName] || startedMs;
    if (now - fromMs < 60 * 1000) return { skipped: true, reason: 'nothing new' };
    const toMs = Math.min(now, fromMs + MAX_CATCHUP_MS);

    const points = await rollup(new Date(fromMs).toISOString(), new Date(toMs).toISOString());
    if (points.length) {
        const writeApi = influx.getWriteApi(INFLUX_ORG, bucket, 'ms');
        try {
            for (const p of points) {
                const pt = new Point(p.measurement).timestamp(new Date(p.time)).tag('well', wellName);
                let wrote = false;
                for (const [f, v] of Object.entries(p.fields)) {
                    if (Number.isFinite(v)) { pt.floatField(f, v); wrote = true; }
                }
                if (wrote) writeApi.writePoint(pt);
            }
            await writeApi.close();
        } catch (err) {
            try { await writeApi.close(); } catch { /* ignore */ }
            throw err;
        }
    }
    state.watermarks[wellName] = toMs;
    saveState();
    return { bucket, well: wellName, points: points.length, from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

/** Final catch-up when a well is completed, so its archive is whole. */
async function finalize(well) {
    if (!well || !well.name) return null;
    let last = null;
    // Drain any remaining backlog in bounded passes.
    for (let i = 0; i < 12; i++) {
        const r = await archiveTick({ name: well.name, startedAt: well.startedAt });
        if (r.skipped) break;
        last = r;
    }
    return last;
}

/**
 * Consumption/utilisation totals for a well window, read from the historian.
 *
 * Diesel and engine hours come from the CAT totalisers (cumulative counters), so
 * the well's usage is last − first over the window — the honest way to do it. A
 * totaliser reset (replacement/rollover) would give a negative delta, which we
 * report as null rather than a fabricated number.
 */
async function getWellConsumption(startIso, endIso) {
    if (!queryApi || !startIso) return null;
    const stop = endIso || new Date().toISOString();
    const spanHrs = (Date.parse(stop) - Date.parse(startIso)) / 3600000;

    // first/last of each cumulative counter, plus a mean for load.
    const flux = `
        import "types"
        base = from(bucket: "${RAW_BUCKET}")
          |> range(start: ${startIso}, stop: ${stop})
          |> filter(fn: (r) => r._measurement == "cat_engine")
          |> filter(fn: (r) => r._field == "total_fuel" or r._field == "run_hours" or r._field == "fuel_rate" or r._field == "load")
          |> filter(fn: (r) => types.isType(v: r._value, type: "float") or types.isType(v: r._value, type: "int"))
        base |> first() |> yield(name: "first")
        base |> last()  |> yield(name: "last")
        base |> mean()  |> yield(name: "mean")`;

    const got = { first: {}, last: {}, mean: {} };
    await new Promise((resolve, reject) => {
        queryApi.queryRows(flux, {
            next(row, meta) {
                const o = meta.toObject(row);
                const kind = o.result || o._result;
                if (got[kind] && Number.isFinite(Number(o._value))) got[kind][o._field] = Number(o._value);
            },
            error: reject,
            complete: resolve,
        });
    });

    const delta = (f) => {
        const a = got.first[f], b = got.last[f];
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        const d = b - a;
        return d >= 0 ? Number(d.toFixed(2)) : null;   // negative => counter reset, don't invent
    };

    const dieselL = delta('total_fuel');
    const engineHrs = delta('run_hours');
    return {
        dieselLitres: dieselL,
        // Fall back to integrating the rate only if the totaliser is unusable.
        dieselLitresEstimated: dieselL == null && Number.isFinite(got.mean.fuel_rate) && spanHrs > 0
            ? Number((got.mean.fuel_rate * spanHrs).toFixed(2)) : null,
        engineRunHours: engineHrs,
        avgEngineLoadPct: Number.isFinite(got.mean.load) ? Number(got.mean.load.toFixed(1)) : null,
        dieselPerHour: dieselL != null && spanHrs > 0 ? Number((dieselL / spanHrs).toFixed(2)) : null,
        source: dieselL != null ? 'totaliser' : (got.mean.fuel_rate != null ? 'rate-integrated' : 'unavailable'),
    };
}

// ---------------------------------------------------------------------------
// Export / import
//
// Export produces a WIDE table — `time` plus one `measurement.field` column per
// signal — which is what an engineer wants in Excel, and which imports cleanly
// back into this app (round-trip safe).
// ---------------------------------------------------------------------------
const MAX_EXPORT_ROWS = Number(process.env.EXPORT_MAX_ROWS || 500000);

/** Query a bucket into wide rows: [{ time, 'meas.field': value, ... }] */
async function queryWide(bucket, { metrics, start, stop, every } = {}) {
    if (!queryApi) throw new Error('historian unavailable');
    const wanted = String(metrics || '').split(',').map((m) => m.trim()).filter(Boolean);
    // Build an explicit selector so a caller can't inject Flux.
    const sel = wanted.length
        ? '|> filter(fn: (r) => ' + wanted.map((m) => {
            const [meas, ...rest] = m.split('.');
            const field = rest.join('.');
            return `(r._measurement == ${JSON.stringify(meas)} and r._field == ${JSON.stringify(field)})`;
        }).join(' or ') + ')'
        : '';
    const agg = every ? `|> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)` : '';
    const flux = `
        import "types"
        from(bucket: ${JSON.stringify(bucket)})
          |> range(start: ${start}, stop: ${stop})
          ${sel}
          |> filter(fn: (r) => types.isType(v: r._value, type: "float") or types.isType(v: r._value, type: "int") or types.isType(v: r._value, type: "uint"))
          ${agg}
          |> yield(name: "out")`;

    const byTime = new Map();
    const columns = new Set();
    let truncated = false;
    await new Promise((resolve, reject) => {
        queryApi.queryRows(flux, {
            next(row, meta) {
                if (byTime.size > MAX_EXPORT_ROWS) { truncated = true; return; }
                const o = meta.toObject(row);
                const col = `${o._measurement}.${o._field}`;
                columns.add(col);
                if (!byTime.has(o._time)) byTime.set(o._time, { time: o._time });
                byTime.get(o._time)[col] = o._value;
            },
            error: reject,
            complete: resolve,
        });
    });
    const rows = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
    return { rows, columns: [...columns].sort(), truncated };
}

const csvEscape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Wide rows -> CSV text (streamed by the caller in chunks). */
function toCsv({ rows, columns }) {
    const head = ['time', ...columns].join(',');
    const body = rows.map((r) => ['time', ...columns].map((c) => csvEscape(r[c])).join(','));
    return [head, ...body].join('\n');
}

/**
 * Export a well.
 * @param tier 'raw'     -> full-rate data from the main bucket, scoped to the well window
 *             'archive' -> the well's permanent 1-minute bucket
 */
async function exportWell(well, { tier = 'archive', metrics, start, stop, every } = {}) {
    if (!well || !well.startedAt) throw Object.assign(new Error('well has no start time'), { status: 400 });
    const from = start || well.startedAt;
    const to = stop || well.completedAt || new Date().toISOString();
    const bucket = tier === 'raw' ? RAW_BUCKET : (state.buckets[well.name] || bucketNameFor(well.name));
    const data = await queryWide(bucket, { metrics, start: from, stop: to, every });
    return { ...data, bucket, tier, well: well.name, from, to };
}

/**
 * Import previously exported history so it can be viewed in the app.
 * Accepts the same WIDE shape produced by exportWell (CSV or JSON rows).
 * Data lands in its own bucket so it can never be confused with live data.
 */
async function importHistory({ label, csv, rows }) {
    const clean = String(label || '').replace(/[^A-Za-z0-9_.\-]/g, '_').replace(/_+/g, '_').slice(0, 48);
    if (!clean) throw Object.assign(new Error('an import label is required'), { status: 400 });
    const bucket = `import_${clean}`;

    let wide = Array.isArray(rows) ? rows : null;
    if (!wide && typeof csv === 'string') {
        const lines = csv.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length < 2) throw Object.assign(new Error('CSV has no data rows'), { status: 400 });
        const head = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
        const ti = head.findIndex((h) => h.toLowerCase() === 'time' || h.toLowerCase() === '_time' || h.toLowerCase() === 'timestamp');
        if (ti === -1) throw Object.assign(new Error('CSV needs a "time" column'), { status: 400 });
        wide = lines.slice(1).map((line) => {
            const cells = line.split(',');
            const o = { time: (cells[ti] || '').replace(/^"|"$/g, '') };
            head.forEach((h, i) => { if (i !== ti && cells[i] !== undefined && cells[i] !== '') o[h] = cells[i]; });
            return o;
        });
    }
    if (!Array.isArray(wide) || !wide.length) throw Object.assign(new Error('no rows to import'), { status: 400 });

    // Imported history is a record, not live data — keep it forever.
    const existing = await findBucket(bucket);
    if (!existing) {
        await api('/api/v2/buckets', {
            method: 'POST',
            body: JSON.stringify({
                orgID: await orgId(), name: bucket,
                description: `Imported historical data (${clean})`,
                retentionRules: [],
            }),
        });
    }

    const writeApi = influx.getWriteApi(INFLUX_ORG, bucket, 'ms');
    let written = 0, skipped = 0;
    try {
        for (const r of wide) {
            const ts = new Date(r.time || r._time || r.timestamp);
            if (isNaN(ts.getTime())) { skipped++; continue; }
            // Group this row's columns back into their measurements.
            const byMeas = {};
            for (const [k, v] of Object.entries(r)) {
                if (k === 'time' || k === '_time' || k === 'timestamp' || k === 'name') continue;
                const n = Number(v);
                if (!Number.isFinite(n)) continue;
                const dot = k.indexOf('.');
                const meas = dot > 0 ? k.slice(0, dot) : 'imported';
                const field = dot > 0 ? k.slice(dot + 1) : k;
                (byMeas[meas] = byMeas[meas] || {})[field] = n;
            }
            for (const [meas, fields] of Object.entries(byMeas)) {
                const pt = new Point(meas).timestamp(ts).tag('import', clean);
                let any = false;
                for (const [f, v] of Object.entries(fields)) { pt.floatField(f, v); any = true; }
                if (any) { writeApi.writePoint(pt); written++; }
            }
        }
        await writeApi.close();
    } catch (err) {
        try { await writeApi.close(); } catch { /* ignore */ }
        throw err;
    }
    state.buckets[`import:${clean}`] = bucket;
    saveState();
    return { bucket, label: clean, rows: wide.length, pointsWritten: written, rowsSkipped: skipped };
}

async function listArchives() {
    const r = await api('/api/v2/buckets?limit=100');
    const buckets = (r && r.buckets) || [];
    return buckets
        .filter((b) => b.name.startsWith('well_') || b.name.startsWith('import_'))
        .map((b) => {
            const kind = b.name.startsWith('import_') ? 'import' : 'well';
            const well = kind === 'well'
                ? (Object.keys(state.buckets).find((w) => state.buckets[w] === b.name) || b.name.replace(/^well_/, ''))
                : b.name.replace(/^import_/, '');
            return {
                bucket: b.name,
                kind,
                well,
                retention: (b.retentionRules && b.retentionRules[0] && b.retentionRules[0].everySeconds) || 0,
                createdAt: b.createdAt,
                watermark: state.watermarks[well] ? new Date(state.watermarks[well]).toISOString() : null,
            };
        });
}

/** A bucket may only be read/exported if this app created it. */
async function assertArchiveBucket(bucket) {
    const name = String(bucket || '');
    if (!/^(well|import)_[A-Za-z0-9_.\-]+$/.test(name)) {
        throw Object.assign(new Error('not an archive bucket'), { status: 400 });
    }
    if (!(await findBucket(name))) throw Object.assign(new Error(`bucket ${name} not found`), { status: 404 });
    return name;
}

/**
 * What is in this archive — time extent and available signals, named the same
 * way the data/export endpoints expect them (`measurement.field`).
 */
async function describeArchive(bucket) {
    await assertArchiveBucket(bucket);
    const signals = new Set();
    const extent = {};
    // One row per series; that is bounded (~a few hundred) for these buckets.
    const probe = (fn) => new Promise((resolve, reject) => {
        queryApi.queryRows(
            `from(bucket: ${JSON.stringify(bucket)}) |> range(start: -100y) |> ${fn}()`,
            {
                next(row, meta) {
                    const o = meta.toObject(row);
                    signals.add(`${o._measurement}.${o._field}`);
                    if (fn === 'first') {
                        if (!extent.from || o._time < extent.from) extent.from = o._time;
                    } else if (!extent.to || o._time > extent.to) extent.to = o._time;
                },
                error: reject,
                complete: resolve,
            },
        );
    });
    try { await Promise.all([probe('first'), probe('last')]); } catch { /* empty bucket */ }
    return {
        bucket,
        signals: [...signals].sort(),
        from: extent.from || null,
        to: extent.to || null,
    };
}

const getStatus = () => ({
    rawBucket: RAW_BUCKET,
    window: WINDOW,
    retentionSeconds: ARCHIVE_RETENTION_SECONDS,
    buckets: state.buckets,
    watermarks: Object.fromEntries(Object.entries(state.watermarks).map(([k, v]) => [k, new Date(v).toISOString()])),
});

module.exports = {
    ensureWellBucket, archiveTick, finalize, listArchives, getStatus,
    bucketNameFor, getWellConsumption,
    exportWell, importHistory, queryWide, toCsv, describeArchive, assertArchiveBucket,
    RAW_BUCKET,
};
