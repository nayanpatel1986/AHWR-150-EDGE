/**
 * Well report — the day-by-day record of a well.
 *
 * For each calendar day inside the well's window it gathers the operations log,
 * the maintenance log, the activity/NPT breakdown and the equipment run hours,
 * then closes with an equipment health summary for the whole job.
 *
 * Days are keyed by calendar date (UTC), which is exactly how the logbook and
 * the run-hour ledger already stamp their own records — the report never
 * re-bins someone else's timestamps into a different day.
 *
 * Everything here is derived from records the app already holds. Nothing is
 * synthesised: a day with no entries reports empty, not plausible-looking text.
 */
const cmms = require('./cmms');
const workover = require('./workover');
const runlog = require('./runlog');
const maintenance = require('./maintenance');
const instruments = require('./instruments');

const DAY_MS = 24 * 60 * 60 * 1000;
const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Every calendar day touched by [startMs, endMs]. */
function daysInWindow(startMs, endMs) {
    const out = [];
    let cur = Date.parse(`${dayKeyOf(startMs)}T00:00:00.000Z`);
    // A long-running well should not be able to generate an unbounded report.
    for (let i = 0; cur <= endMs && i < 400; i++, cur += DAY_MS) out.push(cur);
    return out;
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * Hours an asset actually ran inside [fromMs, toMs].
 *
 * Sessions are clipped to the window rather than counted whole, so a partial
 * first/last day is not credited with a full run, and a session that is still
 * open counts the time it has run so far instead of zero.
 */
function runHoursIn(sessions, fromMs, toMs, nowMs) {
    let ms = 0;
    for (const s of sessions) {
        const a = Date.parse(s.startTs);
        if (!Number.isFinite(a)) continue;
        const b = s.endTs ? Date.parse(s.endTs) : nowMs;
        const overlap = Math.min(Number.isFinite(b) ? b : nowMs, toMs) - Math.max(a, fromMs);
        if (overlap > 0) ms += overlap;
    }
    return ms / 3600000;
}

function buildWellReport(well, opts = {}) {
    if (!well || !well.startedAt) return null;
    const startMs = Date.parse(well.startedAt);
    const endMs = well.completedAt ? Date.parse(well.completedAt) : Date.now();
    if (!Number.isFinite(startMs)) return null;

    const latest = opts.latestRigData || {};

    // Pull the whole window once, then bucket by day — far cheaper than
    // filtering the logbook per day.
    const allLogs = cmms.listLogbook({ limit: 100000 });
    const inWindow = (iso) => {
        const t = Date.parse(iso);
        return Number.isFinite(t) && t >= startMs && t <= endMs;
    };
    const windowLogs = allLogs.filter((l) => inWindow(l.ts));
    // Run sessions per asset, for run hours clipped to each day and to the job.
    const sessionsByAsset = Object.fromEntries(
        maintenance.ASSETS.map((a) => [a.id, runlog.getAssetHistory(a.id).sessions]),
    );

    const workOrders = cmms.listWorkOrders({ limit: 100000 });
    const woOn = (dayKey, field) => workOrders.filter((w) => String(w[field] || '').slice(0, 10) === dayKey);

    const days = daysInWindow(startMs, endMs).map((dayStartMs) => {
        const key = dayKeyOf(dayStartMs);
        // The first and last day are partial — measure only the part of the day
        // the well actually occupied.
        const from = clamp(dayStartMs, startMs, endMs);
        const to = clamp(dayStartMs + DAY_MS, startMs, endMs);
        const dayLogs = windowLogs.filter((l) => l.date === key);
        const summary = workover.windowSummary(new Date(from).toISOString(), new Date(to).toISOString()) || {};
        const runHours = {};
        let runHoursTotal = 0;
        for (const a of maintenance.ASSETS) {
            const h = runHoursIn(sessionsByAsset[a.id] || [], from, to, endMs);
            if (h > 0) { runHours[a.id] = Number(h.toFixed(2)); runHoursTotal += h; }
        }

        return {
            date: key,
            from: new Date(from).toISOString(),
            to: new Date(to).toISOString(),
            partial: from > dayStartMs || to < dayStartMs + DAY_MS,
            operations: dayLogs.filter((l) => l.logType === 'OPERATIONS'),
            maintenance: dayLogs.filter((l) => l.logType === 'MAINTENANCE'),
            activity: summary.activitySummary || [],
            productiveSec: summary.productiveSec || 0,
            nptSec: summary.nptSec || 0,
            connections: summary.connections || { run: 0, pass: 0, fail: 0 },
            depthStart: summary.depthStart != null ? summary.depthStart : null,
            depthEnd: summary.depthEnd != null ? summary.depthEnd : null,
            depthProgress: summary.depthProgress || 0,
            runHours,
            runHoursTotal: Number(runHoursTotal.toFixed(2)),
            workOrdersRaised: woOn(key, 'raisedAt').map((w) => ({ no: w.no, type: w.type, priority: w.priority, assetId: w.assetId, title: w.title, status: w.status })),
            workOrdersClosed: woOn(key, 'completedAt').map((w) => ({ no: w.no, type: w.type, assetId: w.assetId, title: w.title, downtimeHrs: Number(((w.downtimeMin || 0) / 60).toFixed(2)) })),
        };
    });

    // ---- Equipment health across the whole job -----------------------------
    const pm = maintenance.getPM(latest);
    const equipmentHealth = maintenance.ASSETS.map((a) => {
        const hist = runlog.getAssetHistory(a.id);
        const sess = sessionsByAsset[a.id] || [];
        const inJob = sess.filter((s) => inWindow(s.startTs));
        const closed = inJob.filter((s) => s.endTs && s.durationH != null);
        // Clipped to the job window, and counting the currently-running session.
        const runH = runHoursIn(sess, startMs, endMs, endMs);
        const snaps = inJob.filter((s) => s.snapshotAt);
        const assetWos = workOrders.filter((w) => w.assetId === a.id);
        const breakdowns = assetWos.filter((w) => w.type === 'BREAKDOWN' && inWindow(w.raisedAt));
        const downtimeH = breakdowns.reduce((sum, w) => sum + (Number(w.downtimeMin) || 0) / 60, 0);

        return {
            assetId: a.id,
            name: a.name,
            category: a.category,
            running: hist.running,
            totalHours: maintenance.getHours()[a.id] != null ? Number(Number(maintenance.getHours()[a.id]).toFixed(1)) : null,
            runHoursInJob: Number(runH.toFixed(2)),
            starts: inJob.length,
            shortRuns: inJob.filter((s) => s.snapshotSkipped).length,
            avgRunHours: closed.length
                ? Number((closed.reduce((s, x) => s + Number(x.durationH || 0), 0) / closed.length).toFixed(2))
                : null,
            // First and last settled snapshot: the health drift across the job.
            firstSnapshot: snaps.length ? { ts: snaps[snaps.length - 1].snapshotAt, params: snaps[snaps.length - 1].params } : null,
            lastSnapshot: snaps.length ? { ts: snaps[0].snapshotAt, params: snaps[0].params } : null,
            snapshotCount: snaps.length,
            breakdowns: breakdowns.length,
            downtimeHrs: Number(downtimeH.toFixed(2)),
            openWorkOrders: assetWos.filter((w) => w.status !== 'COMPLETED' && w.status !== 'CANCELLED').length,
            // MTBF over this job only; needs at least one failure to mean anything.
            mtbfHrs: breakdowns.length ? Number((runH / breakdowns.length).toFixed(1)) : null,
            pm: pm.filter((p) => p.assetId === a.id)
                .map((p) => ({ name: p.name, status: p.status, dueInHours: p.dueInHours })),
        };
    });

    const instrumentSummary = instruments.getSummary();
    const totals = days.reduce((acc, d) => ({
        productiveSec: acc.productiveSec + d.productiveSec,
        nptSec: acc.nptSec + d.nptSec,
        operations: acc.operations + d.operations.length,
        maintenance: acc.maintenance + d.maintenance.length,
        joints: acc.joints + (d.connections.run || 0),
    }), { productiveSec: 0, nptSec: 0, operations: 0, maintenance: 0, joints: 0 });

    return {
        generatedAt: new Date().toISOString(),
        well: {
            id: well.id, name: well.name, uwi: well.uwi, jobNo: well.jobNo,
            serviceType: well.serviceType, status: well.status,
            startedAt: well.startedAt, completedAt: well.completedAt || null,
            objective: well.objective || null, plannedTdM: well.plannedTdM ?? null,
            rig: well.rig || null, field: well.field || null,
        },
        window: {
            from: new Date(startMs).toISOString(),
            to: new Date(endMs).toISOString(),
            elapsedHrs: Number(((endMs - startMs) / 3600000).toFixed(2)),
            days: days.length,
            dayBoundary: 'calendar day (UTC), matching the logbook and run-hour ledger',
        },
        summary: { ...(opts.summary || {}), ...totals, consumption: opts.consumption || null },
        days,
        equipmentHealth,
        instruments: {
            total: instrumentSummary.total,
            overdue: instrumentSummary.overdue,
            dueSoon: instrumentSummary.dueSoon,
            outOfService: instrumentSummary.outOfService,
        },
    };
}

module.exports = { buildWellReport };
