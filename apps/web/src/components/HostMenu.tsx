/**
 * Host controls (P44, PRD 5.2): pause or resume, change the blinds or how long a dropped player's
 * seat is held (P45), remove a player, hand over the
 * room, end the game. A button in the page header (so nothing on the table moves for it) opens a
 * sheet over the bottom of the screen (`data-cover`: nothing under it takes a tap). Removing,
 * handing over and ending each take a second, named step.
 *
 * The people listed are the server's `host:members`: everyone admitted, seated or not.
 *
 * As elsewhere, a button takes no taps until it has been still for `HOST_ARM_MS` and a tap must
 * begin on it. A person is chosen by user id, never by position. The sheet closes by itself when
 * the host's own turn or an award arrives, so it is never in the way of the action bar.
 */
import { useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  DEFAULT_SEAT_HOLD_MINUTES,
  MAX_CHIPS,
  type ClientEventName,
  type PublicRoomState,
} from '@felt/protocol';
import { OUTLINE, SOLID, type Tap } from '../lib/actionUi';
import { parseWholeNumber } from '../lib/createRoom';
import { hostFailure, kickFate } from '../lib/hostControls';
import { useRoomStore } from '../lib/realtime/roomStore';
import type { AckResult, SocketClient } from '../lib/realtime/socketClient';
import { usePressGuard } from '../lib/usePressGuard';
import { useStillCards } from '../lib/useStillCards';

export const HOST_ARM_MS = 400;
const SEAT_HOLD_CHOICES = [1, 3, 5, 10] as const;

const ROW = 'min-h-12 w-full shrink-0';
const FIELD =
  'min-h-12 w-full min-w-0 rounded-xl border border-felt-700 bg-felt-900 px-3 text-center text-lg text-cream tabular-nums';
const DANGER =
  'flex min-h-12 min-w-0 items-center justify-center rounded-xl border border-chip-red px-2 text-base font-semibold text-chip-red active:brightness-90 disabled:opacity-40';

type View =
  | { name: 'menu' }
  | { name: 'blinds' }
  | { name: 'hold' }
  | { name: 'kick' | 'transfer'; userId: string }
  | {
      name: 'end';
    };

type Client = Pick<SocketClient, 'emitWithAck'>;

function Blinds({
  room,
  busy,
  onBack,
  onSave,
}: {
  room: PublicRoomState;
  busy: boolean;
  onBack: () => void;
  onSave: (smallBlind: number, bigBlind: number) => void;
}) {
  const now = room.nextBlinds ?? room.settings;
  const [small, setSmall] = useState(() => String(now.smallBlind));
  const [big, setBig] = useState(() => String(now.bigBlind));
  const sb = parseWholeNumber(small);
  const bb = parseWholeNumber(big);
  const valid = sb >= 1 && bb >= sb && bb <= MAX_CHIPS;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && !busy) onSave(sb, bb);
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-2">
      <p className="text-center text-sm text-cream/75">Used from the next hand.</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-center text-sm text-brass">
          Small blind
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            className={FIELD}
            value={small}
            onChange={(e) => setSmall(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-center text-sm text-brass">
          Big blind
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            className={FIELD}
            value={big}
            onChange={(e) => setBig(e.target.value)}
          />
        </label>
      </div>
      <p className="min-h-5 text-center text-sm text-chip-red">
        {valid ? '' : 'Whole numbers; the big blind is at least the small one.'}
      </p>
      <div className="grid grid-cols-3 gap-2">
        <button type="button" className={OUTLINE} onClick={onBack}>
          Back
        </button>
        <button type="submit" className={`${SOLID} col-span-2`} disabled={!valid || busy}>
          Save blinds
        </button>
      </div>
    </form>
  );
}

function Confirm({
  title,
  detail,
  yes,
  id,
  tap,
  busy,
  onBack,
  onYes,
}: {
  title: string;
  detail: string;
  yes: string;
  id: string;
  tap: Tap;
  busy: boolean;
  onBack: () => void;
  onYes: () => void;
}) {
  const props = tap(id, onYes);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-center text-lg font-semibold wrap-anywhere text-cream">{title}</p>
      <p className="text-center text-sm wrap-anywhere text-cream/75">{detail}</p>
      <div className="grid grid-cols-3 gap-2">
        <button type="button" className={OUTLINE} onClick={onBack}>
          Back
        </button>
        <button
          key={id}
          type="button"
          className={`${SOLID} col-span-2 wrap-anywhere`}
          {...props}
          disabled={props.disabled || busy}
        >
          {yes}
        </button>
      </div>
    </div>
  );
}

