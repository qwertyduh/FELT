import { randomInt as nodeRandomInt } from 'node:crypto';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_PREFIX,
  ROOM_CODE_LENGTH,
  type RoomCode,
} from '@felt/protocol';
import { isProfane } from '../usernames/profanity';

/** `(maxExclusive) => integer in [0, max)`; injectable for tests. */
export type RandomInt = (maxExclusive: number) => number;
export const cryptoRandomInt: RandomInt = (max) => nodeRandomInt(max);

/** Extra 4-letter strings rejected on top of the profanity matcher. */
export const CODE_DENYLIST: ReadonlySet<string> = new Set([
  'NAZI',
  'RAPE',
  'CUNT',
  'FUCK',
  'SHIT',
  'DICK',
  'COCK',
  'TITS',
  'ANAL',
  'ANUS',
  'CLIT',
  'FAGS',
  'KIKE',
  'SPIC',
  'WOPS',
  'HOMO',
  'PISS',
  'WANK',
  'TWAT',
  'SLUT',
  'WHOR',
  'HELL',
  'KKK2',
  'JEW2',
  'DAMN',
  'PORN',
  'SEXY',
  'SEX2',
  'NIG3',
  'NGR2',
  'BUTT',
  'CRAP',
]);

export function isBlockedCode(letters: string): boolean {
  return CODE_DENYLIST.has(letters) || isProfane(letters);
}

/** One random `FELT-XXXX`, regenerated until it passes the denylist (bounded). */
export function generateRoomCode(randomInt: RandomInt = cryptoRandomInt): RoomCode {
  for (let attempt = 0; attempt < 100; attempt++) {
    let letters = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      letters += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }
    if (!isBlockedCode(letters)) return `${ROOM_CODE_PREFIX}${letters}` as RoomCode;
  }
  throw new Error('room code generation failed'); // unreachable with a sane RNG
}
