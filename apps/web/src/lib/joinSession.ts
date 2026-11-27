/**
 * The life of one visit to `/r/:code` (P36): connect, find out whether this user is already in,
 * otherwise ask to join and wait for the host. One socket per visit, because
 * `room:join_decision` carries no room code.
 *
 * On every (re)connect: `room:enter` first (the server is the authority on admission), then
 * `room:request_join` again only while a request of ours has not passed its deadline, so an expired
 * request is never silently re-created. Nothing is emitted while disconnected (socket.io would
 * buffer it), and no other room event may be sent until `ready` (the `room:enter` ack).
 */
import {
  DENY_COOLDOWN_MS,
  JOIN_REQUEST_TTL_MS,
  type RoomCode,
  type RoomPreview,
  type ServerEventPayload,
} from '@felt/protocol';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { ApiError } from './apiFetch';
import { readJoinMemory, writeJoinMemory, type JoinMemory } from './joinStorage';
import { bindRoomEvents } from './realtime/bindRoomEvents';
import { resetRoom } from './realtime/roomStore';
import type { SocketClient } from './realtime/socketClient';

export type JoinPhase =
  /** Not yet known whether we are admitted. */
  | { name: 'loading' }
  | { name: 'preview' }
  | { name: 'requesting' }
  | { name: 'pending'; requestId: string; deadline: number }
  | { name: 'denied'; until: number }
  | { name: 'expired' }
  /** Admitted, waiting for the `room:enter` ack. */
  | { name: 'entering' }
  | { name: 'entered' }
  /** The host removed us; coming back takes a new request. */
  | { name: 'kicked' }
  | { name: 'ended' }
  | { name: 'missing' };

export interface JoinState {
  phase: JoinPhase;
  preview: RoomPreview | null;
  previewError: string | null;
  connected: boolean;
  /** True only between a successful `room:enter` ack and the next disconnect. */
  ready: boolean;
  /** The last thing that went wrong, for the screen. */
  problem: string | null;
}

export interface JoinSessionDeps {
  code: RoomCode;
  userId: string;
  client: SocketClient;
  fetchPreview: () => Promise<RoomPreview>;
}

export interface JoinSession {
  store: StoreApi<JoinState>;
  start(): void;
  /** Leaving the screen: drops the socket and the room state. A pending request stays. */
  stop(): void;
  request(): void;
  cancel(): void;
  retry(): void;
}

/** How long after our deadline we wait for the server's expiry notice before asking. */
export const EXPIRY_GRACE_MS = 2_000;
export const RETRY_MS = 3_000;
const MIN_COOLDOWN_MS = 5_000;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

