import { z } from 'zod';
import {
  PositiveChipsSchema,
  RoomCodeSchema,
  RoomSettingsSchema,
  RoomStatusSchema,
  type RoomCode,
  type RoomSettings,
} from '@felt/protocol';
import { generateRoomCode, type RandomInt } from './code';
import { bounded, RoomStoreUnavailableError, type RoomRedis } from './redis';

export const ROOM_TTL_SECONDS = 2 * 60 * 60;
export const MAX_OPEN_ROOMS_PER_USER = 5;
export const CODE_ATTEMPTS = 8;

const UserId = z.string().min(1).max(64);

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
          userId: UserId,
          username: z.string(),
          kind: z.enum(['join', 'topup']),
          requestedAt: z.number().int(),
          expiresAt: z.number().int(),
        })
        .strict(),
    ),
    seats: z.array(
      z
        .object({
          seat: z.number().int().min(0).max(8),
          userId: UserId,
          stack: z.number().int().min(0),
          sittingOut: z.boolean(),
        })
        .strict(),
    ),
    ledger: z.array(
      z
        .object({
          userId: UserId,
          type: z.string().max(32),
          amount: PositiveChipsSchema,
          at: z.number().int(),
        })
        .strict(),
    ),
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
   */
  async save(record: RoomRecord): Promise<void> {
    const ok = await bounded(() =>
      this.redis.set(roomKey(record.code), JSON.stringify(record), 'EX', ROOM_TTL_SECONDS, 'XX'),
    );
    if (ok !== 'OK') throw new RoomGoneError();
  }

  /** Refresh the TTL on activity. */
  async touch(code: RoomCode): Promise<boolean> {
    return (await bounded(() => this.redis.expire(roomKey(code), ROOM_TTL_SECONDS))) === 1;
  }
}

export { RoomStoreUnavailableError };
