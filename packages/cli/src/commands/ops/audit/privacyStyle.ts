import {
  collectLivingNameHitsWithMatcher,
  compileLivingNameMatcher,
  computeSourceMaxYearById,
  extractLatestEdtfYear,
  type LivingNameTarget,
  NARRATIVE_POSTHUMOUS_HORIZON_YEARS,
  resolveNarrativeMaxYear,
} from '../living-name-matcher.js';
import {
  isPlainRecord,
  type LooseRecord,
  type PrivacyAndStyleCheckResult,
  type PrivacyScanDateContext,
  stringListField,
} from './types.js';

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const US_PHONE_RE =
  /(?<!\d)(?:\+1[-.\s]?)?(?:\(\d{3}\)[-.\s]?|\b[2-9]\d{2}[-.\s])[2-9]\d{2}[-.\s]\d{4}(?!\d)/g;
const EM_DASH_RE = /\u2014/g;

function collectStringsWithPath(
  value: unknown,
  prefix: string,
  maxYear: number | null,
  out: Array<{ path: string; text: string; maxYear: number | null }>
): void {
  if (typeof value === 'string') {
    out.push({ path: prefix, text: value, maxYear });
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectStringsWithPath(value[i], `${prefix}[${i}]`, maxYear, out);
    }
    return;
  }
  if (isPlainRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      collectStringsWithPath(v, prefix ? `${prefix}.${k}` : k, maxYear, out);
    }
  }
}

