# FELT — Architecture & Tech Spec

**Status:** Draft v2.1 · **Last updated:** 2026-11-24
**Companion to:** [`PRD.md`](./PRD.md) · [`PLAN.md`](./PLAN.md)

---

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Vite + React + TypeScript** | Fast dev loop, static build deploys anywhere |
| Styling | **Tailwind CSS** | Mobile-first utility styling |
| Client state | **Zustand** | Small, works well with socket-driven state |
| PWA | **vite-plugin-pwa** | Manifest, service worker, installability |
| Real-time | **Socket.io** (client + server) | Rooms, acks, auto-reconnect — all needed here |
| Server | **Node.js + Fastify + TypeScript** | REST + hosts the Socket.io server in one process |
| Validation | **Zod** | Validates env, REST bodies, and every socket payload |
| Auth | **Supabase Auth**: anonymous sessions (v1); Google OAuth deferred | One JWT format now and after Google is added |
| Profanity filter | **obscenity** (npm) + reserved-word list | Catches leetspeak/obfuscated spellings |
| Database | **Supabase Postgres** | Usernames + short-lived shared recaps |
| Game state | **Redis** | Room/hand state survives server restarts; Socket.io adapter for scaling later |
| Tests | **Vitest** (unit), **Playwright** (multi-browser E2E) | |
| Local dev | **Docker Compose** (server + Redis) | Supabase is the hosted project, not local |
| Hosting | **Vercel** (web) · **Railway** (server, Docker + Railway Redis) | Vercel can't hold WebSockets, so the game server is hosted separately |

---

## 2. System overview

```
          ┌──────────────────────── Vercel ────────────────────────┐
Phone ───▶│  apps/web  (static PWA: React + Socket.io client)       │
  │       └────────────────────────────────────────────────────────┘
  │  OAuth / anon sign-in
  ├──────────────────────────────▶  Supabase Auth  ──▶ issues JWT (anonymous; Google later)
  │
  │  HTTPS (REST) + WSS (Socket.io), JWT in Authorization / handshake
  ▼
┌─────────────── Railway (Docker) ───────────────┐
│  apps/server                                    │
│   Fastify  ── REST routes                       │
│   Socket.io ── room/game/chat handlers          │
│        │                                        │
│        ▼                                        │
│   RoomActor (one per active room, in-process)   │──▶ Redis   (room + hand state, snapshots)
│        │  calls                                 │
│        ▼                                        │──▶ Supabase Postgres (profiles, recaps)
│   packages/engine (pure poker logic)            │
│   packages/bots   (pure bot strategies)         │
└─────────────────────────────────────────────────┘
```

**Server-authoritative.** In multiplayer rooms, clients send *intents* (`bet 120`); the server validates them against engine rules and broadcasts the resulting state. Clients never compute outcomes.

**Practice mode is the exception:** it runs entirely in the browser (engine + bots + a local runner), with no server or socket. That's safe because it's solo, and it lets practice work offline in the installed PWA.

---

## 3. Repository layout

npm workspaces monorepo:

```
felt/
├── apps/
│   ├── web/                  # Vite + React PWA
│   │   └── src/
│   │       ├── routes/       # /, /onboarding, /r/:code, /practice, /learn, /recap/:id
│   │       ├── components/   # ui/, table/, actions/, hybrid/, host/, practice/, tutorial/, chat/, hand-ranks/
│   │       ├── local/        # in-browser game runner for practice + tutorial
│   │       ├── socket/       # typed Socket.io client
│   │       ├── store/        # Zustand stores
│   │       └── lib/          # supabase client, api client
│   └── server/               # Fastify + Socket.io
│       └── src/
│           ├── config/       # env (zod), redis, supabase
│           ├── http/         # REST routes + auth hook
│           ├── socket/       # io setup, auth middleware, handlers
│           ├── rooms/        # RoomActor, RoomRegistry, persistence
│           ├── usernames/    # format, reserved list, profanity check
│           └── recap/        # recap builder + settle-up
├── packages/
│   ├── engine/               # PURE poker logic: no I/O, no timers, no randomness source of its own
│   ├── bots/                 # PURE bot strategies + hint/explanation templates
│   └── protocol/             # Shared TS types + Zod schemas for REST & socket events
├── supabase/migrations/
├── docker-compose.yml
└── docs/
```

### Boundaries (enforced in review)
| Module | Owns | Must not |
|---|---|---|
| `packages/engine` | Rules, state transitions, side pots, hand evaluation, equity | Import Node/browser APIs, Redis, sockets, `Math.random` |
| `packages/bots` | Bot decisions, practice hints and explanations | Same restrictions as engine; RNG is injected |
| `packages/protocol` | Event names, payload types, Zod schemas | Contain logic |
| `rooms/RoomActor` | Serialising actions for one room, timers, persistence, broadcasting | Implement poker rules |
| `socket/handlers` | Auth, payload validation, forwarding to the actor | Mutate state directly |
| `http/` | Auth-gated REST | Touch live game state except via the registry |

