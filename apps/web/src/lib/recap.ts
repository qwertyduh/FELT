/** Pure helpers for the session recap screens (P54): names, money, the rate and the settle-up. */
import { settleUp, type SettleRate } from '@felt/engine';
import { RATE_MAX, type Recap, type SharedRecap } from '@felt/protocol';

export interface ResultRow {
  name: string;
  you: boolean;
  boughtIn: number;
  finalStack: number;
  net: number;
  adjusted: number;
  handsPlayed: number;
  handsWon: number;
  biggestPot: number;
}

export interface SettlementRows {
  /** Money per row, in hundredths, in row order. */
  amounts: number[];
  transfers: { from: string; to: string; amount: number }[];
  unsettled: { name: string; amount: number }[];
}

export const chips = (n: number): string => n.toLocaleString('en-US');
export const signed = (n: number, text: (abs: number) => string = chips): string =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}${text(Math.abs(n))}`;

/** Hundredths as a plain amount with two decimals: no currency (PRD names none). */
export const money = (minor: number): string => {
  const abs = Math.abs(minor);
  const cents = String(abs % 100).padStart(2, '0');
  return `${minor < 0 ? '−' : ''}${chips(Math.floor(abs / 100))}.${cents}`;
};

/** Leavers of an old room can have no stored name; they are told apart by number. */
export function rowsOf(
  players: SharedRecap['players'] | Recap['players'],
  userId?: string,
): ResultRow[] {
  const unnamed = players.filter((p) => p.username === null).length;
  let n = 0;
  return players.map((p) => ({
    name: p.username ?? (unnamed > 1 ? `Former player ${++n}` : 'Former player'),
    you: userId !== undefined && 'userId' in p && p.userId === userId,
    boughtIn: p.boughtIn,
    finalStack: p.finalStack,
    net: p.net,
    adjusted: p.adjusted,
    handsPlayed: p.handsPlayed,
    handsWon: p.handsWon,
    biggestPot: p.biggestPot,
  }));
}

/** Said plainly whenever winnings and losses differ; null when they match. */
export function imbalanceNotice(rows: readonly ResultRow[]): string | null {
  const net = rows.reduce((sum, r) => sum + r.net, 0);
  if (net === 0) return null;
  const by = `${chips(Math.abs(net))} ${Math.abs(net) === 1 ? 'chip' : 'chips'}`;
  const outcome = `${net > 0 ? 'winnings' : 'losses'} are ${by} more than ${
    net > 0 ? 'losses' : 'winnings'
  }`;
  const adjusted = rows.reduce((sum, r) => sum + r.adjusted, 0);
  return adjusted === net
    ? `Results don't add up to zero. The host's stack corrections ${
        net > 0 ? 'added' : 'removed'
      } ${by}, so ${outcome}.`
    : `Results don't add up to zero: ${outcome}.`;
}

export type RateInput =
  { kind: 'none' } | { kind: 'invalid'; message: string } | { kind: 'ok'; rate: SettleRate };

/** "`chipsText` chips = `amountText`". An empty amount means no rate. */
export function parseRate(chipsText: string, amountText: string): RateInput {
  const amount = amountText.trim().replace(/^(\d*),(\d{0,2})$/, '$1.$2');
  if (amount === '') return { kind: 'none' };
  const count = chipsText.trim().replaceAll(',', '');
  const invalid = (message: string): RateInput => ({ kind: 'invalid', message });
  if (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > RATE_MAX) {
    return invalid(`Chips must be a whole number from 1 to ${chips(RATE_MAX)}.`);
  }
  const parts = /^(\d*)(?:\.(\d{0,2}))?$/.exec(amount);
  const minor = parts ? Number(parts[1] || 0) * 100 + Number((parts[2] ?? '').padEnd(2, '0')) : 0;
  if (!parts || minor < 1 || minor > RATE_MAX) {
    return invalid(`The amount must be from 0.01 to ${money(RATE_MAX)}, with up to 2 decimals.`);
  }
  return { kind: 'ok', rate: { chips: Number(count), minorUnits: minor } };
}

/** Null when the rate makes the amounts too large to count exactly. */
export function settlementOf(recap: Recap, rate: SettleRate): SettlementRows | null {
  const rows = rowsOf(recap.players);
  const names = new Map(recap.players.map((p, i) => [p.userId, rows[i]!.name]));
  try {
    const s = settleUp(recap.players, rate);
    return {
      amounts: s.amounts.map((a) => a.amount),
      transfers: s.transfers.map((t) => ({
        from: names.get(t.from)!,
        to: names.get(t.to)!,
        amount: t.amount,
      })),
      unsettled: s.unsettled.map((u) => ({ name: names.get(u.userId)!, amount: u.amount })),
    };
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

export function sharedSettlement(recap: SharedRecap): SettlementRows | null {
  const s = recap.settlement;
  if (!s) return null;
  const rows = rowsOf(recap.players);
  const name = (i: number) => rows[i]?.name ?? 'Former player';
  return {
    amounts: s.amounts,
    transfers: s.transfers.map((t) => ({ from: name(t.from), to: name(t.to), amount: t.amount })),
    unsettled: s.unsettled.map((u) => ({ name: name(u.player), amount: u.amount })),
  };
}

export const recapUrl = (slug: string): string => `${window.location.origin}/recap/${slug}`;

/** The one page that needs no sign-in. */
export const isPublicPath = (pathname: string): boolean => /^\/recap\/[^/]+\/?$/i.test(pathname);
