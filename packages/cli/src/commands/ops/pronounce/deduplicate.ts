import fs from 'node:fs';
import path from 'node:path';
import {
  findIpaGlyphsInPhonetic,
  getCurrentReferenceYear,
  type KinloomSiteConfig,
  type Pronunciation,
  parseKinloomConfigYaml,
  parsePeopleYaml,
  type RawPerson,
  resolveEffectiveLiving,
  serializeKinloomConfigYaml,
  serializePeopleYaml,
} from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import {
  evaluatePersonOverrideRedundancy,
  extractPromotableTokenFromPerson,
  loadArchivePronunciationLexicon,
  normalizeIpaForConflictCheck,
  normalizePhoneticComparable,
  type PromotionCandidate,
  type PronounceDeduplicateKeptOverride,
  type PronounceDeduplicateOptions,
  type PronounceDeduplicatePromotedToken,
  type PronounceDeduplicateRemovedOverride,
  type PronounceDeduplicateResult,
  type PronounceDeduplicateSkippedPromotion,
} from '../shared/pronunciation/index.js';

export {
  evaluatePersonOverrideRedundancy,
  type OverrideRedundancyDecision,
} from '../shared/pronunciation/index.js';

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

  const referenceYear = siteConfig.privacy.referenceYear ?? getCurrentReferenceYear();
  for (const person of people) {
    if (
      person.is_living ||
      person.full_name.trim() === 'Living' ||
      resolveEffectiveLiving(person, siteConfig.privacy, referenceYear)
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
        candidates.map((c) => normalizePhoneticComparable(c.entry.phonetic)).filter(Boolean)
      );
      const distinctIpas = new Set(
        candidates.map((c) => normalizeIpaForConflictCheck(c.entry.ipa)).filter(Boolean)
      );
      if (distinctPhonetics.size > 1 || distinctIpas.size > 1) {
        skippedPromotions.push({
          term: first.term,
          reason: 'conflicting_candidates',
          source_person_ids: candidates.map((c) => c.personId),
        });
        continue;
      }

      const bestCandidate =
        candidates.find(
          (c) =>
            c.entry.phonetic &&
            c.entry.ipa?.includes('ˈ') &&
            /[A-Z]/.test(c.entry.phonetic) &&
            c.entry.source_label
        ) ??
        candidates.find((c) => c.entry.phonetic && c.entry.ipa && c.entry.source_label) ??
        candidates.find((c) => c.entry.phonetic && c.entry.ipa) ??
        candidates.find((c) => c.entry.phonetic) ??
        first;

      const bestPhonetic =
        bestCandidate.entry.phonetic ??
        candidates.find((c) => c.entry.phonetic && /[A-Z]/.test(c.entry.phonetic))?.entry.phonetic ??
        candidates.find((c) => c.entry.phonetic)?.entry.phonetic;
      const bestIpa =
        bestCandidate.entry.ipa ??
        candidates.find((c) => c.entry.ipa?.includes('ˈ'))?.entry.ipa ??
        candidates.find((c) => c.entry.ipa)?.entry.ipa;
      const mergedEntry: Pronunciation = {
        ...bestCandidate.entry,
        ...(bestPhonetic ? { phonetic: bestPhonetic } : {}),
        ...(bestIpa ? { ipa: bestIpa } : {}),
      };

      workingLexicon[bestCandidate.term] = mergedEntry;
      promotedLexiconAdditions[bestCandidate.term] = mergedEntry;
      promotedTokens.push({
        term: bestCandidate.term,
        ...(mergedEntry.phonetic ? { phonetic: mergedEntry.phonetic } : {}),
        ...(mergedEntry.ipa ? { ipa: mergedEntry.ipa } : {}),
        ...(mergedEntry.language ? { language: mergedEntry.language } : {}),
        source_person_id: bestCandidate.personId,
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
