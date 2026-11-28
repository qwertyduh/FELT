/**
 * The room once admitted (P38, P39): the seat map in the lobby and the table once the game has
 * started, plus buy-in and the host's Start. People without a seat (late joiners, returners) take
 * one from either. Everything sits in normal flow (nothing floats over the host's request cards
 * below). Nothing is sent before `ready`, and every send waits for its ack; the seats themselves
 * only ever change through `room:state`.
 *
 * The hand-rank and chat buttons are rendered from here, which knows what the table shows, into the
 * header. The open chat panel takes the place of the top part; a turn or a proposed award arriving
 * closes it.
 *
 * Renders two siblings: a top part that gives up height (and scrolls) when the request cards are
 * up, and a footer that stays whole, so Start and the buy-in panel are never pushed out of view.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { PublicRoomState } from '@felt/protocol';
import { setChatOpen, useRoomStore } from '../lib/realtime/roomStore';
import type { SocketClient } from '../lib/realtime/socketClient';
import { satOutByClock } from '../lib/satOut';
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
import { useShownRoom } from '../lib/useShownRoom';
import { useStillCards } from '../lib/useStillCards';
import { useTurnSignal } from '../lib/useTurnSignal';
import { BuyMore } from './BuyMore';
import { ChatButton } from './chat/ChatButton';
import { ChatPanel } from './chat/ChatPanel';
import { ChatPreview } from './chat/ChatPreview';
import { InHeader } from './hand-ranks/headerSlot';
import { TableHandRanks } from './hand-ranks/TableHandRanks';
import { RoomLog } from './hybrid/RoomLog';
import { InviteButton } from './InviteButton';
import { ResultBanner } from './ResultBanner';
import { SeatControls } from './SeatControls';
import { SeatMap } from './SeatMap';
import { Table, TableSummary } from './Table';
import { TableNotices } from './TableNotices';

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

/** Small: it shares a short screen with the table, a sat-out notice and the action bar. */
const Stopped = ({ children }: { children: React.ReactNode }) => (
  <p data-testid="stopped" className="text-center text-sm leading-tight text-cream">
    {children}
  </p>
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
  /** The only amount allowed (returning player; 0 if they left busted), or null. */
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
      {exact !== null && exact > 0 && (
        <p id="buy-in-range" className="text-sm text-cream">
          You sit back down with your whole cash out, now{' '}
          <strong className="text-brass">{chips(exact)}</strong> chips.
        </p>
      )}
      {exact === 0 && (
        <p id="buy-in-range" className="text-sm text-cream">
          Your cash out is 0 chips now. Sit down with <strong className="text-brass">0</strong>,
          then tap Buy more to ask the host for chips.
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
  useTurnSignal(room, userId);
  // What the table says: an all-in run-out is dealt street by street before its result.
  const { room: shown, held } = useShownRoom(room, ready);

  const hosting = room.hostId === userId;
  const mine = room.seats.find((s) => s?.userId === userId) ?? null;
  const chatting = useRoomStore((s) => s.chatOpen) && room.status !== 'ended';
  const live = room.status === 'playing' && room.hand && room.hand.street !== 'ended';
  const hand = live ? room.hand! : null;
  const myTurn = mine !== null && hand?.currentActor === mine.seat;
  /** What must not be missed under an open chat: our turn, or an award with its short window. */
  const urgent = hand && (myTurn || hand.pendingAwards.length > 0);
  const urgentKey = urgent ? `${hand.handId}:${hand.street}:${myTurn}` : null;
  // Only as it arrives: the panel may still be opened during a turn.
  useLayoutEffect(() => {
    if (urgentKey !== null) setChatOpen(false);
  }, [urgentKey]);
  const started = room.status !== 'lobby';
  const full = room.seats.every(Boolean);
  /** The only amount a returning player may sit with: what they left with (0 if busted). */
  const exact = returning === null ? null : returning.kind === 'exact' ? returning.amount : 0;
  // Not during a run-out: someone cashed out by that hand is told what they must sit back down with.
  // Nor in a game that is ending: no further hand will be dealt.
  const removing = room.removals?.includes(userId) ?? false;
  const canSit = !mine && room.status !== 'ended' && !held && !room.ending && !removing;

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
    if (exact !== null) {
      buyIn = exact;
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
    if (res.ok) {
      // Seated: what we were told about coming back is spent, whatever happens next.
      setReturning(null);
      setNotice(null);
      return setSelected(null);
    }
    const back = returningFrom(res.error);
    if (back) return setReturning(back);
    if (res.error.code === 'seat_taken') {
      setSelected(null);
      return setNotice(sitFailure(res.error));
    }
    setError(sitFailure(res.error));
  }

  // Approved top-ups are added before the hand is dealt, so they count.
  const eligible = room.seats.filter(
    (s) => s && !s.sittingOut && (s.stack > 0 || (room.pendingTopUps[s.userId] ?? 0) > 0),
  ).length;
  // Play stopped for lack of players: only the host can start it again.
  const stopped = room.status === 'playing' && room.hand === null && !room.ending;
  // Not started yet, or stopped.
  const startable = room.status === 'lobby' || stopped;

  const title = started && mine ? 'Game on' : hosting ? "You're hosting" : "You're in";

  function status() {
    if (room.status === 'ended') return <Hint>This game has ended.</Hint>;
    if (stopped) {
      if (!hosting) {
        return (
          <Stopped>
            {eligible >= 2
              ? 'Play has stopped. Waiting for the host to tap Start game.'
              : 'Play has stopped: fewer than 2 players are ready. The host can start again once 2 are.'}
          </Stopped>
        );
      }
      return eligible >= 2 ? (
        <>
          <Stopped>Play has stopped. Tap Start game to deal again.</Stopped>
          <StartButton ready={ready} client={client} />
        </>
      ) : (
        <Stopped>
          Play has stopped. Get 2 players ready (back, topped up or seated), then tap Start game
          here.
        </Stopped>
      );
    }
    if (hosting && startable) {
      return eligible >= 2 ? (
        <StartButton ready={ready} client={client} />
      ) : (
        <Hint>
          {mine ? '' : 'Pick a seat if you’re playing. '}Start appears when 2 players are seated.
        </Hint>
      );
    }
    // No seat to offer: the notice above says why.
    if (!mine && (room.ending || removing)) return null;
    if (started) {
      return mine ? null : <Hint>The game has started. Take a seat to join the next hand.</Hint>;
    }
    if (mine) return <Hint>Waiting for the host to start.</Hint>;
    if (full) return <Hint>The table is full.</Hint>;
    return <Hint>Tap an open seat to sit down.</Hint>;
  }

  const { nextBlinds } = room;
  const blinds = (
    <span data-testid="blinds">
      Blinds {chips(room.settings.smallBlind)} / {chips(room.settings.bigBlind)}
      {nextBlinds && (
        <span data-testid="next-blinds" className="block text-xs text-cream">
          Next hand {chips(nextBlinds.smallBlind)} / {chips(nextBlinds.bigBlind)}
        </span>
      )}
    </span>
  );
  const shownMine = shown.seats.find((s) => s?.userId === userId) ?? null;
  const seats = { room: shown, userId, selected, onPick: canSit ? pick : null };
  const seatControls = (place: 'table' | 'map') =>
    mine &&
    room.status !== 'ended' && (
      <SeatControls
        room={room}
        me={mine}
        ready={ready}
        client={client}
        place={place}
        held={held}
        noToggle={satOutByClock(room, mine)}
      />
    );
  /** An online hand has ended: its result takes the blinds row's place until the next deal. */
  const result = started && room.settings.mode === 'online' && shown.hand?.outcome !== undefined;
  /** A notice above or below the figures takes height from the felt. */
  const noticed =
    stopped || room.ending === true || removing || (mine !== null && satOutByClock(room, mine));
  /**
   * The line gives up its place to a result. Paused it can last: on a screen with room to spare the
   * line (and Invite) comes back. A notice costs it only on a short screen.
   */
  const short = 'hidden [@media(min-height:640px)]:flex';
  const rowClass = result ? (room.paused && !noticed ? short : 'hidden') : noticed ? short : 'flex';
  // Chips bought now could never be dealt in a game that is ending, or to a player being removed.
  const buyMore = mine && room.status !== 'ended' && !room.ending && !removing && (
    <BuyMore
      room={shown}
      me={shownMine!}
      ready={ready}
      client={client}
      compact={started}
      held={held}
    />
  );

  return (
    <>
      {room.status !== 'ended' && (
        <InHeader>
          {/* The room as shown: a run-out must not be given away. */}
          <TableHandRanks room={shown} userId={userId} ready={ready} />
          <ChatButton userId={userId} />
        </InHeader>
      )}
      {chatting && (
        <ChatPanel room={room} me={mine} myTurn={myTurn} ready={ready} client={client} />
      )}
      {/* Hidden, not removed, while the chat has its place. */}
      <div className={`flex-1 flex-col gap-2 ${chatting ? 'hidden' : 'flex'} ${ABOVE_REQUESTS}`}>
        {result && <ResultBanner room={shown} userId={userId} held={held} />}
        <div
          className={`${rowClass} relative flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1 ${
            started ? '[[data-testid=entered-room]:has([data-testid=host-inbox])_&]:order-last' : ''
          }`}
        >
          <h1 className={started ? 'sr-only' : 'font-display text-2xl font-semibold text-cream'}>
            {title}
          </h1>
          {started && <p className="text-sm text-brass tabular-nums">{blinds}</p>}
          {started && room.settings.mode === 'hybrid' && <RoomLog log={room.log} />}
          <InviteButton code={room.code} />
          {room.settings.mode === 'online' && !chatting && <ChatPreview userId={userId} />}
        </div>
        {started ? (
          <Table {...seats} held={held} ready={ready} controls={seatControls('table')} />
        ) : (
          <>
            <p className="flex flex-wrap justify-between gap-x-3 text-sm text-brass tabular-nums">
              {blinds}
              <span>Buy-in {buyInRange(room.settings)}</span>
            </p>
            <SeatMap {...seats} controls={seatControls('map')} />
          </>
        )}
      </div>

      {/* In the lobby a steady height, so what is around it moves as little as possible. */}
      <div className={`flex shrink-0 flex-col justify-end gap-2 pt-2 ${started ? '' : 'min-h-18'}`}>
        <TableNotices room={room} userId={userId} me={mine} ready={ready} client={client} />
        {started && <TableSummary room={shown} userId={userId} ready={ready} action={buyMore} />}
        {notice && <Problem>{notice}</Problem>}
        {selected !== null && canSit ? (
          <BuyInForm
            room={room}
            seat={selected}
            value={value}
            exact={exact}
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
        ) : !started && buyMore ? (
          // Side by side: a short screen with a request card has no height to spare.
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">{status()}</div>
            {buyMore}
          </div>
        ) : (
          status()
        )}
      </div>
    </>
  );
}