export function runPrivacyAndStyleScan(
  dossierText: string,
  patch: LooseRecord,
  livingPeople: readonly LooseRecord[],
  deceasedPeople: readonly LooseRecord[] = [],
  dateContext?: PrivacyScanDateContext
): PrivacyAndStyleCheckResult {
  const livingNameMatcher = compileLivingNameMatcher(livingPeople, deceasedPeople);
  const ssnHits: Array<{ location: string; match: string }> = [];
  const phoneHits: Array<{ location: string; match: string }> = [];
  const emDashHits: Array<{ location: string; count: number }> = [];

  const livingIds = new Set<string>();
  for (const person of livingPeople) {
    if (typeof person.id === 'string' && person.id) {
      livingIds.add(person.id);
    }
  }

  const allPeople = dateContext?.allPeople ?? [...livingPeople, ...deceasedPeople];
  const deathYearByPersonId = new Map<string, number | null>();
  for (const person of allPeople) {
    if (typeof person.id === 'string' && person.id) {
      deathYearByPersonId.set(person.id, extractLatestEdtfYear(person.death_edtf));
    }
  }

  const updates = isPlainRecord(patch.person_updates) ? patch.person_updates : {};
  const patchPersonId = typeof patch.person_id === 'string' ? patch.person_id : '';
  const targetPerson =
    dateContext?.targetPerson ??
    (patchPersonId ? (allPeople.find((person) => person.id === patchPersonId) ?? null) : null);
  const targetId = typeof targetPerson?.id === 'string' && targetPerson.id ? targetPerson.id : patchPersonId;
  const targetDeathYear = extractLatestEdtfYear(
    updates.death_edtf ?? updates.death_date ?? targetPerson?.death_edtf
  );
  if (targetId && targetDeathYear !== null) {
    deathYearByPersonId.set(targetId, targetDeathYear);
  }

  const targetIsLiving =
    (targetId !== '' && livingIds.has(targetId)) ||
    targetPerson?.is_living === true ||
    targetPerson?.living === true;
  const subjectMaxYear =
    !targetIsLiving && targetDeathYear !== null ? targetDeathYear + NARRATIVE_POSTHUMOUS_HORIZON_YEARS : null;

  const mergedEventsById = new Map<string, LooseRecord>();
  const anonymousPatchEvents: LooseRecord[] = [];
  for (const liveEvent of dateContext?.liveEvents ?? []) {
    if (typeof liveEvent.id === 'string' && liveEvent.id) {
      mergedEventsById.set(liveEvent.id, liveEvent);
    }
  }
  for (const rawId of Array.isArray(patch.remove_event_ids) ? patch.remove_event_ids : []) {
    if (typeof rawId === 'string' && rawId.trim()) {
      mergedEventsById.delete(rawId.trim());
    }
  }
  for (const rawEvent of Array.isArray(patch.events) ? patch.events : []) {
    if (!isPlainRecord(rawEvent)) {
      continue;
    }
    if (typeof rawEvent.id === 'string' && rawEvent.id) {
      mergedEventsById.set(rawEvent.id, rawEvent);
    } else {
      anonymousPatchEvents.push(rawEvent);
    }
  }

  const eventMaxYearById = new Map<string, number | null>();
  for (const [eventId, event] of mergedEventsById) {
    eventMaxYearById.set(eventId, extractLatestEdtfYear(event.edtf_date));
  }
  const sourceMaxYearById = computeSourceMaxYearById([...mergedEventsById.values(), ...anonymousPatchEvents]);

  const livingNameTargets: LivingNameTarget[] = [];

  const scanTarget = (label: string, text: string, maxYear: number | null, checkEmDash: boolean): void => {
    if (!text) {
      return;
    }
    livingNameTargets.push({ location: label, text, maxYear });
    for (const m of text.matchAll(SSN_RE)) {
      if (ssnHits.length < 25) {
        ssnHits.push({ location: label, match: m[0] });
      }
    }
    for (const m of text.matchAll(US_PHONE_RE)) {
      if (phoneHits.length < 25) {
        phoneHits.push({ location: label, match: m[0] });
      }
    }
    if (checkEmDash) {
      const count = (text.match(EM_DASH_RE) ?? []).length;
      if (count > 0) {
        emDashHits.push({ location: label, count });
      }
    }
  };

  if (dossierText) {
    scanTarget('dossier.md', dossierText, subjectMaxYear, true);
  }

  const patchStrings: Array<{ path: string; text: string; maxYear: number | null }> = [];
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'person_updates') {
      collectStringsWithPath(value, 'patch.person_updates', subjectMaxYear, patchStrings);
      continue;
    }
    if (key === 'people' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const rawPerson = value[i];
        let personMaxYear: number | null = null;
        if (isPlainRecord(rawPerson)) {
          const stagedId = typeof rawPerson.id === 'string' ? rawPerson.id.trim() : '';
          const stagedIsLiving =
            (stagedId !== '' && livingIds.has(stagedId)) ||
            rawPerson.is_living === true ||
            rawPerson.living === true;
          const stagedDeathYear =
            extractLatestEdtfYear(rawPerson.death_edtf) ??
            (stagedId ? (deathYearByPersonId.get(stagedId) ?? null) : null);
          if (!stagedIsLiving && stagedDeathYear !== null) {
            personMaxYear = stagedDeathYear + NARRATIVE_POSTHUMOUS_HORIZON_YEARS;
          }
        }
        collectStringsWithPath(rawPerson, `patch.people[${i}]`, personMaxYear, patchStrings);
      }
      continue;
    }
    if (key === 'events' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const rawEv = value[i];
        const eventMaxYear = isPlainRecord(rawEv) ? extractLatestEdtfYear(rawEv.edtf_date) : null;
        collectStringsWithPath(rawEv, `patch.events[${i}]`, eventMaxYear, patchStrings);
      }
      continue;
    }
    if (key === 'media' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const rawItem = value[i];
        let mediaMaxYear: number | null = null;
        if (isPlainRecord(rawItem)) {
          const linkedEventId =
            typeof rawItem.event_id === 'string' && rawItem.event_id ? rawItem.event_id : null;
          mediaMaxYear =
            extractLatestEdtfYear(rawItem.date_edtf) ??
            (linkedEventId ? (eventMaxYearById.get(linkedEventId) ?? null) : null);
        }
        collectStringsWithPath(rawItem, `patch.media[${i}]`, mediaMaxYear, patchStrings);
      }
      continue;
    }
    if (key === 'sources' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const rawSource = value[i];
        const sourceId = isPlainRecord(rawSource) && typeof rawSource.id === 'string' ? rawSource.id : '';
        const sourceMaxYear = sourceId ? (sourceMaxYearById.get(sourceId) ?? null) : null;
        collectStringsWithPath(rawSource, `patch.sources[${i}]`, sourceMaxYear, patchStrings);
      }
      continue;
    }
    if (key === 'narratives' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const rawNarrative = value[i];
        const narrativeMaxYear = isPlainRecord(rawNarrative)
          ? resolveNarrativeMaxYear({
              subjectPersonId:
                typeof rawNarrative.subject_person_id === 'string' ? rawNarrative.subject_person_id : null,
              personIds: stringListField(rawNarrative.person_ids),
              eventIds: stringListField(rawNarrative.event_ids),
              livingIds,
              deathYearByPersonId,
              eventMaxYearById,
            })
          : null;
        collectStringsWithPath(rawNarrative, `patch.narratives[${i}]`, narrativeMaxYear, patchStrings);
      }
      continue;
    }
    collectStringsWithPath(value, `patch.${key}`, null, patchStrings);
  }

  for (const item of patchStrings) {
    const isBioProse =
      item.path.endsWith('.body_md') || item.path.endsWith('.biography') || item.path.endsWith('.bio');
    scanTarget(item.path, item.text, item.maxYear, isBioProse);
  }

  const livingNameHits = collectLivingNameHitsWithMatcher(livingNameMatcher, livingNameTargets);

  const totalEmDashes = emDashHits.reduce((acc, row) => acc + row.count, 0);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (livingNameHits.length > 0) {
    errors.push(`Found ${livingNameHits.length} living-relative name mention(s).`);
  }
  if (ssnHits.length > 0) {
    errors.push(`Found ${ssnHits.length} SSN-like pattern(s).`);
  }
  if (phoneHits.length > 0) {
    errors.push(`Found ${phoneHits.length} US phone-number pattern(s).`);
  }
  if (totalEmDashes > 0) {
    warnings.push(`Found ${totalEmDashes} em-dash character(s) in biography prose.`);
  }

  return {
    ok: errors.length === 0,
    livingPeopleChecked: livingPeople.length,
    livingNameHits,
    ssnHits,
    phoneHits,
    emDashCount: totalEmDashes,
    emDashHits,
    errors,
    warnings,
  };
}
