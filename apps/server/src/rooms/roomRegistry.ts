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
  /** Called once for each actor built from the stored record (e.g. to re-arm its timers). */
  onLoad?: (room: Readonly<RoomRecord>) => void;
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

  /** Unknown (or corrupt) room -> null. Redis failures reject. */
  get(code: RoomCode): Promise<RoomActor | null> {
    const live = this.actors.get(code);
    if (live) return Promise.resolve(live);
    const inflight = this.loading.get(code);
    if (inflight) return inflight;
    const p = (async () => {
      const record = await this.store.get(code);
      if (!record || this.closed) return null;
      const actor = new RoomActor(record, this.store, {
        now: () => this.clock.now(),
        onGone: (a) => {
          if (this.actors.get(code) === a) this.actors.delete(code);
        },
        ...this.opts.actor,
      });
      this.actors.set(code, actor);
      this.opts.onLoad?.(record);
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
  }
}
