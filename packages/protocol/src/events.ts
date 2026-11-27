import { z } from 'zod';
import {
  ADJUST_REASON_MAX,
  CardSchema,
  ChipsSchema,
  EpochMsSchema,
  IdSchema,
  MAX_CHIPS,
  MAX_SEATS,
  PositiveChipsSchema,
  SeatIndexSchema,
  TableChipsByUserSchema,
  TableChipsSchema,
  TurnSeqSchema,
  UserIdSchema,
} from './common';
import { HostSettingsPatchSchema, RoomCodeSchema } from './rooms';
import { PublicRoomStateSchema } from './state';

const NoPayload = z.undefined();

// ---------- Error codes & ack ----------
/** Mirrors the engine's EngineErrorCode (kept in sync by a test). */
export const ENGINE_ERROR_CODES = [
  'invalid_state',
  'hand_ended',
  'not_enough_players',
  'not_your_turn',
  'unknown_player',
  'illegal_action',
  'cannot_check',
  'nothing_to_call',
  'bet_too_small',
  'raise_too_small',
  'bet_exceeds_stack',
  'wrong_mode',
  'invalid_amount',
  'invalid_cards',
  'unknown_pot',
  'invalid_winners',
  'pot_already_awarded',
  'awaiting_host',
  'betting_incomplete',
] as const;

export const PROTOCOL_ERROR_CODES = [
  'invalid_payload',
  'unauthorized',
  'not_admitted',
  'not_host',
  'not_found',
  'room_ended',
  'room_paused',
  'already_requested',
  'cooldown',
  'request_expired',
  'room_full',
  'seat_taken',
  'already_seated',
  'not_seated',
  'invalid_buy_in',
  'invalid_topup',
  'stale_hand',
  'no_hand',
  'muted',
  'rate_limited',
  'forbidden',
  'internal',
] as const;

export const ERROR_CODES = [...ENGINE_ERROR_CODES, ...PROTOCOL_ERROR_CODES] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorPayloadSchema = z
  .object({ code: ErrorCodeSchema, message: z.string().max(300) })
  .strict();
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

export const AckSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: ErrorPayloadSchema }).strict(),
]);
export type Ack = z.infer<typeof AckSchema>;

// ---------- Client -> server payloads ----------
const handId = IdSchema;
const turnSeq = TurnSeqSchema;
const requestId = IdSchema;
const userRef = z.object({ userId: UserIdSchema }).strict();

/**
 * `amount` is the TOTAL street bet ("raise to"), mirroring the engine; none for other types.
 * `turnSeq` is the `room:state` value the player was looking at: a late or doubled send is refused
 * as `stale_hand` instead of acting on a later turn.
 */
export const GameActPayloadSchema = z.discriminatedUnion('type', [
  z.object({ handId, turnSeq, type: z.literal('fold') }).strict(),
  z.object({ handId, turnSeq, type: z.literal('check') }).strict(),
  z.object({ handId, turnSeq, type: z.literal('call') }).strict(),
  z.object({ handId, turnSeq, type: z.literal('all_in') }).strict(),
  z.object({ handId, turnSeq, type: z.literal('bet'), amount: PositiveChipsSchema }).strict(),
  z.object({ handId, turnSeq, type: z.literal('raise'), amount: PositiveChipsSchema }).strict(),
]);
export type GameActPayload = z.infer<typeof GameActPayloadSchema>;

/** Hybrid: how long a proposed award stands, open to dispute, before it is paid. */
export const AWARD_CONFIRM_MS = 5_000;

export const CHAT_MAX_LENGTH = 200;
/** Allow-list for quick reactions (decision: PRD/ARCH leave the set open). */
export const REACTION_EMOJIS = ['👍', '👏', '😂', '😮', '😭', '😡', '🔥', '🙏'] as const;

