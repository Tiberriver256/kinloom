import fs from 'node:fs';
import path from 'node:path';
import {
  findIpaGlyphsInPhonetic,
  inspectPersonPronunciationTokens,
  type KinloomSiteConfig,
  type Pronunciation,
  parseKinloomConfigYaml,
  parsePeopleYaml,
  type RawPerson,
  type ResolvedPersonPronunciation,
  resolveEffectiveLiving,
  resolvePersonPronunciation,
  serializeKinloomConfigYaml,
  serializePeopleYaml,
  stripIpaDelimiters,
} from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import { loadArchivePronunciationLexicon } from './lexiconLoader.js';
import type {
  PronounceDeduplicateKeepReason,
  PronounceDeduplicateKeptOverride,
  PronounceDeduplicateOptions,
  PronounceDeduplicatePromotedToken,
  PronounceDeduplicateRemovedOverride,
  PronounceDeduplicateResult,
  PronounceDeduplicateSkippedPromotion,
} from './types.js';

function normalizeWhitespace(value?: string | null): string {
  return (value ?? '').trim().replaceAll(/\s+/g, ' ');
}

function normalizeIpaComparable(value?: string | null): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return '';
  }
  return normalizeWhitespace(stripIpaDelimiters(trimmed));
}

function hasExplicitPronunciationContent(entry?: Pronunciation | null): entry is Pronunciation {
  if (!entry) {
    return false;
  }
  if (entry.phonetic?.trim() || entry.ipa?.trim() || entry.audio_url?.trim() || entry.note?.trim()) {
    return true;
  }
  return Boolean(
    entry.variants?.some(
      (v) =>
        Boolean(v.phonetic?.trim()) ||
        Boolean(v.ipa?.trim()) ||
        Boolean(v.audio_url?.trim()) ||
        Boolean(v.note?.trim())
    )
  );
}

export type OverrideRedundancyDecision =
  | {
      readonly kind: 'removable';
      readonly resolved: ResolvedPersonPronunciation;
    }
  | {
      readonly kind: 'keep';
      readonly reason: PronounceDeduplicateKeepReason;
      readonly detail: string;
    };

/**
 * Conservatively determine whether an explicit `person.pronunciation` override is 100%
 * losslessly redundant against the shared pronunciation lexicon.
 */
export function evaluatePersonOverrideRedundancy(
  person: RawPerson,
  lexicon: Readonly<Record<string, Pronunciation>>,
  force = false
): OverrideRedundancyDecision | null {
  const own = person.pronunciation;
  if (!hasExplicitPronunciationContent(own)) {
    return null;
  }

  const withoutOwn = resolvePersonPronunciation({ ...person, pronunciation: undefined }, lexicon);
  if (withoutOwn?.coverage !== 'full') {
    const missing = withoutOwn?.missingParts?.length
      ? ` (missing shared tokens: ${withoutOwn.missingParts.join(', ')})`
      : '';
    return {
      kind: 'keep',
      reason: 'would_drop_coverage',
      detail: `Removing override would drop coverage below full${missing}.`,
    };
  }

  const ownNote = normalizeWhitespace(own.note);
  const sharedNote = normalizeWhitespace(withoutOwn.note);
  if (ownNote && ownNote !== sharedNote) {
    return {
      kind: 'keep',
      reason: 'has_unique_note',
      detail: 'Override carries a unique pronunciation note.',
    };
  }

  if (own.variants && own.variants.length > 0) {
    const sharedVariantsJson = JSON.stringify(withoutOwn.variants ?? []);
    if (JSON.stringify(own.variants) !== sharedVariantsJson) {
      return {
        kind: 'keep',
        reason: 'has_unique_variants',
        detail: 'Override carries unique pronunciation variants.',
      };
    }
  }

  const ownAudio = normalizeWhitespace(own.audio_url);
  const sharedAudio = normalizeWhitespace(withoutOwn.audio_url);
  if (ownAudio && ownAudio !== sharedAudio) {
    return {
      kind: 'keep',
      reason: 'has_unique_audio',
      detail: 'Override carries a custom audio_url.',
    };
  }

  if (!force) {
    const ownPhonetic = normalizeWhitespace(own.phonetic);
    const sharedPhonetic = normalizeWhitespace(withoutOwn.phonetic);
    if (ownPhonetic && ownPhonetic !== sharedPhonetic) {
      return {
        kind: 'keep',
        reason: 'pronunciation_differs',
        detail: `Respelling differs ("${ownPhonetic}" vs shared "${sharedPhonetic || 'none'}").`,
      };
    }

    const ownIpa = normalizeIpaComparable(own.ipa);
    const sharedIpa = normalizeIpaComparable(withoutOwn.ipa);
    if (ownIpa && ownIpa !== sharedIpa) {
      return {
        kind: 'keep',
        reason: 'pronunciation_differs',
        detail: `IPA differs ("${own.ipa?.trim()}" vs shared "${withoutOwn.ipa?.trim() || 'none'}").`,
      };
    }
  }

  return {
    kind: 'removable',
    resolved: withoutOwn,
  };
}

