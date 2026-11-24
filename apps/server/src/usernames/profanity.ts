import {
  DataSet,
  type MatchPayload,
  englishDataset,
  englishRecommendedTransformers,
  pattern,
  RegExpMatcher,
  TextCensor,
} from 'obscenity';
import { normalizeUsername } from '@felt/protocol';

/**
 * Profanity filtering (ARCHITECTURE §6 step 4 for usernames, §11 for chat).
 * Everything is local: obscenity's bundled English dataset, no network.
 *
 * Whitelist / dataset adjustments: see the comments on the matcher below.
 */

// Dataset adjustments on top of obscenity's English dataset (all local). Whitelisting is
// substring based: a match lying entirely inside a whitelisted term is ignored.
//  - Whitelisted common words / names the stock dataset flags: cockpit, cocksure, cumin,
//    retardant, shiitake, rapeseed, mishit, penistone, peniston, dickson, dickinson, fagin,
//    butts, kuntz, fuchs, wang. (Hancock, Cockburn, dickens, shitake already pass.)
//  - Blacklisted `dumbass`, `jackass`, `smartass`, `fatass`: obscenity's `ass` patterns need
//    a word boundary, so these compounds slip through. Whole compounds, so `assassin`,
//    `bass`, `class` are unaffected.
//  - Blacklisted slur / abuse variants the stock set misses: `niqqer`, `nlgger` (l for i),
//    `nigguh`, `phuck`, `biatch`. (`niqqer` is written `niqer`: the recommended transformers
//    collapse repeated characters in the input before matching.)
//  - Whole-token terms `spic`, `coon`, `paki`, `kys` are NOT in the dataset: obscenity's
//    recommended transformers drop non-letters (so `|kys|` boundaries vanish at `_` or a
//    space). They are handled by WHOLE_TOKEN below instead: a term flags only when not
//    adjacent to a letter, with digits and `_` counting as separators, so `kys_now`,
//    `xx_kys_xx`, `kys99` flag while `raccoon`, `spicy`, `pakistan`, `skyscraper`, `kysa`
//    do not. `coonhound` and `paki_chef` do flag (coonhound documented, acceptable).
//
// Known, intentional over-blocking for usernames (not whitelisted): dick, dick_smith,
// dikshit, shitole, shitzu, Bitchfield, Shitterton, Twatt, Dicklebury, ass_ist, pen15.
const WHITELIST = [
  'cockpit',
  'cocksure',
  'cumin',
  'retardant',
  'shiitake',
  'rapeseed',
  'mishit',
  'penistone',
  'peniston',
  'dickson',
  'dickinson',
  'fagin',
  'butts',
  'kuntz',
  'fuchs',
  'wang',
];

const dataset = new DataSet()
  .addAll(englishDataset)
  .addPhrase((phrase) => {
    for (const term of WHITELIST) phrase.addWhitelistedTerm(term);
    return phrase.setMetadata({ originalWord: 'whitelist-only' });
  })
  .addPhrase((phrase) =>
    phrase
      .setMetadata({ originalWord: 'ass-compound' })
      .addPattern(pattern`dumbass`)
      .addPattern(pattern`jackass`)
      .addPattern(pattern`smartass`)
      .addPattern(pattern`fatass`),
  )
  .addPhrase((phrase) =>
    phrase
      .setMetadata({ originalWord: 'nigger-variant' })
      .addPattern(pattern`niqer`)
      .addPattern(pattern`nlgger`)
      .addPattern(pattern`nigguh`),
  )
  .addPhrase((phrase) =>
    phrase
      .setMetadata({ originalWord: 'fuck-bitch-variant' })
      .addPattern(pattern`phuck`)
      .addPattern(pattern`biatch`),
  );

// Matches whole tokens only: not preceded or followed by a letter. Digits and `_` separate.
const WHOLE_TOKEN = /(?<![a-z])(?:spic|coon|paki|kys)(?![a-z])/gi;

// Built once at module load; matcher construction compiles the whole dataset.
const matcher = new RegExpMatcher({
  ...dataset.build(),
  ...englishRecommendedTransformers,
});

// obscenity's built-in strategies size the mask by `matchLength`, which is measured after
// its repeated-character collapsing (`fuuuuck` -> 4), so the output would shrink. Size by
// the real matched span instead so the string length is preserved.
const censorer = new TextCensor().setStrategy(({ startIndex, endIndex }) =>
  '*'.repeat(endIndex - startIndex + 1),
);

// Separators people insert to dodge filters: underscores, whitespace, dots, dashes.
const SEPARATORS = /[_\s.-]+/g;
// Digits as separators (f1u2c3k). Applied together with SEPARATORS. Done as a separate
// variant because stripping digits would break leetspeak (sh1t) if it were the only check.
const SEPARATORS_AND_DIGITS = /[_\s.\d-]+/g;

function matches(text: string): MatchPayload[] {
  return matcher.getAllMatches(text, true);
}

function hasWholeToken(text: string): boolean {
  WHOLE_TOKEN.lastIndex = 0;
  return WHOLE_TOKEN.test(text);
}

/**
 * True when the text contains profanity. Normalises (NFKC + trim) internally, then checks
 * three variants: as-is, with separators removed, and with separators and digits removed.
 * obscenity itself handles leetspeak, repeated characters, case and confusables, and its
 * word-boundary logic avoids the Scunthorpe problem.
 */
export function isProfane(text: string): boolean {
  const normalized = normalizeUsername(text);
  if (normalized.length === 0) return false;
  if (matcher.hasMatch(normalized) || hasWholeToken(normalized)) return true;
  const noSeparators = normalized.replace(SEPARATORS, '');
  if (noSeparators !== normalized && matcher.hasMatch(noSeparators)) return true;
  const noDigits = normalized.replace(SEPARATORS_AND_DIGITS, '');
  return noDigits !== noSeparators && noDigits.length > 0 && matcher.hasMatch(noDigits);
}

/**
 * Replaces profanity with `*`, preserving every other character and the string length.
 * Intended for chat. Matches are found on the text as given (obscenity applies its own
 * transformers internally), so fullwidth and leet forms are censored in place. Known gap:
 * the separator-stripping variants used by `isProfane` are not applied here, so spaced or
 * underscore-separated words (`f u c k`) are not censored in chat.
 */
export function censor(text: string): string {
  if (text.length === 0) return text;
  const found = matches(text);
  const censored = found.length === 0 ? text : censorer.applyTo(text, found);
  return censored.replace(WHOLE_TOKEN, (m) => '*'.repeat(m.length));
}
