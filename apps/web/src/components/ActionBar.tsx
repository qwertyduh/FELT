/**
 * The player's moves (P40) and, in hybrid, the host's controls and the award banner (P41), last on
 * the screen so nothing above can move it. A fixed height whatever it holds. The host only has a
 * step to take when nobody is on turn, so the two never want the buttons at once. Sizing, cards,
 * winners and the proposed award open as sheets laid over what is above (`data-cover`), so the
 * request cards never move; they take no taps while covered.
 *
 * In hybrid the host's bar has one more line, always there, with Undo and Fix stack (P42). While
 * the game is paused (P44) nothing can be done here; the host's button row holds Resume. With the
 * turn timer off, the host's button row offers to fold a disconnected player on turn (P45), behind
 * a sheet that names them.
 *
 * After an online hand, a player whose cards were not revealed has one button here: Show, in the
 * right-hand column so that a repeated tap on Check or Call cannot land on it (P50).
 *
 * Money safety: a button takes no taps until it has been in place for `ACTION_ARM_MS` (new on
 * every change to the hand, and after a sheet opens or closes), a tap must begin on it, and every
 * send quotes the `turnSeq` it was made for and waits for its ack.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type {
  CardString,
  ClientEventName,
  PublicHand,
  PublicRoomState,
  PublicSeat,
  TurnOptions,
} from '@felt/protocol';
import {
  actFailure,
  actPayload,
  POT_PRESETS,
  potSized,
  sizedMove,
  type Move,
  type RaiseOptions,
} from '../lib/actions';
import { OUTLINE, SHEET, SOLID, type Tap } from '../lib/actionUi';
import { DEALS, hostStep } from '../lib/hybrid';
import { useRoomStore } from '../lib/realtime/roomStore';
import type { AckResult, SocketClient } from '../lib/realtime/socketClient';
import { chips, shortChips } from '../lib/seating';
import { absentActor, potTotal, toCall } from '../lib/table';
import { turnTimer, type TurnTimer } from '../lib/turnClock';
import { usePressGuard } from '../lib/usePressGuard';
import { useStillCards } from '../lib/useStillCards';
import { HoleCards } from './cards/HoleCards';
import { AdjustSheet } from './hybrid/AdjustSheet';
import { AwardBanner } from './hybrid/AwardBanner';
import { AwardSheet } from './hybrid/AwardSheet';
import { CardSheet } from './hybrid/CardSheet';
import { ForceFoldSheet } from './ForceFoldSheet';
import { UndoSheet } from './hybrid/UndoSheet';
import { TurnRing } from './TurnRing';

export const ACTION_ARM_MS = 400;
export const ACTION_NOTICE_MS = 4_000;

const money = (n: number) => shortChips(n, 100_000_000);
const TOOL =
  'min-h-11 w-18 shrink-0 rounded-xl border border-felt-700 text-sm font-semibold text-brass active:brightness-90 disabled:text-cream/30';

type SheetKind = 'size' | 'cards' | 'award' | 'undo' | 'adjust' | 'absent';

function SizeSheet({
  raise,
  pot,
  currentBet,
  call,
  stack,
  turnKey,
  tap,
  bet,
  notice,
  cards,
  timer,
  ready,
  onBack,
  onSend,
}: {
  raise: RaiseOptions;
  pot: number;
  currentBet: number;
  call: number;
  stack: number;
  turnKey: string;
  tap: Tap;
  /** Already in on this street: the total less this is what the move puts in. */
  bet: number;
  notice: ReactNode;
  /** Online: the player's own cards, which the sheet lies over. */
  cards: ReactNode;
  /** The countdown, which it lies over too. */
  timer: TurnTimer | null;
  ready: boolean;
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
  const label = allIn ? 'All-in to' : raise.type === 'bet' ? 'Bet' : 'Raise to';
  return (
    <div
      data-cover
      data-testid="size-sheet"
      role="group"
      aria-label={raise.type === 'bet' ? 'Bet size' : 'Raise size'}
      className={SHEET}
    >
      {notice}
      <p className="flex flex-wrap justify-between gap-x-3 text-sm text-cream/75 tabular-nums">
        <span>Pot {money(pot)}</span>
        <span>Stack {money(stack)}</span>
        <span>To call {money(call)}</span>
      </p>
      {/* Beside the amount, so the sheet grows as little as it can over the board. */}
      <div className="flex items-center gap-2">
        {cards}
        <div className="min-w-0 flex-1 text-center">
          {(cards !== null || timer) && (
            <p data-testid="size-turn" className="text-sm leading-tight font-bold text-brass">
              {ready ? 'Your turn' : 'Waiting for the connection'}
            </p>
          )}
          <p data-testid="size-amount" className="text-2xl font-semibold text-cream tabular-nums">
            {chips(amount)}
          </p>
          <p data-testid="size-adds" className="text-sm leading-tight text-cream/75 tabular-nums">
            {raise.type === 'bet' && !allIn ? 'Your bet' : 'Street total'} · you put in{' '}
            {chips(amount - bet)} more
          </p>
        </div>
        {timer && ready && <TurnRing timer={timer} testId="size-ring" />}
      </div>
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
  userId,
  me,
  ready,
  client,
}: {
  room: PublicRoomState;
  userId: string;
  /** Null for a host who has no seat. */
  me: PublicSeat | null;
  /** True only after the `room:enter` ack: nothing may be sent before. */
  ready: boolean;
  client: Pick<SocketClient, 'emitWithAck'>;
}) {
  const { hand } = room;
  const live = room.status === 'playing' && !room.paused;
  const turn: { hand: PublicHand; options: TurnOptions; me: PublicSeat } | null =
    live && me && hand?.options && hand.currentActor === me.seat
      ? { hand, options: hand.options, me }
      : null;
  const hosting = room.hostId === userId;
  const step = hosting ? hostStep(room) : null;
  const proposed = live && hand && hand.street !== 'ended' && hand.pendingAwards.length > 0;
  const turnKey = hand ? `${hand.handId}:${hand.turnSeq}` : '';
  const owed = me ? toCall(hand, me) : null;

  /**
   * A sheet, opened for one state of the hand: any change to the hand closes it. Two differ: the
   * winners stay up while the pots, who can win them and any proposal are unchanged (a folded
   * player leaving must not lose the picks), and a stack correction is not tied to the hand.
   */
  const [sheet, setSheet] = useState<{ kind: SheetKind; key: string } | null>(null);
  const awardKey = hand
    ? `award:${hand.handId}:${hand.street}:${JSON.stringify([
        hand.pots,
        hand.pendingAwards.map((a) => [a.potId, a.winners, a.disputed]),
      ])}`
    : '';
  const keyOf = (kind: SheetKind) =>
    kind === 'award' ? awardKey : kind === 'adjust' ? 'adjust' : turnKey;
  const opened = sheet && sheet.key === keyOf(sheet.kind) ? sheet.kind : null;
  /** The disconnected player on turn, whom the host may fold. */
  const absent = absentActor(room, userId);
  // Forgotten, not just hidden: pots can come round to the same again after an undo. The same for
  // a fold sheet whose player has come back: it must not reappear if they drop again.
  if (sheet && (opened === null || (opened === 'absent' && !absent))) setSheet(null);
  const show = (kind: SheetKind) => setSheet({ kind, key: keyOf(kind) });
  const close = () => setSheet(null);
  /** The state of the hand whose disputed result was put aside to see the table. */
  const [aside, setAside] = useState<string | null>(null);

  const tools = hosting && room.settings.mode === 'hybrid';
  const disputed = Boolean(proposed) && hand!.pendingAwards.some((a) => a.disputed);
  const minimised = disputed && aside === turnKey;
  /** A pending award must be stopped before anything is undone (the server says the same). */
  const canUndo =
    tools &&
    live &&
    hand !== null &&
    hand.street !== 'ended' &&
    hand.undo !== null &&
    (!proposed || disputed);

  /** The state of the hand already answered (or being answered): its buttons stay off. */
  const [sent, setSent] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string } | null>(null);
  /** By state of the hand: a lost ack must not swallow taps on a later one. */
  const sending = useRef<string | null>(null);
  const latest = useRef(turnKey);
  useLayoutEffect(() => {
    latest.current = turnKey;
  });

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), ACTION_NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);

  /** Our cards of this ended online hand are still face down to the others. */
  const dealtHand = useRoomStore((s) => s.privateHand?.handId ?? null);
  const showable =
    room.settings.mode === 'online' &&
    me !== null &&
    hand?.outcome !== undefined &&
    dealtHand === hand.handId &&
    !hand.outcome.hands.some((h) => h.userId === userId);

  // A sheet's buttons are armed by the same check, also when nothing else is up.
  const resumable = hosting && room.status === 'paused';
  const active =
    turn !== null ||
    step !== null ||
    Boolean(proposed) ||
    opened !== null ||
    resumable ||
    showable ||
    absent !== null;
  const { list, held, isStill } = useStillCards<HTMLElement>(active, ACTION_ARM_MS);
  const guard = usePressGuard();

  async function send(event: ClientEventName, emit: () => Promise<AckResult>) {
    const key = turnKey;
    if (!ready || sending.current === key) return;
    sending.current = key;
    setSent(key);
    setNotice(null);
    const res = await emit();
    if (sending.current === key) sending.current = null;
    if (res.ok) return setSheet((s) => (s?.key === key ? null : s));
    // The hand moved while we waited: there is no answer to wait for, and nothing to report.
    if (latest.current !== key && (res.error.code as string) === 'timeout') return;
    // Safe to try again: if it did land, the same turnSeq is refused.
    setSent((s) => (s === key ? null : s));
    setNotice({ text: actFailure(res.error, event) });
  }

  /** Apart from `send`: resuming twice is harmless, and a pause changes no `turnSeq`. */
  async function resume() {
    if (!ready) return;
    setNotice(null);
    const res = await client.emitWithAck('host:resume', undefined);
    if (!res.ok) setNotice({ text: actFailure(res.error, 'host:resume') });
  }

  const act = (move: Move) => {
    if (!turn) return;
    const payload = actPayload(turn.hand.handId, turn.hand.turnSeq, move);
    void send('game:act', () => client.emitWithAck('game:act', payload));
  };

  const off = !ready || (sent === turnKey && !resumable);
  const tap: Tap = (id, run) => ({
    'data-card': id,
    disabled: off || held.has(id),
    onPointerDown: () => guard.press(isStill(id) ? id : null),
    onClick: (e) => {
      if (guard.took(id, e) && isStill(id)) run();
    },
  });
  const button = (
    name: string,
    className: string,
    run: () => void,
    detail?: string,
    id = `${name}:${turnKey}`,
  ) => (
    <button key={id} type="button" className={className} {...tap(id, run)}>
      <span>{name}</span>
      {detail !== undefined && <span className="text-sm tabular-nums">{detail}</span>}
    </button>
  );

  const alert = notice && (
    <span role="alert" className="truncate text-chip-red">
      {notice.text}
    </span>
  );
  /** A sheet covers the bar's own line, so it repeats a refusal. */
  const sheetAlert = alert && <p className="flex justify-center text-sm">{alert}</p>;

  /** An ended hand keeps Show's column to itself: a second tap there must not reach Resume. */
  const showColumn = room.settings.mode === 'online' && hand?.outcome !== undefined;

  function showCards() {
    if (!hand) return;
    void send('hand:show', () => client.emitWithAck('hand:show', { handId: hand.handId }));
  }

  const raise = turn?.options.raise ?? null;
  const sizing = raise !== null && opened === 'size';
  const call = turn?.options.call ?? null;
  const deal = step?.kind === 'deal' ? DEALS[step.street] : null;
  const picking = hosting && (step?.kind === 'award' || proposed) && opened === 'award';
  const undoing = canUndo && opened === 'undo';
  const adjusting = tools && live && opened === 'adjust';
  const banner = proposed && !minimised && !picking && !undoing && !adjusting;
  /** A sheet is up: it says the refusal, so it is not said twice. */
  const folding = absent !== null && opened === 'absent';
  const covered =
    sizing || (deal !== null && opened === 'cards') || picking || undoing || banner || folding;

  function dealStreet(cards?: CardString[]) {
    if (!hand || step?.kind !== 'deal') return;
    const payload = {
      handId: hand.handId,
      turnSeq: hand.turnSeq,
      street: step.street,
      ...(cards ? { cards } : {}),
    };
    void send('host:advance_street', () => client.emitWithAck('host:advance_street', payload));
  }

  return (
    <section
      ref={list}
      aria-label="Actions"
      data-testid="action-bar"
      className={`relative flex shrink-0 flex-col pt-1 ${tools ? 'h-24' : 'h-18'}`}
    >
      {/* The amount to call is never hidden: a refusal shares the line with it. */}
      <div className={tools ? 'flex h-11 items-center gap-2' : 'flex h-5 items-center'}>
        {tools && (
          <button
            type="button"
            className={TOOL}
            disabled={!ready || !canUndo}
            onClick={() => show('undo')}
          >
            Undo
          </button>
        )}
        <p
          className={`flex min-w-0 flex-1 items-center justify-center text-sm ${
            tools ? 'flex-col text-center leading-tight' : 'gap-3 whitespace-nowrap'
          }`}
        >
          {me && (
            <span
              data-testid="my-call"
              className="shrink-0 whitespace-nowrap text-cream tabular-nums"
            >
              To call {owed === null ? '–' : money(owed)}
            </span>
          )}
          {!covered &&
            (tools && notice ? (
              <span role="alert" className="line-clamp-2 text-xs leading-3 text-chip-red">
                {notice.text}
              </span>
            ) : (
              alert
            ))}
        </p>
        {tools && (
          <button
            type="button"
            className={TOOL}
            disabled={!ready || !live}
            onClick={() => show('adjust')}
          >
            Fix stack
          </button>
        )}
      </div>
      {(resumable || showable) && (
        <div className="grid grid-cols-3 gap-2">
          {resumable &&
            button(
              'Resume game',
              `${SOLID} ${showColumn ? 'col-span-2' : 'col-span-3'}`,
              () => void resume(),
              undefined,
              // Not tied to the hand: it may be paused with none, and more than once.
              'resume',
            )}
          {showable &&
            // Tied to the hand only: someone else showing must not hold it again.
            button(
              'Show',
              `${OUTLINE} col-start-3`,
              showCards,
              'your cards',
              `show:${hand!.handId}`,
            )}
        </div>
      )}
      {absent && !folding && (
        <div className="grid">
          <button
            key={`absent:${turnKey}:${absent.userId}`}
            type="button"
            className={`${OUTLINE} w-full`}
            {...tap(`absent:${turnKey}:${absent.userId}`, () => show('absent'))}
          >
            <span className="block w-full truncate">Fold {absent.username}</span>
            <span className="text-sm">They&apos;re away</span>
          </button>
        </div>
      )}
      {folding && hand && (
        <ForceFoldSheet
          key={`${turnKey}:${absent.userId}`}
          username={absent.username}
          id={`fold-away:${turnKey}:${absent.userId}`}
          tap={tap}
          notice={sheetAlert}
          onBack={close}
          onFold={() => {
            const payload = { handId: hand.handId, turnSeq: hand.turnSeq, userId: absent.userId };
            void send('host:force_fold', () => client.emitWithAck('host:force_fold', payload));
          }}
        />
      )}
      {turn && !sizing && (
        <div className="grid grid-cols-3 gap-2">
          {button('Fold', OUTLINE, () => act({ type: 'fold' }))}
          {turn.options.check && button('Check', SOLID, () => act({ type: 'check' }))}
          {call !== null &&
            (call >= turn.me.stack
              ? button('Call all-in', SOLID, () => act({ type: 'call' }), `${money(call)} more`)
              : button('Call', SOLID, () => act({ type: 'call' }), money(call)))}
          {raise &&
            button(
              raise.min === raise.max ? 'All-in' : raise.type === 'bet' ? 'Bet' : 'Raise',
              OUTLINE,
              () => show('size'),
            )}
        </div>
      )}
      {turn && sizing && (
        <SizeSheet
          key={turnKey}
          raise={raise}
          pot={potTotal(room)}
          currentBet={turn.hand.currentBet}
          call={call ?? 0}
          stack={turn.me.stack}
          bet={turn.me.bet}
          turnKey={turnKey}
          tap={tap}
          notice={sheetAlert}
          cards={
            room.settings.mode === 'online' ? (
              <HoleCards
                handId={turn.hand.handId}
                folded={false}
                size="w-10 min-[360px]:w-12"
                testId="size-cards"
              />
            ) : null
          }
          timer={turnTimer(room)}
          ready={ready}
          onBack={close}
          onSend={act}
        />
      )}
      {deal && step?.kind === 'deal' && opened !== 'cards' && (
        <div className="grid grid-cols-3 gap-2">
          {deal.cards > 0 &&
            button('Add cards', OUTLINE, () => show('cards'), undefined, `cards:${turnKey}`)}
          {button(deal.label, `${SOLID} ${deal.cards > 0 ? 'col-span-2' : 'col-span-3'}`, () =>
            dealStreet(),
          )}
        </div>
      )}
      {deal && opened === 'cards' && hand && (
        <CardSheet
          key={turnKey}
          label={deal.label}
          count={deal.cards}
          board={hand.board}
          turnKey={turnKey}
          tap={tap}
          notice={sheetAlert}
          onBack={close}
          onDeal={dealStreet}
        />
      )}
      {step?.kind === 'award' && opened !== 'award' && (
        <div className="grid">{button('Pick winners', SOLID, () => show('award'))}</div>
      )}
      {picking && hand && (
        <AwardSheet
          key={awardKey}
          room={room}
          hand={hand}
          turnKey={turnKey}
          tap={tap}
          notice={sheetAlert}
          onBack={close}
          onAward={(awards) => {
            const payload = { handId: hand.handId, turnSeq: hand.turnSeq, awards };
            void send('host:award', () => client.emitWithAck('host:award', payload));
          }}
        />
      )}
      {minimised && !banner && !picking && (
        <div className={`grid gap-2 ${hosting ? 'grid-cols-3' : ''}`}>
          {button('See result', OUTLINE, () => setAside(null), undefined, `result:${turnKey}`)}
          {hosting &&
            button(
              'Pick winners again',
              `${SOLID} col-span-2`,
              () => show('award'),
              undefined,
              `again:${turnKey}`,
            )}
        </div>
      )}
      {undoing && hand && (
        <UndoSheet
          key={turnKey}
          room={room}
          hand={hand}
          turnKey={turnKey}
          tap={tap}
          notice={sheetAlert}
          onBack={close}
          onUndo={() => {
            const payload = { handId: hand.handId, turnSeq: hand.turnSeq };
            void send('host:undo', () => client.emitWithAck('host:undo', payload));
          }}
        />
      )}
      {adjusting && (
        <AdjustSheet room={room} tap={tap} ready={ready} client={client} onBack={close} />
      )}
      {banner && (
        <AwardBanner
          key={turnKey}
          room={room}
          hand={hand}
          userId={userId}
          stack={me?.stack ?? null}
          turnKey={turnKey}
          tap={tap}
          notice={sheetAlert}
          onDispute={() =>
            void send('host:dispute', () =>
              client.emitWithAck('host:dispute', { handId: hand.handId }),
            )
          }
          onRepick={() => show('award')}
          onMinimise={() => setAside(turnKey)}
        />
      )}
    </section>
  );
}
