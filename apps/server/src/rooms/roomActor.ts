import { AsyncLocalStorage } from 'node:async_hooks';
import type { RoomCode } from '@felt/protocol';
import { RoomGoneError, RoomRecordSchema, type RoomRecord, type RoomStore } from './roomStore';

export const TASK_TIMEOUT_MS = 10_000;

/** Marks code running inside a task of the given actor (re-entrant enqueue detection). */
const running = new AsyncLocalStorage<{ actor: RoomActor; active: boolean }>();

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const c of Object.values(v)) deepFreeze(c);
  }
  return v;
}

export const MAX_QUEUE_LENGTH = 200;

export type ActorErrorCode =
  | 'queue_full'
  | 'disposed'
  | 'invalid_record'
  | 'invalid_task_result'
  | 'task_timeout'
  | 'reentrant_enqueue';
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
  /** Per-task limit. A timed-out task's late result is discarded and never persisted. */
  taskTimeoutMs?: number;
  /** Called when the room's key no longer exists (the actor is disposed first). */
  onGone?: (actor: RoomActor) => void;
  /**
   * Called synchronously right after each committed (persisted) change, before the next task can
   * start, so calls arrive in version order. `before` is the state the change replaced. An error
   * never fails the task (the change is already saved); it goes to `onCommitError`.
   */
  onCommit?: (room: Readonly<RoomRecord>, before: Readonly<RoomRecord>) => void;
  onCommitError?: (err: unknown, room: Readonly<RoomRecord>) => void;
}

export interface EnqueueOptions {
  /** Persist without refreshing the room's TTL (the change is not user activity). */
  keepTtl?: boolean;
  /** This task hands the room to another host; any other change of `hostId` is rejected. */
  newHost?: boolean;
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
  private readonly timeoutMs: number;
  private readonly onGone: ((a: RoomActor) => void) | undefined;
  private readonly onCommit: RoomActorOptions['onCommit'];
  private readonly onCommitError: RoomActorOptions['onCommitError'];
  private last: number;

  constructor(
    initial: RoomRecord,
    private readonly store: Pick<RoomStore, 'save'>,
    opts: RoomActorOptions = {},
  ) {
    this.room = initial;
    this.maxQueue = opts.maxQueue ?? MAX_QUEUE_LENGTH;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.taskTimeoutMs ?? TASK_TIMEOUT_MS;
    this.onGone = opts.onGone;
    this.onCommit = opts.onCommit;
    this.onCommitError = opts.onCommitError;
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

  enqueue<T = void>(fn: RoomTask<T>, opts: EnqueueOptions = {}): Promise<T> {
    const ctx = running.getStore();
    if (ctx?.actor === this && ctx.active)
      return Promise.reject(new RoomActorError('reentrant_enqueue'));
    if (this.disposed) return Promise.reject(new RoomActorError('disposed'));
    if (this.pending >= this.maxQueue) return Promise.reject(new RoomActorError('queue_full'));
    this.pending += 1;
    this.last = this.now();
    const run = async (): Promise<T> => {
      try {
        const before = this.room;
        // The task gets a deep-frozen copy: in-place mutation throws and can never corrupt `before`.
        const input = deepFreeze(structuredClone(before));
        const token = { actor: this as RoomActor, active: true };
        let timer: NodeJS.Timeout | undefined;
        let out: TaskOutcome<T>;
        try {
          out = await Promise.race([
            running.run(token, () => Promise.resolve(fn(input))),
            new Promise<never>((_, rej) => {
              timer = setTimeout(() => rej(new RoomActorError('task_timeout')), this.timeoutMs);
            }),
          ]);
        } finally {
          token.active = false; // detached work started by this task may enqueue later
          clearTimeout(timer);
        }
        if (typeof out !== 'object' || out === null) {
          throw new RoomActorError('invalid_task_result');
        }
        const next = isWrapped(out) ? out.room : out;
        const result = (isWrapped(out) ? out.result : undefined) as T;
        if (typeof next !== 'object' || next === null) {
          throw new RoomActorError('invalid_task_result');
        }
        if (next === input || next === before) return result; // no change: nothing to persist
        const committed: RoomRecord = { ...next, version: before.version + 1 };
        if (
          !RoomRecordSchema.safeParse(committed).success ||
          committed.code !== before.code ||
          (committed.hostId !== before.hostId && !opts.newHost)
        ) {
          throw new RoomActorError('invalid_record');
        }
        try {
          await this.store.save(committed, opts); // throws -> `this.room` stays at `before`
        } catch (err) {
          if (err instanceof RoomGoneError) {
            this.dispose();
            this.onGone?.(this);
          }
          throw err;
        }
        this.room = committed;
        try {
          this.onCommit?.(committed, before);
        } catch (err) {
          // Publishing must never fail an already persisted change.
          this.onCommitError?.(err, committed);
        }
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
