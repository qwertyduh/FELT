/**
 * What a chat line becomes before anyone sees it (ARCHITECTURE security: text only, censored, not
 * blocked). Invisible and direction-changing characters go first, so they can neither reorder the
 * text around them nor split a word past the profanity filter.
 */
import { censor } from '../usernames/profanity';

/** Combining marks allowed on one character; more of them paint far outside their line. */
const MAX_MARKS = 3;
/** Line breaks, tabs and every other kind of space. */
const SPACES = /[\s\u0085]+/gu;
/**
 * Control characters, lone surrogates, and everything invisible (format and "default ignorable"
 * characters, bidi overrides and isolates among them, and the blank braille cell). Kept: the two variation selectors, and the
 * joiner inside an emoji sequence (checked apart).
 */
const INVISIBLE =
  /(?![\uFE0E\uFE0F\u200D])[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\u2800]/gu;
/** A zero-width joiner anywhere but between two emoji. */
const STRAY_JOINER =
  /(?<![\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F])\u200D|\u200D(?!\p{Extended_Pictographic})/gu;
const PILED_MARKS = new RegExp(`(\\p{M}{${MAX_MARKS}})\\p{M}+`, 'gu');

/** Empty when nothing visible was sent. Never longer than what came in. */
export function cleanChatText(text: string): string {
  const plain = text
    .replace(SPACES, ' ')
    .replace(INVISIBLE, '')
    .replace(STRAY_JOINER, '')
    .replace(PILED_MARKS, '$1')
    .replace(/ {2,}/g, ' ')
    .trim();
  // Selectors alone show nothing.
  if (!/[^\uFE0E\uFE0F ]/u.test(plain)) return '';
  return censor(plain);
}
