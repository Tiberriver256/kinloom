import { edtfYear } from '../edtf.js';
import type { PrivacyConfig } from '../schemas/config.js';
import type { ArchiveEvent, BuildMode, MediaItem, Person, RawEvent, RawPerson } from '../schemas/entities.js';
import { getMediaPersonIds } from '../schemas/entities.js';

export const DEFAULT_LIVING_CUTOFF_YEARS = 101;

export interface LivingStatusInput {
  explicitLiving?: boolean;
  hasDeathOrBurial: boolean;
  birthYear: number | null;
  earliestEventYear: number | null;
  referenceYear: number;
  livingCutoffYears?: number;
}

export interface RedactOptions {
  privacy?: Partial<PrivacyConfig>;
  referenceYear?: number;
  clone?: boolean;
}

export interface ApplyPrivacyFilterOptions {
  privacy?: Partial<PrivacyConfig>;
  referenceYear?: number;
  cloneInputs?: boolean;
}

export interface FilterMediaPrivacyOptions {
  cloneInputs?: boolean;
  stripLivingPortraits?: boolean;
}

export class PrivacyViolationError extends Error {
  readonly code: 'LIVING_MEDIA_FORBIDDEN' | 'PRIVACY_VIOLATION';
  readonly blockedPersonIds: readonly string[];

  constructor(
    message: string,
    options: {
      code?: 'LIVING_MEDIA_FORBIDDEN' | 'PRIVACY_VIOLATION';
      blockedPersonIds?: readonly string[];
    } = {}
  ) {
    super(message);
    this.name = 'PrivacyViolationError';
    this.code = options.code ?? 'LIVING_MEDIA_FORBIDDEN';
    this.blockedPersonIds = options.blockedPersonIds ?? [];
  }
}

export type MediaPrivacyCheckResult =
  | { ok: true }
  | { ok: false; code: 'LIVING_MEDIA_FORBIDDEN'; message: string; blockedPersonIds: string[] };

/**
 * 100-year living-person privacy heuristic (default cutoff = 101 years so <= referenceYear - 101 is deceased).
 * Pure and deterministic: callers must supply `referenceYear` explicitly.
 */
export function isPersonLivingPublic(params: LivingStatusInput): boolean {
  const {
    explicitLiving,
    hasDeathOrBurial,
    birthYear,
    earliestEventYear,
    referenceYear,
    livingCutoffYears = DEFAULT_LIVING_CUTOFF_YEARS,
  } = params;
  if (explicitLiving) {
    return true;
  }
  if (hasDeathOrBurial) {
    return false;
  }
  const cutoff = referenceYear - livingCutoffYears;
  if (birthYear !== null) {
    return birthYear > cutoff;
  }
  if (earliestEventYear !== null) {
    return earliestEventYear > cutoff;
  }
  return true;
}

/**
 * Resolve effective living status honoring both explicit `is_living` and configured birth-year cutoff.
 * Pure and deterministic: requires `referenceYear` or `privacy.referenceYear` whenever evaluating a birth-year cutoff.
 */
export function resolveEffectiveLiving(
  person: Pick<RawPerson, 'is_living' | 'birth_edtf' | 'death_edtf'>,
  privacy?: Partial<PrivacyConfig>,
  referenceYear?: number
): boolean {
  if (person.is_living) {
    return true;
  }
  if (person.death_edtf && person.death_edtf.trim().length > 0) {
    return false;
  }
  const birthYear = edtfYear(person.birth_edtf);
  if (birthYear !== null) {
    const resolvedReferenceYear = referenceYear ?? privacy?.referenceYear;
    if (resolvedReferenceYear === undefined) {
      throw new RangeError(
        'resolveEffectiveLiving requires an explicit referenceYear or privacy.referenceYear when evaluating birth-year cutoffs.'
      );
    }
    return isPersonLivingPublic({
      explicitLiving: false,
      hasDeathOrBurial: false,
      birthYear,
      earliestEventYear: null,
      referenceYear: resolvedReferenceYear,
      livingCutoffYears: privacy?.livingCutoffYears ?? DEFAULT_LIVING_CUTOFF_YEARS,
    });
  }
  return false;
}

export function collectLivingNames(
  people: readonly Pick<RawPerson, 'is_living' | 'full_name' | 'alt_names'>[]
): string[] {
  const names = new Set<string>();
  for (const p of people) {
    if (!p.is_living) {
      continue;
    }
    const full = p.full_name.trim();
    if (full && full.toLowerCase() !== 'living') {
      names.add(full);
    }
    for (const alt of p.alt_names) {
      const trimmed = alt.trim();
      if (trimmed && trimmed.toLowerCase() !== 'living') {
        names.add(trimmed);
      }
    }
  }
  return [...names].toSorted((a, b) => b.length - a.length || a.localeCompare(b));
}

