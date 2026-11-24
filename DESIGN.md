# FELT — Design & Tech Stack

_Consolidated from prd.md and struc.md. Part A is the product/tech design, Part B is the planned folder structure, Part C is what had been built before the reset._

---

# Part A — Product Requirements & Tech Stack

## Product Requirements Document
### FELT — Multiplayer Texas Hold'em Platform

**Version:** 1.0  
**Status:** Draft  
**Author:** —  
**Last Updated:** May 2026

---

### 1. Overview

FELT is a public-facing, full-stack multiplayer Texas Hold'em platform built primarily as a learning project. It covers the full modern web stack: real-time communication via WebSockets, persistent storage with Supabase (PostgreSQL), ephemeral game state in Redis, containerized services via Docker, a Vite-powered frontend, and a Node.js REST API with JWT-based auth.

The platform supports three distinct game modes, in-game chat, a leaderboard, and player stats — all on a mobile-responsive UI.

---

### 2. Goals

#### Learning Goals
| Technology | What Gets Practiced |
|---|---|
| **WebSockets** | Real-time game state sync, room events, chat |
| **Redis** | Game room cache, turn timers, session store |
| **Supabase / PostgreSQL** | User accounts, hand history, stats, leaderboard |
| **Docker** | Multi-container setup (API, Redis, frontend) via Compose |
| **Vite** | Frontend build pipeline, HMR, environment config |
| **Node.js REST API** | Auth, lobby, user endpoints |
| **Auth (JWT + Supabase Auth)** | Registration, login, protected routes, token refresh |

#### Product Goals
- Playable by anyone who signs up (no invite needed)
- Three game modes covering different use cases (online, hybrid, learning)
- Clean, mobile-responsive UI
- Stats and leaderboard to motivate continued play

---

### 3. Game Modes

#### Mode 1 — Full Online
Everything is digital. Cards are dealt and displayed on screen. All betting actions happen in the browser. Intended for standard online play between 2–9 players.

#### Mode 2 — Hybrid (Betting Only)
Players have a physical deck of cards in front of them. The app handles only the betting round — raise, call, fold, check — and tracks the pot. No cards are rendered. Players manually deal and reveal cards. Useful for in-person home games that want digital pot/chip tracking.

#### Mode 3 — Learning / Bot Mode
A solo player is matched against one or more AI bots. The bot uses a rule-based strategy engine (no ML required for v1). The UI shows tips, odds, and pot equity hints to help the player learn hand strength and betting strategy. This mode is also the onboarding path for new users.

---

### 4. Tech Stack

```
Frontend         Vite + React + TypeScript
Styling          Tailwind CSS
Real-time        Socket.io (client + server)
Backend          Node.js + Fastify
Auth             Supabase Auth (email/password + JWT)
Primary DB       Supabase (PostgreSQL) — users (with embedded stats)
Cache / State    Redis — active game rooms, turn state, timers
Containerization Docker + Docker Compose
```

#### Docker Services (Compose)
| Service | Image |
|---|---|
| `api` | Custom Node.js image |
| `redis` | `redis:alpine` |
| `frontend` | Served via Vite dev server or nginx in prod |

Supabase runs as a managed cloud service (no local container needed for v1).

---

### 5. Architecture

```
Browser (Vite/React)
  │
  ├── REST (HTTP)   ──▶  Node.js API  ──▶  Supabase (PostgreSQL)
  │                          │
  └── WebSocket    ──▶  Socket.io     ──▶  Redis (game rooms)
```

- **REST API** handles: auth, user profile, lobby creation, leaderboard, stats
- **Socket.io** handles: joining a room, game events (deal, bet, fold), chat, timer sync
- **Redis** stores: room state, player hands (Mode 1), turn order, pot, timers (TTL)
- **Supabase** stores: user records, chip balances, hand history, leaderboard snapshots

---

### 6. Features

#### 6.1 Auth
- Sign up with email + password (Supabase Auth)
- Login / logout
- JWT stored in httpOnly cookie or localStorage
- Protected routes on frontend and API middleware

