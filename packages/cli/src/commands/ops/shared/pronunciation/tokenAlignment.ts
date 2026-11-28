import { type InspectedPersonPronunciationToken, stripIpaDelimiters } from '@kinloom/core';

interface NonTokenPronunciationSpec {
  readonly phonetics: readonly string[];
  readonly ipas: readonly string[];
}

const LETTER_INITIAL_SPECS: Readonly<Record<string, NonTokenPronunciationSpec>> = {
  a: { phonetics: ['ay', 'ey'], ipas: ['eɪ', 'ei', 'e', 'a'] },
  b: { phonetics: ['bee'], ipas: ['bi', 'be'] },
  c: { phonetics: ['see'], ipas: ['si', 'se', 'tse'] },
  d: { phonetics: ['dee'], ipas: ['di', 'de'] },
  e: { phonetics: ['ee'], ipas: ['i', 'e'] },
  f: { phonetics: ['ef', 'eff'], ipas: ['ɛf', 'ef'] },
  g: { phonetics: ['jee'], ipas: ['dʒi', 'ɡe', 'ge', 'ɣe', 'xe'] },
  h: { phonetics: ['aych', 'aitch', 'haych'], ipas: ['eɪtʃ', 'heɪtʃ', 'ha', 'ɦa'] },
  i: { phonetics: ['eye', 'igh'], ipas: ['aɪ', 'ai', 'i'] },
  j: { phonetics: ['jay'], ipas: ['dʒeɪ', 'dʒei', 'je', 'jɔt'] },
  k: { phonetics: ['kay'], ipas: ['keɪ', 'kei', 'ka'] },
  l: { phonetics: ['el', 'ell'], ipas: ['ɛl', 'ɛɫ', 'el', 'eɫ'] },
  m: { phonetics: ['em'], ipas: ['ɛm', 'em'] },
  n: { phonetics: ['en'], ipas: ['ɛn', 'en'] },
  o: { phonetics: ['oh'], ipas: ['oʊ', 'əʊ', 'ou', 'o'] },
  p: { phonetics: ['pee'], ipas: ['pi', 'pe'] },
  q: { phonetics: ['kyoo', 'kyu', 'cue', 'kew'], ipas: ['kju', 'ky', 'ku'] },
  r: { phonetics: ['ar', 'ahr', 'are'], ipas: ['ɑr', 'ɑɹ', 'ɑ', 'ar', 'aɹ', 'ɛr', 'ɛʁ', 'ɛɾ'] },
  s: { phonetics: ['es', 'ess'], ipas: ['ɛs', 'es'] },
  t: { phonetics: ['tee'], ipas: ['ti', 'te'] },
  u: { phonetics: ['yoo', 'yu', 'you'], ipas: ['ju', 'y', 'u'] },
  v: { phonetics: ['vee'], ipas: ['vi', 've', 'faʊ'] },
  w: {
    phonetics: [
      'dub-uhl-yoo',
      'dub-ul-yoo',
      'dub-el-yoo',
      'dub-uh-yoo',
      'dub-yoo',
      'double-yoo',
      'double-u',
      'dub-uhl yoo',
      'double u',
    ],
    ipas: ['dʌbəlju', 'dʌblju', 'dʌbəɫju', 'dʌbɫju', 'dʌbju', 'dʌbəl ju', 've', 'ʋe'],
  },
  x: { phonetics: ['eks', 'ex'], ipas: ['ɛks', 'eks', 'ɪks'] },
  y: { phonetics: ['wy', 'wye', 'why'], ipas: ['waɪ', 'wai', 'ɛi', 'y'] },
  z: { phonetics: ['zee', 'zed'], ipas: ['zi', 'zɛd', 'zed', 'tsɛt'] },
};

