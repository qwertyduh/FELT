/**
 * Hand lifecycle (P33): `host:start`, `game:act`, `host:advance_street`, `host:award`,
 * `host:dispute`, the deadlines stored in the room, and `hand:result`. The rules (game.ts) run
 * inside the room's actor queue; this file only wires sockets and timers to them.
 */
import { randomUUID } from 'node:crypto';
import type { Ack, RoomCode, ServerEventPayload } from '@felt/protocol';
import type { Realtime, Timers } from '../realtime';
import { roomChannel } from '../realtime/channels';
import {
  errorAck,
  onClientEvent,
  type FeltSocket,
  type SocketRegistrar,
} from '../realtime/handlers';
import {
  act,
  advance,
  dispute,
  nextDeadline,
  proposeAward,
  start,
  tick,
  type GameContext,
  type GameResult,
} from './game';
import { RoomGoneError, type RoomRecord } from './roomStore';
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
    awards: result.awards.map((a) => ({
      potId: a.potId,
      winners: [...a.winners],
      amounts: { ...a.amounts },
      contested: a.contested,
      handNames: { ...a.handNames },
    })),
    showdown: [], // hybrid shows no cards; online reveals arrive with Stage D
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

  constructor(deps: GameServiceDeps) {
    this.io = deps.io;
    this.registry = deps.registry;
    this.timers = deps.timers ?? realTimers;
    this.newId = deps.newId ?? randomUUID;
  }

  readonly register: SocketRegistrar = (socket, log) => {
    onClientEvent(socket, 'host:start', () => this.intent(socket, start), log);
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
  };

  /** After every committed change (the actor's `onCommit`, after the state broadcast). */
  committed(room: Readonly<RoomRecord>, before: Readonly<RoomRecord>): void {
    this.arm(room.code, nextDeadline(room));
    const result = handResult(room, before);
    if (result) this.io.to(roomChannel(room.code)).emit('hand:result', result);
  }

  /** A room was rehydrated: its stored deadlines still apply, overdue ones at once. */
  loaded(room: Readonly<RoomRecord>): void {
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
    try {
      const actor = await this.registry.get(code);
      if (!actor) return notFound();
      const refused = await actor.enqueue((room) => {
        const ctx = this.context();
        // Settle anything overdue first, so an intent never beats a deadline that has passed.
        // Only for admitted users: nobody else may move the room on.
        const settled = room.admitted.includes(userId) ? tick(room, ctx) : (room as RoomRecord);
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
      this.arm(code, this.timers.now() + DEADLINE_RETRY_MS); // e.g. Redis down: try again
    }
  }
}
