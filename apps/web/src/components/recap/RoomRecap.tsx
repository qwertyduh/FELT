import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  CreateRecapResponseSchema,
  parseTolerant,
  type CreateRecapRequest,
  type Recap,
} from '@felt/protocol';
import { apiFetch, ApiError } from '../../lib/api';
import { parseRate, recapUrl, rowsOf, settlementOf, type RateInput } from '../../lib/recap';
import { RecapResults } from './RecapResults';
import { ShareBar, type ShareState } from './ShareBar';
import { WhoPaysWhom } from './WhoPaysWhom';

const FIELD =
  'min-h-12 w-full min-w-0 rounded-xl border-2 border-felt-700 bg-felt-950/70 px-3 text-lg text-cream tabular-nums focus:border-brass focus:outline-none';

function shareProblem(err: unknown): ShareState {
  const code = err instanceof ApiError ? err.code : '';
  const final = (message: string): ShareState => ({ kind: 'closed', message });
  const retry = (message: string): ShareState => ({ kind: 'failed', message });
  switch (code) {
    case 'room_not_found':
      return final(
        "This room has closed, so a link can't be made any more. Take a screenshot to keep the results.",
      );
    case 'not_host':
      return final('Only the host can share this recap.');
    case 'nothing_to_share':
      return final("Nobody played, so there's nothing to share.");
    case 'rate_limited':
      return retry('Too many links. Wait a minute and try again.');
    case 'rate_too_large':
      return retry('That rate makes the amounts too large.');
    default:
      return retry("Couldn't make the link. Try again.");
  }
}

/** The end of a game, for the people who were in it (PRD 5.9). */
export function RoomRecap({ recap, userId }: { recap: Recap; userId: string }) {
  const host = recap.hostId === userId;
  const [chipsText, setChipsText] = useState('1000');
  const [amountText, setAmountText] = useState('');
  const [share, setShare] = useState<ShareState>({ kind: 'idle' });

  const input: RateInput = parseRate(chipsText, amountText);
  const rate = input.kind === 'ok' ? input.rate : null;
  const rateKey = rate ? `${rate.chips}:${rate.minorUnits}` : '';
  const settlement = useMemo(() => {
    if (!rateKey) return null;
    const [count, minorUnits] = rateKey.split(':').map(Number) as [number, number];
    return settlementOf(recap, { chips: count, minorUnits });
  }, [recap, rateKey]);
  const tooLarge = rate !== null && settlement === null;
  const problem =
    input.kind === 'invalid'
      ? input.message
      : tooLarge
        ? 'That rate makes the amounts too large.'
        : null;
  const rows = rowsOf(recap.players, userId);

  async function create() {
    setShare({ kind: 'busy' });
    try {
      const body: CreateRecapRequest = { code: recap.code, rate };
      const res = await apiFetch(
        '/recaps',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        // Not safe to repeat blindly: each success is another stored copy.
        { retryUnavailable: false },
      );
      const parsed = parseTolerant(CreateRecapResponseSchema, res);
      if (!parsed.success) throw parsed.error;
      setShare({ kind: 'done', url: recapUrl(parsed.data.slug), rateKey });
    } catch (err) {
      setShare(shareProblem(err));
    }
  }

  return (
    <div data-testid="room-recap" className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-3 py-3">
        <h1 className="font-display text-2xl font-semibold text-cream">This game has ended</h1>
        <RecapResults rows={rows} amounts={settlement?.amounts ?? null} />

        {rows.length > 0 && (
          <section aria-labelledby="settle-title" className="flex flex-col gap-2">
            <h2 id="settle-title" className="font-display text-xl font-semibold text-cream">
              Settle up
            </h2>
            <div className="flex items-end gap-2">
              <label className="flex min-w-0 flex-1 flex-col text-sm text-cream/75">
                Chips
                <input
                  className={FIELD}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={13}
                  value={chipsText}
                  onChange={(e) => setChipsText(e.target.value)}
                />
              </label>
              <span aria-hidden="true" className="pb-3 text-lg text-cream/75">
                =
              </span>
              <label className="flex min-w-0 flex-1 flex-col text-sm text-cream/75">
                Amount
                <input
                  className={FIELD}
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={13}
                  placeholder="10.00"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                />
              </label>
            </div>
            {problem ? (
              <p role="alert" className="text-sm text-chip-red">
                {problem}
              </p>
            ) : (
              <p className="text-sm text-cream/60">
                {host
                  ? 'This rate goes into the shared link. FELT never moves money.'
                  : "Only on your screen; the host's rate goes into the shared link. FELT never moves money."}
              </p>
            )}
            {settlement && <WhoPaysWhom settlement={settlement} />}
          </section>
        )}
      </div>

      {host && rows.length > 0 ? (
        <ShareBar
          // A link made with another rate is not this screen's link.
          state={
            share.kind === 'done' && share.rateKey !== rateKey ? { kind: 'idle' as const } : share
          }
          disabled={problem !== null}
          withRate={rate !== null}
          onCreate={() => void create()}
        />
      ) : (
        <Link
          to="/"
          className="flex min-h-14 items-center justify-center rounded-2xl border border-brass text-lg font-semibold text-brass"
        >
          Go home
        </Link>
      )}
    </div>
  );
}
