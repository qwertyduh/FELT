import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import {
  parseTolerant,
  RecapSlugSchema,
  SharedRecapResponseSchema,
  type SharedRecapResponse,
} from '@felt/protocol';
import { RecapResults } from '../components/recap/RecapResults';
import { WhoPaysWhom } from '../components/recap/WhoPaysWhom';
import { getWebEnv } from '../lib/env';
import { chips, money, rowsOf, sharedSettlement } from '../lib/recap';

type Load =
  | { kind: 'loading' }
  | { kind: 'ok'; data: SharedRecapResponse }
  | { kind: 'gone' }
  | { kind: 'failed' };

const day = (ms: number) =>
  new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** No sign-in, so a plain request (`apiFetch` would ask for a session). */
async function fetchRecap(slug: string, signal: AbortSignal): Promise<Load> {
  try {
    const res = await fetch(`${getWebEnv().serverUrl}/recaps/${slug}`, { signal });
    if (res.status === 404) return { kind: 'gone' };
    if (!res.ok) return { kind: 'failed' };
    const parsed = parseTolerant(SharedRecapResponseSchema, await res.json());
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

function Message({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="status" className="flex flex-1 flex-col items-center justify-center gap-4">
      <h1 className="font-display text-2xl font-semibold text-balance text-cream">{title}</h1>
      {children}
    </div>
  );
}

function Shared({ slug }: { slug: string }) {
  const [attempt, setAttempt] = useState(0);
  const valid = RecapSlugSchema.safeParse(slug).success;
  const [load, setLoad] = useState<Load>({ kind: valid ? 'loading' : 'gone' });

  useEffect(() => {
    if (!valid) return;
    const controller = new AbortController();
    void fetchRecap(slug, controller.signal).then((next) => {
      if (!controller.signal.aborted) setLoad(next);
    });
    return () => controller.abort();
  }, [slug, valid, attempt]);

  if (load.kind === 'loading') return <Message title="Loading the recap…" />;
  if (load.kind === 'gone') {
    return (
      <Message title="Recap not found">
        <p className="text-base text-cream/75">Recap links expire after 7 days.</p>
      </Message>
    );
  }
  if (load.kind === 'failed') {
    return (
      <Message title="Couldn't load the recap">
        <button
          type="button"
          className="min-h-12 rounded-xl border border-brass px-5 text-base font-semibold text-brass"
          onClick={() => {
            setLoad({ kind: 'loading' });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </Message>
    );
  }

  const { recap, expiresAt } = load.data;
  const settlement = sharedSettlement(recap);
  const rate = recap.settlement?.rate;
  return (
    <div data-testid="shared-recap" className="flex flex-col gap-3 py-2 text-left">
      <header>
        <h1 className="font-display text-2xl font-semibold text-cream">Game recap</h1>
        <p className="text-sm text-cream/60">
          Played {day(recap.endedAt)}. Link expires {day(expiresAt)}.
        </p>
      </header>
      <RecapResults rows={rowsOf(recap.players)} amounts={settlement?.amounts ?? null} />
      {settlement && rate && (
        <section className="flex flex-col gap-2">
          <h2 className="font-display text-xl font-semibold text-cream">Settle up</h2>
          <p className="text-sm text-cream/60">
            {chips(rate.chips)} chips = {money(rate.minorUnits)}. FELT never moves money.
          </p>
          <WhoPaysWhom settlement={settlement} />
        </section>
      )}
    </div>
  );
}

export function Recap() {
  const { slug = '' } = useParams<{ slug: string }>();
  return (
    <section className="flex flex-1 flex-col text-center">
      {/* A full page load, so the app signs in as usual (nothing here has). */}
      <a href="/" className="inline-flex min-h-11 items-center self-start text-base text-brass">
        <span aria-hidden="true" className="mr-2">
          ←
        </span>
        FELT
      </a>
      <Shared key={slug} slug={slug} />
    </section>
  );
}
