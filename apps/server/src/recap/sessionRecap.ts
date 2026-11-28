/**
 * The two wire forms of `buildRecap`: `session:recap` for the room's players, and the public
 * payload of a shared link. Pure; both are built from the room record alone.
 */
import {
  RecapSchema,
  SharedRecapSchema,
  type Recap,
  type SharedRecap,
  type CreateRecapRequest,
} from '@felt/protocol';
import type { RoomRecord } from '../rooms/roomStore';
import { buildRecap } from './buildRecap';
import { settleUp } from './settleUp';

/** A room ended before `endedAt` was stored: its last chip movement is the closest there is. */
const endedAt = (room: Readonly<RoomRecord>): number =>
  room.endedAt ?? room.ledger.at(-1)?.t ?? room.createdAt;

export function sessionRecap(room: Readonly<RoomRecord>): Recap {
  return RecapSchema.parse({
    code: room.code,
    hostId: room.hostId,
    endedAt: endedAt(room),
    players: buildRecap(room).players,
  });
}

/** Throws a RangeError when the rate makes an amount too large to count exactly. */
export function sharedRecap(
  room: Readonly<RoomRecord>,
  rate: CreateRecapRequest['rate'],
): SharedRecap {
  const { players } = buildRecap(room);
  const index = new Map(players.map((p, i) => [p.userId, i]));
  const at = (userId: string): number => index.get(userId)!;
  let settlement: SharedRecap['settlement'] = null;
  if (rate) {
    const s = settleUp(players, rate);
    settlement = {
      rate,
      amounts: s.amounts.map((a) => a.amount),
      transfers: s.transfers.map((t) => ({ from: at(t.from), to: at(t.to), amount: t.amount })),
      unsettled: s.unsettled.map((u) => ({ player: at(u.userId), amount: u.amount })),
    };
  }
  // Field by field: nothing else of the record can reach the public payload.
  return SharedRecapSchema.parse({
    endedAt: endedAt(room),
    players: players.map((p) => ({
      username: p.username,
      boughtIn: p.boughtIn,
      finalStack: p.finalStack,
      net: p.net,
      adjusted: p.adjusted,
      handsPlayed: p.handsPlayed,
      handsWon: p.handsWon,
      biggestPot: p.biggestPot,
    })),
    settlement,
  });
}
