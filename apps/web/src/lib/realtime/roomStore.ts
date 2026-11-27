import { create } from 'zustand';
import {
  PublicRoomStateSchema,
  type PublicRoomState,
  type ServerToClientEvents,
} from '@felt/protocol';

type PrivateHand = Parameters<ServerToClientEvents['hand:private']>[0];
type HostInbox = Parameters<ServerToClientEvents['host:inbox']>[0];
type JoinRequest = Parameters<ServerToClientEvents['host:join_request']>[0];
type TopUpRequest = Parameters<ServerToClientEvents['host:topup_request']>[0];

export interface RoomStoreState {
  room: PublicRoomState | null;
  lastVersion: number;
  status: 'empty' | 'ready';
  error: string | null;
  /** Set on reconnect; cleared by the next accepted `room:state`. */
  needsResync: boolean;
  /** Count of dropped invalid payloads (never logs the payload itself). */
  invalidDropped: number;
  /** Own hole cards for the current hand only. */
  privateHand: PrivateHand | null;
  hostInbox: {
    joinRequests: (JoinRequest & { expiresAt?: number })[];
    topUpRequests: TopUpRequest[];
  };
}

const emptyInbox: RoomStoreState['hostInbox'] = { joinRequests: [], topUpRequests: [] };

export const initialRoomState: RoomStoreState = {
  room: null,
  lastVersion: -1,
  status: 'empty',
  error: null,
  needsResync: false,
  invalidDropped: 0,
  privateHand: null,
  hostInbox: emptyInbox,
};

export const useRoomStore = create<RoomStoreState>(() => initialRoomState);

/**
 * Applies only newer versions of the same room; right after a reconnect the version already held
 * is accepted too (nothing changed while away: one version always has one content). Returns
 * whether it was applied.
 */
export function applyRoomState(next: unknown): boolean {
  const parsed = PublicRoomStateSchema.safeParse(next);
  if (!parsed.success) {
    useRoomStore.setState((s) => ({ invalidDropped: s.invalidDropped + 1 }));
    return false;
  }
  const incoming = parsed.data;
  const s = useRoomStore.getState();
  const sameRoom = s.room?.code === incoming.code;
  const floor = s.needsResync ? s.lastVersion : s.lastVersion + 1;
  if (sameRoom && incoming.version < floor) return false;
  useRoomStore.setState({
    ...(sameRoom ? {} : { ...initialRoomState, invalidDropped: s.invalidDropped }),
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

export function markNeedsResync(): void {
  useRoomStore.setState({ needsResync: true });
}

export function resetRoom(): void {
  useRoomStore.setState({ ...initialRoomState });
}
