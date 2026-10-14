'use strict';
// The edge's Energistics data objects (WITSML 2.1 / eml 2.3), assembled from
// the historian (channels, well_runs, telemetry) and the well registry:
//   Rig, the logging company and well operators (BusinessAssociate), the PWLS
//   property kinds in use, one Channel per recorded metric, and per well run a
//   Well, Wellbore, RigUtilization, Log and ChannelSet.
// listObjects() describes them all (type, uuid, title, last change, XML), for
// the REST export and for the ETP Store push to the CMF.
const tsdb = require('./tsdb');
const ids = require('./ids');
const w21 = require('./witsml21');
const channelLib = require('./channels');

let ctx = {
    getRigId: () => process.env.DEVICE_ID || 'AHWR-50-EDGE',
    getWells: () => [],
    getDictionary: () => new Map(),
    getDepths: () => ({}),
    timeZone: 'Z',
};
const configure = (opts = {}) => { ctx = { ...ctx, ...opts }; };
const rigId = () => ctx.getRigId();
const loggingCompany = () => process.env.WITSML_LOGGING_COMPANY || rigId();
const iso = (t) => (t ? new Date(t).toISOString() : null);
const bad = (msg, status = 404) => Object.assign(new Error(msg), { status });

// ---- Channel data extents -----------------------------------------------------
/**
 * Keep channels.first_ts/last_ts equal to the data in telemetry. The quick pass
 * looks at the last few minutes; the full pass (start-up, daily) re-reads both
 * ends of every channel, which also follows the retention policy.
 */
async function refreshExtents({ full = false } = {}) {
    if (full) {
        const r = await tsdb.query(
            `UPDATE channels c
                SET first_ts = (SELECT ts FROM telemetry t WHERE t.rig_id = c.rig_id AND t.metric = c.metric ORDER BY ts ASC LIMIT 1),
                    last_ts  = (SELECT ts FROM telemetry t WHERE t.rig_id = c.rig_id AND t.metric = c.metric ORDER BY ts DESC LIMIT 1)
              WHERE c.rig_id = $1`, [rigId()]);
        return r.rowCount;
    }
    const r = await tsdb.query(
        `UPDATE channels c SET last_ts = s.last_ts, first_ts = COALESCE(c.first_ts, s.first_ts)
           FROM (SELECT metric, min(ts) AS first_ts, max(ts) AS last_ts FROM telemetry
                  WHERE rig_id = $1 AND ts > now() - interval '10 minutes' GROUP BY metric) s
          WHERE c.rig_id = $1 AND c.metric = s.metric AND (c.last_ts IS NULL OR s.last_ts > c.last_ts)`, [rigId()]);
    return r.rowCount;
}

/** Dictionary entries with their stored extents and timestamps. */
async function channelEntries(metrics = null) {
    const dict = ctx.getDictionary();
    const { rows } = await tsdb.query(
        `SELECT metric, first_ts, last_ts, created_at, updated_at FROM channels
          WHERE rig_id = $1 ${metrics ? 'AND metric = ANY($2)' : ''}`, metrics ? [rigId(), metrics] : [rigId()]);
    const ext = new Map(rows.map((r) => [r.metric, r]));
    const list = metrics ? metrics.map((m) => dict.get(m)).filter(Boolean) : [...dict.values()];
    return list.map((c) => {
        const e = ext.get(c.metric) || {};
        return { ...c, firstTs: iso(e.first_ts), lastTs: iso(e.last_ts), createdAt: iso(e.created_at), updatedAt: iso(e.updated_at) };
    });
}

// ---- Runs and wells ---------------------------------------------------------------
async function runs() {
    const { rows } = await tsdb.query(
        `SELECT well_id, started_at, ended_at FROM well_runs WHERE rig_id = $1 ORDER BY started_at`, [rigId()]);
    return rows.map((r) => ({ wellId: r.well_id, startedAt: iso(r.started_at), endedAt: iso(r.ended_at) }));
}

const wellRecord = (wellId) => ctx.getWells().find((w) => w.name === wellId || w.id === wellId) || null;

