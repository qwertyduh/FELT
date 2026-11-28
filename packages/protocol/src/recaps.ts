/*
 * The session recap (PRD 5.9): `session:recap` for the players of an ended room, and the shared
 * link (`POST /recaps`, `GET /recaps/:slug`).
 */
import { z } from 'zod';
import { EpochMsSchema, TableChipsSchema, UserIdSchema } from './common';
import { RoomCodeSchema } from './rooms';

/**
 * Everyone who played, leavers included, so not bounded by the table size. Each one was admitted by
 * the host by hand; this is only a bound on the payload.
 */
export const RECAP_MAX_PLAYERS = 1000;

/** Chip results. Totals accumulate, so they are bounded only by safe integers. */
const playerShape = {
  /** Null only for a leaver of a room stored before names were kept. */
  username: z.string().min(1).max(20).nullable(),
  boughtIn: TableChipsSchema,
  finalStack: TableChipsSchema,
  net: z.number().int(),
  /** The host's stack corrections, already included in `net`. */
  adjusted: z.number().int(),
  handsPlayed: z.number().int().min(0),
  handsWon: z.number().int().min(0),
  biggestPot: TableChipsSchema,
};

export const RecapPlayerSchema = z.object({ userId: UserIdSchema, ...playerShape }).strict();
export type RecapPlayer = z.infer<typeof RecapPlayerSchema>;

export const RecapSchema = z
  .object({
    code: RoomCodeSchema,
    /** Who may share it. */
    hostId: UserIdSchema,
    endedAt: EpochMsSchema,
    players: z.array(RecapPlayerSchema).max(RECAP_MAX_PLAYERS),
  })
  .strict();
export type Recap = z.infer<typeof RecapSchema>;

// ---------- Settle-up rate ----------
export const RATE_MAX = 1_000_000_000;
const rateSide = z.number().int().min(1).max(RATE_MAX);
/** `chips` chips are worth `minorUnits` hundredths ("1,000 chips = 10.00" is `{1000, 1000}`). */
export const SettleRateSchema = z.object({ chips: rateSide, minorUnits: rateSide }).strict();

// ---------- The shared link ----------
export const RECAP_TTL_DAYS = 7;
/** 128 random bits, base64url. */
export const RecapSlugSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/** The rate is the only number a client supplies: everything else is the server's own record. */
export const CreateRecapRequestSchema = z
  .object({ code: RoomCodeSchema, rate: SettleRateSchema.nullable() })
  .strict();
export type CreateRecapRequest = z.infer<typeof CreateRecapRequestSchema>;

export const CreateRecapResponseSchema = z
  .object({ slug: RecapSlugSchema, expiresAt: EpochMsSchema })
  .strict();
export type CreateRecapResponse = z.infer<typeof CreateRecapResponseSchema>;

/** An index into `players`: the public payload has no user ids. */
const playerIndex = z
  .number()
  .int()
  .min(0)
  .max(RECAP_MAX_PLAYERS - 1);

export const SharedSettlementSchema = z
  .object({
    rate: SettleRateSchema,
    /** Each player's result in hundredths, in `players` order. */
    amounts: z.array(z.number().int()).max(RECAP_MAX_PLAYERS),
    transfers: z
      .array(
        z.object({ from: playerIndex, to: playerIndex, amount: z.number().int().min(1) }).strict(),
      )
      .max(RECAP_MAX_PLAYERS),
    /** What no transfer covers: positive is still owed to them, negative they still owe. */
    unsettled: z
      .array(z.object({ player: playerIndex, amount: z.number().int() }).strict())
      .max(RECAP_MAX_PLAYERS),
  })
  .strict();

/** Public: usernames and numbers only. Nothing that identifies an account or a room. */
export const SharedRecapSchema = z
  .object({
    endedAt: EpochMsSchema,
    players: z.array(z.object(playerShape).strict()).max(RECAP_MAX_PLAYERS),
    /** Null when the host shared without a rate. */
    settlement: SharedSettlementSchema.nullable(),
  })
  .strict();
export type SharedRecap = z.infer<typeof SharedRecapSchema>;

export const SharedRecapResponseSchema = z
  .object({ recap: SharedRecapSchema, expiresAt: EpochMsSchema })
  .strict();
export type SharedRecapResponse = z.infer<typeof SharedRecapResponseSchema>;
