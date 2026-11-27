import fs from 'node:fs';
import path from 'node:path';
import {
  getCurrentReferenceYear,
  type KinloomSiteConfig,
  type Place,
  type Pronunciation,
  parseKinloomConfigYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  type RawPerson,
  resolveEffectiveLiving,
  resolvePersonPronunciation,
  resolvePlacePronunciation,
} from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import { formatAuditText } from './auditReport.js';
import {
  detectHomonymousPlaceCollisions,
  detectLivingPronunciationLeaks,
  hasPronunciationValues,
  inspectNonTrivialPlaceReason,
  inspectPronunciationQuality,
} from './auditRules.js';
import { evaluatePersonOverrideRedundancy } from './deduplicate.js';
import { loadArchivePronunciationLexicon } from './lexiconLoader.js';
import type {
  PronounceAuditOptions,
  PronounceAuditResult,
  PronounceCoverageGapPerson,
  PronounceCoverageGapPlace,
  PronounceMissingPersonGap,
  PronouncePartialPersonGap,
  PronounceQualityWarning,
  PronounceRedundantPersonOverride,
  PronounceUnsourcedEntry,
} from './types.js';

export { loadArchivePronunciationLexicon } from './lexiconLoader.js';

export function runPronounceAuditCommand(options: PronounceAuditOptions): PronounceAuditResult {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }

  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  const peoplePath = path.join(repoDir, 'data', 'people.yaml');
  const placesPath = path.join(repoDir, 'data', 'places.yaml');

  if (!fs.existsSync(configPath)) {
    throw new CliValidationError(
      `Missing ${configPath} (pass --repo <archive-root> if running outside the archive root).`
    );
  }

  const siteConfig: KinloomSiteConfig = parseKinloomConfigYaml(fs.readFileSync(configPath, 'utf8'));
  const people: RawPerson[] = fs.existsSync(peoplePath)
    ? parsePeopleYaml(fs.readFileSync(peoplePath, 'utf8'))
    : [];
  const places: Place[] = fs.existsSync(placesPath)
    ? parsePlacesYaml(fs.readFileSync(placesPath, 'utf8'))
    : [];

  const lexicon = loadArchivePronunciationLexicon(repoDir, siteConfig.pronunciations);
  const lexiconLowerKeys = new Map<string, string>();
  for (const key of Object.keys(lexicon)) {
    lexiconLowerKeys.set(key.trim().toLowerCase(), key);
  }

  const deceasedPeople: RawPerson[] = [];
  const livingPeople: Array<{ index: number; person: RawPerson }> = [];
  const referenceYear = siteConfig.privacy.referenceYear ?? getCurrentReferenceYear();
  for (let i = 0; i < people.length; i += 1) {
    const person = people[i];
    if (
      person.is_living ||
      person.full_name.trim() === 'Living' ||
      resolveEffectiveLiving(person, siteConfig.privacy, referenceYear)
    ) {
      livingPeople.push({ index: i + 1, person });
      continue;
    }
    deceasedPeople.push(person);
  }

  const livingLeaks = detectLivingPronunciationLeaks(livingPeople, deceasedPeople, lexiconLowerKeys);

  let deceasedFullCoverage = 0;
  const peoplePartial: PronouncePartialPersonGap[] = [];
  const peopleMissing: PronounceMissingPersonGap[] = [];

  for (const person of deceasedPeople) {
    const resolved = resolvePersonPronunciation(person, lexicon);
    if (!resolved || !hasPronunciationValues(resolved)) {
      peopleMissing.push({
        id: person.id,
        full_name: person.full_name,
        surname: person.surname,
      });
      continue;
    }
    if (resolved.coverage === 'full') {
      deceasedFullCoverage += 1;
    } else {
      peoplePartial.push({
        id: person.id,
        full_name: person.full_name,
        coverage: resolved.coverage,
        matched_part: resolved.matchedPart ?? null,
        missing_parts: [...(resolved.missingParts ?? [])],
      });
    }
  }
  peopleMissing.sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id));
  peoplePartial.sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id));

  const surnameStats = new Map<
    string,
    { canonical: string; deceasedCount: number; hasExplicitOverride: boolean }
  >();
  for (const person of deceasedPeople) {
    const surname = person.surname.trim();
    if (!surname || surname.toLowerCase() === 'unknown') {
      continue;
    }
    const lower = surname.toLowerCase();
    const existing = surnameStats.get(lower);
    const hasOwn = hasPronunciationValues(person.pronunciation);
    if (existing) {
      existing.deceasedCount += 1;
      if (hasOwn) {
        existing.hasExplicitOverride = true;
      }
    } else {
      surnameStats.set(lower, {
        canonical: surname,
        deceasedCount: 1,
        hasExplicitOverride: hasOwn,
      });
    }
  }

  const missingSurnames: PronounceCoverageGapPerson[] = [];
  for (const [lower, stat] of surnameStats.entries()) {
    if (!lexiconLowerKeys.has(lower) && !stat.hasExplicitOverride) {
      missingSurnames.push({
        surname: stat.canonical,
        deceased_count: stat.deceasedCount,
      });
    }
  }
  missingSurnames.sort((a, b) => b.deceased_count - a.deceased_count || a.surname.localeCompare(b.surname));

  let placesCovered = 0;
  let nonTrivialMissingPlaces = 0;
  const missingPlaces: PronounceCoverageGapPlace[] = [];
  for (const place of places) {
    const resolved = resolvePlacePronunciation(place, lexicon);
    if (resolved && (resolved.phonetic || resolved.ipa || resolved.audio_url)) {
      placesCovered += 1;
      continue;
    }
    const nonTrivialReason = inspectNonTrivialPlaceReason(place);
    if (nonTrivialReason) {
      nonTrivialMissingPlaces += 1;
    }
    missingPlaces.push({
      id: place.id,
      name: place.name,
      full_name: place.full_name,
      reason: nonTrivialReason ?? 'missing pronunciation entry',
    });
  }
  missingPlaces.sort((a, b) => a.full_name.localeCompare(b.full_name));

  const unsourcedEntries: PronounceUnsourcedEntry[] = [];
  const qualityWarnings: PronounceQualityWarning[] = [];

  const auditEntry = (
    scope: 'lexicon' | 'person' | 'place',
    key: string,
    label: string,
    entry: Pronunciation
  ): void => {
    const hasSource = Boolean(entry.source_url?.trim() || entry.source_label?.trim());
    if (!hasSource) {
      unsourcedEntries.push({
        scope,
        key,
        label,
        missing_note: !entry.note?.trim(),
      });
    }
    inspectPronunciationQuality(scope, key, entry, qualityWarnings);
    for (const variant of entry.variants ?? []) {
      inspectPronunciationQuality(scope, `${key} [${variant.label}]`, variant, qualityWarnings);
    }
  };

  for (const [term, entry] of Object.entries(lexicon).toSorted(([a], [b]) => a.localeCompare(b))) {
    auditEntry('lexicon', term, term, entry);
  }
  for (const person of deceasedPeople) {
    if (person.pronunciation) {
      auditEntry('person', person.id, `${person.full_name} (${person.id})`, person.pronunciation);
    }
  }
  for (const place of places) {
    if (place.pronunciation) {
      auditEntry('place', place.id, `${place.full_name} (${place.id})`, place.pronunciation);
    }
  }

  const redundantPersonOverrides: PronounceRedundantPersonOverride[] = [];
  for (const person of deceasedPeople) {
    const decision = evaluatePersonOverrideRedundancy(person, lexicon, false);
    if (decision?.kind === 'removable') {
      redundantPersonOverrides.push({
        id: person.id,
        full_name: person.full_name,
        ...(person.pronunciation?.phonetic ? { explicit_phonetic: person.pronunciation.phonetic } : {}),
        ...(decision.resolved.phonetic ? { composed_phonetic: decision.resolved.phonetic } : {}),
        ...(decision.resolved.resolvedFrom ? { resolved_from: decision.resolved.resolvedFrom } : {}),
      });
    }
  }
  redundantPersonOverrides.sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id));

  const homonymousCollisions = detectHomonymousPlaceCollisions(places, lexicon);
  const ipaInPhoneticWarnings = qualityWarnings.filter((w) => w.code === 'ipa_in_phonetic');

  const strictOk =
    livingLeaks.length === 0 &&
    peoplePartial.length === 0 &&
    peopleMissing.length === 0 &&
    missingPlaces.length === 0 &&
    homonymousCollisions.length === 0 &&
    ipaInPhoneticWarnings.length === 0;
  const ok = livingLeaks.length === 0 && (!options.strict || strictOk);

  const resultBody: Omit<PronounceAuditResult, 'rendered'> = {
    ok,
    strictOk,
    repo: repoDir,
    summary: {
      deceasedTotal: deceasedPeople.length,
      deceasedFullCoverage,
      deceasedPartialOnly: peoplePartial.length,
      deceasedMissing: peopleMissing.length,
      livingLeaks: livingLeaks.length,
      placesTotal: places.length,
      placesCovered,
      placesMissing: missingPlaces.length,
      lexicon_entries: Object.keys(lexicon).length,
      deceased_people: deceasedPeople.length,
      living_people_excluded: livingPeople.length,
      places: places.length,
      missing_surnames: missingSurnames.length,
      missing_non_trivial_places: nonTrivialMissingPlaces,
      unsourced_entries: unsourcedEntries.length,
      homonymous_place_collisions: homonymousCollisions.length,
      ipa_quality_warnings: qualityWarnings.length,
      redundant_person_overrides: redundantPersonOverrides.length,
    },
    living_leaks: livingLeaks,
    coverage_gaps: {
      people_missing: peopleMissing,
      people_partial: peoplePartial,
      surnames: missingSurnames,
      places: missingPlaces,
    },
    unsourced_entries: unsourcedEntries,
    homonymous_place_collisions: homonymousCollisions,
    ipa_quality_warnings: qualityWarnings,
    redundant_person_overrides: redundantPersonOverrides,
  };

  const rendered = options.json ? JSON.stringify(resultBody, null, 2) : formatAuditText(resultBody);
  return { ...resultBody, rendered };
}
