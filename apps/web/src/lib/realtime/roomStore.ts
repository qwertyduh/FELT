import { create } from 'zustand';
import {
  CHAT_HISTORY_LIMIT,
  ChatMessageSchema,
  PublicRoomStateSchema,
  RecapSchema,
  parseTolerant,
  serverEventSchemas,
  type ChatMessage,
  type PublicRoomState,
  type Recap,
  type ServerToClientEvents,
} from '@felt/protocol';
import { clearUpgrade, requireReload } from './upgradeStore';

type PrivateHand = Parameters<ServerToClientEvents['hand:private']>[0];
type HostInbox = Parameters<ServerToClientEvents['host:inbox']>[0];
type JoinRequest = Parameters<ServerToClientEvents['host:join_request']>[0];
type HostMembers = Parameters<ServerToClientEvents['host:members']>[0];
type TopUpRequest = Parameters<ServerToClientEvents['host:topup_request']>[0];
type TopUpStatus = Parameters<ServerToClientEvents['player:topup_status']>[0];
type TopUpDecision = Parameters<ServerToClientEvents['player:topup_decision']>[0];

/** A chat line as this screen holds it; `unread` until the panel has been open since it came. */
export type ChatLine = ChatMessage & { unread: boolean };
/** How many lines a screen keeps. */
export const CHAT_KEPT = 50;
/** How long a reaction stays at its seat. */
export const REACTION_SHOW_MS = 3_000;

export interface RoomStoreState {
  /** Oldest first. */
  chat: ChatLine[];
  chatOpen: boolean;
  /** What is typed but not sent: kept when the panel is put away. */
  chatDraft: string;
  /** The latest reaction of each user still on show; `n` tells one from the next. */
  reactions: Record<string, { emoji: string; n: number }>;
  room: PublicRoomState | null;
  lastVersion: number;
  status: 'empty' | 'ready';
  error: string | null;
  /** Set on reconnect; cleared by the next accepted `room:state`. */
  needsResync: boolean;
  /** Count of dropped invalid payloads (never logs the payload itself). */
  invalidDropped: number;
  /** The ended game's results (`session:recap`). */
  recap: Recap | null;
  /** Own hole cards for the current hand only. */
  privateHand: PrivateHand | null;
  /** Everyone seen on a seat in this room: a cashed-out player can still be in a hand's result. */
  names: Record<string, string>;
  /** The ended hand whose all-in run-out has been dealt out on this screen. */
  releasedHandId: string | null;
  /** Own top-up request still waiting for the host. */
  topUp: TopUpStatus['pending'];
  /** The host's latest answer to it, until the toast has been shown. */
  topUpDecision: TopUpDecision | null;
  /** Host only: everyone else admitted. */
  members: HostMembers['members'];
  hostInbox: {
    joinRequests: (JoinRequest & { expiresAt?: number })[];
    topUpRequests: TopUpRequest[];
  };
}

const emptyInbox: RoomStoreState['hostInbox'] = { joinRequests: [], topUpRequests: [] };

export const initialRoomState: RoomStoreState = {
  chat: [],
  chatOpen: false,
  chatDraft: '',
  reactions: {},
  room: null,
  lastVersion: -1,
  status: 'empty',
  error: null,
  needsResync: false,
  invalidDropped: 0,
  recap: null,
  privateHand: null,
  names: {},
  releasedHandId: null,
  topUp: null,
  topUpDecision: null,
  members: [],
  hostInbox: emptyInbox,
};

export const useRoomStore = create<RoomStoreState>(() => initialRoomState);

/**
 * Unknown keys are ignored; anything else wrong drops the state and asks for a reload, so a table
 * never just freezes.
 *
 * Applies only newer versions of the same room; right after a reconnect the version already held
 * is accepted too (nothing changed while away: one version always has one content). Returns
 * whether it was applied.
 */
export function applyRoomState(next: unknown): boolean {
  const parsed = parseTolerant(PublicRoomStateSchema, next);
  if (!parsed.success) {
    useRoomStore.setState((s) => ({ invalidDropped: s.invalidDropped + 1 }));
    requireReload('payload');
    return false;
  }
  clearUpgrade('payload');
  const incoming = parsed.data;
  const s = useRoomStore.getState();
  const sameRoom = s.room?.code === incoming.code;
  const floor = s.needsResync ? s.lastVersion : s.lastVersion + 1;
  if (sameRoom && incoming.version < floor) return false;
  // Only a switch from ANOTHER room clears it: on the first state of a room, `host:inbox` (which
  // the server sends just before it) must survive.
  const switched = s.room !== null && !sameRoom;
  const names = switched ? {} : { ...s.names };
  for (const seat of incoming.seats) if (seat) names[seat.userId] = seat.username;
  useRoomStore.setState({
    ...(switched ? { ...initialRoomState, invalidDropped: s.invalidDropped } : {}),
    names,
    room: incoming,
    lastVersion: incoming.version,
    status: 'ready',
    error: null,
    needsResync: false,
    privateHand:
      sameRoom && incoming.hand && s.privateHand?.handId === incoming.hand.handId
        ? s.privateHand
        : null,
  });
  return true;
}

