import { chips, imbalanceNotice, money, signed, type ResultRow } from '../../lib/recap';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-cream/60">{label}</dt>
      <dd className="text-base wrap-anywhere text-cream tabular-nums">{value}</dd>
    </div>
  );
}

/** Everyone who played, best result first (the server's order). */
export function RecapResults({
  rows,
  amounts,
}: {
  rows: ResultRow[];
  /** Money per row in hundredths, when there is a rate. */
  amounts: number[] | null;
}) {
  const notice = imbalanceNotice(rows);
  if (rows.length === 0) {
    return <p className="py-4 text-center text-base text-cream/75">Nobody played a part.</p>;
  }
  return (
    <>
      {notice && (
        <p
          data-testid="recap-imbalance"
          className="rounded-xl border border-chip-red px-3 py-2 text-sm text-chip-red"
        >
          {notice}
        </p>
      )}
      <ul aria-label="Results" className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <li
            key={i}
            data-testid="recap-player"
            className="rounded-2xl border border-felt-700 bg-felt-950/70 px-3 py-2"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-lg font-semibold wrap-anywhere text-cream">
                {r.name}
                {r.you && <span className="ml-2 text-sm font-normal text-brass">You</span>}
              </p>
              <p className="shrink-0 text-right tabular-nums">
                <span
                  data-testid="recap-net"
                  className={`block text-xl font-semibold ${
                    r.net > 0 ? 'text-chip-green' : r.net < 0 ? 'text-chip-red' : 'text-cream'
                  }`}
                >
                  {signed(r.net)}
                </span>
                {amounts && (
                  <span data-testid="recap-money" className="block text-sm text-cream/75">
                    {signed(amounts[i] ?? 0, money)}
                  </span>
                )}
              </p>
            </div>
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
              <Stat label="Bought in" value={chips(r.boughtIn)} />
              <Stat label="Final stack" value={chips(r.finalStack)} />
              <Stat label="Hands won" value={`${chips(r.handsWon)} of ${chips(r.handsPlayed)}`} />
              <Stat label="Biggest pot won" value={chips(r.biggestPot)} />
            </dl>
            {r.adjusted !== 0 && (
              <p className="mt-1 text-sm text-brass">
                Includes host correction {signed(r.adjusted)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
