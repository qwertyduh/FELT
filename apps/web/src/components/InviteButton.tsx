/**
 * Invite: opens the sheet with the code and link. It is open by itself once, for whoever has just
 * created the room, and gets out of the way when `dismissKey` says something cannot wait.
 */
import { useEffect, useState } from 'react';
import { forgetCreated, isJustCreated } from '../lib/justCreated';
import { InviteSheet } from './InviteSheet';

export function InviteButton({
  code,
  dismissKey = null,
}: {
  code: string;
  /** Closes the sheet whenever it changes to something. */
  dismissKey?: string | null;
}) {
  const [open, setOpen] = useState(() => isJustCreated(code));
  useEffect(() => forgetCreated(code), [code]);
  // Only as it arrives: the sheet may still be opened during a turn.
  const [seenKey, setSeenKey] = useState(dismissKey);
  if (seenKey !== dismissKey) {
    setSeenKey(dismissKey);
    if (dismissKey !== null) setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        className="min-h-11 shrink-0 rounded-xl border border-brass px-3 text-base font-semibold text-brass active:brightness-90"
        onClick={() => setOpen(true)}
      >
        Invite
      </button>
      {open && <InviteSheet code={code} onClose={() => setOpen(false)} />}
    </>
  );
}
