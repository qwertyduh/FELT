import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { AuthError, AuthUnavailableError, type AuthUser } from '../auth/verify';
import { installGuards, type FeltSocket, type SocketData, type SocketRegistrar } from './handlers';
import type { ClientToServerEvents, ServerToClientEvents } from '@felt/protocol';

export type SocketAuthCode = 'unauthorized' | 'token_expired' | 'auth_unavailable';

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface RealtimeDeps {
  verify: (token: string) => Promise<AuthUser>;
  /** Same allow-list as REST CORS. */
  origins: readonly string[];
  timers?: Timers;
  /** Later phases register their handlers here. */
  registrars?: SocketRegistrar[];
}

export interface Realtime {
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  /** Simple metric hook: currently connected (authenticated) sockets. */
  connectedCount(): number;
  /** Add a registrar (P29+); applies to sockets connecting afterwards. */
  register(r: SocketRegistrar): void;
}

declare module 'fastify' {
  interface FastifyInstance {
    realtime: Realtime;
  }
}

export const MAX_HTTP_BUFFER_SIZE = 64 * 1024;

/**
 * Attaches Socket.io at `/socket.io`.
 * - Token: `handshake.auth.token` ONLY. Never the query string (URLs get logged by proxies) and
 *   not headers (browsers can't set them on WebSocket anyway).
 * - Origin: a browser always sends Origin, so a present Origin must be allow-listed (this also
 *   blocks cross-site WebSocket hijacking). A missing Origin (non-browser clients, tests) is
 *   allowed through to the JWT check, which is the actual gate.
 * - Nothing here logs handshake URLs, query strings or tokens.
 */
export function attachRealtime(app: FastifyInstance, deps: RealtimeDeps): Realtime {
  const timers = deps.timers ?? realTimers;
  const allowed = new Set(deps.origins);
  const registrars = [...(deps.registrars ?? [])];
  let count = 0;

  const io: Realtime['io'] = new Server(app.server, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    serveClient: false,
    maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
    cors: { origin: [...allowed], credentials: false },
    allowRequest: (req: IncomingMessage, cb) => {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowed.has(origin)) return cb('origin not allowed', false);
      cb(null, true);
    },
  });

  io.use((socket, next) => {
    const fail = (code: SocketAuthCode): void => {
      const err = new Error(code) as Error & { data: { code: SocketAuthCode } };
      err.data = { code };
      next(err);
    };
    const auth: unknown = socket.handshake.auth;
    const token =
      typeof auth === 'object' && auth !== null ? (auth as { token?: unknown }).token : undefined;
    if (typeof token !== 'string' || token === '') return fail('unauthorized');
    deps
      .verify(token)
      .then((user) => {
        socket.data.user = { userId: user.userId, isAnonymous: user.isAnonymous, exp: user.exp };
        next();
      })
      .catch((err: unknown) => {
        if (err instanceof AuthUnavailableError) {
          app.log.warn({ error: err.reason }, 'socket auth unavailable');
          return fail('auth_unavailable');
        }
        const code = err instanceof AuthError ? err.code : 'invalid';
        app.log.info({ authCode: code }, 'socket auth failed');
        fail(code === 'expired' ? 'token_expired' : 'unauthorized');
      });
  });

  io.on('connection', (socket) => {
    const s = socket as FeltSocket;
    const { userId, exp } = s.data.user;
    count += 1;
    app.log.info({ userId }, 'socket connected');

    // Disconnect at token expiry. Token refresh needs a protocol event (decision pending):
    // until then the client reconnects with a fresh token.
    const delay = Math.min(Math.max(exp * 1000 - timers.now(), 0), 2 ** 31 - 1);
    const timer = timers.setTimeout(() => {
      app.log.info({ userId }, 'socket token expired; disconnecting');
      s.disconnect(true);
    }, delay);

    s.on('disconnect', (reason) => {
      timers.clearTimeout(timer);
      count -= 1;
      app.log.info({ userId, reason }, 'socket disconnected');
    });

    installGuards(s, timers.now, app.log);
    for (const r of registrars) r(s, app.log);
  });

  // `preClose` runs before Fastify's own server.close(), which would otherwise wait forever on open
  // websockets (onClose hooks run too late). Don't call io.close(): it would also close the HTTP server.
  // Disconnect every socket and shut the engine down so no upgraded connection holds the port.
  app.addHook('preClose', async () => {
    io.disconnectSockets(true);
    io.engine.close();
  });

  return {
    io,
    connectedCount: () => count,
    register: (r) => void registrars.push(r),
  };
}