const DECORATION_SPECS: Readonly<Record<string, NonTokenPronunciationSpec>> = {
  jr: {
    phonetics: ['jr', 'joon-yer', 'joon-yur', 'junior'],
    ipas: ['dʒunjər', 'dʒunjə', 'dʒunjɚ', 'dʒuniər', 'dʒuniɚ'],
  },
  sr: {
    phonetics: ['sr', 'seen-yer', 'seen-yur', 'senior'],
    ipas: ['sinjər', 'sinjə', 'sinjɚ', 'siniər', 'siniɚ'],
  },
  ii: {
    phonetics: ['ii', 'the sek-uhnd', 'sek-uhnd', 'second'],
    ipas: ['ðə sɛkənd', 'sɛkənd'],
  },
  iii: {
    phonetics: ['iii', 'the therd', 'therd', 'third'],
    ipas: ['ðə θɜrd', 'ðə θɜd', 'ðə θɝd', 'θɜrd', 'θɜd', 'θɝd'],
  },
  iv: {
    phonetics: ['iv', 'the forth', 'forth', 'fourth'],
    ipas: ['ðə fɔrθ', 'ðə fɔθ', 'fɔrθ', 'fɔθ'],
  },
  v: {
    phonetics: ['v', 'the fifth', 'fifth'],
    ipas: ['ðə fɪfθ', 'fɪfθ'],
  },
  vi: {
    phonetics: ['vi', 'the siksth', 'sixth'],
    ipas: ['ðə sɪksθ', 'sɪksθ'],
  },
};

export type AlignmentMode = 'phonetic' | 'ipa';

export function normalizeWhitespace(value?: string | null): string {
  return (value ?? '').trim().replaceAll(/\s+/g, ' ');
}

export function normalizeIpaComparable(value?: string | null): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return '';
  }
  return normalizeWhitespace(stripIpaDelimiters(trimmed));
}

function trimCharsOrSpace(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (chars.includes(value.charAt(start)) || /\s/.test(value.charAt(start)))) {
    start += 1;
  }
  while (end > start && (chars.includes(value.charAt(end - 1)) || /\s/.test(value.charAt(end - 1)))) {
    end -= 1;
  }
  return value.slice(start, end);
}

export function cleanExtractedPhonetic(raw: string): string | null {
  const cleaned = trimCharsOrSpace(
    normalizeWhitespace(raw).replaceAll(/\s*-\s*/g, '-'),
    '.,;:!?()[]"“”-'
  ).trim();
  return cleaned || null;
}

export function cleanExtractedIpa(raw: string): string | null {
  const cleaned = trimCharsOrSpace(normalizeIpaComparable(raw), ',;:/[]-').trim();
  return cleaned || null;
}

export function normalizePhoneticComparable(value?: string | null): string {
  const cleaned = cleanExtractedPhonetic(value ?? '');
  return cleaned ? cleaned.toLowerCase() : '';
}

export function normalizeIpaForConflictCheck(value?: string | null): string {
  const cleaned = cleanExtractedIpa(value ?? '');
  if (!cleaned) {
    return '';
  }
  return normalizeWhitespace(
    cleaned
      .replaceAll(/(?:[ˈˌ.,;:[\]/]|\u0361|\u035c|\u0329)/g, '')
      .replaceAll(/\s*-\s*/g, '-')
      .toLowerCase()
  );
}

