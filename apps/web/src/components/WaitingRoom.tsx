/**
 * The room once admitted (P38, P39): the seat map in the lobby and the table once the game has
 * started, plus buy-in and the host's Start. People without a seat (late joiners, returners) take
 * one from either. Everything sits in normal flow (nothing floats over the host's request cards
 * below). Nothing is sent before `ready`, and every send waits for its ack; the seats themselves
 * only ever change through `room:state`.
 *
 * Renders two siblings: a top part that gives up height (and scrolls) when the request cards are
 * up, and a footer that stays whole, so Start and the buy-in panel are never pushed out of view.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import type { PublicRoomState } from '@felt/protocol';
import type { SocketClient } from '../lib/realtime/socketClient';
import {
  buyInRange,
  chips,
  parseBuyIn,
  returningFrom,
  sitFailure,
  startFailure,
  type Returning,
} from '../lib/seating';
import { usePressGuard } from '../lib/usePressGuard';
import { useStillCards } from '../lib/useStillCards';
import { RoomLog } from './hybrid/RoomLog';
import { InviteButton } from './InviteButton';
import { SeatMap } from './SeatMap';
import { Table, TableSummary } from './Table';

/** A Start button that has just appeared or moved may be under a tap meant for something else. */
export const START_ARM_MS = 600;

const PRIMARY =
  'min-h-14 w-full rounded-2xl bg-brass px-4 text-lg font-semibold text-felt-950 active:brightness-90 disabled:bg-felt-800 disabled:text-cream/40';
const SECONDARY =
  'min-h-14 rounded-2xl border border-brass px-4 text-lg font-semibold text-brass active:brightness-90';

/**
 * While the host's request cards (HostInbox, a later sibling) are up, the top part scrolls inside
 * whatever height the screen has left, so nothing is laid over anything. A zero basis (not 0%)
 * keeps its content from stretching the page.
 */
const ABOVE_REQUESTS =
  '[&:has(~[data-testid=host-inbox])]:min-h-24 [&:has(~[data-testid=host-inbox])]:basis-0 [&:has(~[data-testid=host-inbox])]:overflow-y-auto';

type Client = Pick<SocketClient, 'emitWithAck'>;

const Hint = ({ children }: { children: React.ReactNode }) => (
  <p className="text-center text-base text-cream/75">{children}</p>
);

const Problem = ({ children }: { children: React.ReactNode }) => (
  <p role="alert" className="text-center text-base wrap-anywhere text-chip-red">
    {children}
  </p>
);

