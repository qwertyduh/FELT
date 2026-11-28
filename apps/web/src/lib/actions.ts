/**
 * Action bar helpers (P40). What is allowed, and between which amounts, comes from the server
 * (`hand.options`, built by the engine); this only suggests sizes inside that range and words the
 * refusals.
 */
import type { ClientEventName, ErrorPayload, GameActPayload, TurnOptions } from '@felt/protocol';

export type RaiseOptions = NonNullable<TurnOptions['raise']>;

export const POT_PRESETS = [
  { label: '½', name: 'Half pot', share: 1 / 2 },
  { label: '⅔', name: 'Two thirds pot', share: 2 / 3 },
  { label: 'Pot', name: 'Pot', share: 1 },
] as const;

/**
 * A pot-sized share as a "raise to" total: call first, then put in `share` of the pot as it then
 * stands. `pot` counts every chip in the middle, this street's bets included.
 */
export function potSized(
  share: number,
  {
    raise,
    pot,
    currentBet,
    call,
  }: { raise: RaiseOptions; pot: number; currentBet: number; call: number },
): number {
  const to = currentBet + Math.round(share * (pot + call));
  return Math.min(raise.max, Math.max(raise.min, to));
}

export type Move =
  { type: 'fold' | 'check' | 'call' | 'all_in' } | { type: 'bet' | 'raise'; amount: number };

/** The chosen size as a move: the top of the range is always sent as all-in. */
export function sizedMove(raise: RaiseOptions, amount: number): Move {
  return amount >= raise.max ? { type: 'all_in' } : { type: raise.type, amount };
}

export const actPayload = (handId: string, turnSeq: number, move: Move): GameActPayload => ({
  handId,
  turnSeq,
  ...move,
});

/** Short enough to share the bar's line with "To call N" on a 320px screen. */
export function actFailure({ code }: ErrorPayload, event: ClientEventName = 'game:act'): string {
  if (event === 'host:dispute' && (code === 'hand_ended' || code === 'stale_hand')) {
    return 'Too late: already paid.';
  }
  if (event === 'hand:show' && ['stale_hand', 'no_hand', 'hand_ended'].includes(code)) {
    return 'Too late to show.';
  }
  if (event === 'host:start' && code === 'not_enough_players') return '2 players must be ready.';
  // Most likely they are back (or the game's timer is on).
  if (event === 'host:force_fold' && code === 'illegal_action') return 'Not folded. Check table.';
  switch (code as string) {
    case 'stale_hand':
    case 'not_your_turn':
    case 'hand_ended':
    case 'no_hand':
    case 'awaiting_host':
      return 'Table moved on. Check it.';
    case 'bet_too_small':
    case 'raise_too_small':
    case 'bet_exceeds_stack':
    case 'invalid_amount':
    case 'illegal_action':
    case 'invalid_winners':
    case 'invalid_cards':
      return "The table didn't allow it.";
    case 'room_paused':
      return 'The game is paused.';
    case 'rate_limited':
      return 'Too fast. Wait a moment.';
    case 'timeout':
      return 'No answer. Check the table.';
    default:
      return 'Not sent. Try again.';
  }
}
