/**
 * Confirms folding a disconnected player's hand (P45): it names them. Mounted for one `turnSeq`
 * and one player, so it never confirms a fold other than the one it shows.
 */
import type { ReactNode } from 'react';
import { OUTLINE, SHEET, SOLID, type Tap } from '../lib/actionUi';

export function ForceFoldSheet({
  username,
  id,
  tap,
  notice,
  onBack,
  onFold,
}: {
  username: string;
  /** Names the state of the hand and the player: the button is held again when either changes. */
  id: string;
  tap: Tap;
  notice: ReactNode;
  onBack: () => void;
  onFold: () => void;
}) {
  return (
    <div
      data-cover
      data-testid="fold-sheet"
      role="group"
      aria-label="Fold away player"
      className={SHEET}
    >
      {notice}
      <div className="text-center">
        <p className="text-lg font-semibold wrap-anywhere text-cream">
          Fold {username}&apos;s hand?
        </p>
        <p className="text-sm text-cream/75">
          They&apos;re disconnected. Chips they&apos;ve put in stay in the pot. This can&apos;t be
          undone.
        </p>
      </div>
      <div className="grid shrink-0 grid-cols-3 gap-2">
        <button type="button" className={OUTLINE} onClick={onBack}>
          Back
        </button>
        <button key={id} type="button" className={`${SOLID} col-span-2`} {...tap(id, onFold)}>
          <span className="block w-full truncate">Fold {username}</span>
        </button>
      </div>
    </div>
  );
}
