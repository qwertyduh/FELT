/**
 * The room log (P42): every undo, stack correction and forced fold (P45), for everyone at the table. Opened over the
 * screen (marked `data-cover`, so nothing under it takes a tap), so it moves nothing.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { PublicRoomState } from '@felt/protocol';
import { logLine } from '../../lib/hybrid';

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function RoomLog({ log }: { log: PublicRoomState['log'] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        className="min-h-11 shrink-0 rounded-xl border border-felt-700 px-3 text-base font-semibold text-brass tabular-nums active:brightness-90"
        onClick={() => setOpen(true)}
      >
        Log{log.length > 0 && ` · ${log.length}`}
      </button>
      {open &&
        createPortal(
          <div
            data-cover
            data-testid="room-log"
            role="dialog"
            aria-label="Room log"
            className="fixed inset-x-0 bottom-0 z-20 mx-auto flex max-h-[75dvh] w-full max-w-[480px] flex-col gap-2 rounded-t-2xl border-t-2 border-brass-dim bg-felt-950 p-4"
          >
            <h2 className="text-center text-lg font-semibold text-cream">Room log</h2>
            {log.length === 0 ? (
              <p className="text-center text-base text-cream/75">
                Nothing yet. Undos, stack corrections and forced folds show here.
              </p>
            ) : (
              <ol className="flex min-h-0 flex-col gap-2 overflow-y-auto">
                {[...log].reverse().map((entry) => (
                  <li key={entry.id} className="flex gap-3 text-base text-cream">
                    <span className="shrink-0 text-sm text-cream/60 tabular-nums">
                      {time(entry.at)}
                    </span>
                    <span className="min-w-0 wrap-anywhere">{logLine(entry)}</span>
                  </li>
                ))}
              </ol>
            )}
            <button
              type="button"
              className="min-h-12 shrink-0 rounded-xl border border-brass text-base font-semibold text-brass"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}