#### 6.2 Lobby
- Create a room (choose mode, max players, starting chips, blind levels)
- Join a room via room code or public room list
- Waiting room shows connected players; host starts the game

#### 6.3 Full Online Game (Mode 1)
- Server deals cards; each player's hand is private (stored in Redis, sent only to that player's socket)
- Game phases: Pre-flop → Flop → Turn → River → Showdown
- Actions: Fold, Check, Call, Raise, All-in
- Turn timer (configurable, default 30s); auto-fold on timeout
- Pot split logic for side pots
- End-of-hand summary: winner, hand rank, chips won

#### 6.4 Hybrid Betting Mode (Mode 2)
- No card dealing or rendering
- Players manually enter community cards at each phase (host-controlled input)
- App tracks: pot, current bet, player chip stacks, action order
- Same betting actions as Mode 1

#### 6.5 Learning / Bot Mode (Mode 3)
- Solo player vs 1–3 configurable bots
- Bots use a rule-based engine: tight-aggressive baseline with randomised bluff frequency
- UI overlay shows: current hand rank, pot odds, rough equity %
- Pause and "explain this situation" button — generates a brief text hint
- Stats tracked same as live mode

#### 6.6 In-Game Chat
- Room-scoped chat via Socket.io
- Messages include player name, timestamp
- Emoji reactions to last action (fold 💀, raise 🔥, etc.)
- No direct messages in v1

#### 6.7 Leaderboard & Stats
- Global leaderboard: ranked by total chips won all-time
- Per-user stats: hands played, hands won, biggest pot won, win rate %, VPIP (voluntarily put money in pot)
- Stats update after each hand (written to Supabase)
- Leaderboard page refreshes every 60s (polling in v1; websocket push in v2)

#### 6.8 User Profile
- Avatar (initials-based in v1, upload in v2)
- Chip balance (virtual, no real money)
- Stats summary
- Game history (last 20 hands)

---

### 7. Data Models (Supabase / PostgreSQL)

#### `users`
All stats are columns on the users table — no separate stats table needed.

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | Supabase Auth UID |
| username | text unique | |
| chip_balance | integer | Default 1000; replenished via purchase at 0 |
| hands_played | integer | Default 0 |
| hands_won | integer | Default 0 |
| total_chips_won | integer | Default 0 |
| biggest_pot | integer | Default 0 |
| vpip | float | Default 0.0; updated per hand |
| created_at | timestamptz | |

**Chip purchase:** when `chip_balance` hits 0, the user is prompted to buy more chips (virtual, no real money in v1 — treated as a free top-up of 1000 chips). A `POST /users/:id/buy-chips` endpoint resets the balance.

#### Redis Keys (Game Cache)
| Key Pattern | Value | TTL |
|---|---|---|
| `room:{roomId}` | JSON room state | 2h |
| `room:{roomId}:hand` | Current hand state (cards, pot, phase) | Until hand ends |
| `room:{roomId}:timer` | Seconds remaining for turn | 30s |
| `session:{userId}` | Socket ID mapping | 1h |

---

### 8. API Endpoints (REST — Fastify)

| Method | Path | Description |
|---|---|---|
| POST | `/auth/register` | Create account |
| POST | `/auth/login` | Login, return JWT |
| POST | `/auth/logout` | Invalidate session |
| GET | `/users/:id` | Get profile + stats |
| POST | `/users/:id/buy-chips` | Top up chips to 1000 when balance is 0 |
| GET | `/leaderboard` | Top 50 by total chips won |
| POST | `/rooms` | Create room |
| GET | `/rooms` | List public rooms |
| GET | `/rooms/:id` | Room details |

---

### 9. Socket.io Events

#### Client → Server
| Event | Payload | Description |
|---|---|---|
| `join_room` | `{ roomId, userId }` | Join a game room |
| `game_action` | `{ type: fold/call/raise, amount? }` | Player action |
| `chat_message` | `{ text }` | Send chat |
| `reveal_cards` | `{ communityCards }` | Mode 2 host input |
| `start_game` | — | Host starts the room |

