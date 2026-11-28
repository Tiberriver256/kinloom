import {
  composeLanguageTag,
  composeProvenance,
  findSurnameTokenSpan,
  getLexiconLowerIndexMeta,
  hasPronunciationEntryContent,
  isSingleLetterInitial,
  lookupCompatiblePersonLexiconEntry,
  lookupCompatiblePersonLexiconMatch,
  lookupLexiconEntry,
  mergePronunciationEntry,
  PERSON_NAME_DECORATION_RE,
  stripIpaDelimiters,
  tokenizePersonName,
} from './pronunciationPhonetics.js';
import { resolvePlacePronunciation } from './pronunciationPlaceResolve.js';
import type {
  InspectedPersonPronunciationToken,
  PersonPronunciationInspection,
  PersonPronunciationTokenRole,
  Pronunciation,
  ResolvedPersonPronunciation,
} from './pronunciationSchema.js';

export { resolvePlacePronunciation };

interface ComposedTokenPart {
  readonly kind: 'resolved' | 'initial' | 'decoration';
  readonly token: string;
  readonly entry?: Pronunciation | undefined;
  readonly joinWithHyphen?: boolean | undefined;
}

function resolveCompositionalPersonPronunciation(
  tokens: readonly string[],
  lexicon: Readonly<Record<string, Pronunciation>>,
  fullNameLower: string
): { readonly resolved: ResolvedPersonPronunciation | null; readonly missingParts: readonly string[] } {
  if (tokens.length === 0) {
    return { resolved: null, missingParts: [] };
  }

  const { maxWordSpan } = getLexiconLowerIndexMeta(lexicon);
  const parts: ComposedTokenPart[] = [];
  const resolvedEntries: Pronunciation[] = [];
  const missingParts: string[] = [];

  let idx = 0;
  while (idx < tokens.length) {
    // Greedy longest-phrase match (bounded by lexicon maxWordSpan, up to 4 tokens).
    const maxSpan = Math.min(maxWordSpan, tokens.length - idx);
    let matchedSpan = 0;
    let matchedEntry: Pronunciation | undefined;
    let matchedText = '';

    for (let span = maxSpan; span >= 1; span -= 1) {
      const phrase = span === 1 ? (tokens[idx] ?? '') : tokens.slice(idx, idx + span).join(' ');
      const candidate = lookupCompatiblePersonLexiconEntry(lexicon, phrase, fullNameLower);
      if (candidate) {
        matchedSpan = span;
        matchedEntry = candidate;
        matchedText = phrase;
        break;
      }
    }

    if (matchedSpan > 0 && matchedEntry) {
      parts.push({ kind: 'resolved', token: matchedText, entry: matchedEntry });
      resolvedEntries.push(matchedEntry);
      idx += matchedSpan;
      continue;
    }

    const token = tokens[idx];
    if (token === undefined) {
      idx += 1;
      continue;
    }

    if (token.includes('-')) {
      const subTokens = token
        .split('-')
        .map((s) => s.trim())
        .filter(Boolean);
      if (subTokens.length > 1) {
        const subEntries: Pronunciation[] = [];
        let allSubMatched = true;
        for (const sub of subTokens) {
          const subEntry = lookupCompatiblePersonLexiconEntry(lexicon, sub, fullNameLower);
          if (!subEntry) {
            allSubMatched = false;
            missingParts.push(sub);
          } else {
            subEntries.push(subEntry);
          }
        }
        if (allSubMatched) {
          subTokens.forEach((subTok, s) => {
            const subEntry = subEntries[s];
            if (!subEntry) {
              return;
            }
            parts.push({
              kind: 'resolved',
              token: subTok,
              entry: subEntry,
              joinWithHyphen: s > 0,
            });
            resolvedEntries.push(subEntry);
          });
        }
        idx += 1;
        continue;
      }
    }

    if (tokens.length > 1 && isSingleLetterInitial(token)) {
      parts.push({ kind: 'initial', token });
      idx += 1;
      continue;
    }

    if (tokens.length > 1 && PERSON_NAME_DECORATION_RE.test(token)) {
      parts.push({ kind: 'decoration', token });
      idx += 1;
      continue;
    }

    missingParts.push(token);
    idx += 1;
  }

  if (missingParts.length > 0 || resolvedEntries.length === 0) {
    return { resolved: null, missingParts };
  }

  let allHavePhonetic = true;
  let allHaveIpa = true;
  let allHaveAudio = true;
  for (const e of resolvedEntries) {
    if (!e.phonetic?.trim()) {
      allHavePhonetic = false;
    }
    if (!e.ipa?.trim()) {
      allHaveIpa = false;
    }
    if (!e.audio_url?.trim()) {
      allHaveAudio = false;
    }
  }

  let phonetic: string | undefined;
  if (allHavePhonetic) {
    let out = '';
    for (const part of parts) {
      const piece = part.kind === 'resolved' ? (part.entry?.phonetic?.trim() ?? '') : part.token;
      if (!piece) {
        continue;
      }
      out = !out ? piece : part.joinWithHyphen ? `${out}-${piece}` : `${out} ${piece}`;
    }
    phonetic = out || undefined;
  }

  let ipa: string | undefined;
  if (allHaveIpa) {
    let out = '';
    for (const part of parts) {
      if (part.kind !== 'resolved' || !part.entry?.ipa?.trim()) {
        continue;
      }
      const piece = stripIpaDelimiters(part.entry.ipa);
      if (!piece) {
        continue;
      }
      out = !out ? piece : part.joinWithHyphen ? `${out}-${piece}` : `${out} ${piece}`;
    }
    ipa = out ? `/${out}/` : undefined;
  }

  if (!phonetic && !ipa) {
    return { resolved: null, missingParts: [] };
  }

  const language = composeLanguageTag(resolvedEntries);
  const provenance = composeProvenance(resolvedEntries);
  const tokenAudioUrls = allHaveAudio
    ? resolvedEntries.map((entry) => entry.audio_url?.trim() ?? '')
    : undefined;

  const resolved: ResolvedPersonPronunciation = {
    ...(phonetic ? { phonetic } : {}),
    ...(ipa ? { ipa } : {}),
    ...(language ? { language } : {}),
    ...provenance,
    ...(tokenAudioUrls ? { token_audio_urls: tokenAudioUrls } : {}),
    coverage: 'full',
    resolvedFrom: 'composed',
  };

  return {
    resolved,
    missingParts: [],
  };
}

