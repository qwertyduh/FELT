/**
 * Online chat is "on" (PRD 5.7): a line from somebody else shows for a few seconds while the panel
 * is closed. It lies over the left of the blinds row only (never over the table, the turn line or
 * the actions) and takes no taps. Hybrid players sit together, so theirs stays collapsed.
 */
import { useEffect, useState } from 'react';
import { useRoomStore } from '../../lib/realtime/roomStore';

export const PREVIEW_MS = 4_000;

export function ChatPreview({ userId }: { userId: string }) {
  const line = useRoomStore(
    (s) => s.chat.filter((m) => m.unread && m.userId !== userId).at(-1) ?? null,
  );
  const [gone, setGone] = useState<string | null>(null);
  const id = line?.id ?? null;
  useEffect(() => {
    if (id === null) return;
    const timer = setTimeout(() => setGone(id), PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [id]);
  if (!line || line.id === gone) return null;
  return (
    <p
      data-testid="chat-preview"
      role="status"
      className="pointer-events-none absolute inset-y-0 right-24 left-0 z-[6] flex items-center gap-1.5 overflow-hidden rounded-xl border border-felt-700 bg-felt-950 px-2 text-sm text-cream"
    >
      {/* A long name gives way: some of the message always shows. */}
      <bdi className="max-w-2/5 shrink-0 truncate font-semibold text-brass">{line.username}</bdi>
      <bdi className="min-w-0 truncate">{line.text}</bdi>
    </p>
  );
}
