import { io } from 'socket.io-client';

// ONE shared socket instance for the whole app.
// - autoConnect:false so the connection is owned by Layout (after auth), not by import side-effects.
// - auth is a callback so the LATEST token is read on every (re)connect.
export const socket = io('/', {
    autoConnect: false,
    auth: (cb) => cb({ token: localStorage.getItem('romii_token') }),
    transports: ['websocket', 'polling'],
    rememberUpgrade: true,
    timeout: 3000,
    reconnectionDelay: 500,
    reconnectionDelayMax: 2000,
    randomizationFactor: 0.2,
});

let latestRigData = null;
let latestAlarms = null;
const recentRigData = [];
const MAX_RECENT_RIG_SAMPLES = 3600;

export function isLiveRigPayload(payload) {
    const meta = payload?._meta || {};
    return meta.connected === true && meta.source !== 'none' && meta.stale !== true;
}

// Client-side watchdog. The server normally marks stale packets itself, but if
// it stops emitting altogether while the socket stays connected (hung loop,
// blocked event loop), screens would keep showing the last packet as live.
// After RIG_DATA_TIMEOUT_MS of silence, replay the last packet marked stale to
// every rig_data listener so all pages switch to their no-live-data state.
const RIG_DATA_TIMEOUT_MS = 6000;
let lastRigDataAt = 0;
let watchdogFired = false;

setInterval(() => {
    if (!socket.connected || !lastRigDataAt || watchdogFired) return;
    if (Date.now() - lastRigDataAt < RIG_DATA_TIMEOUT_MS) return;
    watchdogFired = true;
    const stalePayload = {
        ...(latestRigData || {}),
        _meta: {
            ...(latestRigData?._meta || {}),
            stale: true,
            connected: false,
            source: 'none',
            watchdog: true,
            error: `No data from server for ${Math.round((Date.now() - lastRigDataAt) / 1000)} s`,
        },
    };
    socket.listeners('rig_data').forEach((listener) => {
        try { listener(stalePayload); } catch (err) { console.error('rig_data watchdog listener failed:', err); }
    });
}, 1000);

socket.on('rig_data', (payload) => {
    if (!payload?._meta?.watchdog) {
        lastRigDataAt = Date.now();
        watchdogFired = false;
    }
    if (payload && Object.keys(payload).length) {
        latestRigData = payload;
        if (!isLiveRigPayload(payload)) return;
        recentRigData.push(payload);
        if (recentRigData.length > MAX_RECENT_RIG_SAMPLES) {
            recentRigData.splice(0, recentRigData.length - MAX_RECENT_RIG_SAMPLES);
        }
    }
});

socket.on('alarms', (payload) => {
    latestAlarms = payload;
});

export function getLatestRigData() {
    return latestRigData;
}

export function getRecentRigDataSamples(limit = 300) {
    return recentRigData.slice(-Math.max(1, Math.min(MAX_RECENT_RIG_SAMPLES, Number(limit) || 300)));
}

export function getLatestAlarms() {
    return latestAlarms;
}

export function connectSocket() {
    if (!socket.connected) socket.connect();
}

export function disconnectSocket() {
    if (socket.connected) socket.disconnect();
}
