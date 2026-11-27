/**
 * Sit out / I'm back and Leave, for a seated player. They sit inside the felt (bottom corners of
 * the table, middle of the seat map), so they take no height from anything and the action bar and
 * request cards never move for them. Leave only opens a sheet that says exactly what leaving would
 * do now; nothing is sent until that is confirmed.
 *
 * Tap protections as elsewhere: a button takes no taps until it has been in place for
 * `SEAT_ARM_MS` (also after what the sheet says changes), and a tap must begin on it. The sheet is
 * closed when your turn or a proposed award arrives, so it is never laid over a fresh decision.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { PublicRoomState, PublicSeat } from '@felt/protocol';
import type { Tap } from '../lib/actionUi';
import { leaveLines } from '../lib/leave';
import { useRoomStore } from '../lib/realtime/roomStore';
import type { SocketClient } from '../lib/realtime/socketClient';
import { usePressGuard } from '../lib/usePressGuard';
import { useStillCards } from '../lib/useStillCards';

export const SEAT_ARM_MS = 600;

const SMALL =
  'pointer-events-auto flex min-h-11 min-w-0 flex-col items-center justify-center rounded-xl border px-1.5 text-sm leading-tight font-semibold active:brightness-90 disabled:opacity-60';
const BIG = 'min-h-12 rounded-xl px-2 text-base font-semibold active:brightness-90';

type Client = Pick<SocketClient, 'emitWithAck'>;

function failure(code: string): string {
  if (code === 'timeout') return 'No answer from the table. Check your seat and try again.';
  if (code === 'rate_limited') return 'Too many tries. Wait a moment and try again.';
  return "That didn't work. Try again.";
}

/** `still` arms the buttons inside the element given `list`. */
function useGuarded(ready: boolean) {
  const { list, held, isStill } = useStillCards<HTMLDivElement>(true, SEAT_ARM_MS);
  const guard = usePressGuard();
  const tap: Tap = (id, run) => ({
    'data-card': id,
    disabled: !ready || held.has(id),
    onPointerDown: () => guard.press(isStill(id) ? id : null),
    onClick: (e) => {
      if (guard.took(id, e) && isStill(id)) run();
    },
  });
  return { list, tap };
}

function LeaveSheet({
  lines,
  ready,
  busy,
  error,
  onStay,
  onLeave,
}: {
  lines: string[];
  ready: boolean;
  busy: boolean;
  error: string | null;
  onStay: () => void;
  onLeave: () => void;
}) {
  const { list, tap } = useGuarded(ready && !busy);
  // Held again if what leaving would do changes.
  const id = `leave:${lines.join(' ')}`;
  return createPortal(
    <div
      ref={list}
      data-cover
      data-testid="leave-sheet"
      role="dialog"
      aria-label="Leave your seat"
      className="fixed inset-x-0 bottom-0 z-30 mx-auto flex max-h-[100dvh] w-full max-w-[480px] flex-col gap-2 rounded-t-2xl border-t-2 border-brass-dim bg-felt-950 p-4"
    >
      <h2 className="text-center text-lg font-semibold text-cream">Leave your seat?</h2>
      <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto text-sm text-cream">
        {lines.map((line) => (
          <p key={line} className="tabular-nums">
            {line}
          </p>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-center text-sm text-chip-red">
          {error}
        </p>
      )}
      <div className="grid shrink-0 grid-cols-3 gap-2">
        <button type="button" className={`${BIG} border border-brass text-brass`} onClick={onStay}>
          Stay
        </button>
        <button
          key={id}
          type="button"
          className={`${BIG} col-span-2 border border-chip-red bg-chip-red text-felt-950 disabled:opacity-40`}
          {...tap(id, onLeave)}
        >
          {busy ? 'Leaving…' : 'Leave seat'}
        </button>
      </div>
    </div>,
    document.body,
  );
}

export function SeatControls({
  room,
  me,
  ready,
  client,
  place,
}: {
  room: PublicRoomState;
  me: PublicSeat;
  /** True only after the `room:enter` ack: nothing may be sent before. */
  ready: boolean;
  client: Client;
  /** Where in the felt: the table's bottom corners, or the middle of the lobby's seat map. */
  place: 'table' | 'map';
}) {
  const [busy, setBusy] = useState(false);
  const { list, tap } = useGuarded(ready && !busy);
  const asked = useRoomStore((s) => s.topUp?.amount ?? null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const handId = room.hand && room.hand.street !== 'ended' ? room.hand.handId : null;
  const { leaving } = me;
  /** Dealt in and not folded: sitting out only starts with the next hand. */
  const dealtIn = me.onLeave !== null;

  const urgent =
    room.status === 'playing' &&
    handId !== null &&
    (room.hand!.currentActor === me.seat || room.hand!.pendingAwards.length > 0);
  // Only as it arrives: you may still open the sheet during your turn.
  const [wasUrgent, setWasUrgent] = useState(urgent);
  if (urgent !== wasUrgent) {
    setWasUrgent(urgent);
    if (urgent) setOpen(false);
  }
  if (open && leaving) setOpen(false);

  async function send(event: 'room:sit_out' | 'room:sit_in' | 'room:leave') {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    const res = await client.emitWithAck(event, undefined);
    setBusy(false);
    if (res.ok) {
      if (event === 'room:leave') setOpen(false);
      return;
    }
    setError(failure(res.error.code));
  }

  const toggle = me.sittingOut ? 'room:sit_in' : 'room:sit_out';
  const box =
    place === 'table'
      ? 'absolute inset-x-0 bottom-0 justify-between'
      : 'absolute inset-x-0 top-[10.75rem] justify-center gap-0.5';
  const width = place === 'table' ? 'w-24' : 'w-[3.625rem]';

  return (
    <div
      ref={list}
      data-testid="seat-controls"
      className={`pointer-events-none z-[5] flex items-end ${box}`}
    >
      {leaving ? (
        <p
          role="status"
          className={`${width} ml-auto flex min-h-11 items-center justify-center rounded-xl bg-felt-950 text-center text-[11px] leading-tight text-cream ${
            place === 'map' ? 'mx-auto' : ''
          }`}
        >
          Leaving after this hand
        </p>
      ) : (
        <>
          <button
            key={toggle}
            type="button"
            className={`${SMALL} ${width} ${
              me.sittingOut
                ? 'border-brass bg-brass text-felt-950'
                : 'border-felt-700 bg-felt-950 text-brass'
            }`}
            {...tap(toggle, () => void send(toggle))}
          >
            <span className="whitespace-nowrap">{me.sittingOut ? "I'm back" : 'Sit out'}</span>
            {error && !open ? (
              <span role="alert" className="text-[11px] font-normal">
                Try again
              </span>
            ) : (
              // This hand is played on: say when sitting out starts.
              place === 'table' &&
              me.sittingOut &&
              dealtIn && <span className="text-[11px] font-normal">Out next hand</span>
            )}
          </button>
          <button
            type="button"
            aria-label="Leave seat"
            aria-haspopup="dialog"
            className={`${SMALL} ${width} border-felt-700 bg-felt-950 text-brass`}
            {...tap('open-leave', () => {
              setError(null);
              setOpen(true);
            })}
          >
            Leave
          </button>
        </>
      )}
      {open && !leaving && (
        <LeaveSheet
          lines={leaveLines(room, me, {
            asked,
            approved: room.pendingTopUps[me.userId] ?? null,
          })}
          ready={ready}
          busy={busy}
          error={error}
          onStay={() => setOpen(false)}
          onLeave={() => void send('room:leave')}
        />
      )}
    </div>
  );
}
