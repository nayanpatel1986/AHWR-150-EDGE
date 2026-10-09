'use strict';
// WITSML 1.4.1.1 agent (edge export). Generates Energistics WITSML 1.4.1.1 <wells> and
// <logs> (date-time indexed) documents from the current well header + recent telemetry,
// for interoperability with the central WITSML store / office systems. Export only.
const NS = 'http://www.witsml.org/schemas/1series';
const VER = '1.4.1.1';

// Curated standard channels (WITSML mnemonic <- app key, with unit).
const CHANNELS = [
    { mnem: 'HKLD', key: 'drawworks.hook_load', unit: 't' },
    { mnem: 'BPOS', key: 'drawworks.block_position', unit: 'ft' },
    { mnem: 'WOB', key: 'drilling.wob', unit: 't' },
    { mnem: 'ROPA', key: 'drilling.rop', unit: 'm/h' },
    { mnem: 'RPMA', key: 'drilling.rpm', unit: 'rpm' },
    { mnem: 'TQA', key: 'drilling.torque', unit: 'N.m' },
    { mnem: 'SPPA', key: 'mudpump.pressure', unit: 'bar' },
    { mnem: 'TUBP', key: 'wellhead.tubing_pressure', unit: 'bar' },
    { mnem: 'CASP', key: 'wellhead.casing_pressure', unit: 'bar' },
    { mnem: 'BDEP', key: 'drilling.bit_depth', unit: 'm' },
    { mnem: 'DMEA', key: 'drilling.hole_depth', unit: 'm' },
];

const esc = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const idOf = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_-]/g, '-');

function wells(header) {
    const h = header || {};
    const uidWell = idOf(h.well || 'WELL'); const uidWb = idOf(h.rig || 'WB');
    return `<?xml version="1.0" encoding="UTF-8"?>
<wells xmlns="${NS}" version="${VER}">
  <well uid="${uidWell}">
    <name>${esc(h.well || 'WELL-001')}</name>
    <operator>${esc(h.operator || 'ONGC')}</operator>
    <field>${esc(h.field || 'Ankleshwar')}</field>
    <numLicense>${esc(h.jobNo || '')}</numLicense>
    <statusWell>active</statusWell>
    <wellbore uid="${uidWb}">
      <name>${esc(h.rig || 'AHWR-50')}</name>
      <statusWellbore>active</statusWellbore>
    </wellbore>
  </well>
</wells>`;
}

function logs(header, snapshots) {
    const h = header || {};
    const uidWell = idOf(h.well || 'WELL'); const uidWb = idOf(h.rig || 'WB');
    const snaps = Array.isArray(snapshots) ? snapshots : [];
    const start = snaps.length ? snaps[0].ts : new Date().toISOString();
    const end = snaps.length ? snaps[snaps.length - 1].ts : start;

    const curveInfo = (mnem, unit, idx, isTime) => `      <logCurveInfo uid="${mnem}">
        <mnemonic>${mnem}</mnemonic>
        <unit>${esc(unit)}</unit>
        <typeLogData>${isTime ? 'date time' : 'double'}</typeLogData>
        <columnIndex>${idx}</columnIndex>
      </logCurveInfo>`;
    const curves = [curveInfo('TIME', 's', 1, true), ...CHANNELS.map((c, i) => curveInfo(c.mnem, c.unit, i + 2, false))].join('\n');

    const mnemonicList = ['TIME', ...CHANNELS.map((c) => c.mnem)].join(',');
    const unitList = ['s', ...CHANNELS.map((c) => c.unit)].join(',');
    const rows = snaps.map((s) => {
        const vals = CHANNELS.map((c) => { const v = s.values ? s.values[c.key] : undefined; return Number.isFinite(v) ? Number(v).toFixed(3) : ''; });
        return `        <data>${[s.ts, ...vals].join(',')}</data>`;
    }).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<logs xmlns="${NS}" version="${VER}">
  <log uidWell="${uidWell}" uidWellbore="${uidWb}" uid="LOG-EDGE-1">
    <nameWell>${esc(h.well || 'WELL-001')}</nameWell>
    <nameWellbore>${esc(h.rig || 'AHWR-50')}</nameWellbore>
    <name>Edge time log</name>
    <serviceCompany>ONGC Instrumentation</serviceCompany>
    <indexType>date time</indexType>
    <startDateTimeIndex>${esc(start)}</startDateTimeIndex>
    <endDateTimeIndex>${esc(end)}</endDateTimeIndex>
    <direction>increasing</direction>
    <indexCurve>TIME</indexCurve>
${curves}
    <logData>
      <mnemonicList>${mnemonicList}</mnemonicList>
      <unitList>${unitList}</unitList>
${rows}
    </logData>
  </log>
</logs>`;
}

module.exports = { wells, logs, CHANNELS };