function normalizePhoneticNonTokenCandidate(segment: string): string {
  return normalizeWhitespace(segment)
    .replaceAll(/\s*-\s*/g, '-')
    .replace(/^[.,;:!?()[\]"'“”‘’\s]+|[.,;:!?()[\]"'“”‘’\s]+$/g, '')
    .toLowerCase();
}

function normalizeIpaNonTokenCandidate(segment: string): string {
  return normalizeWhitespace(stripIpaDelimiters(segment))
    .replaceAll(/(?:[ˈˌːˑ.,;:/[\]()]|\u0361|\u035c|\u0329)/g, '')
    .toLowerCase();
}

function normalizeNonTokenKey(text: string): string {
  return text.trim().replace(/\.+$/, '').toLowerCase();
}

function matchesNonTokenSegment(
  tok: InspectedPersonPronunciationToken,
  candidate: string,
  mode: AlignmentMode
): boolean {
  const key = normalizeNonTokenKey(tok.text);
  if (!key) {
    return false;
  }
  const normalized =
    mode === 'phonetic'
      ? normalizePhoneticNonTokenCandidate(candidate)
      : normalizeIpaNonTokenCandidate(candidate);
  if (!normalized) {
    return false;
  }
  if (normalized === key) {
    return true;
  }
  const spec = tok.kind === 'initial' ? LETTER_INITIAL_SPECS[key] : DECORATION_SPECS[key];
  if (!spec) {
    return false;
  }
  const accepted = mode === 'phonetic' ? spec.phonetics : spec.ipas;
  return accepted.includes(normalized);
}

function stripDelimitedKnownPieceFromStart(
  remaining: string,
  expected: string,
  mode: AlignmentMode,
  allowHyphen: boolean,
  exactCasePhonetic: boolean,
  allowFullConsume: boolean
): string | null {
  const normExpected = mode === 'phonetic' ? normalizeWhitespace(expected) : normalizeIpaComparable(expected);
  if (!normExpected) {
    return null;
  }

  const remainingComp = exactCasePhonetic && mode === 'phonetic' ? remaining : remaining.toLowerCase();
  const expectedComp = exactCasePhonetic && mode === 'phonetic' ? normExpected : normExpected.toLowerCase();

  if (allowFullConsume && remainingComp === expectedComp) {
    return '';
  }

  if (remainingComp.startsWith(`${expectedComp} `)) {
    return remaining.slice(normExpected.length + 1).trim();
  }
  if (mode === 'phonetic') {
    const afterPrefix = remaining.slice(normExpected.length);
    if (remainingComp.startsWith(expectedComp) && /^[,;:]+\s+/.test(afterPrefix)) {
      return afterPrefix.replace(/^[,;:]+\s+/, '').trim();
    }
    if (allowFullConsume && remainingComp.startsWith(expectedComp) && /^[,;:.]+$/.test(afterPrefix)) {
      return '';
    }
  }
  if (allowHyphen && remainingComp.startsWith(`${expectedComp}-`)) {
    return remaining.slice(normExpected.length + 1).trim();
  }

  if (mode === 'ipa') {
    const expectedWords = normExpected.split(' ');
    const remainingWords = remaining.split(' ');
    const expectedRelaxed = normalizeIpaForConflictCheck(normExpected);

    if (allowFullConsume && remainingWords.length === expectedWords.length) {
      if (normalizeIpaForConflictCheck(remaining) === expectedRelaxed) {
        return '';
      }
    }

    if (remainingWords.length > expectedWords.length) {
      const head = remainingWords.slice(0, expectedWords.length).join(' ');
      if (normalizeIpaForConflictCheck(head) === expectedRelaxed) {
        return remainingWords.slice(expectedWords.length).join(' ').trim();
      }
    }

    if (allowHyphen && expectedWords.length === 1) {
      const firstWord = remainingWords[0] ?? '';
      const hyphenIdx = firstWord.indexOf('-');
      if (hyphenIdx > 0) {
        const leftPart = firstWord.slice(0, hyphenIdx);
        if (normalizeIpaForConflictCheck(leftPart) === expectedRelaxed) {
          const restFirst = firstWord.slice(hyphenIdx + 1);
          const rest = [restFirst, ...remainingWords.slice(1)].filter(Boolean).join(' ');
          return rest || null;
        }
      }
    }
  }

  return null;
}

function stripDelimitedKnownPieceFromEnd(
  remaining: string,
  expected: string,
  mode: AlignmentMode,
  allowHyphen: boolean
): string | null {
  const normExpected = mode === 'phonetic' ? normalizeWhitespace(expected) : normalizeIpaComparable(expected);
  if (!normExpected) {
    return null;
  }

  const remainingLower = remaining.toLowerCase();
  const expectedLower = normExpected.toLowerCase();

  if (remainingLower.endsWith(` ${expectedLower}`)) {
    return remaining.slice(0, remaining.length - normExpected.length - 1).trim();
  }
  if (mode === 'phonetic') {
    const trimmedTrailingPunct = remaining.replace(/[,;:.]+$/, '');
    if (
      trimmedTrailingPunct.length < remaining.length &&
      trimmedTrailingPunct.toLowerCase().endsWith(` ${expectedLower}`)
    ) {
      return trimmedTrailingPunct.slice(0, trimmedTrailingPunct.length - normExpected.length - 1).trim();
    }
  }
  if (allowHyphen && remainingLower.endsWith(`-${expectedLower}`)) {
    return remaining.slice(0, remaining.length - normExpected.length - 1).trim();
  }

  if (mode === 'ipa') {
    const expectedWords = normExpected.split(' ');
    const remainingWords = remaining.split(' ');
    const expectedRelaxed = normalizeIpaForConflictCheck(normExpected);

    if (remainingWords.length > expectedWords.length) {
      const tail = remainingWords.slice(remainingWords.length - expectedWords.length).join(' ');
      if (normalizeIpaForConflictCheck(tail) === expectedRelaxed) {
        return remainingWords
          .slice(0, remainingWords.length - expectedWords.length)
          .join(' ')
          .trim();
      }
    }

    if (allowHyphen && expectedWords.length === 1) {
      const lastWord = remainingWords[remainingWords.length - 1] ?? '';
      const hyphenIdx = lastWord.lastIndexOf('-');
      if (hyphenIdx > 0 && hyphenIdx < lastWord.length - 1) {
        const rightPart = lastWord.slice(hyphenIdx + 1);
        if (normalizeIpaForConflictCheck(rightPart) === expectedRelaxed) {
          const restLast = lastWord.slice(0, hyphenIdx);
          const rest = [...remainingWords.slice(0, -1), restLast].filter(Boolean).join(' ');
          return rest || null;
        }
      }
    }
  }

  return null;
}

function tryStripOptionalNonTokenFromStart(
  remaining: string,
  tok: InspectedPersonPronunciationToken,
  mode: AlignmentMode,
  allowFullConsume: boolean
): { readonly matched: boolean; readonly next: string } {
  if (!remaining) {
    return { matched: false, next: remaining };
  }
  const words = remaining.split(' ');
  const maxWords = Math.min(2, words.length);
  for (let span = maxWords; span >= 1; span -= 1) {
    if (!allowFullConsume && words.length <= span) {
      continue;
    }
    const phrase = words.slice(0, span).join(' ');
    if (matchesNonTokenSegment(tok, phrase, mode)) {
      return { matched: true, next: words.slice(span).join(' ').trim() };
    }
  }
  return { matched: false, next: remaining };
}

function tryStripOptionalNonTokenFromEnd(
  remaining: string,
  tok: InspectedPersonPronunciationToken,
  mode: AlignmentMode
): { readonly matched: boolean; readonly next: string } {
  if (!remaining) {
    return { matched: false, next: remaining };
  }
  const words = remaining.split(' ');
  const maxWords = Math.min(2, words.length - 1);
  for (let span = maxWords; span >= 1; span -= 1) {
    const phrase = words.slice(words.length - span).join(' ');
    if (matchesNonTokenSegment(tok, phrase, mode)) {
      return {
        matched: true,
        next: words
          .slice(0, words.length - span)
          .join(' ')
          .trim(),
      };
    }
  }
  return { matched: false, next: remaining };
}

export function extractAlignedTokenSegment(args: {
  readonly fullValue: string;
  readonly beforeTokens: readonly InspectedPersonPronunciationToken[];
  readonly missingToken: InspectedPersonPronunciationToken;
  readonly afterTokens: readonly InspectedPersonPronunciationToken[];
  readonly mode: AlignmentMode;
}): string | null {
  const { beforeTokens, missingToken, afterTokens, mode } = args;
  let remaining =
    mode === 'phonetic' ? normalizeWhitespace(args.fullValue) : normalizeIpaComparable(args.fullValue);
  if (!remaining) {
    return null;
  }

  let unmatchedAdjacentInitial = false;

  for (let i = 0; i < beforeTokens.length; i += 1) {
    const tok = beforeTokens[i];
    if (tok === undefined) continue;
    const nextTok = i + 1 < beforeTokens.length ? beforeTokens[i + 1] : missingToken;
    if (tok.kind === 'token') {
      const piece =
        mode === 'phonetic'
          ? normalizeWhitespace(tok.entry?.phonetic)
          : normalizeIpaComparable(tok.entry?.ipa);
      if (!piece) {
        return null;
      }
      const next = stripDelimitedKnownPieceFromStart(
        remaining,
        piece,
        mode,
        Boolean(nextTok?.joinWithHyphen),
        false,
        false
      );
      if (next === null || !next) {
        return null;
      }
      remaining = next;
    } else {
      const attempt = tryStripOptionalNonTokenFromStart(remaining, tok, mode, false);
      remaining = attempt.next;
      if (tok.kind === 'initial' && !attempt.matched) {
        unmatchedAdjacentInitial = true;
      }
    }
  }

  for (let i = afterTokens.length - 1; i >= 0; i -= 1) {
    const tok = afterTokens[i];
    if (tok === undefined) continue;
    if (tok.kind === 'token') {
      const piece =
        mode === 'phonetic'
          ? normalizeWhitespace(tok.entry?.phonetic)
          : normalizeIpaComparable(tok.entry?.ipa);
      if (!piece) {
        return null;
      }
      const next = stripDelimitedKnownPieceFromEnd(remaining, piece, mode, Boolean(tok.joinWithHyphen));
      if (next === null || !next) {
        return null;
      }
      remaining = next;
    } else {
      const attempt = tryStripOptionalNonTokenFromEnd(remaining, tok, mode);
      remaining = attempt.next;
      if (tok.kind === 'initial' && !attempt.matched) {
        unmatchedAdjacentInitial = true;
      }
    }
  }

  const cleaned = mode === 'phonetic' ? cleanExtractedPhonetic(remaining) : cleanExtractedIpa(remaining);
  if (!cleaned) {
    return null;
  }

  // Refuse to absorb an unrecognized middle-initial or expanded middle-name word into a shorter token.
  if (unmatchedAdjacentInitial) {
    const missingWordCount = normalizeWhitespace(missingToken.text).split(' ').filter(Boolean).length;
    const extractedWordCount = cleaned.split(' ').filter(Boolean).length;
    if (extractedWordCount > missingWordCount) {
      return null;
    }
  }

  return mode === 'ipa' ? `/${cleaned}/` : cleaned;
}

export function matchesComposedTokenSequence(args: {
  readonly value: string;
  readonly tokens: readonly InspectedPersonPronunciationToken[];
  readonly mode: AlignmentMode;
}): boolean {
  const { tokens, mode } = args;
  let remaining = mode === 'phonetic' ? normalizeWhitespace(args.value) : normalizeIpaComparable(args.value);
  if (!remaining || tokens.length === 0) {
    return false;
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === undefined) continue;
    const hasFollowingRequiredToken = tokens.slice(i + 1).some((t) => t.kind === 'token');
    const nextTok = tokens[i + 1];

    if (tok.kind === 'token') {
      const piece =
        mode === 'phonetic'
          ? normalizeWhitespace(tok.entry?.phonetic)
          : normalizeIpaComparable(tok.entry?.ipa);
      if (!piece) {
        return false;
      }
      const next = stripDelimitedKnownPieceFromStart(
        remaining,
        piece,
        mode,
        Boolean(nextTok?.joinWithHyphen),
        true,
        !hasFollowingRequiredToken
      );
      if (next === null) {
        return false;
      }
      remaining = next;
    } else {
      const attempt = tryStripOptionalNonTokenFromStart(remaining, tok, mode, !hasFollowingRequiredToken);
      remaining = attempt.next;
    }
  }

  return remaining === '';
}
