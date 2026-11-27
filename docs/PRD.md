# FELT — Product Requirements

**Status:** Draft v2.1 (post-reset) · **Last updated:** 2026-11-24
**Supersedes:** `DESIGN.md` Part A (v1 learning-project PRD)
**Build plan:** [`PLAN.md`](./PLAN.md)

---

## 1. Summary

FELT is a mobile-first web app for playing Texas Hold'em with friends. A host creates a private room and shares a link. Friends request to join from their phones, after picking a username, and the host lets them in. FELT supports three ways to play:

1. **Online:** FELT deals the cards and everyone plays on their own device, in the same room or remotely.
2. **Hybrid:** a real deck on a real table, with FELT replacing the chips. Each player bets from their own phone and the host advances the streets.
3. **Practice:** a solo tutorial that teaches the rules and flow of the game, then practice hands against bots.

Chips exist only for the length of a game. The host sets a minimum buy-in and approves further buy-ins. When the game ends, everyone gets a session recap: who bought in for how much, who won and lost, and a settle-up list. Nothing carries over to the next game.

### What changed from v1
| v1 (DESIGN.md) | v2 (this doc) |
|---|---|
| Learning project, public | Real product for friends & home games |
| Persistent chip balance, buy-chips top-up | Per-game buy-ins, host-approved top-ups |
| Global leaderboard + lifetime stats | End-of-game session recap only |
| Email + password | Guest accounts with unique usernames (Google sign-in deferred) |
| Public room list | Private rooms; host approves every join |
| Bot mode with hints | Practice = tutorial stage + practice-hands stage |
| Responsive web | Mobile-first PWA |

---

## 2. Goals & non-goals

### Goals
- **Fast joining.** A friend taps a link, requests to join, and is seated as soon as the host approves, with no account required.
- **Hybrid mode is first-class.** It replaces a box of chips at a home game and must be faster than counting real chips.
- **Correct poker.** Betting rules, side pots and hand evaluation are exact and server-authoritative.
- **Survives real phones.** Locked screens, flaky Wi-Fi and app-switching never cost a player their seat or their chips.

### Non-goals (v1)
- Real money of any kind. FELT never moves money; settle-up is informational.
- Public lobby or matchmaking with strangers.
- Spectators (non-seated viewers).
- Lifetime stats, leaderboards and hand history archives.
- Tournaments.
- Native iOS/Android apps, since FELT ships as a PWA only.
- **Google sign-in** (deferred to a later release; design kept in ARCHITECTURE §6).
- **Apple sign-in.** On the web it needs a paid Apple Developer Program membership ($99/yr) to create the required Services ID. Testing doesn't need it, because the iOS Simulator (free with Xcode) and Playwright's mobile WebKit both work without an account. Apple sign-in can be added later if iPhone users ask for it.
- **Local-network / offline multiplayer.** A browser can open a socket *to* a server, but it can't *be* a socket server, so phones on the same Wi-Fi can't talk to each other directly. The workarounds (a host phone running the game over WebRTC, or a laptop running a local server) break server-authoritative play and card privacy, so multiplayer needs internet. Practice mode runs fully on the device and works offline.
- Voice/video chat.
- Poker variants other than No-Limit Texas Hold'em.

---

## 3. Users

| Persona | Situation | Needs |
|---|---|---|
| **Host** | Organises the Friday game and owns the room. | Fast setup, control over who joins, blinds, buy-ins; can fix mistakes in hybrid mode. |
| **Player** | Invited by link. May not have an account. | Join quickly, a clear "your turn" signal, obvious bet controls on a phone. |
| **Remote friend** | Can't make it in person. | Join an online-mode game from anywhere. |
| **Learner** | New to poker or rusty. | Learn the rules step by step, then practise without social pressure. |

---

## 4. Core concepts

- **Room:** a private game space with a short code (e.g. `FELT-7KQ2`) and an invite link. It has one host, a mode and settings, and lives until the host ends it or it's idle for 2 hours.
- **Join request:** a player's request to enter a room. Only the host can approve it.
- **Seat:** up to 9 per room. A player holds a seat for the whole game and can sit out.
- **Buy-in:** chips a player brings to the table. The first buy-in must be at least the room's minimum, and later buy-ins (top-ups) need host approval.
- **Stack:** a player's chips in this room. It changes only through play, approved top-ups and host corrections (hybrid).
- **Hand:** one deal, from blinds to showdown.
- **Session:** everything from the first hand until the host ends the game. It produces the recap.

---

## 5. Features

