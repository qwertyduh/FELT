# FELT

Mobile-first PWA for playing No-Limit Texas Hold'em with friends. Three modes:
- **Online:** the app deals.
- **Hybrid:** real cards; the app tracks bets. Every player is on their own phone, and the host advances streets and awards pots.
- **Practice:** a tutorial, then practice hands vs bots. Runs fully in the browser.

Private rooms only: the host approves every join, sets the minimum buy-in, and approves top-ups. Chips are per-game; nothing persists except usernames and shared recaps. Sign-in is guest-only in v1 (anonymous Supabase session + unique username); Google is deferred.

- Product spec: `docs/PRD.md`
- Technical spec: `docs/ARCHITECTURE.md` (stack, module boundaries, socket protocol, data model)
- **Build plan: `docs/PLAN.md`.** Work happens one phase at a time. Follow the agent rules at the top of that file.
- `DESIGN.md` is the superseded v1 plan. Don't follow it where it conflicts with `docs/`.

## Status
Pre-scaffold. Check `docs/PLAN.md` for which phases are done. The commands below are planned; update this file once they exist.

## Layout (npm workspaces)
- `apps/web`: Vite + React + TS + Tailwind + Zustand PWA (Vercel)
- `apps/server`: Fastify + Socket.io (Docker on Railway, with Railway Redis)
- `packages/engine`: pure poker logic
- `packages/bots`: pure bot strategies, hints and explanations
- `packages/protocol`: shared types + Zod schemas for REST and socket events
- `supabase/migrations`: SQL migrations

## Commands (planned)
```bash
npm install
docker compose up -d redis       # local Redis
npm run dev                      # web + server
npm test                         # vitest across workspaces
npm run test -w packages/engine  # engine only
npm run e2e                      # playwright
npm run typecheck && npm run lint
```

## Rules that matter
- **`packages/engine` and `packages/bots` are pure.** No Node/browser APIs, no I/O, no timers, no `Math.random` (RNG is injected). Every rule change needs a unit test. Side pots and min-raise logic are the riskiest code in the repo.
- **Server-authoritative multiplayer.** Clients send intents; only the server applies rules. Practice mode is the only place the client runs the engine.
- **Hole cards never leak.** Other players' cards and the deck go out only via `hand:private` to their owner. Every `room:state` payload goes through the single public-state builder.
- **Admission gates everything.** No room state or room events reach a socket until the host admits that user.
- **One serial queue per room.** All state changes go through the room's `RoomActor` queue: player actions, host actions, join and top-up requests, timer expiry.
- **Protocol changes start in `packages/protocol`.** Add the Zod schema + type first; client and server import from there. Validate every incoming socket payload.
- **Usernames are written only by the server** (service role) after the format → reserved → profanity → uniqueness pipeline. The client-side check is UX only.
- **Timers use absolute deadlines** (epoch ms) stored in state, so they survive restarts.
- **Chips are integers.** Every chip change outside play (buy-in, top-up, adjust) is a ledger entry.
- Mobile-first UI: design for a ~375px portrait viewport first, with actions reachable one-handed. The hand-rank button must never cover the action bar.
- Secrets: the Supabase service-role key is server-only. Never commit `.env`.

## Deploy
- Web → Vercel (`vercel` CLI). Vercel can't host the WebSocket server.
- Server + Redis → Railway (`railway` CLI).
- Auth/DB → Supabase (`supabase` CLI). Provider: anonymous (Google deferred).
