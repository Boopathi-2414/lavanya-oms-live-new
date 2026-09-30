// Checks .env BEFORE the app starts, so a missing or wrong value is
// reported in plain words instead of the login page's
// "Missing database configuration." Values are never printed.
import { readFileSync, existsSync } from 'node:fs';

const say = (m) => console.log(m);
if (!existsSync('.env')) {
  if (existsSync('.env.txt')) say('ERROR: File is named ".env.txt". Rename it to ".env" (no .txt).');
  else say('ERROR: .env file not found in this folder. Run SETUP_ENV.cmd.');
  process.exit(1);
}
const env = {};
for (const raw of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const i = line.indexOf('=');
  if (i < 0) continue;
  const k = line.slice(0, i).trim();
  let v = line.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[k] = v;
}
const errors = [];
const url = env.VITE_SUPABASE_URL || '';
const key = env.VITE_SUPABASE_ANON_KEY || '';
const uid = env.VITE_AUTHORIZED_UID || '';
const mode = env.VITE_ENVIRONMENT || '';
if (!url) errors.push('VITE_SUPABASE_URL is empty.');
else if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/i.test(url)) errors.push('VITE_SUPABASE_URL must look like https://abcdefgh.supabase.co');
else if (/YOUR_PROJECT/i.test(url)) errors.push('VITE_SUPABASE_URL still has the example value.');
if (!key) errors.push('VITE_SUPABASE_ANON_KEY is empty.');
else if (/YOUR_PUBLISHABLE_KEY/i.test(key)) errors.push('VITE_SUPABASE_ANON_KEY still has the example value.');
else if (key.length < 30) errors.push('VITE_SUPABASE_ANON_KEY looks too short — copy the full key.');
else if (/service_role|sb_secret_/i.test(key)) errors.push('VITE_SUPABASE_ANON_KEY is a SECRET key. Use the publishable / anon key only.');
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uid)) errors.push('VITE_AUTHORIZED_UID is missing or not a valid UUID.');
if (!['test', 'production'].includes(mode)) errors.push('VITE_ENVIRONMENT must be "test" or "production".');
if (errors.length) {
  say('.env has problems:');
  errors.forEach((e) => say('  - ' + e));
  say('Fix them (or run SETUP_ENV.cmd), then start again.');
  process.exit(1);
}
const ref = url.replace(/^https:\/\//i, '').split('.')[0];
say(`.env check passed: project ${ref}, environment ${mode}.`);
if (mode === 'test' && ref !== 'jfynrmusohnbsmlhainm')
  say(`WARNING: this TEST build expects project jfynrmusohnbsmlhainm, but .env points to ${ref}. Make sure this is NOT your live business database.`);