/**
 * Inspect every name token (`given`, `middle`, `surname`, plus initials/suffixes) for a person
 * against the shared lexicon using the exact same tokenization and longest-phrase lookup rules
 * as `resolvePersonPronunciation`.
 */
export function inspectPersonPronunciationTokens(
  person: {
    readonly full_name?: string | undefined;
    readonly given_name?: string | undefined;
    readonly surname?: string | undefined;
    readonly is_living?: boolean | undefined;
  },
  lexicon?: Readonly<Record<string, Pronunciation>> | null
): PersonPronunciationInspection {
  if (person.is_living || person.full_name?.trim() === 'Living') {
    return {
      tokens: [],
      composed: null,
      missingParts: [],
      allTokensResolved: false,
      hasAnySharedToken: false,
    };
  }

  const rawTokens = tokenizePersonName(person);
  if (rawTokens.length === 0) {
    return {
      tokens: [],
      composed: null,
      missingParts: [],
      allTokensResolved: false,
      hasAnySharedToken: false,
    };
  }

  const effectiveLexicon: Readonly<Record<string, Pronunciation>> = lexicon ?? {};
  const { maxWordSpan } = getLexiconLowerIndexMeta(effectiveLexicon);
  const fullNameTrimmed =
    person.full_name?.trim() || [person.given_name?.trim(), person.surname?.trim()].filter(Boolean).join(' ');
  const fullNameLower = fullNameTrimmed.toLowerCase();
  const surnameSpan = findSurnameTokenSpan(rawTokens, person.surname);

  const roleForSpan = (
    startIdx: number,
    endIdx: number,
    isDecoration: boolean,
    seenGiven: boolean
  ): PersonPronunciationTokenRole => {
    if (isDecoration) {
      return 'suffix';
    }
    if (surnameSpan && startIdx < surnameSpan.end && endIdx > surnameSpan.start) {
      return 'surname';
    }
    return seenGiven ? 'middle' : 'given';
  };

  const inspected: InspectedPersonPronunciationToken[] = [];
  let seenGiven = false;
  let idx = 0;

  while (idx < rawTokens.length) {
    const maxSpan = Math.min(maxWordSpan, rawTokens.length - idx);
    let matchedSpan = 0;
    let matchedLex: { readonly key: string; readonly entry: Pronunciation } | undefined;
    let matchedText = '';

    for (let span = maxSpan; span >= 1; span -= 1) {
      const phrase = span === 1 ? (rawTokens[idx] ?? '') : rawTokens.slice(idx, idx + span).join(' ');
      const candidate = lookupCompatiblePersonLexiconMatch(effectiveLexicon, phrase, fullNameLower);
      if (candidate) {
        matchedSpan = span;
        matchedLex = candidate;
        matchedText = phrase;
        break;
      }
    }

    if (matchedSpan > 0 && matchedLex) {
      const role = roleForSpan(idx, idx + matchedSpan, false, seenGiven);
      if (role === 'given') {
        seenGiven = true;
      }
      inspected.push({
        kind: 'token',
        role,
        text: matchedText,
        lexiconKey: matchedLex.key,
        entry: matchedLex.entry,
      });
      idx += matchedSpan;
      continue;
    }

    // Group an entirely unmatched multi-word surname into one editable chip.
    if (
      surnameSpan &&
      idx === surnameSpan.start &&
      surnameSpan.end - surnameSpan.start > 1 &&
      rawTokens
        .slice(surnameSpan.start, surnameSpan.end)
        .every((tok) => !lookupCompatiblePersonLexiconMatch(effectiveLexicon, tok, fullNameLower))
    ) {
      const phrase = rawTokens.slice(surnameSpan.start, surnameSpan.end).join(' ');
      inspected.push({
        kind: 'token',
        role: 'surname',
        text: phrase,
        lexiconKey: null,
        entry: null,
      });
      idx = surnameSpan.end;
      continue;
    }

    const token = rawTokens[idx];
    if (token === undefined) {
      idx += 1;
      continue;
    }

    if (token.includes('-')) {
      const subTokens = token
        .split('-')
        .map((s) => s.trim())
        .filter(Boolean);
      if (subTokens.length > 1) {
        const role = roleForSpan(idx, idx + 1, false, seenGiven);
        if (role === 'given') {
          seenGiven = true;
        }
        subTokens.forEach((sub, s) => {
          const subMatch = lookupCompatiblePersonLexiconMatch(effectiveLexicon, sub, fullNameLower);
          inspected.push({
            kind: 'token',
            role,
            text: sub,
            lexiconKey: subMatch?.key ?? null,
            entry: subMatch?.entry ?? null,
            ...(s > 0 ? { joinWithHyphen: true } : {}),
          });
        });
        idx += 1;
        continue;
      }
    }

    if (rawTokens.length > 1 && isSingleLetterInitial(token)) {
      const role = roleForSpan(idx, idx + 1, false, seenGiven);
      inspected.push({
        kind: 'initial',
        role,
        text: token,
        lexiconKey: null,
        entry: null,
      });
      idx += 1;
      continue;
    }

    if (rawTokens.length > 1 && PERSON_NAME_DECORATION_RE.test(token)) {
      inspected.push({
        kind: 'decoration',
        role: 'suffix',
        text: token,
        lexiconKey: null,
        entry: null,
      });
      idx += 1;
      continue;
    }

    const role = roleForSpan(idx, idx + 1, false, seenGiven);
    if (role === 'given') {
      seenGiven = true;
    }
    inspected.push({
      kind: 'token',
      role,
      text: token,
      lexiconKey: null,
      entry: null,
    });
    idx += 1;
  }

  const { resolved: composed, missingParts } = resolveCompositionalPersonPronunciation(
    rawTokens,
    effectiveLexicon,
    fullNameLower
  );
  const editableTokens = inspected.filter((t) => t.kind === 'token');
  const hasAnySharedToken = editableTokens.some((t) => t.entry !== null);
  const allTokensResolved =
    editableTokens.length > 0 && editableTokens.every((t) => t.entry !== null) && composed !== null;

  return {
    tokens: inspected,
    composed,
    missingParts,
    allTokensResolved,
    hasAnySharedToken,
  };
}

