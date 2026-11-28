/**
 * The hand-rank sheet (PRD 5.8): the ten ranks from best to worst, each with an example, and the
 * player's own rank marked when `current` is given. Laid over the page (`data-cover`: nothing under
 * it takes a tap); a tap outside, a swipe down, Close or Escape puts it away. It pauses nothing:
 * `indicator` keeps the turn and its countdown in sight above the list.
 *
 * It knows nothing of rooms, so online, hybrid, practice and the tutorial can all use it.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PlayingCard } from '../cards/PlayingCard';
import { RANK_ROWS, type CurrentHand } from './ranks';

/** A downward drag at least this long closes the sheet. */
export const SWIPE_CLOSE_PX = 60;

function useSwipeDown(onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const el = panel.current!;
    /** Where a one-finger drag that may close the sheet began. */
    let from: { x: number; y: number } | null = null;
    let by = 0;
    const move = (px: number) => {
      by = px;
      el.style.transform = px > 0 ? `translateY(${px}px)` : '';
    };
    const start = (e: TouchEvent) => {
      const touch = e.touches[0]!;
      // A list scrolled down is scrolled back up first.
      const scrolled = list.current!.contains(e.target as Node) && list.current!.scrollTop > 0;
      from = e.touches.length === 1 && !scrolled ? { x: touch.clientX, y: touch.clientY } : null;
      move(0);
    };
    const drag = (e: TouchEvent) => {
      if (!from) return;
      const dx = e.touches[0]!.clientX - from.x;
      const dy = e.touches[0]!.clientY - from.y;
      // Anything but downward is a scroll (or nothing): leave it to the browser.
      if (by === 0 && (dy <= 0 || Math.abs(dx) > dy)) {
        if (dy < 0) from = null;
        return;
      }
      // Ours now: no scrolling and no pull-to-refresh.
      if (e.cancelable) e.preventDefault();
      move(Math.max(0, dy));
    };
    const end = () => {
      const far = from !== null && by >= SWIPE_CLOSE_PX;
      from = null;
      if (far) close.current();
      else move(0);
    };
    const cancel = () => {
      from = null;
      move(0);
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', drag, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', cancel);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', drag);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', cancel);
    };
  }, []);
  return { panel, list };
}

export function HandRanksSheet({
  current,
  indicator,
  onClose,
}: {
  /** Null: nothing to mark (cards unknown). */
  current: CurrentHand | null;
  /** Whose turn it is, with the time left. */
  indicator?: ReactNode;
  onClose: () => void;
}) {
  const { panel, list } = useSwipeDown(onClose);
  const closer = useRef<HTMLButtonElement>(null);
  const mine = useRef<HTMLLIElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const before = document.activeElement;
    closer.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close.current();
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      if (before instanceof HTMLElement) before.focus({ preventScroll: true });
    };
  }, []);
  // A screen too short for all ten: bring the marked one into sight.
  useEffect(() => {
    mine.current?.scrollIntoView?.({ block: 'nearest' });
  }, [current?.category]);

  return createPortal(
    <div data-cover data-testid="hand-ranks" className="fixed inset-0 z-40">
      <div
        data-testid="hand-ranks-backdrop"
        aria-hidden="true"
        className="absolute inset-0 touch-none bg-black/60"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Hand rankings"
        className="absolute inset-x-0 bottom-0 mx-auto flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[480px] flex-col rounded-t-2xl border-t-2 border-brass-dim bg-felt-950 px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] transition-transform duration-100"
      >
        <div className="shrink-0 touch-none">
          <span
            aria-hidden="true"
            className="mx-auto mt-1.5 block h-1 w-10 rounded-full bg-felt-700"
          />
          <div className="flex min-h-11 items-center gap-2">
            <h2 className="shrink-0 font-display text-base font-semibold text-cream min-[360px]:text-lg">
              Hand ranks
            </h2>
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{indicator}</div>
            <button
              ref={closer}
              type="button"
              aria-label="Close hand ranks"
              className="-mr-2 flex size-11 shrink-0 items-center justify-center text-2xl text-brass"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        </div>
        <ol
          ref={list}
          aria-label="Hand ranks, best first"
          className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain"
        >
          {RANK_ROWS.map((row, i) => {
            const yours = current?.category === row.category;
            return (
              <li
                key={row.category}
                ref={yours ? mine : undefined}
                data-testid={`rank-${row.category}`}
                aria-current={yours ? 'true' : undefined}
                className={`flex shrink-0 items-center gap-2 rounded-lg border-2 px-1.5 py-px ${
                  yours ? 'border-brass bg-felt-700' : 'border-transparent'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="w-4 shrink-0 text-xs text-cream/60 tabular-nums"
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block text-sm font-semibold text-cream">{row.name}</span>
                  {yours && (
                    <span data-testid="your-hand" className="block text-xs text-brass">
                      <span className="font-bold">Yours</span>
                      <span className="sr-only">: {current.name}</span>
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 gap-0.5">
                  {row.example.map((card, at) => (
                    <span key={card} className={at < row.made ? '' : 'opacity-40'}>
                      <PlayingCard
                        card={card}
                        // All ten fit a 568px screen without scrolling.
                        className="w-7 min-[360px]:w-8 [@media(max-height:600px)]:w-[1.625rem] [@media(min-height:700px)]:min-[360px]:w-9"
                      />
                    </span>
                  ))}
                </span>
              </li>
            );
          })}
        </ol>
        {current && (
          <p
            data-testid="your-best"
            className="shrink-0 touch-none pt-1 text-center text-xs text-brass min-[360px]:text-sm"
          >
            Your best now: <span className="font-semibold">{current.name}</span>
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
