import { useEffect, useRef, type MouseEvent } from 'react';

/**
 * A tap counts only if it began on the button it ends on: a touch browser aims the click by where
 * the finger lifts. Any new press, wherever it lands, forgets the last one (window capture runs
 * first), so an abandoned press cannot vouch for a later tap.
 */
export function usePressGuard() {
  const pressed = useRef<string | null>(null);
  useEffect(() => {
    const forget = () => (pressed.current = null);
    window.addEventListener('pointerdown', forget, true);
    window.addEventListener('pointercancel', forget, true);
    return () => {
      window.removeEventListener('pointerdown', forget, true);
      window.removeEventListener('pointercancel', forget, true);
    };
  }, []);
  return {
    /** `id` is null when the button could not be tapped as the press began. */
    press(id: string | null) {
      pressed.current = id;
    },
    /** `detail` 0 is keyboard or assistive tech: there is no press to compare. */
    took(id: string, e: MouseEvent): boolean {
      const start = pressed.current;
      pressed.current = null;
      return e.detail === 0 || start === id;
    },
  };
}
