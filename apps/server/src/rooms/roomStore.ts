import { z } from 'zod';
import {
  PositiveChipsSchema,
  ROOM_LOG_LIMIT,
  RoomCodeSchema,
  RoomLogEntrySchema,
  RoomSettingsSchema,
  RoomStatusSchema,
  SeatHoldMinutesSchema,
  type RoomCode,
  type RoomSettings,
} from '@felt/protocol';
import { generateRoomCode, type RandomInt } from './code';
import { GameSchema } from './gameSchema';
import { bounded, RoomStoreUnavailableError, type RoomRedis } from './redis';

export const ROOM_TTL_SECONDS = 2 * 60 * 60;
export const MAX_OPEN_ROOMS_PER_USER = 5;
export const CODE_ATTEMPTS = 8;

const UserId = z.string().min(1).max(64);

/** ARCHITECTURE's ledger kinds plus `cash_out` (chips leaving the table with a player). */
export const LEDGER_KINDS = ['buy_in', 'top_up', 'adjust', 'hand_result', 'cash_out'] as const;

/** A top-up asked for. The amount never changes: another amount is another request. */
const TopUpSchema = z
  .object({ requestId: z.string().min(1).max(64), userId: UserId, amount: PositiveChipsSchema })
  .strict();
export type TopUp = z.infer<typeof TopUpSchema>;

/** Server-side room record (`room:{code}`). Later phases extend the sub-shapes. */
export const RoomRecordSchema = z
  .object({
    version: z.number().int().min(0),
    code: RoomCodeSchema,
    status: RoomStatusSchema,
    settings: RoomSettingsSchema,
    hostId: UserId,
    /** Snapshot taken at creation; the preview never needs a DB hit. */
    hostUsername: z.string().min(1).max(20),
    createdAt: z.number().int(),
    admitted: z.array(UserId),
    requests: z.array(
      z
        .object({
          requestId: z.string().min(1).max(64),
          userId: UserId,
          username: z.string(),
          kind: z.enum(['join', 'topup']),
          requestedAt: z.number().int(),
          expiresAt: z.number().int(),
        })
        .strict(),
    ),
    /** Top-ups waiting for the host's answer; one per seated user at most. */
    topUpRequests: z.array(TopUpSchema).optional(),
    /** Approved top-ups, added to the stack when the next hand starts. */
    pendingTopUps: z.array(TopUpSchema).optional(),
    /** Usernames of admitted users, for the host's list (`host:members`). Absent on old rooms. */
    names: z.record(UserId, z.string().min(1).max(20)).optional(),
    /** Removed by the host and not asked again since: told so if they come back. */
    kicked: z.array(UserId).optional(),
    /** Blinds the host set while a hand was running; taken up when the next one is dealt. */
    nextBlinds: z
      .object({ smallBlind: PositiveChipsSchema, bigBlind: PositiveChipsSchema })
      .strict()
      .optional(),
    /**
     * Automatic blind increase (blinds.ts): from `at` (absolute epoch ms) the next dealt hand takes
     * the next level. `pausedAt` freezes it. Absent when off or before the first hand.
     */
    blindClock: z
      .object({ at: z.number().int(), pausedAt: z.number().int().optional() })
      .strict()
      .optional(),
    /**
     * Seated players and the host who have no socket in the room (absence.ts): when that was
     * noticed, and until when a seat is held. Absolute epoch ms.
     */
    away: z
      .record(UserId, z.object({ since: z.number().int(), releaseAt: z.number().int() }).strict())
      .optional(),
    /** Per user, the visit that last entered the room (`room:enter`). */
    sessions: z.record(UserId, z.string().min(1).max(64)).optional(),
    /** `host:seat_hold`; absent means the default. */
    seatHoldMinutes: SeatHoldMinutesSchema.optional(),
    /**
     * The host ended the game while a hand was being played: no further hand is dealt and the game
     * ends once this one is over (ending.ts).
     */
    ending: z.boolean().optional(),
    /** Removed by the host while still in the running hand: it takes effect when the hand ends. */
    removals: z.array(UserId).optional(),
    /** Join-denial cooldowns: userId -> epoch ms until which the user may not ask again. */
    denied: z.record(UserId, z.number().int()).optional(),
    seats: z.array(
      z
        .object({
          seat: z.number().int().min(0).max(8),
          userId: UserId,
          /** Snapshot taken when sitting (usernames never change): no DB hit to broadcast. */
          username: z.string().min(1).max(20),
          stack: z.number().int().min(0),
          sittingOut: z.boolean(),
          /** Turns in a row the clock ran out on (P48); absent means none. */
          timeouts: z.number().int().min(0).optional(),
          /** Why they are sitting out, when it was not their choice. */
          sitOutReason: z.literal('timeouts').optional(),
          /** Left during a hand their cards are still live in; cashed out when it ends. */
          leaving: z.boolean().optional(),
        })
        .strict(),
    ),
    ledger: z.array(
      z
        .object({
          t: z.number().int(),
          userId: UserId,
          kind: z.enum(LEDGER_KINDS),
          /** Signed for an `adjust`. A `cash_out` is 0 when the player left busted. */
          amount: z.number().int(),
          note: z.string().max(100).optional(),
        })
        .strict()
        .refine((e) => e.kind === 'adjust' || e.amount >= 0, 'only an adjust may be negative'),
    ),
    /** The public room log (host corrections), oldest first. */
    log: z.array(RoomLogEntrySchema).max(ROOM_LOG_LIMIT).optional(),
    /** Absent until the host first starts the game. */
    game: GameSchema.optional(),
  })
  .strict();
