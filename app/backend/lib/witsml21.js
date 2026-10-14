'use strict';
// WITSML 2.1 data objects (Energistics common v2.3), serialized as XML.
//
// Objects: Well, Wellbore, Rig, RigUtilization (a rig working a wellbore = one
// well run), Channel (one per recorded metric of a rig), ChannelSet and Log
// (one per well run, holding that run's channels and, on request, its data),
// plus the eml23 BusinessAssociate and PropertyKind objects they reference.
// Element order follows the XSD sequences; test/witsml21.test.cjs validates
// every object against the official schemas when WITSML21_XSD_DIR is set.
//
// Pure functions: the inputs are plain records (lib/energistics.js reads them
// from the historian). Identifiers come from lib/ids.js.
const ids = require('./ids');

const NS_WITSML = 'http://www.energistics.org/energyml/data/witsmlv2';
const NS_EML = 'http://www.energistics.org/energyml/data/commonv2';
const NS_XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const WITSML_VERSION = '2.1';
const EML_VERSION = '2.3';
// Application named in citations (eml:Format); setApplication() changes it.
let APP = (() => { try { return `AHWR-150 EDGE ${require('../package.json').version}`; } catch { return 'AHWR-150 EDGE'; } })();
const setApplication = (name) => { APP = String(name).slice(0, 2000); };

const esc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const ts = (t) => (t ? new Date(t).toISOString() : null);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
// <p:Name>value</p:Name>, or nothing when the value is empty.
const el = (p, name, value, attrs = '') => (value === null || value === undefined || value === ''
    ? '' : `<${p}:${name}${attrs}>${esc(value)}</${p}:${name}>`);
const s64 = (v) => (v == null ? v : String(v).slice(0, 64));

/** eml:Citation (Title, Originator, Creation, Format, LastUpdate, Description). */
function citation({ title, originator, creation, lastUpdate, description }) {
    return '<eml:Citation>'
        + el('eml', 'Title', String(title || 'untitled').slice(0, 256))
        + el('eml', 'Originator', s64(originator || APP))
        + el('eml', 'Creation', ts(creation) || new Date(0).toISOString())
        + el('eml', 'Format', APP)
        + el('eml', 'LastUpdate', ts(lastUpdate))
        + el('eml', 'Description', description ? String(description).slice(0, 2000) : null)
        + '</eml:Citation>';
}

/** A DataObjectReference element <p:Name> to { uuid, type (e.g. witsml21.Well), title }. */
function ref(p, name, { uuid, type, title }) {
    return `<${p}:${name}>${el('eml', 'Uuid', uuid)}${el('eml', 'QualifiedType', type)}${el('eml', 'Title', String(title || uuid).slice(0, 2000))}</${p}:${name}>`;
}

function root(prefix, name, uuid, version, body) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + `<${prefix}:${name} xmlns:witsml="${NS_WITSML}" xmlns:eml="${NS_EML}" xmlns:xsi="${NS_XSI}" uuid="${uuid}" schemaVersion="${version}">`
        + body + `</${prefix}:${name}>\n`;
}
const interval = (p, name, start, end) => (start && end
    ? `<${p}:${name} xsi:type="eml:DateTimeInterval">${el('eml', 'StartTime', ts(start))}${el('eml', 'EndTime', ts(end))}</${p}:${name}>`
    : '');
const length = (p, name, metres) => (num(metres) === null ? '' : `<${p}:${name} uom="m">${num(metres)}</${p}:${name}>`);
const md = (name, metres) => (num(metres) === null ? ''
    : `<witsml:${name}><eml:MeasuredDepth uom="m">${num(metres)}</eml:MeasuredDepth></witsml:${name}>`);

// ---- References --------------------------------------------------------------
const refs = {
    well: (wellId) => ({ uuid: ids.well(wellId), type: 'witsml21.Well', title: wellId }),
    wellbore: (wellId) => ({ uuid: ids.wellbore(wellId), type: 'witsml21.Wellbore', title: wellId }),
    rig: (rigId) => ({ uuid: ids.rig(rigId), type: 'witsml21.Rig', title: rigId }),
    company: (name) => ({ uuid: ids.businessAssociate(name), type: 'eml23.BusinessAssociate', title: name }),
    propertyKind: (pk) => ({ uuid: pk.uuid, type: 'eml23.PropertyKind', title: pk.title }),
};