export const clientEventSchemas = {
  'room:request_join': z.object({ code: RoomCodeSchema }).strict(),
  /** Names the room: a user's requests elsewhere stay pending. */
  'room:cancel_request': z.object({ code: RoomCodeSchema }).strict(),
  'room:enter': z.object({ code: RoomCodeSchema }).strict(),
  /**
   * `buyIn` 0 is only for a player who left busted and is taking a seat again: they then ask the
   * host for chips with `player:topup_request`. The server refuses 0 from anyone else.
   */
  'room:sit': z.object({ seat: SeatIndexSchema, buyIn: ChipsSchema }).strict(),
  'room:sit_out': NoPayload,
  'room:sit_in': NoPayload,
  'room:leave': NoPayload,
  'game:act': GameActPayloadSchema,
  'player:topup_request': z.object({ amount: PositiveChipsSchema }).strict(),
  'host:admit': z.object({ requestId, approve: z.boolean() }).strict(),
  'host:topup': z.object({ requestId, approve: z.boolean() }).strict(),
  'host:start': NoPayload,
  'host:pause': NoPayload,
  'host:resume': NoPayload,
  'host:end': NoPayload,
  'host:settings': HostSettingsPatchSchema,
  'host:kick': userRef,
  'host:transfer': userRef,
  'host:mute': z.object({ userId: UserIdSchema, muted: z.boolean() }).strict(),
  /**
   * `street` is the street the host is advancing FROM. Without it a double tap during an all-in
   * run-out (nobody left to bet) would advance two streets. `turnSeq` is the `room:state` value
   * the host was looking at, as for `game:act`.
   */
  'host:advance_street': z
    .object({
      handId,
      turnSeq,
      street: z.enum(['preflop', 'flop', 'turn', 'river']),
      cards: z.array(CardSchema).min(1).max(3).optional(),
    })
    .strict(),
  /**
   * `turnSeq` ties the result to the pots the host was looking at: if the hand has changed since
   * (including another proposal or a dispute) it is refused as `stale_hand`.
   */
  'host:award': z
    .object({
      handId,
      turnSeq,
      awards: z
        .array(
          z
            .object({
              potId: IdSchema,
              winners: z.array(UserIdSchema).min(1).max(MAX_SEATS),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_SEATS),
    })
    .strict(),
  'host:dispute': z.object({ handId }).strict(),
  /** `turnSeq` as for `game:act`: a double or late send cannot undo a second step. */
  'host:undo': z.object({ handId, turnSeq }).strict(),
  /**
   * `amount` is a signed, non-zero delta. `stack` is the stack the host was looking at: if it has
   * changed (including by this same adjustment, sent twice) it is refused as `stale_hand`.
   */
  'host:adjust_stack': z
    .object({
      userId: UserIdSchema,
      amount: z
        .number()
        .int()
        .min(-MAX_CHIPS)
        .max(MAX_CHIPS)
        .refine((n) => n !== 0, { message: 'amount must be non-zero' }),
      stack: TableChipsSchema,
      /** Shown to the whole table: no control or text-direction characters. */
      reason: z
        .string()
        .trim()
        .min(1)
        .max(ADJUST_REASON_MAX)
        .regex(/^[^\p{Cc}\u202A-\u202E\u2066-\u2069]*$/u, 'plain text only'),
    })
    .strict(),
  'chat:send': z.object({ text: z.string().trim().min(1).max(CHAT_MAX_LENGTH) }).strict(),
  'chat:react': z.object({ emoji: z.enum(REACTION_EMOJIS) }).strict(),
} as const;

export type ClientEventName = keyof typeof clientEventSchemas;
export type ClientEventPayload<K extends ClientEventName> = z.infer<(typeof clientEventSchemas)[K]>;

/**
 * Generic validation for the server. Callers must pass `undefined` for events
 * with no payload (Socket.io hands the ack as the first arg then: strip it).
 */
export function parseClientEvent<K extends ClientEventName>(
  name: K,
  payload: unknown,
): z.ZodSafeParseResult<ClientEventPayload<K>> {
  return clientEventSchemas[name].safeParse(payload) as z.ZodSafeParseResult<ClientEventPayload<K>>;
}

// ---------- Server -> client payloads ----------
export const PrivateHandSchema = z
  .object({ handId, holeCards: z.tuple([CardSchema, CardSchema]) })
  .strict();

export const HandResultPayloadSchema = z
  .object({
    handId,
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
    /** Revealed hands only (showdown); empty when everyone folded or in hybrid. */
    showdown: z
      .array(
        z
          .object({
            userId: UserIdSchema,
            cards: z.tuple([CardSchema, CardSchema]),
            handName: z.string().max(60),
            category: z.number().int().min(0).max(9),
          })
          .strict(),
      )
      .max(MAX_SEATS),
    stacks: TableChipsByUserSchema,
  })
  .strict();

export const RecapPlayerSchema = z
  .object({
    userId: UserIdSchema,
    username: z.string().min(1).max(20),
    boughtIn: ChipsSchema,
    finalStack: ChipsSchema,
    net: z.number().int(),
    handsPlayed: z.number().int().min(0),
    handsWon: z.number().int().min(0),
    biggestPotWon: ChipsSchema,
  })
  .strict();

export const RecapSchema = z
  .object({ endedAt: EpochMsSchema, players: z.array(RecapPlayerSchema).max(MAX_SEATS) })
  .strict();
export type Recap = z.infer<typeof RecapSchema>;

const JoinRequestSchema = z
  .object({ requestId, userId: UserIdSchema, username: z.string().min(1).max(20) })
  .strict();
const TopUpRequestSchema = z
  .object({ requestId, userId: UserIdSchema, amount: PositiveChipsSchema })
  .strict();

/**
 * Host-only snapshot of pending requests, sent on (re)connect so a reconnecting
 * host sees them. Additive to ARCHITECTURE 9 (which only lists the incremental
 * `host:join_request` / `host:topup_request` events).
 */
export const HostInboxSchema = z
  .object({
    joinRequests: z.array(JoinRequestSchema.extend({ expiresAt: EpochMsSchema }).strict()).max(50),
    topUpRequests: z.array(TopUpRequestSchema).max(50),
  })
  .strict();

export const serverEventSchemas = {
  'room:join_pending': z.object({ requestId, expiresAt: EpochMsSchema }).strict(),
  'room:join_decision': z
    .object({ approved: z.boolean(), retryAfter: EpochMsSchema.optional() })
    .strict(),
  'host:join_request': JoinRequestSchema,
  'host:topup_request': TopUpRequestSchema,
  'host:inbox': HostInboxSchema,
  /**
   * To the requester. `reason: 'over_max'`: not added, because by the time it was due it would
   * have taken the stack over the maximum buy-in.
   */
  'player:topup_decision': z
    .object({
      requestId,
      approved: z.boolean(),
      amount: PositiveChipsSchema,
      reason: z.literal('over_max').optional(),
    })
    .strict(),
  /**
   * To one player: their own request still waiting for the host, or null. Sent on (re)entry and
   * on every change (approved amounts are public, in `room:state.pendingTopUps`).
   */
  'player:topup_status': z
    .object({ pending: z.object({ requestId, amount: PositiveChipsSchema }).strict().nullable() })
    .strict(),
  'room:state': PublicRoomStateSchema,
  'hand:private': PrivateHandSchema,
  'hand:result': HandResultPayloadSchema,
  'turn:start': z.object({ userId: UserIdSchema, deadline: EpochMsSchema.nullable() }).strict(),
  'chat:message': z
    .object({
      userId: UserIdSchema,
      username: z.string().min(1).max(20),
      text: z.string().min(1).max(CHAT_MAX_LENGTH),
      at: EpochMsSchema,
    })
    .strict(),
  'chat:reaction': z.object({ userId: UserIdSchema, emoji: z.enum(REACTION_EMOJIS) }).strict(),
  'session:recap': RecapSchema,
  error: ErrorPayloadSchema,
} as const;

export type ServerEventName = keyof typeof serverEventSchemas;
export type ServerEventPayload<K extends ServerEventName> = z.infer<(typeof serverEventSchemas)[K]>;

// ---------- Typed Socket.io maps (plain interfaces; no socket.io dependency) ----------
type Handler<K extends ClientEventName> =
  ClientEventPayload<K> extends undefined
    ? (ack: (res: Ack) => void) => void
    : (payload: ClientEventPayload<K>, ack: (res: Ack) => void) => void;

/** Every client->server event takes an ack callback as its last argument. */
export type ClientToServerEvents = { [K in ClientEventName]: Handler<K> };

export type ServerToClientEvents = {
  [K in ServerEventName]: (payload: ServerEventPayload<K>) => void;
};