export function applyRecap(next: unknown): void {
  const parsed = parseTolerant(RecapSchema, next);
  if (!parsed.success) {
    useRoomStore.setState((s) => ({ invalidDropped: s.invalidDropped + 1 }));
    requireReload('payload');
    return;
  }
  useRoomStore.setState({ recap: parsed.data });
}

/** `hand:private` replaces the previous hand's cards; a new hand id clears the old ones. */
export function applyPrivateHand(hand: PrivateHand): void {
  useRoomStore.setState({ privateHand: hand });
}

export function clearPrivateHand(): void {
  useRoomStore.setState({ privateHand: null });
}

export function applyHostInbox(inbox: HostInbox): void {
  useRoomStore.setState({ hostInbox: { ...inbox } });
}

export function applyHostMembers({ members }: HostMembers): void {
  useRoomStore.setState({ members });
}

export function addJoinRequest(req: JoinRequest): void {
  useRoomStore.setState((s) => ({
    hostInbox: {
      ...s.hostInbox,
      joinRequests: [...s.hostInbox.joinRequests.filter((r) => r.requestId !== req.requestId), req],
    },
  }));
}

export function addTopUpRequest(req: TopUpRequest): void {
  useRoomStore.setState((s) => ({
    hostInbox: {
      ...s.hostInbox,
      topUpRequests: [
        ...s.hostInbox.topUpRequests.filter((r) => r.requestId !== req.requestId),
        req,
      ],
    },
  }));
}

export function removeJoinRequest(requestId: string): void {
  useRoomStore.setState((s) => ({
    hostInbox: {
      ...s.hostInbox,
      joinRequests: s.hostInbox.joinRequests.filter((r) => r.requestId !== requestId),
    },
  }));
}

export function removeTopUpRequest(requestId: string): void {
  useRoomStore.setState((s) => ({
    hostInbox: {
      ...s.hostInbox,
      topUpRequests: s.hostInbox.topUpRequests.filter((r) => r.requestId !== requestId),
    },
  }));
}

export function applyTopUpStatus({ pending }: TopUpStatus): void {
  useRoomStore.setState({ topUp: pending });
}

export function applyTopUpDecision(decision: TopUpDecision): void {
  useRoomStore.setState({ topUpDecision: decision });
}

export function clearTopUpDecision(): void {
  useRoomStore.setState({ topUpDecision: null });
}

/** Merged by id, oldest first, the newest `CHAT_KEPT`. */
function addChat(lines: ChatMessage[], unread: boolean): void {
  useRoomStore.setState((s) => {
    const held = new Set(s.chat.map((m) => m.id));
    const fresh = lines
      .filter((m) => !held.has(m.id))
      .map((m) => ({ ...m, unread: unread && !s.chatOpen }));
    if (fresh.length === 0) return s;
    return { chat: [...s.chat, ...fresh].sort((a, b) => a.at - b.at).slice(-CHAT_KEPT) };
  });
}

/** A line that does not fit the schema is dropped: chat is never worth a reload screen. */
export function applyChatMessage(next: unknown): void {
  const parsed = parseTolerant(ChatMessageSchema, next);
  if (parsed.success) return addChat([parsed.data], true);
  useRoomStore.setState((s) => ({ invalidDropped: s.invalidDropped + 1 }));
}

/**
 * What the room kept, on entry. On a screen that already had lines (a reconnect) the ones it
 * missed are unread; on a fresh one they are just what was said before.
 */
export function applyChatHistory(next: unknown): void {
  const parsed = parseTolerant(serverEventSchemas['chat:history'], next);
  if (!parsed.success) {
    useRoomStore.setState((s) => ({ invalidDropped: s.invalidDropped + 1 }));
    return;
  }
  const known = useRoomStore.getState().chat.length > 0;
  addChat(parsed.data.messages.slice(-CHAT_HISTORY_LIMIT), known);
}

let reactionCount = 0;
export function applyReaction(next: unknown): void {
  const parsed = parseTolerant(serverEventSchemas['chat:reaction'], next);
  if (!parsed.success) {
    useRoomStore.setState((s) => ({ invalidDropped: s.invalidDropped + 1 }));
    return;
  }
  const { userId, emoji } = parsed.data;
  const n = ++reactionCount;
  useRoomStore.setState((s) => ({ reactions: { ...s.reactions, [userId]: { emoji, n } } }));
  setTimeout(() => {
    useRoomStore.setState((s) => {
      if (s.reactions[userId]?.n !== n) return s;
      const { [userId]: gone, ...reactions } = s.reactions;
      void gone;
      return { reactions };
    });
  }, REACTION_SHOW_MS);
}

/** Opening it, or closing it, reads whatever was there. */
export function setChatOpen(chatOpen: boolean): void {
  useRoomStore.setState((s) => ({
    chatOpen,
    chat: s.chat.some((m) => m.unread) ? s.chat.map((m) => ({ ...m, unread: false })) : s.chat,
  }));
}

export function setChatDraft(chatDraft: string): void {
  useRoomStore.setState({ chatDraft });
}

/**
 * A reconnect. The host's lists go: the server sends them again on entry if we are still the host,
 * and says nothing if the role moved on while we were away.
 */
export function markNeedsResync(): void {
  useRoomStore.setState({ needsResync: true, hostInbox: emptyInbox, members: [] });
}

export function resetRoom(): void {
  useRoomStore.setState({ ...initialRoomState });
}
