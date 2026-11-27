import fs from 'node:fs';
import path from 'node:path';
import {
  type KinloomSiteConfig,
  type Place,
  type Pronunciation,
  PronunciationSchema,
  type PronunciationVariant,
  parseKinloomConfigYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseYaml,
  type RawPerson,
  resolveEffectiveLiving,
  resolvePersonPronunciation,
  resolvePlacePronunciation,
} from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import {
  normalizeLangCode,
  type PronounceAuditOptions,
  type PronounceAuditResult,
  type PronounceCoverageGapPerson,
  type PronounceCoverageGapPlace,
  type PronounceHomonymCollision,
  type PronounceLivingLeak,
  type PronounceMissingPersonGap,
  type PronouncePartialPersonGap,
  type PronounceQualityWarning,
  type PronounceUnsourcedEntry,
} from './types.js';

const NON_ENGLISH_COUNTRY_HINTS = [
  'netherlands',
  'nederland',
  'holland',
  'zeeland',
  'friesland',
  'gelderland',
  'sweden',
  'sverige',
  'finland',
  'suomi',
  'poland',
  'polska',
  'germany',
  'deutschland',
  'prussia',
  'preußen',
  'belgium',
  'belgië',
  'norway',
  'norge',
  'denmark',
  'danmark',
  'france',
  'italy',
  'italia',
  'austria',
  'switzerland',
];

const NON_TRIVIAL_PLACE_PATTERNS: readonly RegExp[] = [
  /(?:dijk|kerk|stad|holm|vik|berg|borg|huizen|woude|zand|sluis|meer|veld|veen|buren|dam|sloot)$/i,
  /(?:järvi|koski|mäki|lahti|niemi|luoto|pää|kylä)$/i,
  /(?:sz|cz|rz|dz|ść|ź|ł|ń|ś|ć)/i,
  /(?:ij|oe|ui|eu|aa|ee|oo|uu)/i,
  /(?:ough|augh|sch|tz|ckh|gham|cester|wich|borough|burgh)/i,
];

interface ForeignIpaRule {
  readonly pattern: RegExp;
  readonly tokenLabel: string;
}

const COMMON_ENGLISH_IPA_RULES: readonly ForeignIpaRule[] = [
  { pattern: /[ɝɚ]/, tokenLabel: 'rhotic schwa (/ɝ/ or /ɚ/)' },
  { pattern: /ɜː?r/, tokenLabel: 'English r-colored /ɜːr/' },
  { pattern: /ɹ/, tokenLabel: 'English approximant /ɹ/' },
  { pattern: /oʊ/, tokenLabel: 'English diphthong /oʊ/' },
  { pattern: /eɪ/, tokenLabel: 'English diphthong /eɪ/' },
  { pattern: /[θð]/, tokenLabel: 'English dental fricative (/θ/ or /ð/)' },
];

const ENGLISH_AI_DIPHTHONG_RULE: ForeignIpaRule = {
  pattern: /aɪ/,
  tokenLabel: 'English diphthong /aɪ/',
};

const FOREIGN_IPA_SUSPICIOUS_RULES: Readonly<Record<string, readonly ForeignIpaRule[]>> = {
  nl: [
    ...COMMON_ENGLISH_IPA_RULES.slice(0, 3),
    { pattern: /aɪ(?![̯])/, tokenLabel: 'English diphthong /aɪ/' },
    ...COMMON_ENGLISH_IPA_RULES.slice(3),
  ],
  sv: [
    ...COMMON_ENGLISH_IPA_RULES.slice(0, 3),
    ENGLISH_AI_DIPHTHONG_RULE,
    ...COMMON_ENGLISH_IPA_RULES.slice(3),
  ],
  fi: [
    ...COMMON_ENGLISH_IPA_RULES.slice(0, 3),
    ENGLISH_AI_DIPHTHONG_RULE,
    ...COMMON_ENGLISH_IPA_RULES.slice(3),
  ],
  pl: [
    ...COMMON_ENGLISH_IPA_RULES.slice(0, 3),
    ENGLISH_AI_DIPHTHONG_RULE,
    ...COMMON_ENGLISH_IPA_RULES.slice(3),
  ],
  de: COMMON_ENGLISH_IPA_RULES,
};

function hasNonAsciiChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) {
      return true;
    }
  }
  return false;
}

