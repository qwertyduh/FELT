/**
 * Pure settle-up (P53, PRD 5.9): nets in chips become money at the host's rate, then a "who pays
 * whom" list. Money is integer minor units (cents, paise); FELT never moves any.
 *
 * Rounding (largest remainder): each amount is its exact value rounded down or up, so less than
 * one minor unit off, and together they come to the exact total rounded (halves up). Nets that sum
 * to zero therefore give amounts that sum to zero, and a zero net stays zero.
 *
 * Transfers: when the amounts sum to zero, the fewest possible, found by splitting the players
 * into as many groups that cancel out as can be (a group of k needs k - 1 payments). Above
 * `MAX_EXACT_PLAYERS` with money to move it only matches largest with largest, which needs at most
 * one payment fewer than there are players. The result does not depend on the order of the input.
 *
 * Nets need not sum to zero (host adjustments, see buildRecap). Everything that can be matched is,
 * and the rest is listed in `unsettled` instead of being shared out. The number of payments is
 * then not necessarily the fewest, and who is left short follows from the matching, not from any
 * rule of poker, so show it to the players.
 */

/** `chips` chips are worth `minorUnits` minor units: "1,000 chips = $10" is `{1000, 1000}`. */
export interface SettleRate {
  chips: number;
  minorUnits: number;
}

export interface ChipNet {
  userId: string;
  net: number;
}

export interface Amount {
  userId: string;
  /** Signed minor units: positive is to receive, negative is to pay. */
  amount: number;
}

export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

export interface Settlement {
  /** Each player's result in money, in the order given. */
  amounts: Amount[];
  transfers: Transfer[];
  /** What no transfer covers (same sign as `amounts`); empty when the nets sum to zero. */
  unsettled: Amount[];
  /** Sum of `amounts`, which is also the sum of `unsettled`. */
  imbalance: number;
}

export const MAX_EXACT_PLAYERS = 16;

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function safe(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError('amount is too large');
  return n;
}

/** Floor division for a positive divisor. */
const floorDiv = (a: bigint, b: bigint): bigint => a / b - (a % b < 0n ? 1n : 0n);

export function toMoney(nets: readonly ChipNet[], rate: SettleRate): Amount[] {
  for (const value of [rate.chips, rate.minorUnits]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError('the rate must be positive whole numbers');
    }
  }
  if (new Set(nets.map((n) => n.userId)).size !== nets.length) {
    throw new RangeError('each player may appear once');
  }
  const per = BigInt(rate.chips);
  const worth = BigInt(rate.minorUnits);
  let total = 0n;
  let floors = 0n;
  const parts = nets.map(({ userId, net }) => {
    if (!Number.isSafeInteger(net)) throw new RangeError('nets must be whole chips');
    const exact = BigInt(net) * worth;
    const floor = floorDiv(exact, per);
    total += exact;
    floors += floor;
    return { userId, floor, rest: exact - floor * per };
  });
  const target = floorDiv(2n * total + per, 2n * per);
  const up = new Set(
    [...parts]
      .sort((a, b) => (a.rest === b.rest ? byId(a.userId, b.userId) : a.rest > b.rest ? -1 : 1))
      .slice(0, safe(target - floors))
      .map((p) => p.userId),
  );
  return parts.map((p) => ({
    userId: p.userId,
    amount: safe(p.floor + (up.has(p.userId) ? 1n : 0n)),
  }));
}

/**
 * Split into as many zero-sum groups as possible; whatever cannot cancel out (only when the whole
 * does not sum to zero) is one more group.
 */
function groups(open: readonly Amount[]): Amount[][] {
  const n = open.length;
  if (n === 0) return [];
  if (n > MAX_EXACT_PLAYERS) return [[...open]];
  const size = 1 << n;
  const sum = new Array<number>(size).fill(0);
  /** Most zero-sum prefixes of any ordering of the players in `mask`. */
  const best = new Array<number>(size).fill(0);
  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask;
    sum[mask] = sum[mask ^ low]! + open[31 - Math.clz32(low)]!.amount;
    let most = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) most = Math.max(most, best[mask ^ (1 << i)]!);
    }
    best[mask] = most + (sum[mask] === 0 ? 1 : 0);
  }
  const found: Amount[][] = [];
  let group: Amount[] = [];
  for (let mask = size - 1; mask > 0;) {
    const want = best[mask]! - (sum[mask] === 0 ? 1 : 0);
    let i = 0;
    while (!(mask & (1 << i)) || best[mask ^ (1 << i)] !== want) i++;
    group.push(open[i]!);
    mask ^= 1 << i;
    if (sum[mask] === 0) {
      found.push(group);
      group = [];
    }
  }
  return found;
}

/** Largest debtor pays largest creditor until one side of the group is done. */
function match(group: readonly Amount[], transfers: Transfer[], unsettled: Amount[]): void {
  const side = (sign: 1 | -1) =>
    group
      .filter((a) => Math.sign(a.amount) === sign)
      .map((a) => ({ userId: a.userId, left: Math.abs(a.amount) }))
      .sort((a, b) => b.left - a.left);
  const payers = side(-1);
  const payees = side(1);
  let i = 0;
  let j = 0;
  while (i < payers.length && j < payees.length) {
    const from = payers[i]!;
    const to = payees[j]!;
    const amount = Math.min(from.left, to.left);
    transfers.push({ from: from.userId, to: to.userId, amount });
    from.left -= amount;
    to.left -= amount;
    if (from.left === 0) i++;
    if (to.left === 0) j++;
  }
  for (const p of payers.slice(i)) unsettled.push({ userId: p.userId, amount: -p.left });
  for (const p of payees.slice(j)) unsettled.push({ userId: p.userId, amount: p.left });
}

/** A `Recap`'s `players` can be passed as `nets`. */
export function settleUp(nets: readonly ChipNet[], rate: SettleRate): Settlement {
  const amounts = toMoney(nets, rate);
  const open = amounts.filter((a) => a.amount !== 0).sort((a, b) => byId(a.userId, b.userId));
  // Keeps every partial sum below exact.
  safe(open.reduce((total, a) => total + BigInt(Math.abs(a.amount)), 0n));
  const transfers: Transfer[] = [];
  const unsettled: Amount[] = [];
  for (const group of groups(open)) match(group, transfers, unsettled);
  return {
    amounts,
    transfers,
    unsettled,
    imbalance: amounts.reduce((total, a) => total + a.amount, 0),
  };
}
