# FELT — Build Plan

**Last updated:** 2026-11-24 · Specs: [`PRD.md`](./PRD.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md)

The build is split into small phases, each sized so **one agent can finish it in one session** without guessing. Phases are grouped into stages, and each phase lists what it depends on.

## Rules for the agent running a phase

1. **Do exactly one phase.** Read `CLAUDE.md`, this phase's block, and only the spec sections it cites.
2. **Check dependencies.** If a phase listed under **Needs** isn't ✅, stop and say so.
3. **Stay in scope.** Touch only the files and areas listed. If the work clearly needs something outside the phase, stop and report it instead of building it.
4. **Don't invent.** If the spec is ambiguous or silent, stop and ask. Don't pick a behaviour and move on.
5. **Prove it.** Every **Done when** item must be demonstrated (test output, command output, or a screenshot for UI). "Should work" doesn't count.
6. **Don't commit.** Leave changes in the working tree. After the tester's GO, the orchestrator ticks the phase, commits `P<nn>: <title>` and pushes to GitHub (branch `rebuild`).
7. **Never push tests, env files or rebuildable artifacts.** `.gitignore` excludes `*.test.*`, `*.spec.*`, `e2e/`, `.env*`, `node_modules/` and `dist/`. Tests live and run locally only. Keep `package-lock.json` committed, because Vercel and Railway need it for reproducible installs.

## Execution protocol: builder ↔ tester

Each phase is run by the orchestrator (the main Claude session) with a **fresh pair of subagents**. The pair is never reused across phases.

```
orchestrator ──spawn──▶ BUILDER  builds the phase, reports "READY FOR TEST" + evidence
     │                     ▲
     │                     │ NO-GO + findings (same builder, via SendMessage)
     ▼                     │
orchestrator ──spawn──▶ TESTER   stress-tests the build, replies GO or NO-GO
     │
     └─ GO ──▶ tick the phase ✅, report to owner, next phase only on the owner's word
```

- **Strict alternation.** The tester doesn't start until the builder reports READY. The builder doesn't resume until the tester's verdict arrives. Neither acts on its own.
- **Builder:** implements only the phase, runs the Done-when checks itself, and reports changed files, commands run and their output.
- **Tester:** read-only on product code. It may write throwaway probes in the scratchpad or temporary files that it removes afterwards. Its job is to *break* the phase: re-run every Done-when check from a clean state, try edge cases, check scope and the CLAUDE.md rules, and confirm the tests actually fail when they should (mutation spot-checks). Its reply is `VERDICT: GO` or `VERDICT: NO-GO` with numbered, reproducible findings.
- **NO-GO loop:** the tester's findings go back to the same builder, and after its fix a **new tester** checks it (fresh eyes). Max 3 rounds; after that the orchestrator stops and asks the owner.
- **Models:** the default is Sonnet for both. Use Opus for the tester on correctness-critical phases (P18–P25 engine, P30 admission, P32/P47 privacy, P43 ledger) and for the builder on P22–P25.

Legend: ⬜ not started · 🟨 in progress · ✅ done · 👤 needs the owner (login, account, decision)

---

## Stage A — Foundation & accounts

### ✅ P01 · Monorepo skeleton
- **Needs:** —
- **Do:** Root `package.json` with npm workspaces (`apps/*`, `packages/*`), `tsconfig.base.json` (strict), ESLint + Prettier, Vitest. Create empty `apps/web`, `apps/server`, `packages/engine`, `packages/bots`, `packages/protocol`, each with `package.json`, `tsconfig.json`, `src/index.ts` and one trivial test. Root scripts: `dev`, `test`, `typecheck`, `lint`. Add `.gitignore` and `.env.example`.
- **Done when:** `npm install && npm test && npm run typecheck && npm run lint` all pass from the root.
- _Note: Tester GO on round 1. Typecheck is per-workspace `tsc --noEmit`, and all workspaces use `types: []` until P03 adds `@types/node` to the server. Lint is not type-aware. Workspace deps aren't enforced (npm hoisting)._

