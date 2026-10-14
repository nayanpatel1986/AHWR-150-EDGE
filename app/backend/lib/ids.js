'use strict';
// Energistics data-object identifiers (WITSML 2.1 / ETP v1.2).
//
// Every object the edge publishes gets an RFC 4122 version-5 (name-based, SHA-1)
// UUID, so the edge and the CMF derive the same identifier for the same rig,
// well, wellbore, run or channel without exchanging it:
//   NAMESPACE = uuid5(NAMESPACE_URL, "urn:ahwr:energyml")
//             = 0c778a8a-d94f-55c2-9951-37777e6d4d11
//   rig            uuid5(NAMESPACE, "rig:<rig id>")
//   well           uuid5(NAMESPACE, "well:<well id>")          (well id = well name, as at the CMF)
//   wellbore       uuid5(NAMESPACE, "wellbore:<well id>:1")    (one wellbore per well)
//   rig on a well  uuid5(NAMESPACE, "rigutilization:<rig id>:<well id>:<run start, ISO 8601 UTC>")
//   log            uuid5(NAMESPACE, "log:<rig id>:<well id>:<run start>")
//   channel set    uuid5(NAMESPACE, "channelset:<rig id>:<well id>:<run start>")
//   channel        uuid5(NAMESPACE, "channel:<rig id>:<metric>")
//   company        uuid5(NAMESPACE, "businessassociate:<name>")
// Python: uuid.uuid5(NAMESPACE, name) gives the same values.
const crypto = require('crypto');

const NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const toBytes = (u) => Buffer.from(String(u).replace(/-/g, ''), 'hex');
const format = (b) => {
    const h = Buffer.from(b).toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

/** RFC 4122 version-5 UUID of `name` in `namespace` (both strings). */
function uuid5(name, namespace) {
    const b = crypto.createHash('sha1').update(toBytes(namespace)).update(Buffer.from(String(name), 'utf8')).digest().subarray(0, 16);
    b[6] = (b[6] & 0x0f) | 0x50;
    b[8] = (b[8] & 0x3f) | 0x80;
    return format(b);
}

const NAMESPACE = uuid5('urn:ahwr:energyml', NAMESPACE_URL);
const iso = (t) => (t ? new Date(t).toISOString() : '');
const id = (name) => uuid5(name, NAMESPACE);

module.exports = {
    NAMESPACE, uuid5, toBytes, format,
    rig: (rigId) => id(`rig:${rigId}`),
    well: (wellId) => id(`well:${wellId}`),
    wellbore: (wellId) => id(`wellbore:${wellId}:1`),
    rigUtilization: (rigId, wellId, startedAt) => id(`rigutilization:${rigId}:${wellId}:${iso(startedAt)}`),
    log: (rigId, wellId, startedAt) => id(`log:${rigId}:${wellId}:${iso(startedAt)}`),
    channelSet: (rigId, wellId, startedAt) => id(`channelset:${rigId}:${wellId}:${iso(startedAt)}`),
    channel: (rigId, metric) => id(`channel:${rigId}:${metric}`),
    businessAssociate: (name) => id(`businessassociate:${name}`),
};