### 5.1 Identity & usernames
- **v1: guest accounts only.** On first visit the player picks a username and plays. Behind the scenes this is a Supabase anonymous session that persists on the device, so the same username comes back next time on that device.
- **Google sign-in is deferred** (not in v1). When it's added, a player links Google to their existing guest account and keeps the same user ID and username. The docs keep the Google design so it can be picked up later.
- Anyone can create and host any room type, and join any room.
- **Usernames:** chosen once, on first visit.
  - 3–20 characters: letters, numbers and underscore.
  - Unique, case-insensitive (`Pranay` and `pranay` collide).
  - Rejected if profane, including obfuscated spellings (`a$$`, `sh1t`, spacing tricks), or if reserved (`admin`, `host`, `felt`, `support`, `guest`…).
  - Availability is checked live while typing and checked again on submit, so two people can't grab the same name at once.
  - The filter errs on the side of blocking. A name rejected as profane gets a plain message. The "blocked by mistake? tag us on social media" appeal popup is switched off until there is a social handle (set `SOCIAL_HANDLE` in `apps/web/src/config.ts` to turn it on; the owner would then create those accounts manually).
- Clearing browser data loses the guest account; the player then picks a new username. Account recovery comes with Google sign-in later.
- Profile = username + initials avatar. Nothing else is stored in v1.

### 5.2 Rooms
- **Create room:** choose the mode, then settings:
  - Minimum buy-in (default 1,000)
  - Maximum buy-in (default none)
  - Small / big blind (default 5 / 10)
  - Max seats (2–9, default 9)
  - Turn timer: off / 15 / 30 / 60s (default 30s for online, **off** for hybrid)
  - Blind increase: off / every N minutes (default off), multiplying the blinds by 1.5 or 2 (default 2). The host can change it from the Host menu. New blinds apply from the next hand; the countdown starts with the first hand, stops while paused and restarts when the host sets blinds by hand
- **Join by permission (always on):**
  1. A player opens the link (`/r/FELT-7KQ2`) or types the code, and sees a room preview (host, mode, blinds, seats taken).
  2. They tap **Request to join**.
  3. The host gets a request card (username) and taps **Admit** or **Deny**.
  4. If admitted, the player enters the room and picks a seat. If denied, they see a message and can't request again for 10 minutes.
  - Requests expire after 2 minutes without an answer.
  - Once admitted, a player can reconnect for the rest of the session without asking again. A kicked player must request again.
- **Host controls:** start game, pause/resume, admit/deny, kick, approve top-ups, change blinds between hands, transfer host, end game.
- If the host disconnects for more than 2 minutes, the host role transfers to the longest-seated connected player.
- New players can be admitted mid-session and are dealt in from the next hand.

### 5.3 Buy-ins & top-ups
- When taking a seat, the player enters their buy-in: at least the room minimum and at most the maximum (if set). The first buy-in needs no approval, because the host already admitted them.
- **Top-up (buy more):** a seated player taps **Buy more** and enters an amount. The host gets a request to **Approve** or **Decline** it.
  - It's allowed at any time, including when the player is busted (stack 0).
  - An approved top-up is added to the stack **between hands**, never mid-hand.
  - It must keep the stack within the max buy-in, if one is set.
- Every buy-in and top-up is recorded in the session ledger and shown in the recap.

### 5.4 Online mode
- The server shuffles (with a cryptographically secure shuffle) and deals. Each player's hole cards are sent only to that player.
- Streets: pre-flop → flop → turn → river → showdown.
- Actions: fold, check, call, bet/raise (with min-raise rules), all-in.
- Side pots are computed automatically, and tied hands split the pot.
- Showdown reveals cards in the correct order, and losing players may muck.
- Turn timer: on expiry the player auto-checks if possible, otherwise auto-folds. Two consecutive timeouts sit the player out.
- End-of-hand summary: winner(s), winning hand name, pot(s) awarded.

### 5.5 Hybrid mode (betting only)
Physical cards, digital chips, and **every player on their own phone**.
- The app shows no cards. It tracks the dealer button, blinds, action order, bets, pot(s) and stacks.
- Each player acts on their own phone using the same action controls as online mode.
- **The host advances the streets** ("Flop dealt" → "Turn dealt" → "River dealt"). Entering the actual community cards is optional, for the record only.
- **Showdown:** the app can't see the cards, so the host taps the winner(s) of each pot, and split pots are supported. Every player sees the proposed award, which auto-confirms after 5 seconds unless someone disputes it.
- **Undo:** the host can undo the last action, since mis-taps happen at a physical table.
- **Correct stack:** the host can manually adjust a player's stack to fix real-world mistakes. Every adjustment appears in the room log.
- **Table view** toggle: a large, glanceable pot and action display for a phone propped in the middle of the table.

