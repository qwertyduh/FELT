/**
 * Chat and reactions (P55, PRD 5.7): `chat:send` and `chat:react`, from seated players the host
 * has not muted. Each is checked and sent from inside the room's actor queue, so a mute or a
 * removal that came first always holds; neither changes the room.
 *
 * Recent messages are kept for reconnects in THIS PROCESS'S MEMORY only, never in the room record
 * (which is rewritten on every move): the last `CHAT_HISTORY_LIMIT` per room, gone with the game,
 * an idle room or a restart. Each is replayed only to users who were admitted when it was sent.
 *
 * Rate limits are per user across all rooms, sockets and devices, so reconnecting resets nothing.
 */
import { randomUUID } from 'node:crypto';
import {
  CHAT_HISTORY_LIMIT,
  type Ack,
  type ChatMessage,
  type ClientEventPayload,
  type RoomCode,
} from '@felt/protocol';
import type { Realtime, Timers } from '../realtime';
import { outOfRoom, roomChannel } from '../realtime/channels';
import {
  errorAck,
  onClientEvent,
  type FeltSocket,
  type SocketRegistrar,
} from '../realtime/handlers';
import { KeyedLimiter } from '../realtime/rateLimit';
import { cleanChatText } from './chatText';
import type { RoomRegistry } from './roomRegistry';
import { ROOM_TTL_SECONDS, RoomGoneError, type RoomRecord } from './roomStore';

export const CHAT_BURST = 5;
export const CHAT_PER_SEC = 1 / 2;
export const REACT_BURST = 4;
export const REACT_PER_SEC = 1 / 2;
/** Rooms whose history is held at once; the longest silent goes first. */
export const MAX_ROOMS_WITH_HISTORY = 500;

export interface ChatServiceDeps {
  io: Realtime['io'];
  registry: RoomRegistry;
  timers?: Pick<Timers, 'now'>;
  newId?: () => string;
}

interface History {
  /** A room code can be reused once its room is gone. */
  createdAt: number;
  /** Oldest first; `to` is who was admitted at the time. */
  lines: { message: ChatMessage; to: ReadonlySet<string> }[];
}

type Say = (room: Readonly<RoomRecord>, seat: RoomRecord['seats'][number]) => void;

export class ChatService {
  private readonly io: Realtime['io'];
  private readonly registry: RoomRegistry;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly messages: KeyedLimiter;
  private readonly reactions: KeyedLimiter;
  /** Insertion order is the order of last use. */
  private readonly history = new Map<RoomCode, History>();

  constructor(deps: ChatServiceDeps) {
    this.io = deps.io;
    this.registry = deps.registry;
    const { timers } = deps;
    this.now = timers ? () => timers.now() : () => Date.now();
    this.newId = deps.newId ?? randomUUID;
    this.messages = new KeyedLimiter(CHAT_PER_SEC, CHAT_BURST, this.now);
    this.reactions = new KeyedLimiter(REACT_PER_SEC, REACT_BURST, this.now);
  }

  readonly register: SocketRegistrar = (socket, log) => {
    onClientEvent(socket, 'chat:send', (p) => this.send(socket, p), log);
    onClientEvent(socket, 'chat:react', (p) => this.react(socket, p), log);
  };

  /** For a socket that has just entered the room (admission checked by the caller). */
  welcome(socket: FeltSocket, room: Readonly<RoomRecord>): void {
    const { userId } = socket.data.user;
    const messages = (this.of(room)?.lines ?? [])
      .filter((line) => line.to.has(userId))
      .map((line) => line.message);
    if (messages.length > 0) socket.emit('chat:history', { messages });
  }

  /** After every committed change: an ended game's chat is dropped. */
  committed(room: Readonly<RoomRecord>): void {
    if (room.status === 'ended') this.history.delete(room.code);
  }

  private send(socket: FeltSocket, { text }: ClientEventPayload<'chat:send'>): Promise<Ack> {
    const { userId } = socket.data.user;
    if (!socket.data.roomCode) return Promise.resolve(notEntered());
    // Before anything costly, and before the room's queue, which play shares.
    if (!this.messages.take(userId)) return Promise.resolve(tooFast());
    const clean = cleanChatText(text);
    if (!clean) return Promise.resolve(errorAck('invalid_payload', 'nothing to send'));
    return this.say(socket, (room, seat) => {
      const message: ChatMessage = {
        id: this.newId(),
        userId,
        username: seat.username,
        text: clean,
        at: this.now(),
      };
      this.keep(room, message);
      this.io.to(roomChannel(room.code)).emit('chat:message', message);
    });
  }

  private react(socket: FeltSocket, { emoji }: ClientEventPayload<'chat:react'>): Promise<Ack> {
    const { userId } = socket.data.user;
    if (!socket.data.roomCode) return Promise.resolve(notEntered());
    if (!this.reactions.take(userId)) return Promise.resolve(tooFast());
    return this.say(socket, (room) => {
      this.io.to(roomChannel(room.code)).emit('chat:reaction', { userId, emoji });
    });
  }

  private async say(socket: FeltSocket, emit: Say): Promise<Ack> {
    const { userId } = socket.data.user;
    const code = socket.data.roomCode!;
    try {
      const actor = await this.registry.get(code);
      if (!actor) return errorAck('not_found', 'room not found');
      return await actor.enqueue((room) => {
        const result = ((): Ack => {
          if (outOfRoom(socket, code) || !room.admitted.includes(userId)) return notEntered();
          if (room.status === 'ended') return errorAck('room_ended', 'room has ended');
          const seat = room.seats.find((s) => s.userId === userId && !s.leaving);
          if (!seat) return errorAck('not_seated', 'take a seat to chat');
          if (room.muted?.includes(userId)) return errorAck('muted', 'the host has muted you');
          emit(room, seat);
          return { ok: true };
        })();
        return { room: room as RoomRecord, result };
      });
    } catch (err) {
      if (err instanceof RoomGoneError) return errorAck('not_found', 'room not found');
      throw err; // -> `internal` ack
    }
  }

  private of(room: Readonly<RoomRecord>): History | null {
    const held = this.history.get(room.code);
    if (!held || held.createdAt !== room.createdAt) return null;
    const last = held.lines.at(-1);
    if (last && this.now() - last.message.at > ROOM_TTL_SECONDS * 1000) {
      this.history.delete(room.code);
      return null;
    }
    return held;
  }

  private keep(room: Readonly<RoomRecord>, message: ChatMessage): void {
    const held = this.of(room) ?? { createdAt: room.createdAt, lines: [] };
    held.lines.push({ message, to: new Set(room.admitted) });
    if (held.lines.length > CHAT_HISTORY_LIMIT) held.lines.shift();
    this.history.delete(room.code);
    this.history.set(room.code, held);
    if (this.history.size > MAX_ROOMS_WITH_HISTORY) {
      this.history.delete(this.history.keys().next().value!);
    }
  }
}

const notEntered = () => errorAck('not_admitted', 'enter the room first');
const tooFast = () => errorAck('rate_limited', 'slow down');
