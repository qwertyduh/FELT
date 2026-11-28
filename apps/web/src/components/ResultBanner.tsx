/**
 * How an online hand ended (P50): each pot's winners, amounts and hand, above the table, where the
 * blinds line is between hands: clear of the cards, the viewer's own and the action bar. During an
 * all-in run-out it only says what is being dealt, in the same box. It is given the room as the
 * table shows it, so a held result is not in it to leak. It stays in sight if the request cards make
 * the top of the screen scroll.
 *
 * A player cashed out as the hand ended has no seat to show cards on: theirs are shown here.
 */
import type { PublicRoomState } from '@felt/protocol';
import { useRoomStore } from '../lib/realtime/roomStore';
import { potLines } from '../lib/result';
import { PlayingCard } from './cards/PlayingCard';

const NEXT: Readonly<Record<number, string>> = { 0: 'flop', 3: 'turn', 4: 'river' };

export function ResultBanner({
  room,
  userId,
  held,
}: {
  room: PublicRoomState;
  userId: string;
  held: boolean;
}) {
  const names = useRoomStore((s) => s.names);
  const { hand } = room;
  const outcome = hand?.outcome;
  if (!outcome) return null;
  const nameOf = (id: string) =>
    room.seats.find((s) => s?.userId === id)?.username ?? names[id] ?? 'A player who left';
  const gone = outcome.hands.filter((h) => !room.seats.some((s) => s?.userId === h.userId));
  const lines = potLines(outcome, userId, nameOf);
  const single = lines.length === 1;
  return (
    <div
      role="status"
      aria-label="Hand result"
      // Scrolls when there are many pots or long names; reachable by keyboard too.
      tabIndex={0}
      data-testid="result-banner"
      // A new box per hand, so it never opens scrolled down.
      key={hand.handId}
      // On a short screen the "Game paused" line takes some of the banner's room.
      className={`${room.paused ? 'max-h-16' : 'max-h-20'} sticky top-0 z-[6] mt-1 flex min-h-12 shrink-0 flex-col overflow-y-auto rounded-xl border-2 border-brass bg-felt-950 px-2 py-0.5 text-center leading-tight wrap-anywhere [@media(min-height:640px)]:max-h-28 [@media(min-height:740px)]:max-h-48 [[data-testid=entered-room]:has([data-testid=host-inbox])_&]:max-h-13`}
    >
      {/* Centred while it fits; the top stays reachable when it does not. */}
      <div className="my-auto">
        {held ? (
          <p className="text-base font-semibold text-cream">
            All-in. Dealing the {NEXT[hand.board.length] ?? 'result'}…
          </p>
        ) : (
          <ul aria-label="Winners">
            {lines.map((line) =>
              single ? (
                <li key={line.potId}>
                  <p className="text-sm font-semibold text-brass [@media(min-height:640px)]:text-base [&]:leading-tight">
                    {line.headline}
                  </p>
                  {line.detail.length > 0 && (
                    <p className="text-xs text-cream [@media(min-height:640px)]:text-sm [&]:leading-tight">
                      {line.detail.join(' · ')}
                    </p>
                  )}
                </li>
              ) : (
                // Several pots: one run of text each, so as many as possible show at once.
                <li
                  key={line.potId}
                  className="text-xs text-cream [@media(min-height:640px)]:text-sm [&]:leading-tight"
                >
                  <span className="font-semibold text-brass">
                    <span className="text-cream">{line.pot}: </span>
                    {line.headline}
                  </span>
                  {line.detail.length > 0 && ` · ${line.detail.join(' · ')}`}
                </li>
              ),
            )}
          </ul>
        )}
        {gone.map((h) => (
          <p key={h.userId} className="flex items-center justify-center gap-1 text-sm text-cream">
            <span className="min-w-0 truncate">
              {names[h.userId] ? `${names[h.userId]} (left)` : nameOf(h.userId)}
            </span>
            {h.cards.map((card) => (
              <PlayingCard key={card} card={card} className="w-6" />
            ))}
          </p>
        ))}
      </div>
    </div>
  );
}
