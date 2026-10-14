'use strict';
// ETP v1.2 message session over one WebSocket (client or server side).
//   - message ids: the client uses non-zero even numbers, the server odd ones,
//     always increasing;
//   - responses carry the request's messageId as correlationId; multipart
//     responses end with the FIN flag;
//   - ProtocolException answers a request (correlationId set) or reports an
//     error with the session (correlationId 0);
//   - Core Ping is answered with Pong.
const EventEmitter = require('events');
const codec = require('./codec');

const { PROTOCOL, FLAGS, ERRORS } = codec;
const OPEN = 1;

class EtpSession extends EventEmitter {
    /** @param ws a "ws" WebSocket; @param side 'client' | 'server' */
    constructor(ws, { side, requestTimeoutMs = 30000 } = {}) {
        super();
        this.ws = ws;
        this.side = side;
        this.lastId = side === 'client' ? 0 : -1;
        this.pending = new Map();        // messageId -> { resolve, reject, parts, errors, timer }
        this.requestTimeoutMs = requestTimeoutMs;
        this.closed = false;
        ws.on('message', (data, isBinary) => this._receive(data, isBinary));
        ws.on('close', (code, reason) => this._closed(code, String(reason || '')));
        ws.on('error', (e) => this.emit('transportError', e));
    }

    nextId() { this.lastId += 2; return this.lastId; }

    /** Send one message; returns its messageId. */
    send(protocol, name, body, { correlationId = 0, final = true, ackRequested = false } = {}) {
        if (this.closed || this.ws.readyState !== OPEN) throw new Error('ETP session is closed');
        const messageId = this.nextId();
        const flags = (final ? FLAGS.FIN : 0) | (ackRequested ? FLAGS.ACK_REQUESTED : 0);
        this.ws.send(codec.encode(protocol, name, body, { messageId, correlationId, flags }));
        return messageId;
    }

    /** Reply to a request; `parts` = array of bodies sends a multipart response. */
    reply(req, name, parts, { protocol = req.protocol } = {}) {
        const list = Array.isArray(parts) ? parts : [parts];
        list.forEach((body, i) => this.send(protocol, name, body, { correlationId: req.header.messageId, final: i === list.length - 1 }));
    }

    /** Multipart reply made of several message kinds; the last one carries FIN. */
    replySequence(req, items, { protocol = req.protocol } = {}) {
        items.forEach(([name, body], i) => this.send(protocol, name, body, { correlationId: req.header.messageId, final: i === items.length - 1 }));
    }

    /** ProtocolException in the request's protocol (or Core); `errors` = map form. */
    exception(req, code, message, { errors = null, final = true } = {}) {
        const protocol = req ? req.protocol : PROTOCOL.Core;
        const body = errors
            ? { error: null, errors: Object.fromEntries(Object.entries(errors).map(([k, e]) => [k, { message: String(e.message).slice(0, 4096), code: e.code }])) }
            : { error: codec.errorInfo(code, message), errors: {} };
        try {
            this.send(protocol, 'ProtocolException', body, { correlationId: req ? req.header.messageId : 0, final });
        } catch { /* closed */ }
    }

    /**
     * Send a request and collect every response part until FIN.
     * Resolves { parts: [msg], errors: { key: ErrorInfo } }; rejects on a
     * non-map ProtocolException (err.etpCode) or timeout.
     */
    request(protocol, name, body, { timeoutMs = this.requestTimeoutMs } = {}) {
        return new Promise((resolve, reject) => {
            let messageId;
            try { messageId = this.send(protocol, name, body); } catch (e) { reject(e); return; }
            const timer = setTimeout(() => {
                this.pending.delete(messageId);
                reject(Object.assign(new Error(`${name}: no response within ${timeoutMs} ms`), { etpCode: ERRORS.ETIMED_OUT }));
            }, timeoutMs);
            this.pending.set(messageId, { resolve, reject, parts: [], errors: {}, timer, name });
        });
    }

    close(reason = 'closing') {
        if (this.closed) return;
        try { this.send(PROTOCOL.Core, 'CloseSession', { reason }); } catch { /* ignore */ }
        try { this.ws.close(1000, reason.slice(0, 120)); } catch { /* ignore */ }
    }

    _closed(code, reason) {
        if (this.closed) return;
        this.closed = true;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('ETP session closed'), { etpCode: ERRORS.EINVALID_STATE })); }
        this.pending.clear();
        this.emit('close', code, reason);
    }

    _receive(data, isBinary) {
        if (!isBinary) {
            // ETP v1.2 production implementations use binary Avro only.
            this.exception(null, ERRORS.EINVALID_MESSAGE, 'text (JSON) messages are not supported; use binary encoding');
            return;
        }
        let msg;
        try {
            msg = codec.decode(Buffer.from(data));
        } catch (e) {
            this.exception(null, e.etpCode || ERRORS.EINVALID_MESSAGE, `undecodable message: ${e.message}`);
            return;
        }
        if (!msg.name) {
            this.exception({ protocol: msg.header.protocol || 0, header: msg.header }, ERRORS.EINVALID_MESSAGETYPE,
                `unknown message type ${msg.header.protocol}/${msg.header.messageType}`);
            return;
        }
        const corr = msg.header.correlationId;
        const p = corr ? this.pending.get(Number(corr)) : null;
        if (p) {
            if (msg.name === 'ProtocolException') {
                const err = msg.body.error && (msg.body.error['Energistics.Etp.v12.Datatypes.ErrorInfo'] || msg.body.error);
                if (err) {
                    clearTimeout(p.timer); this.pending.delete(Number(corr));
                    p.reject(Object.assign(new Error(`${p.name}: ${err.message} (${err.code})`), { etpCode: err.code, parts: p.parts }));
                    return;
                }
                Object.assign(p.errors, msg.body.errors || {});
            } else {
                p.parts.push(msg);
            }
            if (msg.header.messageFlags & FLAGS.FIN) {
                clearTimeout(p.timer); this.pending.delete(Number(corr));
                p.resolve({ parts: p.parts, errors: p.errors });
            }
            return;
        }
        if (msg.protocol === PROTOCOL.Core && msg.name === 'Ping') {
            try { this.send(PROTOCOL.Core, 'Pong', { currentDateTime: Date.now() * 1000 }, { correlationId: msg.header.messageId }); } catch { /* closed */ }
            return;
        }
        if (msg.header.messageFlags & FLAGS.ACK_REQUESTED) {
            try { this.send(msg.protocol, 'Acknowledge', {}, { correlationId: msg.header.messageId }); } catch { /* ignore */ }
        }
        this.emit('message', msg);
    }
}

module.exports = { EtpSession };
