import path from 'node:path';
import {
  getCurrentReferenceYear,
  type PrivacyConfig,
  type RawPerson,
  RawPersonSchema,
  resolveEffectiveLiving,
} from '@kinloom/core';
import { CliValidationError } from '../../../../errors.js';
import { parseValidDeathEdtf } from '../stagedPackages.js';
import { canonicalJsonStringify, dedupeStrings, isPlainObject } from './primitives.js';
import { type NormalizedPatch, SAFE_PERSON_ID_RE, SAFE_SLUG_RE, type UpsertCounts } from './types.js';

export const ALLOWED_PERSON_UPDATE_KEYS = new Set([
  'id',
  'slug',
  'gedcom_xref',
  'full_name',
  'given_name',
  'surname',
  'alt_names',
  'sex',
  'is_living',
  'living',
  'lineage_group',
  'branch',
  'birth_edtf',
  'death_edtf',
  'birth_date',
  'death_date',
  'portrait_url',
  'thumb_url',
  'pronunciation',
  'has_primary_source',
  'extensions',
  'bio',
  'biography',
  'summary',
  'research_notes',
  'sources',
]);

function dedupeExtensionSources(
  existing: readonly unknown[] | undefined,
  additions: readonly unknown[] | undefined
): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const keyFor = (entry: unknown): string => {
    if (typeof entry === 'string') {
      return `str:${entry.trim()}`;
    }
    if (isPlainObject(entry) && typeof entry['source_id'] === 'string') {
      return `sid:${entry['source_id']}`;
    }
    return `json:${JSON.stringify(entry)}`;
  };
  for (const entry of [...(existing ?? []), ...(additions ?? [])]) {
    if (entry === null || entry === undefined) {
      continue;
    }
    const key = keyFor(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(structuredClone(entry));
  }
  return out;
}

export { parseValidDeathEdtf };

function resolveValidDeathEdtfUpdate(updates: Record<string, unknown> | null): string | null {
  if (!updates) {
    return null;
  }
  if (
    updates['death_edtf'] !== undefined &&
    updates['death_date'] !== undefined &&
    String(updates['death_edtf']) !== String(updates['death_date'])
  ) {
    throw new Error('person_updates has conflicting death_edtf and death_date.');
  }
  const raw = updates['death_edtf'] !== undefined ? updates['death_edtf'] : updates['death_date'];
  return parseValidDeathEdtf(raw);
}

