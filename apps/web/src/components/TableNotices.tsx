/**
 * What a player has to be told in so many words, above the figures under the table: the game ends
 * after this hand, the host is removing them, or the turn clock sat them out (with the way back).
 * All of it is read from `room:state`, so it is also there for somebody who was away when it
 * happened. In normal flow: it takes height from the felt and never covers the action bar.
 */
import { useState } from 'react';
import {
  FORCED_TURN_SECONDS,
  TIMEOUTS_TO_SIT_OUT,
  type PublicRoomState,
  type PublicSeat,
} from '@felt/protocol';
import type { SocketClient } from '../lib/realtime/socketClient';
import { satOutByClock } from '../lib/satOut';
import { usePressGuard } from '../lib/usePressGuard';
import { useStillCards } from '../lib/useStillCards';

/** A button that has just appeared may be under a tap meant for something else. */
export const BACK_ARM_MS = 600;

type Client = Pick<SocketClient, 'emitWithAck'>;

function SatOut({ ready, client }: { ready: boolean; client: Client }) {
  const { list, held, isStill } = useStillCards<HTMLDivElement>(true, BACK_ARM_MS);
  const guard = usePressGuard();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function back() {
    if (busy || !ready) return;
    setBusy(true);
    setFailed(false);
    const res = await client.emitWithAck('room:sit_in', undefined);
    setBusy(false);
    if (!res.ok) setFailed(true);
  }

  return (
    <div
      ref={list}
      data-testid="sat-out"
      className="flex items-center gap-2 rounded-xl border border-brass bg-felt-950 py-0.5 pr-0.5 pl-3"
    >
      <p role="status" className="min-w-0 flex-1 text-sm leading-tight font-semibold text-cream">
        You were sat out after {TIMEOUTS_TO_SIT_OUT} timeouts
        {failed && <span className="block font-normal text-chip-red">Not sent. Try again.</span>}
      </p>
      <button
        type="button"
        data-card="back"
        className="min-h-11 shrink-0 rounded-xl bg-brass px-4 text-base font-semibold text-felt-950 active:brightness-90 disabled:opacity-60"
        disabled={!ready || busy || held.has('back')}
        onPointerDown={() => guard.press(isStill('back') ? 'back' : null)}
        onClick={(e) => {
          if (guard.took('back', e) && isStill('back')) void back();
        }}
      >
        I&apos;m back
      </button>
    </div>
  );
}

export function TableNotices({
  room,
  userId,
  me,
  ready,
  client,
}: {
  room: PublicRoomState;
  userId: string;
  me: PublicSeat | null;
  ready: boolean;
  client: Client;
}) {
  if (room.status === 'ended') return null;
  // Also for somebody who has given up their seat since.
  const removing = room.removals?.includes(userId) ?? false;
  const forced = room.settings.turnTimerSeconds === null;
  return (
    <>
      {(room.ending || removing) && (
        <p
          role="status"
          data-testid="pending-notice"
          className="rounded-xl bg-brass px-3 py-1 text-center text-sm leading-tight font-semibold text-felt-950"
        >
          {room.ending
            ? 'Game ends after this hand'
            : `The host is removing you after this hand.${me ? ' Play it out.' : ''}`}
          {forced && (room.ending || me) && (
            <span className="block font-normal">
              {room.ending ? 'Every turn' : 'Your turns'}: {FORCED_TURN_SECONDS}s, then check or
              fold
            </span>
          )}
        </p>
      )}
      {me && satOutByClock(room, me) && <SatOut ready={ready} client={client} />}
    </>
  );
}
