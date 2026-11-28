/**
 * The hand-rank button of a room's table. Online it marks the viewer's current hand, from their own
 * cards and the board of the room it is given: give it the room as the table shows it, so a run-out
 * is never given away. Hybrid cards are real, so nothing is marked. Folded hands are not marked.
 */
import type { PublicRoomState } from '@felt/protocol';
import { useRoomStore } from '../../lib/realtime/roomStore';
import { turnLine } from '../../lib/table';
import { turnTimer } from '../../lib/turnClock';
import { TurnRing } from '../TurnRing';
import { HandRanksButton } from './HandRanksButton';
import { currentHand } from './ranks';

export function TableHandRanks({
  room,
  userId,
  ready = true,
}: {
  room: PublicRoomState;
  userId: string;
  /** False while disconnected: whose turn it is may have changed since. */
  ready?: boolean;
}) {
  const own = useRoomStore((s) => s.privateHand);
  const { hand } = room;
  const me = room.seats.find((s) => s?.userId === userId) ?? null;
  const current =
    room.settings.mode === 'online' &&
    hand &&
    own?.handId === hand.handId &&
    me &&
    me.handStatus !== null &&
    me.handStatus !== 'folded'
      ? currentHand(own.holeCards, hand.board)
      : null;
  const line = ready ? turnLine(room, userId) : 'Waiting for the connection';
  const timer = ready ? turnTimer(room) : null;
  return (
    <HandRanksButton
      current={current}
      // A proposed award has a short window to dispute: nothing of ours stays over it.
      dismiss={hand !== null && hand.street !== 'ended' && hand.pendingAwards.length > 0}
      indicator={
        // In the lobby there is no turn to speak of.
        room.status !== 'lobby' && (
          <>
            <p
              role="status"
              data-testid="ranks-turn-line"
              className={`line-clamp-2 min-w-0 text-right leading-tight wrap-anywhere ${
                line === 'Your turn' ? 'text-base font-bold text-brass' : 'text-sm text-cream'
              }`}
            >
              {line}
            </p>
            {timer && <TurnRing timer={timer} testId="ranks-turn-ring" />}
          </>
        )
      }
    />
  );
}
