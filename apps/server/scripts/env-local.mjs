#!/usr/bin/env node
// Writes ONLY SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the local Supabase stack into
// apps/server/.env.local (gitignored via `.env.*`, mode 0600). Never prints the key.
//
//   supabase start && npm run env:local -w apps/server
//
// `supabase status -o env` names (CLI 2.x): API_URL, SERVICE_ROLE_KEY (a JWT with role
// service_role) and SECRET_KEY (the newer opaque `sb_secret_...` key). We use SERVICE_ROLE_KEY and
// fall back to SECRET_KEY only when the older name is absent (future CLIs).
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { chmodSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..'); // `supabase/` lives at the repo root
const target = resolve(here, '../.env.local');

const run = spawnSync('supabase', ['status', '-o', 'env'], {
  cwd: repoRoot,
  encoding: 'utf8',
});
if (run.error || run.status !== 0) {
  // stderr from the CLI never contains the keys; stdout (which does) is not echoed.
  process.stderr.write(
    '`supabase status -o env` failed. Is the local stack running (`supabase start`)?\n',
  );
  if (run.stderr) process.stderr.write(`${run.stderr.trim().split('\n').slice(0, 3).join('\n')}\n`);
  process.exit(1);
}

const vars = new Map();
for (const line of run.stdout.split('\n')) {
  const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
  if (m) vars.set(m[1], m[2]);
}
const url = vars.get('API_URL');
const key = vars.get('SERVICE_ROLE_KEY') || vars.get('SECRET_KEY');
if (!url || !key) {
  process.stderr.write(
    'API_URL and SERVICE_ROLE_KEY (or SECRET_KEY) not found in the CLI output.\n',
  );
  process.exit(1);
}

writeFileSync(target, `SUPABASE_URL=${url}\nSUPABASE_SERVICE_ROLE_KEY=${key}\n`, { mode: 0o600 });
chmodSync(target, 0o600);
process.stdout.write(`Wrote SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to ${target}\n`);
