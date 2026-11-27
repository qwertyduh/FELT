/**
 * A room lives for as long as somebody admitted is connected to it. Commits refresh its TTL, but a
 * quiet room (paused, a waiting lobby, players only reconnecting) commits nothing or only
 * `keepTtl` writes, so connected rooms are touched on entry and then periodically. A touch is an
 * EXPIRE, not a state change: it needs no place in the actor queue and cannot bring back a room
 * whose key is gone. Rooms with nobody in them are left to expire; so are ended ones, which would
 * otherwise go on counting against their host's room limit for as long as a tab stayed open.
 */
import type { RoomCode } from '@felt/protocol';
import type { Realtime } from '../realtime';
import { roomChannel } from '../realtime/channels';
import type { RoomRegistry } from './roomRegistry';
import type { RoomRecord, RoomStore } from './roomStore';

/** Far below ROOM_TTL_SECONDS: several failed sweeps in a row lose nothing. */
export const KEEP_ALIVE_MS = 5 * 60_000;

export interface KeepAliveDeps {
  io: Realtime['io'];
  registry: Pick<RoomRegistry, 'get'>;
  store: Pick<RoomStore, 'touch'>;
  log: { warn(obj: Record<string, unknown>, msg: string): void };
  intervalMs?: number;
}

/** Everyone whose open-rooms set may list this room: whoever created it is among them. */
const members = (room: Readonly<RoomRecord>): string[] => [
  ...new Set([room.hostId, ...room.admitted, ...room.ledger.map((e) => e.userId)]),
];

export class KeepAliveService {
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly deps: KeepAliveDeps) {
    this.timer = setInterval(() => void this.sweep(), deps.intervalMs ?? KEEP_ALIVE_MS);
    this.timer.unref();
  }

  /** Every room with a socket in its admitted channel. */
  async sweep(): Promise<void> {
    const codes = new Set<RoomCode>();
    for (const socket of this.deps.io.sockets.sockets.values()) {
      const code = socket.data.roomCode;
      if (code && socket.rooms.has(roomChannel(code))) codes.add(code);
    }
    await Promise.all([...codes].map((code) => this.refresh(code)));
  }

  /** Never rejects: a failure is retried by the next sweep. */
  async refresh(code: RoomCode): Promise<void> {
    try {
      const actor = await this.deps.registry.get(code);
      const room = actor?.state();
      if (!room || room.status === 'ended') return;
      await this.deps.store.touch(code, members(room));
    } catch (err) {
      this.deps.log.warn(
        { code, err: err instanceof Error ? err.name : 'unknown' },
        'room keep-alive failed',
      );
    }
  }

  close(): void {
    clearInterval(this.timer);
  }
}
