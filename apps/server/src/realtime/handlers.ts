import {
  clientEventSchemas,
  parseClientEvent,
  type Ack,
  type ClientEventName,
  type ClientEventPayload,
  type ClientToServerEvents,
  type ErrorCode,
  type RoomCode,
  type ServerToClientEvents,
} from '@felt/protocol';
import type { Socket } from 'socket.io';
import { TokenBucket } from './rateLimit';

export interface SocketUser {
  userId: string;
  isAnonymous: boolean;
  /** Token expiry, epoch seconds. */
  exp: number;
}
export interface SocketData {
  user: SocketUser;
  /** The room this socket entered after admission (set only by `room:enter`). */
  roomCode?: RoomCode;
  /** The visit named by this socket's last successful `room:enter`. */
  session?: string | undefined;
  /** Sequence of `room:enter` intents, so a slow earlier one never overrides a later one. */
  enterSeq?: number;
}
export type FeltSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export interface HandlerContext {
  socket: FeltSocket;
  user: SocketUser;
}
/** Return an Ack to override the default `{ ok: true }`. Throwing yields an `internal` ack. */
export type ClientEventHandler<K extends ClientEventName> = (
  payload: ClientEventPayload<K>,
  ctx: HandlerContext,
) => Ack | void | Promise<Ack | void>;

export interface SocketLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

type RawSocket = { on(e: string, l: (...a: unknown[]) => void): void };

export const RATE_PER_SEC = 20;
export const RATE_BURST = 40;
/** Consecutive rate-limited events before the socket is dropped. */
export const ABUSE_DISCONNECT_AFTER = 100;

export function errorAck(code: ErrorCode, message: string): Ack {
  return { ok: false, error: { code, message } };
}

/** Bounded, Zod-free summary: field paths only (never values or Zod internals). */
function summarizeIssues(issues: readonly { path: PropertyKey[] }[]): string {
  const paths = issues
    .slice(0, 5)
    .map((i) => i.path.map(String).join('.').slice(0, 40) || '(root)');
  return `invalid payload: ${[...new Set(paths)].join(', ')}`.slice(0, 200);
}

function split(args: unknown[]): { payload: unknown; ack: ((a: Ack) => void) | undefined } {
  const last = args[args.length - 1];
  const ack = typeof last === 'function' ? (last as (a: Ack) => void) : undefined;
  // Events with no payload receive the ack as their first argument.
  const payload = typeof args[0] === 'function' ? undefined : args[0];
  return { payload, ack };
}

function safeAck(ack: ((a: Ack) => void) | undefined, res: Ack, socket: FeltSocket): void {
  try {
    if (ack) ack(res);
    else if (!res.ok) (socket as unknown as Socket).emit('error', res.error); // no ack: use the `error` event
  } catch {
    /* socket gone */
  }
}

/**
 * Per-socket guard installed once on connect via `socket.use`: runs for EVERY incoming packet
 * (including unknown event names) before any listener. Drops unknown events and rate-limited ones.
 */
export function installGuards(socket: FeltSocket, now: () => number, log: SocketLogger): void {
  const bucket = new TokenBucket(RATE_PER_SEC, RATE_BURST, now);
  let strikes = 0;
  socket.use((packet, next) => {
    const [event, ...rest] = packet as unknown[];
    const { ack } = split(rest);
    // Rate limit first so floods of unknown events are limited (and eventually disconnected) too.
    if (!bucket.take()) {
      strikes += 1;
      safeAck(ack, errorAck('rate_limited', 'too many events'), socket);
      if (strikes >= ABUSE_DISCONNECT_AFTER) {
        log.warn({ userId: socket.data.user.userId }, 'socket disconnected for sustained abuse');
        socket.disconnect(true);
      }
      return;
    }
    if (typeof event !== 'string' || !Object.hasOwn(clientEventSchemas, event)) {
      // No `next()`: the event is dropped; no listener ever sees it.
      safeAck(ack, errorAck('invalid_payload', 'unknown event'), socket);
      return;
    }
    // A real event nobody handles yet must still be answered. Reuses `internal` (no dedicated
    // not_implemented code in the protocol; documented decision).
    if ((socket as unknown as Socket).listeners(event).length === 0) {
      safeAck(ack, errorAck('internal', 'not implemented'), socket);
      return;
    }
    strikes = 0;
    next();
  });
}

/**
 * Registers a validated handler. Later phases (P29+) call this; never use `socket.on` directly.
 * Never logs the payload.
 */
export function onClientEvent<K extends ClientEventName>(
  socket: FeltSocket,
  name: K,
  handler: ClientEventHandler<K>,
  log?: SocketLogger,
): void {
  if (!Object.hasOwn(clientEventSchemas, name)) throw new Error('unknown client event');
  (socket as unknown as RawSocket).on(name, (...args: unknown[]) => {
    const { payload, ack } = split(args);
    const parsed = parseClientEvent(name, payload);
    if (!parsed.success) {
      safeAck(ack, errorAck('invalid_payload', summarizeIssues(parsed.error.issues)), socket);
      return;
    }
    void (async () => {
      try {
        const res = await handler(parsed.data, { socket, user: socket.data.user });
        safeAck(ack, res ?? { ok: true }, socket);
      } catch (err) {
        log?.warn(
          {
            event: name,
            userId: socket.data.user.userId,
            err: err instanceof Error ? err.name : 'unknown',
          },
          'handler failed',
        );
        safeAck(ack, errorAck('internal', 'internal error'), socket);
      }
    })();
  });
}

/** Hook for later phases: each registrar attaches its events to a freshly authenticated socket. */
export type SocketRegistrar = (socket: FeltSocket, log: SocketLogger) => void;
