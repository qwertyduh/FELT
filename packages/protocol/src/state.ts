import { z } from 'zod';
import {
  ADJUST_REASON_MAX,
  CardSchema,
  ChipsByUserSchema,
  EpochMsSchema,
  IdSchema,
  MAX_SEATS,
  ROOM_LOG_LIMIT,
  SeatIndexSchema,
  StreetSchema,
  TableChipsSchema,
  TurnSeqSchema,
  UndoActionSchema,
  UserIdSchema,
} from './common';
import {
  RoomCodeSchema,
  RoomSettingsSchema,
  RoomStatusSchema,
  SeatHoldMinutesSchema,
} from './rooms';

/**
 * Public room state: what every ADMITTED player may see. It must never carry
 * hole cards or the deck (those travel only in `hand:private`). Strict schemas
 * reject any stray `hole` / `holeCards` / `deck` key. Join/top-up requests are
 * host-only (see HostInbox in events.ts), not part of this state.
 */

export const PLAYER_HAND_STATUSES = ['active', 'folded', 'all_in'] as const;

const PublicNameSchema = z.string().min(1).max(20);

export const PublicSeatSchema = z
  .object({
    seat: SeatIndexSchema,
    userId: UserIdSchema,
    username: PublicNameSchema,
    stack: TableChipsSchema,
    /** Chips put in on the current street. */
    bet: TableChipsSchema,
    /** Status in the running hand; null when not dealt in. */
    handStatus: z.enum(PLAYER_HAND_STATUSES).nullable(),
    sittingOut: z.boolean(),
    connected: z.boolean(),
    muted: z.boolean(),
  })
  .strict();
export type PublicSeat = z.infer<typeof PublicSeatSchema>;

export const PublicPotSchema = z
  .object({
    id: IdSchema,
    amount: TableChipsSchema,
    eligible: z.array(UserIdSchema).max(MAX_SEATS),
  })
  .strict();
export type PublicPot = z.infer<typeof PublicPotSchema>;

/** Hybrid: a proposed award waiting out the 5s dispute window. */
export const PendingAwardSchema = z
  .object({
    potId: IdSchema,
    winners: z.array(UserIdSchema).min(1).max(MAX_SEATS),
    /** Absolute epoch ms when the award auto-confirms. */
    confirmAt: EpochMsSchema,
    disputed: z.boolean(),
  })
  .strict();

/**
 * The choices of the player on turn, as the engine computes them (clients show these and apply no
 * betting rules of their own). Public: it follows from the betting everyone has seen. Fold is
 * always allowed.
 */
export const TurnOptionsSchema = z
  .object({
    check: z.boolean(),
    /** Chips a call puts in; null when there is nothing to call. */
    call: TableChipsSchema.nullable(),
    /** Street totals ("raise to"); `max` is all-in. Null when betting or raising is not open. */
    raise: z
      .object({ type: z.enum(['bet', 'raise']), min: TableChipsSchema, max: TableChipsSchema })
      .strict()
      .nullable(),
  })
  .strict();
export type TurnOptions = z.infer<typeof TurnOptionsSchema>;

export const PublicHandSchema = z
  .object({
    handId: IdSchema,
    /** Goes up with every change to the hand; `game:act` must quote it. */
    turnSeq: TurnSeqSchema,
    /** For `currentActor`; null when nobody is on turn. */
    options: TurnOptionsSchema.nullable(),
    street: StreetSchema,
    board: z.array(CardSchema).max(5),
    pots: z.array(PublicPotSchema).max(MAX_SEATS),
    /**
     * This street's bets of players who have since left their seat: part of the pot, but on no
     * seat in `seats`.
     */
    departedBet: TableChipsSchema,
    /**
     * Hybrid: what `host:undo` would take back now (`userId` is null for a deal), or null. Only
     * that one step: the history itself never leaves the server.
     */
    undo: z
      .object({ action: UndoActionSchema, userId: UserIdSchema.nullable() })
      .strict()
      .nullable(),
    /** Highest street bet to match. */
    currentBet: TableChipsSchema,
    /** Min-raise increment (last full raise). */
    lastFullRaise: TableChipsSchema,
    /** Seat to act, or null. */
    currentActor: SeatIndexSchema.nullable(),
    button: SeatIndexSchema,
    smallBlindSeat: SeatIndexSchema,
    bigBlindSeat: SeatIndexSchema,
    /** Absolute deadline (epoch ms) of the current turn; null when no timer. */
    turnDeadline: EpochMsSchema.nullable(),
    /** Hybrid: betting is complete and the host must advance the street / award. */
    awaitingHost: z.boolean(),
    pendingAwards: z.array(PendingAwardSchema).max(MAX_SEATS),
  })
  .strict();
export type PublicHand = z.infer<typeof PublicHandSchema>;

const logBase = { id: z.number().int().min(1), at: EpochMsSchema };

/**
 * The room log every admitted player may read: the host's corrections. `street` is the one the
 * undone step was taken on (for a deal, the street that was dealt).
 */
export const RoomLogEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...logBase,
      kind: z.literal('undo'),
      action: UndoActionSchema,
      /** Whose move was taken back; null for a deal. */
      username: PublicNameSchema.nullable(),
      street: StreetSchema,
    })
    .strict(),
  z
    .object({
      ...logBase,
      /** The host folded a disconnected player's hand. */
      kind: z.literal('force_fold'),
      username: PublicNameSchema,
      street: StreetSchema,
    })
    .strict(),
  z
    .object({
      ...logBase,
      kind: z.literal('adjust'),
      username: PublicNameSchema,
      /** Signed change. */
      amount: z.number().int(),
      /** The stack after it. */
      stack: TableChipsSchema,
      reason: z.string().min(1).max(ADJUST_REASON_MAX),
    })
    .strict(),
]);
export type RoomLogEntry = z.infer<typeof RoomLogEntrySchema>;

export const PublicRoomStateSchema = z
  .object({
    /** Monotonic; clients drop updates with version <= the one they hold. */
    version: z.number().int().min(0),
    code: RoomCodeSchema,
    status: RoomStatusSchema,
    settings: RoomSettingsSchema,
    hostId: UserIdSchema,
    /** Set once the host has changed it; absent means `DEFAULT_SEAT_HOLD_MINUTES`. */
    seatHoldMinutes: SeatHoldMinutesSchema.optional(),
    /** Index = seat; null = empty. Length === settings.maxSeats. */
    seats: z.array(PublicSeatSchema.nullable()).min(2).max(MAX_SEATS),
    /** Seat of the button for the last/current hand; null before the first hand. */
    button: SeatIndexSchema.nullable(),
    /** Null between hands. */
    hand: PublicHandSchema.nullable(),
    /** Approved top-ups waiting for the next hand (amount per userId). */
    pendingTopUps: ChipsByUserSchema,
    /** Blinds the host has set for the next hand; absent when no change is waiting. */
    nextBlinds: z
      .object({ smallBlind: TableChipsSchema, bigBlind: TableChipsSchema })
      .strict()
      .optional(),
    /** Absolute epoch ms of the next blind increase; null when off. */
    nextBlindIncreaseAt: EpochMsSchema.nullable(),
    paused: z.boolean(),
    /** Oldest first, the last `ROOM_LOG_LIMIT` entries. */
    log: z.array(RoomLogEntrySchema).max(ROOM_LOG_LIMIT),
  })
  .strict();
export type PublicRoomState = z.infer<typeof PublicRoomStateSchema>;
