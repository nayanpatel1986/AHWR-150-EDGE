'use strict';
// Edge health / data-quality agent. Computes a per-rig health score from live-data
// freshness (stale/missing measurements), collector/link state, and sync lag.
// Read-only; surfaced on the Edge Sync page and available to the central health monitor.
const EXPECTED = ['drawworks', 'mudpump', 'fluid', 'drilling', 'hpu', 'htd', 'cat_engine', 'acs', 'cwk', 'pct', 'well_control', 'wellhead', 'safety'];
const SYNC_TARGET_SEC = 30; // central latency target from the proposal (§6.5)

const hasFinite = (obj) => obj && typeof obj === 'object' && Object.values(obj).some((v) => Number.isFinite(Number(v)));
const grade = (s) => (s >= 90 ? 'Good' : s >= 70 ? 'Degraded' : 'Poor');

function getEdgeHealth(data, sync) {
    data = data || {};
    const meta = data._meta || {};
    const present = EXPECTED.filter((m) => hasFinite(data[m]));
    const missing = EXPECTED.filter((m) => !hasFinite(data[m]));

    // Data freshness
    let freshness = EXPECTED.length ? Math.round((present.length / EXPECTED.length) * 100) : 0;
    if (meta.stale) freshness = Math.round(freshness * 0.5);

    // Collector / link
    const collector = meta.connected ? 100 : 0;

    // Sync health
    let syncScore = 100, syncDetail = 'disabled';
    if (sync && sync.enabled) {
        const lag = sync.syncLagSec;
        if (sync.bufferedBatches > 0 && sync.connected) { syncScore = 70; syncDetail = `draining (${sync.bufferedBatches} buffered)`; }
        else if (!sync.connected) { syncScore = sync.bufferedBatches > 200 ? 20 : 40; syncDetail = `offline — buffering (${sync.bufferedBatches})`; }
        else if (lag != null && lag <= SYNC_TARGET_SEC) { syncScore = 100; syncDetail = `in sync (${lag}s lag)`; }
        else if (lag != null && lag <= 300) { syncScore = 75; syncDetail = `lag ${lag}s`; }
        else { syncScore = 60; syncDetail = `lag ${lag != null ? lag + 's' : 'unknown'}`; }
    }

    const score = Math.round(freshness * 0.5 + collector * 0.2 + syncScore * 0.3);
    return {
        score, grade: grade(score),
        components: [
            { name: 'Data freshness', score: freshness, status: grade(freshness), detail: `${present.length}/${EXPECTED.length} sources fresh${meta.stale ? ' · STALE feed' : ''}` },
            { name: 'Collector / PLC link', score: collector, status: grade(collector), detail: meta.connected ? `connected (${meta.source || 'plc'})` : 'no live data' },
            { name: 'Central sync', score: syncScore, status: grade(syncScore), detail: syncDetail },
        ],
        missing,
        expected: EXPECTED.length,
        present: present.length,
        generatedAt: new Date().toISOString(),
    };
}

module.exports = { getEdgeHealth, EXPECTED };
