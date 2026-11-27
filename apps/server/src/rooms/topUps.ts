/**
 * Pure top-up rules over a RoomRecord (P43, PRD 5.3). Same contract as seating.ts: no I/O, ids
 * are passed in, inputs are never mutated, an unchanged room is returned as the same object.
 *
 * A seated player asks, the host answers, and an approved amount waits in `pendingTopUps` until a
 * hand is dealt (`applyTopUps`, in the same commit as the deal). Chips exist only from that moment:
 * that is when the `top_up` ledger line is written, once, and the entry leaves the queue. A request
 * or a queued amount that is dropped (declined, over the maximum, the player left) has no chips and
 * no ledger line.
 */
import { MAX_CHIPS, type ErrorCode } from '@felt/protocol';
import type { RoomRecord, TopUp } from './roomStore';

export interface TopUpResult {
  room: RoomRecord;
  refused: { code: ErrorCode; message: string } | null;
  /** The request just answered. */
  request?: TopUp;
}

const refuse = (room: Readonly<RoomRecord>, code: ErrorCode, message: string): TopUpResult => ({
  room: room as RoomRecord,
  refused: { code, message },
});

/** The highest stack a top-up may reach. Without a maximum, the usual cap on chip amounts. */
const limit = (room: Readonly<RoomRecord>): number => room.settings.maxBuyIn ?? MAX_CHIPS;

const overLimit = (room: Readonly<RoomRecord>, stack: number): TopUpResult => {
  const { maxBuyIn } = room.settings;
  const more = Math.max(0, limit(room) - stack);
  const what = maxBuyIn === null ? 'the chip limit' : `the ${maxBuyIn} maximum`;
  return refuse(room, 'invalid_topup', `that would go over ${what}; the most to add is ${more}`);
};

function gate(room: Readonly<RoomRecord>, userId: string): TopUpResult | null {
  if (!room.admitted.includes(userId)) {
    return refuse(room, 'not_admitted', 'not admitted to this room');
  }
  if (room.status === 'ended') return refuse(room, 'room_ended', 'room has ended');
  return null;
}

/** `player:topup_request`. */
export function requestTopUp(
  room: Readonly<RoomRecord>,
  userId: string,
  amount: number,
  requestId: string,
): TopUpResult {
  const gated = gate(room, userId);
  if (gated) return gated;
  const seat = room.seats.find((s) => s.userId === userId);
  if (!seat) return refuse(room, 'not_seated', 'you are not seated');
  if (seat.leaving) return refuse(room, 'forbidden', 'you are leaving the table');
  if (room.topUpRequests?.some((r) => r.userId === userId)) {
    return refuse(room, 'already_requested', 'a top-up request is already waiting for the host');
  }
  if (room.pendingTopUps?.some((r) => r.userId === userId)) {
    return refuse(room, 'already_requested', 'an approved top-up is waiting for the next hand');
  }
  if (seat.stack + amount > limit(room)) return overLimit(room, seat.stack);
  const request: TopUp = { requestId, userId, amount };
  return {
    room: { ...room, topUpRequests: [...(room.topUpRequests ?? []), request] },
    refused: null,
  };
}

/**
 * `host:topup`. The answer names a request, and a request has one fixed amount, so it cannot land
 * on a different one; answering twice finds nothing the second time. An approval that no longer
 * fits under the maximum is refused and the request stays, for the host to decline.
 */
export function decideTopUp(
  room: Readonly<RoomRecord>,
  actorId: string,
  requestId: string,
  approve: boolean,
): TopUpResult {
  const gated = gate(room, actorId);
  if (gated) return gated;
  if (room.hostId !== actorId) return refuse(room, 'not_host', 'only the host can do that');
  const request = room.topUpRequests?.find((r) => r.requestId === requestId);
  if (!request) return refuse(room, 'request_expired', 'request is no longer pending');
  const topUpRequests = room.topUpRequests!.filter((r) => r !== request);
  if (!approve) return { room: { ...room, topUpRequests }, refused: null, request };
  const seat = room.seats.find((s) => s.userId === request.userId);
  // Leaving drops the request, so this only guards against a record that disagrees.
  if (!seat || seat.leaving) {
    return refuse(room, 'request_expired', 'that player is no longer at the table');
  }
  if (seat.stack + request.amount > limit(room)) return overLimit(room, seat.stack);
  return {
    room: { ...room, topUpRequests, pendingTopUps: [...(room.pendingTopUps ?? []), request] },
    refused: null,
    request,
  };
}

/**
 * Add every queued top-up to its seat, for a hand about to be dealt. The maximum is checked again:
 * the stack may have grown since the approval, and then the whole amount is dropped (never a
 * different amount from the one asked for and approved).
 */
export function applyTopUps(room: Readonly<RoomRecord>, now: number): RoomRecord {
  if (!room.pendingTopUps?.length) return room as RoomRecord;
  let seats = room.seats;
  const lines: RoomRecord['ledger'] = [];
  for (const { requestId, userId, amount } of room.pendingTopUps) {
    const seat = seats.find((s) => s.userId === userId);
    if (!seat || seat.leaving || seat.stack + amount > limit(room)) continue;
    seats = seats.map((s) => (s === seat ? { ...s, stack: s.stack + amount } : s));
    lines.push({ t: now, userId, kind: 'top_up', amount, note: requestId });
  }
  return { ...room, seats, pendingTopUps: [], ledger: [...room.ledger, ...lines] };
}

/** The user is leaving the table: nothing waiting for them survives it. */
export function dropTopUps(room: Readonly<RoomRecord>, userId: string): RoomRecord {
  const mine = (r: TopUp) => r.userId === userId;
  if (!room.topUpRequests?.some(mine) && !room.pendingTopUps?.some(mine)) {
    return room as RoomRecord;
  }
  return {
    ...room,
    topUpRequests: (room.topUpRequests ?? []).filter((r) => !mine(r)),
    pendingTopUps: (room.pendingTopUps ?? []).filter((r) => !mine(r)),
  };
}