### ✅ P02 · Web app scaffold
- **Needs:** P01
- **Do:** Vite + React + TS in `apps/web`, Tailwind, React Router with placeholder routes (`/`, `/onboarding`, `/r/:code`, `/practice`, `/learn`, `/recap/:slug`), Zustand installed. Mobile-first base layout (375px).
- **Done when:** `npm run dev -w apps/web` serves every route, with a screenshot of `/` at 375px.
- _Note: Tester GO on round 1. React 19, Vite 8, Tailwind 4, react-router 7 (imports from `react-router`), Zustand 5. Vitest config lives in `apps/web/vite.config.ts` (jsdom). Vercel will need SPA rewrites (P13)._

### ✅ P03 · Server scaffold
- **Needs:** P01
- **Do:** Fastify in `apps/server`, Zod-validated env (`config/env.ts`), pino logging, `GET /health`, CORS restricted to `WEB_ORIGIN`.
- **Done when:** a `fastify.inject` test for `/health` → 200 passes; the server boots with `npm run dev -w apps/server`.
- _Note: Tester GO on round 1. Built with tsup (`noExternal: /^@felt\//`), and bundling of workspace packages was proven by the tester. `NODE_ENV` defaults to development, so the Dockerfile must set production. Port 3000 is taken by another local process on the dev machine._

### ✅ P04 · Docker Compose + Redis
- **Needs:** P03
- **Do:** `apps/server/Dockerfile` (multi-stage), `docker-compose.yml` with `server` + `redis:7-alpine`. Add a Redis client in `config/redis.ts`. `/health` reports Redis status. Carried over from P03's tester:
  - (a) Fix log redaction. The default `req` serializer drops headers, so the current redact paths never apply. Use redact paths that cover any logged `headers.authorization` / `headers.cookie` (e.g. `*.headers.authorization`), plus a test that logs a headers object and asserts the values are censored.
  - (b) Load the root `.env` in dev (`tsx watch --env-file-if-exists=../../.env`), so the root `npm run dev` works without exporting vars.
  - (c) Make the dev server port configurable, because local port 3000 may be taken.
- **Done when:** `docker compose up` runs both services and `curl :3001/health` shows `redis: "ok"`.
- _Note: Tester GO on round 1. The server's host port is `${SERVER_PORT:-3001}`. `/health` returns 200 with `redis: ok|down`. The image is 271MB, non-root, with no env or test files. On the dev machine, ports 3000 and 6379 are already used by other local processes, so override `SERVER_PORT`/`REDIS_PORT` if needed._

### 🟨 P05 · CI
- **Needs:** P01
- **Do:** GitHub Actions workflow running `npm ci`, typecheck, lint and a production build on push/PR. Tests aren't pushed, so CI doesn't run them; they run locally before every commit.
- **Done when:** the first run on GitHub is green.

### ⬜ P06 · Supabase schema 👤
- **Needs:** P01
- **Do:** `supabase init` (if needed), migration with `citext`, `profiles` (ARCHITECTURE §7) and RLS (select-only for authenticated users). Enable Google + anonymous sign-in in `supabase/config.toml`. 👤 The owner creates the Google OAuth client and provides its keys.
- **Done when:** `supabase db reset` applies cleanly; a SQL test shows an invalid-format username is rejected and `Bob`/`bob` collide.

### ⬜ P07 · Protocol: username & name schemas
- **Needs:** P01
- **Do:** In `packages/protocol`: a Zod `UsernameSchema` (format), `GuestNameSchema`, a `RESERVED_NAMES` list and a `UsernameCheckResult` type. Export them for web + server.
- **Done when:** unit tests cover valid, too short, too long, bad characters and reserved names.

### ⬜ P08 · Profanity filter module
- **Needs:** P07
- **Do:** `apps/server/src/usernames/profanity.ts` wrapping `obscenity` (English dataset + recommended transformers). `isProfane(name): boolean` and `censor(text): string`.
- **Done when:** tests pass for plain, leetspeak (`sh1t`), repeated-character, mixed-case and confusable cases, plus false-positive guards (e.g. `scunthorpe`, `classic`, `bass`).

