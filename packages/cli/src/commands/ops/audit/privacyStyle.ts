import {
  collectLivingNameHitsWithMatcher,
  compileLivingNameMatcher,
  extractLatestEdtfYear,
  type LivingNameTarget,
  NARRATIVE_POSTHUMOUS_HORIZON_YEARS,
  resolveNarrativeMaxYear,
} from '@kinloom/core';
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
  const livingNameMatcher =
    livingPeople.length > 0 ? compileLivingNameMatcher(livingPeople, deceasedPeople) : null;
  const ssnHits: Array<{ location: string; match: string }> = [];
  const phoneHits: Array<{ location: string; match: string }> = [];
  const emDashHits: Array<{ location: string; count: number }> = [];

  const livingIds = new Set<string>();
  for (let i = 0; i < livingPeople.length; i += 1) {
    const person = livingPeople[i];
    if (person === undefined) continue;
    if (typeof person['id'] === 'string' && person['id']) {
      livingIds.add(person['id']);
    }
  }

  const allPeople = dateContext?.allPeople ?? [...livingPeople, ...deceasedPeople];
  const deathYearByPersonId = new Map<string, number | null>();
  if (livingPeople.length > 0) {
    for (let i = 0; i < allPeople.length; i += 1) {
      const person = allPeople[i];
      if (person === undefined) continue;
      if (typeof person['id'] === 'string' && person['id']) {
        deathYearByPersonId.set(person['id'], extractLatestEdtfYear(person['death_edtf']));
      }
    }
  }

  const updates = isPlainRecord(patch['person_updates']) ? patch['person_updates'] : {};
  const patchPersonId = typeof patch['person_id'] === 'string' ? patch['person_id'] : '';
  const targetPerson =
    dateContext?.targetPerson ??
    (patchPersonId ? (allPeople.find((person) => person['id'] === patchPersonId) ?? null) : null);
  const targetId =
    typeof targetPerson?.['id'] === 'string' && targetPerson['id'] ? targetPerson['id'] : patchPersonId;
  const targetDeathYear = extractLatestEdtfYear(
    updates['death_edtf'] ?? updates['death_date'] ?? targetPerson?.['death_edtf']
  );
  if (targetId && targetDeathYear !== null) {
    deathYearByPersonId.set(targetId, targetDeathYear);
  }

  const targetIsLiving =
    (targetId !== '' && livingIds.has(targetId)) ||
    targetPerson?.['is_living'] === true ||
    targetPerson?.['living'] === true;
  const subjectMaxYear =
    !targetIsLiving && targetDeathYear !== null ? targetDeathYear + NARRATIVE_POSTHUMOUS_HORIZON_YEARS : null;

  const removedEventIds = new Set<string>();
  for (const rawId of Array.isArray(patch['remove_event_ids']) ? patch['remove_event_ids'] : []) {
    if (typeof rawId === 'string' && rawId.trim()) {
      removedEventIds.add(rawId.trim());
    }
  }
  const patchEventsById = new Map<string, LooseRecord>();
  const anonymousPatchEvents: LooseRecord[] = [];
  for (const rawEvent of Array.isArray(patch['events']) ? patch['events'] : []) {
    if (!isPlainRecord(rawEvent)) {
      continue;
    }
    if (typeof rawEvent['id'] === 'string' && rawEvent['id']) {
      patchEventsById.set(rawEvent['id'], rawEvent);
    } else {
      anonymousPatchEvents.push(rawEvent);
    }
  }

  const liveEvents = dateContext?.liveEvents ?? [];
  let liveEventsById: Map<string, LooseRecord> | null = null;
  const eventMaxYearCache = new Map<string, number | null>();

  const getEventMaxYear = (eventId: string): number | null => {
    if (eventMaxYearCache.has(eventId)) {
      return eventMaxYearCache.get(eventId) ?? null;
    }
    let resolved: number | null = null;
    const patchedEv = patchEventsById.get(eventId);
    if (patchedEv) {
      resolved = extractLatestEdtfYear(patchedEv['edtf_date']);
    } else if (!removedEventIds.has(eventId)) {
      if (!liveEventsById) {
        liveEventsById = new Map<string, LooseRecord>();
        for (let i = 0; i < liveEvents.length; i += 1) {
          const ev = liveEvents[i];
          if (ev === undefined) continue;
          if (typeof ev['id'] === 'string' && ev['id']) {
            liveEventsById.set(ev['id'], ev);
          }
        }
      }
      const liveEv = liveEventsById.get(eventId);
      if (liveEv) {
        resolved = extractLatestEdtfYear(liveEv['edtf_date']);
      }
    }
    eventMaxYearCache.set(eventId, resolved);
    return resolved;
  };

  // Compute maxYear only for source_ids actually present in patch.sources instead of all 300 archive sources.
  const patchedSourceIds = new Set<string>();
  if (Array.isArray(patch['sources'])) {
    for (let i = 0; i < patch['sources'].length; i += 1) {
      const rawSource = patch['sources'][i];
      if (isPlainRecord(rawSource) && typeof rawSource['id'] === 'string' && rawSource['id']) {
        patchedSourceIds.add(rawSource['id']);
      }
    }
  }
  const sourceMaxYearById = new Map<string, number | null>();
  if (patchedSourceIds.size > 0 && livingPeople.length > 0) {
    const accumulateEventForPatchedSources = (ev: LooseRecord): void => {
      if (!Array.isArray(ev['sources']) || ev['sources'].length === 0) {
        return;
      }
      let touchesPatched = false;
      for (let s = 0; s < ev['sources'].length; s += 1) {
        const ref = ev['sources'][s];
        const sid = isPlainRecord(ref) && typeof ref['source_id'] === 'string' ? ref['source_id'] : '';
        if (sid && patchedSourceIds.has(sid)) {
          touchesPatched = true;
          break;
        }
      }
      if (!touchesPatched) {
        return;
      }
      const evYear = extractLatestEdtfYear(ev['edtf_date']);
      for (let s = 0; s < ev['sources'].length; s += 1) {
        const ref = ev['sources'][s];
        if (
          !isPlainRecord(ref) ||
          typeof ref['source_id'] !== 'string' ||
          !patchedSourceIds.has(ref['source_id'])
        ) {
          continue;
        }
        const claimedYear = extractLatestEdtfYear(ref['claimed_date']) ?? evYear;
        if (claimedYear === null) {
          if (!sourceMaxYearById.has(ref['source_id'])) {
            sourceMaxYearById.set(ref['source_id'], null);
          }
        } else {
          const prev = sourceMaxYearById.get(ref['source_id']);
          if (prev === undefined || (prev !== null && claimedYear > prev)) {
            sourceMaxYearById.set(ref['source_id'], claimedYear);
          }
        }
      }
    };

    for (let i = 0; i < liveEvents.length; i += 1) {
      const ev = liveEvents[i];
      if (ev === undefined) continue;
      const evId = typeof ev['id'] === 'string' ? ev['id'] : '';
      if (evId && (removedEventIds.has(evId) || patchEventsById.has(evId))) {
        continue;
      }
      accumulateEventForPatchedSources(ev);
    }
    for (const ev of patchEventsById.values()) {
      accumulateEventForPatchedSources(ev);
    }
    for (const ev of anonymousPatchEvents) {
      accumulateEventForPatchedSources(ev);
    }
  }

  const livingNameTargets: LivingNameTarget[] = [];

  const scanTarget = (label: string, text: string, maxYear: number | null, checkEmDash: boolean): void => {
    if (!text) {
      return;
    }
    if (livingNameMatcher) {
      livingNameTargets.push({ location: label, text, maxYear });
    }
    if (text.includes('-')) {
      for (const m of text.matchAll(SSN_RE)) {
        if (ssnHits.length < 25) {
          ssnHits.push({ location: label, match: m[0] });
        }
      }
    }
    for (const m of text.matchAll(US_PHONE_RE)) {
      if (phoneHits.length < 25) {
        phoneHits.push({ location: label, match: m[0] });
      }
    }
    if (checkEmDash && text.includes('\u2014')) {
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
          const stagedId = typeof rawPerson['id'] === 'string' ? rawPerson['id'].trim() : '';
          const stagedIsLiving =
            (stagedId !== '' && livingIds.has(stagedId)) ||
            rawPerson['is_living'] === true ||
            rawPerson['living'] === true;
          const stagedDeathYear =
            extractLatestEdtfYear(rawPerson['death_edtf']) ??
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
        const eventMaxYear = isPlainRecord(rawEv) ? extractLatestEdtfYear(rawEv['edtf_date']) : null;
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
            typeof rawItem['event_id'] === 'string' && rawItem['event_id'] ? rawItem['event_id'] : null;
          mediaMaxYear =
            extractLatestEdtfYear(rawItem['date_edtf']) ??
            (linkedEventId ? getEventMaxYear(linkedEventId) : null);
        }
        collectStringsWithPath(rawItem, `patch.media[${i}]`, mediaMaxYear, patchStrings);
      }
      continue;
    }
    if (key === 'sources' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const rawSource = value[i];
        const sourceId =
          isPlainRecord(rawSource) && typeof rawSource['id'] === 'string' ? rawSource['id'] : '';
        const sourceMaxYear = sourceId ? (sourceMaxYearById.get(sourceId) ?? null) : null;
        collectStringsWithPath(rawSource, `patch.sources[${i}]`, sourceMaxYear, patchStrings);
      }
      continue;
    }
    if (key === 'narratives' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const rawNarrative = value[i];
        let narrativeMaxYear: number | null = null;
        if (isPlainRecord(rawNarrative) && livingPeople.length > 0) {
          const narEventIds = stringListField(rawNarrative['event_ids']);
          const scopedEventMaxYearById = new Map<string, number | null>();
          for (const evId of narEventIds) {
            scopedEventMaxYearById.set(evId, getEventMaxYear(evId));
          }
          narrativeMaxYear = resolveNarrativeMaxYear({
            subjectPersonId:
              typeof rawNarrative['subject_person_id'] === 'string'
                ? rawNarrative['subject_person_id']
                : null,
            personIds: stringListField(rawNarrative['person_ids']),
            eventIds: narEventIds,
            livingIds,
            deathYearByPersonId,
            eventMaxYearById: scopedEventMaxYearById,
          });
        }
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

  const livingNameHits = livingNameMatcher
    ? collectLivingNameHitsWithMatcher(livingNameMatcher, livingNameTargets)
    : [];

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
