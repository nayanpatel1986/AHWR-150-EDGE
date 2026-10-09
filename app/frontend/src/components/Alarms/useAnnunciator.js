import { useEffect, useRef, useState, useCallback } from 'react';

// Web Audio annunciator. Different tone + cadence per priority for the highest
// UNACKED alarm. Browsers block autoplay, so the AudioContext is only created /
// resumed in response to a user gesture: callers expose a speaker toggle that
// calls `arm()`. While armed and an unacked alarm is present, a repeating beep
// pattern plays until ack'd or disarmed.
//
// Cadence / pitch per priority:
//   P1: fast urgent double-beep, high pitch (880 Hz)
//   P2: slower single beep, mid pitch (660 Hz)
//   P3: slow soft beep, low pitch (520 Hz)

const PATTERNS = {
    // freq Hz, beep length s, gap between repeats s, double-beep flag
    P1: { freq: 880, beep: 0.18, period: 0.9, double: true, gain: 0.22 },
    P2: { freq: 660, beep: 0.22, period: 1.8, double: false, gain: 0.18 },
    P3: { freq: 520, beep: 0.30, period: 3.0, double: false, gain: 0.14 },
};

export default function useAnnunciator(highestUnackPriority) {
    const [armed, setArmed] = useState(false);
    const ctxRef = useRef(null);
    const timerRef = useRef(null);
    const priorityRef = useRef(null);

    priorityRef.current = highestUnackPriority || null;

    const ensureCtx = useCallback(() => {
        if (!ctxRef.current) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            ctxRef.current = new AC();
        }
        // Resume if the context was suspended by the autoplay policy.
        if (ctxRef.current.state === 'suspended') {
            ctxRef.current.resume().catch(() => {});
        }
        return ctxRef.current;
    }, []);

    const playBeep = useCallback((freq, when, length, gainPeak) => {
        const ctx = ctxRef.current;
        if (!ctx) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        // Short attack/decay envelope to avoid clicks.
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.exponentialRampToValueAtTime(gainPeak, when + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + length);
        osc.connect(gain).connect(ctx.destination);
        osc.start(when);
        osc.stop(when + length + 0.02);
    }, []);

    const stopLoop = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    // Toggle armed state. Must be called from a user gesture (click).
    const toggle = useCallback(() => {
        setArmed((prev) => {
            const next = !prev;
            if (next) {
                ensureCtx(); // create/resume inside the gesture
            }
            return next;
        });
    }, [ensureCtx]);

    // The repeating scheduler. Re-reads the latest priority each tick so a
    // priority escalation changes the cadence without restarting the effect.
    useEffect(() => {
        if (!armed) {
            stopLoop();
            return undefined;
        }

        let cancelled = false;

        const tick = () => {
            if (cancelled) return;
            const prio = priorityRef.current;
            const pattern = prio ? PATTERNS[prio] : null;
            const ctx = ctxRef.current;

            if (pattern && ctx) {
                if (ctx.state === 'suspended') ctx.resume().catch(() => {});
                const now = ctx.currentTime + 0.02;
                playBeep(pattern.freq, now, pattern.beep, pattern.gain);
                if (pattern.double) {
                    playBeep(pattern.freq, now + pattern.beep + 0.08, pattern.beep, pattern.gain);
                }
                timerRef.current = setTimeout(tick, pattern.period * 1000);
            } else {
                // Nothing unacked right now; poll again shortly.
                timerRef.current = setTimeout(tick, 500);
            }
        };

        tick();

        return () => {
            cancelled = true;
            stopLoop();
        };
    }, [armed, playBeep, stopLoop]);

    // Cleanup the AudioContext on unmount.
    useEffect(() => {
        return () => {
            stopLoop();
            if (ctxRef.current) {
                ctxRef.current.close().catch(() => {});
                ctxRef.current = null;
            }
        };
    }, [stopLoop]);

    return { armed, toggle };
}
