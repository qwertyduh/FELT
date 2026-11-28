import { money, type SettlementRows } from '../../lib/recap';

export function WhoPaysWhom({ settlement }: { settlement: SettlementRows }) {
  const { transfers, unsettled } = settlement;
  return (
    <div data-testid="who-pays-whom" className="flex flex-col gap-2">
      <h3 className="text-base font-semibold text-cream">Who pays whom</h3>
      {transfers.length === 0 ? (
        <p className="text-base text-cream/75">No payments to make.</p>
      ) : (
        <ul className="divide-y divide-felt-700 rounded-2xl border border-brass-dim bg-felt-950/70 px-3">
          {transfers.map((t, i) => (
            <li key={i} className="flex items-center justify-between gap-3 py-2">
              <span className="min-w-0 text-base wrap-anywhere text-cream">
                <strong>{t.from}</strong> pays <strong>{t.to}</strong>
              </span>
              <span className="shrink-0 text-lg text-brass tabular-nums">{money(t.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      {unsettled.length > 0 && (
        <div data-testid="unsettled" className="rounded-xl border border-chip-red px-3 py-2">
          <p className="text-sm font-semibold text-chip-red">Left unsettled</p>
          <ul>
            {unsettled.map((u, i) => (
              <li key={i} className="text-sm wrap-anywhere text-cream">
                {u.name} {u.amount > 0 ? 'is still owed' : 'still owes'} {money(Math.abs(u.amount))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
