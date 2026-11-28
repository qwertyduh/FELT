/**
 * The chat panel (P55). It takes the table's place in the layout rather than lying over anything:
 * the turn line, countdown, own cards, notices and action bar below stay exactly where they are.
 * The input is at the top and the newest line right under it, so a phone keyboard covers neither;
 * on the viewer's own turn the panel says so at the top too, as the keyboard may cover the turn
 * line. (A turn arriving closes the panel: see `WaitingRoom`.)
 *
 * Seated players send; anyone admitted reads. Everything is rendered as text.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CHAT_MAX_LENGTH,
  REACTION_EMOJIS,
  type PublicRoomState,
  type PublicSeat,
} from '@felt/protocol';
import { setChatDraft, setChatOpen, useRoomStore } from '../../lib/realtime/roomStore';
import type { SocketClient } from '../../lib/realtime/socketClient';
import { turnTimer } from '../../lib/turnClock';
import { TurnRing } from '../TurnRing';

function failure(code: string): string {
  switch (code) {
    case 'rate_limited':
      return 'Slow down a moment, then try again.';
    case 'muted':
      return 'The host has muted you.';
    case 'not_seated':
      return 'Take a seat to chat.';
    case 'invalid_payload':
      return "That message can't be sent.";
    case 'timeout':
      return 'No answer. Check the chat before sending again.';
    default:
      return 'Not sent. Try again.';
  }
}

export function ChatPanel({
  room,
  me,
  myTurn,
  ready,
  client,
}: {
  room: PublicRoomState;
  /** Null: no seat, so nothing can be sent. */
  me: PublicSeat | null;
  myTurn: boolean;
  /** True only after the `room:enter` ack: nothing may be sent before. */
  ready: boolean;
  client: Pick<SocketClient, 'emitWithAck'>;
}) {
  const chat = useRoomStore((s) => s.chat);
  const draft = useRoomStore((s) => s.chatDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const top = useRef<HTMLElement>(null);
  const timer = myTurn && ready ? turnTimer(room) : null;
  const seated = me !== null && !me.leaving;
  const muted = me?.muted === true;
  const canSend = seated && !muted;
  const latest = chat.at(-1)?.id;
  // A new line is next to the input: bring it into sight if the panel was scrolled.
  useEffect(() => {
    top.current?.scrollTo?.({ top: 0 });
  }, [latest]);

  async function deliver(emit: () => ReturnType<SocketClient['emitWithAck']>, done: () => void) {
    if (!ready || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const res = await emit();
    sending.current = false;
    setBusy(false);
    if (res.ok) done();
    else setError(failure(res.error.code));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    void deliver(
      () => client.emitWithAck('chat:send', { text }),
      // Kept if more has been typed since.
      () => {
        if (useRoomStore.getState().chatDraft.trim() === text) setChatDraft('');
      },
    );
  }

  const close = (
    <button
      type="button"
      aria-label="Close chat"
      className="flex size-11 shrink-0 items-center justify-center text-2xl text-brass"
      onClick={() => setChatOpen(false)}
    >
      ×
    </button>
  );

  return (
    <section
      ref={top}
      data-testid="chat-panel"
      aria-label="Chat"
      onKeyDown={(e) => e.key === 'Escape' && setChatOpen(false)}
      // A zero basis: it fills what the table would, and no message can stretch the page.
      className="flex min-h-24 flex-1 basis-0 flex-col overflow-y-auto overscroll-contain rounded-2xl border-2 border-brass-dim bg-felt-950 px-2"
    >
      <div className="sticky top-0 flex shrink-0 flex-col bg-felt-950 py-1">
        {myTurn && (
          <div className="flex items-center justify-center gap-2">
            <p data-testid="chat-turn" className="text-base font-bold text-brass">
              {ready ? 'Your turn' : 'Waiting for the connection'}
            </p>
            {timer && <TurnRing timer={timer} testId="chat-ring" />}
          </div>
        )}
        {canSend ? (
          <form onSubmit={submit} className="flex items-center gap-1">
            <input
              type="text"
              aria-label="Message"
              placeholder="Message"
              autoComplete="off"
              enterKeyHint="send"
              maxLength={CHAT_MAX_LENGTH}
              value={draft}
              onChange={(e) => {
                setChatDraft(e.target.value);
                setError(null);
              }}
              // 16px: a smaller field makes iOS zoom the page on focus.
              className="min-h-11 w-full min-w-0 flex-1 rounded-xl border border-felt-700 bg-felt-900 px-3 text-base text-cream"
            />
            <button
              type="submit"
              disabled={!ready || busy || !draft.trim()}
              // The field keeps the focus, so the keyboard stays up.
              onPointerDown={(e) => e.preventDefault()}
              className="min-h-11 shrink-0 rounded-xl bg-brass px-3 text-base font-semibold text-felt-950 active:brightness-90 disabled:opacity-40"
            >
              Send
            </button>
            {close}
          </form>
        ) : (
          <div className="flex items-center gap-1">
            <p data-testid="chat-blocked" className="min-w-0 flex-1 text-center text-sm text-cream">
              {muted ? 'The host has muted you.' : 'Take a seat to chat.'}
            </p>
            {close}
          </div>
        )}
        {error && (
          <p role="alert" className="text-center text-sm text-chip-red">
            {error}
          </p>
        )}
      </div>
      {canSend && (
        <div role="group" aria-label="Reactions" className="grid shrink-0 grid-cols-8">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              disabled={!ready || busy}
              className="min-h-11 min-w-0 rounded-lg text-xl active:bg-felt-700 disabled:opacity-40"
              // Closed once sent: the bubble is on the table underneath.
              onClick={() =>
                void deliver(
                  () => client.emitWithAck('chat:react', { emoji }),
                  () => setChatOpen(false),
                )
              }
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
      <ol aria-label="Messages, newest first" aria-live="polite" className="flex flex-col py-1">
        {chat.length === 0 && (
          <li className="py-1 text-center text-sm text-cream/60">No messages yet.</li>
        )}
        {[...chat].reverse().map((m) => (
          <li
            key={m.id}
            data-testid="chat-line"
            // Clipped: stacked accents must not paint over the line above.
            className="shrink-0 overflow-hidden py-0.5 text-sm leading-snug wrap-anywhere text-cream"
          >
            <bdi
              className={`font-semibold ${m.userId === me?.userId ? 'text-cream' : 'text-brass'}`}
            >
              {m.username}
            </bdi>{' '}
            <bdi>{m.text}</bdi>
          </li>
        ))}
      </ol>
    </section>
  );
}
