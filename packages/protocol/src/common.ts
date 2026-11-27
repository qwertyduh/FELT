import { z } from 'zod';

/** Upper bound for any single chip amount (keeps sums far inside Number.MAX_SAFE_INTEGER). */
export const MAX_CHIPS = 1_000_000_000;

/** Integer chips >= 0. */
export const ChipsSchema = z.number().int().min(0).max(MAX_CHIPS);
/** Integer chips >= 1. */
export const PositiveChipsSchema = z.number().int().min(1).max(MAX_CHIPS);

/**
 * Chips that accumulate at the table (stacks, bets, pots). MAX_CHIPS caps what a client may put in
 * one request, not what a player can win, so these are bounded only by safe integers.
 */
export const TableChipsSchema = z.number().int().min(0);

/** Opaque ids (Supabase uuid, hand ids, request ids, pot ids): bounded non-empty strings. */
export const IdSchema = z.string().min(1).max(64);
export const UserIdSchema = IdSchema;

export const MAX_SEATS = 9;
export const MIN_SEATS = 2;
export const SeatIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_SEATS - 1);

/** Mirrors the engine's Card ("Ah", "Td"). Engine is not imported at runtime; see sync test. */
export const CARD_RANKS = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'T',
  'J',
  'Q',
  'K',
  'A',
] as const;
export const CARD_SUITS = ['c', 'd', 'h', 's'] as const;
export const CardSchema = z
  .string()
  .regex(/^[2-9TJQKA][cdhs]$/)
  .transform((c) => c as `${(typeof CARD_RANKS)[number]}${(typeof CARD_SUITS)[number]}`);
export type CardString = z.infer<typeof CardSchema>;

/** Mirrors the engine's Street. */
export const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown', 'ended'] as const;
export const StreetSchema = z.enum(STREETS);

export const GAME_MODES = ['online', 'hybrid'] as const;
export const GameModeSchema = z.enum(GAME_MODES);

/** Epoch milliseconds (absolute deadlines, never remaining-seconds). */
export const EpochMsSchema = z.number().int().min(0);

/** Bounded record of integer chips keyed by userId (<= table size). */
export const ChipsByUserSchema = z
  .record(UserIdSchema, ChipsSchema)
  .refine((r) => Object.keys(r).length <= MAX_SEATS, { message: 'too many entries' });
