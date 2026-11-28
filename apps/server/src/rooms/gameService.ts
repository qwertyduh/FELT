/**
 * Hand lifecycle (P33): `host:start`, `game:act`, `host:advance_street`, `host:award`,
 * `host:dispute`, `host:undo`, `host:adjust_stack` (P42), `host:force_fold` (P45), `hand:show`
 * (P47), `turn:start`, turn expiry and its grace after a restart (P48), the deadlines stored in the room, `hand:private` and `hand:result`. The rules (game.ts)
 * run inside the room's actor queue; this file only wires sockets and timers to them.
 */
import { randomUUID } from 'node:crypto';
import type { Ack, RoomCode, ServerEventPayload } from '@felt/protocol';
import type { Realtime, Timers } from '../realtime';
import { memberChannel, outOfRoom, roomChannel } from '../realtime/channels';
import {
  errorAck,
  onClientEvent,
  type FeltSocket,
  type SocketRegistrar,
} from '../realtime/handlers';
import {
  act,
  adjustStack,
  advance,
  dispute,
  forceFold,
  nextDeadline,
  proposeAward,
  show,
  start,
  tick,
  undo,
  type GameContext,
  type GameResult,
} from './game';
import { privateHandOf, publicAwards, shownHands } from './reveal';
import { RoomGoneError, type RoomRecord } from './roomStore';
import { afterRestart } from './turnClock';
import type { RoomRegistry } from './roomRegistry';

export const DEADLINE_RETRY_MS = 5_000;
/** A timer may fire a hair before its deadline; never spin on it. */
const MIN_REARM_MS = 10;

export interface GameServiceDeps {
  io: Realtime['io'];
  registry: RoomRegistry;
  timers?: Timers;
  newId?: () => string;
}

const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

const notFound = () => errorAck('not_found', 'room not found');

type Rule = (room: Readonly<RoomRecord>, userId: string, ctx: GameContext) => GameResult;

/** The turn being waited on, if the game is running, and what tells it apart from any other. */
function turnOf(
  room: Readonly<RoomRecord>,
): { key: string; payload: ServerEventPayload<'turn:start'> } | null {
  const hand = room.game?.hand;
  if (room.status !== 'playing' || !hand || hand.state.street === 'ended') return null;
  const player = hand.state.players.find((p) => p.seat === hand.state.currentActor);
  if (!player) return null;
  const deadline = hand.turnDeadline ?? null;
  return {
    key: `${hand.handId}|${hand.state.street}|${player.playerId}|${deadline}`,
    payload: { userId: player.playerId, deadline },
  };
}

/** The `hand:result` payload, if this change ended a hand. */
function handResult(
  room: Readonly<RoomRecord>,
  before: Readonly<RoomRecord>,
): ServerEventPayload<'hand:result'> | null {
  const hand = room.game?.hand;
  const result = hand?.state.result;
  if (!hand || !result) return null;
  const prior = before.game?.hand;
  if (prior?.handId === hand.handId && prior.state.result) return null;
  return {
    handId: hand.handId,
    awards: publicAwards(result),
    // Hybrid shows no cards. Online: only what the rules reveal (nobody has chosen to show yet).
    showdown: shownHands(hand.state, hand).map(({ userId, cards }) => {
      const entry = result.showdown.find((s) => s.playerId === userId)!;
      return { userId, cards, handName: entry.handName, category: entry.category };
    }),
    stacks: { ...result.stacks },
  };
}

export class GameService {
  private readonly io: Realtime['io'];
  private readonly registry: RoomRegistry;
  private readonly timers: Timers;
  private readonly newId: () => string;
  private readonly armed = new Map<RoomCode, { at: number; handle: unknown }>();
  private closed = false;
  /**
   * Rooms whose clocks this process has been running. A room not in here is being taken up after
   * a start of the server; one that is has had its timers all along, so loading it again gives
   * nobody a new clock.
   */
  private readonly known = new Set<RoomCode>();
  /**
   * The new clock given to a turn after a start of the server. It is only in memory until the room
   * is next saved, and a save can fail: a reload that still finds the old deadline gets the same
   * new one again (never a later one).
   */
  private readonly regranted = new Map<
    RoomCode,
    { handId: string; stale: number; deadline: number }
  >();

  constructor(deps: GameServiceDeps) {
    this.io = deps.io;
    this.registry = deps.registry;
    this.timers = deps.timers ?? realTimers;
    this.newId = deps.newId ?? randomUUID;
  }

  readonly register: SocketRegistrar = (socket, log) => {
    onClientEvent(
      socket,
      'host:start',
      (p) => this.intent(socket, (room, userId, ctx) => start(room, userId, ctx, p?.afterHandId)),
      log,
    );
    onClientEvent(
      socket,
      'game:act',
      (p) => this.intent(socket, (room, userId, ctx) => act(room, userId, p, ctx)),
      log,
    );
    onClientEvent(
      socket,
      'host:advance_street',
      (p) => this.intent(socket, (room, userId, ctx) => advance(room, userId, p, ctx)),
      log,
    );
    onClientEvent(
      socket,
      'host:award',
      (p) => this.intent(socket, (room, userId, ctx) => proposeAward(room, userId, p, ctx)),
      log,
    );
    onClientEvent(
      socket,
      'host:dispute',
      (p) => this.intent(socket, (room, userId) => dispute(room, userId, p)),
      log,
    );
    onClientEvent(
      socket,
      'hand:show',
      (p) => this.intent(socket, (room, userId, ctx) => show(room, userId, p, ctx)),
      log,
    );
    onClientEvent(
      socket,
      'host:undo',
      (p) => this.intent(socket, (room, userId, ctx) => undo(room, userId, p, ctx)),
      log,
    );
    onClientEvent(
      socket,
      'host:force_fold',
      (p) =>
        this.intent(socket, (room, userId, ctx) => {
          const connected = this.io.sockets.adapter.rooms.has(memberChannel(room.code, p.userId));
          return forceFold(room, userId, p, connected, ctx);
        }),
      log,
    );
    onClientEvent(
      socket,
      'host:adjust_stack',
      (p) => this.intent(socket, (room, userId, ctx) => adjustStack(room, userId, p, ctx)),
      log,
    );
  };

