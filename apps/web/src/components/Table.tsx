/**
 * The table during a game (P39): seats with names, stacks and this street's bets, the pot(s), the
 * dealer button and whose turn it is, all straight from `room:state`. Online it also has the board,
 * card backs for the others still in the hand and the viewer's own cards (P49). Once a hand has
 * ended, the hands the server revealed turn face up on their seats, in its order, and the winners
 * are marked (P50); while an all-in result is held back the room given here is the one `asShown`
 * makes, which has no winners. It only shows; the one thing to tap is an open seat, for someone who
 * may take it.
 *
 * It fills the height its parent can spare (never less than the seats need), so an action bar or
 * the request cards below simply leave it less.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import type { PublicRoomState, PublicSeat, ShownHand } from '@felt/protocol';
import { cardName } from '../lib/cards';
import { winnings } from '../lib/result';
import { chips, shortChips } from '../lib/seating';
import { potName, potTotal, seatPosition, streetName, turnLine } from '../lib/table';
import { turnTimer, type TurnTimer } from '../lib/turnClock';
import { BlindCountdown } from './BlindCountdown';
import { Board } from './cards/Board';
import { HoleCards } from './cards/HoleCards';
import { CardBack, PlayingCard } from './cards/PlayingCard';
import { SeatRing, TurnRing } from './TurnRing';

/** Fixed box, positioned by `seatPosition`. */
const SEAT =
  'absolute flex h-14 w-(--seat-w) flex-col items-center justify-center rounded-xl px-0.5 text-center text-xs leading-tight';

/** Between one revealed hand and the next, in the server's showing order. */
export const REVEAL_STEP_MS = 300;
/** However many hands there are, the last starts to turn within this. */
const REVEAL_SPAN_MS = 900;

type Style = { left: string; top: string };

function place(index: number, count: number): Style {
  const { x, y } = seatPosition(index, count);
  return {
    left: `calc((100% - var(--seat-w)) * ${x})`,
    top: `calc((100% - 3.5rem) * ${y})`,
  };
}

/** On the corner that faces the middle, so it is never clipped at the screen's edge. */
function Dealer({ inward }: { inward: 'left' | 'right' }) {
  return (
    <span
      data-testid="dealer-button"
      aria-hidden="true"
      className={`absolute -top-2.5 flex size-5 items-center justify-center rounded-full border border-felt-950 bg-cream text-xs font-bold text-felt-950 ${
        inward === 'left' ? '-left-1.5' : '-right-1.5'
      }`}
    >
      D
    </span>
  );
}

/** On a seat whose player has dropped: stays readable whatever else the box says. */
export function AwayMark() {
  return (
    <span
      data-testid="away"
      aria-hidden="true"
      className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-chip-red px-1.5 text-[11px] leading-4 font-bold text-felt-950"
    >
      Away
    </span>
  );
}

/** Two backs on the corner that faces out: this player still holds cards. */
function Backs({ inward }: { inward: 'left' | 'right' }) {
  return (
    <span
      data-testid="card-backs"
      aria-hidden="true"
      className={`absolute -top-2.5 flex ${inward === 'left' ? '-right-1' : '-left-1'}`}
    >
      <CardBack className="w-3 -rotate-8" />
      <CardBack className="-ml-1 w-3 rotate-8" />
    </span>
  );
}

/** A revealed hand, in place of the stack: large enough to read, inside the seat's own box. */
function Revealed({ hand, delay }: { hand: ShownHand; delay: number }) {
  return (
    <span
      data-testid="shown-cards"
      className="flex justify-center gap-px"
      style={{ animation: `felt-flip 260ms ease-out ${delay}ms both` }}
    >
      {hand.cards.map((card) => (
        <PlayingCard key={card} card={card} className="w-[1.9375rem]" />
      ))}
    </span>
  );
}

