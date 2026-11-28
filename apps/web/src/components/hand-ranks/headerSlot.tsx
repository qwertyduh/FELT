/**
 * A place in a screen's header that something further down fills: the table knows what is on show,
 * the header has the room (no height, and no width off the cards or figures). Without a provider the
 * children are rendered where they are.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** The header's element; null until it is there. */
const HeaderSlot = createContext<HTMLElement | null | undefined>(undefined);

export const HeaderSlotProvider = HeaderSlot.Provider;

export function InHeader({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlot);
  if (slot === undefined) return children;
  return slot && createPortal(children, slot);
}
