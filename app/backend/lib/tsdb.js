'use strict';
// TimescaleDB access for the backend (database ahwr_edge, CMF canonical schema).
//
// Connection settings come from the standard libpq environment variables:
//   PGHOST (127.0.0.1), PGPORT (5432), PGDATABASE (ahwr_edge), PGUSER (ahwr_app), PGPASSWORD
// Schema: app/sql/02-schema.sql. The backend never creates or alters tables.
const { Pool } = require('pg');
const ids = require('./ids');

const pool = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'ahwr_edge',
    user: process.env.PGUSER || 'ahwr_app',
    password: process.env.PGPASSWORD,
    max: Number(process.env.PG_POOL_MAX || 8),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 5000),
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 30000),
    application_name: 'ahwr-backend',
});
// An idle client losing its connection (database restart) must not crash the process.
pool.on('error', (err) => console.error('TimescaleDB pool error:', err.message));

const query = (text, params) => pool.query(text, params);

// ---- Time inputs ---------------------------------------------------------
// The API accepts the same time syntax as before (Flux style): relative
// durations like -30s, -7d, -6mo; RFC3339 instants; now(). Values are always
// passed as bind parameters, never interpolated.
const DURATION_RE = /^(-?)(\d+)(ns|us|ms|s|m|h|d|w|mo|y)$/;
const UNIT = { us: 'microseconds', ms: 'milliseconds', s: 'seconds', m: 'minutes', h: 'hours', d: 'days', w: 'weeks', mo: 'months', y: 'years' };

/** "-30s" -> "-30 seconds"; "5m" -> "5 minutes". Nanoseconds round to microseconds. */
function durationToInterval(spec) {
    const m = DURATION_RE.exec(String(spec || ''));
    if (!m) return null;
    let [, sign, n, unit] = m;
    if (unit === 'ns') { n = String(Math.round(Number(n) / 1000)); unit = 'us'; }
    return `${sign}${n} ${UNIT[unit]}`;
}

/**
 * SQL for a time bound, appending its bind value to params.
 * @returns {string} e.g. "now() + $3::interval" or "$3::timestamptz" or "now()"
 */
function timeBound(spec, params) {
    if (spec === undefined || spec === null || spec === '' || spec === 'now()') return 'now()';
    const interval = durationToInterval(spec);
    if (interval) { params.push(interval); return `(now() + $${params.length}::interval)`; }
    params.push(String(spec));
    return `$${params.length}::timestamptz`;
}

// ---- Startup ---------------------------------------------------------------
// 3: Energistics identity (uuid columns, wellbores, channels).
const REQUIRED_SCHEMA = 3;
let schemaOk = false;
async function checkSchema() {
    try {
        const { rows } = await query('SELECT max(version) AS v FROM edge_schema');
        schemaOk = Number(rows[0] && rows[0].v) >= REQUIRED_SCHEMA;
        if (!schemaOk) console.error(`TimescaleDB: schema version ${rows[0] && rows[0].v} is older than ${REQUIRED_SCHEMA} — apply app/sql/02-schema.sql.`);
    } catch (e) {
        schemaOk = false;
        console.error(`TimescaleDB: schema check failed (${e.message}). Apply app/sql/01-roles.sql and 02-schema.sql, and check PG* settings.`);
    }
    return schemaOk;
}

// The edge's own row in rigs (wells.current_rig_id and well_runs.rig_id refer to it).
const knownRigs = new Set();
async function ensureRig(rigId) {
    if (!rigId || knownRigs.has(rigId)) return;
    await query(
        `INSERT INTO rigs (rig_id, name, status, schema_version, uuid)
         VALUES ($1, $1, 'online', 'edge', $2)
         ON CONFLICT (rig_id) DO UPDATE SET updated_at = now(), uuid = EXCLUDED.uuid`, [rigId, ids.rig(rigId)]);
    knownRigs.add(rigId);
}