#### Server → Client
| Event | Payload | Description |
|---|---|---|
| `room_update` | Full room state | Player joined/left |
| `game_state` | Game phase, pot, bets | State broadcast |
| `your_hand` | Private cards | Sent only to recipient |
| `new_message` | Chat message | Broadcast to room |
| `turn_start` | `{ userId, timeLeft }` | Whose turn + timer |
| `hand_result` | Winner, hands revealed | End of hand |

---

### 10. Milestones

#### Phase 1 — Foundation
- [ ] Repo + Docker Compose setup (API + Redis containers)
- [ ] Supabase project created, schema migrated
- [ ] Auth: register, login, JWT middleware
- [ ] Basic Vite + React app with auth pages

#### Phase 2 — Core Game (Mode 1)
- [ ] Room creation & lobby (REST + Socket.io)
- [ ] Card dealing engine (server-side)
- [ ] Full Texas Hold'em game loop
- [ ] Turn timer via Redis TTL
- [ ] End-of-hand resolution + chip update

#### Phase 3 — Chat, Stats, Leaderboard
- [ ] In-game chat
- [ ] Stats written after each hand
- [ ] Leaderboard page

#### Phase 4 — Mode 2 (Hybrid) + Mode 3 (Bot)
- [ ] Hybrid mode (host-controlled community cards)
- [ ] Bot engine (rule-based)
- [ ] Learning UI overlays (odds, hints)

#### Phase 5 — Polish
- [ ] Mobile responsive pass
- [ ] Docker production build (nginx for frontend)
- [ ] README + architecture diagram

---

### 11. Out of Scope (v1)
- Real money / payment processing
- Video/voice chat
- AI-powered bots (ML)
- Tournaments
- Mobile native app
- OAuth (Google, GitHub login)

---

### 12. Open Questions
1. Bot difficulty levels — how many tiers for v1? Suggest: one baseline (tight-aggressive) + one loose style.
2. Room persistence — archiving finished rooms to Supabase deferred to v2.
---

# Part B — Folder Structure

## FELT — Folder Structure