function inspectNonTrivialPlaceReason(place: Place): string | null {
  const fullLower = place.full_name.toLowerCase();
  const segments = place.full_name
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const qualifierJoined = segments.length > 1 ? segments.slice(1).join(', ') : fullLower;

  for (const countryHint of NON_ENGLISH_COUNTRY_HINTS) {
    if (qualifierJoined.includes(countryHint)) {
      return `foreign place (${countryHint})`;
    }
  }
  if (hasNonAsciiChar(place.name)) {
    return 'non-ASCII orthography';
  }
  for (const pattern of NON_TRIVIAL_PLACE_PATTERNS) {
    if (pattern.test(place.name)) {
      return 'non-trivial orthography';
    }
  }
  return null;
}

function derivePlaceScopeHint(place: Place): string {
  const segments = place.full_name
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length <= 1) {
    return place.full_name;
  }
  return segments.slice(-2).join(', ');
}

function inspectPronunciationQuality(
  scope: 'lexicon' | 'person' | 'place',
  key: string,
  entry: Pick<Pronunciation, 'phonetic' | 'ipa' | 'language' | 'audio_url' | 'note'> | PronunciationVariant,
  warnings: PronounceQualityWarning[]
): void {
  const phonetic = entry.phonetic?.trim() ?? '';
  const ipa = entry.ipa?.trim() ?? '';
  const audioUrl = entry.audio_url?.trim() ?? '';
  const language = entry.language?.trim() ?? '';

  if (!phonetic && !ipa && !audioUrl) {
    warnings.push({
      scope,
      key,
      code: 'empty_entry',
      ...(language ? { language } : {}),
      message: `Entry '${key}' has no Respelling, IPA, or audio_url.`,
    });
    return;
  }

  if (ipa) {
    const validSlashed = ipa.startsWith('/') && ipa.endsWith('/') && ipa.length > 2;
    const validBracketed = ipa.startsWith('[') && ipa.endsWith(']') && ipa.length > 2;
    if (!validSlashed && !validBracketed) {
      warnings.push({
        scope,
        key,
        code: 'malformed_ipa',
        ...(language ? { language } : {}),
        ipa,
        message: `Entry '${key}' has unslashed/malformed IPA '${ipa}' (expected /.../ or [...]).`,
      });
    } else {
      const inner = ipa.slice(1, -1).trim();
      if (!inner || /[A-Z]{2,}/.test(inner)) {
        warnings.push({
          scope,
          key,
          code: 'malformed_ipa',
          ...(language ? { language } : {}),
          ipa,
          message: `Entry '${key}' IPA '${ipa}' looks malformed or contains uppercase Respelling.`,
        });
      }
    }

    const baseLang = normalizeLangCode(language);
    if (baseLang && FOREIGN_IPA_SUSPICIOUS_RULES[baseLang]) {
      const matchedLabels: string[] = [];
      for (const rule of FOREIGN_IPA_SUSPICIOUS_RULES[baseLang]) {
        if (rule.pattern.test(ipa)) {
          matchedLabels.push(rule.tokenLabel);
        }
      }
      if (matchedLabels.length > 0) {
        warnings.push({
          scope,
          key,
          code: 'suspicious_english_ipa_for_foreign_lang',
          language,
          ipa,
          message: `Entry '${key}' (language=${language}) contains suspicious English IPA token(s): ${matchedLabels.join(', ')}.`,
        });
      }
    }
  }
}

