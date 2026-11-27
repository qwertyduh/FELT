import type { RoomCode } from '@felt/protocol';

/*
 * Socket.io room names. `room` and `member` are joined ONLY by `room:enter` after the admission
 * check; every room broadcast must target one of them. `joinWait` carries nothing but the
 * requester's own `room:join_*` events.
 */

/** Every admitted socket viewing the room (`room:state`, chat, results...). */
export const roomChannel = (code: RoomCode): string => `room:${code}`;
/** One admitted user's sockets in the room (host-only events, private cards, kick). */
export const memberChannel = (code: RoomCode, userId: string): string => `member:${code}:${userId}`;
/** A not-yet-admitted requester waiting for the decision. */
export const joinWaitChannel = (code: RoomCode, userId: string): string => `join:${code}:${userId}`;
