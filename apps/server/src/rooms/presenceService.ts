/**
 * The timers of the disconnect rules (absence.ts): seat hold and host failover. One timer per room
 * for the earliest stored deadline; expiry is just another queued action, and who is connected is
 * checked inside it. What sockets are told about a new host or a freed seat follows from the
 * committed change, as for any other (hostService, topUpService, broadcaster).
 */
import type { RoomCode } from '@felt/protocol';
import type { Realtime, Timers } from '../realtime';
import { memberChannel } from '../realtime/channels';
import { applyAbsence, nextAbsenceDeadline, type IsConnected } from './absence';
import type { RoomRegistry } from './roomRegistry';
import { RoomGoneError, type RoomRecord } from './roomStore';

export const ABSENCE_RETRY_MS = 5_000;
/**
 * A room loaded with absences already stored (typically after a restart) acts on none of them for
 * this long: those deadlines may have passed while nobody could connect. It covers the client's
 * longest reconnect wait.
 */
export const RELOAD_SETTLE_MS = 45_000;
const MIN_REARM_MS = 10;

export interface PresenceServiceDeps {
  io: Realtime['io'];
  registry: RoomRegistry;
  timers?: Timers;
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

export class PresenceService {
  private readonly io: Realtime['io'];
  private readonly registry: RoomRegistry;
  private readonly timers: Timers;
  private readonly armed = new Map<RoomCode, { at: number; handle: unknown }>();
  private readonly notBefore = new Map<RoomCode, number>();
  private closed = false;

  constructor(deps: PresenceServiceDeps) {
    this.io = deps.io;
    this.registry = deps.registry;
    this.timers = deps.timers ?? realTimers;
  }

  /** After every committed change (the actor's `onCommit`). */
  committed(room: Readonly<RoomRecord>): void {
    this.arm(room);
  }

  /** A room was rehydrated: its stored deadlines still apply, after a moment to reconnect. */
  loaded(room: Readonly<RoomRecord>): void {
    if (room.away && Object.keys(room.away).length > 0) {
      this.notBefore.set(room.code, this.timers.now() + RELOAD_SETTLE_MS);
    }
    this.arm(room);
  }

  close(): void {
    this.closed = true;
    for (const t of this.armed.values()) this.timers.clearTimeout(t.handle);
    this.armed.clear();
    this.notBefore.clear();
  }

  private connected(code: RoomCode): IsConnected {
    return (userId) => this.io.sockets.adapter.rooms.has(memberChannel(code, userId));
  }

  private arm(room: Readonly<RoomRecord>, minDelay = MIN_REARM_MS): void {
    const { code } = room;
    const deadline = nextAbsenceDeadline(room, this.connected(code));
    const floor = this.notBefore.get(code) ?? 0;
    if (floor <= this.timers.now()) this.notBefore.delete(code);
    const at = deadline === null ? null : Math.max(deadline, floor);
    const old = this.armed.get(code);
    if (old && old.at === at) return;
    if (old) this.timers.clearTimeout(old.handle);
    this.armed.delete(code);
    if (at === null || this.closed) return;
    this.schedule(code, at, Math.max(at - this.timers.now(), minDelay));
  }

  private schedule(code: RoomCode, at: number, delay: number): void {
    const handle = this.timers.setTimeout(() => {
      this.armed.delete(code);
      void this.expire(code);
    }, delay);
    this.armed.set(code, { at, handle });
  }

  private async expire(code: RoomCode): Promise<void> {
    try {
      const actor = await this.registry.get(code);
      if (!actor) {
        this.notBefore.delete(code);
        return;
      }
      await actor.enqueue((room) => applyAbsence(room, this.connected(code), this.timers.now()), {
        keepTtl: true,
        newHost: true,
      });
      // A change has armed the next timer already; a timer that came early needs another.
      if (!this.armed.has(code)) this.arm(actor.state());
    } catch (err) {
      if (err instanceof RoomGoneError || this.closed) return;
      const at = this.timers.now() + ABSENCE_RETRY_MS; // e.g. Redis down: try again
      this.schedule(code, at, ABSENCE_RETRY_MS);
    }
  }
}
