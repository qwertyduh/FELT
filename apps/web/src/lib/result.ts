/**
 * An ended online hand in words (P50), from `hand.outcome`. Read-only: who won what is the
 * server's; nothing here compares hands.
 */
import type { HandOutcome } from '@felt/protocol';
import { shortChips } from './seating';
import { potName } from './table';

export interface PotLine {
  potId: string;
  /** "Main", "Side 1"; null when there is only one pot. */
  pot: string | null;
  /** "You win 600", "ana and bea split 600". */
  headline: string;
  /** The winning hand, each share of an uneven or shared pot, or why there is no hand. */
  detail: string[];
}

const money = (n: number) => shortChips(n, 10_000_000);

const list = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export function potLines(
  outcome: HandOutcome,
  userId: string,
  nameOf: (userId: string) => string,
): PotLine[] {
  const name = (id: string) => (id === userId ? 'You' : nameOf(id));
  /** Nobody had to show: everyone else folded. */
  const foldedOut = outcome.runoutFrom === null && outcome.awards.every((a) => !a.contested);
  return outcome.awards.map((award, i) => {
    const { winners, amounts } = award;
    const shares = winners.map((id) => amounts[id] ?? 0);
    const total = shares.reduce((sum, n) => sum + n, 0);
    // "You" reads first.
    const order = [...winners].sort((a, b) => Number(b === userId) - Number(a === userId));
    const split = winners.length > 1;
    const verb = split ? 'split' : winners[0] === userId ? 'win' : 'wins';
    const detail: string[] = [];
    if (split) {
      detail.push(
        shares.every((n) => n === shares[0])
          ? `${money(shares[0]!)} each`
          : order.map((id) => `${name(id)} ${money(amounts[id] ?? 0)}`).join(', '),
      );
    }
    const hands = [...new Set(winners.flatMap((id) => award.handNames[id] ?? []))];
    if (hands.length) detail.push(hands.join(', '));
    else if (foldedOut) detail.push('Everyone else folded');
    return {
      potId: award.potId,
      pot: outcome.awards.length > 1 ? potName(i, outcome.awards.length) : null,
      headline: `${list(order.map(name))} ${verb} ${money(total)}`,
      detail,
    };
  });
}

/** Chips each player won from all the pots together. */
export function winnings(outcome: HandOutcome): Map<string, number> {
  const won = new Map<string, number>();
  for (const { amounts } of outcome.awards) {
    for (const [userId, amount] of Object.entries(amounts)) {
      if (amount > 0) won.set(userId, (won.get(userId) ?? 0) + amount);
    }
  }
  return won;
}