---

## 4. Game engine (`packages/engine`)

A pure reducer:

```ts
type Result = { state: HandState; events: EngineEvent[] } | { error: EngineError };

applyAction(state: HandState, action: PlayerAction | HostAction): Result
startHand(table: TableState, deck: Card[] | null): HandState   // deck null in hybrid mode
```

- **Deck & RNG:** the caller shuffles with Fisher–Yates using an injected `randInt`. The server passes `crypto.randomInt`, and practice mode passes `crypto.getRandomValues`. The engine never generates randomness itself, so it's deterministic and fully testable.
- **Hybrid mode:** `deck = null`. Street advances come from `HostAction { type: 'advance_street' }`, and showdown uses `HostAction { type: 'award_pot', potId, winners }` instead of the evaluator.
- **Betting:** No-Limit rules. The min-raise is the last full raise size, a short all-in doesn't reopen the action, and heads-up uses its own blind/button rules.
- **Side pots:** computed from each player's contributions at every all-in. Each pot lists its eligible players, and odd chips go to the first winner left of the button.
- **Evaluator:** a 7-card evaluator that returns the rank category plus kickers for comparison and a display name ("Flush, King high").
- **Equity (practice hints):** Monte Carlo over random runouts against random opponent hands, run in the browser in a Web Worker with a time budget.
- **Undo (hybrid):** the RoomActor keeps the last K engine states, and undo restores the previous one. The engine itself stays stateless.
- **Chips are integers** everywhere.

Test priorities: side pots with 3+ all-ins, split pots, min-raise edge cases, heads-up, the evaluator against a known-hands corpus, and a property test that chips are conserved across random action sequences.

---

## 5. Room runtime (multiplayer)

### RoomActor
- Exactly one actor per active room. It holds the room state in memory and processes a **serial queue** of actions, so there are no races between two players acting at once.
- Everything goes through the queue: player actions, host actions, join requests, top-ups, timer expiry.
- After each accepted action, the actor persists a snapshot to Redis and then broadcasts to the room's sockets.
- It owns all timers (turn timer, join-request expiry, disconnect grace, blind increases, idle expiry). Timer expiry is just another queued action.

### Room state (beyond the engine's HandState)
- `settings`: mode, minBuyIn, maxBuyIn?, blinds, maxSeats, timer, blindIncrease
- `hostId`
- `admitted`: set of userIds allowed in this session
- `joinRequests`: `{ requestId, userId, username, expiresAt }[]`
- `denied`: `userId → cooldownUntil`
- `topUpRequests`: `{ requestId, userId, amount, createdAt }[]`
- `pendingTopUps`: approved amounts, applied at the next hand start
- `ledger`: append-only `{ t, userId, kind: 'buy_in'|'top_up'|'adjust'|'hand_result', amount, note? }[]`, which is the source of truth for the recap

### Persistence (Redis)
| Key | Value | TTL |
|---|---|---|
| `room:{code}` | Room state above (settings, seats, stacks, host, admitted, requests, ledger) | 2h, refreshed on activity |
| `room:{code}:hand` | Current `HandState` (incl. deck in online mode) | Deleted at hand end |
| `room:{code}:undo` | Last K hand states (hybrid) | Same as room |
| `user:{userId}:room` | Room code the user is seated in | Same as room |

On server boot, the registry lazily rehydrates an actor from Redis when the first socket for that room connects. Timers resume from stored deadlines (epoch ms), not from remaining-seconds counters.

### Scaling
v1 runs **one server instance**, because the in-process actor model requires all of a room's sockets to reach the same process. To scale out later: add the Socket.io Redis adapter plus routing by room code. That isn't needed at friends-and-home-games scale.

---

## 6. Auth & usernames

- **v1:** every player is a Supabase anonymous user. The web app calls `signInAnonymously()` on first visit, and `supabase-js` persists and refreshes the session on the device.
- **Server:** verifies Supabase JWTs (JWKS, cached) on REST via a Fastify `onRequest` hook, and on Socket.io via `io.use()` reading `handshake.auth.token`. The socket re-authenticates when the token refreshes. Claims give `{ userId, isAnonymous }`.
- **Onboarding:** a user with no `profiles` row is sent to `/onboarding` to claim a username before creating or joining rooms.
- **Username pipeline** (`apps/server/src/usernames/`), the same for checking and claiming:
  1. Normalise: trim, then apply Unicode NFKC
  2. Format: `^[A-Za-z0-9_]{3,20}$` (schema in `packages/protocol`, shared with the client for instant feedback)
  3. Reserved list: `admin`, `host`, `felt`, `support`, `guest`, `moderator`, `system`, …
  4. Profanity: the `obscenity` matcher with its English dataset plus recommended transformers (leetspeak, repeated chars, confusables)
  5. Uniqueness: a case-insensitive lookup in `profiles`
  - Claiming relies on the DB unique index as the final arbiter. A unique violation returns `409 username_taken`, which makes the claim race-safe.