interface PromotionCandidate {
  readonly term: string;
  readonly entry: Pronunciation;
  readonly personId: string;
}

function stripDelimitedPrefixAndSuffix(
  fullValue: string,
  prefixPieces: readonly string[],
  suffixPieces: readonly string[]
): string | null {
  let remaining = normalizeWhitespace(fullValue);
  for (const piece of prefixPieces) {
    const norm = normalizeWhitespace(piece);
    if (!norm) {
      return null;
    }
    if (remaining.toLowerCase().startsWith(`${norm.toLowerCase()} `)) {
      remaining = remaining.slice(norm.length + 1).trim();
    } else if (remaining.toLowerCase().startsWith(`${norm.toLowerCase()}-`)) {
      remaining = remaining.slice(norm.length + 1).trim();
    } else {
      return null;
    }
  }
  for (let i = suffixPieces.length - 1; i >= 0; i -= 1) {
    const norm = normalizeWhitespace(suffixPieces[i]);
    if (!norm) {
      return null;
    }
    if (remaining.toLowerCase().endsWith(` ${norm.toLowerCase()}`)) {
      remaining = remaining.slice(0, remaining.length - norm.length - 1).trim();
    } else if (remaining.toLowerCase().endsWith(`-${norm.toLowerCase()}`)) {
      remaining = remaining.slice(0, remaining.length - norm.length - 1).trim();
    } else {
      return null;
    }
  }
  return remaining || null;
}

