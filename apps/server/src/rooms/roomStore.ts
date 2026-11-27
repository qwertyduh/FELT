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

export class RoomStore {
  constructor(
    private readonly redis: RoomRedis,
    private readonly opts: { randomInt?: RandomInt; now?: () => number } = {},
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

  /** Null when missing or the stored value fails validation. */
  async get(code: RoomCode): Promise<RoomRecord | null> {
    const raw = await bounded(() => this.redis.get(roomKey(code)));
    if (raw === null) return null;
    try {
      const parsed = RoomRecordSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Persist `record` (caller has already bumped `version`) with a refreshed TTL. XX: a room whose
   * key expired or was deleted is never resurrected; that throws RoomGoneError.
   * `keepTtl`: a write that is not activity (presence) must not extend the room's life.
   */
  async save(record: RoomRecord, opts: { keepTtl?: boolean } = {}): Promise<void> {
    const key = roomKey(record.code);
    const value = JSON.stringify(record);
    const ok = await bounded(() =>
      opts.keepTtl
        ? this.redis.set(key, value, 'KEEPTTL', 'XX')
        : this.redis.set(key, value, 'EX', ROOM_TTL_SECONDS, 'XX'),
    );
    if (ok !== 'OK') throw new RoomGoneError();
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
