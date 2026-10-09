// Shared formatting helpers for workover/well-service feature pages.

// Seconds -> "H:MM:SS" (hours are not zero-padded; minutes/seconds are).
export function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${h}:${pad(m)}:${pad(sec)}`;
}

// "Time-in" style elapsed since an ISO/epoch timestamp, in seconds.
export function secondsSince(ts) {
    if (!ts) return 0;
    const then = typeof ts === 'number' ? ts : Date.parse(ts);
    if (Number.isNaN(then)) return 0;
    return Math.max(0, Math.floor((Date.now() - then) / 1000));
}

// Local clock string (HH:MM:SS) from an ISO/epoch timestamp.
export function formatClock(ts) {
    if (!ts) return '--:--:--';
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Run-hours -> "1234.00 h" (two decimals, thousands-separated). Returns "--" for nullish.
export function formatHours(h) {
    if (h == null || Number.isNaN(Number(h))) return '--';
    return `${Number(h).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })} h`;
}

// Today's date as YYYY-MM-DD (local), for date pickers / API queries.
export function todayISO() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
