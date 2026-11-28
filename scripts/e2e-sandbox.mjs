#!/usr/bin/env node
// The Playwright suite against the Docker sandbox server. Extra arguments go to Playwright:
//
//   npm run sandbox:up && npm run e2e:sandbox [-- online-game]
//
// It never starts a game server: without the sandbox it stops here. The web dev server on 5173
// is reused, or started if none is running. The root .env is not read.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The specs address the server at port 3001.
const PORT = 3001;

function fail(message) {
  process.stderr.write(`e2e:sandbox: ${message}\n`);
  process.exit(1);
}

const container = spawnSync(
  'docker',
  [
    'ps',
    '-q',
    '-f',
    'label=com.docker.compose.project=felt-sandbox',
    '-f',
    'label=com.docker.compose.service=server',
    '-f',
    `publish=${PORT}`,
  ],
  { encoding: 'utf8' },
);
if (container.error || container.status !== 0) fail('could not ask Docker. Is it running?');
if (!container.stdout.trim()) {
  fail(`the sandbox is not up on port ${PORT}. Run \`npm run sandbox:up\` first.`);
}
const ready = await globalThis
  .fetch(`http://127.0.0.1:${PORT}/ready`, {
    signal: globalThis.AbortSignal.timeout(5000),
  })
  .then(
    (res) => res.ok,
    () => false,
  );
if (!ready) fail('the sandbox is not ready. See `npm run sandbox:logs`.');

// The sandbox listens on 127.0.0.1 only, so anything on ::1 would take the `localhost` traffic.
const shadowed = await new Promise((done) => {
  const socket = connect({ host: '::1', port: PORT });
  const finish = (up) => {
    socket.destroy();
    done(up);
  };
  socket.setTimeout(1000, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});
if (shadowed) fail(`another server answers on [::1]:${PORT}. Stop it first.`);

// The web app must talk to the local stack, never to a deployment.
let env;
try {
  env = readFileSync(resolve(root, 'apps/web/.env.local'), 'utf8');
} catch {
  fail('apps/web/.env.local is missing. Run `npm run env:local -w apps/web`.');
}
for (const name of ['VITE_SERVER_URL', 'VITE_SUPABASE_URL']) {
  const value = process.env[name] ?? new RegExp(`^${name}=(.*)$`, 'm').exec(env)?.[1]?.trim();
  if (
    !value ||
    !URL.canParse(value) ||
    !['localhost', '127.0.0.1'].includes(new URL(value).hostname)
  )
    fail(`${name} for the web app is not local. Run \`npm run env:local -w apps/web\`.`);
}

const run = spawnSync(
  'npx',
  ['playwright', 'test', '-c', 'apps/web/playwright.config.ts', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit', env: { ...process.env, E2E_SANDBOX: '1' } },
);
process.exit(run.status ?? 1);