export function createJoinSession(deps: JoinSessionDeps): JoinSession {
  const { code, userId, client } = deps;
  const store = createStore<JoinState>(() => ({
    phase: { name: 'loading' },
    preview: null,
    previewError: null,
    connected: false,
    ready: false,
    problem: null,
  }));
  const get = () => store.getState();
  const set = (patch: Partial<JoinState>) => store.setState(patch);

  let stopped = false;
  /** Bumped on connect, disconnect and stop: answers from an older connection are ignored. */
  let epoch = 0;
  let entering: { epoch: number; done: Promise<void> } | null = null;
  /** A `room:request_join` is in flight, so a decision now is its reply (maybe an old denial). */
  let asking = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let unbind: (() => void) | undefined;

  /** The last write reached storage, which all tabs share: from then on it is the truth. */
  let persisted = false;
  const remember = (memory: JoinMemory | null) => {
    persisted = writeJoinMemory(userId, code, memory);
  };
  /** Our pending request is gone from shared storage: another tab cancelled or settled it. */
  const droppedElsewhere = () =>
    get().phase.name === 'pending' && persisted && readJoinMemory(userId, code) === null;

  function show(phase: JoinPhase): void {
    clearTimeout(expiryTimer);
    if (phase.name === 'pending') {
      remember({ kind: 'pending', requestId: phase.requestId, deadline: phase.deadline });
      armExpiry(phase.deadline - Date.now() + EXPIRY_GRACE_MS);
    } else if (phase.name === 'denied') {
      remember({ kind: 'denied', until: phase.until });
    } else if (phase.name !== 'loading' && phase.name !== 'requesting') {
      remember(null);
    }
    set({ phase, ready: phase.name === 'entered', problem: null });
  }

  function armExpiry(delay: number): void {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => void onDeadline(), Math.max(delay, 0));
  }

  function retryLater(fn: () => void): void {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!stopped && client.socket.connected) fn();
    }, RETRY_MS);
  }

  /** Our deadline passed with no word. Entering also makes the server prune and notify. */
  async function onDeadline(): Promise<void> {
    if (stopped || get().phase.name !== 'pending') return;
    if (!client.socket.connected) return show({ name: 'expired' }); // a reconnect checks again
    const at = epoch;
    const res = await client.emitWithAck('room:enter', { code });
    if (at !== epoch || get().phase.name !== 'pending') return;
    if (res.ok) show({ name: 'entered' });
    else if (res.error.code === 'not_admitted') show({ name: 'expired' });
    else if (res.error.code === 'room_ended') show({ name: 'ended' });
    else if (res.error.code === 'not_found') show({ name: 'missing' });
    else armExpiry(RETRY_MS);
  }

  /** `room:enter`, single-flight per connection. */
  function enter(): Promise<void> {
    if (entering?.epoch === epoch) return entering.done;
    const at = epoch;
    const done = doEnter(at).finally(() => {
      if (entering?.done === done) entering = null;
    });
    entering = { epoch: at, done };
    return done;
  }

  async function doEnter(at: number): Promise<void> {
    if (!client.socket.connected) return;
    const res = await client.emitWithAck('room:enter', { code });
    if (at !== epoch) return;
    if (res.ok) return show({ name: 'entered' });
    switch (res.error.code) {
      case 'not_admitted':
        return resume();
      case 'room_ended':
        return show({ name: 'ended' });
      case 'not_found':
        return show({ name: 'missing' });
      default:
        set({ problem: "Couldn't reach the table. Trying again…" });
        retryLater(() => void enter());
    }
  }

  /** Not admitted: pick up whatever we were doing. */
  function resume(): void {
    const { phase } = get();
    if (phase.name === 'entered') {
      resetRoom(); // no longer admitted: none of the room's state may stay on screen
      return show({ name: 'preview' });
    }
    if (phase.name === 'requesting') return void ask();
    if (['kicked', 'expired', 'ended', 'missing'].includes(phase.name)) return;
    // What this tab holds counts only if storage could not keep it: never revive a request that
    // another tab removed.
    const held: JoinMemory | null =
      phase.name === 'pending'
        ? { kind: 'pending', requestId: phase.requestId, deadline: phase.deadline }
        : phase.name === 'denied'
          ? { kind: 'denied', until: phase.until }
          : null;
    const memory = persisted
      ? readJoinMemory(userId, code)
      : (held ?? readJoinMemory(userId, code));
    if (memory?.kind === 'pending') {
      if (memory.deadline <= Date.now()) return show({ name: 'expired' });
      show({ name: 'pending', requestId: memory.requestId, deadline: memory.deadline });
      return void ask(); // a new socket must ask again to hear the decision
    }
    if (memory?.kind === 'denied' && memory.until > Date.now()) {
      return show({ name: 'denied', until: memory.until });
    }
    show({ name: 'preview' });
  }

  async function ask(): Promise<void> {
    if (!client.socket.connected || asking) return;
    if (droppedElsewhere()) return show({ name: 'preview' });
    const at = epoch;
    const sentAt = Date.now();
    asking = true;
    if (get().phase.name !== 'pending') show({ name: 'requesting' });
    else set({ problem: null });
    const res = await client.emitWithAck('room:request_join', { code });
    if (at !== epoch) return;
    asking = false;
    const { phase } = get();
    if (res.ok) {
      // `ok` is a new request (join_pending came first). The server created it after `sentAt`, so
      // this deadline is never later than the server's, whatever the two clocks say.
      if (phase.name === 'pending') show({ ...phase, deadline: sentAt + JOIN_REQUEST_TTL_MS });
      return;
    }
    switch (res.error.code) {
      case 'already_requested':
        return;
      case 'cooldown':
        if (phase.name !== 'denied') {
          show({ name: 'denied', until: Date.now() + DENY_COOLDOWN_MS });
        }
        return;
      case 'room_ended':
        return show({ name: 'ended' });
      case 'not_found':
        return show({ name: 'missing' });
    }
    const problem =
      res.error.code === 'rate_limited'
        ? 'Too many requests. Wait a moment and try again.'
        : "Couldn't send your request. Try again.";
    if (phase.name === 'pending') {
      retryLater(() => void ask());
    } else if (phase.name === 'requesting') {
      show({ name: 'preview' });
      set({ problem });
    }
  }

  const onPending = ({ requestId, expiresAt }: ServerEventPayload<'room:join_pending'>) => {
    const memory = readJoinMemory(userId, code);
    const { phase } = get();
    if (phase.name === 'entered' || phase.name === 'entering') return;
    const known =
      phase.name === 'pending' && phase.requestId === requestId
        ? phase.deadline
        : memory?.kind === 'pending' && memory.requestId === requestId
          ? memory.deadline
          : null;
    const deadline = known ?? Date.now() + clamp(expiresAt - Date.now(), 0, JOIN_REQUEST_TTL_MS);
    show({ name: 'pending', requestId, deadline });
  };

  const onDecision = (d: ServerEventPayload<'room:join_decision'>) => {
    const { phase } = get();
    if (phase.name === 'entered' || phase.name === 'entering') return;
    if (d.ended) {
      show({ name: 'ended' });
    } else if (d.approved) {
      show({ name: 'entering' });
      void enter();
    } else if (d.retryAfter !== undefined) {
      // A live denial starts now. A reply to our request may be an older one: trust the server's
      // time, kept within sane bounds in case this device's clock is off.
      const left = asking
        ? clamp(d.retryAfter - Date.now(), MIN_COOLDOWN_MS, DENY_COOLDOWN_MS)
        : DENY_COOLDOWN_MS;
      show({ name: 'denied', until: Date.now() + left });
    } else if (phase.name === 'pending' || phase.name === 'requesting') {
      show({ name: 'expired' });
    }
  };

  /** Out of the room: answers still on the way no longer count, and its state goes. */
  const onKicked = (p: ServerEventPayload<'room:kicked'>) => {
    if (p.code !== code) return;
    epoch += 1;
    asking = false;
    clearTimeout(retryTimer);
    resetRoom();
    show({ name: 'kicked' });
  };

  /**
   * Shared storage changed. A request removed before its deadline was cancelled or settled in
   * another tab (an expiry cannot come early); a decision of our own still applies afterwards.
   */
  const onStorage = () => {
    const { phase } = get();
    if (phase.name === 'pending' && Date.now() < phase.deadline && droppedElsewhere()) {
      show({ name: 'preview' });
    }
  };

  const onConnect = () => {
    epoch += 1;
    asking = false;
    set({ connected: true, ready: false, problem: null });
    const { name } = get().phase;
    if (name !== 'ended' && name !== 'missing') void enter();
  };

  const onDisconnect = () => {
    epoch += 1;
    asking = false;
    clearTimeout(retryTimer);
    set({ connected: false, ready: false });
  };

  async function loadPreview(): Promise<void> {
    set({ previewError: null });
    try {
      const preview = await deps.fetchPreview();
      if (!stopped) set({ preview });
    } catch (err) {
      if (stopped) return;
      if (err instanceof ApiError && err.status === 404) {
        if (get().phase.name !== 'entered') show({ name: 'missing' });
      } else {
        set({ previewError: "Couldn't load this room. Check your connection and try again." });
      }
    }
  }

  return {
    store,
    start() {
      stopped = false;
      resetRoom();
      unbind = bindRoomEvents(client.socket);
      client.socket.on('connect', onConnect);
      client.socket.on('disconnect', onDisconnect);
      client.socket.on('room:join_pending', onPending);
      client.socket.on('room:join_decision', onDecision);
      client.socket.on('room:kicked', onKicked);
      window.addEventListener('storage', onStorage);
      void loadPreview();
      client.connect();
    },
    stop() {
      stopped = true;
      epoch += 1;
      clearTimeout(expiryTimer);
      clearTimeout(retryTimer);
      unbind?.();
      client.socket.off('connect', onConnect);
      client.socket.off('disconnect', onDisconnect);
      client.socket.off('room:join_pending', onPending);
      client.socket.off('room:join_decision', onDecision);
      client.socket.off('room:kicked', onKicked);
      window.removeEventListener('storage', onStorage);
      client.disconnect();
      resetRoom();
    },
    request() {
      const { phase } = get();
      const allowed =
        phase.name === 'preview' ||
        phase.name === 'expired' ||
        phase.name === 'kicked' ||
        (phase.name === 'denied' && phase.until <= Date.now());
      if (allowed) void ask();
    },
    cancel() {
      if (get().phase.name !== 'pending' || !client.socket.connected) return;
      const at = epoch;
      void client.emitWithAck('room:cancel_request', { code }).then((res) => {
        // A decision that arrived meanwhile wins.
        if (at !== epoch || get().phase.name !== 'pending') return;
        if (res.ok || res.error.code === 'not_found') show({ name: 'preview' });
        else set({ problem: "Couldn't cancel. Try again." });
      });
    },
    retry() {
      if (get().preview === null) void loadPreview();
      if (!client.socket.connected) client.connect();
      else void enter();
    },
  };
}
