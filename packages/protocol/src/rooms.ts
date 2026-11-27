import { z } from 'zod';
import { GameModeSchema, MAX_SEATS, MIN_SEATS, PositiveChipsSchema } from './common';

// ---------- Room code ----------
/** No 0/O, 1/I/L (ambiguous) (31 characters). */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_PREFIX = 'FELT-';
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_PATTERN = /^FELT-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

/** Trims and upper-cases (users type codes by hand), then validates. */
export const RoomCodeSchema = z
  .string()
  .max(32)
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().regex(ROOM_CODE_PATTERN, 'Invalid room code'))
  .brand<'RoomCode'>();
export type RoomCode = z.infer<typeof RoomCodeSchema>;

// ---------- Join requests (PRD 5.2) ----------
/** A join request the host has not answered expires after this long. */
export const JOIN_REQUEST_TTL_MS = 2 * 60_000;
/** A denied player cannot ask again for this long. */
export const DENY_COOLDOWN_MS = 10 * 60_000;

// ---------- Disconnects (PRD 5.2, 5.10) ----------
/** A host who has been away this long hands the room to the longest-seated connected player. */
export const HOST_FAILOVER_MS = 2 * 60_000;
/** How long a dropped player's seat is held. The host can change it (`host:seat_hold`). */
export const DEFAULT_SEAT_HOLD_MINUTES = 3;
export const MAX_SEAT_HOLD_MINUTES = 30;
export const SeatHoldMinutesSchema = z.number().int().min(1).max(MAX_SEAT_HOLD_MINUTES);

// ---------- Settings (PRD 5.2) ----------
export const TURN_TIMER_OPTIONS = [15, 30, 60] as const;
/** null = timer off. */
export const TurnTimerSchema = z.union([z.literal(15), z.literal(30), z.literal(60), z.null()]);
export const MAX_BLIND_INCREASE_MINUTES = 240;
export const BlindIncreaseMinutesSchema = z.number().int().min(1).max(MAX_BLIND_INCREASE_MINUTES);
/** How much each automatic increase multiplies both blinds by. */
export const BLIND_MULTIPLIERS = [1.5, 2] as const;
export const DEFAULT_BLIND_MULTIPLIER = 2;
export const BlindMultiplierSchema = z.union([z.literal(1.5), z.literal(2)]);
export type BlindMultiplier = z.infer<typeof BlindMultiplierSchema>;

const settingsShape = {
  mode: GameModeSchema,
  minBuyIn: PositiveChipsSchema,
  /** null = no maximum. */
  maxBuyIn: PositiveChipsSchema.nullable(),
  smallBlind: PositiveChipsSchema,
  bigBlind: PositiveChipsSchema,
  maxSeats: z.number().int().min(MIN_SEATS).max(MAX_SEATS),
  /** Seconds per turn; null = off. */
  turnTimerSeconds: TurnTimerSchema,
  /** Raise blinds every N minutes; null = off. */
  blindIncreaseMinutes: BlindIncreaseMinutesSchema.nullable(),
  /** Defaulted, so rooms stored before it existed still load. */
  blindIncreaseMultiplier: BlindMultiplierSchema.default(DEFAULT_BLIND_MULTIPLIER),
};

type Rangeable = {
  minBuyIn?: number | undefined;
  maxBuyIn?: number | null | undefined;
  smallBlind?: number | undefined;
  bigBlind?: number | undefined;
};

function checkRanges(s: Rangeable, ctx: z.RefinementCtx): void {
  if (s.minBuyIn !== undefined && s.maxBuyIn != null && s.minBuyIn > s.maxBuyIn) {
    ctx.addIssue({ code: 'custom', path: ['maxBuyIn'], message: 'maxBuyIn must be >= minBuyIn' });
  }
  if (s.smallBlind !== undefined && s.bigBlind !== undefined && s.smallBlind > s.bigBlind) {
    ctx.addIssue({ code: 'custom', path: ['bigBlind'], message: 'bigBlind must be >= smallBlind' });
  }
}

export const RoomSettingsSchema = z.object(settingsShape).strict().superRefine(checkRanges);
export type RoomSettings = z.infer<typeof RoomSettingsSchema>;

/**
 * `host:settings`: the blinds, set by hand. Both are sent, so they are checked together. They apply
 * from the next hand.
 */
export const HostSettingsPatchSchema = z
  .object({ smallBlind: settingsShape.smallBlind, bigBlind: settingsShape.bigBlind })
  .strict()
  .superRefine(checkRanges);
export type HostSettingsPatch = z.infer<typeof HostSettingsPatchSchema>;

/** `host:blind_increase`: the automatic schedule. `minutes: null` turns it off. */
export const BlindIncreasePatchSchema = z
  .object({ minutes: BlindIncreaseMinutesSchema.nullable(), multiplier: BlindMultiplierSchema })
  .strict();
export type BlindIncreasePatch = z.infer<typeof BlindIncreasePatchSchema>;

/** PRD 5.2 defaults: 1000 min, no max, 5/10, 9 seats, timer 30s online / off hybrid, no increase. */
export function defaultRoomSettings(mode: z.infer<typeof GameModeSchema>): RoomSettings {
  return {
    mode,
    minBuyIn: 1000,
    maxBuyIn: null,
    smallBlind: 5,
    bigBlind: 10,
    maxSeats: 9,
    turnTimerSeconds: mode === 'online' ? 30 : null,
    blindIncreaseMinutes: null,
    blindIncreaseMultiplier: DEFAULT_BLIND_MULTIPLIER,
  };
}

/** Throws a ZodError on invalid input. */
export function parseRoomSettings(input: unknown): RoomSettings {
  return RoomSettingsSchema.parse(input);
}

// ---------- REST shapes (ARCHITECTURE 8) ----------
export const CreateRoomRequestSchema = RoomSettingsSchema;
export const CreateRoomResponseSchema = z
  .object({ code: RoomCodeSchema, url: z.string().min(1).max(256) })
  .strict();
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;

export const ROOM_STATUSES = ['lobby', 'playing', 'paused', 'ended'] as const;
export const RoomStatusSchema = z.enum(ROOM_STATUSES);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;

export const RoomPreviewSchema = z
  .object({
    code: RoomCodeSchema,
    mode: GameModeSchema,
    hostUsername: z.string().min(1).max(20),
    smallBlind: PositiveChipsSchema,
    bigBlind: PositiveChipsSchema,
    minBuyIn: PositiveChipsSchema,
    maxBuyIn: PositiveChipsSchema.nullable(),
    seatsTaken: z.number().int().min(0).max(MAX_SEATS),
    maxSeats: z.number().int().min(MIN_SEATS).max(MAX_SEATS),
    status: RoomStatusSchema,
  })
  .strict();
export type RoomPreview = z.infer<typeof RoomPreviewSchema>;