export type RoomRecord = z.infer<typeof RoomRecordSchema>;

export const roomKey = (code: string): string => `room:${code}`;
export const userRoomsKey = (userId: string): string => `user:${userId}:rooms`;

export function newRoomRecord(
  code: RoomCode,
  settings: RoomSettings,
  host: { id: string; username: string },
  now: number,
): RoomRecord {
  return {
    version: 0,
    code,
    status: 'lobby',
    settings,
    hostId: host.id,
    hostUsername: host.username,
    createdAt: now,
    admitted: [host.id],
    names: { [host.id]: host.username },
    requests: [],
    seats: [],
    ledger: [],
  };
}

export type CreateOutcome =
  { kind: 'created'; record: RoomRecord } | { kind: 'too_many_rooms' } | { kind: 'code_exhausted' };

export class RoomGoneError extends Error {
  constructor() {
    super('room no longer exists');
    this.name = 'RoomGoneError';
  }
}

/** The stored version is not the one the change was made from: somebody else has written. */
export class RoomConflictError extends Error {
  constructor() {
    super('room changed elsewhere');
    this.name = 'RoomConflictError';
  }
}

/**
 * The key exists but does not hold a record this server understands (e.g. written by a newer one
 * before a rollback). The room is not gone: it is left untouched and reported as unavailable.
 */
export class RoomRecordInvalidError extends RoomStoreUnavailableError {
  constructor() {
    super('invalid_record');
    this.name = 'RoomRecordInvalidError';
  }
}

/**
 * Compare-and-set on the record's `version`. KEYS[1] room key; ARGV: expected version, new record,
 * TTL seconds ('' keeps the TTL).
 */
export const SAVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 'gone' end
local ok, doc = pcall(cjson.decode, current)
if not ok or type(doc) ~= 'table' or doc.version ~= tonumber(ARGV[1]) then return 'conflict' end
if ARGV[3] == '' then
  redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
