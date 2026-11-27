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
- **Undo (hybrid):** the room keeps what the last 10 steps (moves and deals) of the running hand changed, and undo restores the previous one. Hand end, a departure or a stack correction empties it. `turnSeq` never goes back. The engine itself stays stateless.
- **Chips are integers** everywhere.

Test priorities: side pots with 3+ all-ins, split pots, min-raise edge cases, heads-up, the evaluator against a known-hands corpus, and a property test that chips are conserved across random action sequences.

---

## 5. Room runtime (multiplayer)

### RoomActor
- Exactly one actor per active room. It holds the room state in memory and processes a **serial queue** of actions, so there are no races between two players acting at once.
- Everything goes through the queue: player actions, host actions, join requests, top-ups, timer expiry.
- After each accepted action, the actor persists a snapshot to Redis and then broadcasts to the room's sockets.
- It owns all timers (turn timer, join-request expiry, disconnect grace, idle expiry). Timer expiry is just another queued action.

### Room state (beyond the engine's HandState)
- `settings`: mode, minBuyIn, maxBuyIn?, blinds, maxSeats, timer, blindIncrease (minutes or off, multiplier)
- Turn clock (`rooms/turnClock.ts`): `hand.turnDeadline` (absolute epoch ms) while the room has a timer and somebody is on turn; `turnLeftMs` while paused. Each new turn gets a full clock (another player leaving does not extend the current one). On expiry the player checks if free, else folds, as a queued actor task that reads the deadline as it is then, so a stale timer does nothing. An intent arriving after the deadline loses to it. `seats[].timeouts` counts turns run out in a row: two sit the player out from the next hand; acting in time, `room:sit_out` or `room:sit_in` clears it. Hybrid: a timeout can be undone (with its strike and sit-out). A deadline that passed while the server was down applies once, when the room is next loaded
- `blindClock`: absolute deadline of the next blind increase (frozen while paused). It needs no timer: the next hand dealt after it takes one level (rounded up, capped at the chip maximum) and starts a full countdown
- `hostId`
- `admitted`: set of userIds allowed in this session
- `joinRequests`: `{ requestId, userId, username, expiresAt }[]`
- `denied`: `userId → cooldownUntil`
- `away`: `userId → { since, releaseAt }` for disconnected seated players and the host. At `releaseAt` the seat is given up as `room:leave` would (not while dealt into the running hand or paused). A host away 2 minutes is replaced by the longest-seated connected player
- `sessions`: `userId → session` of the visit holding the room
- `topUpRequests`: `{ requestId, userId, amount, createdAt }[]`
- `pendingTopUps`: approved amounts, applied at the next hand start
- `ledger`: append-only `{ t, userId, kind: 'buy_in'|'top_up'|'adjust'|'hand_result', amount, note? }[]`, which is the source of truth for the recap (`amount` is signed for `adjust`, whose `note` is the reason)
- `log`: the last 20 host corrections (undo, stack adjust), shown to every admitted player

### Persistence (Redis)
| Key | Value | TTL |
|---|---|---|
| `room:{code}` | Room state above (settings, seats, stacks, host, admitted, requests, ledger) | 2h, refreshed on activity and while an admitted user is connected |
| `room:{code}:hand` | Current `HandState` (incl. deck in online mode) | Deleted at hand end |
| `user:{userId}:room` | Room code the user is seated in | Same as room |

On server boot, the registry lazily rehydrates an actor from Redis when the first socket for that room connects. Timers resume from stored deadlines (epoch ms), not from remaining-seconds counters.

