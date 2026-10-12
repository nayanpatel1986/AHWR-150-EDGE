'use strict';
// AHWR edge backend entry point.
//
// Operating records (users, work orders, alarm settings, well registry, …) live
// in the database (app.documents). They are loaded before the application
// modules start, because those modules read their records when they load.
// Until the database answers, this waits and retries rather than starting on
// stale or empty records.
//
// PERSIST_BACKEND=file keeps records as JSON files in DATA_DIR instead
// (tests and development only).
require('dotenv').config();
const persist = require('./lib/persist');

const RETRY_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function loadRecords() {
    if ((process.env.PERSIST_BACKEND || 'db').toLowerCase() === 'file') {
        console.warn('PERSIST_BACKEND=file: operating records are JSON files in DATA_DIR (not for production).');
        return;
    }
    if (!process.env.PGPASSWORD) {
        console.error('FATAL: PGPASSWORD (the ahwr_app database password) is required. Refusing to start.');
        process.exit(1);
    }
    const tsdb = require('./lib/tsdb');
    for (let attempt = 1; ; attempt++) {
        try {
            const result = await persist.init(tsdb.pool);
            console.log(`Operating records loaded from the database (${result.documents} documents`
                + `${result.imported.length ? `, imported ${result.imported.length} JSON file(s)` : ''}).`);
            return;
        } catch (err) {
            console.error(`Operating records unavailable (attempt ${attempt}): ${err.message}. `
                + 'Check PostgreSQL and that app/sql/02-schema.sql has been applied. Retrying...');
            await sleep(RETRY_MS);
        }
    }
}

loadRecords().then(() => require('./app'));