```
felt/
├── docker-compose.yml              # Orchestrates: api, redis, frontend
├── .env.example                    # All env vars documented
├── README.md
│
├── frontend/                       # Vite + React + TypeScript
│   ├── Dockerfile
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.ts
│   ├── package.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       │
│       ├── pages/                  # One file per route
│       │   ├── Login.tsx
│       │   ├── Register.tsx
│       │   ├── Home.tsx            # Room list + create room
│       │   ├── Lobby.tsx           # Waiting room before game starts
│       │   ├── Game.tsx            # Main game view (all 3 modes)
│       │   ├── Leaderboard.tsx
│       │   └── Profile.tsx
│       │
│       ├── components/
│       │   ├── ui/                 # Generic reusables (Button, Modal, etc.)
│       │   ├── auth/               # LoginForm, RegisterForm
│       │   ├── lobby/              # RoomCard, CreateRoomModal, PlayerList
│       │   ├── game/
│       │   │   ├── Table.tsx       # Poker table layout
│       │   │   ├── PlayerSeat.tsx
│       │   │   ├── CardHand.tsx    # Renders hole cards (Mode 1)
│       │   │   ├── CommunityCards.tsx
│       │   │   ├── ActionBar.tsx   # Fold / Call / Raise controls
│       │   │   ├── PotDisplay.tsx
│       │   │   ├── TurnTimer.tsx
│       │   │   ├── HybridInput.tsx # Host enters community cards (Mode 2)
│       │   │   └── BotHints.tsx    # Odds + equity overlay (Mode 3)
│       │   └── chat/
│       │       ├── ChatPanel.tsx
│       │       └── ChatMessage.tsx
│       │
│       ├── hooks/
│       │   ├── useSocket.ts        # Socket.io connection + event binding
│       │   ├── useAuth.ts          # Login state, JWT, redirect
│       │   └── useGame.ts          # Game state derived from socket events
│       │
│       ├── socket/
│       │   └── client.ts           # Socket.io client instance + typed events
│       │
│       ├── api/
│       │   └── client.ts           # Axios/fetch wrapper for REST calls
│       │
│       ├── store/
│       │   └── useStore.ts         # Zustand global store (auth, room, game)
│       │
│       └── types/
│           └── index.ts            # Shared TS types (Room, Player, GameState…)
│
├── backend/                        # Node.js + Fastify
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts               # Fastify instance, register plugins, start
│       │
│       ├── config/
│       │   ├── env.ts              # Zod-validated env vars
│       │   ├── redis.ts            # Redis client setup
│       │   └── supabase.ts         # Supabase client setup
│       │
│       ├── routes/
│       │   ├── auth.ts             # POST /auth/register, /login, /logout
│       │   ├── users.ts            # GET /users/:id, POST /users/:id/buy-chips
│       │   ├── rooms.ts            # POST /rooms, GET /rooms, GET /rooms/:id
│       │   └── leaderboard.ts      # GET /leaderboard
│       │
│       ├── socket/
│       │   ├── index.ts            # Socket.io server init, attach to Fastify
│       │   ├── middleware.ts       # JWT auth for socket connections
│       │   └── handlers/
│       │       ├── room.ts         # join_room, start_game
│       │       ├── game.ts         # game_action, reveal_cards
│       │       └── chat.ts         # chat_message
│       │
│       ├── game/
│       │   ├── engine.ts           # Core game loop (phases, action resolution)
│       │   ├── deck.ts             # Shuffle + deal
│       │   ├── evaluator.ts        # Hand ranking (pair, flush, straight…)
│       │   ├── bot.ts              # Rule-based AI (tight-aggressive baseline)
│       │   └── timer.ts            # Turn timers backed by Redis TTL
│       │
│       ├── services/
│       │   ├── roomService.ts      # Redis room CRUD helpers
│       │   ├── userService.ts      # Supabase user + stats updates
│       │   └── statsService.ts     # Post-hand stat writes (chips, vpip, etc.)
│       │
│       ├── middleware/
│       │   └── auth.ts             # JWT verify hook for Fastify routes
│       │
│       └── types/
│           └── index.ts            # Shared types: Room, GameState, Player…
│
└── supabase/
    └── migrations/
        └── 001_init.sql            # users table with all stat columns
```

---

### Key Boundaries

| Layer | Owns |
|---|---|
| `game/engine.ts` | Pure game logic — no Redis, no DB, no sockets |
| `socket/handlers/` | Translate socket events → call engine → broadcast results |
| `services/` | All Redis and Supabase I/O, called by handlers and routes |
| `routes/` | HTTP-only; no game logic |

Keeping `game/engine.ts` pure (no side effects) makes it easy to unit test the poker rules in isolation before wiring up any real-time plumbing.
---

# Part C — State at time of reset (implementation notes)

Built so far (all optional to reuse):
- **Backend** (`backend/`): Fastify 4 + TypeScript run with `tsx watch`. Deps: `@fastify/jwt`, `@fastify/rate-limit`, `@supabase/supabase-js`, `jwks-rsa` (verifying Supabase JWTs via JWKS), `dotenv`. Files: `server.ts`, `supabase.ts`, `routes/auth.ts` (register endpoint), `middleware/authGuard.ts`.
- **Frontend** (`frontend/`): Vite 8 + React 19 + TypeScript 6 scaffold only (default template; no Tailwind, Socket.io, Zustand yet).
- **Docker Compose**: services `backend` (port 3000), `frontend` (port 5173), `redis` (redis:7-alpine, port 6379), shared `felt-network`, volume `redis_data`; bind-mounts source for dev; env via root `.env`.
- **Env vars** (`.env.example`): `FRONTEND_PORT`, `BACKEND_PORT`, `REDIS_PORT`, `JWT_SECRET`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (compose also passes `SUPABASE_JWT_SECRET`, `REDIS_URL`).
- **Supabase**: local `config.toml`; migration `init_schema` creating `public.users` (id uuid PK, username unique, chip_balance default 1000, hands_played, hands_won, total_chips_won, biggest_pot, vpip, created_at) with RLS: public SELECT, owner-only UPDATE (`auth.uid() = id`).
- Last commit: "create register endpoint".