// ---- Objects -------------------------------------------------------------------
/** @param w edge well record: name, uwi, field, country, operator, spudDate, status, startedAt, completedAt */
function well(w, { timeZone = 'Z', rigId, lastUpdate } = {}) {
    const statusWell = w.status === 'active' ? 'working over' : 'unknown';
    const body = citation({ title: w.name, originator: rigId, creation: w.createdAt || w.startedAt, lastUpdate: lastUpdate || w.updatedAt || w.completedAt })
        + el('eml', 'ActiveStatus', w.status === 'active' ? 'active' : 'inactive')
        + el('witsml', 'NumGovt', s64(w.uwi))
        + el('witsml', 'TimeZone', timeZone)
        + el('witsml', 'Field', s64(w.field))
        + el('witsml', 'Country', s64(w.country))
        + (w.operator ? ref('witsml', 'Operator', refs.company(w.operator)) : '')
        + el('witsml', 'StatusWell', statusWell)
        + el('witsml', 'DTimSpud', ts(w.spudDate));
    return root('witsml', 'Well', ids.well(w.name), WITSML_VERSION, body);
}

function wellbore(w, { rigId, holeDepthM, bitDepthM, lastUpdate } = {}) {
    const body = citation({ title: w.name, originator: rigId, creation: w.createdAt || w.startedAt, lastUpdate: lastUpdate || w.updatedAt })
        + el('eml', 'ActiveStatus', w.status === 'active' ? 'active' : 'inactive')
        + el('witsml', 'Number', '1')
        + el('witsml', 'StatusWellbore', w.status === 'active' ? 'working over' : 'unknown')
        + md('Md', holeDepthM)
        + md('MdBit', bitDepthM)
        + md('MdPlanned', w.plannedTdM)
        + ref('witsml', 'Well', refs.well(w.name));
    return root('witsml', 'Wellbore', ids.wellbore(w.name), WITSML_VERSION, body);
}

function rig(rigId, { active = true, owner, creation, lastUpdate } = {}) {
    const body = citation({ title: rigId, originator: rigId, creation, lastUpdate })
        + el('eml', 'ActiveStatus', active ? 'active' : 'inactive')
        + (owner ? ref('witsml', 'Owner', refs.company(owner)) : '')
        + el('witsml', 'TypeRig', 'land')
        + el('witsml', 'ClassRig', 'workover');
    return root('witsml', 'Rig', ids.rig(rigId), WITSML_VERSION, body);
}

/** One well run: the rig working the well's wellbore from startedAt to endedAt. */
function rigUtilization(run, { rigId, startHoleDepthM, endHoleDepthM } = {}) {
    const body = citation({ title: `${rigId} on ${run.wellId}`, originator: rigId, creation: run.startedAt, lastUpdate: run.endedAt })
        + el('eml', 'ActiveStatus', run.endedAt ? 'inactive' : 'active')
        + el('witsml', 'StartOperationTime', ts(run.startedAt))
        + el('witsml', 'EndOperationTime', ts(run.endedAt))
        + length('witsml', 'StartHoleDepth', startHoleDepthM)
        + length('witsml', 'EndHoleDepth', endHoleDepthM)
        + ref('witsml', 'Wellbore', refs.wellbore(run.wellId))
        + ref('witsml', 'Rig', refs.rig(rigId));
    return root('witsml', 'RigUtilization', ids.rigUtilization(rigId, run.wellId, run.startedAt), WITSML_VERSION, body);
}

function businessAssociate(name, { creation } = {}) {
    const body = citation({ title: name, originator: APP, creation }) + el('eml', 'Name', String(name).slice(0, 256));
    return root('eml', 'BusinessAssociate', ids.businessAssociate(name), EML_VERSION, body);
}

/** A PWLS property kind as published in the Energistics PropertyKindDictionary. */
function propertyKind(pk) {
    const body = '<eml:Citation>' + el('eml', 'Title', pk.title) + el('eml', 'Originator', 'Energistics')
        + el('eml', 'Creation', '2016-12-09T17:30:47Z') + el('eml', 'Format', 'Energistics:PWLS Generator.ps1:2021.11.17')
        + el('eml', 'LastUpdate', '2021-11-17T23:35:26Z') + '</eml:Citation>'
        + el('eml', 'IsAbstract', pk.isAbstract ? 'true' : 'false')
        + el('eml', 'QuantityClass', pk.quantityClass)
        + (pk.parent && pk.parent.uuid !== pk.uuid ? ref('eml', 'Parent', { uuid: pk.parent.uuid, type: 'eml23.PropertyKind', title: pk.parent.title }) : '');
    return root('eml', 'PropertyKind', pk.uuid, EML_VERSION, body);
}

const channelIndex = (p, start, end) => `<${p}:Index>`
    + el('witsml', 'IndexKind', 'date time') + el('witsml', 'Uom', 's') + el('witsml', 'Direction', 'increasing')
    + el('witsml', 'Mnemonic', 'TIME') + interval('witsml', 'IndexInterval', start, end) + `</${p}:Index>`;

/**
 * Channel body (shared by the standalone object and the copy inside a ChannelSet).
 * @param c channel dictionary entry (lib/channels.js) with firstTs/lastTs
 */
