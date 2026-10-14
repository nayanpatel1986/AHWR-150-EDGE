'use strict';
// ETP v1.2 binary Avro codec over the official message schemas (schemas.json,
// extracted from etptypes by test/tools/etp12-extract-schemas.py).
// A WebSocket message = MessageHeader + message body, both Avro binary.
// Unions are wrapped: { long: 5 }, { double: 1.5 }, null.
const avro = require('avsc');
const bundle = require('./schemas.json');

const PROTOCOL = {
    Core: 0, ChannelStreaming: 1, ChannelDataFrame: 2, Discovery: 3, Store: 4,
    ChannelSubscribe: 21, ChannelDataLoad: 22,
};
const FLAGS = { FIN: 0x02, COMPRESSED: 0x08, ACK_REQUESTED: 0x10, HEADER_EXTENSION: 0x20 };
// Error codes (ETP v1.2 specification, chapter 24).
const ERRORS = {
    ENOROLE: 1, ENOSUPPORTEDPROTOCOLS: 2, EINVALID_MESSAGETYPE: 3, EUNSUPPORTED_PROTOCOL: 4,
    EINVALID_ARGUMENT: 5, EREQUEST_DENIED: 6, ENOTSUPPORTED: 7, EINVALID_STATE: 8, EINVALID_URI: 9,
    EAUTHORIZATION_EXPIRED: 10, ENOT_FOUND: 11, ELIMIT_EXCEEDED: 12, ECOMPRESSION_NOTSUPPORTED: 13,
    EINVALID_OBJECT: 14, EMAX_TRANSACTIONS_EXCEEDED: 15, EDATAOBJECTTYPE_NOTSUPPORTED: 16,
    EMAXSIZE_EXCEEDED: 17, EMULTIPART_CANCELLED: 18, EINVALID_MESSAGE: 19, EINVALID_INDEXKIND: 20,
    ENOSUPPORTEDFORMATS: 21, EREQUESTUUID_REJECTED: 22, EUPDATEGROWINGOBJECT_DENIED: 23,
    EBACKPRESSURE_LIMIT_EXCEEDED: 24, EBACKPRESSURE_WARNING: 25, ETIMED_OUT: 26,
    EAUTHORIZATION_REQUIRED: 27, EAUTHORIZATION_EXPIRING: 28, ENOSUPPORTEDDATAOBJECTTYPES: 29,
    ERESPONSECOUNT_EXCEEDED: 30, EINVALID_APPEND: 31, EINVALID_OPERATION: 32,
};
const VERSION = { major: 1, minor: 2, revision: 0, patch: 0 };
const SUBPROTOCOL = 'etp12.energistics.org';

const byKey = new Map();    // "protocol:messageType" -> entry
const byName = new Map();   // "protocol:Name" -> entry
let headerType = null;
for (const m of bundle.messages) {
    const type = avro.Type.forSchema(m.schema, { wrapUnions: true });
    if (m.name === 'MessageHeader') { headerType = type; continue; }
    const entry = { name: m.name, protocol: m.protocol, messageType: m.messageType, senderRole: m.senderRole, type };
    byKey.set(`${m.protocol}:${m.messageType}`, entry);
    byName.set(`${m.protocol}:${m.name}`, entry);
}

// ProtocolException (1000) and Acknowledge (1001) are Core messages that may be
// sent in any protocol, with that protocol in the header.
const ANY_PROTOCOL = new Set(['ProtocolException', 'Acknowledge']);
// Records used outside messages (e.g. ServerCapabilities): binary via
// toBuffer(), Avro JSON encoding via toString().
const records = Object.fromEntries(Object.entries(bundle.records || {})
    .map(([name, schema]) => [name, avro.Type.forSchema(schema, { wrapUnions: true })]));

const lookup = (protocol, name) => {
    const e = byName.get(`${ANY_PROTOCOL.has(name) ? 0 : protocol}:${name}`);
    if (!e) throw new Error(`no ETP v1.2 message ${name} in protocol ${protocol}`);
    return e;
};

/** Encode one message; `flags` defaults to FIN (single-part or last part). */
function encode(protocol, name, body, { messageId, correlationId = 0, flags = FLAGS.FIN } = {}) {
    const e = lookup(protocol, name);
    const header = headerType.toBuffer({ protocol, messageType: e.messageType, correlationId, messageId, messageFlags: flags });
    return Buffer.concat([header, e.type.toBuffer(body)]);
}

/** Decode one WebSocket message: { header, protocol, name, body } (name null if unknown). */
function decode(buf) {
    const h = headerType.decode(buf, 0);
    if (h.offset < 0) throw new Error('truncated message header');
    const header = h.value;
    const mt = Number(header.messageType);
    const e = byKey.get(`${mt === 1000 || mt === 1001 ? 0 : header.protocol}:${mt}`);
    if (!e) return { header, protocol: header.protocol, name: null, body: null };
    if (header.messageFlags & FLAGS.COMPRESSED) throw Object.assign(new Error('compressed messages are not supported'), { etpCode: ERRORS.ECOMPRESSION_NOTSUPPORTED });
    if (header.messageFlags & FLAGS.HEADER_EXTENSION) throw Object.assign(new Error('message header extensions are not supported'), { etpCode: ERRORS.EINVALID_MESSAGE });
    const d = e.type.decode(buf, h.offset);
    if (d.offset < 0) throw Object.assign(new Error(`truncated ${e.name} body`), { etpCode: ERRORS.EINVALID_MESSAGE });
    return { header, protocol: header.protocol, name: e.name, body: d.value };
}

const has = (protocol, name) => byName.has(`${ANY_PROTOCOL.has(name) ? 0 : protocol}:${name}`);

// ---- Value helpers ---------------------------------------------------------------
/** UTC microseconds since the Unix epoch (ETP timestamps and time indexes). */
const micros = (t) => (t instanceof Date ? t.getTime() : (typeof t === 'number' ? t : Date.parse(t))) * 1000;
const fromMicros = (us) => new Date(Math.floor(Number(us) / 1000));
const indexValue = (t) => ({ item: { long: micros(t) } });
/** Read an IndexValue: { item: { long } | { double } | null } -> number | null. */
const indexOf = (iv) => {
    const item = iv && iv.item;
    if (!item) return null;
    if ('long' in item) return Number(item.long);
    if ('double' in item) return Number(item.double);
    return null;
};
/** DataValue -> JS number/boolean/string/null (scalars only). */
function dataValueOf(v) {
    const item = v && v.item;
    if (!item) return null;
    const k = Object.keys(item)[0];
    const x = item[k];
    if (['int', 'long', 'float', 'double', 'boolean', 'string'].includes(k)) return x;
    return null;
}
const errorInfo = (code, message) => ({ 'Energistics.Etp.v12.Datatypes.ErrorInfo': { message: String(message).slice(0, 4096), code } });

module.exports = {
    PROTOCOL, FLAGS, ERRORS, VERSION, SUBPROTOCOL, encode, decode, has, lookup,
    micros, fromMicros, indexValue, indexOf, dataValueOf, errorInfo, bundle, records,
};
