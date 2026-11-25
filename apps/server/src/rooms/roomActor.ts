import type { RoomCode } from '@felt/protocol';
import { RoomGoneError, type RoomRecord, type RoomStore } from './roomStore';

export const MAX_QUEUE_LENGTH = 200;

export type ActorErrorCode = 'queue_full' | 'disposed';
export class RoomActorError extends Error {
  constructor(readonly code: ActorErrorCode) {
    super(code);
    this.name = 'RoomActorError';
  }
}

/** A task returns the next room (pure update; never mutate the input) or `{ room, result }`. */
export type TaskOutcome<T> = RoomRecord | { room: RoomRecord; result: T };
export type RoomTask<T> = (room: Readonly<RoomRecord>) => TaskOutcome<T> | Promise<TaskOutcome<T>>;

function isWrapped<T>(o: TaskOutcome<T>): o is { room: RoomRecord; result: T } {
  return 'room' in o && 'result' in o;
}

export interface RoomActorOptions {
  maxQueue?: number;
  now?: () => number;
}

/**
 * Serial FIFO queue for one room. State only changes through `enqueue`; a task's new state is
 * persisted (version + 1, TTL refreshed) BEFORE it becomes visible, so a persistence failure
 * leaves memory (and Redis) at the pre-task state and rejects that task only.
 */
export class RoomActor {
  private room: RoomRecord;
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly maxQueue: number;
  private readonly now: () => number;
  private last: number;

  constructor(
    initial: RoomRecord,
    private readonly store: Pick<RoomStore, 'save'>,
    opts: RoomActorOptions = {},
  ) {
    this.room = initial;
    this.maxQueue = opts.maxQueue ?? MAX_QUEUE_LENGTH;
    this.now = opts.now ?? Date.now;
    this.last = this.now();
  }

  get code(): RoomCode {
    return this.room.code;
  }
  /** Current committed state (immutable by convention). */
  state(): Readonly<RoomRecord> {
    return this.room;
  }
  getSnapshot(): RoomRecord {
    return structuredClone(this.room);
  }
  get queueLength(): number {
    return this.pending;
  }
  get lastActivity(): number {
    return this.last;
  }
  get isDisposed(): boolean {
    return this.disposed;
  }

  enqueue<T = void>(fn: RoomTask<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new RoomActorError('disposed'));
    if (this.pending >= this.maxQueue) return Promise.reject(new RoomActorError('queue_full'));
    this.pending += 1;
    this.last = this.now();
    const run = async (): Promise<T> => {
      try {
        const before = this.room;
        const out = await fn(before);
        const next = isWrapped(out) ? out.room : out;
        const result = (isWrapped(out) ? out.result : undefined) as T;
        if (next === before) return result; // no change: nothing to persist
        const committed: RoomRecord = { ...next, version: before.version + 1 };
        await this.store.save(committed); // throws -> `this.room` stays at `before`
        this.room = committed;
        return result;
      } finally {
        this.pending -= 1;
        this.last = this.now();
      }
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => undefined);
    return p;
  }

  /** Resolves once everything queued so far has settled. */
  drain(): Promise<void> {
    return this.tail.then(() => undefined);
  }

  /** Reject further work. Already-queued tasks still run. */
  dispose(): void {
    this.disposed = true;
  }
}

export { RoomGoneError };