function extractPromotableTokenFromPerson(
  person: RawPerson,
  lexicon: Readonly<Record<string, Pronunciation>>
): PromotionCandidate | null {
  const own = person.pronunciation;
  if (!hasExplicitPronunciationContent(own)) {
    return null;
  }
  const inspection = inspectPersonPronunciationTokens(person, lexicon);
  const editableTokens = inspection.tokens.filter((t) => t.kind === 'token');
  const unresolvedIndices: number[] = [];
  for (let i = 0; i < inspection.tokens.length; i += 1) {
    const tok = inspection.tokens[i];
    if (tok.kind === 'token' && tok.entry === null) {
      unresolvedIndices.push(i);
    }
  }
  if (editableTokens.length === 0 || unresolvedIndices.length !== 1) {
    return null;
  }

  const missingIdx = unresolvedIndices[0];
  const missingToken = inspection.tokens[missingIdx];
  const beforeTokens = inspection.tokens.slice(0, missingIdx);
  const afterTokens = inspection.tokens.slice(missingIdx + 1);

  let extractedPhonetic: string | undefined;
  const ownPhonetic = normalizeWhitespace(own.phonetic);
  if (ownPhonetic) {
    const beforePhonetic: string[] = [];
    const afterPhonetic: string[] = [];
    let canExtractPhonetic = true;
    for (const tok of beforeTokens) {
      const piece = tok.kind === 'token' ? normalizeWhitespace(tok.entry?.phonetic) : tok.text;
      if (!piece) {
        canExtractPhonetic = false;
        break;
      }
      beforePhonetic.push(piece);
    }
    if (canExtractPhonetic) {
      for (const tok of afterTokens) {
        const piece = tok.kind === 'token' ? normalizeWhitespace(tok.entry?.phonetic) : tok.text;
        if (!piece) {
          canExtractPhonetic = false;
          break;
        }
        afterPhonetic.push(piece);
      }
    }
    if (canExtractPhonetic) {
      const remainder = stripDelimitedPrefixAndSuffix(ownPhonetic, beforePhonetic, afterPhonetic);
      if (remainder) {
        extractedPhonetic = remainder;
      }
    }
  }

  let extractedIpa: string | undefined;
  const ownIpaInner = normalizeIpaComparable(own.ipa);
  if (ownIpaInner) {
    const beforeIpa: string[] = [];
    const afterIpa: string[] = [];
    let canExtractIpa = true;
    for (const tok of beforeTokens) {
      if (tok.kind !== 'token') {
        continue;
      }
      const piece = normalizeIpaComparable(tok.entry?.ipa);
      if (!piece) {
        canExtractIpa = false;
        break;
      }
      beforeIpa.push(piece);
    }
    if (canExtractIpa) {
      for (const tok of afterTokens) {
        if (tok.kind !== 'token') {
          continue;
        }
        const piece = normalizeIpaComparable(tok.entry?.ipa);
        if (!piece) {
          canExtractIpa = false;
          break;
        }
        afterIpa.push(piece);
      }
    }
    if (canExtractIpa) {
      const remainder = stripDelimitedPrefixAndSuffix(ownIpaInner, beforeIpa, afterIpa);
      if (remainder) {
        extractedIpa = `/${remainder}/`;
      }
    }
  }

  if (!extractedPhonetic && !extractedIpa) {
    return null;
  }

  const entry: Pronunciation = {
    ...(extractedPhonetic ? { phonetic: extractedPhonetic } : {}),
    ...(extractedIpa ? { ipa: extractedIpa } : {}),
    ...(own.language?.trim() ? { language: own.language.trim() } : {}),
    ...(own.source_label?.trim() ? { source_label: own.source_label.trim() } : {}),
    ...(own.source_url?.trim() ? { source_url: own.source_url.trim() } : {}),
    ...(own.region?.trim() ? { region: own.region.trim() } : {}),
  };

  return {
    term: missingToken.text,
    entry,
    personId: person.id,
  };
}

function formatDeduplicateText(result: Omit<PronounceDeduplicateResult, 'rendered'>): string {
  const s = result.summary;
  const modeLabel = result.applied ? 'APPLIED' : 'DRY RUN';
  const lines: string[] = [
    `Pronunciation Deduplicate (${modeLabel}) — ${result.repo}`,
    `  Deceased people scanned: ${s.deceased_people} | Living excluded: ${s.living_people_excluded}`,
    `  Explicit per-person overrides: ${s.people_with_explicit_overrides}`,
    `  Promotable shared tokens: ${s.promoted_tokens} (skipped: ${s.skipped_promotions})`,
    `  Redundant overrides removable: ${s.removable_overrides} | Kept safely: ${s.kept_overrides}`,
  ];

  if (result.promoted_tokens.length > 0) {
    lines.push('', `Shared tokens to promote (${result.promoted_tokens.length}):`);
    for (const p of result.promoted_tokens) {
      const guide = [p.phonetic, p.ipa].filter(Boolean).join(' ');
      lines.push(`  + "${p.term}" -> ${guide} (from ${p.source_person_id})`);
    }
  }

  if (result.skipped_promotions.length > 0) {
    lines.push('', `Skipped token promotions (${result.skipped_promotions.length}):`);
    for (const sk of result.skipped_promotions) {
      lines.push(`  - "${sk.term}" (${sk.reason}; sources: ${sk.source_person_ids.join(', ')})`);
    }
  }

  if (result.removable_overrides.length > 0) {
    lines.push('', `Redundant per-person overrides (${result.removable_overrides.length}):`);
    for (const r of result.removable_overrides) {
      lines.push(
        `  - ${r.id}: ${r.full_name} (inherits "${r.shared_phonetic ?? ''}" via ${r.resolved_from ?? 'shared'})`
      );
    }
  }

  if (result.kept_overrides.length > 0) {
    lines.push('', `Kept per-person overrides (${result.kept_overrides.length}):`);
    for (const k of result.kept_overrides) {
      lines.push(`  - ${k.id}: ${k.full_name} [${k.reason}] ${k.detail}`);
    }
  }

  if (result.applied) {
    if (result.files_written.length > 0) {
      lines.push('', `Updated files: ${result.files_written.join(', ')}`);
    } else {
      lines.push('', 'No files changed.');
    }
  } else if (result.promoted_tokens.length > 0 || result.removable_overrides.length > 0) {
    lines.push('', 'Dry run: no files were modified. Pass --apply to write changes.');
  } else {
    lines.push('', 'Nothing to deduplicate.');
  }

  return lines.join('\n');
}

