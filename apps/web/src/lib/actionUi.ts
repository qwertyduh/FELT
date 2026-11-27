/** Shared by the action bar and the hybrid controls that live in it. */
import type { MouseEvent } from 'react';

export const BUTTON =
  'flex min-h-12 min-w-0 flex-col items-center justify-center rounded-xl px-1 text-base leading-tight font-semibold active:brightness-90 disabled:opacity-40';
export const OUTLINE = `${BUTTON} border border-brass text-brass`;
export const SOLID = `${BUTTON} bg-brass text-felt-950`;

/** A panel laid over what is above the bar; its bottom row sits where the bar's buttons do. */
export const SHEET =
  'absolute -inset-x-2 bottom-0 z-10 flex max-h-[calc(100dvh-2rem)] flex-col gap-2 rounded-t-2xl border-t-2 border-brass-dim bg-felt-950 px-2 pt-2';

/** Props that make a button guarded: held until still, and the press must begin on it. */
export type Tap = (
  id: string,
  run: () => void,
) => {
  'data-card': string;
  disabled: boolean;
  onPointerDown: () => void;
  onClick: (e: MouseEvent) => void;
};
