/**
 * Pure seating rules over a RoomRecord (sit, sit out/in, leave). Same contract as admission.ts:
 * no I/O, `now` passed in, inputs never mutated, an unchanged room returned as the same object.
 *
 * Buy-ins: only a player's first buy-in needs no host approval (PRD 4, 5.3), so leaving and sitting
 * down again must not create chips once the game has started. A player who left during the game may
 * only sit back with exactly the stack they left with (not at all if busted). Leaving in the lobby
 * is a refund (nothing was played), so the next buy-in is a fresh one.
 *
 * A player who left busted may take a seat again with 0 chips; chips then come only from a top-up
 * the host approves (topUps.ts, P43).
 *
 * Not handled here: leaving while dealt into a running hand (game.ts).
 */
import type { ErrorCode } from '@felt/protocol';
import type { RoomRecord } from './roomStore';
import { dropTopUps } from './topUps';

type Ledger = RoomRecord['ledger'][number];

/** Note on a `cash_out` made before the game started. */
export const NOTE_REFUND = 'refund';
/** Note on a `buy_in` that brings back the chips of an earlier `cash_out`. */
export const NOTE_RETURN = 'return';

export interface SeatResult {
  room: RoomRecord;
  refused: { code: ErrorCode; message: string } | null;
}

const done = (room: Readonly<RoomRecord>): SeatResult => ({
  room: room as RoomRecord,
  refused: null,
});
const refuse = (room: Readonly<RoomRecord>, code: ErrorCode, message: string): SeatResult => ({
  room: room as RoomRecord,
  refused: { code, message },
});

/** Checks shared by every seat intent. */
function gate(room: Readonly<RoomRecord>, userId: string): SeatResult | null {
  if (!room.admitted.includes(userId)) {
    return refuse(room, 'not_admitted', 'not admitted to this room');
  }
  if (room.status === 'ended') return refuse(room, 'room_ended', 'room has ended');
  return null;
}

/**
 * Chips the user took away mid-game and may bring back, or null for a fresh buy-in. That is every
 * `cash_out` since their last buy-in: chips can follow a leaver after they have gone (game.ts).
 */
function takenAway(room: Readonly<RoomRecord>, userId: string): number | null {
  const mine = room.ledger.filter(
    (e) => e.userId === userId && (e.kind === 'buy_in' || e.kind === 'cash_out'),
  );
  const out = mine.slice(mine.map((e) => e.kind).lastIndexOf('buy_in') + 1);
  const last = out.at(-1);
  if (!last || last.note === NOTE_REFUND) return null;
  return out.reduce((sum, e) => sum + e.amount, 0);
}

export function sit(
  room: Readonly<RoomRecord>,
  who: { userId: string; username: string },
  want: { seat: number; buyIn: number },
  now: number,
): SeatResult {
  const gated = gate(room, who.userId);
  if (gated) return gated;
  if (room.removals?.includes(who.userId)) {
    return refuse(room, 'forbidden', 'the host is removing you');
  }
  if (room.ending) return refuse(room, 'illegal_action', 'the game ends after this hand');
  const { maxSeats, minBuyIn, maxBuyIn } = room.settings;
  if (room.seats.some((s) => s.userId === who.userId)) {
    return refuse(room, 'already_seated', 'you already have a seat');
  }
  if (want.seat >= maxSeats) return refuse(room, 'invalid_payload', 'no such seat');
  if (room.seats.length >= maxSeats) return refuse(room, 'room_full', 'the table is full');
  if (room.seats.some((s) => s.seat === want.seat)) {
    return refuse(room, 'seat_taken', 'that seat is taken');
  }
  const back = takenAway(room, who.userId);
  if (back === 0 && want.buyIn !== 0) {
    return refuse(
      room,
      'forbidden',
      'you left with no chips; sit down with 0 and ask for a top-up',
    );
  }
  if (back !== null) {
    if (want.buyIn !== back) {
      return refuse(room, 'invalid_buy_in', `sit back down with the ${back} chips you left with`);
    }
  } else if (want.buyIn < minBuyIn || (maxBuyIn !== null && want.buyIn > maxBuyIn)) {
    const range = maxBuyIn === null ? `at least ${minBuyIn}` : `${minBuyIn} to ${maxBuyIn}`;
    return refuse(room, 'invalid_buy_in', `buy-in must be ${range}`);
  }
  const entry: Ledger = {
    t: now,
    userId: who.userId,
    kind: 'buy_in',
    amount: want.buyIn,
    ...(back === null ? {} : { note: NOTE_RETURN }),
  };
  const seat = {
    seat: want.seat,
    userId: who.userId,
    username: who.username,
    stack: want.buyIn,
    sittingOut: false,
  };
  return done({
    ...room,
    names: { ...room.names, [who.userId]: who.username },
    seats: [...room.seats, seat],
    ledger: [...room.ledger, entry],
  });
}

export function setSittingOut(
  room: Readonly<RoomRecord>,
  userId: string,
  sittingOut: boolean,
): SeatResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  const mine = room.seats.find((s) => s.userId === userId);
  if (!mine) return refuse(room, 'not_seated', 'you are not seated');
  if (mine.sittingOut === sittingOut) return done(room);
  // A leaving seat is already sitting out; it cannot be brought back.
  if (mine.leaving) return refuse(room, 'forbidden', 'you are leaving the table');
  // Choosing either way is a sign of life: the run of timeouts starts again.
  const { timeouts, sitOutReason, ...seat } = mine;
  void timeouts;
  void sitOutReason;
  return done({
    ...room,
    seats: room.seats.map((s) => (s === mine ? { ...seat, sittingOut } : s)),
  });
}

/** Frees the seat; the stack leaves the table on the ledger. Admission is unaffected. */
export function leaveSeat(room: Readonly<RoomRecord>, userId: string, now: number): SeatResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  if (!room.seats.some((s) => s.userId === userId)) {
    return refuse(room, 'not_seated', 'you are not seated');
  }
  return done(vacate(room, userId, now));
}

/**
 * `leaveSeat` without the checks on who asks: also for a seat whose player is no longer admitted
 * (removed while their cards were still live, P44) and for the end of the game. A user with no
 * seat changes nothing.
 */
export function vacate(room: Readonly<RoomRecord>, userId: string, now: number): RoomRecord {
  const mine = room.seats.find((s) => s.userId === userId);
  if (!mine) return room as RoomRecord;
  const entry: Ledger = {
    t: now,
    userId,
    kind: 'cash_out',
    amount: mine.stack,
    ...(room.status === 'lobby' ? { note: NOTE_REFUND } : {}),
  };
  const left = dropTopUps(room, userId);
  return {
    ...left,
    seats: left.seats.filter((s) => s !== mine),
    ledger: [...left.ledger, entry],
  };
}