function channelBody(c, { rigId, loggingCompany }) {
    const start = c.firstTs || null;
    const end = c.lastTs || null;
    return citation({ title: c.label || c.metric, originator: rigId, creation: c.createdAt || start, lastUpdate: c.updatedAt, description: `${rigId} ${c.metric}` })
        + el('eml', 'ActiveStatus', end && Date.now() - Date.parse(end) < 15 * 60 * 1000 ? 'active' : 'inactive')
        + el('witsml', 'Mnemonic', s64(c.mnemonic))
        + el('witsml', 'GlobalMnemonic', s64(c.mnemonic))
        + el('witsml', 'DataKind', c.dataKind || 'double')
        + el('witsml', 'Uom', c.uom)
        + el('witsml', 'Source', s64(rigId))
        + el('witsml', 'ChannelState', 'real time')
        + ref('witsml', 'ChannelPropertyKind', refs.propertyKind(c.propertyKind))
        + interval('witsml', 'PrimaryIndexInterval', start, end)
        + ref('witsml', 'LoggingCompany', refs.company(loggingCompany || rigId))
        + channelIndex('witsml', start, end);
}

function channel(c, opts) {
    return root('witsml', 'Channel', c.uuid, WITSML_VERSION, channelBody(c, opts));
}

/**
 * Data rows in the WITSML 2.x JSON form: [[["<time>"], [v1, v2, ...]], ...],
 * values in channel order, presented units (value * factor), null when absent.
 * @param rows [{ time, [metric]: storedValue }]
 */
function channelData(entries, rows) {
    const lines = rows.map((r) => JSON.stringify([[ts(r.time)], entries.map((c) => {
        const v = num(r[c.metric]);
        return v === null ? null : Number((v * (c.factor || 1)).toFixed(6));
    })]));
    return `[\n${lines.join(',\n')}\n]`;
}

function channelSetBody(run, entries, { rigId, loggingCompany, start, end, rows }) {
    const title = `${run.wellId} ${rigId} ${ts(run.startedAt).slice(0, 10)}`;
    return citation({ title, originator: rigId, creation: run.startedAt, lastUpdate: run.endedAt })
        + el('eml', 'ActiveStatus', run.endedAt ? 'inactive' : 'active')
        + el('witsml', 'ChannelState', run.endedAt ? 'final' : 'real time')
        + interval('witsml', 'PrimaryIndexInterval', start, end)
        + ref('witsml', 'LoggingCompany', refs.company(loggingCompany || rigId))
        + channelIndex('witsml', start, end)
        + entries.map((c) => `<witsml:Channel uuid="${c.uuid}" schemaVersion="${WITSML_VERSION}">${channelBody(c, { rigId, loggingCompany })}</witsml:Channel>`).join('')
        + (rows ? `<witsml:Data><witsml:Data><![CDATA[${channelData(entries, rows)}]]></witsml:Data></witsml:Data>` : '')
        + ref('witsml', 'Wellbore', refs.wellbore(run.wellId));
}

/**
 * The channel set of one well run.
 * @param run      { wellId, startedAt, endedAt }
 * @param entries  channel dictionary entries (with firstTs/lastTs)
 * @param opts     { rigId, loggingCompany, start, end (data extent in the run), rows (optional data) }
 */
function channelSet(run, entries, opts) {
    return root('witsml', 'ChannelSet', ids.channelSet(opts.rigId, run.wellId, run.startedAt), WITSML_VERSION,
        channelSetBody(run, entries, opts));
}

/** The log of one well run: its channel set, referencing the wellbore. */
function log(run, entries, opts) {
    const { rigId, loggingCompany, start, end } = opts;
    const body = citation({ title: `${run.wellId} ${rigId} real-time log`, originator: rigId, creation: run.startedAt, lastUpdate: run.endedAt })
        + el('eml', 'ActiveStatus', run.endedAt ? 'inactive' : 'active')
        + el('witsml', 'ChannelState', run.endedAt ? 'final' : 'real time')
        + interval('witsml', 'PrimaryIndexInterval', start, end)
        + ref('witsml', 'LoggingCompany', refs.company(loggingCompany || rigId))
        + `<witsml:ChannelSet uuid="${ids.channelSet(rigId, run.wellId, run.startedAt)}" schemaVersion="${WITSML_VERSION}">${channelSetBody(run, entries, opts)}</witsml:ChannelSet>`
        + ref('witsml', 'Wellbore', refs.wellbore(run.wellId));
    return root('witsml', 'Log', ids.log(rigId, run.wellId, run.startedAt), WITSML_VERSION, body);
}

module.exports = {
    NS_WITSML, NS_EML, WITSML_VERSION, EML_VERSION, refs, setApplication,
    well, wellbore, rig, rigUtilization, businessAssociate, propertyKind, channel, channelSet, log, channelData,
};