function Sheet({
  room,
  userId,
  ready,
  client,
  onClose,
}: {
  room: PublicRoomState;
  userId: string;
  ready: boolean;
  client: Client;
  onClose: () => void;
}) {
  const [view, setView] = useState<View>({ name: 'menu' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { list, held, isStill } = useStillCards<HTMLDivElement>(true, HOST_ARM_MS);
  const guard = usePressGuard();
  const tap: Tap = (id, run) => ({
    'data-card': id,
    disabled: !ready || held.has(id),
    onPointerDown: () => guard.press(isStill(id) ? id : null),
    onClick: (e) => {
      if (guard.took(id, e) && isStill(id)) run();
    },
  });

  const members = useRoomStore((s) => s.members);
  const others = members
    .filter((m) => m.userId !== userId)
    .map((m) => {
      const seat = room.seats.find((s) => s?.userId === m.userId);
      return {
        userId: m.userId,
        username: m.username ?? `Player ${m.userId.slice(0, 4)}`,
        note: m.leaving
          ? 'leaving'
          : !m.seated
            ? 'not seated'
            : seat && !seat.connected
              ? 'away'
              : null,
        /** The host can only hand over to a seat that is staying. */
        canHost: m.seated && !m.leaving,
        connected: seat?.connected ?? false,
      };
    });
  const target =
    view.name === 'kick' || view.name === 'transfer'
      ? (others.find((s) => s.userId === view.userId) ?? null)
      : null;
  // The chosen player has gone (or can no longer host): there is nothing left to confirm.
  if ((view.name === 'kick' && !target) || (view.name === 'transfer' && !target?.canHost)) {
    setView({ name: 'menu' });
  }

  const open = (next: View) => {
    setError(null);
    setView(next);
  };
  const back = () => open({ name: 'menu' });

  async function send(event: ClientEventName, emit: () => Promise<AckResult>) {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const res = await emit();
    setBusy(false);
    if (res.ok) return onClose();
    setError(hostFailure(res.error, event));
  }

  const hand = room.hand && room.hand.street !== 'ended';
  const fate = view.name === 'kick' && target ? kickFate(room, target.userId) : '';
  const started = room.status === 'playing' || room.status === 'paused';
  const paused = room.status === 'paused';
  const holdMinutes = room.seatHoldMinutes ?? DEFAULT_SEAT_HOLD_MINUTES;

  return createPortal(
    <div
      ref={list}
      data-cover
      data-testid="host-menu"
      role="dialog"
      aria-label="Host controls"
      className="fixed inset-x-0 bottom-0 z-20 mx-auto flex max-h-[85dvh] w-full max-w-[480px] flex-col gap-2 rounded-t-2xl border-t-2 border-brass-dim bg-felt-950 p-4"
    >
      {error && (
        <p role="alert" className="text-center text-sm wrap-anywhere text-chip-red">
          {error}
        </p>
      )}
      {view.name === 'menu' && (
        <>
          <h2 className="text-center text-lg font-semibold text-cream">Host controls</h2>
          <div className="grid grid-cols-2 gap-2">
            {started && (
              <button
                key={paused ? 'resume' : 'pause'}
                type="button"
                className={SOLID}
                {...tap(paused ? 'resume' : 'pause', () => {
                  const event = paused ? 'host:resume' : 'host:pause';
                  void send(event, () => client.emitWithAck(event, undefined));
                })}
              >
                {paused ? 'Resume game' : 'Pause game'}
              </button>
            )}
            <button type="button" className={OUTLINE} onClick={() => open({ name: 'blinds' })}>
              Change blinds
            </button>
            <button
              type="button"
              className={`${OUTLINE} ${started ? 'col-span-2' : ''}`}
              onClick={() => open({ name: 'hold' })}
            >
              Seat hold: {holdMinutes} min
            </button>
          </div>
          {others.length > 0 && (
            <ul aria-label="Players" className="flex min-h-24 flex-col gap-2 overflow-y-auto">
              {others.map((s) => (
                <li key={s.userId} className="flex shrink-0 items-center gap-2">
                  <span className="min-w-0 flex-1 text-base leading-tight text-cream">
                    <span className="block truncate">{s.username}</span>
                    {s.note && <span className="block text-sm text-cream/60">{s.note}</span>}
                  </span>
                  {s.canHost && (
                    <button
                      type="button"
                      aria-label={`Make ${s.username} host`}
                      className={`${OUTLINE} shrink-0 px-2 text-sm`}
                      {...(() => {
                        const props = tap(`transfer:${s.userId}`, () =>
                          open({ name: 'transfer', userId: s.userId }),
                        );
                        return { ...props, disabled: props.disabled || !s.connected };
                      })()}
                    >
                      Make host
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${s.username}`}
                    className={`${DANGER} shrink-0 text-sm`}
                    {...tap(`kick:${s.userId}`, () => open({ name: 'kick', userId: s.userId }))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className={`${DANGER} ${ROW}`}
            {...tap('end', () => open({ name: 'end' }))}
          >
            End game
          </button>
          <button type="button" className={`${OUTLINE} ${ROW}`} onClick={onClose}>
            Close
          </button>
        </>
      )}
      {view.name === 'blinds' && (
        <Blinds
          room={room}
          busy={busy || !ready}
          onBack={back}
          onSave={(smallBlind, bigBlind) =>
            void send('host:settings', () =>
              client.emitWithAck('host:settings', { smallBlind, bigBlind }),
            )
          }
        />
      )}
      {view.name === 'hold' && (
        <div className="flex flex-col gap-2">
          <p className="text-center text-sm text-cream/75">
            How long a player who drops keeps their seat.
          </p>
          <div className="grid grid-cols-4 gap-2">
            {SEAT_HOLD_CHOICES.map((minutes) => (
              <button
                key={minutes}
                type="button"
                aria-pressed={minutes === holdMinutes}
                className={minutes === holdMinutes ? SOLID : OUTLINE}
                {...tap(
                  `hold:${minutes}`,
                  () =>
                    void send('host:seat_hold', () =>
                      client.emitWithAck('host:seat_hold', { minutes }),
                    ),
                )}
              >
                {minutes} min
              </button>
            ))}
          </div>
          <button type="button" className={OUTLINE} onClick={back}>
            Back
          </button>
        </div>
      )}
      {view.name === 'kick' && target && (
        <Confirm
          title={`Remove ${target.username}?`}
          detail={`${fate} They must ask to join again.`}
          yes={`Remove ${target.username}`}
          // Held again if what it would do changes.
          id={`yes-kick:${target.userId}:${fate}`}
          tap={tap}
          busy={busy}
          onBack={back}
          onYes={() =>
            void send('host:kick', () => client.emitWithAck('host:kick', { userId: target.userId }))
          }
        />
      )}
      {view.name === 'transfer' && target && (
        <Confirm
          title={`Make ${target.username} the host?`}
          detail="They take over the room at once and you lose the host controls."
          yes={`Make ${target.username} host`}
          id={`yes-transfer:${target.userId}`}
          tap={tap}
          busy={busy}
          onBack={back}
          onYes={() =>
            void send('host:transfer', () =>
              client.emitWithAck('host:transfer', { userId: target.userId }),
            )
          }
        />
      )}
      {view.name === 'end' && (
        <Confirm
          title="End the game for everyone?"
          detail={`This can't be undone.${
            hand ? ' The hand in play is cancelled: everyone gets back what they put in.' : ''
          }`}
          yes="End game now"
          id="yes-end"
          tap={tap}
          busy={busy}
          onBack={back}
          onYes={() => void send('host:end', () => client.emitWithAck('host:end', undefined))}
        />
      )}
    </div>,
    document.body,
  );
}

export function HostMenu({
  room,
  userId,
  ready,
  client,
}: {
  room: PublicRoomState | null;
  userId: string;
  /** True only after the `room:enter` ack: nothing may be sent before. */
  ready: boolean;
  client: Client;
}) {
  const [open, setOpen] = useState(false);
  const hosting = room !== null && room.hostId === userId && room.status !== 'ended';
  const hand = room?.hand && room.hand.street !== 'ended' ? room.hand : null;
  const myTurn =
    room?.status === 'playing' &&
    hand !== null &&
    hand.currentActor !== null &&
    room.seats[hand.currentActor]?.userId === userId;
  const urgent = myTurn || (room?.status === 'playing' && (hand?.pendingAwards.length ?? 0) > 0);
  // Only as it arrives: the host may still open the menu during their turn.
  const [wasUrgent, setWasUrgent] = useState(urgent);
  if (urgent !== wasUrgent) {
    setWasUrgent(urgent);
    if (urgent) setOpen(false);
  }
  if (open && !hosting) setOpen(false);
  if (!hosting) return null;

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        data-testid="host-button"
        disabled={!ready}
        onClick={() => setOpen(true)}
        className="min-h-11 shrink-0 rounded-xl border border-brass px-3 text-base font-semibold text-brass active:brightness-90 disabled:border-felt-700 disabled:text-cream/30"
      >
        Host
      </button>
      {open && (
        <Sheet
          room={room}
          userId={userId}
          ready={ready}
          client={client}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
