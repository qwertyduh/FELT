/**
 * When an all-in result held back by `asShown` is let go (P49): a moment after the hand ends, the
 * full board and the real stacks appear.
 *
 * P50's seam: turn the board over street by street here (give `asShown` the number of cards face up
 * so far) and set `held` false only once the last one is down.
 */
import { useEffect, useState } from 'react';
import type { PublicRoomState } from '@felt/protocol';
import { asShown, resultHeld } from './cards';

export const RESULT_HOLD_MS = 1_500;

export function useShownRoom(room: PublicRoomState): { room: PublicRoomState; held: boolean } {
  const { hand } = room;
  const holding = hand && resultHeld(hand) ? hand.handId : null;
  const nextHandAt = hand?.outcome?.nextHandAt ?? null;
  /** The hand whose result is out: it stays out, whatever happens to the next deal's time. */
  const [released, setReleased] = useState<string | null>(null);
  useEffect(() => {
    if (holding === null) return;
    // Well inside what is left before the next deal; at once if that time has already come.
    const wait =
      nextHandAt === null
        ? RESULT_HOLD_MS
        : Math.max(0, Math.min(RESULT_HOLD_MS, (nextHandAt - Date.now()) / 4));
    const id = setTimeout(() => setReleased(holding), wait);
    return () => clearTimeout(id);
    // `nextHandAt` is read once per hand: a later change must not start the wait again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holding]);
  const held = holding !== null && released !== holding;
  return { room: held ? asShown(room) : room, held };
}
