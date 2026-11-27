/**
 * Join requests and admission (P30): `room:request_join`, `room:cancel_request`, `host:admit`,
 * `room:enter` and request expiry. Every read or change of room state goes through the room's actor
 * queue. Events and channel joins happen only after the new state is committed, synchronously in the
 * continuation of `enqueue`, i.e. before the room's next task can start.
 */
import { randomUUID } from 'node:crypto';
import type { Ack, RoomCode, ServerEventPayload } from '@felt/protocol';
import type { Db } from '../db/supabase';
import { findUsername } from '../usernames/claim';
import type { Realtime, Timers } from '../realtime';
import {
  errorAck,
  onClientEvent,
  type FeltSocket,
  type SocketRegistrar,
} from '../realtime/handlers';
import { joinWaitChannel, memberChannel, roomChannel } from '../realtime/channels';
import { KeyedLimiter } from '../realtime/rateLimit';
import {
  cancelJoin,
  decideJoin,
  hostInbox,
  nextExpiry,
  pruneExpired,
  requestJoin,
  type JoinRecord,
} from './admission';
import { KeyedSerial } from './keyedSerial';
import type { StateBroadcaster } from './broadcaster';
import { RoomGoneError, type RoomRecord } from './roomStore';
import type { RoomRegistry } from './roomRegistry';

/** Per user across all sockets (the per-socket bucket alone is reset by reconnecting). */
export const JOIN_BURST = 10;
export const JOIN_PER_SEC = 10 / 60;
/**
 * `room:enter` attempts that do not end in entry (unknown code, not admitted), per user: limits
 * room-code probing. Other attempts are refunded, so normal reconnects are never throttled.
 */
export const ENTER_MISS_BURST = 20;
export const ENTER_MISS_PER_SEC = 20 / 60;
export const EXPIRY_RETRY_MS = 5_000;
/**
 * How long a departure waits before it is published. A socket that comes back within it changes
 * nothing, and all departures of one room share the wait.
 */
export const PRESENCE_DEBOUNCE_MS = 2_000;

export interface JoinServiceDeps {
  io: Realtime['io'];
  registry: RoomRegistry;
  broadcaster: Pick<StateBroadcaster, 'sendTo' | 'isStale' | 'forget'>;
  /** null: no service key, so new requests cannot be labelled with a username. */
  db: Db | null;
  timers?: Timers;
  newId?: () => string;
  presenceDebounceMs?: number;
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
const OK: Ack = { ok: true };

export class JoinService {
  private readonly io: Realtime['io'];
  private readonly registry: RoomRegistry;
  private readonly broadcaster: JoinServiceDeps['broadcaster'];
  private readonly db: Db | null;
  private readonly timers: Timers;
  private readonly newId: () => string;
  private readonly expiryTimers = new Map<RoomCode, unknown>();
  private readonly presenceTimers = new Map<RoomCode, NodeJS.Timeout>();
  private readonly presenceDebounceMs: number;
  /** Keeps one user's request/cancel intents in arrival order. */
  private readonly serial = new KeyedSerial();
  private readonly joinLimit: KeyedLimiter;
  private readonly enterLimit: KeyedLimiter;
  private closed = false;

  constructor(deps: JoinServiceDeps) {
    this.io = deps.io;
    this.registry = deps.registry;
    this.broadcaster = deps.broadcaster;
    this.db = deps.db;
    this.timers = deps.timers ?? realTimers;
    this.newId = deps.newId ?? randomUUID;
    this.presenceDebounceMs = deps.presenceDebounceMs ?? PRESENCE_DEBOUNCE_MS;
    const now = () => this.timers.now();
    this.joinLimit = new KeyedLimiter(JOIN_PER_SEC, JOIN_BURST, now);
    this.enterLimit = new KeyedLimiter(ENTER_MISS_PER_SEC, ENTER_MISS_BURST, now);
  }

