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

/**
 * Extra 4-letter strings rejected on top of the profanity matcher. Only strings
 * emittable from ROOM_CODE_ALPHABET (no I/L/O/0/1) belong here; entries such as
 * NAZI, HELL, CLIT, WHOR can never be generated, so they are omitted.
 */
export const CODE_DENYLIST: ReadonlySet<string> = new Set([
  'RAPE',
  'CUNT',
  'CNTS',
  'FUCK',
  'FCUK',
  'FUC2',
  'FUKK',
  'FUKS',
  'SHTT',
  'SHT2',
  'PRCK',
  'ANUS',
  'ARSE',
  'FAGS',
  'FAGG',
  'KYKE',
  'WANK',
  'TWAT',
  'BTCH',
  'PUSS',
  'PUTA',
  'P33N',
  'KKK2',
  'KKKK',
  'JEW2',
  'JEWS',
  'NGR2',
  'NGGR',
  'NGER',
  'NGRS',
  'CHNK',
  'TARD',
  'RTRD',
  'TRAN',
  'JERK',
  'SCUM',
  'TURD',
  'DYKE',
  'SPAZ',
  'CUMS',
  'DAMN',
  'SEXY',
  'SEX2',
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
