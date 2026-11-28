import {
  findIpaGlyphsInPhonetic,
  getCurrentReferenceYear,
  type Place,
  type PrivacyConfig,
  type Pronunciation,
  PronunciationSchema,
  type RawPerson,
  resolveEffectiveLiving,
  resolvePersonPronunciation,
  resolvePlacePronunciation,
} from '@kinloom/core';
import type {
  KinloomAuditCheck,
  KinloomAuditCheckContext,
  KinloomCheckResult,
  KinloomVerifyCheck,
  KinloomVerifyCheckContext,
} from '../../plugins.js';
import { loadArchivePronunciationLexicon, runPronounceAuditCommand } from './shared/pronunciation/index.js';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function hasPronunciationValues(p: Pronunciation | null | undefined): boolean {
  if (!p) {
    return false;
  }
  if (p.phonetic?.trim() || p.ipa?.trim() || p.audio_url?.trim() || p.note?.trim()) {
    return true;
  }
  return Boolean(
    p.variants?.some(
      (v) =>
        Boolean(v.phonetic?.trim()) ||
        Boolean(v.ipa?.trim()) ||
        Boolean(v.audio_url?.trim()) ||
        Boolean(v.note?.trim())
    )
  );
}

function parseLoosePronunciation(raw: unknown): Pronunciation | null {
  if (!isPlainRecord(raw)) {
    return null;
  }
  const parsed = PronunciationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function collectIpaInPhoneticMessages(scopeLabel: string, pron: Pronunciation): string[] {
  const messages: string[] = [];
  const mainPhonetic = pron.phonetic?.trim() ?? '';
  if (mainPhonetic) {
    const glyphs = findIpaGlyphsInPhonetic(mainPhonetic);
    if (glyphs.length > 0) {
      messages.push(
        `Staged pronunciation on ${scopeLabel} Respelling '${mainPhonetic}' contains IPA symbol(s) (${glyphs.join(', ')}). Use plain English syllables in phonetic and put IPA in ipa.`
      );
    }
  }
  for (const variant of pron.variants ?? []) {
    const variantPhonetic = variant.phonetic?.trim() ?? '';
    if (!variantPhonetic) {
      continue;
    }
    const glyphs = findIpaGlyphsInPhonetic(variantPhonetic);
    if (glyphs.length > 0) {
      messages.push(
        `Staged pronunciation variant '${variant.label}' on ${scopeLabel} Respelling '${variantPhonetic}' contains IPA symbol(s) (${glyphs.join(', ')}). Use plain English syllables in phonetic and put IPA in ipa.`
      );
    }
  }
  return messages;
}

function toLooseRawPerson(rec: Readonly<Record<string, unknown>>): RawPerson {
  const fullName = asString(rec['full_name']).trim();
  const givenNames = asString(rec['given_names']).trim();
  const surname = asString(rec['surname']).trim();
  const pronunciation = parseLoosePronunciation(rec['pronunciation']);
  const rawSex = asString(rec['sex']).trim();
  const sex: RawPerson['sex'] = rawSex === 'M' || rawSex === 'F' || rawSex === 'U' ? rawSex : 'U';
  return {
    id: asString(rec['id']).trim(),
    slug: asString(rec['slug']).trim() || asString(rec['id']).trim(),
    full_name: fullName || [givenNames, surname].filter(Boolean).join(' ').trim(),
    given_name: asString(rec['given_name']).trim() || givenNames,
    surname,
    alt_names: [],
    sex,
    birth_edtf: asString(rec['birth_edtf']).trim(),
    death_edtf: asString(rec['death_edtf']).trim(),
    is_living: rec['is_living'] === true || rec['living'] === true,
    lineage_group: asString(rec['lineage_group']).trim() || 'unknown',
    portrait_url: null,
    ...(pronunciation ? { pronunciation } : {}),
  };
}

function parseLoosePlaceType(value: unknown): Place['place_type'] {
  if (
    value === 'country' ||
    value === 'state' ||
    value === 'county' ||
    value === 'town' ||
    value === 'homestead'
  ) {
    return value;
  }
  return 'town';
}

function toLoosePlace(rec: Readonly<Record<string, unknown>>): Place {
  const pronunciation = parseLoosePronunciation(rec['pronunciation']);
  return {
    id: asString(rec['id']).trim(),
    slug: asString(rec['slug']).trim() || asString(rec['id']).trim(),
    name: asString(rec['name']).trim(),
    full_name: asString(rec['full_name']).trim() || asString(rec['name']).trim(),
    lat: Number(rec['lat'] ?? 0),
    lng: Number(rec['lng'] ?? rec['lon'] ?? 0),
    place_type: parseLoosePlaceType(rec['place_type']),
    parent_id: null,
    ...(pronunciation ? { pronunciation } : {}),
  };
}

function isEffectiveLivingRecord(
  rec: Readonly<Record<string, unknown>>,
  privacy: Partial<PrivacyConfig>
): boolean {
  if (rec['is_living'] === true || rec['living'] === true) {
    return true;
  }
  const fullName = asString(rec['full_name']).trim();
  if (fullName === 'Living') {
    return true;
  }
  return resolveEffectiveLiving(
    {
      is_living: false,
      birth_edtf: asString(rec['birth_edtf']).trim(),
      death_edtf: asString(rec['death_edtf']).trim(),
    },
    privacy,
    privacy.referenceYear ?? getCurrentReferenceYear()
  );
}

export function runPronunciationAuditCheck(ctx: KinloomAuditCheckContext): KinloomCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const strictFailures: string[] = [];

  const privacy: Partial<PrivacyConfig> = ctx.siteConfig?.privacy ?? {};
  const lexicon = loadArchivePronunciationLexicon(ctx.repoDir, ctx.siteConfig?.pronunciations);
  const personUpdates = isPlainRecord(ctx.patch['person_updates']) ? ctx.patch['person_updates'] : null;

  const liveTarget = ctx.livePeople.find((p) => asString(p['id']).trim() === ctx.personId) ?? null;
  const liveTargetHadPron = liveTarget
    ? hasPronunciationValues(parseLoosePronunciation(liveTarget['pronunciation']))
    : false;

  let deletedLivePronunciation = false;
  if (
    liveTargetHadPron &&
    personUpdates &&
    Object.hasOwn(personUpdates, 'pronunciation') &&
    !hasPronunciationValues(parseLoosePronunciation(personUpdates['pronunciation']))
  ) {
    deletedLivePronunciation = true;
    const msg = `person_updates removes existing live pronunciation on '${ctx.personId}'`;
    warnings.push(msg);
    strictFailures.push(msg);
  }

  // Merge target person with person_updates so we check the post-integration target state.
  const evaluatedPeople = new Map<string, Readonly<Record<string, unknown>>>();
  if (ctx.targetPerson) {
    const mergedTarget = personUpdates ? { ...ctx.targetPerson, ...personUpdates } : ctx.targetPerson;
    evaluatedPeople.set(ctx.personId, mergedTarget);
  } else if (personUpdates) {
    evaluatedPeople.set(ctx.personId, { id: ctx.personId, ...personUpdates });
  }

  for (const rawStaged of Array.isArray(ctx.patch['people']) ? ctx.patch['people'] : []) {
    if (!isPlainRecord(rawStaged)) {
      continue;
    }
    const id = asString(rawStaged['id']).trim();
    if (!id) {
      continue;
    }
    const existing = evaluatedPeople.get(id);
    evaluatedPeople.set(id, existing ? { ...existing, ...rawStaged } : rawStaged);
  }

  let livingLeaks = 0;
  const missingPeople: string[] = [];
  const partialPeople: string[] = [];
  const unsourcedEntries: string[] = [];
  const ipaInPhoneticEntries: string[] = [];

  for (const [id, rec] of evaluatedPeople.entries()) {
    const explicitPron = parseLoosePronunciation(rec['pronunciation']);
    const isLiving = isEffectiveLivingRecord(rec, privacy);

    if (isLiving) {
      if (hasPronunciationValues(explicitPron)) {
        livingLeaks += 1;
        errors.push(
          'Living person record in staged patch contains a pronunciation entry (redacted for privacy).'
        );
      }
      continue;
    }

    if (explicitPron && hasPronunciationValues(explicitPron)) {
      const hasProvenance = Boolean(explicitPron.source_url?.trim() || explicitPron.source_label?.trim());
      if (!hasProvenance) {
        unsourcedEntries.push(`person:${id}`);
        const msg = `Staged pronunciation on person '${id}' is missing provenance (source_url or source_label).`;
        warnings.push(msg);
        strictFailures.push(msg);
      }
      const ipaMessages = collectIpaInPhoneticMessages(`person '${id}'`, explicitPron);
      for (const msg of ipaMessages) {
        ipaInPhoneticEntries.push(`person:${id}`);
        warnings.push(msg);
        strictFailures.push(msg);
      }
    }

    const person = toLooseRawPerson(rec);
    const resolved = resolvePersonPronunciation(person, lexicon);
    if (!resolved || !hasPronunciationValues(resolved)) {
      missingPeople.push(id);
      const msg = `Deceased person '${person.full_name || id}' (${id}) has no pronunciation coverage.`;
      warnings.push(msg);
      strictFailures.push(msg);
    } else if (resolved.coverage !== 'full') {
      partialPeople.push(id);
      const missingParts = resolved.missingParts?.length
        ? ` (missing: ${resolved.missingParts.join(', ')})`
        : '';
      const msg = `Deceased person '${person.full_name || id}' (${id}) has only partial pronunciation coverage${missingParts}.`;
      warnings.push(msg);
      strictFailures.push(msg);
    }
  }

  const missingPlaces: string[] = [];
  for (const rawPlace of Array.isArray(ctx.patch['places']) ? ctx.patch['places'] : []) {
    if (!isPlainRecord(rawPlace)) {
      continue;
    }
    const place = toLoosePlace(rawPlace);
    if (!place.id && !place.name) {
      continue;
    }
    if (place.pronunciation && hasPronunciationValues(place.pronunciation)) {
      const hasProvenance = Boolean(
        place.pronunciation.source_url?.trim() || place.pronunciation.source_label?.trim()
      );
      if (!hasProvenance) {
        unsourcedEntries.push(`place:${place.id || place.name}`);
        const msg = `Staged pronunciation on place '${place.full_name || place.id}' is missing provenance (source_url or source_label).`;
        warnings.push(msg);
        strictFailures.push(msg);
      }
      const ipaMessages = collectIpaInPhoneticMessages(
        `place '${place.full_name || place.id}'`,
        place.pronunciation
      );
      for (const msg of ipaMessages) {
        ipaInPhoneticEntries.push(`place:${place.id || place.name}`);
        warnings.push(msg);
        strictFailures.push(msg);
      }
    }
    const resolved = resolvePlacePronunciation(place, lexicon);
    if (!resolved || !hasPronunciationValues(resolved)) {
      missingPlaces.push(place.id || place.name);
      const msg = `Staged place '${place.full_name || place.id}' (${place.id || place.name}) has no pronunciation coverage.`;
      warnings.push(msg);
      strictFailures.push(msg);
    }
  }

  return {
    errors,
    warnings,
    strictFailures,
    details: {
      livingLeaks,
      missingPeople,
      partialPeople,
      missingPlaces,
      unsourcedEntries,
      ipaInPhoneticEntries,
      deletedLivePronunciation,
    },
  };
}

