/**
 * Buy more (P43, PRD 5.3), for a seated player: the button beside the stack and the amount sheet it
 * opens at the bottom of the screen. The sheet is laid over the page (`data-cover`: nothing under
 * it takes a tap), so the action bar and request cards never move. The button says where a request
 * stands; chips only ever change through `room:state`.
 *
 * `compact`, beside the stack at the table: no taller than that line (a 320x568 screen with a
 * request card has no height to spare), with the tap area reaching above and below it.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { PublicRoomState, PublicSeat } from '@felt/protocol';
import { useRoomStore } from '../lib/realtime/roomStore';
import type { SocketClient } from '../lib/realtime/socketClient';
import { chips, shortChips } from '../lib/seating';
import { parseTopUp, roomToAdd, topUpFailure } from '../lib/topUp';
import { usePressGuard } from '../lib/usePressGuard';

/** A second tap on the button that opened the sheet must not send it. */
export const SHEET_ARM_MS = 400;

const BUTTON = 'min-h-12 rounded-xl px-3 text-base font-semibold active:brightness-90';
const OUTLINE = `${BUTTON} border border-brass text-brass`;
const SOLID = `${BUTTON} bg-brass text-felt-950 disabled:bg-felt-800 disabled:text-cream/40`;

type Client = Pick<SocketClient, 'emitWithAck'>;

function Sheet({
  room,
  me,
  ready,
  client,
  onClose,
}: {
  room: PublicRoomState;
  me: PublicSeat;
  ready: boolean;
  client: Client;
  onClose: () => void;
}) {
  const most = roomToAdd(room.settings, me.stack);
  const [value, setValue] = useState(() => String(Math.min(room.settings.minBuyIn, most)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const sending = useRef(false);
  const guard = usePressGuard();

  useEffect(() => {
    const id = setTimeout(() => setArmed(true), SHEET_ARM_MS);
    return () => clearTimeout(id);
  }, []);

  const parsed = parseTopUp(value, most);

  async function ask() {
    if (!armed || !ready || sending.current) return;
    if (!parsed.ok) return setError(parsed.message);
    sending.current = true;
    setBusy(true);
    setError(null);
    const res = await client.emitWithAck('player:topup_request', { amount: parsed.amount });
    sending.current = false;
    setBusy(false);
    if (res.ok) return onClose();
    setError(topUpFailure(res.error));
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask();
  };
  const off = !armed || !ready || busy;

  return createPortal(
    <div
      data-cover
      data-testid="buy-more-sheet"
      role="dialog"
      aria-label="Buy more chips"
      className="fixed inset-x-0 bottom-0 z-20 mx-auto max-h-[100dvh] w-full max-w-[480px] overflow-y-auto rounded-t-2xl border-t-2 border-brass-dim bg-felt-950 p-4"
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-2">
        <label htmlFor="top-up" className="text-center text-lg font-semibold text-cream">
          Buy more chips
        </label>
        <p id="top-up-room" className="text-center text-sm text-brass tabular-nums">
          Stack {chips(me.stack)}
          {room.settings.maxBuyIn !== null && ` · add up to ${chips(most)}`}
        </p>
        <input
          id="top-up"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="send"
          aria-describedby="top-up-room"
          aria-invalid={error !== null}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          className="min-h-14 w-full rounded-xl border border-felt-700 bg-felt-900 px-3 text-center text-2xl text-cream tabular-nums aria-invalid:border-chip-red"
        />
        {error ? (
          <p role="alert" className="text-center text-sm wrap-anywhere text-chip-red">
            {error}
          </p>
        ) : (
          <p className="text-center text-sm text-cream/75">
            {room.hostId === me.userId
              ? 'Approve it from your requests. Chips arrive with the next hand.'
              : 'The host decides. Chips arrive with the next hand.'}
          </p>
        )}
        <div className="grid grid-cols-3 gap-2">
          <button type="button" className={OUTLINE} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${SOLID} col-span-2 tabular-nums`}
            disabled={off}
            onPointerDown={() => guard.press(off ? null : 'ask')}
            onClick={(e) => {
              if (guard.took('ask', e)) void ask();
            }}
          >
            {parsed.ok ? `Ask for ${chips(parsed.amount)}` : 'Ask the host'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function BuyMore({
  room,
  me,
  ready,
  client,
  compact = false,
}: {
  room: PublicRoomState;
  me: PublicSeat;
  /** True only after the `room:enter` ack: nothing may be sent before. */
  ready: boolean;
  client: Client;
  compact?: boolean;
}) {
  const waiting = useRoomStore((s) => s.topUp);
  const queued = room.pendingTopUps[me.userId];
  const full = roomToAdd(room.settings, me.stack) === 0;
  const [open, setOpen] = useState(false);

  const blocked = queued !== undefined || waiting !== null || full || room.status === 'ended';
  // A proposed award has a short window to dispute: nothing of ours stays over it.
  const awarding = (room.hand?.pendingAwards.length ?? 0) > 0 && room.hand?.street !== 'ended';
  const [wasAwarding, setWasAwarding] = useState(awarding);
  if (awarding !== wasAwarding) {
    setWasAwarding(awarding);
    if (awarding) setOpen(false);
  }
  if (open && blocked) setOpen(false);

  const label =
    queued !== undefined
      ? `+${shortChips(queued, 100_000)} next hand`
      : waiting !== null
        ? `Asked ${shortChips(waiting.amount, 100_000)}`
        : full
          ? 'Max stack'
          : 'Buy more';
  // An all-in player has no stack either, until the hand is over.
  const busted = me.stack === 0 && (me.handStatus !== 'all_in' || room.hand?.street === 'ended');

  return (
    <>
      <button
        type="button"
        data-testid="buy-more"
        aria-haspopup="dialog"
        disabled={!ready || blocked}
        onClick={() => setOpen(true)}
        className={`shrink-0 rounded-xl border px-2 text-sm font-semibold whitespace-nowrap tabular-nums active:brightness-90 disabled:border-felt-700 disabled:text-cream/60 ${
          busted && !blocked ? 'border-brass bg-brass text-felt-950' : 'border-brass text-brass'
        } ${compact ? 'relative h-8 before:absolute before:inset-x-0 before:-inset-y-1.5' : 'min-h-11'}`}
      >
        {label}
      </button>
      {open && !blocked && (
        <Sheet room={room} me={me} ready={ready} client={client} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