/**
 * Resolve a person's effective pronunciation in strict precedence order:
 * 1. Explicit `person.pronunciation` (`coverage: 'full'`)
 * 2. Exact `lexicon[person.id]` or `lexicon[person.full_name]` (`coverage: 'full'`)
 * 3. Compositional full-name resolution across all meaningful name tokens (`coverage: 'full'`)
 * 4. Surname-only fallback (`coverage: 'surname'`, `matchedPart: surname`)
 *
 * Living people always resolve to `null`.
 */
export function resolvePersonPronunciation(
  person: {
    readonly id?: string | undefined;
    readonly is_living?: boolean | undefined;
    readonly full_name?: string | undefined;
    readonly given_name?: string | undefined;
    readonly surname?: string | undefined;
    readonly pronunciation?: Pronunciation | null | undefined;
  },
  lexicon?: Readonly<Record<string, Pronunciation>> | null
): ResolvedPersonPronunciation | null {
  if (person.is_living || person.full_name?.trim() === 'Living') {
    return null;
  }

  const fullNameTrimmed = person.full_name?.trim() ?? '';
  const idKey = person.id?.trim() ?? '';
  const exactIdEntry = lexicon && idKey ? lookupLexiconEntry(lexicon, idKey) : undefined;
  const own = person.pronunciation ?? undefined;

  if (!own && !exactIdEntry && lexicon && fullNameTrimmed) {
    const meta = getLexiconLowerIndexMeta(lexicon);
    if (!meta.hasMatchContainsRule && meta.resolvedPersonCache.size < 8192) {
      const surnameTrimmed = person.surname?.trim() ?? '';
      const cacheKey = `${fullNameTrimmed}\0${surnameTrimmed}`;
      const hit = meta.resolvedPersonCache.get(cacheKey);
      if (hit !== undefined || meta.resolvedPersonCache.has(cacheKey)) {
        return hit ? { ...hit } : null;
      }
      const fullNameLower = fullNameTrimmed.toLowerCase();
      const exactFullNameEntry = lookupCompatiblePersonLexiconEntry(lexicon, fullNameTrimmed, fullNameLower);
      let computed: ResolvedPersonPronunciation | null = null;
      if (exactFullNameEntry) {
        computed = {
          ...exactFullNameEntry,
          coverage: 'full',
          resolvedFrom: 'lexicon_full_name',
        };
      } else {
        const tokens = tokenizePersonName(person);
        const { resolved: composed, missingParts } = resolveCompositionalPersonPronunciation(
          tokens,
          lexicon,
          fullNameLower
        );
        if (composed) {
          computed = composed;
        } else if (surnameTrimmed) {
          const surnameEntry = lookupCompatiblePersonLexiconEntry(lexicon, surnameTrimmed, fullNameLower);
          if (surnameEntry) {
            computed = {
              ...surnameEntry,
              coverage: 'surname',
              matchedPart: surnameTrimmed,
              resolvedFrom: 'lexicon_surname',
              ...(missingParts.length > 0 ? { missingParts } : {}),
            };
          }
        }
      }
      meta.resolvedPersonCache.set(cacheKey, computed);
      return computed ? { ...computed } : null;
    }
  }

  const fullNameLower = fullNameTrimmed.toLowerCase();
  const exactFullNameEntry =
    lexicon && fullNameTrimmed
      ? lookupCompatiblePersonLexiconEntry(lexicon, fullNameTrimmed, fullNameLower)
      : undefined;
  const exactShared =
    exactIdEntry && hasPronunciationEntryContent(exactIdEntry) ? exactIdEntry : exactFullNameEntry;

  if (own && hasPronunciationEntryContent(own)) {
    const merged = mergePronunciationEntry(exactShared, own);
    if (merged) {
      return {
        ...merged,
        coverage: 'full',
        resolvedFrom: 'person',
      };
    }
  }

  if (exactIdEntry && hasPronunciationEntryContent(exactIdEntry)) {
    return {
      ...exactIdEntry,
      coverage: 'full',
      resolvedFrom: 'lexicon_id',
    };
  }
  if (exactFullNameEntry) {
    return {
      ...exactFullNameEntry,
      coverage: 'full',
      resolvedFrom: 'lexicon_full_name',
    };
  }

  if (!lexicon) {
    return null;
  }

  const tokens = tokenizePersonName(person);
  const { resolved: composed, missingParts } = resolveCompositionalPersonPronunciation(
    tokens,
    lexicon,
    fullNameLower
  );
  if (composed) {
    return composed;
  }

  const surnameKey = person.surname?.trim() ?? '';
  if (surnameKey) {
    const surnameEntry = lookupCompatiblePersonLexiconEntry(lexicon, surnameKey, fullNameLower);
    if (surnameEntry) {
      return {
        ...surnameEntry,
        coverage: 'surname',
        matchedPart: surnameKey,
        resolvedFrom: 'lexicon_surname',
        ...(missingParts.length > 0 ? { missingParts } : {}),
      };
    }
  }

  return null;
}
