/**
 * The turn timer as the table shows it (P49): from the absolute deadline in `room:state` and the
 * room's setting. Display only: the server decides when a turn is over.
 */
import { useEffect, useState } from 'react';
import type { PublicRoomState } from '@felt/protocol';

export const TICK_MS = 200;
/** From here on the ring turns red. */
export const URGENT_MS = 5_000;

export interface TurnTimer {
  /** Absolute epoch ms. */
  deadline: number;
  totalMs: number;
}

/** Null when nothing is counting down: no timer, nobody on turn, hand over, paused or ended. */
export function turnTimer(room: PublicRoomState): TurnTimer | null {
  const { hand, settings } = room;
  if (room.status !== 'playing' || room.paused || settings.turnTimerSeconds === null) return null;
  if (!hand || hand.street === 'ended' || hand.currentActor === null) return null;
  if (hand.turnDeadline === null) return null;
  return { deadline: hand.turnDeadline, totalMs: settings.turnTimerSeconds * 1000 };
}

/** When the latest deadline was first shown here, so that every ring of a turn agrees. */
let first = { deadline: -1, at: 0 };
function firstShown(deadline: number): number {
  if (first.deadline !== deadline) first = { deadline, at: performance.now() };
  return first.at;
}

/**
 * Time left, never below zero nor above the whole turn. Never more than the time since it was first
 * shown allows either, in case this device's clock is behind. Read from the clocks each time, so a
 * tab that was in the background is right as soon as it is looked at. Mount anew for a new deadline.
 */
export function useTimeLeft({ deadline, totalMs }: TurnTimer): number {
  const [seen] = useState(() => firstShown(deadline));
  const read = () =>
    Math.max(0, Math.min(deadline - Date.now(), totalMs - (performance.now() - seen)));
  const [left, setLeft] = useState(read);
  useEffect(() => {
    const update = () => setLeft(read());
    update();
    const id = setInterval(update, TICK_MS);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', update);
    };
    // `read` only closes over these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deadline, totalMs]);
  return left;
}