else
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
end
return 'ok'
`;

export interface RoomStoreOptions {
  randomInt?: RandomInt;
  now?: () => number;
  log?: { error(obj: Record<string, unknown>, msg: string): void };
}

export class RoomStore {
  /** Rooms already reported as unreadable (timers retry them every few seconds). */
  private readonly reported = new Set<string>();

  constructor(
    private readonly redis: RoomRedis,
    private readonly opts: RoomStoreOptions = {},
  ) {}

  /** Open rooms of a user; prunes codes whose record has expired. */
  private async openRooms(userId: string): Promise<string[]> {
    const key = userRoomsKey(userId);
    const codes = await bounded(() => this.redis.smembers(key));
    const live: string[] = [];
    for (const c of codes) {
      if ((await bounded(() => this.redis.exists(roomKey(c)))) > 0) live.push(c);
      else await bounded(() => this.redis.srem(key, c));
    }
    return live;
  }

  async create(
    settings: RoomSettings,
    host: { id: string; username: string },
  ): Promise<CreateOutcome> {
    if ((await this.openRooms(host.id)).length >= MAX_OPEN_ROOMS_PER_USER) {
      return { kind: 'too_many_rooms' };
    }
    const now = (this.opts.now ?? Date.now)();
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const code = generateRoomCode(this.opts.randomInt);
      const record = newRoomRecord(code, settings, host, now);
      const ok = await bounded(() =>
        this.redis.set(roomKey(code), JSON.stringify(record), 'EX', ROOM_TTL_SECONDS, 'NX'),
      );
      if (ok !== 'OK') continue; // collision
      const setKey = userRoomsKey(host.id);
      await bounded(() => this.redis.sadd(setKey, code));
      await bounded(() => this.redis.expire(setKey, ROOM_TTL_SECONDS));
      // Re-check after registering so two concurrent creates cannot both slip past the cap.
      if ((await this.openRooms(host.id)).length > MAX_OPEN_ROOMS_PER_USER) {
        await bounded(() => this.redis.srem(setKey, code));
        await bounded(() => this.redis.del(roomKey(code)));
        return { kind: 'too_many_rooms' };
      }
      return { kind: 'created', record };
    }
    return { kind: 'code_exhausted' };
  }

  /** Null when missing. Throws RoomRecordInvalidError when the stored value fails validation. */
  async get(code: RoomCode): Promise<RoomRecord | null> {
    const raw = await bounded(() => this.redis.get(roomKey(code)));
    if (raw === null) return null;
    let issues = ['not_json'];
    try {
      const parsed = RoomRecordSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.reported.delete(code);
        return parsed.data;
      }
      // Top-level field and kind of problem only: deeper paths and values can name users.
      issues = parsed.error.issues.slice(0, 5).map((i) => `${String(i.path[0] ?? '')}:${i.code}`);
    } catch {
      /* not JSON */
    }
    if (!this.reported.has(code)) {
      this.reported.add(code);
      this.opts.log?.error({ code, issues }, 'stored room record is invalid; left untouched');
    }
    throw new RoomRecordInvalidError();
  }

  /**
   * Persist `record` (caller has already bumped `version`) with a refreshed TTL, only over the
   * version it was made from. Otherwise: RoomConflictError, or RoomGoneError for a room whose key
   * expired or was deleted (never resurrected).
   * `keepTtl`: a write that is not activity (presence) must not extend the room's life.
   */
  async save(record: RoomRecord, opts: { keepTtl?: boolean } = {}): Promise<void> {
    const out = await bounded(() =>
      this.redis.eval(
        SAVE_SCRIPT,
        1,
        roomKey(record.code),
        record.version - 1,
        JSON.stringify(record),
        opts.keepTtl ? '' : ROOM_TTL_SECONDS,
      ),
    );
    if (out === 'gone') throw new RoomGoneError();
    if (out !== 'ok') throw new RoomConflictError();
  }

  /**
   * Refresh the room's TTL; false (and nothing else is touched) when its key is gone. `userIds`:
   * their open-rooms sets, which must not expire before a room they list, or the per-host limit
   * would forget it.
   */
  async touch(code: RoomCode, userIds: readonly string[] = []): Promise<boolean> {
    const refresh = (key: string) => bounded(() => this.redis.expire(key, ROOM_TTL_SECONDS));
    if ((await refresh(roomKey(code))) !== 1) return false;
    await Promise.all(userIds.map((id) => refresh(userRoomsKey(id))));
    return true;
  }
}

export { RoomStoreUnavailableError };