  /** After every committed change (the actor's `onCommit`, after the state broadcast). */
  committed(room: Readonly<RoomRecord>, before: Readonly<RoomRecord>): void {
    this.known.add(room.code);
    this.arm(room.code, nextDeadline(room));
    // A hand just dealt: each player's cards to their own sockets only, after the state.
    const hand = room.game?.hand;
    if (hand && hand.handId !== before.game?.hand?.handId) {
      for (const { playerId } of hand.state.players) {
        const own = privateHandOf(room, playerId);
        if (own) this.io.to(memberChannel(room.code, playerId)).emit('hand:private', own);
      }
    }
    // After the state and the cards: a new turn, or the same one with a new deadline (resume).
    const turn = turnOf(room);
    if (turn && turn.key !== turnOf(before)?.key) {
      this.io.to(roomChannel(room.code)).emit('turn:start', turn.payload);
    }
    const result = handResult(room, before);
    if (result) this.io.to(roomChannel(room.code)).emit('hand:result', result);
  }

  /** The stored room as it is to be loaded (see `afterRestart`). */
  rehydrate(room: RoomRecord): RoomRecord {
    const hand = room.game?.hand;
    const given = this.regranted.get(room.code);
    if (hand && given && hand.handId === given.handId && hand.turnDeadline === given.stale) {
      const turnDeadline = given.deadline;
      return { ...room, game: { ...room.game!, hand: { ...hand, turnDeadline } } };
    }
    if (this.known.has(room.code)) return room;
    const next = afterRestart(room, this.timers.now());
    if (next !== room) {
      this.regranted.set(room.code, {
        handId: hand!.handId,
        stale: hand!.turnDeadline!,
        deadline: next.game!.hand!.turnDeadline!,
      });
    }
    return next;
  }

  /**
   * A room was rehydrated: its stored deadlines still apply, overdue ones at once (a turn that ran
   * out while the server was down has been given a new clock first).
   */
  loaded(room: Readonly<RoomRecord>): void {
    this.known.add(room.code);
    this.arm(room.code, nextDeadline(room));
  }

  close(): void {
    this.closed = true;
    for (const t of this.armed.values()) this.timers.clearTimeout(t.handle);
    this.armed.clear();
  }

  private context(): GameContext {
    return { now: this.timers.now(), newId: this.newId };
  }

  private async intent(socket: FeltSocket, rule: Rule): Promise<Ack> {
    const { userId } = socket.data.user;
    const code = socket.data.roomCode;
    if (!code) return errorAck('not_admitted', 'enter the room first');
    // When it got here: waiting in the queue must not cost a move its turn.
    const arrivedAt = this.timers.now();
    try {
      const actor = await this.registry.get(code);
      if (!actor) return notFound();
      const refused = await actor.enqueue((room) => {
        if (outOfRoom(socket, code)) {
          return {
            room,
            result: { code: 'not_admitted' as const, message: 'enter the room first' },
          };
        }
        const ctx = this.context();
        // Settle anything overdue first, so an intent never beats a deadline that has passed.
        // Only for admitted users: nobody else may move the room on.
        const settled = room.admitted.includes(userId)
          ? tick(room, { ...ctx, now: arrivedAt })
          : (room as RoomRecord);
        const r = rule(settled, userId, ctx);
        return { room: r.room, result: r.refused };
      });
      return refused ? errorAck(refused.code, refused.message) : { ok: true };
    } catch (err) {
      if (err instanceof RoomGoneError) return notFound();
      throw err; // -> `internal` ack
    }
  }

  /** One timer per room for the earliest stored deadline. */
  private arm(code: RoomCode, deadline: number | null, minDelay = 0): void {
    const old = this.armed.get(code);
    if (old && old.at === deadline) return;
    if (old) this.timers.clearTimeout(old.handle);
    this.armed.delete(code);
    if (deadline === null || this.closed) return;
    const delay = Math.max(deadline - this.timers.now(), minDelay);
    const handle = this.timers.setTimeout(() => {
      this.armed.delete(code);
      void this.expire(code);
    }, delay);
    this.armed.set(code, { at: deadline, handle });
  }

  /** Timer expiry is just another queued action. */
  private async expire(code: RoomCode): Promise<void> {
    try {
      const actor = await this.registry.get(code);
      if (!actor) return;
      await actor.enqueue((room) => tick(room, this.context()));
      this.arm(code, nextDeadline(actor.state()), MIN_REARM_MS);
    } catch (err) {
      if (err instanceof RoomGoneError) return;
      // A commit or reload meanwhile (e.g. after a save conflict) has armed the right timer.
      if (this.armed.has(code)) return;
      this.arm(code, this.timers.now() + DEADLINE_RETRY_MS); // e.g. Redis down: try again
    }
  }
}
