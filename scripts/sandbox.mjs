#!/usr/bin/env node
// The Docker-built server plus Redis, connected to the LOCAL Supabase stack.
//
//   npm run sandbox:up | sandbox:down | sandbox:logs
//
// Keys come from `supabase status` and go to apps/server/.env.sandbox (gitignored, mode 0600);
// they are never printed. The root .env is not read, and `--env-file` stops Compose reading it.
// Optional: SANDBOX_PORT (default 3001), SANDBOX_WEB_ORIGIN (comma-separated).
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(root, 'apps/server/.env.sandbox');
const port = Number(process.env.SANDBOX_PORT || 3001);
const webOrigin = process.env.SANDBOX_WEB_ORIGIN || 'http://localhost:5173,http://localhost:4173';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** `--env-file /dev/null` replaces Compose's default of reading `.env` from the project folder. */
function compose(args) {
  const run = spawnSync(
    'docker',
    [
      'compose',
      // Explicit, so a shell COMPOSE_PROJECT_NAME cannot point `down -v` at another project.
      '-p',
      'felt-sandbox',
      '--env-file',
      '/dev/null',
      '-f',
      'docker-compose.sandbox.yml',
      ...args,
    ],
    { cwd: root, stdio: 'inherit', env: { ...process.env, SANDBOX_PORT: String(port) } },
  );
  if (run.error) fail(`Could not run docker: ${run.error.message}`);
  return run.status ?? 1;
}

function localSupabase() {
  const run = spawnSync('supabase', ['status', '-o', 'env'], { cwd: root, encoding: 'utf8' });
  if (run.error || run.status !== 0) {
    // stdout holds the keys, so only stderr is ever echoed.
    fail(
      '`supabase status -o env` failed. Is the local stack running (`supabase start`)?\n' +
        (run.stderr ?? '').trim().split('\n').slice(0, 3).join('\n'),
    );
  }
  const vars = new Map();
  for (const line of run.stdout.split('\n')) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m) vars.set(m[1], m[2]);
  }
  const url = vars.get('API_URL');
  const key = vars.get('SERVICE_ROLE_KEY') || vars.get('SECRET_KEY');
  if (!url || !key) fail('API_URL and SERVICE_ROLE_KEY (or SECRET_KEY) not found.');
  if (!URL.canParse(url) || !LOCAL_HOSTS.has(new URL(url).hostname)) {
    fail('Refusing to run: the Supabase URL from `supabase status` is not local.');
  }
  return { url: url.replace(/\/+$/, ''), key };
}

const answers = (host) =>
  new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (up) => {
      socket.destroy();
      done(up);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });

/** A dev server left running would silently take the traffic meant for the container. */
async function assertPortFree() {
  const ours = spawnSync(
    'docker',
    ['ps', '-q', '-f', 'label=com.docker.compose.project=felt-sandbox', '-f', `publish=${port}`],
    { encoding: 'utf8' },
  );
  if (ours.stdout?.trim()) return; // an earlier sandbox: Compose replaces it
  if ((await answers('127.0.0.1')) || (await answers('::1'))) {
    fail(
      `Port ${port} is in use. Stop the dev server first (Ctrl+C in its terminal, or\n` +
        `  kill $(lsof -ti tcp:${port} -sTCP:LISTEN)\n` +
        'or pick another port: SANDBOX_PORT=3002 npm run sandbox:up',
    );
  }
}

async function up() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('SANDBOX_PORT is not a port.');
  const { url, key } = localSupabase();
  await assertPortFree();
  // Inside the container this machine is host.docker.internal. SUPABASE_URL keeps the address
  // the browser uses, because that is the issuer written into the tokens.
  const internal = new URL(url);
  internal.hostname = 'host.docker.internal';
  const api = internal.href.replace(/\/+$/, '');
  const lines = [
    'LOCAL_SANDBOX=true',
    `SUPABASE_URL=${url}`,
    `SUPABASE_API_URL=${api}`,
    `SUPABASE_JWKS_URL=${api}/auth/v1/.well-known/jwks.json`,
    `SUPABASE_SERVICE_ROLE_KEY=${key}`,
    `WEB_ORIGIN=${webOrigin}`,
  ];
  writeFileSync(envFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(envFile, 0o600);

  // `--wait` returns once /ready is healthy.
  if (compose(['up', '-d', '--build', '--wait', '--wait-timeout', '90']) !== 0) {
    compose(['logs', '--tail', '30', 'server']);
    fail('The sandbox did not become ready. Stop it with `npm run sandbox:down`.');
  }
  process.stdout.write(
    `Sandbox ready: http://localhost:${port} (Redis container felt-sandbox-redis-1)\n`,
  );
}

const action = process.argv[2];
if (action === 'up') await up();
// `-v`: the sandbox's Redis is disposable.
else if (action === 'down') process.exit(compose(['down', '-v', '--remove-orphans']));
else if (action === 'logs') process.exit(compose(['logs', '-f', 'server']));
else fail('Usage: node scripts/sandbox.mjs up|down|logs');