### 5.6 Practice mode
Solo, fully on the device. It needs no server or room, works offline once the PWA is installed, and is open to guests.

**Stage 1: Learn the game (tutorial).** A short, step-by-step guided walkthrough on the real table UI with scripted hands:
1. The goal of the game and what chips mean
2. Seats, dealer button, small and big blinds
3. Hole cards and the four betting rounds (pre-flop, flop, turn, river)
4. Actions: fold, check, call, bet, raise, all-in
5. Hand rankings (links to the hand-rank sheet, §5.8)
6. Showdown: who wins, split pots, and side pots in brief
7. A guided full hand, where the player makes each decision with prompts

Lessons can be skipped, progress is saved on the device, and the tutorial can be replayed.

**Stage 2: Practice hands.** The player plays against 1–5 bots.
- Rule-based bots with two styles: **Tight-aggressive** and **Loose-passive**, with randomised bluff frequency. Bots act with a short, human-like delay.
- **Hints overlay** (toggleable): current hand rank, outs, pot odds, and approximate equity.
- **"What should I do?"** button gives a short explanation generated from templates, for example: "You have a flush draw with 9 outs (~35% by the river). Calling 40 into 120 needs 25% equity, so calling is profitable."
- No timer. The player can pause at any time and start a new session with fresh stacks.

### 5.7 Chat & reactions
- Room-scoped text chat. It's on in online mode and collapsed by default in hybrid, since everyone is at the table.
- Quick emoji reactions appear briefly next to the player's seat.
- The host can mute a player. There are no direct messages.

### 5.8 Hand rankings button
- A floating button is visible on every table screen (online, hybrid, practice, tutorial). It never covers the action bar.
- Tapping it opens a sheet listing hand ranks from best to worst, each with an example hand:
  Royal flush → Straight flush → Four of a kind → Full house → Flush → Straight → Three of a kind → Two pair → One pair → High card.
- In online and practice modes the player's current best hand is highlighted.
- The sheet closes on tap-outside or swipe-down. It doesn't pause the game, but the turn indicator stays visible.

### 5.9 Session recap
- Shown to everyone when the host ends the game.
- Per player: total bought in (first buy-in + top-ups), final stack, net result, hands played, hands won, biggest pot won.
- **Settle-up view:** for home games that settle in real money offline, net results are converted at a host-entered rate (e.g. 1,000 chips = $10), followed by a minimal "who pays whom" list. FELT never moves money.
- The recap can be shared as an image or a link that expires after 7 days. Nothing else is persisted.

### 5.10 Connection resilience
- A dropped player keeps their seat for 3 minutes (the host can change this). On their turn, the timer auto-checks or folds; if the timer is off, the game waits until the host forces a fold.
- On reconnect, the client receives the full current state and resumes.
- Opening the room on a second device moves the session to that device.

### 5.11 PWA
- Installable to the home screen, full-screen and portrait-first.
- Vibration and an optional sound on "your turn".
- Screen wake-lock while seated.
- Push notifications are out of scope for v1.

---

## 6. UX principles
- **One-thumb play.** The action bar sits at the bottom with big targets, and the bet slider has pot-fraction presets (½, ⅔, pot, all-in).
- **Your turn is unmistakable.** Colour, vibration and a timer ring all signal it.
- **Never hide money.** The pot, your stack and the amount to call are always visible.
- **Hybrid is faster than real chips.** Default to the most likely action and keep taps per hand to a minimum.
- **Host requests are glanceable.** Join and top-up requests appear as cards the host can answer with one tap, without leaving the table.

---

## 7. Success metrics (first 3 months)
- Time from opening an invite link to seated (excluding host response time): median under 15s
- Hybrid sessions completed (not abandoned mid-game): over 80%
- Repeat hosts (host a second game within 30 days): over 40%
- Tutorial completion rate: over 60% of starters
- Zero reported chip-accounting bugs (pot, side-pot or ledger errors)

---

## 8. Delivery
The build is split into many small, single-agent phases in [`PLAN.md`](./PLAN.md). Hybrid mode ships before online mode: it exercises rooms, betting, side pots and reconnection without needing card dealing or card privacy, and it's the mode most useful to the target audience.

---

## 9. Resolved decisions
1. Top-ups have no per-player cap; only the max buy-in (if set) limits them.
2. Admission is per session. Approved players aren't remembered across games.
