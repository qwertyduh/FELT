/**
 * Buy more (P43): what the amount field accepts and how decisions and refusals are worded. The
 * server checks everything again, at the request, at the approval and when the chips are added.
 */
import {
  MAX_CHIPS,
  type ErrorPayload,
  type ServerEventPayload,
  type RoomSettings,
} from '@felt/protocol';
import { parseWholeNumber } from './createRoom';
import { chips, type BuyIn } from './seating';

/** The most a stack may still take. */
export const roomToAdd = ({ maxBuyIn }: RoomSettings, stack: number): number =>
  Math.max(0, Math.min(MAX_CHIPS, (maxBuyIn ?? MAX_CHIPS) - stack));

export function parseTopUp(raw: string, most: number): BuyIn {
  const fail = (message: string): BuyIn => ({ ok: false, message });
  if (raw.trim() === '') return fail('Enter an amount.');
  const amount = parseWholeNumber(raw);
  if (Number.isNaN(amount) || amount < 1) return fail('Use whole numbers, 1 or more.');
  if (amount > most) return fail(`The most you can add is ${chips(most)}.`);
  return { ok: true, amount };
}

export function topUpFailure({ code, message }: ErrorPayload): string {
  switch (code as string) {
    case 'invalid_topup':
      return `The table said no: ${message}.`;
    case 'already_requested':
      return 'You already have a top-up waiting.';
    case 'rate_limited':
      return 'Too many requests. Wait a minute and try again.';
    case 'timeout':
      return 'No answer from the table. Check before asking again.';
    default:
      return "Couldn't send your request. Try again.";
  }
}

export function topUpDecisionLine(d: ServerEventPayload<'player:topup_decision'>): string {
  const amount = chips(d.amount);
  if (d.reason === 'over_max') {
    return `Your ${amount} top-up wasn't added: it would take you over the maximum.`;
  }
  return d.approved
    ? `Top-up approved: ${amount} chips arrive with the next hand.`
    : `The host declined your ${amount} top-up.`;
}
