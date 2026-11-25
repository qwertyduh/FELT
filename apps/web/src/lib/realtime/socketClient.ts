import {
  io as defaultIo,
  type ManagerOptions,
  type Socket,
  type SocketOptions,
} from 'socket.io-client';
import type {
  Ack,
  ClientEventName,
  ClientToServerEvents,
  ServerToClientEvents,
} from '@felt/protocol';
import { useAuthStore } from './../authStore';
import { setConnectionStatus } from './connectionStore';

export type FeltSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
export type IoFactory = (url: string, opts: Partial<ManagerOptions & SocketOptions>) => FeltSocket;

export interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

export interface SocketClientOptions {
  url: string;
  /** Freshest access token, or null when signed out. Evaluated on every connect attempt. */
  getToken: () => string | null | Promise<string | null>;
  /** Refresh the session (default: Supabase `refreshSession` via the auth store). Called once per auth failure. */
  refresh?: () => Promise<void>;
  io?: IoFactory;
  now?: () => number;
  timers?: Timers;
  random?: () => number;
  /** Reconnect this long before the access token expires. */
  refreshLeadMs?: number;
  maxAuthFailures?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

export const REFRESH_LEAD_MS = 5 * 60_000;
const MIN_PROACTIVE_MS = 10_000;

/** `exp` (epoch ms) of a JWT, or null if undecodable. Never verifies; only schedules. */
export function tokenExpiryMs(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='))) as {
      exp?: unknown;
    };
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function authStoreToken(): string | null {
  return useAuthStore.getState().session?.access_token ?? null;
}

async function defaultRefresh(): Promise<void> {
  const [{ getSupabase }, { applySession }] = await Promise.all([
    import('../supabase'),
    import('../authStore'),
  ]);
  const { data, error } = await getSupabase().auth.refreshSession();
  if (error) throw error;
  if (data.session) applySession(data.session);
}

function errorCode(err: unknown): string {
  const e = err as { data?: { code?: unknown }; message?: unknown } | null;
  if (e && typeof e.data?.code === 'string') return e.data.code;
  return typeof e?.message === 'string' ? e.message : 'unknown';
}

export type AckResult = Ack;

export interface SocketClient {
  socket: FeltSocket;
  connect(): void;
  disconnect(): void;
  on: FeltSocket['on'];
  off: FeltSocket['off'];
  emitWithAck<K extends ClientEventName>(
    event: K,
    payload: Parameters<ClientToServerEvents[K]>[0] extends (res: Ack) => void
      ? undefined
      : Parameters<ClientToServerEvents[K]>[0],
    opts?: { timeoutMs?: number },
  ): Promise<AckResult>;
}

export function createSocketClient(options: SocketClientOptions): SocketClient {
  const {
    url,
    getToken,
    refresh = defaultRefresh,
    io = defaultIo as unknown as IoFactory,
    now = Date.now,
    timers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    },
    random = Math.random,
    refreshLeadMs = REFRESH_LEAD_MS,
    maxAuthFailures = 3,
    backoffBaseMs = 1000,
    backoffMaxMs = 30_000,
  } = options;

  const socket = io(url, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: backoffBaseMs,
    reconnectionDelayMax: backoffMaxMs,
    randomizationFactor: 0.5,
    auth: (cb) => {
      void Promise.resolve(getToken()).then(
        (token) => cb({ token: token ?? '' }),
        () => cb({ token: '' }),
      );
    },
  });

  let wanted = false;
  let everConnected = false;
  let authFailures = 0;
  let unavailableAttempts = 0;
  let retryTimer: unknown = null;
  let proactiveTimer: unknown = null;

  const clearRetry = () => {
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
  };
  const clearProactive = () => {
    if (proactiveTimer !== null) timers.clearTimeout(proactiveTimer);
    proactiveTimer = null;
  };

  function backoff(attempt: number): number {
    const exp = Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempt);
    return Math.round(exp * (0.5 + random() * 0.5));
  }

  function scheduleRetry(ms: number, beforeConnect?: () => Promise<void>): void {
    clearRetry();
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (!wanted) return;
      void (async () => {
        try {
          await beforeConnect?.();
        } catch {
          // A failed refresh still retries the connect; the server decides.
        }
        if (wanted && !socket.connected) socket.connect();
      })();
    }, ms);
  }

  async function scheduleProactive(): Promise<void> {
    clearProactive();
    let token: string | null;
    try {
      token = await getToken();
    } catch {
      return;
    }
    const exp = token ? tokenExpiryMs(token) : null;
    if (exp === null || !wanted || !socket.connected) return;
    const delay = Math.max(MIN_PROACTIVE_MS, exp - now() - refreshLeadMs);
    proactiveTimer = timers.setTimeout(() => {
      proactiveTimer = null;
      if (!wanted) return;
      void (async () => {
        try {
          await refresh();
        } catch {
          // Reconnect anyway; token_expired handling will cope.
        }
        if (!wanted) return;
        setConnectionStatus('reconnecting');
        // Disconnect + connect re-evaluates the auth callback with the new token.
        socket.disconnect();
        socket.connect();
      })();
    }, delay);
  }

  socket.on('connect', () => {
    authFailures = 0;
    unavailableAttempts = 0;
    everConnected = true;
    clearRetry();
    setConnectionStatus('connected');
    void scheduleProactive();
  });

  socket.on('disconnect', (reason) => {
    clearProactive();
    if (!wanted) return;
    setConnectionStatus('reconnecting');
    // The server closes at token `exp`: socket.io will not retry that on its own.
    if (reason === 'io server disconnect') scheduleRetry(0, refresh);
  });

  socket.on('connect_error', (err) => {
    if (!wanted) return;
    const code = errorCode(err);
    if (code === 'unauthorized' || code === 'token_expired') {
      authFailures += 1;
      if (authFailures > maxAuthFailures) {
        setConnectionStatus('error', code);
        return;
      }
      setConnectionStatus('reconnecting', code);
      scheduleRetry(0, refresh);
    } else if (code === 'auth_unavailable') {
      // Server-side outage: never sign out, never refresh. Back off.
      setConnectionStatus('reconnecting', code);
      scheduleRetry(backoff(unavailableAttempts++));
    } else {
      setConnectionStatus(everConnected ? 'reconnecting' : 'connecting', code);
      // Transport errors are retried by socket.io itself while `active`.
      if (!socket.active) scheduleRetry(backoff(unavailableAttempts++));
    }
  });

  return {
    socket,
    connect() {
      wanted = true;
      authFailures = 0;
      unavailableAttempts = 0;
      setConnectionStatus('connecting');
      socket.connect();
    },
    disconnect() {
      wanted = false;
      clearRetry();
      clearProactive();
      socket.disconnect();
      setConnectionStatus('idle');
    },
    on: ((event: never, handler: never) => socket.on(event, handler)) as FeltSocket['on'],
    off: ((event: never, handler: never) => socket.off(event, handler)) as FeltSocket['off'],
    emitWithAck(event, payload, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 10_000;
      return new Promise<AckResult>((resolve) => {
        let done = false;
        const timer = timers.setTimeout(() => {
          if (done) return;
          done = true;
          resolve({ ok: false, error: { code: 'timeout' as never, message: 'Request timed out' } });
        }, timeoutMs);
        const ack = (res: Ack) => {
          if (done) return;
          done = true;
          timers.clearTimeout(timer);
          resolve(res);
        };
        const emit = socket.emit as unknown as (...args: unknown[]) => void;
        if (payload === undefined) emit.call(socket, event, ack);
        else emit.call(socket, event, payload, ack);
      });
    },
  };
}