function hasPronunciationValues(entry?: Pronunciation | null): boolean {
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

function formatAuditText(result: Omit<PronounceAuditResult, 'rendered'>): string {
  const s = result.summary;
  const lines: string[] = [
    `Pronunciation Audit (${result.repo})`,
    `  Pronunciation Lexicon entries: ${s.lexicon_entries} | Living excluded: ${s.living_people_excluded}`,
    `  Deceased Full-Name Pronunciation coverage: ${s.deceasedFullCoverage}/${s.deceasedTotal} (Surname/Partial: ${s.deceasedPartialOnly}, missing: ${s.deceasedMissing})`,
    `  Places coverage: ${s.placesCovered}/${s.placesTotal} (missing: ${s.placesMissing})`,
    `  Living pronunciation leaks: ${s.livingLeaks}`,
    `  Homonymous bare place collisions: ${s.homonymous_place_collisions}`,
    `  Unsourced entries: ${s.unsourced_entries} | IPA / quality warnings: ${s.ipa_quality_warnings}`,
  ];

  if (result.living_leaks.length > 0) {
    lines.push('', `LIVING PRONUNCIATION LEAKS (${result.living_leaks.length}) [FAIL]:`);
    for (const leak of result.living_leaks) {
      lines.push(`  - [${leak.scope}] ${leak.location}: ${leak.reason}`);
    }
  }

  if (result.coverage_gaps.people_missing.length > 0) {
    lines.push('', `Deceased people missing pronunciation (${result.coverage_gaps.people_missing.length}):`);
    for (const p of result.coverage_gaps.people_missing.slice(0, 25)) {
      lines.push(`  - ${p.id}: ${p.full_name}`);
    }
    if (result.coverage_gaps.people_missing.length > 25) {
      lines.push(`  ... and ${result.coverage_gaps.people_missing.length - 25} more.`);
    }
  }

  if (result.coverage_gaps.people_partial.length > 0) {
    lines.push(
      '',
      `Deceased people with Surname Pronunciation or Partial Pronunciation (${result.coverage_gaps.people_partial.length}):`
    );
    for (const p of result.coverage_gaps.people_partial.slice(0, 25)) {
      const missingStr = p.missing_parts.length > 0 ? ` (missing: ${p.missing_parts.join(', ')})` : '';
      lines.push(`  - ${p.id}: ${p.full_name} [${p.coverage}]${missingStr}`);
    }
    if (result.coverage_gaps.people_partial.length > 25) {
      lines.push(`  ... and ${result.coverage_gaps.people_partial.length - 25} more.`);
    }
  }

  if (result.coverage_gaps.places.length > 0) {
    lines.push('', `Places missing pronunciation (${result.coverage_gaps.places.length}):`);
    for (const p of result.coverage_gaps.places.slice(0, 25)) {
      lines.push(`  - ${p.id}: ${p.full_name} (${p.reason})`);
    }
    if (result.coverage_gaps.places.length > 25) {
      lines.push(`  ... and ${result.coverage_gaps.places.length - 25} more.`);
    }
  }

  if (result.homonymous_place_collisions.length > 0) {
    lines.push('', 'Homonymous bare place collisions:');
    for (const c of result.homonymous_place_collisions) {
      const list = c.places.map((p) => `${p.id} (${p.full_name})`).join('; ');
      lines.push(`  - "${c.lexicon_key}" matches multiple places: ${list}`);
      lines.push(`    -> ${c.recommendation}`);
    }
  }

  if (result.ipa_quality_warnings.length > 0) {
    lines.push('', 'IPA / quality warnings:');
    for (const w of result.ipa_quality_warnings) {
      lines.push(`  - [${w.scope}:${w.key}] (${w.code}) ${w.message}`);
    }
  }

  if (result.unsourced_entries.length > 0) {
    lines.push('', `Unsourced entries (${result.unsourced_entries.length}):`);
    for (const u of result.unsourced_entries.slice(0, 25)) {
      lines.push(
        `  - [${u.scope}] ${u.label}${u.missing_note ? ' (missing source and note)' : ' (missing source_url/source_label)'}`
      );
    }
    if (result.unsourced_entries.length > 25) {
      lines.push(`  ... and ${result.unsourced_entries.length - 25} more.`);
    }
  }

  if (result.coverage_gaps.surnames.length > 0) {
    lines.push('', `Missing deceased surnames (${result.coverage_gaps.surnames.length}):`);
    for (const g of result.coverage_gaps.surnames.slice(0, 20)) {
      lines.push(`  - ${g.surname} (${g.deceased_count} deceased)`);
    }
    if (result.coverage_gaps.surnames.length > 20) {
      lines.push(`  ... and ${result.coverage_gaps.surnames.length - 20} more.`);
    }
  }

  return lines.join('\n');
}

export function loadArchivePronunciationLexicon(
  repoDir: string,
  sitePronunciations?: Readonly<Record<string, Pronunciation>>
): Record<string, Pronunciation> {
  const merged: Record<string, Pronunciation> = { ...(sitePronunciations ?? {}) };
  const dataLexiconPath = path.join(repoDir, 'data', 'pronunciations.yaml');
  if (fs.existsSync(dataLexiconPath)) {
    try {
      const parsed = parseYaml(fs.readFileSync(dataLexiconPath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val !== 'object' || val === null || Array.isArray(val)) {
            continue;
          }
          const result = PronunciationSchema.safeParse(val);
          if (result.success) {
            merged[key] = result.data;
          }
        }
      }
    } catch {
      // Malformed optional data/pronunciations.yaml is surfaced by schema/YAML checks elsewhere.
    }
  }
  return merged;
}

