/**
 * The host corrects a stack (P42, PRD 5.5): pick a player, type what the stack should be and why.
 * It is sent as a signed change together with the stack it was made against, so a double send, or
 * a stack that moved meanwhile, is refused. The server decides who may be corrected; the same
 * rule is shown here: not while they are still in the hand.
 */
import { useState } from 'react';
import {
  ADJUST_REASON_MAX,
  MAX_CHIPS,
  type PublicRoomState,
  type PublicSeat,
} from '@felt/protocol';
import { OUTLINE, SHEET, SOLID, type Tap } from '../../lib/actionUi';
import { parseWholeNumber } from '../../lib/createRoom';
import { adjustFailure, stillInHand } from '../../lib/hybrid';
import type { SocketClient } from '../../lib/realtime/socketClient';
import { chips } from '../../lib/seating';

const FIELD =
  'min-h-11 w-full min-w-0 rounded-xl border border-felt-700 bg-felt-900 px-3 text-base text-cream';

export function AdjustSheet({
  room,
  tap,
  ready,
  client,
  onBack,
}: {
  room: PublicRoomState;
  tap: Tap;
  ready: boolean;
  client: Pick<SocketClient, 'emitWithAck'>;
  onBack: () => void;
}) {
  const seats = room.seats.filter((s): s is PublicSeat => s !== null);
  /** `stack` is what the amount was typed against. */
  const [form, setForm] = useState({ userId: '', stack: 0, value: '', moved: false });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seat = seats.find((s) => s.userId === form.userId) ?? null;
  // Their stack changed under the host: the typed total no longer means what it did.
  if (seat && seat.stack !== form.stack) {
    setForm({ ...form, stack: seat.stack, value: '', moved: true });
  }
  const locked = seat !== null && stillInHand(room, seat);
  const target = parseWholeNumber(form.value);
  const delta = seat ? target - seat.stack : Number.NaN;
  const valid =
    seat !== null &&
    !locked &&
    Number.isSafeInteger(delta) &&
    delta !== 0 &&
    Math.abs(delta) <= MAX_CHIPS &&
    (delta < 0 || target <= MAX_CHIPS);
  const signed = `${delta > 0 ? '+' : '−'}${chips(Math.abs(delta))}`;

  const hint = !seat
    ? 'Every correction is shown in the room log.'
    : locked
      ? `${seat.username} is still in this hand. Wait until they fold or it ends.`
      : form.moved && form.value === ''
        ? `Their stack is now ${chips(seat.stack)}. Type it again.`
        : valid
          ? `${signed} chips for ${seat.username}`
          : `Now ${chips(seat.stack)}. Type what it should be.`;

  async function save() {
    // React renders between two taps, so `busy` is enough to send once.
    if (!valid || !reason.trim() || busy || !ready) return;
    setBusy(true);
    setError(null);
    const res = await client.emitWithAck('host:adjust_stack', {
      userId: seat.userId,
      amount: delta,
      stack: seat.stack,
      reason: reason.trim(),
    });
    setBusy(false);
    if (res.ok) return onBack();
    setError(adjustFailure(res.error));
  }

  const confirm = tap(`adjust:${form.userId}`, () => void save());
  return (
    <div
      data-cover
      data-testid="adjust-sheet"
      role="group"
      aria-label="Fix a stack"
      className={`${SHEET} overflow-y-auto`}
    >
      <p className="text-center text-lg font-semibold text-cream">Fix a stack</p>
      <select
        aria-label="Player"
        className={FIELD}
        value={form.userId}
        onChange={(e) => {
          const next = seats.find((s) => s.userId === e.target.value);
          setForm({ userId: e.target.value, stack: next?.stack ?? 0, value: '', moved: false });
          setError(null);
        }}
      >
        <option value="">Choose a player</option>
        {seats.map((s) => (
          <option key={s.userId} value={s.userId}>
            {s.username} · {chips(s.stack)}
            {stillInHand(room, s) ? ' (in the hand)' : ''}
          </option>
        ))}
      </select>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label="New stack"
        placeholder="New stack"
        className={`${FIELD} tabular-nums`}
        disabled={!seat || locked}
        value={form.value}
        onChange={(e) => setForm({ ...form, value: e.target.value, moved: false })}
      />
      <input
        type="text"
        autoComplete="off"
        aria-label="Reason"
        placeholder="Reason (everyone sees it)"
        maxLength={ADJUST_REASON_MAX}
        className={FIELD}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <p data-testid="adjust-hint" className="text-center text-sm wrap-anywhere text-cream/75">
        {hint}
      </p>
      {error && (
        <p role="alert" className="text-center text-sm wrap-anywhere text-chip-red">
          {error}
        </p>
      )}
      <div className="grid shrink-0 grid-cols-3 gap-2">
        <button type="button" className={OUTLINE} onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className={`${SOLID} col-span-2 tabular-nums`}
          {...confirm}
          disabled={confirm.disabled || !valid || !reason.trim() || busy}
        >
          {valid ? `Save ${signed}` : 'Save'}
        </button>
      </div>
    </div>
  );
}
