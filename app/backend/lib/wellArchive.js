'use strict';
// Per-well history on TimescaleDB (CMF canonical schema).
//
// Two tiers:
//
//   RAW       — telemetry: every metric at full rate, kept for the raw window
//               (90 days by default). For troubleshooting and incident review.
//
//   PER-WELL  — telemetry_1m: the 1-minute rollup (mean/min/max per metric),
//               kept indefinitely. A well's permanent record is the rollup over
//               its run window in well_runs (view well_1m). Nothing is copied:
//               TimescaleDB maintains the rollup, and the run window scopes it.
//               Older history migrated from InfluxDB lives in
//               telemetry_1m_legacy and is read through telemetry_1m_all.
//
// Archive identifiers ("bucket" in the API, kept for the UI):
//   well_<run id>     one well run on this rig
//   import_<label>    history imported from an exported CSV/JSON file
//
// Well runs are written through from the edge well registry (wells.json) to
// the CMF tables wells / well_runs, with well_id = well name as at the CMF.
const tsdb = require('./tsdb');
const ids = require('./ids');
const { isFluxInstant } = require('./validate');

const WINDOW = '1m';
const MAX_EXPORT_ROWS = Number(process.env.EXPORT_MAX_ROWS || 500000);
const EVERY_RE = /^\d{1,6}(s|m|h|d)$/;
const IMPORT_BATCH = 20000;

let getRigId = () => process.env.DEVICE_ID || 'AHWR-50-EDGE';
const configure = (opts = {}) => { if (opts.getRigId) getRigId = opts.getRigId; };

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// start/stop/every reach the database only as bind parameters, but they are
// still restricted to instants, relative durations, now() and plain windows.
function assertQueryWindow({ start, stop, every }) {
    if (!isFluxInstant(start)) throw bad('Invalid start (use an RFC3339 timestamp or a duration like -7d)');
    if (stop !== 'now()' && !isFluxInstant(stop)) throw bad('Invalid stop (use an RFC3339 timestamp, a duration or now())');
    if (every !== undefined && every !== null && every !== '' && !EVERY_RE.test(String(every))) {
        throw bad('Invalid every (use a duration like 30s, 1m, 1h)');
    }
}

const cleanLabel = (label) => String(label || '').replace(/[^A-Za-z0-9_.\-]/g, '_').replace(/_+/g, '_').slice(0, 48);
const iso = (d) => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------------------
// Well registry write-through (wells.json -> wells / well_runs)
// ---------------------------------------------------------------------------
async function upsertWell(well, { current } = {}) {
    const rigId = getRigId();
    await tsdb.ensureRig(rigId);
    await tsdb.query(
        `INSERT INTO wells (well_id, name, uwi, well_type, status, field, operator, notes, current_rig_id, uuid)
         VALUES ($1, $1, $2, 'workover', 'workover', $3, $4, $5, $6, $8)
         ON CONFLICT (well_id) DO UPDATE
           SET uwi = COALESCE(EXCLUDED.uwi, wells.uwi),
               field = COALESCE(EXCLUDED.field, wells.field),
               operator = COALESCE(EXCLUDED.operator, wells.operator),
               notes = COALESCE(EXCLUDED.notes, wells.notes),
               current_rig_id = CASE WHEN $7 THEN $6 ELSE wells.current_rig_id END,
               uuid = EXCLUDED.uuid,
               updated_at = now()`,
        [well.name, well.uwi || null, well.field || null, well.operator || null, well.notes || null,
            current ? rigId : null, !!current, ids.well(well.name)]);
    // One wellbore per well (a workover re-enters the existing hole).
    await tsdb.query(
        `INSERT INTO wellbores (uuid, well_id, name, number) VALUES ($1, $2, $2, '1')
         ON CONFLICT (uuid) DO NOTHING`, [ids.wellbore(well.name), well.name]);
}

/** A well was started on this rig: open its run. */
async function startRun(well) {
    if (!well || !well.startedAt) return null;
    await upsertWell(well, { current: true });
    const { rows } = await tsdb.query(
        `INSERT INTO well_runs (well_id, rig_id, job_no, started_at, ended_at, edge_well_ref, uuid)
         VALUES ($1, $2, $3, $4, NULL, $5, $6)
         ON CONFLICT (edge_well_ref) WHERE edge_well_ref IS NOT NULL
         DO UPDATE SET started_at = EXCLUDED.started_at, ended_at = NULL, well_id = EXCLUDED.well_id, uuid = EXCLUDED.uuid
         RETURNING id`,
        [well.name, getRigId(), well.jobNo || well.name, well.startedAt, well.id,
            ids.rigUtilization(getRigId(), well.name, well.startedAt)]);
    return rows[0] ? rows[0].id : null;
}