function mergePersonUpdates(
  existingPerson: RawPerson,
  updates: Record<string, unknown> | null,
  privacyConfig: Partial<PrivacyConfig>
): { updated: RawPerson; changed: boolean } {
  if (!updates || Object.keys(updates).length === 0) {
    return { updated: existingPerson, changed: false };
  }

  if (updates['id'] !== undefined && updates['id'] !== existingPerson.id) {
    throw new Error(
      `person_updates cannot change person id from '${existingPerson.id}' to '${String(updates['id'])}'.`
    );
  }
  if (updates['is_living'] === true || updates['living'] === true) {
    throw new Error(`person_updates cannot mark target '${existingPerson.id}' as living.`);
  }
  if (
    updates['birth_edtf'] !== undefined &&
    updates['birth_date'] !== undefined &&
    String(updates['birth_edtf']) !== String(updates['birth_date'])
  ) {
    throw new Error('person_updates has conflicting birth_edtf and birth_date.');
  }
  if (
    updates['death_edtf'] !== undefined &&
    updates['death_date'] !== undefined &&
    String(updates['death_edtf']) !== String(updates['death_date'])
  ) {
    throw new Error('person_updates has conflicting death_edtf and death_date.');
  }
  if (
    updates['bio'] !== undefined &&
    updates['biography'] !== undefined &&
    String(updates['bio']) !== String(updates['biography'])
  ) {
    throw new Error('person_updates has conflicting bio and biography.');
  }

  const next: Record<string, unknown> = structuredClone(existingPerson);
  const directFields = [
    'slug',
    'gedcom_xref',
    'full_name',
    'given_name',
    'surname',
    'sex',
    'lineage_group',
    'branch',
    'portrait_url',
    'thumb_url',
    'pronunciation',
    'has_primary_source',
  ] as const;

  for (const field of directFields) {
    if (updates[field] !== undefined) {
      next[field] = structuredClone(updates[field]);
    }
  }

  const birthVal = updates['birth_edtf'] !== undefined ? updates['birth_edtf'] : updates['birth_date'];
  if (birthVal !== undefined) {
    next['birth_edtf'] = birthVal === null ? '' : String(birthVal);
  }
  const deathVal = updates['death_edtf'] !== undefined ? updates['death_edtf'] : updates['death_date'];
  if (deathVal !== undefined) {
    next['death_edtf'] = deathVal === null ? '' : String(deathVal);
  }

  if (updates['alt_names'] !== undefined) {
    if (!Array.isArray(updates['alt_names'])) {
      throw new Error('person_updates.alt_names must be an array of strings.');
    }
    next['alt_names'] = dedupeStrings(existingPerson.alt_names, updates['alt_names']);
  }

  const existingExt: Record<string, unknown> = isPlainObject(existingPerson.extensions)
    ? structuredClone(existingPerson.extensions)
    : {};
  let extTouched = false;

  if (updates['extensions'] !== undefined) {
    if (!isPlainObject(updates['extensions'])) {
      throw new Error('person_updates.extensions must be an object.');
    }
    for (const [k, v] of Object.entries(updates['extensions'])) {
      if (k === 'sources' && Array.isArray(v)) {
        existingExt['sources'] = dedupeExtensionSources(
          Array.isArray(existingExt['sources']) ? existingExt['sources'] : [],
          v
        );
      } else {
        existingExt[k] = structuredClone(v);
      }
    }
    extTouched = true;
  }

  const bioVal = updates['biography'] !== undefined ? updates['biography'] : updates['bio'];
  if (bioVal !== undefined) {
    existingExt['biography'] = String(bioVal);
    extTouched = true;
  }
  if (updates['summary'] !== undefined) {
    existingExt['summary'] = String(updates['summary']);
    extTouched = true;
  }
  if (updates['research_notes'] !== undefined) {
    existingExt['research_notes'] = String(updates['research_notes']);
    extTouched = true;
  }
  if (updates['sources'] !== undefined) {
    if (!Array.isArray(updates['sources'])) {
      throw new Error('person_updates.sources must be an array.');
    }
    existingExt['sources'] = dedupeExtensionSources(
      Array.isArray(existingExt['sources']) ? existingExt['sources'] : [],
      updates['sources']
    );
    extTouched = true;
  }

  if (extTouched) {
    next['extensions'] = existingExt;
  }

  const parsed = RawPersonSchema.parse(next);
  if (
    resolveEffectiveLiving(parsed, privacyConfig, privacyConfig.referenceYear ?? getCurrentReferenceYear())
  ) {
    throw new Error(`Refusing update: merged person '${parsed.id}' resolves as living under privacy rules.`);
  }

  const changed = JSON.stringify(existingPerson) !== JSON.stringify(parsed);
  return { updated: parsed, changed };
}

function assertPersonAllowedForPatch(
  person: RawPerson,
  label: string,
  privacyConfig: Partial<PrivacyConfig>
): void {
  if (person.full_name.trim().length === 0) {
    throw new CliValidationError(`${label} ('${person.id}') must have a non-empty full_name.`);
  }
  if (!SAFE_SLUG_RE.test(person.slug)) {
    throw new CliValidationError(
      `${label} ('${person.id}') has invalid slug '${person.slug}'. Use lowercase ASCII letters, digits, hyphens, or underscores.`
    );
  }
  if (
    person.is_living ||
    resolveEffectiveLiving(person, privacyConfig, privacyConfig.referenceYear ?? getCurrentReferenceYear())
  ) {
    throw new CliValidationError(
      `PRIVACY REFUSAL: ${label} ('${person.id}') resolves as living under archive privacy rules (birth_edtf='${person.birth_edtf}', death_edtf='${person.death_edtf}').`
    );
  }
}

