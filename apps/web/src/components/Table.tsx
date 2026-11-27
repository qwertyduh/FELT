/**
 * The table during a game (P39): seats with names, stacks and this street's bets, the pot(s), the
 * dealer button and whose turn it is, all straight from `room:state`. It only shows; the one thing
 * to tap is an open seat, for someone who may take it.
 *
 * It fills the height its parent can spare (never less than the seats need), so an action bar or
 * the request cards below simply leave it less.
 */
import type { PublicRoomState, PublicSeat } from '@felt/protocol';
import { chips, shortChips } from '../lib/seating';
import { potTotal, seatPosition, streetName, turnLine } from '../lib/table';

/** Fixed box, positioned by `seatPosition`. */
const SEAT =
  'absolute flex h-14 w-17 flex-col items-center justify-center rounded-xl px-0.5 text-center text-xs leading-tight min-[360px]:w-20';

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

function Player({
  seat,
  me,
  turn,
  dealer,
  inHand,
  over,
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
  inward: 'left' | 'right';
  style: Style;
}) {
  const folded = seat.handStatus === 'folded';
  const allIn = seat.handStatus === 'all_in';
  // One word under the stack when there is no bet to show there.
  const state = folded
    ? 'Folded'
    : !seat.connected
      ? 'Away'
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
    seat.connected ? '' : 'away',
  ].filter(Boolean);
  const tone = turn
    ? 'border-cream bg-brass text-felt-950 ring-4 ring-brass/50'
    : `bg-felt-950 text-cream ${me ? 'border-brass' : 'border-felt-700'}`;
  return (
    <li
      data-testid={`seat-${seat.seat}`}
      aria-label={label.join(', ')}
      aria-current={turn ? 'true' : undefined}
      className={`${SEAT} border-2 ${tone}`}
      style={style}
    >
      {/* Dimmed inside, so the box still hides the felt behind it. */}
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
      {dealer && <Dealer inward={inward} />}
    </li>
  );
}

/** The middle of the felt: street, total pot and, once there are side pots, each pot. */
function Middle({ room }: { room: PublicRoomState }) {
  const { hand } = room;
  if (!hand) return <p className="text-sm text-cream/75">Between hands</p>;
  return (
    <>
      <p className="text-sm text-cream/75">{streetName(hand.street)}</p>
      <p data-testid="pot" className="leading-tight">
        <span className="block text-xs tracking-widest text-brass uppercase">Pot</span>
        <span className="font-display text-3xl font-semibold text-cream tabular-nums">
          {shortChips(potTotal(room), 10_000_000)}
        </span>
      </p>
      {hand.pots.length > 1 && (
        <ul aria-label="Pots" className="mt-1 flex flex-wrap justify-center gap-x-2 text-xs">
          {hand.pots.map((pot, i) => (
            <li key={pot.id} className="whitespace-nowrap text-cream/75 tabular-nums">
              {i === 0 ? 'Main' : `Side ${i}`} {shortChips(pot.amount, 100_000)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function Table({
  room,
  userId,
  selected,
  onPick,
}: {
  room: PublicRoomState;
  userId: string;
  selected: number | null;
  /** Null: the viewer cannot take a seat now, so open seats are not buttons. */
  onPick: ((seat: number) => void) | null;
}) {
  const count = room.seats.length;
  return (
    <div
      data-testid="table"
      className="relative max-h-[32rem] min-h-64 w-full flex-1 shrink-0 [--seat-w:4.25rem] min-[360px]:[--seat-w:5rem]"
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-8 inset-y-7 rounded-[45%] border-4 border-brass-dim bg-felt-800"
      />
      <div className="absolute inset-x-17 inset-y-14 flex flex-col items-center justify-center text-center min-[360px]:inset-x-20">
        <Middle room={room} />
      </div>
      <ul aria-label="Seats">
        {room.seats.map((seat, i) => {
          const style = place(i, count);
          const inward = seatPosition(i, count).x > 0.5 ? 'left' : 'right';
          const dealer = room.button === i;
          if (seat) {
            return (
              <Player
                key={i}
                seat={seat}
                me={seat.userId === userId}
                turn={room.hand?.currentActor === i}
                dealer={dealer}
                inHand={room.hand !== null}
                over={room.hand?.street === 'ended'}
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
    </div>
  );
}

function Figure({ label, value, id }: { label: string; value: string; id: string }) {
  return (
    <div data-testid={id} className="flex min-w-0 items-baseline gap-2">
      <dt className="text-xs text-cream/75">{label}</dt>
      <dd className="text-lg font-semibold text-cream tabular-nums">{value}</dd>
    </div>
  );
}

/**
 * Below the felt and outside anything that scrolls: whose turn it is and, for a seated player, the
 * pot and their stack (PRD: never hide money). The amount to call is on the action bar.
 */
export function TableSummary({ room, userId }: { room: PublicRoomState; userId: string }) {
  const me = room.seats.find((s) => s?.userId === userId) ?? null;
  const line = turnLine(room, userId);
  const money = (n: number) => shortChips(n, 10_000_000);
  return (
    <div className="flex flex-col gap-1 text-center">
      <p
        role="status"
        data-testid="turn-line"
        className={
          line === 'Your turn'
            ? 'text-xl font-bold text-brass'
            : 'text-base wrap-anywhere text-cream'
        }
      >
        {line}
      </p>
      {me && (
        <dl className="flex flex-wrap justify-center gap-x-6 rounded-xl bg-felt-950 px-2">
          <Figure id="my-pot" label="Pot" value={money(potTotal(room))} />
          <Figure id="my-stack" label="Your stack" value={money(me.stack)} />
        </dl>
      )}
    </div>
  );
}
