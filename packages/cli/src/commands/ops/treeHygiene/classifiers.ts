import { fastLocaleCompare, type RawEvent, type RawPerson } from '@kinloom/core';

export const ADOPTIVE_MARKER_RE = /\badopt(?:ed|ion|ive)?\b|\badop\b/i;
export const ADOPTIVE_XREF_RE = /adopt|adop/i;

const BIRTH_ID_RE = /(?:^|[_-])(?:birt|birth)(?:[_-]|$)/i;
const BIRTH_TITLE_RE = /\b(birth|born)\b/i;
const NON_PRIMARY_BIRTH_TITLE_RE =
  /\b(baptis\w*|christen\w*|affidavit\w*|delayed|petition\w*|correction\w*|amend\w*|census|enumerat\w*)\b|\bcourt\b(?!\s+house\b|\s+st(?:reet|\.)?\b)/i;
const NON_PRIMARY_BIRTH_ID_RE =
  /(?:^|[_-])(?:baptis\w*|bapt|christen\w*|chr|affidavit\w*|delayed|petition\w*|court|correction\w*|amend\w*|census)(?:[_-]|$)/i;
const BIRTH_SUBJECT_ROLES = new Set(['birth_subject', 'subject', 'principal', 'child', 'infant', 'newborn']);

const DEATH_ID_RE = /(?:^|[_-])(?:deat|death)(?:[_-]|$)/i;
const DEATH_TITLE_RE = /\b(death|died|passing|passed\s+away)\b/i;
const NON_DEATH_TITLE_RE =
  /\b(burial|buried|interment|interred|funeral|probate\w*|estate|obituary|headstone|gravestone|cemetery|tombstone|cremation|inquest|widow\w*|traged\w*|newspaper\w*|article|clipping|census|enumerat\w*)\b|\bmemorial\b(?!\s+(?:hospital|medical|clinic|center)\b)|\blast\s+will\b|\bwill\s+(?:and\s+testament|probated?|proved?|filed|recorded|executed|contested)\b|\b(?:his|her|their)\s+will\b|\bnews\s+(?:report|article|clipping|item|story|account|notice|brief)\b/i;
const NON_DEATH_ID_RE =
  /(?:^|[_-])(?:burial|buri|interment|funeral|probate\w*|estate|last_will|will_probate|obituary|obit|memorial|headstone|gravestone|cemetery|tombstone|cremation|inquest|widow\w*|traged\w*|newspaper\w*|news_report|news_article|news_clipping|census)(?:[_-]|$)/i;
const DEATH_SUBJECT_ROLES = new Set(['death_subject', 'deceased', 'decedent', 'subject', 'principal']);

const MARRIAGE_ID_RE = /(?:^|[_-])(?:marr|marriage|wedding)(?:[_-]|$)/i;
const MARRIAGE_TITLE_RE = /\b(marr(?:iage|ied)?|wedding|nuptial)\b/i;
const NON_MARRIAGE_TITLE_RE =
  /\b(divorc\w*|annul\w*|caregiv\w*|travel\w*|newspaper\w*|naturaliz\w*|declaration\w*|widow\w*|census|enumerat\w*|anniversar\w*)\b/i;
const NON_MARRIAGE_ID_RE =
  /(?:^|[_-])(?:divorc\w*|annul\w*|caregiv\w*|travel\w*|newspaper\w*|news|naturaliz\w*|declaration\w*|decl|widow\w*|census|anniversar\w*|anniv)(?:[_-]|$)/i;
const NON_SPOUSE_ROLE_RE =
  /\b(parent|father|mother|witness|officiant|minister|clergy|bondsman|surety|clerk|mentioned|child|informant|guest)\b/i;
const SPOUSE_ROLE_RE = /\b(spouse|bride|groom|husband|wife|partner|principal|subject|co\s+principal)\b/i;

const KNOWN_NORMALIZED_ROLES = new Set([
  'principal',
  'head',
  'resident',
  'attendee',
  'spouse',
  'child',
  'subject',
  'witness',
  'parent',
  'father',
  'mother',
  'birth_subject',
  'death_subject',
  'deceased',
  'decedent',
  'infant',
  'newborn',
]);