/** A well was completed: close its run and release the rig. */
async function endRun(well) {
    if (!well || !well.startedAt) return null;
    const runId = await startRun({ ...well }); // make sure the run exists (idempotent)
    await tsdb.query(
        `UPDATE well_runs SET ended_at = $2, summary = $3 WHERE edge_well_ref = $1`,
        [well.id, well.completedAt || new Date().toISOString(), well.summary ? JSON.stringify(well.summary) : null]);
    await tsdb.query(
        `UPDATE wells SET current_rig_id = NULL, updated_at = now() WHERE well_id = $1 AND current_rig_id = $2`,
        [well.name, getRigId()]);
    return runId;
}

/** Metadata edits (UWI, field, operator) reach the CMF wells row. */
async function updateWellInfo(well) {
    if (!well || !well.startedAt) return;
    await upsertWell(well, { current: well.status === 'active' });
}

/** Back-fill runs for wells started before the database existed (idempotent). */
async function syncRegistry(wellList) {
    let n = 0;
    for (const w of wellList || []) {
        if (!w.startedAt) continue;
        if (w.status === 'complete') await endRun(w); else await startRun(w);
        n++;
    }
    return n;
}

// ---------------------------------------------------------------------------
// Archive catalogue
// ---------------------------------------------------------------------------
async function listArchives() {
    const runs = await tsdb.query(
        `SELECT id, well_id, job_no, started_at, ended_at FROM well_runs
         WHERE rig_id = $1 ORDER BY started_at DESC LIMIT 500`, [getRigId()]);
    const imports = await tsdb.query(
        `SELECT import_label, created_at, last_ts FROM telemetry_imports ORDER BY created_at DESC LIMIT 500`);
    return [
        ...runs.rows.map((r) => ({
            bucket: `well_${r.id}`,
            kind: 'well',
            well: r.well_id,
            job: r.job_no,
            retention: 0,
            createdAt: iso(r.started_at),
            endedAt: iso(r.ended_at),
            watermark: iso(r.ended_at) || new Date().toISOString(),
        })),
        ...imports.rows.map((r) => ({
            bucket: `import_${r.import_label}`,
            kind: 'import',
            well: r.import_label,
            retention: 0,
            createdAt: iso(r.created_at),
            watermark: iso(r.last_ts),
        })),
    ];
}

/** Resolve an archive id to what it covers. Only this rig's runs and known imports. */
async function assertArchiveBucket(bucket) {
    const name = String(bucket || '');
    let m = /^well_(\d{1,18})$/.exec(name);
    if (m) {
        const { rows } = await tsdb.query(
            `SELECT id, well_id, started_at, ended_at FROM well_runs WHERE id = $1 AND rig_id = $2`, [m[1], getRigId()]);
        if (!rows.length) throw bad(`archive ${name} not found`, 404);
        return { kind: 'well', name, runId: rows[0].id, well: rows[0].well_id, from: rows[0].started_at, to: rows[0].ended_at };
    }
    m = /^import_([A-Za-z0-9_.\-]{1,48})$/.exec(name);
    if (m) {
        const { rows } = await tsdb.query(`SELECT import_label FROM telemetry_imports WHERE import_label = $1`, [m[1]]);
        if (!rows.length) throw bad(`archive ${name} not found`, 404);
        return { kind: 'import', name, label: m[1] };
    }
    throw bad('not an archive id');
}

// ---------------------------------------------------------------------------
// Wide queries: [{ time, 'measurement.field': value, ... }]
//
// Data is read in time slices. The UI's archive view collects them (capped);
// exports stream them to the response as they are read, with no row cap.
// ---------------------------------------------------------------------------
const SUFFIX_RE = /_(min|max)$/;
const ROLLUP_SLICE_MS = 7 * 86400000;

// Columns the caller asked for -> base metrics to read from the 1-minute tier.
function splitArchiveMetrics(wanted) {
    const bases = new Set();
    for (const m of wanted) bases.add(SUFFIX_RE.test(m) ? m.replace(SUFFIX_RE, '') : m);
    return [...bases];
}
const wantedList = (metrics) => String(metrics || '').split(',').map((m) => m.trim()).filter(Boolean);

