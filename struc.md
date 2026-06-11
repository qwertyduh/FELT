# FELT — Folder Structure

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

## Key Boundaries

| Layer | Owns |
|---|---|
| `game/engine.ts` | Pure game logic — no Redis, no DB, no sockets |
| `socket/handlers/` | Translate socket events → call engine → broadcast results |
| `services/` | All Redis and Supabase I/O, called by handlers and routes |
| `routes/` | HTTP-only; no game logic |

Keeping `game/engine.ts` pure (no side effects) makes it easy to unit test the poker rules in isolation before wiring up any real-time plumbing.