### ⬜ P09 · Server JWT auth
- **Needs:** P03, P06
- **Do:** Fastify `onRequest` auth hook that verifies the Supabase JWT via JWKS (cached) and sets `request.user = { userId, isAnonymous }`. Add `GET /me`. Widen log redaction to any new secret-bearing headers or fields (`proxy-authorization`, `x-api-key`, tokens in bodies), and add tests for them.
- **Done when:** tests with locally signed tokens cover valid, expired, wrong-issuer and missing-token cases.

### ⬜ P10 · Username endpoints
- **Needs:** P07, P08, P09
- **Do:** `GET /usernames/check`, `POST /me/username` and `GET /names/check`, following the ARCHITECTURE §6 pipeline. Claiming writes with the service role and maps a unique violation to 409. Rate-limit the check endpoint.
- **Done when:** tests cover every `reason` value, a successful claim, a duplicate claim → 409, and the race (two parallel claims → exactly one 201).

### ⬜ P11 · Web auth
- **Needs:** P02, P06
- **Do:** Supabase client in `apps/web/src/lib`, "Continue with Google" and "Play as guest" on `/`, and an auth store (session, `isAnonymous`).
- **Done when:** both sign-in paths work locally and the session survives a reload (screenshots).

### ⬜ P12 · Username onboarding UI
- **Needs:** P10, P11
- **Do:** `/onboarding`: a username input with instant format feedback (shared schema), a debounced availability check and the submit flow. Redirect Google users without a username here. Add a guest-name input for guests.
- **Done when:** a Playwright test covers a taken name, a profane name, a valid claim and the redirect.

### ⬜ P13 · Deploy skeleton 👤
- **Needs:** P04, P11
- **Do:** 👤 The owner runs `railway login` and `vercel login`. Create a Railway project with the server service (Dockerfile) and Railway Redis, a Vercel project for `apps/web`, and the production Supabase project. Set the env vars from ARCHITECTURE §12.
- **Done when:** the production web URL loads, guest sign-in works, and the production `/health` reports Redis ok.

---

## Stage B — Poker engine (pure, `packages/engine`)

### ⬜ P14 · Engine types & card helpers
- **Needs:** P01
- **Do:** Types: `Card`, `Rank`, `Suit`, `SeatState`, `TableState`, `HandState`, `PlayerAction`, `HostAction`, `EngineEvent`, `EngineError`, `Result`. Card `parse`/`format` helpers (`"Ah"`, `"Td"`). Add an ESLint override for `packages/engine` + `packages/bots` banning `Math.random`, `Date.now` and `new Date` (`no-restricted-properties` / `no-restricted-syntax`).
- **Done when:** helper tests pass; types compile; there's no logic yet beyond the helpers.

### ⬜ P15 · Deck & shuffle
- **Needs:** P14
- **Do:** `createDeck()` and `shuffle(deck, randInt)` (Fisher–Yates with an injected RNG).
- **Done when:** tests confirm 52 unique cards, a deterministic order with a seeded RNG, and a chi-square sanity check on position distribution.

### ⬜ P16 · 5-card hand evaluator
- **Needs:** P14
- **Do:** `evaluate5(cards)` → `{ category, tiebreak[] }` for all 10 categories, including the wheel (A-2-3-4-5).
- **Done when:** at least one test per category, plus wheel and ace-high straight tests.

### ⬜ P17 · 7-card best hand + compare + names
- **Needs:** P16
- **Do:** `bestOf7`, `compareHands` and `handName` ("Full house, Kings over Threes").
- **Done when:** tests over a corpus of at least 30 known head-to-head results, including kicker and split cases.

### ⬜ P18 · Start hand
- **Needs:** P15
- **Do:** `startHand(table, deck | null)`: button rotation, skipping sat-out and busted players, posting blinds (heads-up rule, short-stack blind all-in), dealing hole cards when a deck is given, and setting the first to act.
- **Done when:** tests cover 2, 3 and 9 players, a button moving past an empty seat, a short-stack blind, and hybrid (no cards).

