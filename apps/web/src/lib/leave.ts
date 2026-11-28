/**
 * What leaving your seat would do, in words, for the confirm sheet. Read-only: the server decides
 * (rooms/seating.ts and `leave` in rooms/game.ts).
 *
 * Every sentence must stay true whatever happens afterwards. Chips can still follow a player who
 * has left (money nobody still in the hand covers), so amounts are only ever "now" or "at least",
 * never final. rooms/leaveSheet.test.ts plays hands out against each one.
 */
import type { PublicRoomState, PublicSeat } from '@felt/protocol';
import { chips } from './seating';

export function leaveLines(
  room: PublicRoomState,
  me: PublicSeat,
  /** A top-up still waiting for the host, and one approved for the next hand. */
  topUp: { asked: number | null; approved: number | null },
): string[] {
  const lines: string[] = [];
  const cards = me.onLeave;
  const removing = room.removals?.includes(me.userId) ?? false;
  const handLive = room.hand !== null && room.hand.street !== 'ended';

  if (room.status === 'lobby') {
    lines.push(
      `The game hasn't started, so your ${chips(me.stack)} chips are refunded. If you sit again, it's with a new buy-in.`,
    );
  } else {
    if (cards?.staysLive) {
      lines.push(
        me.handStatus === 'all_in'
          ? "You're all-in: your cards stay in play."
          : 'The betting is over: your cards stay in play.',
        'Your seat frees when this hand ends.',
        me.stack === 0
          ? 'Your cash out is then whatever you win or get back.'
          : `Your cash out is then at least your ${chips(me.stack)} chips, plus anything you win or get back.`,
      );
    } else {
      if (cards) {
        const turn = room.hand?.currentActor === me.seat;
        lines.push(`${turn ? "It's your turn. " : ''}You will be folded now.`);
      } else if (handLive && me.handStatus === 'folded') {
        lines.push("You've folded.");
      }
      const back = cards?.returned ?? 0;
      lines.push(
        `You take ${chips(me.stack + back)} chips as your cash out now${
          back > 0 ? `, including ${chips(back)} of your bet that comes straight back` : ''
        }.`,
      );
      if (handLive) {
        lines.push(
          'Chips you put into this hand are not refunded, except any that no player still in the hand ends up matching: those can come back to you.',
        );
      }
    }
    // Neither a game that is ending nor a table you are being removed from can be sat at again.
    if (!room.ending && !removing) {
      lines.push(
        'To sit again you must bring back your whole cash out as it stands then. If that is 0, you sit with 0 and use Buy more.',
      );
    }
  }

  if (topUp.approved !== null) {
    lines.push(`Your approved top-up of ${chips(topUp.approved)} is cancelled and not added.`);
  } else if (topUp.asked !== null) {
    lines.push(`Your request for ${chips(topUp.asked)} more chips is cancelled.`);
  }
  if (room.paused) {
    lines.push(
      cards?.staysLive
        ? 'The game is paused. Your seat stays until this hand ends.'
        : 'The game is paused, but leaving takes effect now.',
    );
  }
  if (room.ending) lines.push('The game ends after this hand.');
  if (removing) {
    lines.push('The host is removing you from the room when this hand ends.');
    return lines;
  }
  lines.push(
    room.hostId === me.userId
      ? "Leaving your seat doesn't change who is host."
      : 'Leaving your seat keeps you in the room.',
  );
  return lines;
}
