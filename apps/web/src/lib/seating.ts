/**
 * Waiting-room logic (P38): what the buy-in field accepts and what to say when the table refuses a
 * `room:sit` or `host:start`. The server stays the authority on both.
 */
import { MAX_CHIPS, type ErrorPayload, type RoomSettings } from '@felt/protocol';
import { parseWholeNumber } from './createRoom';

export const chips = (n: number) => n.toLocaleString('en-US');

export function buyInRange({ minBuyIn, maxBuyIn }: RoomSettings): string {
  return maxBuyIn === null
    ? `${chips(minBuyIn)} or more`
    : `${chips(minBuyIn)} to ${chips(maxBuyIn)}`;
}

export type BuyIn = { ok: true; amount: number } | { ok: false; message: string };

export function parseBuyIn(raw: string, { minBuyIn, maxBuyIn }: RoomSettings): BuyIn {
  const fail = (message: string): BuyIn => ({ ok: false, message });
  if (raw.trim() === '') return fail('Enter an amount.');
  const amount = parseWholeNumber(raw);
  if (Number.isNaN(amount)) return fail('Use whole numbers only.');
  if (amount < minBuyIn) return fail(`The minimum is ${chips(minBuyIn)}.`);
  if (maxBuyIn !== null && amount > maxBuyIn) return fail(`The maximum is ${chips(maxBuyIn)}.`);
  if (amount > MAX_CHIPS) return fail(`Can't be more than ${chips(MAX_CHIPS)}.`);
  return { ok: true, amount };
}

/**
 * Someone who left mid-game may only sit back with the chips they left with, or not at all if they
 * had none (server: rooms/seating.ts). The room state does not carry that amount, so it is read
 * from the refusal; if the wording ever changes, the server's message is shown as it is.
 */
export type Returning = { kind: 'exact'; amount: number } | { kind: 'busted' };

export function returningFrom({ code, message }: ErrorPayload): Returning | null {
  const exact =
    code === 'invalid_buy_in' ? /^sit back down with the (\d+) chips/.exec(message) : null;
  if (exact) return { kind: 'exact', amount: Number(exact[1]) };
  if (code === 'forbidden' && message.startsWith('you left with no chips')) {
    return { kind: 'busted' };
  }
  return null;
}

const NO_ANSWER = 'No answer from the table. Check the seats before trying again.';
const TOO_MANY = 'Too many tries. Wait a moment and try again.';

export function sitFailure({ code, message }: ErrorPayload): string {
  switch (code as string) {
    case 'seat_taken':
      return 'That seat was just taken. Pick another.';
    case 'room_full':
      return 'The table is full.';
    case 'already_seated':
      return 'You already have a seat.';
    case 'invalid_buy_in':
      return `The table said no: ${message}.`;
    case 'rate_limited':
      return TOO_MANY;
    case 'timeout':
      return NO_ANSWER;
    default:
      return "Couldn't sit you down. Try again.";
  }
}

export function startFailure({ code }: ErrorPayload): string {
  switch (code as string) {
    case 'not_enough_players':
      return 'Two players with chips, not sitting out, are needed to start.';
    case 'illegal_action':
      return 'The game is already running.';
    case 'wrong_mode':
      return "Online games can't start yet.";
    case 'rate_limited':
      return TOO_MANY;
    case 'timeout':
      return 'No answer from the table. Try again.';
    default:
      return "Couldn't start the game. Try again.";
  }
}
