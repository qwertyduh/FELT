/**
 * Host controls (P44): how a refusal is worded, and what the confirm step says. The server
 * decides everything.
 */
import {
  FORCED_TURN_SECONDS,
  type ClientEventName,
  type ErrorPayload,
  type PublicRoomState,
} from '@felt/protocol';
import { chips } from './seating';

/**
 * What removing this player does, as the server does it (`kick` in rooms/hostControls.ts):
 * somebody still contesting the running hand plays it out first, anyone else goes at once. While an
 * all-in run-out is being dealt (`held`) the real stack is the result, so no figure is named.
 */
export function kickFate(room: PublicRoomState, userId: string, held = false): string {
  const seat = room.seats.find((s) => s?.userId === userId) ?? null;
  if (!seat) return 'They stop seeing the table.';
  if (held) return 'Their chips are cashed out.';
  const { hand } = room;
  const contesting =
    hand !== null &&
    hand.street !== 'ended' &&
    seat.handStatus !== null &&
    seat.handStatus !== 'folded';
  if (!contesting) return `Their ${chips(seat.stack)} chips are cashed out.`;
  const clock =
    room.settings.turnTimerSeconds === null
      ? ` The turn timer is off, so they get ${FORCED_TURN_SECONDS} seconds a turn, then check or fold.`
      : '';
  return `They're still in this hand, so they play it out.${clock} Then they're removed and their chips and any winnings are cashed out.`;
}

export function hostFailure({ code }: ErrorPayload, event: ClientEventName): string {
  switch (code as string) {
    case 'not_host':
      return "You're not the host any more.";
    case 'not_seated':
      return 'That player has no seat now.';
    case 'not_found':
      return 'That player is no longer in the room.';
    case 'illegal_action':
      return event === 'host:transfer'
        ? "They aren't connected right now."
        : "The table didn't allow it.";
    case 'room_ended':
      return 'This game has ended.';
    case 'rate_limited':
      return 'Too fast. Wait a moment.';
    case 'timeout':
      return 'No answer. Check the table before trying again.';
    default:
      return 'Not sent. Try again.';
  }
}
