/**
 * What somebody types or pastes to join: a room code in any case, with or without `FELT-`, with
 * stray spaces, or an invite link (also inside the message it was shared in). The protocol's schema
 * has the last word; whether the room exists is for the room page to find out.
 */
import { ROOM_CODE_PREFIX, RoomCodeSchema, type RoomCode } from '@felt/protocol';

export function parseRoomCode(input: string): RoomCode | null {
  // Only code characters, so a full stop or bracket after a shared link is left behind.
  const linked = /\/r\/([a-z0-9‐-―−-]*)/i.exec(input);
  const typed = (linked ? linked[1]! : input)
    .toUpperCase()
    // Phone keyboards turn a hyphen into a dash.
    .replace(/[\s‐-―−-]/g, '')
    // A code never holds an L, so this can only be the prefix.
    .replace(/^FELT/, '');
  const parsed = RoomCodeSchema.safeParse(`${ROOM_CODE_PREFIX}${typed}`);
  return parsed.success ? parsed.data : null;
}
