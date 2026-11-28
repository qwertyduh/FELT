/**
 * The all-in run-out (P49, P50). The state arrives with the whole board and the result; this turns
 * the board over street by street and only then lets the result go (`asShown` decides what is on
 * screen meanwhile). Any other state is shown as it is.
 *
 * A hand that ends while we watch runs at full pace, whatever this device's clock says. One that
 * had already ended when we first saw it (a reload, a late arrival, a reconnect) is fitted into
 * half the time left before the next deal. A pause does not stop the cards: the hand is over.
 *
 * Anything else on screen that could give the result away asks `useResultHeld` (the host's menu and
 * requests live outside the table). It is true from the first render of the state that holds the
 * result, because only the release is recorded.
 */
import { useEffect, useRef, useState } from 'react';
import type { PublicRoomState } from '@felt/protocol';
import { asShown, resultHeld, runoutSteps } from './cards';
import { useRoomStore } from './realtime/roomStore';

/** Before each street of a run-out. */
export const STREET_STEP_MS = 1_300;
/** After the river lands, before the result. */
export const RESULT_BEAT_MS = 700;

/** True while an all-in run-out is still being dealt: its result is not to be given away. */
export function useResultHeld(room: PublicRoomState | null | undefined): boolean {
  const released = useRoomStore((s) => s.releasedHandId);
  const hand = room?.hand ?? null;
  return resultHeld(hand) && hand!.handId !== released;
}

export function useShownRoom(
  room: PublicRoomState,
  /** False while disconnected: a hand that ends meanwhile was not watched. */
  ready = true,
): { room: PublicRoomState; held: boolean } {
  const { hand } = room;
  const holding = hand && resultHeld(hand) ? hand.handId : null;
  const steps = holding === null ? [] : runoutSteps(hand!.outcome!.runoutFrom!);
  const held = useResultHeld(room);
  /** How far the run-out of one hand has got. */
  const [reached, setReached] = useState({ handId: '', step: 0 });
  /** The hand that was being played at the last render. */
  const watched = useRef<string | null>(null);
  useEffect(() => {
    if (holding === null || useRoomStore.getState().releasedHandId === holding) return;
    const waits = steps.map((_, i) => (i < steps.length - 1 ? STREET_STEP_MS : RESULT_BEAT_MS));
    const full = waits.reduce((sum, ms) => sum + ms, 0);
    const nextHandAt = hand!.outcome!.nextHandAt;
    // While paused that time stands still, so it says nothing.
    const hurry = watched.current !== holding && !room.paused && nextHandAt !== null;
    const pace = hurry ? Math.min(1, Math.max(0, nextHandAt - Date.now()) / 2 / full) : 1;
    let timer: ReturnType<typeof setTimeout>;
    const after = (step: number) => {
      timer = setTimeout(() => {
        setReached({ handId: holding, step: step + 1 });
        if (step + 1 < waits.length) after(step + 1);
        else useRoomStore.setState({ releasedHandId: holding });
      }, waits[step]! * pace);
    };
    after(0);
    return () => clearTimeout(timer);
    // All else is read once per hand: a later change (a show, a pause) must not start it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holding]);
  // After the effect above, which must see the render before this one.
  useEffect(() => {
    watched.current = ready && hand && hand.street !== 'ended' ? hand.handId : null;
  });
  const step = reached.handId === holding ? reached.step : 0;
  return { room: held ? asShown(room, steps[step]) : room, held };
}