function mergeStagedPersonWithExisting(
  existing: RawPerson,
  rawObj: Record<string, unknown>,
  parsedIncoming: RawPerson,
  label: string,
  privacyConfig: Partial<PrivacyConfig>
): RawPerson {
  const next: Record<string, unknown> = structuredClone(existing);
  const directFields = [
    'slug',
    'gedcom_xref',
    'full_name',
    'given_name',
    'surname',
    'sex',
    'is_living',
    'lineage_group',
    'branch',
    'birth_edtf',
    'death_edtf',
    'portrait_url',
    'thumb_url',
    'pronunciation',
    'has_primary_source',
  ] as const;

  for (const field of directFields) {
    if (Object.hasOwn(rawObj, field) && rawObj[field] !== undefined) {
      next[field] = structuredClone(parsedIncoming[field]);
    }
  }

  if (Object.hasOwn(rawObj, 'alt_names') && rawObj['alt_names'] !== undefined) {
    next['alt_names'] = dedupeStrings(existing.alt_names, parsedIncoming.alt_names);
  }

  if (Object.hasOwn(rawObj, 'extensions') && rawObj['extensions'] !== undefined) {
    const existingExt: Record<string, unknown> = isPlainObject(existing.extensions)
      ? structuredClone(existing.extensions)
      : {};
    for (const [k, v] of Object.entries(parsedIncoming.extensions ?? {})) {
      if (k === 'sources' && Array.isArray(v)) {
        existingExt['sources'] = dedupeExtensionSources(
          Array.isArray(existingExt['sources']) ? existingExt['sources'] : [],
          v
        );
      } else {
        existingExt[k] = structuredClone(v);
      }
    }
    next['extensions'] = existingExt;
  }

  const parsedMerged = RawPersonSchema.parse(next);
  assertPersonAllowedForPatch(parsedMerged, label, privacyConfig);
  return parsedMerged;
}

function upsertPatchPeople(
  existingPeople: readonly RawPerson[],
  incomingPeople: readonly unknown[],
  privacyConfig: Partial<PrivacyConfig>
): {
  items: RawPerson[];
  idxById: Map<string, number>;
  slugToId: Map<string, string>;
  counts: UpsertCounts;
} {
  const items = [...existingPeople];
  const idxById = new Map<string, number>();
  const slugToId = new Map<string, string>();
  for (let i = 0; i < items.length; i += 1) {
    const person = items[i];
    idxById.set(person.id, i);
    slugToId.set(person.slug, person.id);
  }

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const seenPatchIds = new Set<string>();

  for (let i = 0; i < incomingPeople.length; i += 1) {
    const label = `patch.people[${i}]`;
    const raw = incomingPeople[i];
    if (!isPlainObject(raw)) {
      throw new CliValidationError(`${label} must be a JSON object.`);
    }
    if (raw['is_living'] === true || raw['living'] === true) {
      throw new CliValidationError(
        `PRIVACY REFUSAL: ${label} ('${String(raw['id'] ?? 'unknown')}') cannot insert or mark a person as living.`
      );
    }
    if (typeof raw['id'] !== 'string' || !SAFE_PERSON_ID_RE.test(raw['id']) || raw['id'] !== raw['id'].trim()) {
      throw new CliValidationError(
        `${label} has invalid id '${String(raw['id'])}'. Only ASCII letters, digits, _, and - are allowed.`
      );
    }
    if (seenPatchIds.has(raw['id'])) {
      throw new CliValidationError(`Duplicate person id '${raw['id']}' in patch.people.`);
    }
    seenPatchIds.add(raw['id']);

    const parsedResult = RawPersonSchema.safeParse(raw);
    if (!parsedResult.success) {
      const detail = parsedResult.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ');
      throw new CliValidationError(`Invalid person in ${label}: ${detail}`);
    }
    const parsed = parsedResult.data;
    assertPersonAllowedForPatch(parsed, label, privacyConfig);

    const existingIdx = idxById.get(parsed.id);
    if (existingIdx === undefined) {
      const slugOwner = slugToId.get(parsed.slug);
      if (slugOwner !== undefined && slugOwner !== parsed.id) {
        throw new CliValidationError(
          `Slug collision: ${label} ('${parsed.id}') reuses slug '${parsed.slug}' already owned by '${slugOwner}'.`
        );
      }
      idxById.set(parsed.id, items.length);
      slugToId.set(parsed.slug, parsed.id);
      items.push(parsed);
      added += 1;
      continue;
    }

    const existing = items[existingIdx];
    if (
      existing.is_living ||
      resolveEffectiveLiving(
        existing,
        privacyConfig,
        privacyConfig.referenceYear ?? getCurrentReferenceYear()
      )
    ) {
      throw new CliValidationError(
        `PRIVACY REFUSAL: ${label} cannot modify existing living person '${existing.id}'.`
      );
    }
    const merged = mergeStagedPersonWithExisting(existing, raw, parsed, label, privacyConfig);
    const slugOwner = slugToId.get(merged.slug);
    if (slugOwner !== undefined && slugOwner !== merged.id) {
      throw new CliValidationError(
        `Slug collision: ${label} ('${merged.id}') reuses slug '${merged.slug}' already owned by '${slugOwner}'.`
      );
    }
    if (canonicalJsonStringify(existing) === canonicalJsonStringify(merged)) {
      unchanged += 1;
    } else {
      if (existing.slug !== merged.slug && slugToId.get(existing.slug) === existing.id) {
        slugToId.delete(existing.slug);
      }
      slugToId.set(merged.slug, merged.id);
      items[existingIdx] = merged;
      updated += 1;
    }
  }

  return { items, idxById, slugToId, counts: { added, updated, unchanged } };
}

