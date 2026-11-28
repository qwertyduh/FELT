/**
 * The seats around an oval felt (P38). Seat 1 is nearest the thumb, numbers run clockwise. Open
 * seats are buttons only while the viewer may take one.
 */
import type { PublicRoomState, PublicSeat } from '@felt/protocol';
import { chips, shortChips } from '../lib/seating';
import { ReactionBubble } from './chat/ReactionBubble';
import { AwayMark } from './Table';

/** Fixed box so nine seats never overlap on a 320px screen. */
const SEAT =
  'absolute flex h-13 w-17 flex-col items-center justify-center rounded-xl px-1 text-center text-xs leading-tight min-[360px]:w-20';
const WIDTH = 'var(--seat-w)';

/** Where the seat sits on the ellipse; the box stays inside the map at both extremes. */
function place(index: number, count: number) {
  const angle = Math.PI / 2 + (index * 2 * Math.PI) / count;
  const x = (1 + Math.cos(angle)) / 2;
  const y = (1 + Math.sin(angle)) / 2;
  return {
    left: `calc((100% - ${WIDTH}) * ${x.toFixed(4)})`,
    top: `calc((100% - 3.25rem) * ${y.toFixed(4)})`,
  };
}

function Taken({
  seat,
  me,
  host,
  style,
}: {
  seat: PublicSeat;
  me: boolean;
  host: boolean;
  style: { left: string; top: string };
}) {
  const tags = [
    me ? 'you' : '',
    host ? 'host' : '',
    seat.sittingOut ? 'sitting out' : '',
    seat.connected ? '' : 'away',
  ].filter(Boolean);
  return (
    <li
      data-testid={`seat-${seat.seat}`}
      aria-label={[
        `Seat ${seat.seat + 1}`,
        seat.username,
        `${chips(seat.stack)} chips`,
        ...tags,
      ].join(', ')}
      className={`${SEAT} border-2 bg-felt-950 ${
        !seat.connected ? 'border-dashed border-chip-red' : me ? 'border-brass' : 'border-felt-700'
      }`}
      style={style}
    >
      <span
        className={`line-clamp-2 w-full break-all ${me ? 'text-brass' : 'text-cream'} ${
          seat.connected ? '' : 'opacity-60'
        }`}
      >
        {seat.username}
      </span>
      <span className="text-cream/75 tabular-nums">{shortChips(seat.stack)}</span>
      {!seat.connected && <AwayMark />}
      <ReactionBubble userId={seat.userId} />
    </li>
  );
}

export function SeatMap({
  room,
  userId,
  selected,
  onPick,
  controls,
}: {
  room: PublicRoomState;
  userId: string;
  selected: number | null;
  /** Null: the viewer cannot take a seat now, so open seats are not buttons. */
  onPick: ((seat: number) => void) | null;
  /** In the free middle of the felt (sit out, leave). */
  controls?: React.ReactNode;
}) {
  const count = room.seats.length;
  const taken = room.seats.filter(Boolean).length;
  return (
    <div className="relative h-80 w-full shrink-0 [--seat-w:4.25rem] min-[360px]:[--seat-w:5rem]">
      <div
        aria-hidden="true"
        className="absolute inset-x-12 inset-y-9 rounded-[50%] border-4 border-brass-dim bg-felt-800"
      />
      <p className="absolute inset-0 flex items-center justify-center text-sm text-cream/75 tabular-nums">
        {taken} of {count} seated
      </p>
      <ul aria-label="Seats">
        {room.seats.map((seat, i) => {
          const style = place(i, count);
          if (seat) {
            return (
              <Taken
                key={i}
                seat={seat}
                me={seat.userId === userId}
                host={seat.userId === room.hostId}
                style={style}
              />
            );
          }
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
                      : 'border-brass bg-felt-950/70 text-brass'
                  }`}
                  style={style}
                  onClick={() => onPick(i)}
                >
                  <span className="text-base font-semibold">Sit</span>
                  <span>Seat {i + 1}</span>
                </button>
              ) : (
                <span
                  className={`${SEAT} border-2 border-dashed border-felt-700 text-cream/40`}
                  style={style}
                >
                  Open
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
