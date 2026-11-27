/**
 * The host picks the winner(s) of every pot (PRD 5.5). Only a pot's eligible players are offered;
 * two or more split it. It is mounted for one `turnSeq`, so picks never carry over to a changed
 * hand.
 */
import { useState } from 'react';
import type { PublicHand, PublicRoomState } from '@felt/protocol';
import { OUTLINE, SHEET, SOLID, type Tap } from '../../lib/actionUi';
import { initialPicks, playerName, type Award } from '../../lib/hybrid';
import { shortChips } from '../../lib/seating';
import { potName } from '../../lib/table';

export function AwardSheet({
  room,
  hand,
  turnKey,
  tap,
  notice,
  onBack,
  onAward,
}: {
  room: PublicRoomState;
  hand: PublicHand;
  turnKey: string;
  tap: Tap;
  notice: React.ReactNode;
  onBack: () => void;
  onAward: (awards: Award[]) => void;
}) {
  const [picks, setPicks] = useState(() => initialPicks(hand));
  const complete = hand.pots.every((p) => picks[p.id]!.length > 0);
  const toggle = (potId: string, userId: string) =>
    setPicks((all) => {
      const now = all[potId]!;
      const next = now.includes(userId) ? now.filter((w) => w !== userId) : [...now, userId];
      return { ...all, [potId]: next };
    });
  const confirm = tap(`award:${turnKey}`, () =>
    onAward(hand.pots.map((p) => ({ potId: p.id, winners: picks[p.id]! }))),
  );
  return (
    <div data-cover data-testid="award-sheet" role="group" aria-label="Winners" className={SHEET}>
      {notice}
      <p className="text-center text-sm text-cream/75">
        Tap who won each pot. Tap more than one to split.
      </p>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        {hand.pots.map((pot, i) => (
          <fieldset key={pot.id} data-testid={`award-${pot.id}`} className="min-w-0 shrink-0">
            <legend className="mb-1 text-sm font-semibold text-brass tabular-nums">
              {potName(i, hand.pots.length)} {shortChips(pot.amount, 100_000_000)}
              {picks[pot.id]!.length > 1 && ` · split ${picks[pot.id]!.length} ways`}
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {pot.eligible.map((userId) => {
                const on = picks[pot.id]!.includes(userId);
                return (
                  <button
                    key={userId}
                    type="button"
                    aria-pressed={on}
                    // One possible winner: nothing to choose.
                    disabled={pot.eligible.length === 1}
                    className={`min-h-11 min-w-0 truncate rounded-xl border px-2 text-base ${
                      on
                        ? 'border-brass bg-brass font-semibold text-felt-950'
                        : 'border-felt-700 text-cream'
                    }`}
                    onClick={() => toggle(pot.id, userId)}
                  >
                    {on && <span aria-hidden="true">✓ </span>}
                    {playerName(room, userId)}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="grid shrink-0 grid-cols-3 gap-2">
        <button type="button" className={OUTLINE} onClick={onBack}>
          Back
        </button>
        <button
          key={turnKey}
          type="button"
          className={`${SOLID} col-span-2`}
          {...confirm}
          disabled={confirm.disabled || !complete}
        >
          {hand.pots.length > 1 ? `Award ${hand.pots.length} pots` : 'Award pot'}
        </button>
      </div>
    </div>
  );
}