export function applyPeoplePatch(
  existingPeople: readonly RawPerson[],
  patch: Pick<NormalizedPatch, 'people' | 'person_updates'>,
  personId: string,
  dataDir: string,
  privacyConfig: Partial<PrivacyConfig>
): {
  mergedPeople: RawPerson[];
  personUpdated: boolean;
  peopleCounts: UpsertCounts;
  peopleById: Map<string, RawPerson>;
  livingIds: Set<string>;
} {
  const peopleMerge = upsertPatchPeople(existingPeople, patch.people, privacyConfig);
  const mergedPeople = peopleMerge.items;

  const targetIdx = peopleMerge.idxById.get(personId);
  if (targetIdx === undefined) {
    throw new Error(
      `Target person '${personId}' does not exist in ${path.join(dataDir, 'people.yaml')} or patch.people.`
    );
  }
  const targetPerson = mergedPeople[targetIdx];
  if (targetPerson.is_living) {
    throw new Error(
      `PRIVACY REFUSAL: Target person '${personId}' resolves as living. Living people cannot be researched or patched.`
    );
  }
  const updatedDeathEdtf = resolveValidDeathEdtfUpdate(patch.person_updates);
  const referenceYear = privacyConfig.referenceYear ?? getCurrentReferenceYear();
  const candidateTargetPerson =
    updatedDeathEdtf !== null ? { ...targetPerson, death_edtf: updatedDeathEdtf } : targetPerson;
  if (resolveEffectiveLiving(candidateTargetPerson, privacyConfig, referenceYear)) {
    throw new Error(
      `PRIVACY REFUSAL: Target person '${personId}' resolves as living. Living people cannot be researched or patched.`
    );
  }

  const personMerge = mergePersonUpdates(targetPerson, patch.person_updates, privacyConfig);
  if (personMerge.updated.slug !== targetPerson.slug) {
    if (!SAFE_SLUG_RE.test(personMerge.updated.slug)) {
      throw new CliValidationError(
        `person_updates ('${personId}') has invalid slug '${personMerge.updated.slug}'.`
      );
    }
    const slugOwner = peopleMerge.slugToId.get(personMerge.updated.slug);
    if (slugOwner !== undefined && slugOwner !== personId) {
      throw new CliValidationError(
        `Slug collision: person_updates ('${personId}') reuses slug '${personMerge.updated.slug}' already owned by '${slugOwner}'.`
      );
    }
    if (peopleMerge.slugToId.get(targetPerson.slug) === personId) {
      peopleMerge.slugToId.delete(targetPerson.slug);
    }
    peopleMerge.slugToId.set(personMerge.updated.slug, personId);
  }
  mergedPeople[targetIdx] = personMerge.updated;

  const peopleById = new Map<string, RawPerson>();
  const livingIds = new Set<string>();
  for (let i = 0; i < mergedPeople.length; i += 1) {
    const p = mergedPeople[i];
    peopleById.set(p.id, p);
    if (p.is_living || resolveEffectiveLiving(p, privacyConfig, referenceYear)) {
      livingIds.add(p.id);
    }
  }

  return {
    mergedPeople,
    personUpdated: personMerge.changed,
    peopleCounts: peopleMerge.counts,
    peopleById,
    livingIds,
  };
}