export function escapeLivingNameRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileLivingNamePattern(livingNames: readonly string[]): RegExp | null {
  if (livingNames.length === 0) {
    return null;
  }
  const body = livingNames.map((name) => escapeLivingNameRegExp(name)).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, 'gu');
}

export function scrubLivingNames(text: string, pattern: RegExp | null): string {
  if (!text || !pattern) {
    return text;
  }
  return text.replaceAll(pattern, 'Living');
}

function applyRawLivingRedactionFields(
  target: RawPerson,
  mode: BuildMode,
  options?: RedactOptions
): { birthYear: number | null; stripPortraits: boolean } {
  target.is_living = true;

  if (mode === 'public') {
    target.full_name = 'Living';
    target.given_name = 'Living';
    target.surname = '';
    target.alt_names = [];
    target.birth_edtf = '';
    target.death_edtf = '';
    target.portrait_url = null;
    if ('pronunciation' in target) {
      delete target.pronunciation;
    }
    if ('thumb_url' in target) {
      target.thumb_url = null;
    }
    return { birthYear: null, stripPortraits: true };
  }

  const showBirthYear = options?.privacy?.privateModeShowsBirthYear ?? true;
  const stripPortraits = options?.privacy?.stripLivingPortraits ?? true;
  const birthYear = showBirthYear ? edtfYear(target.birth_edtf) : null;
  target.birth_edtf = birthYear !== null ? String(birthYear) : '';
  if (stripPortraits) {
    target.portrait_url = null;
    if ('pronunciation' in target) {
      delete target.pronunciation;
    }
    if ('thumb_url' in target) {
      target.thumb_url = null;
    }
  }
  return { birthYear, stripPortraits };
}

export function isCompiledPerson(person: RawPerson | Person): person is Person {
  return 'birth_year' in person && 'death_year' in person && 'media_count' in person;
}

export function redactSingleRawPerson(
  person: RawPerson,
  mode: BuildMode,
  options?: RedactOptions
): RawPerson {
  const copy = options?.clone === false ? person : structuredClone(person);
  if (!resolveEffectiveLiving(copy, options?.privacy, options?.referenceYear)) {
    return copy;
  }
  applyRawLivingRedactionFields(copy, mode, options);
  return copy;
}

export function redactCompiledPerson(person: Person, mode: BuildMode, options?: RedactOptions): Person {
  const copy = options?.clone === false ? person : structuredClone(person);
  if (!resolveEffectiveLiving(copy, options?.privacy, options?.referenceYear)) {
    return copy;
  }
  const { birthYear, stripPortraits } = applyRawLivingRedactionFields(copy, mode, options);
  if (mode === 'public') {
    copy.birth_year = null;
    copy.death_year = null;
    copy.media_count = 0;
    return copy;
  }
  copy.birth_year = birthYear;
  if (stripPortraits) {
    copy.media_count = 0;
  }
  return copy;
}

export function redactSinglePerson(person: Person, mode: BuildMode, options?: RedactOptions): Person;
export function redactSinglePerson(person: RawPerson, mode: BuildMode, options?: RedactOptions): RawPerson;
export function redactSinglePerson(
  person: RawPerson | Person,
  mode: BuildMode,
  options?: RedactOptions
): RawPerson | Person {
  if (isCompiledPerson(person)) {
    return redactCompiledPerson(person, mode, options);
  }
  return redactSingleRawPerson(person, mode, options);
}

export function sanitizePersonForWrite(
  person: Person,
  privacyConfig?: Partial<PrivacyConfig>,
  referenceYear?: number
): Person;
export function sanitizePersonForWrite(
  person: RawPerson,
  privacyConfig?: Partial<PrivacyConfig>,
  referenceYear?: number
): RawPerson;
export function sanitizePersonForWrite(
  person: RawPerson | Person,
  privacyConfig?: Partial<PrivacyConfig>,
  referenceYear?: number
): RawPerson | Person {
  const opts: RedactOptions = { privacy: privacyConfig, referenceYear };
  if (isCompiledPerson(person)) {
    return redactCompiledPerson(person, 'private', opts);
  }
  return redactSingleRawPerson(person, 'private', opts);
}

function isCompiledEvent(event: RawEvent | ArchiveEvent): event is ArchiveEvent {
  return 'place_ancestors' in event;
}