function Player({
  seat,
  me,
  turn,
  dealer,
  inHand,
  over,
  holding,
  timer,
  shown,
  delay,
  won,
  inward,
  style,
}: {
  seat: PublicSeat;
  me: boolean;
  turn: boolean;
  dealer: boolean;
  /** A hand is on screen. */
  inHand: boolean;
  /** The hand has ended: stacks are final, so an all-in loser shows 0. */
  over: boolean;
  /** Online: another player who still has cards. */
  holding: boolean;
  /** The countdown of this seat's turn, if one runs. */
  timer: TurnTimer | null;
  /** This player's hand, face up after an online hand. */
  shown: ShownHand | null;
  /** Before it starts to turn over. */
  delay: number;
  /** Chips won from the ended hand; 0 while it runs or its result is held. */
  won: number;
  inward: 'left' | 'right';
  style: Style;
}) {
  const folded = seat.handStatus === 'folded';
  const allIn = seat.handStatus === 'all_in';
  // One word under the stack when there is no bet to show there.
  const state = folded
    ? 'Folded'
    : !seat.connected
      ? null
      : seat.sittingOut
        ? 'Sitting out'
        : inHand && seat.handStatus === null
          ? 'Waiting'
          : null;
  const label = [
    `Seat ${seat.seat + 1}`,
    seat.username,
    `${chips(seat.stack)} chips`,
    seat.bet > 0 ? `bet ${chips(seat.bet)}` : '',
    me ? 'you' : '',
    dealer ? 'dealer' : '',
    turn ? 'to act' : '',
    folded ? 'folded' : '',
    allIn ? 'all-in' : '',
    seat.sittingOut ? 'sitting out' : '',
    holding ? 'has cards' : '',
    shown ? `shows ${shown.cards.map(cardName).join(' and ')}` : '',
    won > 0 ? `wins ${chips(won)}` : '',
    seat.connected ? '' : 'away',
  ].filter(Boolean);
  const edge = !seat.connected
    ? 'border-dashed border-chip-red'
    : me
      ? 'border-brass'
      : 'border-felt-700';
  const tone = turn
    ? 'border-2 border-cream bg-brass text-felt-950 ring-4 ring-brass/50'
    : shown
      ? // No border: the cards need the room. A ring takes none.
        `bg-felt-950 text-cream ${won > 0 ? 'ring-3 ring-brass' : 'ring-1 ring-felt-700'}`
      : `border-2 bg-felt-950 text-cream ${won > 0 ? 'border-brass ring-3 ring-brass' : edge}`;
  return (
    <li
      data-testid={`seat-${seat.seat}`}
      aria-label={label.join(', ')}
      aria-current={turn ? 'true' : undefined}
      className={`${SEAT} ${tone}`}
      style={style}
    >
      {shown ? (
        <>
          <span
            title={seat.username}
            className={`w-full truncate text-[11px] leading-3 ${
              won > 0 ? 'rounded-t-md bg-brass font-bold text-felt-950' : me ? 'text-brass' : ''
            }`}
          >
            {seat.username}
          </span>
          <Revealed key={shown.cards.join('')} hand={shown} delay={delay} />
        </>
      ) : (
        /* Dimmed inside, so the box still hides the felt behind it. */
        <span
          className={`flex w-full flex-col items-center ${folded || !seat.connected ? 'opacity-50' : ''}`}
        >
          <span
            title={seat.username}
            className={`w-full truncate ${me && !turn ? 'text-brass' : ''} ${turn ? 'font-semibold' : ''}`}
          >
            {seat.username}
          </span>
          <span className="font-semibold tabular-nums">
            {allIn && seat.stack === 0 && !over ? 'All-in' : shortChips(seat.stack)}
          </span>
          {seat.bet > 0 ? (
            <span
              data-testid="bet"
              className={`rounded-full px-1.5 font-semibold tabular-nums ${
                turn ? 'bg-felt-950 text-brass' : 'bg-brass text-felt-950'
              }`}
            >
              {shortChips(seat.bet, 100_000)}
            </span>
          ) : (
            <span className="h-[1lh] whitespace-nowrap">{state}</span>
          )}
        </span>
      )}
      {timer && <SeatRing timer={timer} />}
      {holding && <Backs inward={inward} />}
      {!seat.connected && <AwayMark />}
      {dealer && <Dealer inward={inward} />}
    </li>
  );
}

/** The middle of the felt: street, total pot, each side pot and the next blind level. */
function Middle({ room }: { room: PublicRoomState }) {
  const { hand } = room;
  if (!hand) {
    return (
      <>
        <p className="text-sm text-cream/75">Between hands</p>
        <BlindCountdown room={room} />
      </>
    );
  }
  const online = room.settings.mode === 'online';
  return (
    <>
      <p className="text-sm text-cream/75">{streetName(hand.street)}</p>
      {online && <Board cards={hand.board} />}
      <p data-testid="pot" className="leading-tight">
        {/* One line under the board, to leave the felt its height. */}
        <span
          className={`text-xs tracking-widest text-brass uppercase ${online ? 'mr-2' : 'block'}`}
        >
          Pot
        </span>
        <span
          className={`font-display font-semibold text-cream tabular-nums ${online ? 'text-2xl' : 'text-3xl'}`}
        >
          {shortChips(potTotal(room), 10_000_000)}
        </span>
      </p>
      {/* Once an online hand has ended the result lists the pots; many would not fit here. */}
      {hand.pots.length > 1 &&
        (!hand.outcome || (!hand.outcome.awards.length && hand.pots.length <= 3)) && (
          <ul aria-label="Pots" className="mt-1 flex flex-wrap justify-center gap-x-2 text-xs">
            {hand.pots.map((pot, i) => (
              <li key={pot.id} className="whitespace-nowrap text-cream/75 tabular-nums">
                {potName(i, hand.pots.length)} {shortChips(pot.amount, 100_000)}
              </li>
            ))}
          </ul>
        )}
      <BlindCountdown room={room} />
    </>
  );
}