function BuyInForm({
  room,
  seat,
  value,
  exact,
  error,
  disabled,
  busy,
  onChange,
  onCancel,
  onSubmit,
}: {
  room: PublicRoomState;
  seat: number;
  value: string;
  /** The only amount allowed (returning player), or null. */
  exact: number | null;
  error: string | null;
  disabled: boolean;
  busy: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    form.current?.scrollIntoView?.({ block: 'nearest' });
  }, [seat, exact, error]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <form
      ref={form}
      onSubmit={submit}
      noValidate
      aria-label={`Buy in at seat ${seat + 1}`}
      className="flex scroll-mb-4 flex-col gap-2 rounded-2xl border-2 border-brass-dim bg-felt-950 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <label htmlFor="buy-in" className="font-display text-xl font-semibold text-cream">
          Seat {seat + 1} buy-in
        </label>
        {exact === null && (
          <p id="buy-in-range" className="text-sm text-brass tabular-nums">
            {buyInRange(room.settings)}
          </p>
        )}
      </div>
      {exact !== null && (
        <p id="buy-in-range" className="text-sm text-cream">
          You left this game with <strong className="text-brass">{chips(exact)}</strong> chips. You
          can only sit back down with exactly that.
        </p>
      )}
      <input
        id="buy-in"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        enterKeyHint="done"
        readOnly={exact !== null}
        aria-describedby={`buy-in-range${error ? ' buy-in-error' : ''}`}
        aria-invalid={error !== null}
        value={exact !== null ? chips(exact) : value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-14 w-full rounded-xl border border-felt-700 bg-felt-900 px-3 text-center text-2xl text-cream tabular-nums read-only:border-brass-dim aria-invalid:border-chip-red"
      />
      {error && (
        <p id="buy-in-error" role="alert" className="text-sm wrap-anywhere text-chip-red">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" className={SECONDARY} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={PRIMARY} disabled={disabled || busy}>
          {busy ? 'Sitting…' : 'Sit down'}
        </button>
      </div>
    </form>
  );
}

function StartButton({ ready, client }: { ready: boolean; client: Client }) {
  const { list, held, isStill } = useStillCards<HTMLDivElement>(true, START_ARM_MS);
  const guard = usePressGuard();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);

  async function start() {
    if (sending.current || !ready || !isStill('start')) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const res = await client.emitWithAck('host:start', undefined);
    sending.current = false;
    setBusy(false);
    if (!res.ok) setError(startFailure(res.error));
  }

  return (
    <div ref={list} className="flex flex-col gap-2">
      {error && <Problem>{error}</Problem>}
      <button
        type="button"
        data-card="start"
        className={PRIMARY}
        disabled={!ready || held.has('start') || busy}
        onPointerDown={() => guard.press(isStill('start') ? 'start' : null)}
        onClick={(e) => {
          if (guard.took('start', e)) void start();
        }}
      >
        {busy ? 'Starting…' : 'Start game'}
      </button>
    </div>
  );
}

export function WaitingRoom({
  room,
  userId,
  ready,
  client,
}: {
  room: PublicRoomState;
  userId: string;
  /** True only after the `room:enter` ack: nothing may be sent before. */
  ready: boolean;
  client: Client;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [value, setValue] = useState(() => String(room.settings.minBuyIn));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [returning, setReturning] = useState<Returning | null>(null);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);

  const hosting = room.hostId === userId;
  const mine = room.seats.find((s) => s?.userId === userId) ?? null;
  const started = room.status !== 'lobby';
  const full = room.seats.every(Boolean);
  const busted = returning?.kind === 'busted';
  const canSit = !mine && !busted && room.status !== 'ended';

  // The selected seat filled up (or we are seated): the form no longer applies.
  if (selected !== null && !busy && (mine !== null || room.seats[selected] !== null)) {
    setSelected(null);
    setError(null);
    if (mine === null) setNotice(`Seat ${selected + 1} was just taken. Pick another.`);
  }
  // What we knew about coming back is spent once we are seated again.
  if (mine !== null && (returning !== null || notice !== null)) {
    setReturning(null);
    setNotice(null);
  }

  function pick(seat: number) {
    setSelected(seat);
    setError(null);
    setNotice(null);
  }

  async function sit() {
    if (selected === null || sending.current || !ready) return;
    let buyIn: number;
    if (returning?.kind === 'exact') {
      buyIn = returning.amount;
    } else {
      const parsed = parseBuyIn(value, room.settings);
      if (!parsed.ok) return setError(parsed.message);
      buyIn = parsed.amount;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    const res = await client.emitWithAck('room:sit', { seat: selected, buyIn });
    sending.current = false;
    setBusy(false);
    if (res.ok) return setSelected(null);
    const back = returningFrom(res.error);
    if (back) {
      setReturning(back);
      if (back.kind === 'busted') setSelected(null);
      return;
    }
    if (res.error.code === 'seat_taken') {
      setSelected(null);
      return setNotice(sitFailure(res.error));
    }
    setError(sitFailure(res.error));
  }

  const online = room.settings.mode === 'online';
  const eligible = room.seats.filter((s) => s && !s.sittingOut && s.stack > 0).length;
  // Not started yet, or play stopped for lack of players (the host starts it again).
  const startable = room.status === 'lobby' || (room.status === 'playing' && room.hand === null);

  const title = started && mine ? 'Game on' : hosting ? "You're hosting" : "You're in";

  function status() {
    if (room.status === 'ended') return <Hint>This game has ended.</Hint>;
    if (busted) {
      return (
        <Problem>
          You left this game with no chips, so you can&apos;t sit back down. Buying more chips
          isn&apos;t available yet.
        </Problem>
      );
    }
    if (online && hosting) {
      return (
        <p className="text-center text-base text-cream">
          Online games can&apos;t start yet: the app can&apos;t deal cards so far.{' '}
          <Link to="/new" className="text-brass underline">
            Create a hybrid room
          </Link>{' '}
          to play with real cards.
        </p>
      );
    }
    if (online) return <Hint>Online games can&apos;t start yet.</Hint>;
    if (hosting && startable) {
      return eligible >= 2 ? (
        <StartButton ready={ready} client={client} />
      ) : (
        <Hint>
          {mine ? '' : 'Pick a seat if you’re playing. '}Start appears when 2 players are seated.
        </Hint>
      );
    }
    if (started) {
      return mine ? null : <Hint>The game has started. Take a seat to join the next hand.</Hint>;
    }
    if (mine) return <Hint>Waiting for the host to start.</Hint>;
    if (full) return <Hint>The table is full.</Hint>;
    return <Hint>Tap an open seat to sit down.</Hint>;
  }

  const blinds = (
    <span data-testid="blinds">
      Blinds {chips(room.settings.smallBlind)} / {chips(room.settings.bigBlind)}
    </span>
  );
  const seats = { room, userId, selected, onPick: canSit ? pick : null };

  return (
    <>
      <div className={`flex flex-1 flex-col gap-2 ${ABOVE_REQUESTS}`}>
        <div
          className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1 ${
            started ? '[[data-testid=entered-room]:has([data-testid=host-inbox])_&]:order-last' : ''
          }`}
        >
          <h1 className={started ? 'sr-only' : 'font-display text-2xl font-semibold text-cream'}>
            {title}
          </h1>
          {started && <p className="text-sm text-brass tabular-nums">{blinds}</p>}
          {started && room.settings.mode === 'hybrid' && <RoomLog log={room.log} />}
          <InviteButton code={room.code} />
        </div>
        {started ? (
          <Table {...seats} />
        ) : (
          <>
            <p className="flex flex-wrap justify-between gap-x-3 text-sm text-brass tabular-nums">
              {blinds}
              <span>Buy-in {buyInRange(room.settings)}</span>
            </p>
            <SeatMap {...seats} />
          </>
        )}
      </div>

      {/* In the lobby a steady height, so what is around it moves as little as possible. */}
      <div className={`flex shrink-0 flex-col justify-end gap-2 pt-2 ${started ? '' : 'min-h-18'}`}>
        {started && <TableSummary room={room} userId={userId} />}
        {notice && <Problem>{notice}</Problem>}
        {selected !== null && canSit ? (
          <BuyInForm
            room={room}
            seat={selected}
            value={value}
            exact={returning?.kind === 'exact' ? returning.amount : null}
            error={error}
            disabled={!ready}
            busy={busy}
            onChange={(v) => {
              setValue(v);
              setError(null);
            }}
            onCancel={() => {
              setSelected(null);
              setError(null);
            }}
            onSubmit={() => void sit()}
          />
        ) : (
          status()
        )}
      </div>
    </>
  );
}
