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

Legend: ⬜ not started · 🟨 in progress · ✅ done · ⏸ deferred · 👤 needs the owner (login, account, decision)

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

### ✅ P05 · CI
- **Needs:** P01
- **Do:** GitHub Actions workflow running `npm ci`, typecheck, lint and a production build on push/PR. Tests aren't pushed, so CI doesn't run them; they run locally before every commit.
- **Done when:** the first run on GitHub is green.
- _Note: Tester GO on round 1. Two jobs: `verify` (ci, typecheck, lint, format, builds) and `docker` (image build). Uses checkout/setup-node v7. A clean-checkout run in a linux container also passed._

### ✅ P06 · Supabase schema
- **Needs:** P01
- **Do:** `supabase init`, then a migration with `citext`, `profiles` (ARCHITECTURE §7) and RLS (select-only for authenticated users). Enable anonymous sign-in in `supabase/config.toml`. Google stays disabled (deferred).
- **Done when:** `supabase db reset` applies cleanly; a SQL test shows an invalid-format username is rejected and `Bob`/`bob` collide.
- _Note: Tester GO on round 1. Local ports 54320–54324/54327 (another project's stack uses 5532x). Writes are blocked by revoked privileges and also by RLS alone (verified separately). 27 pgTAP tests, local only._

### ✅ P07 · Protocol: username schemas
- **Needs:** P01
- **Do:** In `packages/protocol`: a Zod `UsernameSchema` (format), a `RESERVED_NAMES` list and a `UsernameCheckResult` type. Export them for web + server.
- **Done when:** unit tests cover valid, too short, too long, bad characters and reserved names.
- _Note: GO on round 2. Round 1 failed because removing a reserved word didn't fail any test; fixed with a hardcoded expected list. Reserved-word rule: exact match always counts; words of 4+ characters also match with leading `_` or trailing digits/`_`. For P10, the server must store and return the normalised (NFKC + trim) name, never the raw input._

### ✅ P08 · Profanity filter module
- **Needs:** P07
- **Do:** `apps/server/src/usernames/profanity.ts` wrapping `obscenity` (English dataset + recommended transformers). `isProfane(name): boolean` and `censor(text): string`.
- **Done when:** tests pass for plain, leetspeak (`sh1t`), repeated-character, mixed-case and confusable cases, plus false-positive guards (e.g. `scunthorpe`, `classic`, `bass`).
- _Note: GO on round 2. Round 1 failed on false positives (cockpit, cumin, retardant…) and missed slur spellings. Fixed with a whitelist, extra patterns, and a whole-token regex for spic/coon/paki/kys. Separator-split words still pass `censor` (accepted gap)._

### ✅ P08b · Profanity hardening (follow-up from P08 tester)
- **Needs:** P08
- **Do:** Close the gaps that come from the stock obscenity dataset:
  - (a) `<word ending in s>` + n-word passes (`classnigger`, `bossnigger`) because it reads as "snigger". Flag the n-word even when it follows an `s`, while `snigger`/`sniggering` alone still pass.
  - (b) Compound mild profanity passes: `big_wanker`, `bigwanker`, `big_cock`, `fatcock`, `xxcockxx`, `suck_cock`, `butthole`, `butt_hole`, `cvnt`. Flag these without re-breaking cockpit/cocktail/peacock/Hancock/Cockburn/cocoon.
  - (c) Whitelist `cummings` only. Owner decision: `fukushima`, `fukuoka`, `fukui` and `dickerson` stay BLOCKED; wrongly blocked players use the appeal message (P12).
  - (d) Remove the redundant whitelist entries (`wang`, `butts`, `kuntz`, `fuchs`, `penistone`) if stock obscenity doesn't flag them, and keep tests pinning that they pass.
  - (e) Add tests for the `jackass`/`smartass`/`fatass` patterns so mutations are caught.
- **Done when:** all of the above are covered by `it.each` cases in both directions; the round-2 false-positive sweep (300+ clean names) still passes; mutation of each new rule fails a test.
- _Note: GO on round 1. `cock` is blocked unless it sits inside an allowlisted word (`COCK_WORDS`). Accepted over-blocks under the owner's policy: cocky, cockscomb, some cock-surnames (Laycock, Hiscock…), Cummins, `the_snigger`. Candidates to add to `COCK_WORDS` if users appeal._


### ✅ P09 · Server JWT auth
- **Needs:** P03, P06
- **Do:** Fastify `onRequest` auth hook that verifies the Supabase JWT via JWKS (cached) and sets `request.user = { userId, isAnonymous }`. Add `GET /me`. Widen log redaction to any new secret-bearing headers or fields (`proxy-authorization`, `x-api-key`, tokens in bodies), and add tests for them.
- **Done when:** tests with locally signed tokens cover valid, expired, wrong-issuer and missing-token cases.
- _Note: GO on round 4 (the owner approved an extra round).
  - Local Supabase signs with ES256 (`supabase/signing_keys.json`, gitignored). The server verifies via JWKS only, with two-layer alg allow-list, required `iat`, `maxTokenAge` 1h and 10s tolerance.
  - A JWKS outage or an empty keyset returns 503 `auth_unavailable` with `Retry-After`. Clients must only sign out on 401.
  - pino `redact` is removed. A custom sanitizer in `logging/sanitize.ts` redacts secret keys at any depth and never throws.
  - Logged URLs are path-only.
  - Supabase `jwt_expiry` must stay ≤ 3600._

### ✅ P10 · Username endpoints
- **Needs:** P07, P08, P09
- **Do:** (From the P09 tester: drop `err.rawPacket` in `errSerializer`, because at trace level it carries raw request bytes, which may include tokens. Add a test.) (Also from the P09 tester: a JWT stays valid after logout or user deletion until it expires, so never trust `sub` alone. Look up the profile/user and treat a missing row as 401/404.) `GET /usernames/check` and `POST /me/username`, storing and returning the NORMALISED name (`UsernameSchema.parse` output), following the ARCHITECTURE §6 pipeline. Claiming writes with the service role and maps a unique violation to 409. Rate-limit the check endpoint.
- **Done when:** tests cover every `reason` value, a successful claim, a duplicate claim → 409, and the race (two parallel claims → exactly one 201).
- _Note: GO on round 2. Round 1 failed on two counts: a username like `profiles_pkey` was misread as "already set", and postgrest retries made a hung DB take 27s. Now constraint names are matched in `message` only, and retries are off with per-query deadlines.
  - `npm run env:local -w apps/server` writes `apps/server/.env.local` (gitignored) from `supabase status`.
  - A missing key or DB returns 503 `db_unavailable`.
  - POST conflicts return 409 `username_taken` or `username_already_set`.
  - Rate limits are 30/min for check and 10/min for claim, per user, in memory.
  - Worst-case `/me` for a user without a profile is ~9.5s (two sequential 5s budgets); add a shared deadline if it matters.
  - For P13: set Fastify `trustProxy` correctly behind Railway, and move rate limits to Redis if the server scales out._

### ✅ P11 · Web auth
- **Needs:** P02, P06
- **Do:** Supabase client in `apps/web/src/lib`, automatic anonymous sign-in on first visit, and an auth store (session, `userId`). Google is deferred: no button. On a 401 `expired`/`invalid`, refresh the session once and retry, then sign out. On a 503 `auth_unavailable`, retry with backoff and NEVER sign out.
- **Done when:** a first visit creates an anonymous session, and the same user ID survives a reload (screenshots).
- _Note: GO on round 1.
  - `npm run env:local -w apps/web` writes `apps/web/.env.local` (gitignored). In dev, open the web app at `http://localhost:5173` (not 127.0.0.1) so it matches the server's CORS `WEB_ORIGIN`.
  - Sign-in runs from `main.tsx` (outside React), single-flight plus a Web Lock, so StrictMode and multiple tabs create one user.
  - A dead refresh signs out locally and creates a new anonymous user; transient refresh failures don't sign out; 503 backs off (cap 8s, 4 retries) and never signs out.
  - Minor: a 401 arriving after another call's refresh finished refreshes again (harmless)._

### ✅ P12 · Username onboarding UI
- **Needs:** P10, P11
- **Do:** `/onboarding`: a username input with instant format feedback (shared schema), a debounced availability check and the submit flow. Redirect any user without a username here. When the server rejects a name as `profane`, show a small popup: "Think your name was blocked by mistake? Tag us on social media and we'll set up your account personally." The handle comes from one config constant (`SOCIAL_HANDLE`, placeholder until the owner provides it).
- **Done when:** a Playwright test covers a taken name, a profane name (with the appeal popup), a valid claim and the redirect.
- _Note: GO on round 1. `npm run e2e` runs the Playwright test (starts web + server itself; needs local Supabase and Redis on 6380). `SOCIAL_HANDLE` in `apps/web/src/config.ts` is a placeholder until the owner supplies it. Theme tokens (`felt-*`, `cream`, `brass`, `chip-*`) live in `index.css`.
  - Follow-ups (non-blocking): carry a `returnTo` through onboarding so a deep link like `/r/ABC` survives (do it in P36, join flow). Appeal popup: Esc stops working after clicking its body text, and focus returns to `<body>` after a submit-triggered open. The placeholder text contrast is 2.46:1. The `already_set` path can leave the button stuck on "Claiming…" if the `/me` refresh fails._

### ✅ P13 · Deploy skeleton 👤
- **Needs:** P04, P11
- **Do:** 👤 The owner runs `railway login` and `vercel login`. Create a Railway project with the server service (Dockerfile) and Railway Redis, a Vercel project for `apps/web`, and the production Supabase project. Set the env vars from ARCHITECTURE §12.
- **Done when:** the production web URL loads, anonymous sign-in + username claim work, and the production `/health` reports Redis ok.
- _Note: GO on round 1. Web https://felt-rosy-sigma.vercel.app, server https://server-production-1b135132.up.railway.app, Supabase project `felt` (ap-south-1). See `docs/DEPLOY.md`.
  - Follow-ups: `railway.json` is deprecated and works until 2026-12-01, so run `railway config migrate` before then. The server uses the legacy `service_role` key, because the new `sb_secret_` key returned 401, so revisit this before Supabase retires legacy keys. Add security headers (helmet) on the server. Move rate limits to Redis before running more than one replica. Two stray anonymous users from smoke tests remain in prod._

---

## Stage B — Poker engine (pure, `packages/engine`)

### ✅ P14 · Engine types & card helpers
- **Needs:** P01
- **Do:** Types: `Card`, `Rank`, `Suit`, `SeatState`, `TableState`, `HandState`, `PlayerAction`, `HostAction`, `EngineEvent`, `EngineError`, `Result`. Card `parse`/`format` helpers (`"Ah"`, `"Td"`). Add an ESLint override for `packages/engine` + `packages/bots` banning `Math.random`, `Date.now` and `new Date` (`no-restricted-properties` / `no-restricted-syntax`).
- **Done when:** helper tests pass; types compile; there's no logic yet beyond the helpers.
- _Note: GO round 1. Types in packages/engine/src/types.ts. Code supersedes the ARCHITECTURE §4 sketch: `Result<T,E> = {ok:true,value}|{ok:false,error}`, `Transition = {state,events}`. No antes/straddles. Known lint gaps (non-blocking): `Date()` without new and `globalThis.Math/Date` aren't caught; tsc `types: []` covers performance/setTimeout. Later phases may add fields: raise-reopen tracking (P20), a bet_returned event (P22), a showdown event (P23)._

### ✅ P15 · Deck & shuffle
- **Needs:** P14
- **Do:** `createDeck()` and `shuffle(deck, randInt)` (Fisher–Yates with an injected RNG).
- **Done when:** tests confirm 52 unique cards, a deterministic order with a seeded RNG, and a chi-square sanity check on position distribution.
- _Note: GO round 1. `shuffle` is generic, copies its input and throws RangeError on a bad RNG value. Tester verified uniformity with 3 chi-square tests; 12/12 mutants killed._

### ✅ P16 · 5-card hand evaluator
- **Needs:** P14
- **Do:** `evaluate5(cards)` → `{ category, tiebreak[] }` for all 10 categories, including the wheel (A-2-3-4-5).
- **Done when:** at least one test per category, plus wheel and ace-high straight tests.
- _Note: GO round 1. Royal flush is its own category (9). Bad input throws RangeError. evaluate5 verified against an independent evaluator on all 2,598,960 hands._

### ✅ P17 · 7-card best hand + compare + names
- **Needs:** P16
- **Do:** `bestOf7`, `compareHands` and `handName` ("Full house, Kings over Threes").
- **Done when:** tests over a corpus of at least 30 known head-to-head results, including kicker and split cases.
- _Note: GO round 1. `bestOf7` accepts 5–7 cards and returns the best five. `handName` takes any HandRank. 400k random and adversarial deals matched an independent reference; 22/23 mutants killed (the survivor is equivalent). 100k bestOf7 ≈ 0.74s. Nit: handName throws on a hand-built HandRank with a short tiebreak._

### ✅ P18 · Start hand
- **Needs:** P15
- **Do:** `startHand(table, deck | null)`: button rotation, skipping sat-out and busted players, posting blinds (heads-up rule, short-stack blind all-in), dealing hole cards when a deck is given, and setting the first to act.
- **Done when:** tests cover 2, 3 and 9 players, a button moving past an empty seat, a short-stack blind, and hybrid (no cards).
- _Note: GO round 1. Decisions: eligible = occupied, not sitting out, stack>0; first button = lowest eligible seat; no dead button (so a 3→2 transition can give the same player BB twice); heads-up button = SB and acts first preflop; short blinds post min(blind,stack); currentBet is always bigBlind; deal starts left of the button, no burn cards, deck needs 2n+5. Tester fuzzed 20k tables against an independent reference; 15/15 mutants killed. Follow-ups: use Number.isSafeInteger for stacks and blinds; a runtime guard on mode and sparse seats._

### ✅ P19 · Basic actions: fold / check / call
- **Needs:** P18
- **Do:** `applyAction` for fold/check/call with legality checks, turn order, and detection of the end of a betting round. Last player standing wins the hand.
- **Done when:** tests cover illegal check facing a bet, acting out of turn, everyone checking through, fold to the winner, and the big blind's option pre-flop.
- _Note: GO on round 2. Round 1 found unknown action types accepted as a free pass; fixed, plus null/garbage state and action guards. `applyAction(state, action)` is in actions.ts, with `isBettingComplete` and `firstToActPostflop`. Verified by an independent TDA model fuzz (about 1M steps per run, 12 runs)._

### ✅ P20 · Bet / raise / all-in
- **Needs:** P19
- **Do:** Min bet = big blind, min raise = last full raise, all-in for less, and a short all-in not reopening the action to players who already acted.
- **Done when:** tests for each rule, including the "short all-in doesn't reopen" case and a re-raise after a full raise.
- _Note: GO on round 2. Added `HandPlayer.facedBet`. Short all-ins don't reopen betting, but cumulative short all-ins summing to a full raise do (TDA). `currentBet` stays bigBlind when the BB is short. P21's street reset must set bets, hasActed, facedBet and currentBet to 0, lastFullRaise to bigBlind, and the actor from firstToActPostflop. Follow-ups: P22 returns the uncalled excess (it is currently inside the pot-0 award); consider clamping `call` to the highest live opponent bet._

### ✅ P21 · Street progression
- **Needs:** P20
- **Do:** Advance flop/turn/river (from the deck in online mode, via `HostAction advance_street` in hybrid), reset the round's bets, and auto run-out when everyone is all-in.
- **Done when:** tests cover a full hand in both modes, an all-in pre-flop run-out, and a hybrid hand waiting on the host.
- _Note: GO round 1. New API in street.ts: online `applyAction` auto-advances; hybrid uses `applyHostAction` (one street per advance); `advanceStreet`, `collectBets` (seam for P22), `resetForStreet`. No burn cards. New codes: awaiting_host, betting_incomplete. Server note (P29/P33): if `mode==='online' && currentActor===null` on a live hand (blinds put everyone all-in), call `advanceStreet(state)` once. Consider an exported `needsAdvance(state)` helper. Hybrid board may be shorter than 5 at showdown (host entered no cards): UI/P24 must not assume 5 cards._

### ✅ P22 · Side pots
- **Needs:** P20
- **Do:** `computePots(contributions, folded)` → `{ id, amount, eligible[] }[]`.
- **Done when:** tests for 2, 3 and 4 all-ins at different sizes, a folded player's chips staying in the pot, and an uncalled bet returned.
- _Note: GO on round 2 (Opus tester). Round 1's only finding was a missing test, for river betting settling at showdown; added and the mutant now dies. `computePots(contributions, folded)` in pots.ts, plus `settleBets`, which returns uncalled bets (new event `bet_returned`). Verified with 400k synthetic configs against two independent methods and 80k real engine hands. Notes for P23/P24/P25: pots are only rebuilt at street end, so a mid-street fold leaves the folder in `pots[].eligible` until then (read and validate pots at showdown only). `all_in` can have stack > 0 after a bet return. Returned chips are already in the stack. A single-eligible pot is awarded without evaluating hands. The hybrid board can be shorter than 5 cards._

### ✅ P23 · Showdown & award (online)
- **Needs:** P17, P21, P22
- **Do:** Evaluate each pot's eligible hands, award or split, apply the odd-chip rule, and emit `hand_ended` events.
- **Done when:** tests for a split main pot with a single-winner side pot, a three-way tie, and odd-chip placement.
- _Note: GO on round 2 (Opus tester round 1 found test gaps and corrupt-state throws; fixed). `resolveShowdown` in showdown.ts runs automatically in online mode when the hand reaches showdown. Odd chips go clockwise starting left of the button, per pot. Single-eligible pots aren't evaluated. `HandResult.showdown` lists the non-folded players in a pot with 2 or more eligible, so there is no mucking. Verified against 140k independent hands. Notes for P24: hybrid has no hole cards, so don't call bestOf7; reuse the odd-chip order; mirror the final-state contract (street 'ended', committed zeroed). Non-blocking: a few guards lack tests (duplicate player ids, empty eligible list); numeric player fields (stack/seat) aren't validated; a player id of '__proto__' would be dropped from result maps._

### ✅ P24 · Hybrid award
- **Needs:** P22
- **Do:** `HostAction award_pot` with validation that winners are eligible for that pot; the hand ends once every pot is awarded.
- **Done when:** tests for a valid award, an ineligible winner rejected, and a split award.
- _Note: GO round 1. `awardPot` in award.ts, reached through `applyHostAction({type:'award_pot'})`; `splitPot` is shared with P23. The host awards every pot explicitly, in any order. Winnings go to stacks immediately, tracked by awardedPotIds/pendingAwards, so conservation is sum(stacks) + unawarded pot amounts. A single-eligible pot only accepts that player: the UI should pre-fill it. Non-blocking: no test for a folded id listed in eligible (the guard exists); a player id of '__proto__' breaks the amounts maps (use Object.hasOwn or null-prototype maps if ids ever stop being UUIDs)._

### ✅ P25 · Chip conservation property test
- **Needs:** P23, P24
- **Do:** fast-check: random tables and random legal action sequences; assert total chips are constant and no stack goes negative.
- **Done when:** 1,000+ runs pass in CI time (< 10s).
- _Note: GO on round 2 (test-only changes, verified by mutation re-run). `packages/engine/src/conservation.test.ts` has fast-check properties at 1000 runs each: online, hybrid, determinism with a JSON round-trip, 20-hand multi-hand, and a coverage guard. The file takes about 4.5s. Round 1 found a starved generator (hybrid odd chips never reached); fixed with size 'max' and larger tables. Follow-ups: no test for awarding a pot to a folded player listed in eligible, or for a hybrid award giving the whole pot to the first winner (P24 survivors); the property can't catch non-quantity bugs, which other suites cover._

---

## Stage C — Rooms, join approval, hybrid mode

### ✅ P26 · Protocol: room settings & events
- **Needs:** P07, P14
- **Do:** Zod schemas + types for `RoomSettings`, `PublicRoomState`, and every event in ARCHITECTURE §9 (no handlers). Typed event maps for Socket.io.
- **Done when:** schema tests cover the buy-in range (min ≤ max), the seat range and the action payloads.
- _Note: GO round 1. Protocol files in packages/protocol/src (common, rooms, state, events). Decisions: seats 2–9; room-code alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (31 chars); settings are flat with `maxBuyIn` null meaning no max; the blind-increase amount isn't specified anywhere (P4x must decide); added a `host:inbox` server event and the REST shapes. Notes for later phases: `parseClientEvent` throws on unknown event names (guard with `Object.hasOwn` in P28); the server must re-validate `host:settings` against the merged settings; P27's code generator should consider a small denylist of offensive 4-letter codes; `seats.length`/duplicate-board invariants belong to P32; engine `currentActor` is a seat index and needs mapping to a userId for `turn:start`._

### ✅ P27 · Create & preview room (REST)
- **Needs:** P09, P26, P04
- **Do:** A room code generator (`FELT-XXXX`, no ambiguous characters, collision-checked), `POST /rooms` (stores the initial room in Redis and makes the creator host + admitted) and `GET /rooms/:code`.
- **Done when:** tests for create by a user with a username, create rejected without a username, an unknown code → 404 and the preview shape.
- _Note: GO round 1. `POST /rooms` and `GET /rooms/:code` in apps/server/src/rooms. Room record in Redis `room:{code}` with a 2h TTL, created atomically with SET NX. Per-host cap of 5 open rooms (fails closed under contention). Rate limits: 10 creates/min and 60 previews/min per user. Redis errors → 503 within 2s. Verified against real Redis. Follow-ups (non-blocking): extend the code denylist (KKKK, NGGR, FCUK, SHTT, BTCH, CNTS, PUSS, TARD, JEWS, PUTA, SCUM… and drop the entries that can't be emitted); the TTL test should assert the literal 7200; there's no concurrency test for the cap; `requests`/`seats`/`ledger` sub-schemas are provisional for P30–P32._

### ✅ P28 · Socket.io server + auth
- **Needs:** P09, P26
- **Do:** Attach Socket.io to Fastify, add JWT `io.use()` middleware, restrict the origin, and Zod-validate every incoming event (with a typed handler helper). (From the P09 tester: re-verify on token refresh and disconnect at token `exp`, and never log handshake URLs or query strings.)
- **Done when:** tests show an unauthenticated connection is rejected, an invalid payload gets an error ack, and a valid connection succeeds.
- _Note: GO round 1. `app.realtime` in apps/server/src/realtime attaches Socket.io to Fastify. Auth takes the token from `handshake.auth.token` only, through the same strict verifier as HTTP. Origin allow-list; a missing Origin is allowed (the JWT is the gate). The socket disconnects at the token's `exp`. `onClientEvent` validates payloads and returns error acks. Per-socket token bucket (20/s, burst 40). Verified end to end against real Supabase and Redis. To fix at the start of P29: N1, a real event name with no registered handler never gets an ack (add a fallback: ack not_implemented, or validate and ack invalid_payload); N2, unknown events bypass the rate limit (take a token before the unknown-event check). Also: no per-user connection cap (P29/P30); tests for logging of handshake.auth and Origin lookalikes; the web client (P34) must refresh the token ~5 min early and reconnect, handling unauthorized/token_expired/auth_unavailable; there is no protocol event for in-socket token refresh; real-token `exp` disconnect is only covered by a fake-timer test._

### ✅ P29 · RoomActor & registry
- **Needs:** P27, P28
- **Do:** `RoomActor` (serial async queue, snapshot to Redis after each action) and `RoomRegistry` (get-or-rehydrate by code, evict on idle). No game logic.
- **Done when:** tests show concurrent actions processed in order, state rehydrated after the actor is dropped, and idle eviction.
- _Note: GO round 1. `RoomActor` (serial FIFO queue, bounded at 200, persists with SET XX and a version bump before the new state becomes visible, rolls back on a failed save) and `RoomRegistry` (shared get-or-rehydrate, idle eviction after 10 min, never while queued or active) are in apps/server/src/rooms. `app.roomRegistry`; `isRoomActive` is a placeholder (true while any socket is connected). P28 follow-ups N1/N2 are fixed: a real event with no handler acks internal/'not implemented', and unknown-event floods are rate limited. Single-writer assumption: two server instances can clobber each other (no CAS), which is fine for one Railway instance. Hardening noted for a follow-up commit: validate the committed record and keep its code/hostId unchanged; freeze or clone the task input; dispose and evict the actor on RoomGoneError; per-task timeout; re-entrant enqueue deadlocks (document); a clearer error when a task returns nothing; an ambiguous-timeout save can leave a ghost change in Redis._
- _Hardening (committed after P29's GO, tested by a second tester): tasks get a deep-frozen clone of the room; the returned record is validated and `code`/`hostId` must be unchanged (`invalid_record`); `RoomGoneError` disposes the actor and the registry drops it; a per-task timeout of 10s (`task_timeout`, the late result is discarded); `invalid_task_result`; re-entrant enqueue from inside a running task → `reentrant_enqueue` (AsyncLocalStorage token; a detached enqueue on a bare microtask right after a task returns can still be flagged, so hop a macrotask)._

### ✅ P30 · Join requests (server)
- **Needs:** P29
- **Do:** `room:request_join`, `room:cancel_request`, `host:admit`, `room:enter`, the 2-minute request expiry, the 10-minute deny cooldown and joining the Socket.io room only once admitted.
- **Done when:** tests cover admit, deny + cooldown, expiry, a non-host trying to admit, an admitted player reconnecting without asking again, and a requester never receiving `room:state`.
- _Note: GO round 1. Join requests, admit/deny, cancel, 2 min expiry, 10 min cooldown and room:enter in rooms/{admission,joinService}.ts; channels `room:{code}` and `member:{code}:{userId}` are joined only by room:enter. Expiry is `room:join_decision {approved:false}` with no retryAfter; disconnect does not cancel a request. P36: re-send room:request_join (check the stored expiresAt first) and room:enter after every reconnect. Kick and room end must also remove sockets from both channels. Follow-ups: actor eviction race in requestJoin, per-user limit on room:enter (both folded into P31)._

### ✅ P31 · Seating & buy-in (server)
- **Needs:** P30
- **Do:** `room:sit {seat, buyIn}` (range-checked, writes a `buy_in` ledger entry), `sit_out`/`sit_in` and `leave`.
- **Done when:** tests for a below-min or above-max buy-in, a taken seat, a full table and the ledger entry.
- _Note: GO round 1. Seating in rooms/{seating,seatService}.ts; P30 follow-ups fixed. Defaults the spec did not cover (owner to confirm): lobby leave is a refund; after the game starts, leave records a new `cash_out` ledger kind and the player may only sit back with exactly that amount. P43 must give a player who left busted a way to buy back in (top-up is seated-only today). P52 must net `refund`/`return` entries and keep leavers usernames. P36/P37 must await the room:enter ack before sending seat events. P32: a stack above MAX_CHIPS must not break the public schema. P44 kick: cash out before removing admission. The ledger is unbounded._

### ✅ P32 · Public state builder & broadcast
- **Needs:** P31
- **Do:** `toPublicState(room, hand)`, broadcasting `room:state` with an incrementing `version` after every action.
- **Done when:** tests show the version increments, and a privacy test confirms no hole cards or deck in the output (even when present in the hand state).
- _Note: GO round 1. rooms/publicState.ts (allow-list builder) and rooms/broadcaster.ts (only sender of room:state), RoomActor onCommit hook. Table chip amounts are bounded only by safe integers; MAX_CHIPS still caps inputs. Follow-ups fixed in P33: presence publishing on every reconnect, same version with different content, presence writes refreshing the TTL, swallowed onCommit errors. Open: preClose writes per departing user; no duplicate-board check in the public schema. P33 mid-hand leave/reseat must not desync engine seats. P36 must call resetRoom() when leaving a room._

### ✅ P33 · Hand lifecycle in actor (hybrid)
- **Needs:** P32, P21, P24
- **Do:** `host:start` → `startHand(deck=null)`, `game:act` → engine, `host:advance_street`, `host:award` with the 5s confirm window + `host:dispute`, then the next hand after a short delay. Stacks update from the engine.
- **Done when:** an integration test with 3 socket clients plays a hybrid hand through to award.
- _Note: GO round 2 (round 1: a leaver unmatched bet could be won by a short all-in; fixed, uncalled chips are returned). rooms/{game,gameService,gameSchema}.ts, engine foldOut(); the hand lives in the room record. host:advance_street requires `street` (P41 sends it). Ledger has `hand_result` lines and may have several `cash_out` lines per player (P52). Defaults for the owner to confirm: leaving mid-hand folds you at once (all-in cards stay live); sit_out/new sits apply next hand; host:award covers all pots, dispute stops auto-confirm; 5s next-hand delay; under 2 eligible players the host must start again. P32 follow-ups fixed. Open (non-blocking): a raise voided by the raiser leaving still reopens betting (restore hasActed; fix in P42); side pots can display too large until the river after double walk-outs; no test for the preflop big-blind floor in foldOut; game:act has no turn nonce; timers re-arm only when the room is next loaded (P36 clients must re-enter)._

### ✅ P34 · Web: socket client & room store
- **Needs:** P26, P11
- **Do:** A typed Socket.io client with the auth token and reconnect, and a Zustand room store that applies `room:state` only when its version is newer. No UI.
- **Done when:** unit tests cover out-of-order versions being dropped.
- _Note: GO round 1. apps/web/src/lib/realtime: `createSocketClient` (the auth callback fetches a fresh token on every connect attempt; unauthorized/token_expired → refresh once and retry, up to 3 failures then an error state; auth_unavailable → backoff, never signs out; proactive reconnect 5 min before exp; `emitWithAck` times out to an error result instead of hanging), `useRoomStore` (applies room:state only for a newer version, schema-validated; hand:private is cleared when the hand changes), `bindRoomEvents`. Not connected anywhere yet: P36 will call connect. Verified against the real server: reconnect backoff has no storm, bad token stops after 3 refreshes. Follow-ups (non-blocking): the timeout ack uses a cast because 'timeout' isn't a protocol ErrorCode; hand:private arriving before its room:state would be dropped if the server ever orders them that way; real server-side disconnect at exp isn't tested end to end._

### ✅ P35 · Web: create room screen
- **Needs:** P27, P34
- **Do:** A form for mode, min/max buy-in, blinds, seats, timer and blind increase (defaults from PRD §5.2). Submitting goes to the room.
- **Done when:** Playwright creates a room as a guest; a 375px screenshot.
- _Note: GO round 1. `/new` route (routes/CreateRoom.tsx, lib/createRoom.ts). Hybrid is preselected; Online can be chosen but is not playable until Stage D. Blind increase has only off / every N minutes: nothing says by how much blinds rise (owner decision). Follow-ups fixed in P36: no automatic 503 retry on POST /rooms (could orphan rooms), scroll invalid fields into view, reject malformed number grouping. Open: create can be repeated via Back; no request timeout._

### ✅ P36 · Web: join flow
- **Needs:** P30, P34
- **Do:** `/r/:code` preview → **Request to join** → a pending screen with a countdown → admitted (enter room), denied, or expired states.
- **Done when:** a two-browser Playwright test covers request → admit, and request → deny shows the cooldown.
- _Note: GO round 1. Join flow in routes/Room.tsx and lib/{joinSession,joinStorage,returnTo}.ts; the session store `ready` flag is set only after the room:enter ack (P37/P38 gate sends on it). Added a Cancel request button; returnTo applies to every deep link; leaving the screen does not cancel. Nothing owns typing a room code by hand (PRD 5.2): owner to decide. P35 follow-ups fixed. Fixed in P37: long usernames overflow the pending screen, a cancelled request re-created by a second tab, room:cancel_request cancelling every room, a corrupt denied-until, missing returnTo unit test. Open: no auto retry after a failed preview load._

### ✅ P37 · Web: host request inbox
- **Needs:** P36
- **Do:** Host-only stacked request cards (join + top-up types, with top-up showing a placeholder until P43) offering one-tap Admit/Deny without leaving the table.
- **Done when:** Playwright shows the host admitting 2 queued requests.
- _Note: GO round 3 (round 1: cards moving under the thumb could admit the wrong person; round 2: same via a long touch press; both fixed). components/HostInbox.tsx: fixed-height top-anchored list in normal flow, new or moved cards ignore taps for 400ms, a click must match its pointerdown. P36 follow-ups fixed; room:cancel_request now takes {code}. Top-up card is a text placeholder until P43. P39/P40: recheck the inbox height once the table and action bar share the screen (about one card visible at 375x667). A host transfer (P44) must send the new host the inbox._

### ✅ P38 · Web: waiting room & seat picker
- **Needs:** P31, P37
- **Do:** A seat map, tap a seat → buy-in input (range shown) → sit. The host sees a Start button once 2+ players are seated.
- **Done when:** Playwright shows 3 players seated and the host starting the game.
- _Note: Built and tested (GO). Invite button shown to all admitted players; seats are fixed positions 1-9. A returning leaver learns the exact re-sit amount from the server refusal text (a protocol field would be sturdier). No phase owns a Leave / Sit out button yet. Carry to P39/P40: an arriving request card pushes the buy-in panel and Start out of view; Start tap guard arms on mount only._

### ✅ P39 · Web: table view
- **Needs:** P38
- **Do:** Render seats, usernames, stacks, current bets, pot(s), dealer button and the turn highlight from `room:state`. Read-only.
- **Done when:** screenshots at 375px with 2, 6 and 9 players.
- _Note: GO. Seats keep fixed positions (own seat not rotated to the bottom: owner call). No SB/BB markers. P42 must take a server fix: the pot reads low when a player leaves mid-street (departed bets are not in room:state); it must land before any Leave or kick UI (P44). Folded into P40: lost all-in shows All-in at hand over, stale Start press ref, table with a request card plus action bar is tight._

### ✅ P40 · Web: action bar
- **Needs:** P39, P33
- **Do:** Fold/Check/Call/Bet/Raise/All-in, showing only the legal ones; a bet slider with ½, ⅔, pot and all-in presets; ack errors shown inline.
- **Done when:** Playwright plays a hybrid hand to the river through the UI.
- _Note: GO. Added engine legalActions, hand.turnSeq (required on game:act, so web and server must deploy together) and hand.options. Owner calls: no typed bet amount (slider and presets only); Fold stays offered with no confirm when Check is free; raise hidden when all opponents are all-in. P42 must never restore an older turnSeq on undo. Folded into P41: error notice hides To call; All-in label means two different amounts; taps silently ignored after a lost ack; own seat clipped at 320x568 with a request card._

### ✅ P41 · Web: hybrid host controls
- **Needs:** P40
- **Do:** A "Flop / Turn / River dealt" advance button, the optional community-card entry, and the award UI (pick winner(s) per pot), plus the 5s confirm banner with a Dispute button for players.
- **Done when:** Playwright plays a hand including a side pot through to award.
- _Note: GO. turnSeq now required on host:advance_street and host:award. An unseated host may dispute. Owner calls: recorded community cards are stored but shown nowhere; an award that expires while the server is down is paid on reload with no new window. Folded into P42: award winner names truncate (money choice), disputed banner covers the screen with no way to see the table, award sheet picks lost when a folded player leaves._

### ✅ P42 · Hybrid undo & stack adjust
- **Needs:** P41
- **Do:** Server: undo stack (last K states) and `host:adjust_stack` (ledger `adjust` entry with a reason). UI: an Undo button and an adjust-stack dialog, with both logged in a visible room log.
- **Done when:** tests for undoing an action mid-street, undo being unavailable after a hand ends, and an adjustment appearing in the ledger; a Playwright test for undo.
- _Note: GO (Opus tester). Undo keeps the last 10 moves and deals; the history is wiped by hand end, a dealt-in player leaving, and any stack correction to a dealt-in player. Owner to confirm: adjust refused while the target is live in the hand; a hand-ending move cannot be undone; adjust reason is free text with no profanity filter; adjusting to 0 then leaving counts as busted and blocks re-sit. P44 kick must empty the undo history. P43 must handle a busted leaver. P52 must count signed adjust lines. Web and server deploy together._

### ✅ P43 · Top-ups (buy more)
- **Needs:** P37, P33
- **Do:** Server: `player:topup_request` (max buy-in check), `host:topup`, approved amounts queued and applied at the next hand start, ledger `top_up`. UI: a **Buy more** button + amount input, the host card in the inbox, and the decision toast.
- **Done when:** tests show a top-up approved mid-hand is applied only at the next hand, a decline, and a max-buy-in breach rejected; Playwright covers the end-to-end flow.
- _Note: GO. Owner to confirm (PRD silent): a busted leaver re-sits with 0 and buys back with host approval; a top-up that would exceed max buy-in when due is dropped whole; the host approves their own top-up; no minimum; one outstanding top-up per player with no cancel; leaving drops it; an offline player misses the decision notice. P44 kick must go through leave and end game must clear the queue. P52 counts top_up lines. Folded into P44: clipped Approve buttons on the worst-case 320px card, toast covers Home, Buy more sheet stays over the action bar when your turn arrives._

### ✅ P44 · Host room controls
- **Needs:** P33
- **Do:** Pause/resume, kick (removes admission), change blinds (next hand), transfer host and end game (recap placeholder), with server + UI.
- **Done when:** tests for each control, plus a non-host attempt rejected.
- _Note: GO on round 2 (round 1: the host could not remove an admitted player with no seat). Owner to confirm (PRD silent): ending the game during a live hand cancels it and refunds everyone, so a host losing a hand can take the bet back; kicked players may ask again with no cooldown; blinds are manual only. Gaps: no player Leave / Sit out button (no phase owns it); ended or transferred rooms still count toward the 5-room cap; host:mute unimplemented. P52: end keeps seats with final stacks and does not send session:recap._

### ✅ P45 · Reconnection & host failover
- **Needs:** P44
- **Do:** Seat hold for the grace period, resync on reconnect, a second device taking over the session, host auto-transfer after 2 minutes, and a turn waiting for the host to force-fold when the timer is off.
- **Done when:** tests use fake timers for each case; Playwright kills and restores a page mid-hand.
- _Note: GO. 3 minute default seat hold; host failover after 2 minutes to the longest-seated connected player; latest device wins. Owner to know: a hybrid room with a turn timer has no force-fold and timers arrive only with P48, so a dropped player stalls the hand until removed (P48 must cover hybrid); away players are still dealt in during the hold; force-fold cannot be undone. P46 follow-ups: vacuous queued-intent test in presence.test.ts; a take-over dropping mid-save can show Open on another device wrongly. Web and server deploy together._

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

### ⏸ P71 · Google sign-in (deferred)
- **Needs:** P13
- **Do:** 👤 The owner creates a Google OAuth client. Enable the provider in Supabase, add "Link Google account" to the profile using `linkIdentity`, and keep the user ID and username.
- **Done when:** a guest links Google and, on a second device, signs in with Google to the same username.

### ⬜ P70 · Launch checklist 👤
- **Needs:** all
- **Do:** Production env review, security checklist (ARCHITECTURE §11) walkthrough, custom domain, README final pass.
- **Done when:** the owner signs off.