function detectLivingPronunciationLeaks(
  livingPeople: readonly { index: number; person: RawPerson }[],
  deceasedPeople: readonly RawPerson[],
  lexiconLowerKeys: ReadonlyMap<string, string>
): PronounceLivingLeak[] {
  const deceasedFullNamesLower = new Set(
    deceasedPeople.map((p) => p.full_name.trim().toLowerCase()).filter(Boolean)
  );
  const deceasedIdsLower = new Set(deceasedPeople.map((p) => p.id.trim().toLowerCase()));
  const livingLeaks: PronounceLivingLeak[] = [];

  for (const { index, person } of livingPeople) {
    if (hasPronunciationValues(person.pronunciation)) {
      livingLeaks.push({
        scope: 'person',
        location: `data/people.yaml record #${index}`,
        reason: 'Living person record contains a pronunciation entry (redacted for privacy).',
      });
    }
    const idLower = person.id.trim().toLowerCase();
    if (idLower && !deceasedIdsLower.has(idLower) && lexiconLowerKeys.has(idLower)) {
      livingLeaks.push({
        scope: 'lexicon',
        location: `kinloom.config.yaml pronunciations (matches data/people.yaml record #${index})`,
        reason: 'Pronunciation Lexicon contains a key matching a living person ID (redacted for privacy).',
      });
    }
    const fullLower = person.full_name.trim().toLowerCase();
    if (
      fullLower &&
      fullLower !== 'living' &&
      !deceasedFullNamesLower.has(fullLower) &&
      lexiconLowerKeys.has(fullLower)
    ) {
      livingLeaks.push({
        scope: 'lexicon',
        location: `kinloom.config.yaml pronunciations (matches data/people.yaml record #${index})`,
        reason:
          'Pronunciation Lexicon contains a full-name key matching a living person (redacted for privacy).',
      });
    }
  }

  return livingLeaks;
}

function detectHomonymousPlaceCollisions(
  places: readonly Place[],
  lexicon: Readonly<Record<string, Pronunciation>>
): PronounceHomonymCollision[] {
  const placesByBareNameLower = new Map<string, Place[]>();
  for (const place of places) {
    const lower = place.name.trim().toLowerCase();
    if (!lower) {
      continue;
    }
    const list = placesByBareNameLower.get(lower) ?? [];
    list.push(place);
    placesByBareNameLower.set(lower, list);
  }

  const homonymousCollisions: PronounceHomonymCollision[] = [];
  for (const [key] of Object.entries(lexicon).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (key.includes(',') || key.startsWith('plc_')) {
      continue;
    }
    const matchingPlaces = placesByBareNameLower.get(key.trim().toLowerCase());
    if (!matchingPlaces || matchingPlaces.length < 2) {
      continue;
    }
    const distinctScopes = new Set(matchingPlaces.map((p) => derivePlaceScopeHint(p).toLowerCase()));
    if (distinctScopes.size < 2) {
      continue;
    }
    const sortedMatches = [...matchingPlaces].toSorted((a, b) => a.full_name.localeCompare(b.full_name));
    const exampleKeys = sortedMatches
      .slice(0, 2)
      .map((p) => `"${p.name}, ${derivePlaceScopeHint(p)}"`)
      .join(' and ');
    homonymousCollisions.push({
      lexicon_key: key,
      places: sortedMatches.map((p) => ({
        id: p.id,
        name: p.name,
        full_name: p.full_name,
        scope_hint: derivePlaceScopeHint(p),
      })),
      recommendation: `Replace bare key "${key}" with qualified keys such as ${exampleKeys} (or set explicit region / match_full_name_contains).`,
    });
  }

  return homonymousCollisions;
}

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
  for (let i = 0; i < people.length; i += 1) {
    const person = people[i];
    if (
      person.is_living ||
      person.full_name.trim() === 'Living' ||
      resolveEffectiveLiving(person, siteConfig.privacy)
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

  const homonymousCollisions = detectHomonymousPlaceCollisions(places, lexicon);

  const strictOk =
    livingLeaks.length === 0 &&
    peoplePartial.length === 0 &&
    peopleMissing.length === 0 &&
    missingPlaces.length === 0 &&
    homonymousCollisions.length === 0;
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
  };

  const rendered = options.json ? JSON.stringify(resultBody, null, 2) : formatAuditText(resultBody);
  return { ...resultBody, rendered };
}
