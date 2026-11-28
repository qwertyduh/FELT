/**
 * Opens and closes the chat panel. It takes its own place in the room header, never laid over
 * anything, with a count of the lines not yet seen.
 */
import { setChatOpen, useRoomStore } from '../../lib/realtime/roomStore';

export function ChatButton({ userId }: { userId: string }) {
  const open = useRoomStore((s) => s.chatOpen);
  const unread = useRoomStore((s) => s.chat.filter((m) => m.unread && m.userId !== userId).length);
  return (
    <button
      type="button"
      data-testid="chat-button"
      aria-expanded={open}
      aria-label={unread > 0 ? `Chat, ${unread} unread` : 'Chat'}
      className={`relative min-h-11 min-w-11 shrink-0 rounded-full border border-brass text-xs font-semibold shadow-md shadow-black/40 active:brightness-90 ${
        open ? 'bg-brass text-felt-950' : 'bg-felt-950 text-brass'
      }`}
      onClick={() => setChatOpen(!open)}
    >
      Chat
      {unread > 0 && (
        <span
          data-testid="chat-unread"
          aria-hidden="true"
          className="absolute -top-1 -right-1 min-w-4 rounded-full bg-chip-red px-1 text-[11px] leading-4 font-bold text-felt-950 tabular-nums"
        >
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}
