import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { SOCIAL_HANDLE } from '../config';

/** Shown when a name is rejected as profane: the owner can set the account up by hand. */
export function AppealDialog({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-felt-950/80 p-4 sm:items-center"
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="appeal-title"
        aria-describedby="appeal-body"
        className="w-full max-w-sm rounded-2xl border border-brass/60 bg-felt-800 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          } else if (e.key === 'Tab') {
            e.preventDefault(); // the close button is the only stop
            closeRef.current?.focus();
          }
        }}
      >
        <h2 id="appeal-title" className="font-display text-xl font-semibold text-cream">
          Blocked by mistake?
        </h2>
        <p id="appeal-body" className="mt-2 text-base leading-relaxed text-cream/85">
          Think your name was blocked by mistake? Tag us on social media and we&apos;ll set up your
          account personally.
        </p>
        <p
          data-testid="social-handle"
          className="mt-3 rounded-lg bg-felt-950/60 px-3 py-2 text-center text-lg font-semibold text-brass select-all"
        >
          {SOCIAL_HANDLE}
        </p>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          className="mt-4 min-h-12 w-full rounded-xl bg-brass px-4 text-base font-semibold text-felt-950 active:brightness-90"
        >
          Got it
        </button>
      </div>
    </div>,
    document.body,
  );
}
