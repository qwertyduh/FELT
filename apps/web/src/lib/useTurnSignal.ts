/** Vibrates once when it becomes your turn (PRD 5.11, P49). */
import { useEffect, useRef } from 'react';
import type { PublicRoomState } from '@felt/protocol';

export const TURN_VIBRATION: readonly number[] = [200, 100, 200];

/** Not everywhere: iOS has no `vibrate`, and some browsers refuse it. */
function buzz() {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate([...TURN_VIBRATION]);
  } catch {
    // The screen already says it is your turn.
  }
}

export function useTurnSignal(room: PublicRoomState, userId: string): void {
  const { hand } = room;
  const actor = hand && hand.currentActor !== null ? room.seats[hand.currentActor] : null;
  // One turn: other changes to the hand while it lasts (someone leaving) do not repeat it.
  const turn =
    hand && hand.street !== 'ended' && actor?.userId === userId
      ? `${hand.handId}:${hand.street}`
      : null;
  const live = room.status === 'playing' && !room.paused;
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (turn === null) told.current = null;
    else if (live && told.current !== turn) {
      told.current = turn;
      buzz();
    }
  }, [turn, live]);
}