export function runPronounceDeduplicateCommand(
  options: PronounceDeduplicateOptions
): PronounceDeduplicateResult {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }

  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  const peoplePath = path.join(repoDir, 'data', 'people.yaml');

  if (!fs.existsSync(configPath)) {
    throw new CliValidationError(
      `Missing ${configPath} (pass --repo <archive-root> if running outside the archive root).`
    );
  }

  const siteConfig: KinloomSiteConfig = parseKinloomConfigYaml(fs.readFileSync(configPath, 'utf8'));
  const people: RawPerson[] = fs.existsSync(peoplePath)
    ? parsePeopleYaml(fs.readFileSync(peoplePath, 'utf8'))
    : [];

  const livingIdsLower = new Set<string>();
  const livingFullNamesLower = new Set<string>();
  const deceasedPeople: RawPerson[] = [];
  let livingCount = 0;

  for (const person of people) {
    if (
      person.is_living ||
      person.full_name.trim() === 'Living' ||
      resolveEffectiveLiving(person, siteConfig.privacy)
    ) {
      livingCount += 1;
      livingIdsLower.add(person.id.trim().toLowerCase());
      const fullLower = person.full_name.trim().toLowerCase();
      if (fullLower && fullLower !== 'living') {
        livingFullNamesLower.add(fullLower);
      }
      continue;
    }
    deceasedPeople.push(person);
  }

  const baseLexicon = loadArchivePronunciationLexicon(repoDir, siteConfig.pronunciations);
  const workingLexicon: Record<string, Pronunciation> = { ...baseLexicon };
  const promotedTokens: PronounceDeduplicatePromotedToken[] = [];
  const skippedPromotions: PronounceDeduplicateSkippedPromotion[] = [];
  const promotedLexiconAdditions: Record<string, Pronunciation> = {};

  if (options.promoteTokens) {
    const candidatesByLower = new Map<string, PromotionCandidate[]>();
    for (const person of deceasedPeople) {
      const candidate = extractPromotableTokenFromPerson(person, workingLexicon);
      if (!candidate) {
        continue;
      }
      const lower = candidate.term.toLowerCase();
      const list = candidatesByLower.get(lower) ?? [];
      list.push(candidate);
      candidatesByLower.set(lower, list);
    }

    for (const [lower, candidates] of [...candidatesByLower.entries()].toSorted(([a], [b]) =>
      a.localeCompare(b)
    )) {
      const first = candidates[0];
      if (livingIdsLower.has(lower) || livingFullNamesLower.has(lower)) {
        skippedPromotions.push({
          term: first.term,
          reason: 'living_collision',
          source_person_ids: candidates.map((c) => c.personId),
        });
        continue;
      }

      const hasIpaInPhonetic = candidates.some((c) => findIpaGlyphsInPhonetic(c.entry.phonetic).length > 0);
      if (hasIpaInPhonetic) {
        skippedPromotions.push({
          term: first.term,
          reason: 'ipa_in_phonetic',
          source_person_ids: candidates.map((c) => c.personId),
        });
        continue;
      }

      const distinctPhonetics = new Set(
        candidates.map((c) => normalizeWhitespace(c.entry.phonetic)).filter(Boolean)
      );
      const distinctIpas = new Set(
        candidates.map((c) => normalizeIpaComparable(c.entry.ipa)).filter(Boolean)
      );
      if (distinctPhonetics.size > 1 || distinctIpas.size > 1) {
        skippedPromotions.push({
          term: first.term,
          reason: 'conflicting_candidates',
          source_person_ids: candidates.map((c) => c.personId),
        });
        continue;
      }

      const bestEntry =
        candidates.find((c) => c.entry.phonetic && c.entry.ipa && c.entry.source_label) ??
        candidates.find((c) => c.entry.phonetic && c.entry.ipa) ??
        first;

      workingLexicon[bestEntry.term] = bestEntry.entry;
      promotedLexiconAdditions[bestEntry.term] = bestEntry.entry;
      promotedTokens.push({
        term: bestEntry.term,
        ...(bestEntry.entry.phonetic ? { phonetic: bestEntry.entry.phonetic } : {}),
        ...(bestEntry.entry.ipa ? { ipa: bestEntry.entry.ipa } : {}),
        ...(bestEntry.entry.language ? { language: bestEntry.entry.language } : {}),
        source_person_id: bestEntry.personId,
      });
    }
  }

  const removableOverrides: PronounceDeduplicateRemovedOverride[] = [];
  const keptOverrides: PronounceDeduplicateKeptOverride[] = [];
  const removableIds = new Set<string>();
  let peopleWithExplicitOverrides = 0;

  for (const person of deceasedPeople) {
    const decision = evaluatePersonOverrideRedundancy(person, workingLexicon, Boolean(options.force));
    if (!decision) {
      continue;
    }
    peopleWithExplicitOverrides += 1;
    if (decision.kind === 'removable') {
      removableIds.add(person.id);
      removableOverrides.push({
        id: person.id,
        full_name: person.full_name,
        ...(person.pronunciation?.phonetic ? { explicit_phonetic: person.pronunciation.phonetic } : {}),
        ...(decision.resolved.phonetic ? { shared_phonetic: decision.resolved.phonetic } : {}),
        ...(decision.resolved.resolvedFrom ? { resolved_from: decision.resolved.resolvedFrom } : {}),
      });
    } else {
      keptOverrides.push({
        id: person.id,
        full_name: person.full_name,
        reason: decision.reason,
        detail: decision.detail,
      });
    }
  }

  removableOverrides.sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id));
  keptOverrides.sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id));

  const filesWritten: string[] = [];
  const applied = Boolean(options.apply);

  if (applied) {
    if (Object.keys(promotedLexiconAdditions).length > 0) {
      const nextConfig: KinloomSiteConfig = {
        ...siteConfig,
        pronunciations: {
          ...(siteConfig.pronunciations ?? {}),
          ...promotedLexiconAdditions,
        },
      };
      fs.writeFileSync(configPath, serializeKinloomConfigYaml(nextConfig), 'utf8');
      filesWritten.push('kinloom.config.yaml');
    }

    if (removableIds.size > 0 && fs.existsSync(peoplePath)) {
      const updatedPeople = people.map((person) => {
        if (!removableIds.has(person.id)) {
          return person;
        }
        const { pronunciation: _removed, ...rest } = person;
        return rest;
      });
      fs.writeFileSync(peoplePath, serializePeopleYaml(updatedPeople), 'utf8');
      filesWritten.push('data/people.yaml');
    }
  }

  const resultBody: Omit<PronounceDeduplicateResult, 'rendered'> = {
    ok: true,
    applied,
    repo: repoDir,
    summary: {
      deceased_people: deceasedPeople.length,
      living_people_excluded: livingCount,
      people_with_explicit_overrides: peopleWithExplicitOverrides,
      promoted_tokens: promotedTokens.length,
      skipped_promotions: skippedPromotions.length,
      removable_overrides: removableOverrides.length,
      kept_overrides: keptOverrides.length,
    },
    promoted_tokens: promotedTokens,
    skipped_promotions: skippedPromotions,
    removable_overrides: removableOverrides,
    kept_overrides: keptOverrides,
    files_written: filesWritten,
  };

  const rendered = options.json ? JSON.stringify(resultBody, null, 2) : formatDeduplicateText(resultBody);
  return { ...resultBody, rendered };
}
