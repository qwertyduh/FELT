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
  TableChipsByUserSchema,
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
 * the deck or anybody's hole cards (those travel only in `hand:private`), with one
 * exception: `hand.outcome.hands`, the cards shown once an online hand has ended.
 * Strict schemas reject any stray `hole` / `holeCards` / `deck` key. Join/top-up requests are
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
    /** Left while their cards stay in play: the seat is cashed out when the hand ends. */
    leaving: z.boolean(),
    /**
     * What leaving now would do to the cards in the running hand; null without any (not dealt in,
     * folded, hand over, or already leaving). `returned` is what a fold would put back on their stack
     * at once; more can follow later in the hand.
     */
    onLeave: z.object({ staysLive: z.boolean(), returned: TableChipsSchema }).strict().nullable(),
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

/** A hand turned face up after an online hand ended. */
export const ShownHandSchema = z
  .object({
    userId: UserIdSchema,
    cards: z.tuple([CardSchema, CardSchema]),
    /** Null when it was never evaluated (shown after folding, or the hand ended by folds). */
    handName: z.string().min(1).max(60).nullable(),
    /** True when the player chose to show it (`hand:show`); false when the rules revealed it. */
    voluntary: z.boolean(),
  })
  .strict();
export type ShownHand = z.infer<typeof ShownHandSchema>;

/** Online only: how the hand ended. Present exactly while `street` is `ended`. */
export const HandOutcomeSchema = z
  .object({
    /**
     * All-in run-out: how many board cards were face up when the betting closed. The rest of
     * `board` was dealt at once, with the contesting hands face up, for clients to turn over street
     * by street. Null when there was no run-out.
     */
    runoutFrom: z.union([z.literal(0), z.literal(3), z.literal(4)]).nullable(),
    /** In showing order. A mucked or folded hand is absent unless its owner showed it. */
    hands: z.array(ShownHandSchema).max(MAX_SEATS),
    /** One per pot, main pot first. `handNames` covers the winners of a contested pot. */
    awards: z
      .array(
        z
          .object({
            potId: IdSchema,
            winners: z.array(UserIdSchema).max(MAX_SEATS),
            amounts: TableChipsByUserSchema,
            contested: z.boolean(),
            handNames: z.record(UserIdSchema, z.string().max(60)),
          })
          .strict(),
      )
      .max(MAX_SEATS),
    /** When the next hand is due (absolute epoch ms); null if none is scheduled. */
    nextHandAt: EpochMsSchema.nullable(),
  })
  .strict();
export type HandOutcome = z.infer<typeof HandOutcomeSchema>;

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
    /** Absolute deadline (epoch ms) of the current turn; null when no timer, nobody on turn or paused. */
    turnDeadline: EpochMsSchema.nullable(),
    /** Hybrid: betting is complete and the host must advance the street / award. */
    awaitingHost: z.boolean(),
    pendingAwards: z.array(PendingAwardSchema).max(MAX_SEATS),
    /** Online hands that have ended; absent otherwise (and always in hybrid). */
    outcome: HandOutcomeSchema.optional(),
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
    /**
     * Absolute epoch ms from which the next dealt hand takes the next blind level (it may be in
     * the past: a hand is still running). Null when off, before the first hand, paused or ended.
     */
    nextBlindIncreaseAt: EpochMsSchema.nullable(),
    /** Only while paused: the time the countdown will resume with. */
    blindIncreaseLeftMs: z.number().int().min(0).optional(),
    /** The blinds that increase will bring; absent when no countdown is running or frozen. */
    nextBlindLevel: z
      .object({ smallBlind: TableChipsSchema, bigBlind: TableChipsSchema })
      .strict()
      .optional(),
    paused: z.boolean(),
    /** Oldest first, the last `ROOM_LOG_LIMIT` entries. */
    log: z.array(RoomLogEntrySchema).max(ROOM_LOG_LIMIT),
  })
  .strict();
export type PublicRoomState = z.infer<typeof PublicRoomStateSchema>;