### ⬜ P19 · Basic actions: fold / check / call
- **Needs:** P18
- **Do:** `applyAction` for fold/check/call with legality checks, turn order, and detection of the end of a betting round. Last player standing wins the hand.
- **Done when:** tests cover illegal check facing a bet, acting out of turn, everyone checking through, fold to the winner, and the big blind's option pre-flop.

### ⬜ P20 · Bet / raise / all-in
- **Needs:** P19
- **Do:** Min bet = big blind, min raise = last full raise, all-in for less, and a short all-in not reopening the action to players who already acted.
- **Done when:** tests for each rule, including the "short all-in doesn't reopen" case and a re-raise after a full raise.

### ⬜ P21 · Street progression
- **Needs:** P20
- **Do:** Advance flop/turn/river (from the deck in online mode, via `HostAction advance_street` in hybrid), reset the round's bets, and auto run-out when everyone is all-in.
- **Done when:** tests cover a full hand in both modes, an all-in pre-flop run-out, and a hybrid hand waiting on the host.

### ⬜ P22 · Side pots
- **Needs:** P20
- **Do:** `computePots(contributions, folded)` → `{ id, amount, eligible[] }[]`.
- **Done when:** tests for 2, 3 and 4 all-ins at different sizes, a folded player's chips staying in the pot, and an uncalled bet returned.

### ⬜ P23 · Showdown & award (online)
- **Needs:** P17, P21, P22
- **Do:** Evaluate each pot's eligible hands, award or split, apply the odd-chip rule, and emit `hand_ended` events.
- **Done when:** tests for a split main pot with a single-winner side pot, a three-way tie, and odd-chip placement.

### ⬜ P24 · Hybrid award
- **Needs:** P22
- **Do:** `HostAction award_pot` with validation that winners are eligible for that pot; the hand ends once every pot is awarded.
- **Done when:** tests for a valid award, an ineligible winner rejected, and a split award.

### ⬜ P25 · Chip conservation property test
- **Needs:** P23, P24
- **Do:** fast-check: random tables and random legal action sequences; assert total chips are constant and no stack goes negative.
- **Done when:** 1,000+ runs pass in CI time (< 10s).

---

## Stage C — Rooms, join approval, hybrid mode

### ⬜ P26 · Protocol: room settings & events
- **Needs:** P07, P14
- **Do:** Zod schemas + types for `RoomSettings`, `PublicRoomState`, and every event in ARCHITECTURE §9 (no handlers). Typed event maps for Socket.io.
- **Done when:** schema tests cover the buy-in range (min ≤ max), the seat range and the action payloads.

### ⬜ P27 · Create & preview room (REST)
- **Needs:** P09, P26, P04
- **Do:** A room code generator (`FELT-XXXX`, no ambiguous characters, collision-checked), `POST /rooms` (stores the initial room in Redis and makes the creator host + admitted) and `GET /rooms/:code`.
- **Done when:** tests for create by an account, create by a guest, an unknown code → 404 and the preview shape.

### ⬜ P28 · Socket.io server + auth
- **Needs:** P09, P26
- **Do:** Attach Socket.io to Fastify, add JWT `io.use()` middleware, restrict the origin, and Zod-validate every incoming event (with a typed handler helper).
- **Done when:** tests show an unauthenticated connection is rejected, an invalid payload gets an error ack, and a valid connection succeeds.

### ⬜ P29 · RoomActor & registry
- **Needs:** P27, P28
- **Do:** `RoomActor` (serial async queue, snapshot to Redis after each action) and `RoomRegistry` (get-or-rehydrate by code, evict on idle). No game logic.
- **Done when:** tests show concurrent actions processed in order, state rehydrated after the actor is dropped, and idle eviction.

### ⬜ P30 · Join requests (server)
- **Needs:** P29
- **Do:** `room:request_join`, `room:cancel_request`, `host:admit`, `room:enter`, the 2-minute request expiry, the 10-minute deny cooldown, the guest-name check (profanity + in-room uniqueness), and joining the Socket.io room only once admitted.
- **Done when:** tests cover admit, deny + cooldown, expiry, a non-host trying to admit, an admitted player reconnecting without asking again, and a requester never receiving `room:state`.

