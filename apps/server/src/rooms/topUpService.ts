/**
 * Top-ups (P43): `player:topup_request` and `host:topup`. The rules (topUps.ts) run inside the
 * room's actor queue. Who is told what follows from the committed change (`committed`), so it also
 * covers requests that go because their player left, and amounts that a deal drops.
 */
import { randomUUID } from 'node:crypto';
import type { Ack, RoomCode } from '@felt/protocol';
import type { Realtime, Timers } from '../realtime';
import { memberChannel } from '../realtime/channels';
import {
  errorAck,
  onClientEvent,
  type FeltSocket,
  type SocketRegistrar,
} from '../realtime/handlers';
import { KeyedLimiter } from '../realtime/rateLimit';
import { hostInbox, ownTopUp } from './admission';
import type { RoomRegistry } from './roomRegistry';
import { RoomGoneError, type RoomRecord } from './roomStore';
import { decideTopUp, requestTopUp } from './topUps';

/** Per user: every request puts a card in front of the host. */
export const TOPUP_BURST = 6;
export const TOPUP_PER_SEC = 6 / 60;

export interface TopUpServiceDeps {
  io: Realtime['io'];
  registry: RoomRegistry;
  timers?: Pick<Timers, 'now'>;
  newId?: () => string;
}

const notEntered = () => errorAck('not_admitted', 'enter the room first');
const notFound = () => errorAck('not_found', 'room not found');
const OK: Ack = { ok: true };

export class TopUpService {
  private readonly io: Realtime['io'];
  private readonly registry: RoomRegistry;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly limit: KeyedLimiter;

  constructor(deps: TopUpServiceDeps) {
    this.io = deps.io;
    this.registry = deps.registry;
    const { timers } = deps;
    this.now = timers ? () => timers.now() : () => Date.now();
    this.newId = deps.newId ?? randomUUID;
    this.limit = new KeyedLimiter(TOPUP_PER_SEC, TOPUP_BURST, this.now);
  }

  readonly register: SocketRegistrar = (socket, log) => {
    onClientEvent(socket, 'player:topup_request', (p) => this.request(socket, p.amount), log);
    onClientEvent(socket, 'host:topup', (p) => this.decide(socket, p.requestId, p.approve), log);
  };

  /** After every committed change (the actor's `onCommit`, after the state broadcast). */
  committed(room: Readonly<RoomRecord>, before: Readonly<RoomRecord>): void {
    const { code, hostId } = room;
    const was = before.topUpRequests ?? [];
    const is = room.topUpRequests ?? [];
    const added = is.filter((r) => !was.some((w) => w.requestId === r.requestId));
    const gone = was.filter((w) => !is.some((r) => r.requestId === w.requestId));
    for (const { requestId, userId, amount } of added) {
      this.to(code, hostId).emit('host:topup_request', { requestId, userId, amount });
    }
    if (gone.length > 0) this.to(code, hostId).emit('host:inbox', hostInbox(room, this.now()));
    for (const userId of new Set([...added, ...gone].map((r) => r.userId))) {
      this.to(code, userId).emit('player:topup_status', { pending: ownTopUp(room, userId) });
    }
    // An approved amount that left the queue without reaching the ledger was over the maximum
    // (a player who left is not told: it went with their seat).
    for (const { requestId, userId, amount } of before.pendingTopUps ?? []) {
      if (room.pendingTopUps?.some((r) => r.requestId === requestId)) continue;
      const seat = room.seats.find((s) => s.userId === userId);
      if (!seat || seat.leaving) continue;
      if (room.ledger.some((e) => e.kind === 'top_up' && e.note === requestId)) continue;
      this.to(code, userId).emit('player:topup_decision', {
        requestId,
        approved: false,
        amount,
        reason: 'over_max',
      });
    }
  }

  private to(code: RoomCode, userId: string) {
    return this.io.to(memberChannel(code, userId));
  }

  private request(socket: FeltSocket, amount: number): Promise<Ack> {
    const { userId } = socket.data.user;
    const code = socket.data.roomCode;
    if (!code) return Promise.resolve(notEntered());
    if (!this.limit.take(userId)) {
      return Promise.resolve(errorAck('rate_limited', 'too many top-up requests'));
    }
    return this.guard(async () => {
      const actor = await this.registry.get(code);
      if (!actor) return notFound();
      const requestId = this.newId();
      const refused = await actor.enqueue((room) => {
        const r = requestTopUp(room, userId, amount, requestId);
        return { room: r.room, result: r.refused };
      });
      return refused ? errorAck(refused.code, refused.message) : OK;
    });
  }

  private decide(socket: FeltSocket, requestId: string, approve: boolean): Promise<Ack> {
    const { userId } = socket.data.user;
    const code = socket.data.roomCode;
    if (!code) return Promise.resolve(notEntered());
    return this.guard(async () => {
      const actor = await this.registry.get(code);
      if (!actor) return notFound();
      const { refused, request } = await actor.enqueue((room) => {
        const r = decideTopUp(room, userId, requestId, approve);
        return { room: r.room, result: { refused: r.refused, request: r.request } };
      });
      if (refused) return errorAck(refused.code, refused.message);
      this.to(code, request!.userId).emit('player:topup_decision', {
        requestId,
        approved: approve,
        amount: request!.amount,
      });
      return OK;
    });
  }

  private async guard(fn: () => Promise<Ack>): Promise<Ack> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RoomGoneError) return notFound();
      throw err; // -> `internal` ack
    }
  }
}
