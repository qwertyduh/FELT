import { z } from 'zod';
import {
  CardSchema,
  ChipsByUserSchema,
  EpochMsSchema,
  IdSchema,
  MAX_SEATS,
  SeatIndexSchema,
  StreetSchema,
  TableChipsSchema,
  TurnSeqSchema,
  UserIdSchema,
} from './common';
import { RoomCodeSchema, RoomSettingsSchema, RoomStatusSchema } from './rooms';

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

export const PublicRoomStateSchema = z
  .object({
    /** Monotonic; clients drop updates with version <= the one they hold. */
    version: z.number().int().min(0),
    code: RoomCodeSchema,
    status: RoomStatusSchema,
    settings: RoomSettingsSchema,
    hostId: UserIdSchema,
    /** Index = seat; null = empty. Length === settings.maxSeats. */
    seats: z.array(PublicSeatSchema.nullable()).min(2).max(MAX_SEATS),
    /** Seat of the button for the last/current hand; null before the first hand. */
    button: SeatIndexSchema.nullable(),
    /** Null between hands. */
    hand: PublicHandSchema.nullable(),
    /** Approved top-ups waiting for the next hand (amount per userId). */
    pendingTopUps: ChipsByUserSchema,
    /** Absolute epoch ms of the next blind increase; null when off. */
    nextBlindIncreaseAt: EpochMsSchema.nullable(),
    paused: z.boolean(),
  })
  .strict();
export type PublicRoomState = z.infer<typeof PublicRoomStateSchema>;
