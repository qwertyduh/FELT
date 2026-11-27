/**
 * The next blind level and the time to it, in the middle of the felt (the blinds in play are in the
 * line above the table). It only shows: the server decides when the blinds move, at a deal.
 */
import { useEffect, useState } from 'react';
import type { PublicRoomState } from '@felt/protocol';
import { shortChips } from '../lib/seating';

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [running]);
  return now;
}

/** m:ss, or h:mm:ss from an hour up. */
function duration(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  return h > 0 ? `${h}:${two(m)}:${two(total % 60)}` : `${m}:${two(total % 60)}`;
}

export function BlindCountdown({ room }: { room: PublicRoomState }) {
  const { nextBlindLevel: level, nextBlindIncreaseAt: at, blindIncreaseLeftMs: frozen } = room;
  const now = useNow(at !== null);
  const minutes = room.settings.blindIncreaseMinutes;
  if (!level || minutes === null || room.status === 'ended') return null;
  // Never more than a whole interval, whatever this device's clock says.
  const left = frozen ?? (at === null ? null : Math.min(Math.max(0, at - now), minutes * 60_000));
  if (left === null) return null;
  // Blinds set by hand go first (the line above the table says so).
  if (left === 0 && room.nextBlinds) return null;
  return (
    <p data-testid="blind-countdown" className="mt-1 text-xs leading-tight text-cream/75">
      <span className="block whitespace-nowrap tabular-nums">
        Blinds up {shortChips(level.smallBlind, 100_000)}/{shortChips(level.bigBlind, 100_000)}
      </span>
      <span role="timer" className="block whitespace-nowrap text-brass tabular-nums">
        {left === 0 ? 'next hand' : `${frozen === undefined ? 'in' : 'paused'} ${duration(left)}`}
      </span>
    </p>
  );
}