export function Table({
  room,
  userId,
  selected,
  onPick,
  controls,
  held = false,
  ready = true,
}: {
  room: PublicRoomState;
  userId: string;
  selected: number | null;
  /** Null: the viewer cannot take a seat now, so open seats are not buttons. */
  onPick: ((seat: number) => void) | null;
  /** Laid over the free bottom corners of the felt (sit out, leave). */
  controls?: ReactNode;
  /** An all-in result is still held back (`useShownRoom`). */
  held?: boolean;
  /** False while disconnected: what is on screen may be old, so no countdown. */
  ready?: boolean;
}) {
  const count = room.seats.length;
  const online = room.settings.mode === 'online';
  const timer = ready ? turnTimer(room) : null;
  /** The hand is not over on screen while its result is held back. */
  const over = room.hand?.street === 'ended' && !held;
  const mine = room.seats.findIndex((s) => s?.userId === userId);
  const focus = room.hand?.currentActor ?? (mine < 0 ? null : mine);
  /** What the server revealed of an ended online hand, and who took chips from it. */
  const outcome = online ? room.hand?.outcome : undefined;
  const won = outcome ? winnings(outcome) : null;
  const byRules = outcome?.hands.filter((h) => !h.voluntary) ?? [];
  const stagger = Math.min(REVEAL_STEP_MS, REVEAL_SPAN_MS / Math.max(1, byRules.length - 1));
  const table = useRef<HTMLDivElement>(null);
  // Squeezed (request cards on a short screen) the table's parent scrolls: keep whoever is to act,
  // or else the viewer, in sight. Again whenever the room for it changes.
  useEffect(() => {
    const parent = table.current?.parentElement;
    if (focus === null || !parent) return;
    // Online the board matters most (the turn line below already names who is to act).
    const reveal = () =>
      (
        table.current?.querySelector('[data-testid="board"]') ??
        table.current?.querySelector(`[data-testid="seat-${focus}"]`)
      )?.scrollIntoView?.({ block: 'nearest' });
    reveal();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(reveal);
    watch.observe(parent);
    return () => watch.disconnect();
  }, [focus]);
  return (
    <div
      ref={table}
      data-testid="table"
      // Online the felt is wider and the seats narrower, for the board between them.
      className={`relative max-h-[32rem] min-h-64 flex-1 shrink-0 [--seat-w:4.25rem] ${
        online ? '-mx-2' : 'w-full min-[360px]:[--seat-w:5rem]'
      }`}
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-8 inset-y-7 rounded-[45%] border-4 border-brass-dim bg-felt-800"
      />
      <div
        className={`absolute inset-y-14 flex flex-col items-center justify-center text-center ${
          online ? 'inset-x-[calc(var(--seat-w)+1px)]' : 'inset-x-17 min-[360px]:inset-x-20'
        }`}
      >
        <Middle room={room} />
      </div>
      <ul aria-label="Seats">
        {room.seats.map((seat, i) => {
          const style = place(i, count);
          const inward = seatPosition(i, count).x > 0.5 ? 'left' : 'right';
          const dealer = room.button === i;
          if (seat) {
            const revealed = outcome?.hands.find((h) => h.userId === seat.userId) ?? null;
            return (
              <Player
                key={i}
                seat={seat}
                me={seat.userId === userId}
                turn={room.hand?.currentActor === i}
                dealer={dealer}
                inHand={room.hand !== null}
                over={over}
                shown={revealed}
                // A voluntary show turns over when it is tapped; the rest in showing order.
                delay={revealed && !revealed.voluntary ? byRules.indexOf(revealed) * stagger : 0}
                won={won?.get(seat.userId) ?? 0}
                holding={
                  online &&
                  !over &&
                  !revealed &&
                  seat.userId !== userId &&
                  (seat.handStatus === 'active' || seat.handStatus === 'all_in')
                }
                timer={room.hand?.currentActor === i ? timer : null}
                inward={inward}
                style={style}
              />
            );
          }
          // The button can rest on a seat its player has left.
          const marker = dealer && <Dealer inward={inward} />;
          return (
            <li key={i} data-testid={`seat-${i}`}>
              {onPick ? (
                <button
                  type="button"
                  aria-label={`Take seat ${i + 1}`}
                  aria-pressed={selected === i}
                  className={`${SEAT} border-2 border-dashed active:brightness-90 ${
                    selected === i
                      ? 'border-brass bg-brass font-semibold text-felt-950'
                      : 'border-brass bg-felt-950 text-brass'
                  }`}
                  style={style}
                  onClick={() => onPick(i)}
                >
                  <span className="text-base font-semibold">Sit</span>
                  <span>Seat {i + 1}</span>
                  {marker}
                </button>
              ) : (
                <span
                  className={`${SEAT} border-2 border-dashed border-felt-700 text-cream/40`}
                  style={style}
                >
                  Open
                  {marker}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {controls}
    </div>
  );
}

function Figure({ label, value, id }: { label: ReactNode; value: string; id: string }) {
  return (
    <div data-testid={id} className="flex min-w-0 items-baseline gap-2">
      <dt className="text-xs text-cream/75">{label}</dt>
      <dd className="text-lg font-semibold text-cream tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Below the felt and outside anything that scrolls: whose turn it is (with the time left, if timed)
 * and, for a seated player, the pot and their stack (PRD: never hide money), beside their own cards
 * in an online hand. The amount to call is on the action bar.
 */
export function TableSummary({
  room,
  userId,
  action,
  ready = true,
}: {
  room: PublicRoomState;
  userId: string;
  /** Beside the figures of a seated player (Buy more). */
  action?: ReactNode;
  /** False while disconnected: whose turn it is may have changed since. */
  ready?: boolean;
}) {
  const me = room.seats.find((s) => s?.userId === userId) ?? null;
  const line = ready ? turnLine(room, userId) : 'Waiting for the connection';
  const money = (n: number) => shortChips(n, 10_000_000);
  const timer = ready ? turnTimer(room) : null;
  const { hand } = room;
  /** Turns here have a clock: the room's timer, or one put on for a pending removal or end. */
  const timed = room.settings.turnTimerSeconds !== null || room.ending === true || timer !== null;
  /** An online hand has ended: the result banner is up. */
  const resulted = room.settings.mode === 'online' && hand?.outcome !== undefined;
  /** The banner says it better: these words give up their room. */
  // Also once play has stopped: the words below the figures say why.
  const stopped = ready && room.status === 'playing' && hand === null;
  const quiet = stopped || (resulted && (line === 'Hand over' || line === 'Dealing…'));
  const holding =
    room.settings.mode === 'online' && hand && me && me.handStatus !== null ? hand : null;
  const words = (
    <p
      role="status"
      data-testid="turn-line"
      className={
        quiet
          ? 'sr-only'
          : line === 'Your turn'
            ? 'text-xl font-bold text-brass'
            : `min-w-0 wrap-anywhere text-cream ${
                // Beside the cards there is less width: a long name takes two lines at most.
                holding ? 'line-clamp-2 text-sm leading-tight' : 'text-base'
              }`
      }
    >
      {line}
    </p>
  );
  const figures = me && (
    <div className="flex items-center gap-2">
      <dl className="flex min-w-0 flex-1 flex-wrap justify-center gap-x-3 rounded-xl bg-felt-950 px-1">
        <Figure id="my-pot" label="Pot" value={money(potTotal(room))} />
        <Figure
          id="my-stack"
          label={
            // "Stack" where it is narrow, so Buy more fits beside it on one line.
            <>
              <span className={holding ? 'sr-only' : 'max-[359px]:sr-only'}>Your </span>
              <span className={holding ? 'capitalize' : 'max-[359px]:capitalize'}>stack</span>
            </>
          }
          value={money(me.stack)}
        />
      </dl>
      {action}
    </div>
  );
  const status = (
    <div
      className={`flex min-w-0 flex-1 flex-col justify-center text-center ${quiet ? '' : 'gap-1'}`}
    >
      {/* A timed room keeps the ring's height, so nothing shifts from turn to turn. */}
      <div
        className={`flex items-center justify-center gap-2 ${
          !timed || resulted || stopped ? '' : 'min-h-9'
        }`}
      >
        {words}
        {timer && <TurnRing timer={timer} />}
      </div>
      {figures}
    </div>
  );
  if (!holding) return status;
  return (
    <div className="flex items-center gap-2">
      <HoleCards handId={holding.handId} folded={me!.handStatus === 'folded'} />
      {status}
    </div>
  );
}
