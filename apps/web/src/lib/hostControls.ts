/**
 * Host controls (P44): how a refusal is worded, and what the confirm step says. The server
 * decides everything.
 */
import type { ClientEventName, ErrorPayload, PublicRoomState } from '@felt/protocol';
import { chips } from './seating';

/**
 * What removing this player does, as the server does it (`handStaysLive` in rooms/game.ts): their
 * cards stay in play when they are all-in, at showdown, or when nothing is left to bet.
 */
export function kickFate(room: PublicRoomState, userId: string): string {
  const seat = room.seats.find((s) => s?.userId === userId) ?? null;
  if (!seat) return 'They stop seeing the table.';
  const { hand } = room;
  if (
    !hand ||
    hand.street === 'ended' ||
    seat.handStatus === null ||
    seat.handStatus === 'folded'
  ) {
    return `Their ${chips(seat.stack)} chips are cashed out.`;
  }
  const betting = room.seats.filter((s) => s?.handStatus === 'active').length;
  const live =
    seat.handStatus === 'all_in' ||
    hand.street === 'showdown' ||
    (betting < 2 && hand.currentActor === null);
  return live
    ? 'Their cards stay in play until the hand ends, then their chips and any winnings are cashed out.'
    : 'Their hand is folded and the rest of their chips are cashed out.';
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
