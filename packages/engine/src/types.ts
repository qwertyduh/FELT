/**
 * Engine type foundation (P14). Types only: no logic lives here.
 * Everything is plain JSON-serialisable data (no classes, Maps or Dates) so
 * state can be snapshotted to Redis and sent through the protocol package.
 */

// ---------- Cards ----------
export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['c', 'd', 'h', 's'] as const;
export type Rank = (typeof RANKS)[number];
export type Suit = (typeof SUITS)[number];
/** Two-char string such as "Ah" or "Td". */
export type Card = `${Rank}${Suit}`;

// ---------- Table (between hands) ----------
export type GameMode = 'online' | 'hybrid';

export interface SeatState {
  /** Stable player id (user id). */
  playerId: string;
  /** Integer chips behind. */
  stack: number;
  /** Sitting out: skipped for blinds/dealing but keeps the seat. */
  sittingOut: boolean;
}

export interface TableState {
  mode: GameMode;
  /** Index = seat number; null = empty seat. */
  seats: readonly (SeatState | null)[];
  /** Seat index that held the button last hand; null before the first hand. */
  button: number | null;
  smallBlind: number;
  bigBlind: number;
}

// ---------- Hand ----------
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown' | 'ended';

export type PlayerStatus = 'active' | 'folded' | 'all_in';

export interface HandPlayer {
  playerId: string;
  seat: number;
  /** Chips behind (excludes chips already committed). */
  stack: number;
  /** Chips put in on the current street. */
  bet: number;
  /** Chips put in over the whole hand (drives side pots). */
  committed: number;
  status: PlayerStatus;
  /** True once the player has acted since the last full raise (round-closing check). */
  hasActed: boolean;
  /** Null in hybrid mode (no cards) or before dealing. */
  hole: readonly [Card, Card] | null;
}

export interface Pot {
  /** Stable within a hand: "pot-0" is the main pot, then side pots in order. */
  id: string;
  amount: number;
  /** playerIds still eligible to win this pot (not folded). */
  eligible: readonly string[];
}

export interface HandState {
  mode: GameMode;
  street: Street;
  /** Community cards dealt so far (empty in hybrid unless host enters them). */
  board: readonly Card[];
  /** Players dealt into the hand, in seat order. */
  players: readonly HandPlayer[];
  button: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  smallBlind: number;
  bigBlind: number;
  /** Highest street bet to match this street. */
  currentBet: number;
  /** Size of the last FULL raise this street (min-raise increment); starts at bigBlind. */
  lastFullRaise: number;
  /** Seat to act, or null when no one can act (between streets, all-in runout, ended). */
  currentActor: number | null;
  /** Pots collected from completed streets. Chips still in `bet` are not yet in a pot. */
  pots: readonly Pot[];
  /** Remaining undealt cards (online); null in hybrid. */
  deck: readonly Card[] | null;
  /** Hybrid: pots the host has awarded so far. */
  awardedPotIds: readonly string[];
  /** Final stack per playerId once the hand has ended; null while running. */
  result: HandResult | null;
}

export interface PotAward {
  potId: string;
  winners: readonly string[];
  /** Chips won per winner (odd chips already distributed). */
  amounts: Readonly<Record<string, number>>;
}

export interface HandResult {
  awards: readonly PotAward[];
  /** Final stacks by playerId, to write back to the table. */
  stacks: Readonly<Record<string, number>>;
}

// ---------- Actions ----------
/** `amount` for bet/raise is the TOTAL street bet to reach ("raise to"), an integer. */
export type PlayerAction =
  | { type: 'fold'; playerId: string }
  | { type: 'check'; playerId: string }
  | { type: 'call'; playerId: string }
  | { type: 'bet'; playerId: string; amount: number }
  | { type: 'raise'; playerId: string; amount: number }
  | { type: 'all_in'; playerId: string };

export type HostAction =
  /** Hybrid: move to the next street; `cards` optionally records the real board cards. */
  | { type: 'advance_street'; cards?: readonly Card[] }
  /** Hybrid: award one pot to one or more winners (splits allowed). */
  | { type: 'award_pot'; potId: string; winners: readonly string[] };

export type EngineAction = PlayerAction | HostAction;

// ---------- Events ----------
export type EngineEvent =
  | { type: 'hand_started'; button: number; smallBlindSeat: number; bigBlindSeat: number }
  | { type: 'blind_posted'; playerId: string; amount: number; blind: 'small' | 'big' }
  | { type: 'hole_cards_dealt'; playerIds: readonly string[] }
  | {
      type: 'player_acted';
      playerId: string;
      action: PlayerAction['type'];
      /** Chips moved into the pot by this action. */
      amount: number;
    }
  | { type: 'street_advanced'; street: Street; board: readonly Card[] }
  | { type: 'pots_updated'; pots: readonly Pot[] }
  | {
      type: 'pot_awarded';
      potId: string;
      winners: readonly string[];
      amounts: Readonly<Record<string, number>>;
    }
  | { type: 'hand_ended'; result: HandResult };

// ---------- Errors & Result ----------
export type EngineErrorCode =
  | 'invalid_state'
  | 'hand_ended'
  | 'not_enough_players'
  | 'not_your_turn'
  | 'unknown_player'
  | 'illegal_action'
  | 'cannot_check'
  | 'nothing_to_call'
  | 'bet_too_small'
  | 'raise_too_small'
  | 'bet_exceeds_stack'
  | 'wrong_mode'
  | 'invalid_amount'
  | 'invalid_cards'
  | 'unknown_pot'
  | 'invalid_winners'
  | 'pot_already_awarded';

export interface EngineError {
  code: EngineErrorCode;
  message: string;
}

export type Result<T, E = EngineError> = { ok: true; value: T } | { ok: false; error: E };

/** Output of a state transition. */
export interface Transition {
  state: HandState;
  events: readonly EngineEvent[];
}
