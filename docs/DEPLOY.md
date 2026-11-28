# Deploy

No secrets in this file. Secrets live only in Railway, Vercel and Supabase.

## Production resources

| Piece | Where | Name / id | URL |
|---|---|---|---|
| Web | Vercel | project `felt` (`prj_hRxwLk1P1AmA3jIh9gVpGwphvcX7`) | https://felt-rosy-sigma.vercel.app (alias: https://felt-qwertyduhs-projects.vercel.app) |
| Game server | Railway | project `felt` (`aa4bf14b-6e69-4050-a086-aabc668a2906`), service `server`, env `production` | https://server-production-1b135132.up.railway.app |
| Redis | Railway | service `Redis` (same project) | private only: `redis.railway.internal` |
| Auth + DB | Supabase | project `felt`, ref `zhggexxpffjbpunnchuk`, region ap-south-1 | https://zhggexxpffjbpunnchuk.supabase.co |

Supabase signs tokens with ES256 (JWT signing keys); JWKS is at `<url>/auth/v1/.well-known/jwks.json`. Anonymous sign-ins are on, Google is off.

## Render (free option)

`render.yaml` at the repo root creates `felt-server` (Docker, free) and `felt-redis` (free Key Value) in Singapore: Render dashboard, **New > Blueprint**, branch `rebuild`. Render asks for `SUPABASE_SERVICE_ROLE_KEY`. Auto-deploy is off, so deploy by hand ("Manual Deploy"). Free tier: sleeps after 15 min without traffic, and a Redis restart loses live games. Apply pending migrations and point Vercel's `VITE_SERVER_URL` at the Render URL.

## Redeploy

Run from the repo root (the working tree is uploaded; no GitHub link).

```bash
railway up --service server --ci   # builds apps/server/Dockerfile (railway.json + RAILWAY_DOCKERFILE_PATH)
vercel deploy --prod               # uses root vercel.json: npm ci, build apps/web, SPA rewrite
supabase db push                   # applies supabase/migrations to the linked project (supabase link --project-ref zhggexxpffjbpunnchuk)
```

Check after a deploy: `curl -i https://server-production-1b135132.up.railway.app/ready` should return 200 with `"status":"ready"`.

- `/health` is liveness: 200 whenever the process answers (`redis: ok|down` in the body).
- `/ready` is readiness, and Railway's deploy health check (`healthcheckPath` in `railway.json`): 503 while Redis is not ready, or when there is no service-role database client in production. A deploy that never becomes ready within `healthcheckTimeout` (60 s) fails, and the previous one keeps serving. This also means no deploy can succeed while Redis is down. (A missing `SUPABASE_SERVICE_ROLE_KEY` also stops the production server at boot.) It does not test that the key or Supabase actually work.
- Railway calls the health check only while deploying; it is not ongoing monitoring.

## Rooms across a redeploy or rollback

- Old and new server can overlap. A room save only succeeds over the version it was made from; the loser reloads the room and its caller gets a retryable error.
- After a rollback, a record written by the newer server may not parse. It is left untouched (503 on preview, `internal` on socket events) and logged as `stored room record is invalid`. It becomes usable again when the newer build is redeployed, if that happens within its TTL (2 h).

## Local sandbox (production image, local Supabase)

Runs the Docker-built server with its own Redis against the local Supabase stack. Nothing here touches production.

```bash
supabase start
# stop any dev server on 3001 first: Ctrl+C, or kill $(lsof -ti tcp:3001 -sTCP:LISTEN)
npm run sandbox:up      # builds, starts, waits for /ready (http://localhost:3001); rerun after code changes
npm run sandbox:logs
npm run sandbox:down    # stops it and discards its rooms
```

- Keys come from `supabase status` into `apps/server/.env.sandbox` (gitignored). The root `.env` is not used, and the script refuses a non-local Supabase URL.
- `SANDBOX_PORT` and `SANDBOX_WEB_ORIGIN` (default `http://localhost:5173,http://localhost:4173`) override the defaults. Redis has no host port, so the dev Redis is unaffected.
- Web app: run `npm run env:local -w apps/web` once (points at `127.0.0.1:3001`), then `npm run dev -w apps/web`.
- Playwright: with the sandbox up, `npm run e2e:sandbox` (one spec: `npm run e2e:sandbox -- online-game`). It starts no game server and stops with a message if the sandbox is not up; it reuses or starts the web dev server on 5173. Specs assume port 3001. `showdown.spec.ts` is skipped there: it needs a rigged deck, which never goes into the image (see `apps/web/e2e/rig-deck.mjs`; run it with `npm run e2e` against a rigged dev server). Specs are local files, not in the repo.
- Local Supabase allows 30 anonymous sign-ins per hour per IP (`[auth.rate_limit]` in `supabase/config.toml`); long browser runs can hit it.

## Env var names

- **Railway `server`:** `NODE_ENV=production`, `HOST=0.0.0.0`, `LOG_LEVEL=info`, `PORT` (injected by Railway), `REDIS_URL` (reference `${{Redis.REDIS_URL}}`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (secret), `WEB_ORIGIN` (comma-separated exact origins, no trailing slash), `RAILWAY_DOCKERFILE_PATH=apps/server/Dockerfile`. Optional: `TRUST_PROXY` (defaults to true in production, false elsewhere), `SUPABASE_JWKS_URL`, `SUPABASE_API_URL` (where database calls go, if not `SUPABASE_URL`; https). Never set `LOCAL_SANDBOX` on a deployment.
- **Vercel `felt` (Production):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (public), `VITE_SERVER_URL`. Vite inlines these at build time, so redeploy after changing them.

## Notes

- Changing the Vercel URL or adding a custom domain means updating `WEB_ORIGIN` on Railway (the server restarts on a variable change).
- Supabase auth `site_url` is still `http://localhost:3000` (unused by anonymous sign-in); set it when email or Google auth is added.
- `railway.json` is deprecated by Railway ("keeps working until 2026-12-01"); migrate with `railway config migrate` when convenient. `RAILWAY_DOCKERFILE_PATH` keeps the Dockerfile selection working regardless.
- Rate limits are in-process; move them to Redis before running more than one server replica.

## Protocol version rollout
Web and server check a protocol version on connect; on a mismatch the app asks the user to reload. For the first release with this check, deploy web first, then the server. Tabs still running an older bundle have no reload screen and stay on "Reconnecting" until reloaded by hand.

## Releasing and rolling back Stage E
- Order: apply the migration `20261128000000_shared_recaps.sql` to production Supabase, then deploy web and server together (the protocol version changed).
- **Roll the server back only when no rooms are live** (or after flushing Redis). Stored rooms now carry new fields, and an older server refuses a room it cannot read; ended games also lose their recap and share.
- Undoing the migration: `select cron.unschedule('purge-shared-recaps'); drop table public.shared_recaps;`
