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

## Env var names

- **Railway `server`:** `NODE_ENV=production`, `HOST=0.0.0.0`, `LOG_LEVEL=info`, `PORT` (injected by Railway), `REDIS_URL` (reference `${{Redis.REDIS_URL}}`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (secret), `WEB_ORIGIN` (comma-separated exact origins, no trailing slash), `RAILWAY_DOCKERFILE_PATH=apps/server/Dockerfile`. Optional: `TRUST_PROXY` (defaults to true in production, false elsewhere), `SUPABASE_JWKS_URL`.
- **Vercel `felt` (Production):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (public), `VITE_SERVER_URL`. Vite inlines these at build time, so redeploy after changing them.

## Notes

- Changing the Vercel URL or adding a custom domain means updating `WEB_ORIGIN` on Railway (the server restarts on a variable change).
- Supabase auth `site_url` is still `http://localhost:3000` (unused by anonymous sign-in); set it when email or Google auth is added.
- `railway.json` is deprecated by Railway ("keeps working until 2026-12-01"); migrate with `railway config migrate` when convenient. `RAILWAY_DOCKERFILE_PATH` keeps the Dockerfile selection working regardless.
- Rate limits are in-process; move them to Redis before running more than one server replica.
