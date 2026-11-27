/**
 * Confirms the host's undo (P42): it names the one step that goes back. Mounted for one
 * `turnSeq`, so it never confirms a different step than the one it shows.
 */
import type { PublicHand, PublicRoomState } from '@felt/protocol';
import { OUTLINE, SHEET, SOLID, type Tap } from '../../lib/actionUi';
import { undoName } from '../../lib/hybrid';

export function UndoSheet({
  room,
  hand,
  turnKey,
  tap,
  notice,
  onBack,
  onUndo,
}: {
  room: PublicRoomState;
  hand: PublicHand;
  turnKey: string;
  tap: Tap;
  notice: React.ReactNode;
  onBack: () => void;
  onUndo: () => void;
}) {
  return (
    <div data-cover data-testid="undo-sheet" role="group" aria-label="Undo" className={SHEET}>
      {notice}
      <div className="text-center">
        <p className="text-lg font-semibold wrap-anywhere text-cream">
          Undo {undoName(room, hand)}?
        </p>
        <p className="text-sm text-cream/75">
          Chips and turn go back to how they were just before it.
          {hand.pendingAwards.length > 0 && ' The disputed result is dropped.'}
        </p>
      </div>
      <div className="grid shrink-0 grid-cols-3 gap-2">
        <button type="button" className={OUTLINE} onClick={onBack}>
          Back
        </button>
        <button
          key={turnKey}
          type="button"
          className={`${SOLID} col-span-2`}
          {...tap(`undo:${turnKey}`, onUndo)}
        >
          Undo it
        </button>
      </div>
    </div>
  );
}
