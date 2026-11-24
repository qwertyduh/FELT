#!/usr/bin/env node
// Writes the public web env from the local Supabase stack into apps/web/.env.local
// (gitignored via `.env.*`, mode 0600). Never prints the key.
//
//   supabase start && npm run env:local -w apps/web
//
// `supabase status -o env` names (CLI 2.x): API_URL, ANON_KEY (JWT) and PUBLISHABLE_KEY
// (`sb_publishable_...`). We use ANON_KEY and fall back to PUBLISHABLE_KEY.
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { chmodSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const target = resolve(here, '../.env.local');

const run = spawnSync('supabase', ['status', '-o', 'env'], { cwd: repoRoot, encoding: 'utf8' });
if (run.error || run.status !== 0) {
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
const key = vars.get('ANON_KEY') || vars.get('PUBLISHABLE_KEY');
if (!url || !key) {
  process.stderr.write('API_URL and ANON_KEY (or PUBLISHABLE_KEY) not found in the CLI output.\n');
  process.exit(1);
}

writeFileSync(
  target,
  `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${key}\nVITE_SERVER_URL=http://127.0.0.1:3001\n`,
  { mode: 0o600 },
);
chmodSync(target, 0o600);
process.stdout.write(
  `Wrote VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and VITE_SERVER_URL to ${target}\n`,
);
