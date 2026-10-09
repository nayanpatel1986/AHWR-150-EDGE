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
// Unique temp name per write: a shared `<file>.<pid>.tmp` let two overlapping
// writes interleave into one temp file (corrupt JSON) or fail the second rename.
let tmpSeq = 0;
const tmpPath = (target) => `${target}.${process.pid}.${Date.now()}.${++tmpSeq}.tmp`;

// Writes to the same path are chained so they land in call order.
const writeChains = new Map();
const writeJsonFile = (target, obj) => {
    const body = JSON.stringify(obj, null, 2); // snapshot now, not when the chain runs
    const prev = writeChains.get(target) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
        const tmp = tmpPath(target);
        try {
            await fsp.writeFile(tmp, body);
            await fsp.rename(tmp, target);
        } catch (err) {
            fsp.unlink(tmp).catch(() => {});
            throw err;
        }
    });
    writeChains.set(target, run);
    run.finally(() => { if (writeChains.get(target) === run) writeChains.delete(target); }).catch(() => {});
    return run;
};
const writeJson = (file, obj) => writeJsonFile(full(file), obj);
const writeJsonSync = (file, obj) => {
    const tmp = tmpPath(full(file));
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, full(file));
};
// Resolve a dotted path like "drawworks.hook_load" against the rig-data object.
const resolvePath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

module.exports = { DATA_DIR, full, readJson, writeJson, writeJsonFile, writeJsonSync, resolvePath };
