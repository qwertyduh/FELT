/**
 * The player's moves (P40), last on the screen so nothing above can move it. A fixed height whether
 * or not it is their turn. Bet sizing opens as a sheet laid over what is above (`data-cover`), so
 * the request cards never move; they take no taps while covered.
 *
 * Money safety: a button takes no taps until it has been in place for `ACTION_ARM_MS` (new on
 * every turn, and after the sheet opens or closes), a tap must begin on it, and every send quotes
 * the `turnSeq` it was made for and waits for its ack.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { PublicHand, PublicRoomState, PublicSeat, TurnOptions } from '@felt/protocol';
import {
  actFailure,
  actPayload,
  POT_PRESETS,
  potSized,
  sizedMove,
  type Move,
  type RaiseOptions,
} from '../lib/actions';
import type { SocketClient } from '../lib/realtime/socketClient';
import { chips, shortChips } from '../lib/seating';
import { potTotal, toCall } from '../lib/table';
import { usePressGuard } from '../lib/usePressGuard';
import { useStillCards } from '../lib/useStillCards';

export const ACTION_ARM_MS = 400;
export const ACTION_NOTICE_MS = 4_000;

const BUTTON =
  'flex min-h-12 min-w-0 flex-col items-center justify-center rounded-xl px-1 text-base leading-tight font-semibold active:brightness-90 disabled:opacity-40';
const OUTLINE = `${BUTTON} border border-brass text-brass`;
const SOLID = `${BUTTON} bg-brass text-felt-950`;

type Tap = (id: string) => {
  'data-card': string;
  disabled: boolean;
  onPointerDown: () => void;
  onClick: (e: MouseEvent) => void;
};

const money = (n: number) => shortChips(n, 100_000_000);

function SizeSheet({
  raise,
  pot,
  currentBet,
  call,
  stack,
  turnKey,
  tap,
  onBack,
  onSend,
}: {
  raise: RaiseOptions;
  pot: number;
  currentBet: number;
  call: number;
  stack: number;
  turnKey: string;
  tap: (id: string, run: () => void) => ReturnType<Tap>;
  onBack: () => void;
  onSend: (move: Move) => void;
}) {
  const [amount, setAmount] = useState(raise.min);
  const allIn = amount >= raise.max;
  const sizes = [
    ...POT_PRESETS.map((p) => ({
      ...p,
      to: potSized(p.share, { raise, pot, currentBet, call }),
    })),
    { label: 'All-in', name: 'All-in', to: raise.max },
  ];
  const label = allIn ? 'All-in' : raise.type === 'bet' ? 'Bet' : 'Raise to';
  return (
    <div
      data-cover
      data-testid="size-sheet"
      role="group"
      aria-label={raise.type === 'bet' ? 'Bet size' : 'Raise size'}
      className="absolute -inset-x-2 bottom-0 z-10 flex flex-col gap-2 rounded-t-2xl border-t-2 border-brass-dim bg-felt-950 px-2 pt-2"
    >
      <p className="flex flex-wrap justify-between gap-x-3 text-sm text-cream/75 tabular-nums">
        <span>Pot {money(pot)}</span>
        <span>Stack {money(stack)}</span>
        <span>To call {money(call)}</span>
      </p>
      <p data-testid="size-amount" className="text-center text-2xl font-semibold text-cream">
        <span className="tabular-nums">{chips(amount)}</span>
      </p>
      {raise.min < raise.max && (
        <>
          <input
            type="range"
            aria-label="Amount"
            aria-valuetext={chips(amount)}
            min={raise.min}
            max={raise.max}
            step={1}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="h-11 w-full accent-brass"
          />
          <div className="grid grid-cols-4 gap-2">
            {sizes.map((s) => (
              <button
                key={s.name}
                type="button"
                aria-label={s.name}
                aria-pressed={amount === s.to}
                className={`min-h-11 rounded-xl border text-base font-semibold ${
                  amount === s.to
                    ? 'border-brass bg-felt-700 text-cream'
                    : 'border-felt-700 text-brass'
                }`}
                onClick={() => setAmount(s.to)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="grid grid-cols-3 gap-2">
        <button key={`back:${turnKey}`} type="button" className={OUTLINE} onClick={onBack}>
          Back
        </button>
        <button
          key={`confirm:${turnKey}`}
          type="button"
          className={`${SOLID} col-span-2 tabular-nums`}
          {...tap(`confirm:${turnKey}`, () => onSend(sizedMove(raise, amount)))}
        >
          {label} {chips(amount)}
        </button>
      </div>
    </div>
  );
}

export function ActionBar({
  room,
  me,
  ready,
  client,
}: {
  room: PublicRoomState;
  me: PublicSeat;
  /** True only after the `room:enter` ack: nothing may be sent before. */
  ready: boolean;
  client: Pick<SocketClient, 'emitWithAck'>;
}) {
  const { hand } = room;
  const turn: { hand: PublicHand; options: TurnOptions } | null =
    hand?.options && hand.currentActor === me.seat && !room.paused && room.status === 'playing'
      ? { hand, options: hand.options }
      : null;
  const turnKey = hand ? `${hand.handId}:${hand.turnSeq}` : '';
  const owed = toCall(hand, me);

  /** The turn the sizing sheet was opened for: any change to the hand closes it. */
  const [sizing, setSizing] = useState<string | null>(null);
  /** The turn already answered (or being answered): its buttons stay off. */
  const [sent, setSent] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string } | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), ACTION_NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);

  const { list, held, isStill } = useStillCards<HTMLElement>(turn !== null, ACTION_ARM_MS);
  const guard = usePressGuard();

  async function send(move: Move) {
    if (!turn || !ready || sending.current) return;
    sending.current = true;
    setSent(turnKey);
    setNotice(null);
    const res = await client.emitWithAck(
      'game:act',
      actPayload(turn.hand.handId, turn.hand.turnSeq, move),
    );
    sending.current = false;
    if (res.ok) return setSizing(null);
    // Safe to try again: if it did land, the same turnSeq is refused.
    setSent(null);
    setNotice({ text: actFailure(res.error) });
  }

  const off = !ready || sent === turnKey;
  const tap = (id: string, run: () => void): ReturnType<Tap> => ({
    'data-card': id,
    disabled: off || held.has(id),
    onPointerDown: () => guard.press(isStill(id) ? id : null),
    onClick: (e) => {
      if (guard.took(id, e) && isStill(id)) run();
    },
  });
  const button = (name: string, className: string, run: () => void, amount?: number) => {
    const id = `${name}:${turnKey}`;
    return (
      <button key={id} type="button" className={className} {...tap(id, run)}>
        <span>{name}</span>
        {amount !== undefined && <span className="text-sm tabular-nums">{money(amount)}</span>}
      </button>
    );
  };

  const raise = turn?.options.raise ?? null;
  const open = raise !== null && sizing === turnKey;
  const call = turn?.options.call ?? null;

  return (
    <section
      ref={list}
      aria-label="Actions"
      data-testid="action-bar"
      className="relative flex h-18 shrink-0 flex-col pt-1"
    >
      <p className="h-5 truncate text-center text-sm">
        {notice ? (
          <span role="alert" className="text-chip-red">
            {notice.text}
          </span>
        ) : (
          <span data-testid="my-call" className="text-cream tabular-nums">
            To call {owed === null ? '–' : money(owed)}
          </span>
        )}
      </p>
      {turn && !open && (
        <div className="grid grid-cols-3 gap-2">
          {button('Fold', OUTLINE, () => void send({ type: 'fold' }))}
          {turn.options.check && button('Check', SOLID, () => void send({ type: 'check' }))}
          {call !== null &&
            button(
              call >= me.stack ? 'All-in' : 'Call',
              SOLID,
              () => void send({ type: 'call' }),
              call,
            )}
          {raise &&
            button(
              raise.min === raise.max ? 'All-in' : raise.type === 'bet' ? 'Bet' : 'Raise',
              OUTLINE,
              () => setSizing(turnKey),
            )}
        </div>
      )}
      {turn && open && (
        <SizeSheet
          key={turnKey}
          raise={raise}
          pot={potTotal(room)}
          currentBet={turn.hand.currentBet}
          call={call ?? 0}
          stack={me.stack}
          turnKey={turnKey}
          tap={tap}
          onBack={() => setSizing(null)}
          onSend={(move) => void send(move)}
        />
      )}
    </section>
  );
}
