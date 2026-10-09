import React, { createContext, useContext, useEffect, useState } from 'react';
import { getLatestAlarms, isLiveRigPayload, socket } from '../socket';
import axios from '../api';
import { priorityColor } from '../utils/alarms';

// App-wide alarm state, so any dashboard widget can ask "is my parameter in
// alarm right now?" and follow the standard annunciator behaviour:
//   UNACK / RTN_UNACK  -> BLINK in the priority colour (latched: stays until ack/reset)
//   ACK (still active) -> SOLID priority colour (steady, no blink)
//   not in alarm        -> normal
// The map is keyed by dataKey (the dotted telemetry path), mirroring the
// backend `_alarmMap` and the `alarms` socket event's active list.

const AlarmContext = createContext({ active: [], counts: {}, byDataKey: {} });

// Crisp annunciator-style blink (hard on/off, not a soft fade).
export const ALARM_BLINK = 'romiiAlarmBlink';
const ALARM_KEYFRAMES = `@keyframes ${ALARM_BLINK}{0%,49%{opacity:1}50%,100%{opacity:.2}}`;

const buildMap = (active) => {
    const m = {};
    for (const a of active || []) {
        if (!a || !a.dataKey) continue;
        const cur = m[a.dataKey];
        // Prefer the more important rule on a shared dataKey: unacked beats acked.
        if (!cur || (a.state !== 'ACK' && cur.state === 'ACK')) m[a.dataKey] = a;
    }
    return m;
};

export function AlarmProvider({ children }) {
    const [state, setState] = useState({ active: [], counts: {}, byDataKey: {} });

    useEffect(() => {
        let mounted = true;
        const apply = (p) => {
            if (!mounted || !p) return;
            const active = Array.isArray(p.active) ? p.active : [];
            setState({ active, counts: p.counts || {}, byDataKey: buildMap(active) });
        };
        apply(getLatestAlarms());
        // Seed from REST only if the rig feed is live; stale PLC means no active alarm display.
        axios.get('/api/rig/latest', { timeout: 3000 })
            .then(({ data }) => {
                if (!isLiveRigPayload(data)) setState({ active: [], counts: {}, byDataKey: {} });
                else return axios.get('/api/alarms', { timeout: 3000 }).then((r) => apply(r.data));
            })
            .catch(() => setState({ active: [], counts: {}, byDataKey: {} }));
        const clearIfNoPlc = (p) => {
            if (!isLiveRigPayload(p)) setState({ active: [], counts: {}, byDataKey: {} });
        };
        socket.on('alarms', apply);
        socket.on('rig_data', clearIfNoPlc);
        return () => { mounted = false; socket.off('alarms', apply); socket.off('rig_data', clearIfNoPlc); };
    }, []);

    return (
        <AlarmContext.Provider value={state}>
            <style>{ALARM_KEYFRAMES}</style>
            {children}
        </AlarmContext.Provider>
    );
}

export function useAlarms() {
    return useContext(AlarmContext);
}

// Returns null when `dataKey` is clear, else a descriptor with display cues.
export function useAlarmState(dataKey) {
    const { byDataKey } = useContext(AlarmContext);
    if (!dataKey) return null;
    const a = byDataKey[dataKey];
    if (!a) return null;
    const blink = a.state === 'UNACK' || a.state === 'RTN_UNACK';
    return {
        inAlarm: true,
        state: a.state,
        priority: a.priority,
        condition: a.condition,
        value: a.value,
        limit: a.limit,
        label: a.label,
        unit: a.unit,
        color: priorityColor(a.priority),
        blink,                              // unacked (incl. latched ringback) -> blink
        latched: a.state === 'RTN_UNACK',   // returned to normal but not yet reset
    };
}

// Inline-style fragment to splice onto a value when its parameter is in alarm.
// Pass the descriptor from useAlarmState(); returns null when clear.
export function alarmTextStyle(alarm) {
    if (!alarm) return null;
    return {
        color: alarm.color,
        animation: alarm.blink ? `${ALARM_BLINK} 1s steps(1, end) infinite` : 'none',
    };
}
