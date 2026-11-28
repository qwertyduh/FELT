import type { RoomCode } from '@felt/protocol';
import { RoomActor, type RoomActorOptions } from './roomActor';
import type { RoomRecord, RoomStore } from './roomStore';

export const IDLE_EVICT_MS = 10 * 60_000;
export const SWEEP_INTERVAL_MS = 60_000;
export const DISPOSE_DRAIN_TIMEOUT_MS = 5_000;

export interface RegistryClock {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}
const realClock: RegistryClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref();
    return h;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export interface RoomRegistryOptions {
  clock?: RegistryClock;
  idleMs?: number;
  sweepMs?: number;
  /** True while a room has connected sockets; such rooms are never evicted. */
  isRoomActive?: (code: RoomCode) => boolean;
  actor?: RoomActorOptions;
  /**
   * The stored record as this process takes it up, before its actor exists (e.g. clocks that ran
   * out while the server was down). Returns the same object when there is nothing to change; a
   * change is saved with the room's next commit.
   */
  rehydrate?: (room: RoomRecord) => RoomRecord;
  /** Called once for each actor built from the stored record (e.g. to re-arm its timers). */
  onLoad?: (room: Readonly<RoomRecord>) => void;
  /**
   * A room was loaded again because it had been written elsewhere. `before` is the last state
   * this process committed or loaded, i.e. what its sockets were told. Called before the new
   * actor can run anything.
   */
  onReload?: (room: Readonly<RoomRecord>, before: Readonly<RoomRecord>) => void;
  drainTimeoutMs?: number;
}

/**
 * Get-or-rehydrate room actors. Concurrent `get`s for one code share a single Redis load and a
 * single actor. Eviction only disposes: every committed change is already persisted.
 */
export class RoomRegistry {
  private readonly actors = new Map<RoomCode, RoomActor>();
  private readonly loading = new Map<RoomCode, Promise<RoomActor | null>>();
  private readonly clock: RegistryClock;
  private readonly idleMs: number;
  private readonly isRoomActive: (code: RoomCode) => boolean;
  private timer: unknown;
  private closed = false;
  /** Rooms to load again after a conflict: the state their actor held. */
  private readonly outdated = new Map<RoomCode, Readonly<RoomRecord>>();

  constructor(
    private readonly store: Pick<RoomStore, 'get' | 'save'>,
    private readonly opts: RoomRegistryOptions = {},
  ) {
    this.clock = opts.clock ?? realClock;
    this.idleMs = opts.idleMs ?? IDLE_EVICT_MS;
    this.isRoomActive = opts.isRoomActive ?? (() => false);
    this.timer = this.clock.setInterval(
      () => this.evictIdle(this.clock.now()),
      opts.sweepMs ?? SWEEP_INTERVAL_MS,
    );
  }

  /** Metric: rooms currently held in memory. */
  get activeRooms(): number {
    return this.actors.size;
  }

  /** Unknown room -> null. Redis failures and unreadable records reject. */
  get(code: RoomCode): Promise<RoomActor | null> {
    const live = this.actors.get(code);
    if (live) return Promise.resolve(live);
    const inflight = this.loading.get(code);
    if (inflight) return inflight;
    const p = (async () => {
      const stored = await this.store.get(code);
      if (!stored || this.closed) {
        this.outdated.delete(code);
        return null;
      }
      const record = this.opts.rehydrate?.(stored) ?? stored;
      const actor = new RoomActor(record, this.store, {
        now: () => this.clock.now(),
        onGone: (a) => {
          if (this.actors.get(code) === a) this.actors.delete(code);
        },
        onConflict: (a) => {
          if (this.actors.get(code) !== a) return;
          this.actors.delete(code);
          this.outdated.set(code, a.state());
          // At once: the sockets are owed the current state and the timers its deadlines. If this
          // fails, whoever asks for the room next does it.
          void this.get(code).catch(() => undefined);
        },
        ...this.opts.actor,
      });
      this.actors.set(code, actor);
      this.opts.onLoad?.(record);
      const before = this.outdated.get(code);
      if (before) {
        this.outdated.delete(code);
        this.opts.onReload?.(record, before);
      }
      return actor;
    })().finally(() => this.loading.delete(code));
    this.loading.set(code, p);
    return p;
  }

  /** Dispose idle actors with an empty queue and no connected sockets. Returns evicted codes. */
  evictIdle(now: number): RoomCode[] {
    const evicted: RoomCode[] = [];
    for (const [code, actor] of this.actors) {
      if (actor.queueLength > 0 || this.isRoomActive(code)) continue;
      if (now - actor.lastActivity <= this.idleMs) continue;
      actor.dispose();
      this.actors.delete(code);
      evicted.push(code);
    }
    return evicted;
  }

  /** Shutdown: stop sweeping, wait (bounded) for queues to drain, dispose everything. */
  async dispose(): Promise<void> {
    this.closed = true;
    this.clock.clearInterval(this.timer);
    const actors = [...this.actors.values()];
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(actors.map((a) => a.drain())),
      new Promise<void>((r) => {
        timer = setTimeout(r, this.opts.drainTimeoutMs ?? DISPOSE_DRAIN_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    for (const a of actors) a.dispose();
    this.actors.clear();
    this.outdated.clear();
  }
}
