import { useState } from 'react';

export type ShareState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; url: string; rateKey: string }
  /** Worth another try. */
  | { kind: 'failed'; message: string }
  /** No try can work any more. */
  | { kind: 'closed'; message: string };

const BUTTON =
  'flex min-h-14 w-full items-center justify-center rounded-2xl px-4 text-lg font-semibold active:brightness-90';
const PRIMARY = `${BUTTON} bg-brass text-felt-950 disabled:bg-felt-800 disabled:text-cream/40`;

/**
 * The host's share control, pinned where the thumb is. Making the link and sending it are two taps:
 * the share sheet needs a tap of its own, not one that has waited for the server.
 */
export function ShareBar({
  state,
  disabled,
  withRate,
  onCreate,
}: {
  state: ShareState;
  disabled: boolean;
  withRate: boolean;
  onCreate: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function send(url: string) {
    if (typeof navigator.share === 'function') {
      try {
        return await navigator.share({ title: 'FELT game recap', url });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return; // sheet dismissed
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
    } catch {
      /* the link is on screen to copy by hand */
    }
  }

  return (
    <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-felt-700 bg-felt-900 px-4 pt-2 pb-1">
      {state.kind === 'done' ? (
        <>
          <a
            data-testid="recap-link"
            href={state.url}
            target="_blank"
            rel="noreferrer"
            className="block text-sm break-all text-brass underline select-all"
          >
            {state.url}
          </a>
          <button type="button" className={PRIMARY} onClick={() => void send(state.url)}>
            <span aria-live="polite">{copied === state.url ? 'Link copied' : 'Send link'}</span>
          </button>
          <p className="text-center text-sm text-cream/60">Anyone with the link, for 7 days.</p>
        </>
      ) : (
        <>
          {(state.kind === 'failed' || state.kind === 'closed') && (
            <p role="alert" className="text-center text-sm text-chip-red">
              {state.message}
            </p>
          )}
          {state.kind !== 'closed' && (
            <button
              type="button"
              className={PRIMARY}
              disabled={disabled || state.kind === 'busy'}
              onClick={onCreate}
            >
              {state.kind === 'busy'
                ? 'Making the link…'
                : withRate
                  ? 'Share with settle-up'
                  : 'Share results'}
            </button>
          )}
        </>
      )}
    </div>
  );
}
