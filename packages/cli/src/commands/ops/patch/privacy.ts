import {
  getCurrentReferenceYear,
  getMediaPersonIds,
  type MediaItem,
  type Narrative,
  type PrivacyConfig,
  type RawEvent,
  type RawPerson,
  resolveEffectiveLiving,
} from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';

const YEAR_ONLY_EDTF_RE = /^\d{4}$/;

export function isEffectiveLivingPerson(
  person: RawPerson,
  privacyConfig: Partial<PrivacyConfig> | undefined
): boolean {
  const referenceYear = privacyConfig?.referenceYear ?? getCurrentReferenceYear();
  return person.is_living || resolveEffectiveLiving(person, privacyConfig, referenceYear);
}

/**
 * Enforce strict living-person privacy invariants on a living person entry when `--allow-living` is set:
 * - Explicit `is_living: true`
 * - Zero portraits (`portrait_url` and `thumb_url` must be null/empty)
 * - Zero full `YYYY-MM-DD` (or month-level) DOBs: `birth_edtf` must be empty or 4-digit `YYYY`
 * - Zero pronunciation overrides on living people
 */
export function assertLivingPersonPrivacyInvariants(person: RawPerson, label: string): void {
  const violations: string[] = [];

  if (!person.is_living) {
    violations.push('effective-living person must explicitly set is_living: true');
  }

  const birthEdtf = person.birth_edtf.trim();
  if (birthEdtf.length > 0 && !YEAR_ONLY_EDTF_RE.test(birthEdtf)) {
    violations.push(
      `living person birth_edtf '${birthEdtf}' must be empty or year-only YYYY (full YYYY-MM-DD DOBs are forbidden)`
    );
  }

  if (typeof person.portrait_url === 'string' && person.portrait_url.trim().length > 0) {
    violations.push('living person must not have portrait_url (zero portraits)');
  }

  if (typeof person.thumb_url === 'string' && person.thumb_url.trim().length > 0) {
    violations.push('living person must not have thumb_url (zero portraits)');
  }

  if (person.pronunciation !== undefined && person.pronunciation !== null) {
    violations.push('living person must not have a pronunciation override');
  }

  if (violations.length > 0) {
    throw new CliValidationError(
      `LIVING PRIVACY VIOLATION in ${label} ('${person.id}'): ${violations.join('; ')}.`
    );
  }
}

/**
 * Enforce living-person privacy invariants on patched events, media, and narratives.
 * - When `allowLiving` is false: any event, media, or narrative touching a living person is rejected.
 * - When `allowLiving` is true:
 *   - Events with a living participant may NOT be `residence_anchor`, may NOT set `place_id`,
 *     may NOT set `photo_url`, and may NOT have non-year-only `edtf_date` (zero full DOBs / residence spans).
 *   - Media items may NEVER link to a living person or living event (zero portraits/photos).
 *   - Narratives may NEVER target or list a living person.
 */
export function assertPatchedRelationsLivingPrivacy(input: {
  readonly allowLiving: boolean;
  readonly livingIds: ReadonlySet<string>;
  readonly patchEvents: readonly RawEvent[];
  readonly patchMedia: readonly MediaItem[];
  readonly patchNarratives: readonly Narrative[];
  readonly allEventsById: ReadonlyMap<string, RawEvent>;
}): void {
  const { allowLiving, livingIds, patchEvents, patchMedia, patchNarratives, allEventsById } = input;

  for (const ev of patchEvents) {
    const livingParticipantIds = ev.participants
      .filter((pt) => livingIds.has(pt.person_id))
      .map((pt) => pt.person_id);
    if (livingParticipantIds.length === 0) {
      continue;
    }

    if (!allowLiving) {
      throw new CliValidationError(
        `PRIVACY REFUSAL: Patch event '${ev.id}' includes living participant(s) (${livingParticipantIds.join(', ')}). Pass --allow-living to permit privacy-compliant living-person updates.`
      );
    }

    const violations: string[] = [];
    if (ev.event_kind === 'residence_anchor') {
      violations.push('event_kind cannot be residence_anchor for a living person (zero residence spans)');
    }
    if (ev.place_id !== null && ev.place_id.trim().length > 0) {
      violations.push(`place_id '${ev.place_id}' must be null for a living person (zero residence spans)`);
    }
    if (typeof ev.photo_url === 'string' && ev.photo_url.trim().length > 0) {
      violations.push('photo_url must be null/omitted for a living person (zero portraits)');
    }
    const edtfDate = ev.edtf_date.trim();
    if (edtfDate.length > 0 && !YEAR_ONLY_EDTF_RE.test(edtfDate)) {
      violations.push(
        `edtf_date '${edtfDate}' must be empty or year-only YYYY for a living person (full YYYY-MM-DD dates are forbidden)`
      );
    }
    if (violations.length > 0) {
      throw new CliValidationError(`LIVING PRIVACY VIOLATION in event '${ev.id}': ${violations.join('; ')}.`);
    }
  }

  for (const item of patchMedia) {
    const linkedPersonIds = getMediaPersonIds(item);
    const livingLinked = linkedPersonIds.filter((pid) => livingIds.has(pid));
    if (livingLinked.length > 0) {
      throw new CliValidationError(
        `LIVING PRIVACY VIOLATION in media '${item.id}': media cannot reference living person(s) (${livingLinked.join(', ')}) (zero portraits/media for living people).`
      );
    }
    if (item.event_id) {
      const ev = allEventsById.get(item.event_id);
      if (ev && ev.participants.some((pt) => livingIds.has(pt.person_id))) {
        throw new CliValidationError(
          `LIVING PRIVACY VIOLATION in media '${item.id}': media cannot reference event '${item.event_id}' involving a living person.`
        );
      }
    }
  }

  for (const nar of patchNarratives) {
    if (nar.subject_person_id && livingIds.has(nar.subject_person_id)) {
      throw new CliValidationError(
        `LIVING PRIVACY VIOLATION in narrative '${nar.id}': subject_person_id '${nar.subject_person_id}' is a living person.`
      );
    }
    const livingPersonRefs = nar.person_ids.filter((pid) => livingIds.has(pid));
    if (livingPersonRefs.length > 0) {
      throw new CliValidationError(
        `LIVING PRIVACY VIOLATION in narrative '${nar.id}': person_ids references living person(s) (${livingPersonRefs.join(', ')}).`
      );
    }
  }
}