- **Keep-alive:** a connected room (not an ended one) has its TTL refreshed on `room:enter` and every 5 minutes (`EXPIRE`, so a gone room stays gone), along with its members' open-rooms sets.
- **Saves are compare-and-set** on the record's `version` (Lua). On a conflict the actor is disposed, queued tasks are rejected, the caller gets a retryable `internal` error, and the room is loaded again and published. After a save that failed ambiguously, the stored version is checked before the next task.
- **A record that fails the schema** is not "missing": it is left untouched, logged, and reported as unavailable (503 / `internal`).

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
| `GET` | `/ready` | Readiness: 503 without Redis, or without the database client in production (no auth) |
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
| `room:cancel_request` | `{ code }` | Requester |
| `room:enter` | `{ code, session?, resume? }` | Admitted player (incl. on reconnect). `session` names the visit: the latest to enter holds the user's session and their other sockets get `room:displaced`. `resume` (an automatic reconnect) is refused as `session_moved` if another session has taken over |
| `room:sit` | `{ seat, buyIn }` | Admitted player; `minBuyIn ≤ buyIn ≤ maxBuyIn`. A player returning mid-game brings exactly what they left with (0 if busted; then a top-up) |
| `room:sit_out` / `room:sit_in` | — | Player |
| `room:leave` | — | Player |
| `game:act` | `{ handId, turnSeq, type: 'fold'\|'check'\|'call'\|'bet'\|'raise'\|'all_in', amount? }` | Player on turn; a `turnSeq` older than `room:state` is refused as `stale_hand` |
| `player:topup_request` | `{ amount }` | Seated player (the host too); one outstanding per player; `stack + amount ≤ maxBuyIn`, checked again at approval and when applied |
| `host:admit` | `{ requestId, approve }` | Host |
| `host:topup` | `{ requestId, approve }` | Host |
| `host:start` / `host:pause` / `host:resume` / `host:end` | — | Host. While paused, moves, deals, awards, disputes, undo, stack fixes and start are refused (`room_paused`); resume keeps what was left of the turn (at least 5s, or the whole timer if shorter) and restarts the other waiting deadlines in full. End cancels a running hand (everyone gets back what they put in) and drops all requests and queued top-ups |
| `host:settings` | `{ smallBlind, bigBlind }` (applied next hand; restarts the blind increase countdown) | Host |
| `host:blind_increase` | `{ minutes, multiplier }` (`minutes` 1–240 or null = off; multiplier 1.5 or 2) | Host |
| `host:kick` | `{ userId }`. Does what `room:leave` does, then removes admission | Host |
| `host:transfer` | `{ userId }` (seated and connected) | Host |
| `host:mute` | `{ userId, muted }` | Host |
| `host:seat_hold` | `{ minutes }` (1–30, default 3; applies to later disconnects) | Host |
| `host:force_fold` | `{ handId, turnSeq, userId }`. Folds a disconnected player on turn, only with the turn timer off; cannot be undone | Host |
| `hand:show` | `{ handId }`. Turns your own cards face up after an online hand ends (fold-out winner, mucked or folded), until the next deal | Admitted player dealt into the hand, online |
| `host:advance_street` | `{ handId, turnSeq, street, cards? }` | Host, hybrid |
| `host:award` | `{ handId, turnSeq, awards: [{ potId, winners }] }` (every pot) | Host, hybrid |
| `host:dispute` | `{ handId }` | Any seated player or the host, during the 5s award window (hybrid) |
| `host:undo` | `{ handId, turnSeq }` (the last move or deal of the running hand) | Host, hybrid |
| `host:adjust_stack` | `{ userId, amount, reason, stack }` (signed delta; `stack` = what the host saw). Not while that player is still in the hand | Host, hybrid |
| `chat:send` | `{ text }` (≤ 200 chars) | Seated player |
| `chat:react` | `{ emoji }` (allow-list) | Seated player |

`handId` on game actions prevents a stale tap from a previous hand being applied.

