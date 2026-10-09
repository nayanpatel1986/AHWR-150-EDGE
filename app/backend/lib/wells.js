'use strict';
// Well registry + lifecycle (plan → start → complete) so telemetry/events/reports are
// scoped BY WELL with logged start/end times. Inputs follow WITSML 1.4.1 well/wellbore +
// the IADC daily-report header (the fields standard EDR/reporting apps capture).
const { readJson, writeJson } = require('./persist');
const workover = require('./workover');

const FILE = 'wells.json';
const SERVICE_TYPES = ['Workover', 'Fishing', 'Completion', 'Snubbing', 'Well Service', 'Other'];
const nowIso = () => new Date().toISOString();
let _seq = 0;
const uid = () => `well_${Date.now().toString(36)}_${(++_seq).toString(36)}`;

let wells = readJson(FILE, null);
if (!Array.isArray(wells)) wells = [];
const persist = () => writeJson(FILE, wells).catch(() => {});

const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const numOrNull = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// WITSML/IADC-style editable fields.
function sanitize(info) {
    const i = info && typeof info === 'object' ? info : {};
    return {
        name: str(i.name) || 'WELL',
        uwi: str(i.uwi, 60),                 // UWI / API number
        field: str(i.field, 80),
        operator: str(i.operator, 80) || 'ONGC',
        rig: str(i.rig, 60) || 'AHWR-50',
        location: str(i.location, 160),       // block / lat-long
        country: str(i.country, 60),
        serviceType: SERVICE_TYPES.includes(i.serviceType) ? i.serviceType : 'Workover',
        jobNo: str(i.jobNo, 60),              // job / AFE number
        objective: str(i.objective, 400),
        companyMan: str(i.companyMan, 80),
        toolpusher: str(i.toolpusher, 80),
        plannedTdM: numOrNull(i.plannedTdM),
        spudDate: str(i.spudDate, 40),
        notes: str(i.notes, 600),
    };
}

const getWells = () => wells.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
const getWell = (id) => wells.find((w) => w.id === id) || null;
const getActiveWell = () => wells.find((w) => w.status === 'active') || null;
const getServiceTypes = () => SERVICE_TYPES;

function createWell(info, user) {
    const rec = { id: uid(), ...sanitize(info), status: 'planned', startedAt: null, completedAt: null, startedBy: null, completedBy: null, summary: null, createdAt: nowIso(), createdBy: user || 'system' };
    wells.push(rec); persist();
    return rec;
}

function updateWell(id, patch, user) {
    const w = getWell(id);
    if (!w) throw Object.assign(new Error('Well not found'), { status: 404 });
    Object.assign(w, sanitize({ ...w, ...patch }), { id: w.id, status: w.status, startedAt: w.startedAt, completedAt: w.completedAt, startedBy: w.startedBy, completedBy: w.completedBy, summary: w.summary, createdAt: w.createdAt });
    w.updatedAt = nowIso(); w.updatedBy = user || 'system';
    persist();
    return w;
}

function startWell(id, user) {
    const w = getWell(id);
    if (!w) throw Object.assign(new Error('Well not found'), { status: 404 });
    if (w.status === 'active') return w;
    const active = getActiveWell();
    if (active && active.id !== id) throw Object.assign(new Error(`Complete the active well "${active.name}" before starting another`), { status: 409 });
    w.status = 'active'; w.startedAt = nowIso(); w.startedBy = user || 'system'; w.completedAt = null; w.summary = null;
    persist();
    return w;
}

function completeWell(id, user) {
    const w = getWell(id);
    if (!w) throw Object.assign(new Error('Well not found'), { status: 404 });
    if (w.status !== 'active') throw Object.assign(new Error('Only an active well can be completed'), { status: 409 });
    w.completedAt = nowIso(); w.completedBy = user || 'system'; w.status = 'complete';
    w.summary = workover.windowSummary(w.startedAt, w.completedAt); // data-by-well: activity/NPT/connections/depth over the window
    persist();
    return w;
}

function deleteWell(id) {
    const index = wells.findIndex((w) => w.id === id);
    if (index < 0) throw Object.assign(new Error('Well not found'), { status: 404 });
    const [removed] = wells.splice(index, 1);
    persist();
    return removed;
}

// Live summary for the active (or any) well — telemetry scoped to its window.
function getWellSummary(id) {
    const w = getWell(id);
    if (!w || !w.startedAt) return null;
    return { well: { id: w.id, name: w.name, status: w.status }, ...workover.windowSummary(w.startedAt, w.completedAt) };
}

// Header for WITSML / reports, derived from the active well (null if none active).
function getHeader() {
    const w = getActiveWell();
    if (!w) return null;
    return { well: w.name, rig: w.rig, operator: w.operator, field: w.field, jobNo: w.jobNo, uwi: w.uwi, serviceType: w.serviceType, contractor: w.operator };
}

module.exports = { getWells, getWell, getActiveWell, getServiceTypes, createWell, updateWell, startWell, completeWell, deleteWell, getWellSummary, getHeader };
