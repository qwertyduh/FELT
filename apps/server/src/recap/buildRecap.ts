/**
 * Pure session recap (P52, PRD 5.9) from what the room record already stores. No I/O, no clocks,
 * inputs are not mutated. Meant for an ended room: a game the host ends during a hand only ends
 * once that hand has been played out, so every dealt hand is finished and counted.
 *
 * Reading the ledger:
 * - bought in = `buy_in` + `top_up`, except that a `buy_in` noted `return` brings back chips the
 *   player had cashed out (not new money), and a `cash_out` noted `refund` (left in the lobby)
 *   cancels a buy-in.
 * - final stack = the seat's stack, plus every other `cash_out`, less the `return`s.
 * - net = final stack - bought in.
 * - `hand_result`: one line per player dealt into a finished hand; `amount` is the chips the pots
 *   paid them (0 if none). An uncalled bet handed back is not paid by a pot, so it is not a win.
 *
 * Host stack adjustments are part of the final stack, so part of net. Chips are otherwise
 * conserved, so the nets sum to `adjustmentTotal`, which need not be zero: nothing here spreads or
 * hides the difference. `unaccounted` is what neither explains; it is 0 unless the room still has
 * chips in a pot or the record is wrong.
 */
import { NOTE_REFUND, NOTE_RETURN } from '../rooms/seating';
import type { RoomRecord } from '../rooms/roomStore';

/** A `RoomRecord` fits as it is. */
export type RecapInput = Pick<RoomRecord, 'ledger' | 'seats'> &
  Partial<Pick<RoomRecord, 'names' | 'hostId' | 'hostUsername'>>;

export interface RecapPlayer {
  userId: string;
  /** Null only for a room stored before names were kept, for a player who has left. */
  username: string | null;
  boughtIn: number;
  finalStack: number;
  net: number;
  /** Signed sum of the host's corrections to this player; already included in `net`. */
  adjusted: number;
  handsPlayed: number;
  /** Hands in which a pot paid them anything, split and side pots included. */
  handsWon: number;
  /** The most the pots paid them in one hand; 0 if they never won. */
  biggestPot: number;
}

export interface Recap {
  /** Highest net first. */
  players: RecapPlayer[];
  totalBoughtIn: number;
  totalNet: number;
  adjustmentTotal: number;
  /** `totalNet - adjustmentTotal`. */
  unaccounted: number;
}

type Tally = Omit<RecapPlayer, 'userId' | 'username' | 'net'>;

const emptyTally = (): Tally => ({
  boughtIn: 0,
  finalStack: 0,
  adjusted: 0,
  handsPlayed: 0,
  handsWon: 0,
  biggestPot: 0,
});

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildRecap(room: Readonly<RecapInput>): Recap {
  const tallies = new Map<string, Tally>();
  const of = (userId: string): Tally => {
    let t = tallies.get(userId);
    if (!t) tallies.set(userId, (t = emptyTally()));
    return t;
  };

  for (const { userId, kind, amount, note } of room.ledger) {
    const t = of(userId);
    switch (kind) {
      case 'buy_in':
        if (note === NOTE_RETURN) t.finalStack -= amount;
        else t.boughtIn += amount;
        break;
      case 'top_up':
        t.boughtIn += amount;
        break;
      case 'cash_out':
        if (note === NOTE_REFUND) t.boughtIn -= amount;
        else t.finalStack += amount;
        break;
      case 'adjust':
        t.adjusted += amount;
        break;
      case 'hand_result':
        t.handsPlayed += 1;
        if (amount > 0) t.handsWon += 1;
        t.biggestPot = Math.max(t.biggestPot, amount);
        break;
      default:
        // A new ledger kind must be counted here: this stops the build until it is.
        kind satisfies never;
    }
  }
  for (const seat of room.seats) of(seat.userId).finalStack += seat.stack;

  const nameOf = (userId: string): string | null =>
    room.seats.find((s) => s.userId === userId)?.username ??
    room.names?.[userId] ??
    (userId === room.hostId ? (room.hostUsername ?? null) : null);

  const players: RecapPlayer[] = [...tallies]
    // Sat down and left again before the game started: they took no part.
    .filter(([, t]) => t.boughtIn || t.finalStack || t.adjusted || t.handsPlayed)
    .map(([userId, t]) => ({
      userId,
      username: nameOf(userId),
      ...t,
      net: t.finalStack - t.boughtIn,
    }))
    .sort((a, b) => b.net - a.net || byId(a.userId, b.userId));

  const sum = (pick: (p: RecapPlayer) => number): number =>
    players.reduce((total, p) => total + pick(p), 0);
  const totalNet = sum((p) => p.net);
  const adjustmentTotal = sum((p) => p.adjusted);
  return {
    players,
    totalBoughtIn: sum((p) => p.boughtIn),
    totalNet,
    adjustmentTotal,
    unaccounted: totalNet - adjustmentTotal,
  };
}
