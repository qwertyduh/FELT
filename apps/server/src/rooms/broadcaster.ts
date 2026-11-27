/**
 * Sends `room:state` (P32), always built by `toPublicState`. `publish` is the room actors' commit
 * hook, so it runs once per committed change, synchronously and in version order; Socket.io keeps
 * that order per socket.
 *
 * One version, one content: `connected` flags are not stored in the room, so the payload built for
 * a version is kept and any resend of that version is exactly that payload.
 */
import { PublicRoomStateSchema, type PublicRoomState, type RoomCode } from '@felt/protocol';
import type { Realtime } from '../realtime';
import { memberChannel, roomChannel } from '../realtime/channels';
import type { FeltSocket } from '../realtime/handlers';
import { liveHandOf, toPublicState } from './publicState';
import type { RoomRecord } from './roomStore';

export interface BroadcasterOptions {
  log: { error(obj: Record<string, unknown>, msg: string): void };
}

interface Published {
  state: PublicRoomState;
  /** Admitted users who had a socket in the room when `state` was built. */
  online: ReadonlySet<string>;
}

export class StateBroadcaster {
  /** Last state sent per room with sockets in it. */
  private readonly last = new Map<RoomCode, Published>();

  constructor(
    private readonly io: Realtime['io'],
    private readonly opts: BroadcasterOptions,
  ) {}

  /** To every socket in the admitted `room:{code}` channel. */
  publish(room: Readonly<RoomRecord>): void {
    const channel = roomChannel(room.code);
    this.last.delete(room.code);
    const members = this.io.sockets.adapter.rooms.get(channel);
    if (!members) return;
    // Admission gates everything: anyone no longer admitted is removed before the state goes out.
    for (const id of [...members]) {
      const socket = this.io.sockets.sockets.get(id);
      if (!socket || room.admitted.includes(socket.data.user.userId)) continue;
      void socket.leave(channel);
      void socket.leave(memberChannel(room.code, socket.data.user.userId));
    }
    const online = this.online(room);
    const state = this.build(room, online);
    if (!state) return;
    this.last.set(room.code, { state, online });
    this.io.to(channel).emit('room:state', state);
  }

  /**
   * Resend the current version to one socket that has entered the room. Nothing is sent if that
   * version has not been published by this process (see `isStale`).
   */
  sendTo(socket: FeltSocket, room: Readonly<RoomRecord>): void {
    if (!socket.rooms.has(roomChannel(room.code))) return;
    const sent = this.last.get(room.code);
    if (sent?.state.version === room.version) socket.emit('room:state', sent.state);
  }

  /** True if a new version is needed to tell the room who is connected now. */
  isStale(room: Readonly<RoomRecord>): boolean {
    const sent = this.last.get(room.code);
    if (!sent || sent.state.version !== room.version) return true;
    const online = this.online(room);
    return online.size !== sent.online.size || [...online].some((id) => !sent.online.has(id));
  }

  /** Drop the kept state of a room nobody is in. */
  forget(code: RoomCode): void {
    this.last.delete(code);
  }

  private online(room: Readonly<RoomRecord>): Set<string> {
    const { rooms } = this.io.sockets.adapter;
    return new Set(room.admitted.filter((id) => rooms.has(memberChannel(room.code, id))));
  }

  /** Null (nothing is sent) if the result would not satisfy the strict public schema. */
  private build(room: Readonly<RoomRecord>, online: ReadonlySet<string>): PublicRoomState | null {
    try {
      const state = toPublicState(room, liveHandOf(room), (userId) => online.has(userId));
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
