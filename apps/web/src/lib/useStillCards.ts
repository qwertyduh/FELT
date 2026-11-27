import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

/**
 * Which cards may not be tapped yet. Positions are read from the screen itself (after every render,
 * every frame and again at the tap), so no cause of movement needs to be known: pushes, expiry,
 * another tab, scrolling, resizing or content around them. A card is any `[data-card]` element inside
 * the element given `list`. A card outside an overlay marked `[data-cover]` (the bet-sizing sheet)
 * is held while the overlay is up and for `settleMs` after. Used by the request cards (HostInbox),
 * the Start button and the action bar.
 */
export function useStillCards<T extends HTMLElement>(active: boolean, settleMs: number) {
  const list = useRef<T>(null);
  const seen = useRef(new Map<string, { top: number; left: number; until: number }>());
  const [held, setHeld] = useState('');

  const measure = useCallback(() => {
    const now = performance.now(); // monotonic: a clock set back cannot stretch a hold
    const present = new Set<string>();
    const waiting: string[] = [];
    const cover = document.querySelector('[data-cover]');
    for (const el of list.current?.querySelectorAll<HTMLElement>('[data-card]') ?? []) {
      const id = el.dataset.card!;
      const { top, left } = el.getBoundingClientRect();
      let card = seen.current.get(id);
      const covered = cover !== null && !cover.contains(el);
      if (!card || covered || Math.abs(card.top - top) > 1 || Math.abs(card.left - left) > 1) {
        card = { top, left, until: now + settleMs };
        seen.current.set(id, card);
      }
      present.add(id);
      if (card.until > now) waiting.push(id);
    }
    for (const id of seen.current.keys()) if (!present.has(id)) seen.current.delete(id);
    setHeld(waiting.join(' '));
  }, [settleMs]);

  // Before paint, so a card is never shown tappable in a place it has only just reached.
  useLayoutEffect(measure);

  useEffect(() => {
    if (!active) return;
    let frame = requestAnimationFrame(function tick() {
      flushSync(measure);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, measure]);

  return {
    list,
    held: new Set(held.split(' ')),
    /** Asked at the moment of the tap, in case the card moved since the last frame. */
    isStill(id: string): boolean {
      measure();
      const card = seen.current.get(id);
      return card !== undefined && card.until <= performance.now();
    },
  };
}