### ⬜ P31 · Seating & buy-in (server)
- **Needs:** P30
- **Do:** `room:sit {seat, buyIn}` (range-checked, writes a `buy_in` ledger entry), `sit_out`/`sit_in` and `leave`.
- **Done when:** tests for a below-min or above-max buy-in, a taken seat, a full table and the ledger entry.

### ⬜ P32 · Public state builder & broadcast
- **Needs:** P31
- **Do:** `toPublicState(room, hand)`, broadcasting `room:state` with an incrementing `version` after every action.
- **Done when:** tests show the version increments, and a privacy test confirms no hole cards or deck in the output (even when present in the hand state).

### ⬜ P33 · Hand lifecycle in actor (hybrid)
- **Needs:** P32, P21, P24
- **Do:** `host:start` → `startHand(deck=null)`, `game:act` → engine, `host:advance_street`, `host:award` with the 5s confirm window + `host:dispute`, then the next hand after a short delay. Stacks update from the engine.
- **Done when:** an integration test with 3 socket clients plays a hybrid hand through to award.

### ⬜ P34 · Web: socket client & room store
- **Needs:** P26, P11
- **Do:** A typed Socket.io client with the auth token and reconnect, and a Zustand room store that applies `room:state` only when its version is newer. No UI.
- **Done when:** unit tests cover out-of-order versions being dropped.

### ⬜ P35 · Web: create room screen
- **Needs:** P27, P34
- **Do:** A form for mode, min/max buy-in, blinds, seats, timer and blind increase (defaults from PRD §5.2). Submitting goes to the room.
- **Done when:** Playwright creates a room as a guest; a 375px screenshot.

### ⬜ P36 · Web: join flow
- **Needs:** P30, P34
- **Do:** `/r/:code` preview → guest name (if guest) → **Request to join** → a pending screen with a countdown → admitted (enter room), denied, or expired states.
- **Done when:** a two-browser Playwright test covers request → admit, and request → deny shows the cooldown.

### ⬜ P37 · Web: host request inbox
- **Needs:** P36
- **Do:** Host-only stacked request cards (join + top-up types, with top-up showing a placeholder until P43) offering one-tap Admit/Deny without leaving the table.
- **Done when:** Playwright shows the host admitting 2 queued requests.

### ⬜ P38 · Web: waiting room & seat picker
- **Needs:** P31, P37
- **Do:** A seat map, tap a seat → buy-in input (range shown) → sit. The host sees a Start button once 2+ players are seated.
- **Done when:** Playwright shows 3 players seated and the host starting the game.

### ⬜ P39 · Web: table view
- **Needs:** P38
- **Do:** Render seats, names (with guest tag), stacks, current bets, pot(s), dealer button and the turn highlight from `room:state`. Read-only.
- **Done when:** screenshots at 375px with 2, 6 and 9 players.

### ⬜ P40 · Web: action bar
- **Needs:** P39, P33
- **Do:** Fold/Check/Call/Bet/Raise/All-in, showing only the legal ones; a bet slider with ½, ⅔, pot and all-in presets; ack errors shown inline.
- **Done when:** Playwright plays a hybrid hand to the river through the UI.

### ⬜ P41 · Web: hybrid host controls
- **Needs:** P40
- **Do:** A "Flop / Turn / River dealt" advance button, the optional community-card entry, and the award UI (pick winner(s) per pot), plus the 5s confirm banner with a Dispute button for players.
- **Done when:** Playwright plays a hand including a side pot through to award.

### ⬜ P42 · Hybrid undo & stack adjust
- **Needs:** P41
- **Do:** Server: undo stack (last K states) and `host:adjust_stack` (ledger `adjust` entry with a reason). UI: an Undo button and an adjust-stack dialog, with both logged in a visible room log.
- **Done when:** tests for undoing an action mid-street, undo being unavailable after a hand ends, and an adjustment appearing in the ledger; a Playwright test for undo.

### ⬜ P43 · Top-ups (buy more)
- **Needs:** P37, P33
- **Do:** Server: `player:topup_request` (max buy-in check), `host:topup`, approved amounts queued and applied at the next hand start, ledger `top_up`. UI: a **Buy more** button + amount input, the host card in the inbox, and the decision toast.
- **Done when:** tests show a top-up approved mid-hand is applied only at the next hand, a decline, and a max-buy-in breach rejected; Playwright covers the end-to-end flow.

