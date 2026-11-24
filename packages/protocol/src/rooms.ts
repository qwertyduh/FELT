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

// ---------- Settings (PRD 5.2) ----------
export const TURN_TIMER_OPTIONS = [15, 30, 60] as const;
/** null = timer off. */
export const TurnTimerSchema = z.union([z.literal(15), z.literal(30), z.literal(60), z.null()]);
export const MAX_BLIND_INCREASE_MINUTES = 240;

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
  blindIncreaseMinutes: z.number().int().min(1).max(MAX_BLIND_INCREASE_MINUTES).nullable(),
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
 * Host edits (applied next hand). Every field optional, at least one required;
 * the mode cannot change. Cross-field ordering is re-checked against the full
 * merged settings by the server; here only fields present together are checked.
 */
export const HostSettingsPatchSchema = z
  .object({ ...settingsShape, mode: z.never().optional() })
  .partial()
  .strict()
  .superRefine(checkRanges)
  .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'empty patch' });
export type HostSettingsPatch = z.infer<typeof HostSettingsPatchSchema>;

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
