import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer required; install Node.js 22.');
  let dir = dirname(require.resolve('@supabase/supabase-js'));
  while (!existsSync(join(dir, 'package.json'))) { const parent = dirname(dir); if (parent === dir) throw new Error('SDK package metadata missing'); dir = parent; }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  if (pkg.version !== lock.packages['node_modules/@supabase/supabase-js'].version) throw new Error('SDK version differs from lockfile');
  for (const field of ['main', 'module']) if (pkg[field] && !existsSync(join(dir, pkg[field]))) throw new Error(`Missing SDK ${field} file`);
  const sdk = await import('@supabase/supabase-js');
  if (typeof sdk.createClient !== 'function') throw new Error('SDK createClient export missing');
  console.log(`Installation check passed: Supabase ${pkg.version}, Node ${process.versions.node}`);
} catch (error) {
  console.error('Installation check failed:', error.message);
  console.error('Close the dev server and run REPAIR_WINDOWS.cmd.');
  process.exit(1);
}
