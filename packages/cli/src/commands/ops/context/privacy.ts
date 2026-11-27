import {
  collectLivingNames,
  compileLivingNamePattern,
  edtfYear,
  type PrivacyConfig,
  resolveEffectiveLiving,
} from '@kinloom/core';
import { type LivingPrivacyState, type LooseYamlRecord, REDACTED_RELATIVE_LABEL } from './types.js';
import { asNonEmptyString, extractNumericXref, extractYamlBlockId, isPlainRecord } from './yamlScanner.js';

export function scrubText(value: string, livingNamePattern: RegExp | null): string {
  if (!value || !livingNamePattern) {
    return value;
  }
  return value.replaceAll(livingNamePattern, REDACTED_RELATIVE_LABEL);
}

export function scrubDeep<T>(value: T, livingNamePattern: RegExp | null): T {
  if (!livingNamePattern) {
    return value;
  }
  if (typeof value === 'string') {
    return value.replaceAll(livingNamePattern, REDACTED_RELATIVE_LABEL) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubDeep(item, livingNamePattern)) as T;
  }
  if (isPlainRecord(value)) {
    const out: LooseYamlRecord = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubDeep(v, livingNamePattern);
    }
    return out as T;
  }
  return value;
}

export function isEffectiveLivingRecord(
  person: LooseYamlRecord,
  personEvents: readonly { edtf_date?: unknown }[],
  privacy: Partial<PrivacyConfig>
): boolean {
  if (person.is_living === true || person.living === true) {
    return true;
  }
  const birthEdtf = asNonEmptyString(person.birth_edtf);
  const deathEdtf = asNonEmptyString(person.death_edtf);
  if (
    resolveEffectiveLiving(
      {
        is_living: Boolean(person.is_living),
        birth_edtf: birthEdtf,
        death_edtf: deathEdtf,
      },
      privacy
    )
  ) {
    return true;
  }
  if (deathEdtf.length > 0) {
    return false;
  }
  const years = personEvents
    .map((ev) =>
      edtfYear(typeof ev.edtf_date === 'string' || typeof ev.edtf_date === 'number' ? ev.edtf_date : null)
    )
    .filter((yr): yr is number => yr !== null);
  if (years.length > 0) {
    const earliest = Math.min(...years);
    const refYear = privacy.referenceYear ?? new Date().getUTCFullYear();
    const cutoffYears = privacy.livingCutoffYears ?? 101;
    if (earliest > refYear - cutoffYears) {
      return true;
    }
  }
  return false;
}

export function isConfirmedDeceasedRelative(
  person: LooseYamlRecord | undefined,
  livingIds: ReadonlySet<string>,
  privacy: Partial<PrivacyConfig>
): person is LooseYamlRecord {
  if (!person || typeof person.id !== 'string' || livingIds.has(person.id)) {
    return false;
  }
  if (person.is_living === true || person.living === true) {
    return false;
  }
  const birthEdtf = asNonEmptyString(person.birth_edtf);
  const deathEdtf = asNonEmptyString(person.death_edtf);
  if (
    resolveEffectiveLiving(
      {
        is_living: false,
        birth_edtf: birthEdtf,
        death_edtf: deathEdtf,
      },
      privacy
    )
  ) {
    return false;
  }
  if (deathEdtf.length > 0) {
    return true;
  }
  const birthYear = edtfYear(birthEdtf);
  const refYear = privacy.referenceYear ?? new Date().getUTCFullYear();
  const cutoffYears = privacy.livingCutoffYears ?? 101;
  return birthYear !== null && birthYear <= refYear - cutoffYears;
}

export function selectPeopleBlocksForContext(
  peopleBlocks: readonly string[],
  personId: string,
  relativeIdSet: ReadonlySet<string>
): string[] {
  return peopleBlocks.filter((block) => {
    const id = extractYamlBlockId(block);
    if (id === personId || (id && relativeIdSet.has(id))) {
      return true;
    }
    if (/\b(?:is_living|living):\s*true\b/.test(block)) {
      return true;
    }
    const deathMatch = /^\s+death_edtf:\s*(.*)$/m.exec(block);
    const deathVal = deathMatch ? deathMatch[1].trim().replaceAll(/^["']|["']$/g, '') : '';
    return deathVal.length === 0 || deathVal === 'null' || deathVal === '~';
  });
}

export function buildLivingPrivacyState(params: {
  parsedPeople: readonly LooseYamlRecord[];
  personId: string;
  rawPersonEvents: readonly LooseYamlRecord[];
  unknownYearEventsByPerson: ReadonlyMap<string, ReadonlyArray<{ edtf_date: string }>>;
  privacy: Partial<PrivacyConfig>;
}): LivingPrivacyState {
  const livingIds = new Set<string>();
  const livingAncestryPids = new Set<string>();
  const livingPeopleForNames: Array<{ is_living: boolean; full_name: string; alt_names: string[] }> = [];

  for (const person of params.parsedPeople) {
    if (typeof person.id !== 'string') {
      continue;
    }
    const personEvents =
      person.id === params.personId
        ? params.rawPersonEvents
        : (params.unknownYearEventsByPerson.get(person.id) ?? []);
    if (isEffectiveLivingRecord(person, personEvents, params.privacy)) {
      livingIds.add(person.id);
      const numericId = extractNumericXref(person.gedcom_xref);
      if (numericId) {
        livingAncestryPids.add(numericId);
      }
      livingPeopleForNames.push({
        is_living: true,
        full_name: asNonEmptyString(person.full_name),
        alt_names: Array.isArray(person.alt_names)
          ? person.alt_names.filter((n): n is string => typeof n === 'string')
          : [],
      });
    }
  }

  const livingNamePattern = compileLivingNamePattern(collectLivingNames(livingPeopleForNames));
  return {
    livingIds,
    livingAncestryPids,
    livingNamePattern,
    privacy: params.privacy,
  };
}