export function createPronunciationAuditCheck(): KinloomAuditCheck {
  return {
    id: 'pronunciation',
    name: 'Pronunciation',
    run: runPronunciationAuditCheck,
  };
}

export function runPronunciationVerifyCheck(ctx: KinloomVerifyCheckContext): KinloomCheckResult {
  const hasPreloadedEntities = ctx.people.length > 0 || ctx.places.length > 0;
  const audit = runPronounceAuditCommand({
    repoDir: ctx.repoDir,
    ...(hasPreloadedEntities
      ? {
          preloaded: {
            siteConfig: ctx.siteConfig,
            people: ctx.people,
            places: ctx.places,
          },
        }
      : {}),
  });

  const errors: string[] = audit.living_leaks.map((leak) => `${leak.location}: ${leak.reason}`);
  const warnings: string[] = [];
  const strictFailures: string[] = [];

  for (const gap of audit.coverage_gaps.people_missing) {
    const msg = `Deceased person '${gap.full_name}' (${gap.id}) is missing pronunciation coverage.`;
    warnings.push(msg);
    strictFailures.push(msg);
  }
  for (const gap of audit.coverage_gaps.people_partial) {
    const missing = gap.missing_parts.length > 0 ? ` (missing: ${gap.missing_parts.join(', ')})` : '';
    const msg = `Deceased person '${gap.full_name}' (${gap.id}) has partial pronunciation coverage${missing}.`;
    warnings.push(msg);
    strictFailures.push(msg);
  }
  for (const gap of audit.coverage_gaps.places) {
    const msg = `Place '${gap.full_name}' (${gap.id}) is missing pronunciation coverage (${gap.reason}).`;
    warnings.push(msg);
    strictFailures.push(msg);
  }
  for (const u of audit.unsourced_entries) {
    const msg = `Unsourced pronunciation [${u.scope}] ${u.label}.`;
    warnings.push(msg);
    strictFailures.push(msg);
  }
  for (const c of audit.homonymous_place_collisions) {
    const msg = `Homonymous bare lexicon key '${c.lexicon_key}' matches multiple places.`;
    warnings.push(msg);
    strictFailures.push(msg);
  }
  for (const q of audit.ipa_quality_warnings) {
    const msg = `IPA quality [${q.scope}:${q.key}] ${q.message}`;
    warnings.push(msg);
    strictFailures.push(msg);
  }

  return {
    errors,
    warnings,
    strictFailures,
    details: {
      summary: audit.summary,
    },
  };
}

export function createPronunciationVerifyCheck(): KinloomVerifyCheck {
  return {
    id: 'pronunciation',
    name: 'Pronunciation',
    run: runPronunciationVerifyCheck,
  };
}