### ⬜ P44 · Host room controls
- **Needs:** P33
- **Do:** Pause/resume, kick (removes admission), change blinds (next hand), transfer host and end game (recap placeholder), with server + UI.
- **Done when:** tests for each control, plus a non-host attempt rejected.

### ⬜ P45 · Reconnection & host failover
- **Needs:** P44
- **Do:** Seat hold for the grace period, resync on reconnect, a second device taking over the session, host auto-transfer after 2 minutes, and a turn waiting for the host to force-fold when the timer is off.
- **Done when:** tests use fake timers for each case; Playwright kills and restores a page mid-hand.

### ⬜ P46 · Hybrid E2E game
- **Needs:** P42, P43, P45
- **Do:** A Playwright suite: 4 browsers, join approval, buy-ins, 5 hands including a side pot and an undo, a top-up and end game.
- **Done when:** the suite passes in CI.

---

## Stage D — Online mode

### ⬜ P47 · Server dealing & private hands
- **Needs:** P33, P23
- **Do:** For online rooms, shuffle with `crypto.randomInt`, call `startHand` with the deck, send `hand:private` to each owner, and run showdown via the engine.
- **Done when:** tests show each socket receives only its own cards and the privacy test from P32 still passes with real decks.

### ⬜ P48 · Turn timer
- **Needs:** P47
- **Do:** Deadlines stored in state, `turn:start`, expiry as a queued action (auto check/fold), and sitting a player out after two consecutive timeouts. Survives a restart.
- **Done when:** fake-timer tests cover each case, including a restart mid-turn.

### ⬜ P49 · Web: cards, timer ring, your-turn signal
- **Needs:** P47, P40
- **Do:** Hole and community card components, the timer ring, and vibration on your turn.
- **Done when:** 375px screenshots of each street.

### ⬜ P50 · Web: showdown & hand result
- **Needs:** P49
- **Do:** Reveal order, a muck option for losers and a result banner (winner, hand name, pots).
- **Done when:** Playwright covers a showdown with a split.

### ⬜ P51 · Online E2E game
- **Needs:** P48, P50
- **Do:** Playwright: 3 browsers, 5 hands, a timeout fold and a side pot.
- **Done when:** passes in CI.

---

## Stage E — Recap, chat, hand ranks

### ⬜ P52 · Recap builder
- **Needs:** P31
- **Do:** A pure `buildRecap(ledger, seats)` producing per-player buy-in total, final stack, net, hands played/won and biggest pot.
- **Done when:** tests show net totals summing to 0 and top-ups counted.

### ⬜ P53 · Settle-up algorithm
- **Needs:** P52
- **Do:** A pure min-transfers "who pays whom" from nets, plus a chips→money conversion at a given rate.
- **Done when:** tests cover 2, 5 and 9 players, a zero-net player and rounding.

### ⬜ P54 · Recap screen & share link
- **Needs:** P53, P44
- **Do:** A `session:recap` event on end game, the recap UI with a rate input, a `shared_recaps` migration, `POST/GET /recaps`, a pg_cron purge and `/recap/:slug`.
- **Done when:** Playwright ends a game, shares the recap and opens the link logged-out.

### ⬜ P55 · Chat & reactions
- **Needs:** P32, P08
- **Do:** Server `chat:send` (censor, 200-char cap, token bucket), `chat:react` (allow-list) and `host:mute`. UI: a chat panel (collapsed by default in hybrid) and reaction bubbles at seats.
- **Done when:** tests for the rate limit, censoring and muting; a Playwright smoke test.

### ⬜ P56 · Hand rankings button & sheet
- **Needs:** P39, P17
- **Do:** A floating button on every table screen that never overlaps the action bar. A bottom sheet lists the 10 ranks best→worst with example cards and highlights the player's current best hand when cards are known.
- **Done when:** screenshots open and closed at 375px; a highlight test with known hole + board cards.

---

