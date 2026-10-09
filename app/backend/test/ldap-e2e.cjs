'use strict';
// End-to-end test of the Windows-domain (LDAP/AD) login path WITHOUT a live
// Domain Controller. We inject a simulated `ldapts` client that mimics AD
// (sAMAccountName / userPrincipalName / memberOf, service-account search + user
// re-bind), then boot the real backend and drive it over HTTP. This validates
// the authenticate() orchestration, group->role mapping, JIT provisioning, JWT
// issuance, AUTH_MODE routing and the local break-glass account.
const http = require('http');
const Module = require('module');

// --- simulated directory ---------------------------------------------------
const SUFFIX = 'dc=corp,dc=example,dc=com';
const SERVICE = { dn: `cn=svc,${SUFFIX}`, pw: 'svcpass' };
const USERS = [
    { sam: 'jdoe', dn: `cn=jdoe,ou=users,${SUFFIX}`, upn: 'jdoe@corp.example.com', pw: 'Passw0rd!', display: 'John Doe', memberOf: [`CN=RigOperators,OU=Groups,${SUFFIX}`] },
    { sam: 'agreen', dn: `cn=agreen,ou=users,${SUFFIX}`, upn: 'agreen@corp.example.com', pw: 'AdminPass1', display: 'Anna Green', memberOf: [`CN=RigAdmins,OU=Groups,${SUFFIX}`] },
    { sam: 'vsmith', dn: `cn=vsmith,ou=users,${SUFFIX}`, upn: 'vsmith@corp.example.com', pw: 'ViewPass1', display: 'Vic Smith', memberOf: [] },
];
const norm = (dn) => String(dn).toLowerCase().replace(/,\s+/g, ',');

class FakeClient {
    async startTLS() {}
    async bind(dn, pw) {
        if (norm(dn) === norm(SERVICE.dn)) { if (pw !== SERVICE.pw) throw new Error('InvalidCredentials'); return; }
        const u = USERS.find((x) => norm(dn) === norm(x.dn) || dn === x.upn);
        if (!u || pw !== u.pw) throw new Error('InvalidCredentials');
    }
    async search(base, opts) {
        const m = /(?:sAMAccountName|userPrincipalName|uid)=([^)]+)/i.exec(opts.filter || '');
        const val = m ? m[1] : '';
        const u = USERS.find((x) => x.sam === val || x.upn === val);
        if (!u) return { searchEntries: [], searchReferences: [] };
        return { searchEntries: [{ dn: u.dn, distinguishedName: u.dn, sAMAccountName: u.sam, userPrincipalName: u.upn, displayName: u.display, cn: u.sam, memberOf: u.memberOf }], searchReferences: [] };
    }
    async unbind() {}
}

// Intercept require('ldapts') before the backend loads it.
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'ldapts') return { Client: FakeClient };
    return origLoad.apply(this, arguments);
};

// --- backend env (service-account search mode) -----------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ahwr-ldap-'));
Object.assign(process.env, {
    AUTH_MODE: 'both',
    LDAP_URL: 'ldap://fake-dc:389',
    LDAP_BIND_DN: SERVICE.dn,
    LDAP_BIND_PASSWORD: SERVICE.pw,
    LDAP_SEARCH_BASE: SUFFIX,
    LDAP_DOMAIN: 'corp.example.com',
    LDAP_ROLE_ADMIN: 'RigAdmins',
    LDAP_ROLE_OPERATOR: 'RigOperators',
    LDAP_DEFAULT_ROLE: 'viewer',
    JWT_SECRET: 'testsecret_testsecret_1234567890',
    INFLUX_TOKEN: 'dummy',
    DATA_DIR,
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'LocalAdminPass1',
    PORT: '5097',
    POLL_INTERVAL_MS: '999999', // effectively pause Influx polling during the test
});

require('../server.js');

const BASE = 'http://127.0.0.1:5097';
const post = (pathname, body) => new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request(`${BASE}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', () => resolve({ status: 0, body: {} }));
    req.end(data);
});
const get = (pathname) => new Promise((resolve) => {
    http.get(`${BASE}${pathname}`, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') })); }).on('error', () => resolve({ status: 0, body: {} }));
});

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); } };

setTimeout(async () => {
    const info = await get('/api/auth/info');
    check('auth/info reports ldap enabled', info.body.ldapEnabled === true && info.body.authMode === 'both', JSON.stringify(info.body));

    const op = await post('/api/login', { username: 'jdoe', password: 'Passw0rd!' });
    check('operator login -> role operator + token', op.body.success && op.body.user.role === 'operator' && !!op.body.token, JSON.stringify(op.body));

    const ad = await post('/api/login', { username: 'agreen', password: 'AdminPass1' });
    check('admin group -> role admin', ad.body.success && ad.body.user.role === 'admin', JSON.stringify(ad.body));

    const vw = await post('/api/login', { username: 'vsmith', password: 'ViewPass1' });
    check('no group -> default role viewer', vw.body.success && vw.body.user.role === 'viewer', JSON.stringify(vw.body));

    const dom = await post('/api/login', { username: 'CORP\\jdoe', password: 'Passw0rd!' });
    check('DOMAIN\\user form works', dom.body.success && dom.body.user.role === 'operator', JSON.stringify(dom.body));

    const upn = await post('/api/login', { username: 'jdoe@corp.example.com', password: 'Passw0rd!' });
    check('UPN form works', upn.body.success && upn.body.user.role === 'operator', JSON.stringify(upn.body));

    const bad = await post('/api/login', { username: 'jdoe', password: 'wrong' });
    check('wrong password -> 401', bad.status === 401 && !bad.body.success, JSON.stringify(bad.body));

    const local = await post('/api/login', { username: 'admin', password: 'LocalAdminPass1' });
    check('local break-glass admin still works in both-mode', local.body.success && local.body.user.role === 'admin' && local.body.user.source === undefined, JSON.stringify(local.body));

    const stored = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json')));
    const jdoeRec = stored.find((u) => u.username === 'jdoe');
    check('LDAP user JIT-provisioned with source=ldap and no password', !!jdoeRec && jdoeRec.source === 'ldap' && !('password' in jdoeRec), JSON.stringify(jdoeRec));

    console.log(`\n${fail === 0 ? 'ALL PASS' : 'SOME FAILED'} — ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}, 800);
