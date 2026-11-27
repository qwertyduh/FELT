/**
 * Seating (P31): `room:sit`, `room:sit_out`, `room:sit_in`, `room:leave`. They act on the room the
 * socket entered (`room:enter`); the rules, including the admission re-check, run inside that
 * room's actor queue, whose commit hook broadcasts the new state.
 */
import type { Ack, RoomCode } from '@felt/protocol';
import type { Db } from '../db/supabase';
import { findUsername } from '../usernames/claim';
import type { Timers } from '../realtime';
import { outOfRoom } from '../realtime/channels';
import {
  errorAck,
  onClientEvent,
  type FeltSocket,
  type SocketRegistrar,
} from '../realtime/handlers';
import { KeyedLimiter } from '../realtime/rateLimit';
import { KeyedSerial } from './keyedSerial';
import { RoomGoneError, type RoomRecord } from './roomStore';
import type { RoomRegistry } from './roomRegistry';
import { leave } from './game';
import { setSittingOut, sit, type SeatResult } from './seating';

/**
 * `room:sit` per user: each attempt costs a username lookup, and sit/leave cycling grows the
 * ledger.
 */
export const SIT_BURST = 10;
export const SIT_PER_SEC = 10 / 60;

export interface SeatServiceDeps {
  registry: RoomRegistry;
  /** null: no service key, so a seat cannot be labelled with a username. */
  db: Db | null;
  timers?: Pick<Timers, 'now'>;
}

type Rule = (room: Readonly<RoomRecord>) => SeatResult;

const notEntered = () => errorAck('not_admitted', 'enter the room first');
const notFound = () => errorAck('not_found', 'room not found');

export class SeatService {
  private readonly registry: RoomRegistry;
  private readonly db: Db | null;
  private readonly now: () => number;
  private readonly sitLimit: KeyedLimiter;
  /** One user's seat intents apply in arrival order (`sit` has a DB lookup, the rest do not). */
  private readonly serial = new KeyedSerial();

  constructor(deps: SeatServiceDeps) {
    this.registry = deps.registry;
    this.db = deps.db;
    const { timers } = deps;
    this.now = timers ? () => timers.now() : () => Date.now();
    this.sitLimit = new KeyedLimiter(SIT_PER_SEC, SIT_BURST, this.now);
  }

  readonly register: SocketRegistrar = (socket, log) => {
    onClientEvent(socket, 'room:sit', (p) => this.sit(socket, p.seat, p.buyIn), log);
    onClientEvent(
      socket,
      'room:sit_out',
      () => this.intent(socket, (room, userId) => setSittingOut(room, userId, true)),
      log,
    );
    onClientEvent(
      socket,
      'room:sit_in',
      () => this.intent(socket, (room, userId) => setSittingOut(room, userId, false)),
      log,
    );
    onClientEvent(
      socket,
      'room:leave',
      () => this.intent(socket, (room, userId) => leave(room, userId, this.now())),
      log,
    );
  };

  private sit(socket: FeltSocket, seat: number, buyIn: number): Promise<Ack> {
    const { userId } = socket.data.user;
    const code = socket.data.roomCode;
    if (!code) return Promise.resolve(notEntered());
    if (!this.sitLimit.take(userId)) {
      return Promise.resolve(errorAck('rate_limited', 'too many seat requests'));
    }
    return this.serial.run(userId, async () => {
      if (!this.db) return errorAck('internal', 'usernames unavailable');
      const username = await findUsername(this.db, userId); // I/O stays outside the room queue
      if (username === null) return errorAck('forbidden', 'username required');
      return this.apply(socket, code, (room) =>
        // Gone during the lookup: their departure has been handled already, so a seat taken now
        // would never be marked as away and never be released.
        socket.connected
          ? sit(room, { userId, username }, { seat, buyIn }, this.now())
          : {
              room: room as RoomRecord,
              refused: { code: 'not_admitted', message: 'disconnected' },
            },
      );
    });
  }

  private intent(
    socket: FeltSocket,
    rule: (room: Readonly<RoomRecord>, userId: string) => SeatResult,
  ): Promise<Ack> {
    const { userId } = socket.data.user;
    const code = socket.data.roomCode;
    if (!code) return Promise.resolve(notEntered());
    return this.serial.run(userId, () => this.apply(socket, code, (room) => rule(room, userId)));
  }

  /** The actor is fetched immediately before `enqueue`, so it cannot be evicted in between. */
  private async apply(socket: FeltSocket, code: RoomCode, rule: Rule): Promise<Ack> {
    try {
      const actor = await this.registry.get(code);
      if (!actor) return notFound();
      const refused = await actor.enqueue((room) => {
        if (outOfRoom(socket, code)) {
          return {
            room,
            result: { code: 'not_admitted' as const, message: 'enter the room first' },
          };
        }
        const r = rule(room);
        return { room: r.room, result: r.refused };
      });
      return refused ? errorAck(refused.code, refused.message) : { ok: true };
    } catch (err) {
      if (err instanceof RoomGoneError) return notFound();
      throw err; // -> `internal` ack
    }
  }
}
