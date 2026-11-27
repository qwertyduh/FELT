/**
 * Stored shape of the running hand (`room.game`). It lives inside the room record so the hand,
 * the stacks and the ledger are always saved in one atomic write. The engine state holds the deck
 * and hole cards in online mode: it reaches clients only through `toPublicState`'s allow-list.
 * Strict objects: a field the engine gains but this misses fails the commit instead of being
 * silently dropped on rehydrate.
 */
import type { HandState } from '@felt/engine';
import { CardSchema, STREETS } from '@felt/protocol';
import { z } from 'zod';

const Id = z.string().min(1).max(64);
const Chips = z.number().int().min(0);
const Seat = z.number().int().min(0).max(8);
const Card = z.string().regex(/^[2-9TJQKA][cdhs]$/);

const PotAward = z.strictObject({
  potId: Id,
  winners: z.array(Id),
  amounts: z.record(Id, Chips),
  contested: z.boolean(),
  handNames: z.record(Id, z.string()),
});

const HandStateShape = z.strictObject({
  mode: z.enum(['online', 'hybrid']),
  street: z.enum(STREETS),
  board: z.array(CardSchema).max(5),
  players: z.array(
    z.strictObject({
      playerId: Id,
      seat: Seat,
      stack: Chips,
      bet: Chips,
      committed: Chips,
      status: z.enum(['active', 'folded', 'all_in']),
      hasActed: z.boolean(),
      facedBet: Chips,
      hole: z.tuple([Card, Card]).nullable(),
    }),
  ),
  button: Seat,
  smallBlindSeat: Seat,
  bigBlindSeat: Seat,
  smallBlind: Chips,
  bigBlind: Chips,
  currentBet: Chips,
  lastFullRaise: Chips,
  currentActor: Seat.nullable(),
  pots: z.array(z.strictObject({ id: Id, amount: Chips, eligible: z.array(Id) })),
  deck: z.array(Card).nullable(),
  awardedPotIds: z.array(Id),
  pendingAwards: z.array(PotAward).optional(),
  result: z
    .strictObject({
      awards: z.array(PotAward),
      stacks: z.record(Id, Chips),
      showdown: z.array(
        z.strictObject({
          playerId: Id,
          hole: z.tuple([Card, Card]),
          handName: z.string(),
          category: z.number().int(),
        }),
      ),
    })
    .nullable(),
});

/** `custom`: validate only, and keep the engine's own type. */
const EngineHandSchema = z.custom<HandState>((v) => HandStateShape.safeParse(v).success);

/** Hybrid: the host's proposed result, waiting out the dispute window. */
export const ProposalSchema = z.strictObject({
  awards: z.array(z.strictObject({ potId: Id, winners: z.array(Id).min(1) })).min(1),
  /** Absolute epoch ms. */
  confirmAt: z.number().int(),
  disputed: z.boolean(),
});

export const GameSchema = z.strictObject({
  /** Button seat of the current or last hand; drives rotation. */
  button: Seat.nullable(),
  /** The running hand, or the one just ended while the next is pending. */
  hand: z
    .strictObject({
      handId: Id,
      /** Bumped on every engine step (P40). Absent on hands stored before it existed: 0. */
      turnSeq: z.number().int().min(0).optional(),
      state: EngineHandSchema,
      /** Dealt-in players who gave up their seat during this hand. */
      departed: z.array(Id),
      proposal: ProposalSchema.nullable(),
    })
    .nullable(),
  /** Absolute epoch ms at which the next hand is dealt; null when none is scheduled. */
  nextHandAt: z.number().int().nullable(),
});
export type Game = z.infer<typeof GameSchema>;
export type GameHand = NonNullable<Game['hand']>;