// Pivot one slice's long rows into wide rows (slices never split a timestamp).
function pivotSlice(rows, keep) {
    const byTime = new Map();
    for (const r of rows) {
        let row = byTime.get(r.time);
        if (!row) { row = { time: r.time }; byTime.set(r.time, row); }
        for (const [col, value] of r.cols) {
            if (value === null || value === undefined) continue;
            if (keep && !keep.has(col)) continue;
            row[col] = value;
        }
    }
    return [...byTime.values()];
}

// Resolve the API's start/stop (instants, durations, now()) to ISO instants.
async function resolveWindow(start, stop, clampFrom, clampTo) {
    const params = [];
    const s = tsdb.timeBound(start, params);
    const e = tsdb.timeBound(stop, params);
    const { rows } = await tsdb.query(`SELECT ${s} AS s, ${e} AS e, now() AS n`, params);
    let from = rows[0].s;
    let to = rows[0].e;
    if (clampFrom && from < clampFrom) from = clampFrom;
    const ceiling = clampTo || rows[0].n;
    if (to > ceiling) to = ceiling;
    return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** A readable source: the column list and an async iterator of wide-row slices. */
function rollupSource(rigId, from, to, { metrics, every }) {
    const wanted = wantedList(metrics);
    const keep = wanted.length ? new Set(wanted) : null;
    const bases = wanted.length ? splitArchiveMetrics(wanted) : null;
    const interval = every ? tsdb.durationToInterval(every) : null;
    return {
        async columns() {
            const params = [rigId, from, to];
            let filter = '';
            if (bases) { params.push(bases); filter = `AND metric = ANY($${params.length})`; }
            const { rows } = await tsdb.query(
                `SELECT metric FROM telemetry_1m_all WHERE rig_id = $1 AND bucket >= $2 AND bucket < $3 ${filter}
                 GROUP BY metric ORDER BY metric`, params);
            const cols = rows.flatMap((r) => [r.metric, `${r.metric}_min`, `${r.metric}_max`]);
            return (keep ? cols.filter((c) => keep.has(c)) : cols).sort();
        },
        async *slices() {
            for (let t = Date.parse(from), end = Date.parse(to); t < end; t += ROLLUP_SLICE_MS) {
                const a = new Date(t).toISOString();
                const b = new Date(Math.min(end, t + ROLLUP_SLICE_MS)).toISOString();
                const params = [rigId, a, b];
                let filter = '';
                if (bases) { params.push(bases); filter = `AND metric = ANY($${params.length})`; }
                let sql;
                if (interval) {
                    params.push(interval);
                    sql = `SELECT time_bucket($${params.length}::interval, bucket) AS t, metric,
                                  avg(avg) AS avg, min(min) AS min, max(max) AS max
                           FROM telemetry_1m_all
                           WHERE rig_id = $1 AND bucket >= $2 AND bucket < $3 ${filter}
                           GROUP BY 1, 2 ORDER BY 1`;
                } else {
                    sql = `SELECT bucket AS t, metric, avg, min, max FROM telemetry_1m_all
                           WHERE rig_id = $1 AND bucket >= $2 AND bucket < $3 ${filter} ORDER BY 1`;
                }
                const { rows } = await tsdb.query(sql, params);
                yield pivotSlice(rows.map((r) => ({
                    time: new Date(r.t).toISOString(),
                    cols: [[r.metric, r.avg], [`${r.metric}_min`, r.min], [`${r.metric}_max`, r.max]],
                })), keep);
            }
        },
    };
}

function valueSource(table, keyCol, keyVal, from, to, { metrics, every }) {
    const wanted = wantedList(metrics);
    const interval = every ? tsdb.durationToInterval(every) : null;
    const sliceMs = (interval ? 24 : 1) * 3600000;
    return {
        async columns() {
            if (wanted.length) return [...wanted].sort();
            // Raw telemetry: the rollup holds the same metrics and is far cheaper to scan.
            const { rows } = table === 'telemetry'
                ? await tsdb.query(`SELECT metric FROM telemetry_1m_all WHERE rig_id = $1 AND bucket >= $2 AND bucket < $3 GROUP BY metric ORDER BY metric`,
                    [keyVal, new Date(Math.floor(Date.parse(from) / 60000) * 60000).toISOString(), to])
                : await tsdb.query(`SELECT metric FROM ${table} WHERE ${keyCol} = $1 AND ts >= $2 AND ts < $3 GROUP BY metric ORDER BY metric`, [keyVal, from, to]);
            return rows.map((r) => r.metric);
        },
        async *slices() {
            for (let t = Date.parse(from), end = Date.parse(to); t < end; t += sliceMs) {
                const a = new Date(t).toISOString();
                const b = new Date(Math.min(end, t + sliceMs)).toISOString();
                const params = [keyVal, a, b];
                let filter = '';
                if (wanted.length) { params.push(wanted); filter = `AND metric = ANY($${params.length})`; }
                let sql;
                if (interval) {
                    params.push(interval);
                    sql = `SELECT time_bucket($${params.length}::interval, ts) AS t, metric, avg(value) AS v
                           FROM ${table} WHERE ${keyCol} = $1 AND ts >= $2 AND ts < $3 ${filter}
                           GROUP BY 1, 2 ORDER BY 1`;
                } else {
                    sql = `SELECT ts AS t, metric, value AS v FROM ${table}
                           WHERE ${keyCol} = $1 AND ts >= $2 AND ts < $3 ${filter} ORDER BY 1`;
                }
                const { rows } = await tsdb.query(sql, params);
                yield pivotSlice(rows.map((r) => ({ time: new Date(r.t).toISOString(), cols: [[r.metric, r.v]] })), null);
            }
        },
    };
}

// Collect a source into memory, capped (UI archive view).
async function collect(source) {
    const rows = [];
    const columns = new Set();
    let truncated = false;
    for await (const slice of source.slices()) {
        for (const row of slice) {
            if (rows.length >= MAX_EXPORT_ROWS) { truncated = true; break; }
            rows.push(row);
            for (const k of Object.keys(row)) if (k !== 'time') columns.add(k);
        }
        if (truncated) break;
    }
    return { rows, columns: [...columns].sort(), truncated };
}

async function archiveSource(archive, { metrics, start, stop, every } = {}) {
    assertQueryWindow({ start, stop, every });
    if (archive.kind === 'import') {
        const { from, to } = await resolveWindow(start, stop, null, new Date('9999-01-01'));
        return { source: valueSource('telemetry_import', 'import_label', archive.label, from, to, { metrics, every }), from, to };
    }
    const { from, to } = await resolveWindow(start, stop, archive.from, archive.to);
    return { source: rollupSource(getRigId(), from, to, { metrics, every }), from, to };
}

/** Wide rows for an archive (well run or import), for the UI (capped). */
async function queryWide(archive, opts = {}) {
    const { source } = await archiveSource(archive, opts);
    return collect(source);
}

/** Streamable export of an archive: { columns(), slices(), from, to }. */
async function exportArchive(archive, opts = {}) {
    const { source, from, to } = await archiveSource(archive, opts);
    return { ...source, from, to, bucket: archive.name };
}

/** Raw (full-rate) or 1-minute telemetry for any window, as a readable source. */
async function telemetrySource({ tier = 'raw', start, stop, metrics, every } = {}) {
    assertQueryWindow({ start, stop, every });
    const win = await resolveWindow(start, stop, null, null);
    const source = tier === 'raw'
        ? valueSource('telemetry', 'rig_id', getRigId(), win.from, win.to, { metrics, every })
        : rollupSource(getRigId(), win.from, win.to, { metrics, every });
    return { ...source, from: win.from, to: win.to };
}

/**
 * Streamable export of a well.
 * @param tier 'raw'     -> full-rate telemetry inside the well's window
 *             'archive' -> the well's permanent 1-minute record
 */
async function exportWell(well, { tier = 'archive', metrics, start, stop, every } = {}) {
    if (!well || !well.startedAt) throw bad('well has no start time');
    const from = start || well.startedAt;
    const to = stop || well.completedAt || new Date().toISOString();
    assertQueryWindow({ start: from, stop: to, every });
    const win = await resolveWindow(from, to, null, null);
    const source = tier === 'raw'
        ? valueSource('telemetry', 'rig_id', getRigId(), win.from, win.to, { metrics, every })
        : rollupSource(getRigId(), win.from, win.to, { metrics, every });
    return { ...source, bucket: tier === 'raw' ? 'telemetry' : 'telemetry_1m', tier, well: well.name, from: win.from, to: win.to };
}

/** Signals and time extent of an archive, named as the data/export endpoints expect. */
async function describeArchive(bucket) {
    const archive = await assertArchiveBucket(bucket);
    if (archive.kind === 'import') {
        const { rows } = await tsdb.query(
            `SELECT metric, min(ts) AS f, max(ts) AS l FROM telemetry_import WHERE import_label = $1 GROUP BY metric`,
            [archive.label]);
        return extent(archive.name, rows, false);
    }
    const params = [getRigId(), archive.from];
    params.push(archive.to || new Date());
    const { rows } = await tsdb.query(
        `SELECT metric, min(bucket) AS f, max(bucket) AS l FROM telemetry_1m_all
         WHERE rig_id = $1 AND bucket >= $2 AND bucket < $3 GROUP BY metric`, params);
    return extent(archive.name, rows, true);
}

function extent(bucket, rows, withEnvelope) {
    const signals = [];
    let from = null, to = null;
    for (const r of rows) {
        signals.push(r.metric);
        if (withEnvelope) signals.push(`${r.metric}_min`, `${r.metric}_max`);
        if (!from || r.f < from) from = r.f;
        if (!to || r.l > to) to = r.l;
    }
    return { bucket, signals: signals.sort(), from: iso(from), to: iso(to) };
}

const csvEscape = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Wide rows -> CSV text. */
function toCsv({ rows, columns }) {
    const head = ['time', ...columns].join(',');
    const body = rows.map((r) => ['time', ...columns].map((c) => csvEscape(r[c])).join(','));
    return [head, ...body].join('\n');
}

const csvLine = (row, columns) => ['time', ...columns].map((c) => csvEscape(row[c])).join(',');

/**
 * Stream an export to an HTTP response as CSV or JSON, slice by slice, honouring
 * back-pressure. Memory stays bounded by one slice however long the window is.
 */
async function streamExport(res, exp, format) {
    const columns = await exp.columns();
    const write = (chunk) => (res.write(chunk) ? Promise.resolve() : new Promise((r) => res.once('drain', r)));
    let rows = 0;
    if (format === 'json') {
        const meta = { bucket: exp.bucket, tier: exp.tier, well: exp.well, from: exp.from, to: exp.to, columns, truncated: false };
        await write(`${JSON.stringify(meta).slice(0, -1)},"rows":[`);
        for await (const slice of exp.slices()) {
            for (const row of slice) { await write(`${rows ? ',' : ''}${JSON.stringify(row)}`); rows++; }
        }
        await write(']}');
    } else {
        await write(`${['time', ...columns].join(',')}\n`);
        for await (const slice of exp.slices()) {
            if (!slice.length) continue;
            await write(`${slice.map((row) => csvLine(row, columns)).join('\n')}\n`);
            rows += slice.length;
        }
    }
    res.end();
    return rows;
}

// One CSV line -> cells, honouring "quoted, cells" and "" escapes.
function splitCsvLine(line) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
        } else if (c === '"') q = true;
        else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out;
}