- Only the server writes `profiles.username` (service role) so the profanity filter can't be bypassed from the client.
- **Deferred: Google sign-in.** `linkIdentity({ provider: 'google' })` upgrades the anonymous user in place, so the user ID, username and any seat survive. It needs a Google OAuth client and the provider enabled in Supabase. Nothing else in this design changes.

## 7. Data model (Postgres)

Deliberately small, because game state is ephemeral.

```sql
create extension if not exists citext;

profiles (
  id          uuid primary key references auth.users on delete cascade,
  username    citext not null unique
              check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  created_at  timestamptz not null default now()
)
-- One row per player (anonymous user) once they claim a username.

shared_recaps (
  id          text primary key,          -- short public slug
  room_code   text not null,
  payload     jsonb not null,            -- frozen recap
  created_by  uuid references auth.users,
  expires_at  timestamptz not null       -- now() + 7 days; purged by pg_cron
)
```

RLS:
- `profiles`: select for authenticated users; **no** insert/update policies (writes go through the server's service role).
- `shared_recaps`: select by slug for anyone, while not expired. Writes go through the service role only.

---

## 8. REST API

All routes require a Supabase JWT unless noted otherwise.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness + Redis status (no auth) |
| `GET` | `/me` | `{ userId, isAnonymous, username? }` |
| `GET` | `/usernames/check?u=` | `{ available, reason?: 'format'\|'reserved'\|'profane'\|'taken' }` (rate-limited) |
| `POST` | `/me/username` | Claim username → `201` / `409 username_taken` / `422 { reason }` |
| `POST` | `/rooms` | Create room → `{ code, url }` (guests allowed) |
| `GET` | `/rooms/:code` | Preview: mode, host name, blinds, buy-in range, seats taken, status |
| `POST` | `/recaps` | Freeze a finished session's recap → `{ slug }` (host only) |
| `GET` | `/recaps/:slug` | Public recap (no auth) |

Everything in-game happens over Socket.io. Practice mode uses no API at all.

---

## 9. Socket.io protocol

Defined once in `packages/protocol` (types + Zod). Client → server events use **acks**, so the UI gets `{ ok: true } | { ok: false, error }` for every intent.

### Client → Server
| Event | Payload | Who |
|---|---|---|
| `room:request_join` | `{ code }` | Anyone not yet admitted |
| `room:cancel_request` | — | Requester |
| `room:enter` | `{ code }` | Admitted player (incl. on reconnect) |
| `room:sit` | `{ seat, buyIn }` | Admitted player; `minBuyIn ≤ buyIn ≤ maxBuyIn` |
| `room:sit_out` / `room:sit_in` | — | Player |
| `room:leave` | — | Player |
| `game:act` | `{ handId, type: 'fold'\|'check'\|'call'\|'bet'\|'raise'\|'all_in', amount? }` | Player on turn |
| `player:topup_request` | `{ amount }` | Seated player |
| `host:admit` | `{ requestId, approve }` | Host |
| `host:topup` | `{ requestId, approve }` | Host |
| `host:start` / `host:pause` / `host:resume` / `host:end` | — | Host |
| `host:settings` | Partial room settings (applied next hand) | Host |
| `host:kick` | `{ userId }` | Host |
| `host:transfer` | `{ userId }` | Host |
| `host:mute` | `{ userId, muted }` | Host |
| `host:advance_street` | `{ handId, cards? }` | Host, hybrid |
| `host:award` | `{ handId, awards: [{ potId, winners }] }` | Host, hybrid |
| `host:dispute` | `{ handId }` | Any seated player, during the 5s award window |
| `host:undo` | `{ handId }` | Host, hybrid |
| `host:adjust_stack` | `{ userId, amount, reason }` | Host, hybrid |
| `chat:send` | `{ text }` (≤ 200 chars) | Seated player |
| `chat:react` | `{ emoji }` (allow-list) | Seated player |

`handId` on game actions prevents a stale tap from a previous hand being applied.

### Server → Client
| Event | Payload | Audience |
|---|---|---|
| `room:join_pending` | `{ requestId, expiresAt }` | Requester |
| `room:join_decision` | `{ approved, retryAfter? }` | Requester |
| `host:join_request` | `{ requestId, userId, username }` | Host |
| `host:topup_request` | `{ requestId, userId, amount }` | Host |
| `player:topup_decision` | `{ requestId, approved }` | Requester |
| `room:state` | Full public room + hand state, `version` number | Admitted players |
| `hand:private` | `{ handId, holeCards }` | One player (online mode) |
| `hand:result` | Pots, winners, revealed hands | Room |
| `turn:start` | `{ userId, deadline }` | Room |
| `chat:message` / `chat:reaction` | Message | Room |
| `session:recap` | Recap + settle-up | Room |
| `error` | `{ code, message }` | One socket |

**Socket rooms:** a socket joins the Socket.io room `room:{code}` only after it has been admitted. Requesters get only their own pending/decision events and never see room state.

**State sync:** v1 broadcasts the full public state on every change, which is small at 9 seats. Each `room:state` carries a monotonically increasing `version`, and clients drop out-of-order updates. On reconnect, the server sends the current `room:state` (plus `hand:private` if applicable).

**Privacy rule:** hole cards and the deck live only in server memory/Redis and in `hand:private` to their owner. The public state builder must be the only path to `room:state`, and a test asserts it never includes other players' cards.

---

## 10. Practice mode (client-side)

- **Local runner** (`apps/web/src/local/`) wraps `packages/engine` + `packages/bots` and exposes the same `room:state`-shaped store the multiplayer table reads, so the table, action bar and hand-ranks UI are reused unchanged.
- **Bots:** `(publicState, holeCards, style, rng) → PlayerAction`, using hand-strength buckets, pot odds, position and a bluff probability. Styles are `tag` (tight-aggressive) and `lp` (loose-passive), and bots act after a random 0.8–2.5s delay.
- **Hints & explanations:** computed in `packages/bots` from the same features the bots use. Explanations are templates; there's no LLM.
- **Tutorial:** lessons are data (`apps/web/src/components/tutorial/lessons/*.ts`). Each step has a scripted deck, a starting state, overlay text, a highlighted UI element and an expected action. The runner rejects any action other than the expected one, with a hint. Progress is stored in `localStorage`.

---

## 11. Security checklist
- Validate every socket payload with Zod and reject unknown events.
- Authorise every host action against `room.hostId`, every game action against the seat whose turn it is, and every room event against `room.admitted`.
- Rate limit REST via `@fastify/rate-limit` (`/usernames/check` especially), and sockets via a per-connection token bucket (especially chat and join requests).
- Shuffle only with a CSPRNG.
- Never log hole cards or decks.
- Restrict CORS and the Socket.io `origin` to the web origin.
- The Supabase service-role key exists only on the server.
- Render chat text as text (no HTML) and cap its length. Run chat through the profanity filter (censor, don't block).
- Profanity checks run server-side only. The client check is just for UX.

---

## 12. Environments & config

| Var | Used by | Notes |
|---|---|---|
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | web | Public |
| `VITE_SERVER_URL` | web | REST + WS origin (Railway URL) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | server | Secret |
| `SUPABASE_JWKS_URL` | server | JWT verification |
| `REDIS_URL` | server | Railway Redis reference variable in prod |
| `WEB_ORIGIN` | server | CORS / socket origin allow-list |
| `PORT` | server | Injected by Railway |

Environments: `local` (Compose + Supabase), `preview` (Vercel previews → Railway staging environment), `production`.

CLIs: `supabase`, `vercel` and `railway`, each logged in by the developer.

---

## 13. Observability
- Structured logs (Fastify's pino) with `roomCode`, `handId` and `userId`, never card data.
- Error tracking with Sentry on web and server.
- Basic metrics: active rooms, connected sockets, action latency, reconnects, pending join requests.

---

## 14. Decisions log
| # | Decision | Alternatives considered |
|---|---|---|
| 1 | Keep Fastify + Socket.io + Redis + Supabase from v1 | Supabase Realtime only (too weak for server-authoritative logic); Colyseus (less control) |
| 2 | Monorepo with shared `engine`, `bots`, `protocol` packages | Separate repos (type drift) |
| 3 | In-process RoomActor + Redis snapshots | Redis as the only source of truth with locks (race-prone, more round-trips) |
| 4 | Full-state broadcast, not diffs | Patches (premature at 9 players) |
| 5 | Supabase anonymous auth for guests | Custom guest tokens (two auth paths to secure) |
| 6 | Hybrid mode before online mode | Online first (as in v1) |
| 7 | Practice mode runs fully client-side | Server-side bots (needless load, no offline) |
| 8 | v1 is anonymous accounts + unique usernames; Google deferred; no Apple | Google now (setup cost); Apple (paid developer account) |
| 9 | Internet required for multiplayer; no LAN mode | WebRTC with the host phone as the authority (breaks fairness and card privacy, phones sleep) |
| 10 | Join by host approval, always on | Open links (too easy to gatecrash) |
| 11 | Railway for the game server | Fly.io (similar; Railway preferred by the owner) |
