// GO-LIVE PREFLIGHT — read-only database check, run on your own computer.
//   node scripts/preflight.mjs
// Uses only the public (publishable) key from .env and your login.
// Never prints keys or passwords. Changes NO orders, payments or products.
// The only write is one temporary row in oms_business_records, deleted at once.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { createClient } from '@supabase/supabase-js';

const out = [];
const say = (m = '') => { console.log(m); out.push(m); };
const PASS = 'PASS ', FAIL = 'FAIL ', WARN = 'WARN ';
let fails = 0, warns = 0;
const pass = (m) => say(PASS + m);
const fail = (m) => { fails++; say(FAIL + m); };
const warn = (m) => { warns++; say(WARN + m); };

if (!existsSync('.env')) { console.log('FAIL .env not found in this folder. Run SETUP_ENV.cmd first.'); process.exit(1); }
const env = {};
for (const raw of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const line = raw.trim(); if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('='); if (i < 0) continue;
  let v = line.slice(i + 1).trim();
  if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
  env[line.slice(0, i).trim()] = v;
}
const URL_ = env.VITE_SUPABASE_URL?.replace(/\/$/, '');
const KEY = env.VITE_SUPABASE_ANON_KEY;
const UID = env.VITE_AUTHORIZED_UID;
const MODE = env.VITE_ENVIRONMENT;
if (!URL_ || !KEY) { console.log('FAIL .env is missing URL or key. Run SETUP_ENV.cmd.'); process.exit(1); }
const ref = URL_.replace(/^https:\/\//, '').split('.')[0];

const TABLES = ['oms_orders', 'oms_payments', 'oms_products', 'oms_trash', 'oms_fraud_list',
  'oms_business_records', 'customer_profiles', 'oms_reconciliation_history'];
const REQUIRED = new Set(['oms_orders', 'oms_payments', 'oms_products', 'oms_trash', 'oms_fraud_list', 'oms_business_records']);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let muted = false;
rl._writeToOutput = function (str) { if (!muted) rl.output.write(str); else if (/[\r\n]/.test(str)) rl.output.write('\n'); };
const lines = [], waiters = [];
rl.on('line', (l) => { muted = false; waiters.length ? waiters.shift()(l.trim()) : lines.push(l.trim()); });
rl.on('close', () => { while (waiters.length) waiters.shift()(''); });
function ask(q, hidden = false) {
  process.stdout.write(q);
  if (lines.length) return Promise.resolve(lines.shift());
  muted = hidden;
  return new Promise((res) => waiters.push(res));
}
async function counts(client) {
  const r = {};
  for (const t of TABLES) {
    const { count, error, status } = await client.from(t).select('id', { count: 'exact' }).limit(1);
    r[t] = error ? { error: `${error.code || ''} ${error.message || ''}`.trim() || `HTTP ${status}` } : { count: count ?? 0 };
  }
  return r;
}
const fmt = (x) => x.error ? `error ${x.error.slice(0, 5)}` : String(x.count);

say('LAVANYA OMS — GO-LIVE PREFLIGHT');
say(`Date: ${new Date().toISOString()}   Project: ${ref}   Environment in .env: ${MODE}`);
say('');

// 1. Reachability
try {
  const r = await fetch(`${URL_}/auth/v1/health`, { headers: { apikey: KEY } });
  r.ok ? pass('Supabase project is reachable') : fail(`Supabase answered HTTP ${r.status} — URL or key is wrong`);
} catch (e) { fail('Cannot reach Supabase — check internet / URL'); }

// 2. Anonymous access (no login) — should be CLOSED for customer data
const anon = createClient(URL_, KEY, { auth: { persistSession: false } });
const a = await counts(anon);

// 3. Login
say('');
const email = await ask('OMS login email: ');
const password = await ask('OMS password (hidden): ', true);
rl.close();
const user = createClient(URL_, KEY, { auth: { persistSession: false } });
const { data: login, error: loginErr } = await user.auth.signInWithPassword({ email, password });
say('');
if (loginErr) {
  fail(`Login failed: ${loginErr.message}`);
  say('      Fix: Supabase > Authentication > Users — this email must exist in THIS project, password must match.');
} else {
  pass('Login works for this email');
  const id = login.user.id;
  if (id === UID) pass('VITE_AUTHORIZED_UID in .env matches this login');
  else {
    fail('VITE_AUTHORIZED_UID in .env does NOT match this login -> app will say "not authorised"');
    say(`      Put this value in .env as VITE_AUTHORIZED_UID:  ${id}`);
  }
}

// 4. Tables with login
say('');
const u = loginErr ? null : await counts(user);
say('Table                         no-login     logged-in');
for (const t of TABLES) say(`${t.padEnd(30)}${fmt(a[t]).padEnd(13)}${u ? fmt(u[t]) : '-'}`);
say('');
for (const t of TABLES) {
  const x = u?.[t];
  if (!x) continue;
  const missing = /42P01|does not exist|Could not find the table/i.test(x.error || '');
  if (missing) (REQUIRED.has(t) ? fail : warn)(`${t}: table missing${t === 'oms_business_records' ? ' -> run deploy/000_new_project_setup.sql (with THIS project\'s UID)' : ''}`);
  else if (x.error) (REQUIRED.has(t) ? fail : warn)(`${t}: logged-in user cannot read (${x.error.slice(0, 80)}) -> RLS policy must allow "authenticated"`);
  else if (a[t] && !a[t].error && a[t].count > 0 && x.count === 0) fail(`${t}: no-login sees ${a[t].count} rows but logged-in sees 0 -> RLS allows only anon; app would show EMPTY`);
  else pass(`${t}: logged-in can read (${x.count} rows)`);
}
const openTables = TABLES.filter((t) => a[t] && !a[t].error && a[t].count > 0);
if (openTables.length) warn(`Without login anyone with the public key can read: ${openTables.join(', ')}. Lock these after go-live (deploy/002_lock_tables.sql).`);
else pass('Customer data is not readable without login');

// 5. Write test — business records only, removed immediately
if (u && !u.oms_business_records?.error) {
  const id = `preflight-${Date.now()}`;
  const ins = await user.from('oms_business_records').insert({ id, data: { type: 'preflight' } });
  if (ins.error) fail(`Cannot save to oms_business_records (${ins.error.message}) -> check UID inside the SQL policy`);
  else {
    const del = await user.from('oms_business_records').delete().eq('id', id);
    del.error ? warn(`Test row ${id} could not be deleted; delete it in Table Editor`) : pass('Saving works (test row written and removed)');
  }
}
// Grant check on orders without changing anything (matches no row)
if (u && !u.oms_orders?.error) {
  const up = await user.from('oms_orders').update({ updated_at: new Date().toISOString() }).eq('id', '__preflight_no_such_row__');
  up.error ? fail(`Logged-in user has no UPDATE permission on oms_orders (${up.error.message}) -> scans would not save`) : pass('Update permission on oms_orders is granted');
}

if (MODE !== 'production') warn('VITE_ENVIRONMENT is "test". For the live site set it to production and rebuild.');
say('');
say(fails ? `RESULT: ${fails} FAIL, ${warns} WARN — do NOT go live yet. Send this report to Claude.` : `RESULT: ALL REQUIRED CHECKS PASSED (${warns} warnings).`);
writeFileSync('PREFLIGHT_REPORT.txt', out.join('\r\n'));
console.log('\nSaved: PREFLIGHT_REPORT.txt  (contains no keys or passwords — safe to send)');
process.exit(fails ? 1 : 0);