  readonly register: SocketRegistrar = (socket, log) => {
    // Socket.io has already removed the socket from its channels when this fires.
    socket.on('disconnect', () => {
      const code = socket.data.roomCode;
      if (code) this.departed(code);
    });
    onClientEvent(
      socket,
      'room:request_join',
      ({ code }) => this.guard(() => this.requestJoin(socket, code)),
      log,
    );
    onClientEvent(
      socket,
      'room:cancel_request',
      ({ code }) => this.guard(() => this.cancelRequest(socket, code)),
      log,
    );
    onClientEvent(
      socket,
      'room:enter',
      ({ code }) => this.guard(() => this.enter(socket, code)),
      log,
    );
    onClientEvent(
      socket,
      'host:admit',
      (p) => this.guard(() => this.admit(socket, p.requestId, p.approve)),
      log,
    );
  };

  close(): void {
    this.closed = true;
    for (const h of this.expiryTimers.values()) this.timers.clearTimeout(h);
    this.expiryTimers.clear();
    for (const h of this.presenceTimers.values()) clearTimeout(h);
    this.presenceTimers.clear();
  }

  private async guard(fn: () => Promise<Ack>): Promise<Ack> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RoomGoneError) return notFound();
      throw err; // -> `internal` ack
    }
  }

  private requestJoin(socket: FeltSocket, code: RoomCode): Promise<Ack> {
    const { userId } = socket.data.user;
    if (!this.joinLimit.take(userId)) {
      return Promise.resolve(errorAck('rate_limited', 'too many join requests'));
    }
    return this.serial.run(userId, async () => {
      if (!this.db) return errorAck('internal', 'usernames unavailable');
      const username = await findUsername(this.db, userId); // I/O stays outside the room queue
      if (username === null) return errorAck('forbidden', 'username required');
      // Fetched after the lookup, with no I/O before `enqueue`: an actor held across a slow await
      // could be evicted (disposed) meanwhile.
      const actor = await this.registry.get(code);
      if (!actor) return notFound();
      const requestId = this.newId();
      const now = () => this.timers.now();

      const out = await actor.enqueue((room) => {
        const at = now();
        const pruned = pruneExpired(room, at);
        const r = requestJoin(pruned.room, { userId, username, requestId }, at);
        return { room: r.room, result: { outcome: r.outcome, expired: pruned.expired } };
      });
      this.afterChange(code, actor.state(), out.expired);

      const o = out.outcome;
      switch (o.kind) {
        case 'refused':
          return errorAck(o.code, o.message);
        case 'admitted':
          socket.emit('room:join_decision', { approved: true });
          return OK;
        case 'cooldown':
          socket.emit('room:join_decision', { approved: false, retryAfter: o.until });
          return errorAck('cooldown', 'you were denied recently; try again later');
        case 'created':
        case 'pending': {
          const { request } = o;
          this.waitOn(socket, code);
          socket.emit('room:join_pending', {
            requestId: request.requestId,
            expiresAt: request.expiresAt,
          });
          if (o.kind === 'pending') {
            return errorAck('already_requested', 'a request is already pending');
          }
          this.toHost(code, actor.state().hostId).emit('host:join_request', {
            requestId: request.requestId,
            userId,
            username: request.username,
          });
          return OK;
        }
      }
    });
  }

  private cancelRequest(socket: FeltSocket, code: RoomCode): Promise<Ack> {
    const { userId } = socket.data.user;
    // The code is client-chosen, so a cancel with nothing to cancel spends the same per-user
    // budget as a missed `room:enter`. A real cancel is refunded.
    if (!this.enterLimit.take(userId)) {
      return Promise.resolve(errorAck('rate_limited', 'too many attempts'));
    }
    // One answer for "no such room" and "nothing pending there": no code probing.
    const nothing = () => errorAck('not_found', 'no pending request');
    return this.serial.run(userId, async () => {
      const actor = await this.registry.get(code);
      if (!actor) return nothing();
      const out = await actor.enqueue((room) => {
        const pruned = pruneExpired(room, this.timers.now());
        const r = cancelJoin(pruned.room, userId);
        return { room: r.room, result: { removed: r.removed, expired: pruned.expired } };
      });
      this.stopWaiting(code, userId);
      this.afterChange(code, actor.state(), out.expired);
      if (!out.removed) return nothing();
      this.enterLimit.refund(userId);
      this.sendInbox(code, actor.state());
      return OK;
    });
  }

  private async admit(socket: FeltSocket, requestId: string, approve: boolean): Promise<Ack> {
    const { userId } = socket.data.user;
    const code = socket.data.roomCode;
    if (!code) return errorAck('not_admitted', 'enter the room first');
    const actor = await this.registry.get(code);
    if (!actor) return notFound();
    const out = await actor.enqueue((room) => {
      const at = this.timers.now();
      const pruned = pruneExpired(room, at);
      const r = decideJoin(pruned.room, userId, requestId, approve, at);
      return { room: r.room, result: { outcome: r.outcome, expired: pruned.expired } };
    });
    this.afterChange(code, actor.state(), out.expired);
    const o = out.outcome;
    if (o.kind === 'refused') return errorAck(o.code, o.message);
    this.decide(
      code,
      o.request.userId,
      o.retryAfter === undefined
        ? { approved: true }
        : { approved: false, retryAfter: o.retryAfter },
    );
    this.sendInbox(code, actor.state());
    return OK;
  }

  private async enter(socket: FeltSocket, code: RoomCode): Promise<Ack> {
    const { userId } = socket.data.user;
    // Taken up front (parallel probes cannot all slip past), refunded unless it was a miss.
    if (!this.enterLimit.take(userId)) return errorAck('rate_limited', 'too many attempts');
    let miss = false;
    try {
      return await this.tryEnter(socket, code, () => (miss = true));
    } finally {
      if (!miss) this.enterLimit.refund(userId);
    }
  }

  private async tryEnter(socket: FeltSocket, code: RoomCode, missed: () => void): Promise<Ack> {
    const { userId } = socket.data.user;
    const seq = (socket.data.enterSeq ?? 0) + 1;
    socket.data.enterSeq = seq;
    const actor = await this.registry.get(code);
    if (!actor) {
      missed();
      return notFound();
    }
    // Queued (even though it usually changes nothing) so the admission check and the channel join
    // cannot interleave with another change to the room.
    const out = await actor.enqueue((room) => {
      const pruned = pruneExpired(room, this.timers.now());
      return {
        room: pruned.room,
        result: {
          expired: pruned.expired,
          admitted: pruned.room.admitted.includes(userId),
          ended: pruned.room.status === 'ended',
        },
      };
    });
    const room = actor.state();
    this.afterChange(code, room, out.expired);
    if (!out.admitted) {
      missed();
      return errorAck('not_admitted', 'the host has not admitted you');
    }
    if (out.ended) return errorAck('room_ended', 'room has ended');
    if (socket.data.enterSeq !== seq) return errorAck('forbidden', 'superseded by a newer request');
    if (!socket.connected) return OK;

    const previous = socket.data.roomCode;
    if (previous && previous !== code) {
      void socket.leave(roomChannel(previous));
      void socket.leave(memberChannel(previous, userId));
      this.departed(previous);
    }
    void socket.leave(joinWaitChannel(code, userId));
    void socket.join([roomChannel(code), memberChannel(code, userId)]);
    socket.data.roomCode = code;
    if (room.hostId === userId) socket.emit('host:inbox', hostInbox(room, this.timers.now()));
    // If this changes who is connected, publish a new version (which reaches this socket too).
    // Otherwise resend the current one unchanged.
    const published = await this.publishPresence(code);
    if (!published && socket.data.roomCode === code && socket.connected) {
      this.broadcaster.sendTo(socket, actor.state());
    }
    return OK;
  }

  /**
   * Presence is not stored in the room, so a change of it is published by committing an unchanged
   * copy: the version moves on and the actor's `onCommit` broadcasts. Checked inside the queue, so
   * changes that are already covered cost nothing. Never extends the room's TTL. True if a new
   * version went out.
   */
  private async publishPresence(code: RoomCode): Promise<boolean> {
    try {
      const actor = await this.registry.get(code);
      if (!actor) return false;
      return await actor.enqueue(
        (room) => {
          const stale = this.broadcaster.isStale(room);
          return { room: stale ? { ...room } : room, result: stale };
        },
        { keepTtl: true },
      );
    } catch {
      this.departed(code); // e.g. Redis down: check again after the usual pause
      return false;
    }
  }

  /** Check presence again after a pause (a socket left, or publishing failed); once per room. */
  private departed(code: RoomCode): void {
    if (this.closed || this.presenceTimers.has(code)) return;
    const timer = setTimeout(() => {
      this.presenceTimers.delete(code);
      // Nobody to tell: write nothing; the next to enter gets a fresh version.
      if (!this.io.sockets.adapter.rooms.has(roomChannel(code))) this.broadcaster.forget(code);
      else void this.publishPresence(code);
    }, this.presenceDebounceMs);
    timer.unref();
    this.presenceTimers.set(code, timer);
  }

  /** A socket waits for one room at a time: decisions carry no room code. */
  private waitOn(socket: FeltSocket, code: RoomCode): void {
    const { userId } = socket.data.user;
    for (const name of socket.rooms) if (name.startsWith('join:')) void socket.leave(name);
    void socket.join(joinWaitChannel(code, userId));
  }

  private stopWaiting(code: RoomCode, userId: string): void {
    this.io.in(joinWaitChannel(code, userId)).socketsLeave(joinWaitChannel(code, userId));
  }

  private decide(
    code: RoomCode,
    userId: string,
    decision: ServerEventPayload<'room:join_decision'>,
  ): void {
    this.io.to(joinWaitChannel(code, userId)).emit('room:join_decision', decision);
    this.stopWaiting(code, userId);
  }

  private toHost(code: RoomCode, hostId: string) {
    return this.io.to(memberChannel(code, hostId));
  }

  private sendInbox(code: RoomCode, room: Readonly<RoomRecord>): void {
    this.toHost(code, room.hostId).emit('host:inbox', hostInbox(room, this.timers.now()));
  }

  /** After any task: tell whoever expired, then (re)arm the room's expiry timer. */
  private afterChange(code: RoomCode, room: Readonly<RoomRecord>, expired: JoinRecord[]): void {
    // No `retryAfter`: that is how an expiry differs from a denial.
    for (const r of expired) this.decide(code, r.userId, { approved: false });
    if (expired.length > 0) this.sendInbox(code, room);
    this.arm(code, nextExpiry(room));
  }

  /** One timer per room, for the earliest stored (absolute) deadline. */
  private arm(code: RoomCode, deadline: number | null, minDelay = 0): void {
    const old = this.expiryTimers.get(code);
    if (old !== undefined) this.timers.clearTimeout(old);
    this.expiryTimers.delete(code);
    if (deadline === null || this.closed) return;
    const delay = Math.max(deadline - this.timers.now(), minDelay);
    this.expiryTimers.set(
      code,
      this.timers.setTimeout(() => {
        this.expiryTimers.delete(code);
        void this.expire(code);
      }, delay),
    );
  }

  /** Timer expiry is just another queued action. */
  private async expire(code: RoomCode): Promise<void> {
    try {
      const actor = await this.registry.get(code);
      if (!actor) return;
      const expired = await actor.enqueue((room) => {
        const pruned = pruneExpired(room, this.timers.now());
        return { room: pruned.room, result: pruned.expired };
      });
      this.afterChange(code, actor.state(), expired);
    } catch (err) {
      if (err instanceof RoomGoneError) return;
      this.arm(code, this.timers.now() + EXPIRY_RETRY_MS); // e.g. Redis down: try again
    }
  }
}
