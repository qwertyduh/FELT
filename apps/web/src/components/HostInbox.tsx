/**
 * The host's pending requests as stacked cards (P37). Self-contained: it reads the room store and
 * answers over the socket it is given, and renders nothing for non-hosts or an empty inbox. It sits
 * in normal flow with its own scroll (never fixed or floating), so whatever is mounted below it,
 * such as the table's action bar, cannot be covered.
 *
 * Nobody may be answered by a tap aimed at someone else: the region has a fixed height with cards
 * stacked from its top (an arrival moves nothing), and a card that is new or has moved, for
 * whatever reason, takes no taps until it has been still for `SETTLE_MS`. A tap also has to start
 * on the button it ends on: a touch browser aims the click by where the finger lifts, which may be
 * long after the card under the finger changed.
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ErrorCode } from '@felt/protocol';
import { removeJoinRequest, useRoomStore } from '../lib/realtime/roomStore';
import type { SocketClient } from '../lib/realtime/socketClient';
import { useStillCards } from '../lib/useStillCards';

export const SETTLE_MS = 400;
export const NOTICE_MS = 4_000;

const BUTTON = 'min-h-12 flex-1 rounded-xl px-3 text-base font-semibold active:brightness-90';
const CARD = 'rounded-2xl border border-brass-dim bg-felt-950 p-3';

function failure(code: ErrorCode | 'timeout'): string {
  if (code === 'rate_limited') return 'Too many taps. Wait a moment and try again.';
  return "Couldn't send your answer. Try again.";
}

export function HostInbox({
  userId,
  ready,
  client,
  compact = false,
}: {
  userId: string;
  /** True only after the `room:enter` ack: nothing may be sent before. */
  ready: boolean;
  client: Pick<SocketClient, 'emitWithAck'>;
  /** The table is on screen: only as tall as one card, so the felt keeps its room. */
  compact?: boolean;
}) {
  const hosting = useRoomStore((s) => s.room?.hostId === userId);
  const seats = useRoomStore((s) => s.room?.seats);
  const { joinRequests, topUpRequests } = useRoomStore((s) => s.hostInbox);
  /** requestIds with an answer in flight. */
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  /** An object, so a repeat of the same words restarts its time on screen. */
  const [notice, setNotice] = useState<{ text: string } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);

  const count = joinRequests.length + topUpRequests.length;
  const { list, held, isStill } = useStillCards<HTMLUListElement>(hosting && count > 0, SETTLE_MS);
  /** The button the current press started on, if its card could be tapped then. */
  const pressed = useRef<{ requestId: string; approve: boolean } | null>(null);

  // Any new press forgets the last one, wherever it lands (window capture runs first).
  useEffect(() => {
    const forget = () => (pressed.current = null);
    window.addEventListener('pointerdown', forget, true);
    window.addEventListener('pointercancel', forget, true);
    return () => {
      window.removeEventListener('pointerdown', forget, true);
      window.removeEventListener('pointercancel', forget, true);
    };
  }, []);
  if (!hosting || (count === 0 && notice === null)) return null;

  async function answer(requestId: string, username: string, approve: boolean) {
    if (!isStill(requestId)) return;
    setNotice(null);
    setBusy((b) => new Set(b).add(requestId));
    const res = await client.emitWithAck('host:admit', { requestId, approve });
    setBusy((b) => new Set([...b].filter((id) => id !== requestId)));
    if (res.ok || res.error.code === 'request_expired') {
      if (!res.ok) setNotice({ text: `${username}'s request is no longer open.` });
      removeJoinRequest(requestId);
    } else {
      setNotice({ text: failure(res.error.code) });
    }
  }

  const press = (requestId: string, approve: boolean) => () => {
    pressed.current = isStill(requestId) ? { requestId, approve } : null;
  };
  const click = (requestId: string, username: string, approve: boolean) => (e: MouseEvent) => {
    const start = pressed.current;
    pressed.current = null;
    // `detail` 0 is keyboard or assistive tech: no press to compare, and focus never moves to
    // another person's button (each card is its own element).
    if (e.detail !== 0 && (start?.requestId !== requestId || start.approve !== approve)) return;
    void answer(requestId, username, approve);
  };

  return (
    <section
      aria-label="Requests"
      data-testid="host-inbox"
      className={`flex shrink-0 flex-col gap-2 pt-2 ${compact ? 'h-46' : 'h-[max(40dvh,13rem)]'}`}
    >
      {/* Fixed height: a notice must not push the cards. */}
      <div className="flex h-10 shrink-0 items-end">
        {notice ? (
          <p role="alert" className="line-clamp-2 text-sm wrap-anywhere text-chip-red">
            {notice.text}
          </p>
        ) : (
          <h2 className="text-sm font-semibold text-brass">
            {count} {count === 1 ? 'request' : 'requests'} waiting
          </h2>
        )}
      </div>
      <ul ref={list} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {joinRequests.map(({ requestId, username }) => {
          const off = !ready || held.has(requestId) || busy.has(requestId);
          return (
            <li
              key={requestId}
              data-card={requestId}
              data-testid="join-request"
              className={`shrink-0 ${CARD}`}
            >
              <p className="text-base wrap-anywhere text-cream">
                <strong className="font-semibold">{username}</strong> wants to join
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  aria-label={`Deny ${username}`}
                  className={`${BUTTON} border border-brass text-brass disabled:border-felt-700 disabled:text-cream/30`}
                  disabled={off}
                  onPointerDown={press(requestId, false)}
                  onClick={click(requestId, username, false)}
                >
                  Deny
                </button>
                <button
                  type="button"
                  aria-label={`Admit ${username}`}
                  className={`${BUTTON} bg-brass text-felt-950 disabled:bg-felt-800 disabled:text-cream/40`}
                  disabled={off}
                  onPointerDown={press(requestId, true)}
                  onClick={click(requestId, username, true)}
                >
                  Admit
                </button>
              </div>
            </li>
          );
        })}
        {topUpRequests.map(({ requestId, userId: from, amount }) => (
          <li
            key={requestId}
            data-card={requestId}
            data-testid="topup-request"
            className={`shrink-0 ${CARD}`}
          >
            <p className="text-base wrap-anywhere text-cream">
              <strong className="font-semibold">
                {seats?.find((s) => s?.userId === from)?.username ?? 'A player'}
              </strong>{' '}
              asks for {amount.toLocaleString('en-US')} more chips
            </p>
            {/* Placeholder: answering top-ups is P43 (`host:topup`). */}
            <p className="mt-1 text-sm text-cream/60">
              Answering top-ups isn&apos;t available yet.
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