/**
 * Import previously exported history so it can be viewed in the app.
 * Accepts the WIDE shape produced by the exports (CSV text or JSON rows).
 * Re-importing a label replaces it. Never mixed with live telemetry.
 */
async function importHistory({ label, csv, rows }) {
    const clean = cleanLabel(label);
    if (!clean) throw bad('an import label is required');

    let wide = Array.isArray(rows) ? rows : null;
    if (!wide && typeof csv === 'string') {
        const lines = csv.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length < 2) throw bad('CSV has no data rows');
        const head = splitCsvLine(lines[0]).map((h) => h.trim());
        const ti = head.findIndex((h) => ['time', '_time', 'timestamp'].includes(h.toLowerCase()));
        if (ti === -1) throw bad('CSV needs a "time" column');
        wide = lines.slice(1).map((line) => {
            const cells = splitCsvLine(line);
            const o = { time: cells[ti] };
            head.forEach((h, i) => { if (i !== ti && cells[i] !== undefined && cells[i] !== '') o[h] = cells[i]; });
            return o;
        });
    }
    if (!Array.isArray(wide) || !wide.length) throw bad('no rows to import');

    const ts = [], metric = [], value = [];
    let skipped = 0, first = null, last = null;
    for (const r of wide) {
        const t = new Date(r.time || r._time || r.timestamp);
        if (Number.isNaN(t.getTime())) { skipped++; continue; }
        const tIso = t.toISOString();
        let any = false;
        for (const [k, v] of Object.entries(r)) {
            if (k === 'time' || k === '_time' || k === 'timestamp' || k === 'name') continue;
            const n = Number(v);
            if (v === null || v === '' || !Number.isFinite(n)) continue;
            ts.push(tIso); metric.push(k.includes('.') ? k : `imported.${k}`); value.push(n);
            any = true;
        }
        if (any) {
            if (!first || tIso < first) first = tIso;
            if (!last || tIso > last) last = tIso;
        }
    }

    const client = await tsdb.pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM telemetry_import WHERE import_label = $1', [clean]);
        for (let i = 0; i < ts.length; i += IMPORT_BATCH) {
            await client.query(
                `INSERT INTO telemetry_import (ts, import_label, rig_id, metric, value)
                 SELECT u.ts, $2, NULL, u.metric, u.value
                 FROM unnest($1::timestamptz[], $3::text[], $4::float8[]) AS u(ts, metric, value)`,
                [ts.slice(i, i + IMPORT_BATCH), clean, metric.slice(i, i + IMPORT_BATCH), value.slice(i, i + IMPORT_BATCH)]);
        }
        await client.query(
            `INSERT INTO telemetry_imports (import_label, created_at, rows_in, points, first_ts, last_ts)
             VALUES ($1, now(), $2, $3, $4, $5)
             ON CONFLICT (import_label) DO UPDATE SET created_at = now(), rows_in = EXCLUDED.rows_in,
               points = EXCLUDED.points, first_ts = EXCLUDED.first_ts, last_ts = EXCLUDED.last_ts`,
            [clean, wide.length, ts.length, first, last]);
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
    return { bucket: `import_${clean}`, label: clean, rows: wide.length, pointsWritten: ts.length, rowsSkipped: skipped };
}