async function runFor(wellId) {
    const list = (await runs()).filter((r) => r.wellId === wellId);
    if (!list.length) throw bad(`no run of well ${wellId} on this rig`);
    return list[list.length - 1];
}

/** First and last telemetry time inside a run (null when it has no data). */
async function runExtent(run) {
    const end = run.endedAt || new Date().toISOString();
    const q = (dir) => tsdb.query(
        `SELECT ts FROM telemetry WHERE rig_id = $1 AND ts >= $2 AND ts < $3 ORDER BY ts ${dir} LIMIT 1`,
        [rigId(), run.startedAt, end]);
    const [a, b] = await Promise.all([q('ASC'), q('DESC')]);
    return { start: a.rows[0] ? iso(a.rows[0].ts) : null, end: b.rows[0] ? iso(b.rows[0].ts) : null };
}

/** Wide rows of stored values in [start, end), at most `limit` rows. */
async function dataRows(metrics, start, end, limit) {
    const { rows } = await tsdb.query(
        `SELECT ts, metric, value FROM telemetry
          WHERE rig_id = $1 AND metric = ANY($2) AND ts >= $3 AND ts <= $4
          ORDER BY ts LIMIT $5`, [rigId(), metrics, start, end, limit * metrics.length]);
    const byTime = new Map();
    for (const r of rows) {
        const t = iso(r.ts);
        if (!byTime.has(t)) byTime.set(t, { time: t });
        byTime.get(t)[r.metric] = r.value;
    }
    return [...byTime.values()].slice(0, limit);
}

// ---- Objects --------------------------------------------------------------------
async function wellXml(wellId) {
    const w = wellRecord(wellId);
    if (!w) throw bad(`unknown well ${wellId}`);
    return w21.well(w, { timeZone: ctx.timeZone, rigId: rigId() });
}

async function wellboreXml(wellId) {
    const w = wellRecord(wellId);
    if (!w) throw bad(`unknown well ${wellId}`);
    const d = w.status === 'active' ? ctx.getDepths() : {};
    return w21.wellbore(w, { rigId: rigId(), holeDepthM: d.holeDepthM, bitDepthM: d.bitDepthM });
}

async function rigUtilizationXml(wellId) {
    return w21.rigUtilization(await runFor(wellId), { rigId: rigId() });
}

async function channelXml(metric) {
    const [c] = await channelEntries([metric]);
    if (!c) throw bad(`unknown channel ${metric}`);
    return w21.channel(c, { rigId: rigId(), loggingCompany: loggingCompany() });
}

/**
 * The run's Log, or its ChannelSet with data. Data: rows in [start, end] within
 * the run, at most maxRows.
 */
async function runXml(wellId, { kind = 'log', data = false, start, end, maxRows = 50000, metrics } = {}) {
    const run = await runFor(wellId);
    const extent = await runExtent(run);
    const entries = await channelEntries(metrics || null);
    const opts = { rigId: rigId(), loggingCompany: loggingCompany(), start: extent.start, end: extent.end };
    if (kind === 'log') return { xml: w21.log(run, entries, opts), truncated: false };
    let rows;
    let truncated = false;
    if (data && extent.start) {
        const from = start && Date.parse(start) > Date.parse(extent.start) ? new Date(start).toISOString() : extent.start;
        const to = end && Date.parse(end) < Date.parse(extent.end) ? new Date(end).toISOString() : extent.end;
        rows = await dataRows(entries.map((c) => c.metric), from, to, maxRows + 1);
        truncated = rows.length > maxRows;
        rows = rows.slice(0, maxRows);
    }
    return { xml: w21.channelSet(run, entries, { ...opts, rows }), truncated };
}

const byUuid = (list, uuid) => list.find((o) => o.uuid === uuid) || null;

/**
 * Every data object the edge publishes:
 * [{ type, uuid, title, lastChanged (ISO), xml: async () => string, targets: [uuid] }]
 */