## Stage F — Practice mode (client-side)

### ⬜ P57 · Odds & equity
- **Needs:** P17
- **Do:** In the engine: `outs`, `potOdds` and `equityMonteCarlo(hole, board, opponents, iterations, rng)`.
- **Done when:** tests check known spots (e.g. a flush draw on the flop ≈ 35%, AA vs random ≈ 85%) within tolerance.

### ⬜ P58 · Bots
- **Needs:** P57, P20
- **Do:** In `packages/bots`: `decide(publicState, hole, style, rng)` for `tag` and `lp`, using hand-strength buckets, pot odds, position and bluff frequency.
- **Done when:** tests confirm only legal actions over 10k random spots; `tag` folds more pre-flop than `lp`; deterministic with a seed.

### ⬜ P59 · Hints & explanations
- **Needs:** P57
- **Do:** In `packages/bots`: `hint(state, hole)` → `{ handRank, outs, potOdds, equity, explanation }` with template explanations.
- **Done when:** snapshot tests for 10 representative spots.

### ⬜ P60 · Local game runner
- **Needs:** P58, P34
- **Do:** `apps/web/src/local/`: runs the engine + bots in the browser, with bot delays and equity in a Web Worker, and feeds the same room store shape the table uses.
- **Done when:** a unit test plays 50 bot-vs-bot hands with chips conserved.

### ⬜ P61 · Practice hands UI (stage 2)
- **Needs:** P60, P40, P49, P59
- **Do:** `/practice` setup (number of bots, style mix), the table reusing multiplayer components, the hints toggle, the "What should I do?" button and pause/new session.
- **Done when:** Playwright plays 3 hands vs bots with hints on.

### ⬜ P62 · Tutorial engine
- **Needs:** P60
- **Do:** A lesson data format (scripted deck, start state, overlay text, highlighted element, expected action), a runner that enforces the expected action, and progress saved in `localStorage`.
- **Done when:** unit tests show a wrong action blocked with a hint, the right action advancing, and progress resuming after a reload.

### ⬜ P63 · Tutorial lessons 1–4
- **Needs:** P62, P56
- **Do:** Lessons: the goal and chips; seats/button/blinds; hole cards and streets; actions.
- **Done when:** Playwright completes lessons 1–4.

### ⬜ P64 · Tutorial lessons 5–7
- **Needs:** P63
- **Do:** Lessons: hand rankings (opens the hand-rank sheet), showdown/split/side pots, and a guided full hand. Add a "Learn the game" entry on `/` and in practice.
- **Done when:** Playwright completes lessons 5–7 and can replay the tutorial.

---

## Stage G — Polish & launch

### ⬜ P65 · PWA
- **Needs:** P61
- **Do:** `vite-plugin-pwa` with a manifest, icons, a service worker and an install prompt. Practice and tutorial work offline.
- **Done when:** Lighthouse PWA checks pass, and an offline Playwright test of `/practice` passes.

### ⬜ P66 · Device niceties
- **Needs:** P49
- **Do:** Wake-lock while seated, a sound toggle and vibration settings.
- **Done when:** a manual check on the iOS Simulator + Android emulator (or a real device) is noted.

### ⬜ P67 · Accessibility & mobile audit
- **Needs:** P56, P61
- **Do:** Tap targets of at least 44px, contrast, screen-reader labels on actions and cards, reduced motion, and a 320–430px width sweep.
- **Done when:** no axe violations on the main screens; screenshots of the width sweep.

### ⬜ P68 · Observability
- **Needs:** P13
- **Do:** Sentry on web + server, structured log fields, and basic metrics (active rooms, sockets, pending requests).
- **Done when:** a test error appears in Sentry from both apps.

### ⬜ P69 · Load test
- **Needs:** P51
- **Do:** A script simulating 50 concurrent rooms × 6 players against staging.
- **Done when:** p95 action latency < 150ms and no errors; results recorded here.

### ⬜ P70 · Launch checklist 👤
- **Needs:** all
- **Do:** Production env review, security checklist (ARCHITECTURE §11) walkthrough, custom domain, README final pass.
- **Done when:** the owner signs off.
