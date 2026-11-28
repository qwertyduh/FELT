/**
 * The room code and the invite link, each selectable and with its own Copy, plus the share sheet
 * where the phone has one. Without a clipboard (plain http, permission refused) the text is
 * selected for the host to copy by hand. Over the bottom of the screen like the host menu
 * (`data-cover`: nothing under it takes a tap); one tap closes it.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { OUTLINE, SOLID } from '../lib/actionUi';
import { useRoomStore } from '../lib/realtime/roomStore';

export const COPIED_MS = 3_000;

function CopyBox({ label, value, large }: { label: string; value: string; large?: boolean }) {
  const text = useRef<HTMLParagraphElement>(null);
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');

  useEffect(() => {
    if (state !== 'copied') return;
    const id = setTimeout(() => setState('idle'), COPIED_MS);
    return () => clearTimeout(id);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      window.getSelection()?.selectAllChildren(text.current!);
      setState('manual');
    }
  }

  return (
    <div>
      <p className="text-sm text-cream/75">{label}</p>
      <div className="flex items-center gap-2">
        <p
          ref={text}
          data-testid={`invite-${label === 'Room code' ? 'code' : 'link'}`}
          className={`min-w-0 flex-1 rounded-xl border border-felt-700 bg-felt-900 px-3 py-2 break-all text-cream select-all ${
            large ? 'font-display text-2xl tracking-widest' : 'text-sm'
          }`}
        >
          {value}
        </p>
        <button
          type="button"
          aria-label={`Copy ${label.toLowerCase()}`}
          className={`${OUTLINE} w-20 shrink-0`}
          onClick={() => void copy()}
        >
          <span aria-live="polite">{state === 'copied' ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      {state === 'manual' && (
        <p role="status" className="mt-1 text-sm text-brass">
          Couldn&apos;t copy. It&apos;s selected: copy it by hand.
        </p>
      )}
    </div>
  );
}

export function InviteSheet({ code, onClose }: { code: string; onClose: () => void }) {
  const url = `${window.location.origin}/r/${code}`;
  /** Only ever filled for the host: the cards are under this sheet. */
  const waiting = useRoomStore((s) => s.hostInbox.joinRequests.length);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => dialog.current?.focus(), []);

  async function share() {
    try {
      await navigator.share({ title: 'Join my FELT table', url });
    } catch {
      // Dismissed, or refused: the boxes above still work.
    }
  }

  return createPortal(
    <div
      ref={dialog}
      tabIndex={-1}
      data-cover
      data-testid="invite-sheet"
      role="dialog"
      aria-label="Invite friends"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className="fixed inset-x-0 bottom-0 z-20 mx-auto flex max-h-[90dvh] w-full max-w-[480px] flex-col gap-3 overflow-y-auto rounded-t-2xl border-t-2 border-brass-dim bg-felt-950 p-4 outline-none"
    >
      <h2 className="text-center text-lg font-semibold text-cream">Invite friends</h2>
      <CopyBox label="Room code" value={code} large />
      <CopyBox label="Invite link" value={url} />
      {waiting > 0 && (
        <p role="status" className="text-center text-sm font-semibold text-brass">
          {waiting === 1 ? '1 person is' : `${waiting} people are`} waiting to join. Close to
          answer.
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        {typeof navigator.share === 'function' && (
          <button type="button" className={SOLID} onClick={() => void share()}>
            Share
          </button>
        )}
        <button
          type="button"
          className={`${OUTLINE} ${typeof navigator.share === 'function' ? '' : 'col-span-2'}`}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}