/** Upsert the tag dictionary (metric -> label/unit/group). Rows: [{metric,label,unit,group}] */
async function upsertTags(rows) {
    if (!rows.length) return 0;
    await query(
        `INSERT INTO tags (metric, label, unit, group_name)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
         ON CONFLICT (metric) DO UPDATE
           SET label = EXCLUDED.label, unit = EXCLUDED.unit, group_name = EXCLUDED.group_name`,
        [rows.map((r) => r.metric), rows.map((r) => r.label || null), rows.map((r) => r.unit || null), rows.map((r) => r.group || null)]);
    return rows.length;
}

/** Upsert the channel dictionary of one rig (lib/channels.js entries). */
async function upsertChannels(rigId, entries, { loggingCompany = null } = {}) {
    const list = [...entries];
    if (!list.length) return 0;
    const col = (f) => list.map(f);
    await query(
        `INSERT INTO channels (rig_id, metric, uuid, mnemonic, label, group_name, stored_unit, uom, factor,
                               data_kind, property_kind_uuid, property_kind, unit_source, logging_company, updated_at)
         SELECT $1, u.*, $14, now() FROM unnest($2::text[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[],
                                     $8::text[], $9::float8[], $10::text[], $11::uuid[], $12::text[], $13::text[])
           AS u(metric, uuid, mnemonic, label, group_name, stored_unit, uom, factor, data_kind,
                property_kind_uuid, property_kind, unit_source)
         ON CONFLICT (rig_id, metric) DO UPDATE
           SET uuid = EXCLUDED.uuid, mnemonic = EXCLUDED.mnemonic, label = EXCLUDED.label,
               group_name = EXCLUDED.group_name, stored_unit = EXCLUDED.stored_unit, uom = EXCLUDED.uom,
               factor = EXCLUDED.factor, data_kind = EXCLUDED.data_kind,
               property_kind_uuid = EXCLUDED.property_kind_uuid, property_kind = EXCLUDED.property_kind,
               unit_source = EXCLUDED.unit_source, logging_company = EXCLUDED.logging_company, updated_at = now()
         WHERE (channels.uuid, channels.mnemonic, channels.uom, channels.factor, channels.property_kind_uuid,
                channels.label, channels.stored_unit, channels.unit_source, channels.logging_company)
               IS DISTINCT FROM
               (EXCLUDED.uuid, EXCLUDED.mnemonic, EXCLUDED.uom, EXCLUDED.factor, EXCLUDED.property_kind_uuid,
                EXCLUDED.label, EXCLUDED.stored_unit, EXCLUDED.unit_source, EXCLUDED.logging_company)`,
        [rigId, col((e) => e.metric), col((e) => e.uuid), col((e) => e.mnemonic), col((e) => e.label),
            col((e) => e.group), col((e) => e.storedUnit), col((e) => e.uom), col((e) => e.factor),
            col((e) => e.dataKind), col((e) => e.propertyKind.uuid), col((e) => e.propertyKind.title),
            col((e) => e.unitSource), loggingCompany]);
    return list.length;
}

/** Insert telemetry rows: [{ ts, metric, value }] for one rig. */
async function insertTelemetry(rigId, rows) {
    if (!rows.length) return 0;
    await query(
        `INSERT INTO telemetry (ts, rig_id, metric, value)
         SELECT u.ts, $2, u.metric, u.value
         FROM unnest($1::timestamptz[], $3::text[], $4::float8[]) AS u(ts, metric, value)`,
        [rows.map((r) => r.ts), rigId, rows.map((r) => r.metric), rows.map((r) => r.value)]);
    return rows.length;
}

/** Insert an event (same shape the CMF stores). Idempotent on replays. */
async function insertEvent(rigId, ts, type, payload) {
    await query(
        `INSERT INTO events (ts, rig_id, type, payload) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [ts, rigId, type, payload || {}]);
    if (type === 'connection') {
        const p = payload || {};
        await query(
            `INSERT INTO connections (ts, rig_id, peak_torque, result, joint, payload)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT DO NOTHING`,
            [ts, rigId, p.peakTorque ?? p.peak_torque ?? null, p.result || null, p.joint ?? p.jointCount ?? null, p]);
    }
}

const close = () => pool.end();

module.exports = {
    pool, query, durationToInterval, timeBound,
    checkSchema, isSchemaOk: () => schemaOk,
    ensureRig, upsertTags, upsertChannels, insertTelemetry, insertEvent, close, REQUIRED_SCHEMA,
};