### Versioning
Web and server deploy separately and open tabs keep old bundles.
- **Handshake:** `handshake.auth` is `{ token, protocol }`. Any `protocol` but the server's `PROTOCOL_VERSION` (or none) is refused as `upgrade_required` (`data.protocol` = the server's), before the token is looked at. The client shows a reload screen: no token refresh, no sign-out, no automatic reload, and it keeps reconnecting with backoff.
- **Bumping:** `packages/protocol/src/version.ts` keeps one fingerprint of the wire schemas per version; a test fails until a changed wire format is appended.
- **Client parsing:** server payloads are parsed with `parseTolerant` (unknown keys stripped). A `room:state` that still fails shows the reload screen. Server-side schemas stay strict.
- **REST** carries no version: responses are parsed tolerantly and request bodies are validated strictly.

### Server → Client
| Event | Payload | Audience |
|---|---|---|
| `room:join_pending` | `{ requestId, expiresAt }` | Requester |
| `room:join_decision` | `{ approved, retryAfter?, ended? }` | Requester |
| `room:kicked` | `{ code }` | A removed player's sockets (also on `room:enter` until they ask again) |
| `host:members` | `{ members: [{ userId, username, seated, leaving }] }` (everyone admitted; empty to a host who handed over) | Host |
| `room:displaced` | `{ code }` | A socket whose user opened the room elsewhere; the client stops reconnecting |
| `host:join_request` | `{ requestId, userId, username }` | Host |
| `host:topup_request` | `{ requestId, userId, amount }` | Host |
| `player:topup_decision` | `{ requestId, approved, amount, reason? }` (`over_max`: dropped when due) | Requester |
| `player:topup_status` | `{ pending: { requestId, amount } \| null }` (own unanswered request; on entry and on change) | One player |
| `room:state` | Full public room + hand state, `version` number | Admitted players |
| `hand:private` | `{ handId, holeCards }` | One player's own sockets (online mode) |
| `hand:result` | Pots, winners, revealed hands | Room |
| `turn:start` | `{ userId, deadline }` (`deadline` null with the timer off). Sent on each new turn and on resume; `room:state.hand.turnDeadline` is the same value (null while paused) and is what a reconnecting client uses | Room |
| `chat:message` / `chat:reaction` | Message | Room |
| `session:recap` | Recap + settle-up | Room |
| `error` | `{ code, message }` | One socket |

**Socket rooms:** a socket joins the Socket.io room `room:{code}` only after it has been admitted. Requesters get only their own pending/decision events and never see room state.

**State sync:** v1 broadcasts the full public state on every change, which is small at 9 seats. Each `room:state` carries a monotonically increasing `version`, and clients drop out-of-order updates. On reconnect, the server sends the current `room:state` (plus `hand:private` if applicable).

**Privacy rule:** hole cards and the deck live only in server memory/Redis and in `hand:private` to their owner. The public state builder must be the only path to `room:state`, and a test asserts it never includes other players' cards. The one exception is `hand.outcome.hands` after an online hand has ended (`rooms/reveal.ts`).

**Online hands:** the server shuffles with `crypto.randomInt`; the engine deals, moves the streets on and settles the showdown. `hand:private` goes to a player's own sockets after the `room:state` of the deal, and again after every `room:enter`. Hybrid-only intents (`host:advance_street`, `host:award`, `host:dispute`, `host:undo`, `host:adjust_stack`) are refused (`wrong_mode`).

**Ended online hand:** `room:state.hand.outcome` = `{ runoutFrom, hands: [{ userId, cards, handName, voluntary }], awards, nextHandAt }`.
- Revealed by the rules: after an all-in run-out (`runoutFrom` 0, 3 or 4: board cards face up when betting closed) every hand still contesting; after any other showdown only the winners of contested pots; after everyone folds nothing. Others appear only via `hand:show`.
- The state arrives with the full board and final stacks. A client with `runoutFrom` set turns the hands face up first, then the rest of the board street by street (at most 1.5s a step), and only then shows the result.
- Next deal: 5s after a fold-out, 8s after a showdown, plus 2s per run-out street. A `hand:show` leaves at least 3s more.

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