/**
 * Consumption over a well window from the CAT totalisers (cumulative
 * counters): usage is last - first. A counter reset (negative delta) is
 * reported as null rather than invented. Read from the 1-minute tier so it
 * also works for wells older than the raw window.
 */
async function getWellConsumption(startIso, endIso) {
    if (!startIso) return null;
    const stop = endIso || new Date().toISOString();
    const spanHrs = (Date.parse(stop) - Date.parse(startIso)) / 3600000;
    const { rows } = await tsdb.query(
        `SELECT metric, first(avg, bucket) AS first, last(avg, bucket) AS last, avg(avg) AS mean
         FROM telemetry_1m_all
         WHERE rig_id = $1 AND bucket >= $2 AND bucket < $3
           AND metric = ANY($4)
         GROUP BY metric`,
        [getRigId(), startIso, stop, ['cat_engine.total_fuel', 'cat_engine.run_hours', 'cat_engine.fuel_rate', 'cat_engine.load']]);
    const got = Object.fromEntries(rows.map((r) => [r.metric.split('.')[1], r]));
    const delta = (f) => {
        const r = got[f];
        if (!r || !Number.isFinite(r.first) || !Number.isFinite(r.last)) return null;
        const d = r.last - r.first;
        return d >= 0 ? Number(d.toFixed(2)) : null;
    };
    const meanOf = (f) => (got[f] && Number.isFinite(got[f].mean) ? got[f].mean : null);
    const dieselL = delta('total_fuel');
    const fuelRate = meanOf('fuel_rate');
    const load = meanOf('load');
    return {
        dieselLitres: dieselL,
        dieselLitresEstimated: dieselL == null && fuelRate != null && spanHrs > 0 ? Number((fuelRate * spanHrs).toFixed(2)) : null,
        engineRunHours: delta('run_hours'),
        avgEngineLoadPct: load != null ? Number(load.toFixed(1)) : null,
        dieselPerHour: dieselL != null && spanHrs > 0 ? Number((dieselL / spanHrs).toFixed(2)) : null,
        source: dieselL != null ? 'totaliser' : (fuelRate != null ? 'rate-integrated' : 'unavailable'),
    };
}

const getStatus = () => ({
    rawTable: 'telemetry',
    rollup: 'telemetry_1m',
    window: WINDOW,
    retentionSeconds: 0,
    rigId: getRigId(),
});

module.exports = {
    configure, startRun, endRun, updateWellInfo, syncRegistry,
    listArchives, assertArchiveBucket, describeArchive, queryWide, exportArchive, exportWell, telemetrySource, collect, toCsv, streamExport,
    importHistory, getWellConsumption, getStatus, assertQueryWindow, cleanLabel, splitCsvLine,
};
