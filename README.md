# FELT

**Poker night, minus the chip counting.**

FELT is a mobile-first web app for No-Limit Texas Hold'em with friends. Create a private room, share the link, and let your friends in. Everyone plays from their phone, with no download and no account needed.

- **Online:** FELT deals, and you play together from anywhere.
- **Hybrid:** real cards on a real table, while FELT tracks every bet, pot and side pot.
- **Practice:** learn the rules step by step, then play hands against bots with live odds and hints. Works offline.

The host sets the minimum buy-in and approves top-ups. At the end of the night everyone gets a recap, including a settle-up list.

> **Status:** pre-alpha, being rebuilt. See [`docs/PRD.md`](docs/PRD.md) (product), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (technical design) and [`docs/PLAN.md`](docs/PLAN.md) (phased build plan).

## Stack
React + Vite + Tailwind (PWA) · Fastify + Socket.io · Redis · Supabase (Auth + Postgres) · TypeScript throughout

## Getting started

> These steps describe the planned setup and will be finalised once the monorepo is scaffolded.

### Prerequisites
- Node.js 22+
- Docker (for local Redis)
- A Supabase project with Anonymous sign-in enabled
- CLIs: `supabase`, `vercel`, `railway`

### Setup
```bash
git clone <repo-url> felt && cd felt
npm install
cp .env.example .env            # fill in Supabase keys
docker compose up -d redis
npm run dev                     # web on :5173, server on :3000
```

### Tests
```bash
npm test        # unit tests (engine, server)
npm run e2e     # Playwright multiplayer flows
```

## Project structure
```
apps/web          React PWA
apps/server       Fastify + Socket.io game server
packages/engine   Pure poker rules engine
packages/bots     Practice-mode bots and hints
packages/protocol Shared types and event schemas
supabase/         Database migrations
docs/             PRD and architecture
```

## Deployment
- **Web:** Vercel
- **Game server:** Docker container on Railway (needs WebSockets, so not Vercel)
- **Redis:** Railway Redis
- **Auth & DB:** Supabase

## License
TBD
