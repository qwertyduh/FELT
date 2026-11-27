/**
 * Host controls (P44): `host:pause`, `host:resume`, `host:end`, `host:settings`,
 * `host:blind_increase`, `host:kick`,
 * `host:transfer` and `host:seat_hold` (P45). The rules (hostControls.ts) run inside the room's actor queue. What sockets are
 * told, and which ones lose the room, follows from the committed change (`committed`).
 */
import { randomUUID } from 'node:crypto';
import type { Ack, RoomCode } from '@felt/protocol';
import type { Realtime, Timers } from '../realtime';
import { joinWaitChannel, memberChannel, outOfRoom, roomChannel } from '../realtime/channels';
import {
  errorAck,
  onClientEvent,
  type FeltSocket,
  type SocketRegistrar,
} from '../realtime/handlers';
import { hostInbox, hostMembers } from './admission';
import { tick, type GameContext } from './game';
import {
  changeBlindIncrease,
  changeBlinds,
  changeSeatHold,
  end,
  kick,
  pause,
  resume,
  transfer,
} from './hostControls';
import type { RoomRegistry } from './roomRegistry';
import { RoomGoneError, type RoomRecord } from './roomStore';
import type { SeatResult } from './seating';

export interface HostServiceDeps {
  io: Realtime['io'];
  registry: RoomRegistry;
  timers?: Pick<Timers, 'now'>;
  newId?: () => string;
}

type Rule = (room: Readonly<RoomRecord>, userId: string, ctx: GameContext) => SeatResult;

/**
 * `host:end` must not deal: a hand dealt only to be cancelled would still take up queued top-ups.
 * An award whose window is over is paid first, though.
 */
function dueAward(room: Readonly<RoomRecord>, ctx: GameContext): RoomRecord {
  const proposal = room.game?.hand?.proposal;
  return proposal && !proposal.disputed && proposal.confirmAt <= ctx.now
    ? tick(room, ctx)
    : (room as RoomRecord);
}

export class HostService {
  private readonly io: Realtime['io'];
  private readonly registry: RoomRegistry;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(deps: HostServiceDeps) {
    this.io = deps.io;
    this.registry = deps.registry;
    const { timers } = deps;
    this.now = timers ? () => timers.now() : () => Date.now();
    this.newId = deps.newId ?? randomUUID;
  }

  readonly register: SocketRegistrar = (socket, log) => {
    onClientEvent(
      socket,
      'host:pause',
      () => this.intent(socket, (room, userId, ctx) => pause(room, userId, ctx.now)),
      log,
    );
    onClientEvent(
      socket,
      'host:resume',
      () => this.intent(socket, (room, userId, ctx) => resume(room, userId, ctx.now)),
      log,
    );
    onClientEvent(
      socket,
      'host:end',
      () => this.intent(socket, (room, userId, ctx) => end(room, userId, ctx.now), dueAward),
      log,
    );
    onClientEvent(
      socket,
      'host:settings',
      (p) => this.intent(socket, (room, userId, ctx) => changeBlinds(room, userId, p, ctx.now)),
      log,
    );
    onClientEvent(
      socket,
      'host:blind_increase',
      (p) =>
        this.intent(socket, (room, userId, ctx) => changeBlindIncrease(room, userId, p, ctx.now)),
      log,
    );
    onClientEvent(
      socket,
      'host:seat_hold',
      (p) => this.intent(socket, (room, userId) => changeSeatHold(room, userId, p.minutes)),
      log,
    );
    onClientEvent(
      socket,
      'host:kick',
      (p) => this.intent(socket, (room, userId, ctx) => kick(room, userId, p.userId, ctx.now)),
      log,
    );
    onClientEvent(
      socket,
      'host:transfer',
      (p) =>
        this.intent(
          socket,
          (room, userId) => transfer(room, userId, p.userId, this.connected(room.code, p.userId)),
          tick,
          true,
        ),
      log,
    );
  };

  /**
   * After every committed change (the actor's `onCommit`), BEFORE the state broadcast: a removed
   * player's sockets must be out of the room's channels before anything else is sent.
   */
  committed(room: Readonly<RoomRecord>, before: Readonly<RoomRecord>): void {
    const { code } = room;
    for (const userId of before.admitted) {
      if (!room.admitted.includes(userId)) this.remove(code, userId);
    }
    if (room.status === 'ended' && before.status !== 'ended') {
      for (const { userId, kind } of before.requests) {
        if (kind !== 'join') continue;
        const waiting = joinWaitChannel(code, userId);
        this.io.to(waiting).emit('room:join_decision', { approved: false, ended: true });
        this.io.in(waiting).socketsLeave(waiting);
      }
      this.inbox(room, room.hostId);
    }
    if (room.hostId !== before.hostId) {
      this.io
        .to(memberChannel(code, before.hostId))
        .emit('host:inbox', { joinRequests: [], topUpRequests: [] });
      this.inbox(room, room.hostId);
      this.members(room);
    } else if (JSON.stringify(hostMembers(room)) !== JSON.stringify(hostMembers(before))) {
      this.members(room);
    }
    if (room.hostId !== before.hostId) {
      this.io.to(memberChannel(code, before.hostId)).emit('host:members', { members: [] });
    }
  }

  private members(room: Readonly<RoomRecord>): void {
    this.io
      .to(memberChannel(room.code, room.hostId))
      .emit('host:members', { members: hostMembers(room) });
  }

  private inbox(room: Readonly<RoomRecord>, userId: string): void {
    this.io.to(memberChannel(room.code, userId)).emit('host:inbox', hostInbox(room, this.now()));
  }

  /** Take every socket of a removed player out of the room, and tell them. */
  private remove(code: RoomCode, userId: string): void {
    const member = memberChannel(code, userId);
    for (const id of [...(this.io.sockets.adapter.rooms.get(member) ?? [])]) {
      const socket = this.io.sockets.sockets.get(id);
      if (!socket) continue;
      void socket.leave(roomChannel(code));
      void socket.leave(member);
      delete socket.data.roomCode;
      socket.emit('room:kicked', { code });
    }
  }

  private connected(code: RoomCode, userId: string): boolean {
    return this.io.sockets.adapter.rooms.has(memberChannel(code, userId));
  }

  private async intent(
    socket: FeltSocket,
    rule: Rule,
    /** What is overdue is settled first, so a control never beats a deadline that has passed. */
    settle: (room: Readonly<RoomRecord>, ctx: GameContext) => RoomRecord = tick,
    newHost = false,
  ): Promise<Ack> {
    const { userId } = socket.data.user;
    const code = socket.data.roomCode;
    if (!code) return errorAck('not_admitted', 'enter the room first');
    try {
      const actor = await this.registry.get(code);
      if (!actor) return errorAck('not_found', 'room not found');
      const refused = await actor.enqueue(
        (room) => {
          if (outOfRoom(socket, code)) {
            return {
              room,
              result: { code: 'not_admitted' as const, message: 'enter the room first' },
            };
          }
          const ctx = { now: this.now(), newId: this.newId };
          // Only for the host: nobody else may move the room on.
          const settled =
            room.hostId === userId && room.admitted.includes(userId)
              ? settle(room, ctx)
              : (room as RoomRecord);
          const r = rule(settled, userId, ctx);
          return { room: r.room, result: r.refused };
        },
        { newHost },
      );
      return refused ? errorAck(refused.code, refused.message) : { ok: true };
    } catch (err) {
      if (err instanceof RoomGoneError) return errorAck('not_found', 'room not found');
      throw err; // -> `internal` ack
    }
  }
}
