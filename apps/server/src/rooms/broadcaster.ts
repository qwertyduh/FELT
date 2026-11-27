/**
 * Sends `room:state` (P32), always built by `toPublicState`. `publish` is the room actors' commit
 * hook, so it runs once per committed change, synchronously and in version order; Socket.io keeps
 * that order per socket.
 */
import { PublicRoomStateSchema, type PublicRoomState } from '@felt/protocol';
import type { Realtime } from '../realtime';
import { memberChannel, roomChannel } from '../realtime/channels';
import type { FeltSocket } from '../realtime/handlers';
import { toPublicState, type LiveHand } from './publicState';
import type { RoomRecord } from './roomStore';

export interface BroadcasterOptions {
  log: { error(obj: Record<string, unknown>, msg: string): void };
  /** The room's running hand, if any. P33 supplies this. */
  handOf?: (room: Readonly<RoomRecord>) => LiveHand | null;
}

export class StateBroadcaster {
  constructor(
    private readonly io: Realtime['io'],
    private readonly opts: BroadcasterOptions,
  ) {}

  /** To every socket in the admitted `room:{code}` channel. */
  publish(room: Readonly<RoomRecord>): void {
    const channel = roomChannel(room.code);
    const members = this.io.sockets.adapter.rooms.get(channel);
    if (!members) return;
    // Admission gates everything: anyone no longer admitted is removed before the state goes out.
    for (const id of [...members]) {
      const socket = this.io.sockets.sockets.get(id);
      if (!socket || room.admitted.includes(socket.data.user.userId)) continue;
      void socket.leave(channel);
      void socket.leave(memberChannel(room.code, socket.data.user.userId));
    }
    const state = this.build(room);
    if (state) this.io.to(channel).emit('room:state', state);
  }

  /** The current state to one socket that has entered the room. */
  sendTo(socket: FeltSocket, room: Readonly<RoomRecord>): void {
    if (!socket.rooms.has(roomChannel(room.code))) return;
    const state = this.build(room);
    if (state) socket.emit('room:state', state);
  }

  /** Null (nothing is sent) if the result would not satisfy the strict public schema. */
  private build(room: Readonly<RoomRecord>): PublicRoomState | null {
    try {
      const state = toPublicState(room, this.opts.handOf?.(room) ?? null, (userId) =>
        this.io.sockets.adapter.rooms.has(memberChannel(room.code, userId)),
      );
      const parsed = PublicRoomStateSchema.safeParse(state);
      if (parsed.success) return parsed.data;
      // Field paths only: never log the state itself.
      const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.map(String).join('.'));
      this.opts.log.error({ code: room.code, paths }, 'invalid public room state');
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown';
      this.opts.log.error({ code: room.code, err: name }, 'public room state failed');
    }
    return null;
  }
}