function hasAdoptiveExtension(extensions: Record<string, unknown> | undefined): boolean {
  if (!extensions) {
    return false;
  }
  for (const [key, value] of Object.entries(extensions)) {
    if (ADOPTIVE_XREF_RE.test(key)) {
      if (value === true || (typeof value === 'string' && value.trim().length > 0 && value !== 'false')) {
        return true;
      }
    }
    if (typeof value === 'string' && ADOPTIVE_XREF_RE.test(value) && ADOPTIVE_MARKER_RE.test(value)) {
      return true;
    }
  }
  return false;
}

export function hasAdoptivePersonTag(person: RawPerson | undefined): boolean {
  if (!person) {
    return false;
  }
  return (
    (ADOPTIVE_XREF_RE.test(person.lineage_group) && ADOPTIVE_MARKER_RE.test(person.lineage_group)) ||
    hasAdoptiveExtension(person.extensions)
  );
}

export function isAdoptionEvent(event: RawEvent): boolean {
  if (event.category && ADOPTIVE_XREF_RE.test(event.category) && ADOPTIVE_MARKER_RE.test(event.category)) {
    return true;
  }
  if (ADOPTIVE_XREF_RE.test(event.title) && ADOPTIVE_MARKER_RE.test(event.title)) {
    return true;
  }
  for (const pt of event.participants) {
    const role = pt.role;
    if (ADOPTIVE_XREF_RE.test(role) && ADOPTIVE_MARKER_RE.test(role)) {
      return true;
    }
  }
  return false;
}

function normalizeRole(role: string): string {
  if (KNOWN_NORMALIZED_ROLES.has(role)) {
    return role;
  }
  return role
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, '_');
}

function isBirthEvent(event: RawEvent): boolean {
  const cat = event.category;
  const isPositive =
    cat === 'birth' ||
    BIRTH_ID_RE.test(event.id) ||
    BIRTH_TITLE_RE.test(event.title) ||
    (cat !== undefined && cat !== null && cat.trim().toLowerCase() === 'birth');
  if (!isPositive) {
    return false;
  }
  return !NON_PRIMARY_BIRTH_TITLE_RE.test(event.title) && !NON_PRIMARY_BIRTH_ID_RE.test(event.id);
}

export function isBirthEventForParticipant(event: RawEvent, role: string): boolean {
  if (!BIRTH_SUBJECT_ROLES.has(normalizeRole(role))) {
    return false;
  }
  return isBirthEvent(event);
}

function isDeathEvent(event: RawEvent): boolean {
  const cat = event.category;
  const isPositive =
    cat === 'death' ||
    DEATH_ID_RE.test(event.id) ||
    DEATH_TITLE_RE.test(event.title) ||
    (cat !== undefined && cat !== null && cat.trim().toLowerCase() === 'death');
  if (!isPositive) {
    return false;
  }
  return !NON_DEATH_TITLE_RE.test(event.title) && !NON_DEATH_ID_RE.test(event.id);
}

export function isDeathEventForParticipant(event: RawEvent, role: string): boolean {
  if (!DEATH_SUBJECT_ROLES.has(normalizeRole(role))) {
    return false;
  }
  return isDeathEvent(event);
}

export function isMarriageEvent(event: RawEvent): boolean {
  if (!MARRIAGE_ID_RE.test(event.id) && !MARRIAGE_TITLE_RE.test(event.title)) {
    return false;
  }
  return !NON_MARRIAGE_TITLE_RE.test(event.title) && !NON_MARRIAGE_ID_RE.test(event.id);
}

export function getMarriageSpouseIds(event: RawEvent): string[] {
  const spouses = new Set<string>();
  for (let i = 0; i < event.participants.length; i += 1) {
    const participant = event.participants[i];
    if (participant === undefined) continue;
    const roleTokens = participant.role.trim().replaceAll(/[_-]+/g, ' ');
    if (NON_SPOUSE_ROLE_RE.test(roleTokens)) {
      continue;
    }
    if (SPOUSE_ROLE_RE.test(roleTokens)) {
      spouses.add(participant.person_id);
    }
  }
  return [...spouses].toSorted(fastLocaleCompare);
}

export function personLabel(personId: string, peopleById: ReadonlyMap<string, RawPerson>): string {
  const person = peopleById.get(personId);
  return person ? `${person.full_name} (${person.id})` : personId;
}

export function normalizeSex(person: RawPerson | undefined): 'F' | 'M' | 'U' {
  const raw = person?.sex;
  if (raw === 'F' || raw === 'M') {
    return raw;
  }
  const upper = raw?.trim().toUpperCase();
  if (upper === 'F' || upper === 'M') {
    return upper;
  }
  return 'U';
}
