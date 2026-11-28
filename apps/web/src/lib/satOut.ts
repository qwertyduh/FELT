import type { PublicRoomState, PublicSeat } from '@felt/protocol';

/** Sat out by the turn clock (as the server says), and still able to come back. */
export const satOutByClock = (room: PublicRoomState, me: PublicSeat): boolean =>
  me.sittingOut &&
  me.sitOutReason === 'timeouts' &&
  !me.leaving &&
  !room.removals?.includes(me.userId) &&
  !room.ending &&
  room.status !== 'ended';