function applyLivingEventWriteRedaction(target: RawEvent, privacyConfig?: Partial<PrivacyConfig>): void {
  const showBirthYear = privacyConfig?.privateModeShowsBirthYear ?? true;
  const stripPortraits = privacyConfig?.stripLivingPortraits ?? true;
  const yr = showBirthYear ? edtfYear(target.edtf_date) : null;
  target.edtf_date = yr !== null ? String(yr) : '';
  target.place_id = null;
  target.summary = 'Living relative record (location and exact date omitted).';
  if (stripPortraits) {
    target.photo_url = undefined;
  }
}

export function sanitizeRawEventForWrite(
  event: RawEvent,
  livingPersonIds: ReadonlySet<string>,
  privacyConfig?: Partial<PrivacyConfig>
): RawEvent {
  const hasLivingParticipant = event.participants.some((pt) => livingPersonIds.has(pt.person_id));
  if (!hasLivingParticipant) {
    return {
      ...event,
      participants: event.participants.map((pt) => ({ ...pt })),
      sources: event.sources.map((s) => ({ ...s })),
    };
  }
  const copy = structuredClone(event);
  applyLivingEventWriteRedaction(copy, privacyConfig);
  return copy;
}

export function sanitizeCompiledEventForWrite(
  event: ArchiveEvent,
  livingPersonIds: ReadonlySet<string>,
  privacyConfig?: Partial<PrivacyConfig>
): ArchiveEvent {
  const hasLivingParticipant = event.participants.some((pt) => livingPersonIds.has(pt.person_id));
  if (!hasLivingParticipant) {
    return {
      ...event,
      participants: event.participants.map((pt) => ({ ...pt })),
      sources: event.sources.map((s) => ({ ...s })),
    };
  }
  const copy = structuredClone(event);
  applyLivingEventWriteRedaction(copy, privacyConfig);
  copy.place_ancestors = [];
  return copy;
}

export function sanitizeEventForWrite(
  event: ArchiveEvent,
  livingPersonIds: ReadonlySet<string>,
  privacyConfig?: Partial<PrivacyConfig>
): ArchiveEvent;
export function sanitizeEventForWrite(
  event: RawEvent,
  livingPersonIds: ReadonlySet<string>,
  privacyConfig?: Partial<PrivacyConfig>
): RawEvent;
export function sanitizeEventForWrite(
  event: RawEvent | ArchiveEvent,
  livingPersonIds: ReadonlySet<string>,
  privacyConfig?: Partial<PrivacyConfig>
): RawEvent | ArchiveEvent {
  if (isCompiledEvent(event)) {
    return sanitizeCompiledEventForWrite(event, livingPersonIds, privacyConfig);
  }
  return sanitizeRawEventForWrite(event, livingPersonIds, privacyConfig);
}

export function validateMediaForPrivacy(
  media: Pick<MediaItem, 'id' | 'person_id' | 'person_ids' | 'event_id'>,
  livingPersonIds: ReadonlySet<string>,
  eventsById?: ReadonlyMap<string, Pick<RawEvent, 'id' | 'participants'>>
): MediaPrivacyCheckResult {
  const blocked = new Set<string>();
  for (const pid of getMediaPersonIds(media)) {
    if (livingPersonIds.has(pid)) {
      blocked.add(pid);
    }
  }
  if (media.event_id && eventsById) {
    const ev = eventsById.get(media.event_id);
    if (ev) {
      for (const pt of ev.participants) {
        if (livingPersonIds.has(pt.person_id)) {
          blocked.add(pt.person_id);
        }
      }
    }
  }
  if (blocked.size > 0) {
    const blockedPersonIds = [...blocked].toSorted();
    return {
      ok: false,
      code: 'LIVING_MEDIA_FORBIDDEN',
      message: `Media ${media.id} cannot be linked to living person(s): ${blockedPersonIds.join(', ')}`,
      blockedPersonIds,
    };
  }
  return { ok: true };
}

export function assertMediaAllowedForPrivacy(
  media: Pick<MediaItem, 'id' | 'person_id' | 'person_ids' | 'event_id'>,
  livingPersonIds: ReadonlySet<string>,
  eventsById?: ReadonlyMap<string, Pick<RawEvent, 'id' | 'participants'>>
): void {
  const result = validateMediaForPrivacy(media, livingPersonIds, eventsById);
  if (!result.ok) {
    throw new PrivacyViolationError(result.message, {
      code: result.code,
      blockedPersonIds: result.blockedPersonIds,
    });
  }
}
