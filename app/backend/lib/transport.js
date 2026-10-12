'use strict';
// Outbound links (CMF sync, central messages, ETP) carry the device token and
// rig data, so they must be encrypted. Plain http:// / ws:// is accepted only
// to a loopback host, or when ALLOW_INSECURE_TRANSPORT=true (lab use only).
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const insecureAllowed = () => /^(1|true|yes)$/i.test(process.env.ALLOW_INSECURE_TRANSPORT || '');

/**
 * Returns null when the URL is acceptable, else a human-readable reason.
 * @param {string} url
 * @param {{secure: string[], plain: string[]}} schemes e.g. https:/http: or wss:/ws:
 */
function insecureReason(url, schemes) {
    let u;
    try { u = new URL(String(url || '')); } catch { return 'invalid URL'; }
    if (schemes.secure.includes(u.protocol)) return null;
    if (!schemes.plain.includes(u.protocol)) return `unsupported scheme ${u.protocol}`;
    if (LOOPBACK.has(u.hostname) || insecureAllowed()) return null;
    return `${u.protocol}// is not encrypted; use ${schemes.secure[0]}// (or set ALLOW_INSECURE_TRANSPORT=true for a lab)`;
}

const HTTP = { secure: ['https:'], plain: ['http:'] };
const WS = { secure: ['wss:'], plain: ['ws:'] };

function assertSecure(url, schemes, label) {
    const reason = insecureReason(url, schemes);
    if (reason) throw Object.assign(new Error(`${label}: ${reason}`), { status: 400 });
}

module.exports = { insecureReason, assertSecure, HTTP, WS };