async function listObjects() {
    const rig = rigId();
    const entries = await channelEntries();
    const dict = new Map(entries.map((c) => [c.metric, c]));
    const out = [];
    const company = loggingCompany();
    const companies = new Set([company]);
    const runList = await runs();
    for (const r of runList) { const w = wellRecord(r.wellId); if (w && w.operator) companies.add(w.operator); }
    const lastData = entries.reduce((m, c) => (c.lastTs && c.lastTs > m ? c.lastTs : m), '');

    out.push({ type: 'witsml21.Rig', uuid: ids.rig(rig), title: rig, lastChanged: lastData || null, targets: [],
        xml: async () => w21.rig(rig, {}) });
    for (const name of companies) {
        out.push({ type: 'eml23.BusinessAssociate', uuid: ids.businessAssociate(name), title: name, lastChanged: null, targets: [],
            xml: async () => w21.businessAssociate(name) });
    }
    for (const pk of channelLib.propertyKindsUsed(dict)) {
        out.push({ type: 'eml23.PropertyKind', uuid: pk.uuid, title: pk.title, lastChanged: '2021-11-17T23:35:26.000Z',
            targets: pk.parent.uuid !== pk.uuid ? [pk.parent.uuid] : [], xml: async () => w21.propertyKind(pk) });
    }
    for (const c of entries) {
        out.push({ type: 'witsml21.Channel', uuid: c.uuid, title: c.label || c.metric, metric: c.metric,
            lastChanged: c.lastTs || c.updatedAt, targets: [c.propertyKind.uuid, ids.businessAssociate(company)],
            xml: async () => w21.channel(c, { rigId: rig, loggingCompany: company }) });
    }
    const seenWells = new Set();
    for (const r of runList) {
        const w = wellRecord(r.wellId);
        if (!w) continue;
        if (!seenWells.has(r.wellId)) {
            seenWells.add(r.wellId);
            out.push({ type: 'witsml21.Well', uuid: ids.well(r.wellId), title: r.wellId, lastChanged: w.updatedAt || w.completedAt || w.startedAt,
                targets: w.operator ? [ids.businessAssociate(w.operator)] : [], xml: () => wellXml(r.wellId) });
            out.push({ type: 'witsml21.Wellbore', uuid: ids.wellbore(r.wellId), title: r.wellId, lastChanged: w.updatedAt || w.startedAt,
                targets: [ids.well(r.wellId)], xml: () => wellboreXml(r.wellId) });
        }
        const changed = r.endedAt || lastData || r.startedAt;
        out.push({ type: 'witsml21.RigUtilization', uuid: ids.rigUtilization(rig, r.wellId, r.startedAt), title: `${rig} on ${r.wellId}`,
            lastChanged: r.endedAt || r.startedAt, targets: [ids.wellbore(r.wellId), ids.rig(rig)],
            xml: async () => w21.rigUtilization(r, { rigId: rig }) });
        const runEntries = entries;
        out.push({ type: 'witsml21.Log', uuid: ids.log(rig, r.wellId, r.startedAt), title: `${r.wellId} ${rig} real-time log`,
            lastChanged: changed, targets: [ids.wellbore(r.wellId), ids.businessAssociate(company)],
            xml: async () => w21.log(r, runEntries, { rigId: rig, loggingCompany: company, ...(await runExtent(r)) }) });
        out.push({ type: 'witsml21.ChannelSet', uuid: ids.channelSet(rig, r.wellId, r.startedAt), title: `${r.wellId} ${rig} ${r.startedAt.slice(0, 10)}`,
            lastChanged: changed, targets: [ids.wellbore(r.wellId), ids.businessAssociate(company), ...runEntries.map((c) => c.uuid)],
            xml: async () => w21.channelSet(r, runEntries, { rigId: rig, loggingCompany: company, ...(await runExtent(r)) }) });
    }
    return out;
}

module.exports = {
    configure, refreshExtents, channelEntries, runs, runFor, runExtent, dataRows,
    wellXml, wellboreXml, rigUtilizationXml, channelXml, runXml, listObjects, byUuid,
};
