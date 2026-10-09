'use strict';
// Small atomic-JSON persistence helper shared by the workover feature modules.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const full = (file) => path.join(DATA_DIR, file);

const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(full(file))); } catch { return fallback; }
};
const writeJson = async (file, obj) => {
    const tmp = `${full(file)}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fsp.rename(tmp, full(file));
};
const writeJsonSync = (file, obj) => {
    const tmp = `${full(file)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, full(file));
};
// Resolve a dotted path like "drawworks.hook_load" against the rig-data object.
const resolvePath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

module.exports = { DATA_DIR, full, readJson, writeJson, writeJsonSync, resolvePath };
