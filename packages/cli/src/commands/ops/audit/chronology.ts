import {
  asString,
  type ChronologyCheckResult,
  isPlainRecord,
  type LifespanSummary,
  type LooseRecord,
  type ParsedAuditEdtf,
} from './types.js';

const POST_MORTEM_RE =
  /\b(burial|buried|funeral|probate|will|estate|obituary|memorial|gravestone|headstone|cemetery|cenotaph|interment|interred|administration|inventory|tombstone|inquest|posthumous|heirs?|executors?|widow)\b/i;
const POST_MORTEM_PASSIVE_ROLES = new Set([
  'mentioned',
  'deceased_parent',
  'parent_of_groom',
  'parent_of_bride',
  'cited_parent',
  'subject_parent',
]);
const PRE_BIRTH_CONTEXT_RE =
  /\b(father|mother|parents?|ancestors?|pre-birth|prior to birth|before birth|family origin)\b/i;
const CENSUS_RE = /\b(census|enumerat\w*)\b/i;
const MARRIAGE_RE = /\b(marr(?:iage|ied)?|wedding|nuptial)\b/i;
const SPOUSE_ROLE_RE = /\b(spouse|bride|groom|husband|wife|principal|subject|partner)\b/i;

interface AuditEdtfPoint {
  year: number;
  month: number | null;
  day: number | null;
  precision: 'day' | 'month' | 'year';
  startMs: number;
  endMs: number;
}

type ParsedEndpoint = { kind: 'open' } | { kind: 'point'; point: AuditEdtfPoint };

function parseClosedEdtfPoint(part: string): AuditEdtfPoint | null {
  const clean = part.trim().replaceAll(/[~?%]/g, '');
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (full) {
    const year = Number(full[1]);
    const month = Number(full[2]);
    const day = Number(full[3]);
    const ms = Date.UTC(year, month - 1, day);
    return { year, month, day, precision: 'day', startMs: ms, endMs: ms };
  }

  const ym = /^(\d{4})-(\d{2})$/.exec(clean);
  if (ym) {
    const year = Number(ym[1]);
    const month = Number(ym[2]);
    return {
      year,
      month,
      day: null,
      precision: 'month',
      startMs: Date.UTC(year, month - 1, 1),
      endMs: Date.UTC(year, month, 0),
    };
  }

  const y = /^(\d{4})/.exec(clean);
  if (y) {
    const year = Number(y[1]);
    return {
      year,
      month: null,
      day: null,
      precision: 'year',
      startMs: Date.UTC(year, 0, 1),
      endMs: Date.UTC(year, 11, 31),
    };
  }

  return null;
}

function parseAuditEndpoint(part: string): ParsedEndpoint | null {
  const trimmed = part.trim();
  if (trimmed === '' || trimmed === '..') {
    return { kind: 'open' };
  }
  const point = parseClosedEdtfPoint(trimmed);
  return point ? { kind: 'point', point } : null;
}

export function parseAuditEdtf(raw: unknown): ParsedAuditEdtf | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const approximate = /[~?%]/.test(trimmed);
  const slash = trimmed.indexOf('/');
  if (slash === -1) {
    const point = parseClosedEdtfPoint(trimmed);
    if (!point) {
      return null;
    }
    return { raw: trimmed, approximate, ...point };
  }
  if (trimmed.indexOf('/', slash + 1) !== -1) {
    return null;
  }

  const left = parseAuditEndpoint(trimmed.slice(0, slash));
  const right = parseAuditEndpoint(trimmed.slice(slash + 1));
  if (!left || !right || (left.kind === 'open' && right.kind === 'open')) {
    return null;
  }

  const anchor = left.kind === 'point' ? left.point : right.kind === 'point' ? right.point : null;
  if (!anchor) {
    return null;
  }
  const startMs = left.kind === 'point' ? left.point.startMs : Number.NEGATIVE_INFINITY;
  const endMs = right.kind === 'point' ? right.point.endMs : Number.POSITIVE_INFINITY;
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs > endMs) {
    return null;
  }

  return {
    raw: trimmed,
    year: anchor.year,
    month: anchor.month,
    day: anchor.day,
    precision: anchor.precision,
    approximate,
    startMs,
    endMs,
  };
}

function auditLowerMs(bound: ParsedAuditEdtf): number {
  if (!Number.isFinite(bound.startMs)) {
    return bound.startMs;
  }
  if (bound.approximate) {
    return Date.UTC(new Date(bound.startMs).getUTCFullYear() - 1, 0, 1);
  }
  return bound.startMs;
}

function auditUpperMs(bound: ParsedAuditEdtf): number {
  if (!Number.isFinite(bound.endMs)) {
    return bound.endMs;
  }
  if (bound.approximate) {
    return Date.UTC(new Date(bound.endMs).getUTCFullYear() + 1, 11, 31);
  }
  return bound.endMs;
}

export function computeLifespan(
  birth: ParsedAuditEdtf | null,
  death: ParsedAuditEdtf | null
): LifespanSummary {
  if (!birth || !death) {
    return { exact: false, years: null, days: null, totalDays: null, label: null };
  }
  if (birth.raw.includes('/') || death.raw.includes('/')) {
    if (!Number.isFinite(birth.startMs) || !Number.isFinite(death.endMs)) {
      return { exact: false, years: null, days: null, totalDays: null, label: null };
    }
    const years = new Date(death.endMs).getUTCFullYear() - new Date(birth.startMs).getUTCFullYear();
    return {
      exact: false,
      years,
      days: null,
      totalDays: null,
      label: `~${years} years`,
    };
  }
  if (birth.precision === 'day' && death.precision === 'day' && birth.month !== null && birth.day !== null) {
    const totalDays = Math.round((death.startMs - birth.startMs) / 86_400_000);
    let years = death.year - birth.year;
    let anniversary = Date.UTC(birth.year + years, birth.month - 1, birth.day);
    if (anniversary > death.startMs) {
      years -= 1;
      anniversary = Date.UTC(birth.year + years, birth.month - 1, birth.day);
    }
    const remDays = Math.round((death.startMs - anniversary) / 86_400_000);
    return {
      exact: true,
      years,
      days: remDays,
      totalDays,
      label: `${years} years, ${remDays} days (${totalDays} days)`,
    };
  }
  const approxYears = death.year - birth.year;
  return {
    exact: false,
    years: approxYears,
    days: null,
    totalDays: null,
    label: `~${approxYears} years`,
  };
}

function checkEventChronologyForPerson(params: {
  ev: LooseRecord;
  dt: ParsedAuditEdtf;
  personId: string;
  birth: ParsedAuditEdtf | null;
  death: ParsedAuditEdtf | null;
  role: string;
  labelPrefix: string;
  errors: string[];
  warnings: string[];
}): void {
  const { ev, dt, birth, death, role, labelPrefix, errors, warnings } = params;
  const evId = asString(ev.id);
  const textBlob = `${evId} ${asString(ev.event_kind)} ${asString(ev.title)} ${asString(ev.summary)}`;
  const isPostMortemAllowed = POST_MORTEM_RE.test(textBlob);
  const normalizedRole = role
    .trim()
    .toLowerCase()
    .replaceAll(/[\s-]+/g, '_');
  const isPassivePostMortemRole = POST_MORTEM_PASSIVE_ROLES.has(normalizedRole);
  const isPreBirthContext = PRE_BIRTH_CONTEXT_RE.test(textBlob);
  const isCensus = CENSUS_RE.test(`${evId} ${asString(ev.title)}`);
  const isMarriage = MARRIAGE_RE.test(`${evId} ${asString(ev.event_kind)} ${asString(ev.title)}`);

  const birthMinMs = birth ? auditLowerMs(birth) : null;
  const deathMaxMs = death ? auditUpperMs(death) : null;

  if (birth && birthMinMs !== null && dt.endMs < birthMinMs) {
    if (isCensus) {
      if (!isPreBirthContext) {
        errors.push(
          `${labelPrefix}Event ${evId} (${dt.raw}): census predates birth (${birth.raw}) without context label.`
        );
      } else {
        warnings.push(
          `${labelPrefix}Event ${evId} (${dt.raw}): labeled pre-birth census context before birth (${birth.raw}).`
        );
      }
    } else if (isPreBirthContext) {
      warnings.push(
        `${labelPrefix}Event ${evId} (${dt.raw}): pre-birth family context before birth (${birth.raw}).`
      );
    } else {
      errors.push(`${labelPrefix}Event ${evId} (${dt.raw}): predates birth (${birth.raw}).`);
    }
  }

  if (death && deathMaxMs !== null && dt.startMs > deathMaxMs && !isPassivePostMortemRole) {
    if (isCensus) {
      if (!isPostMortemAllowed) {
        errors.push(
          `${labelPrefix}Event ${evId} (${dt.raw}): census postdates death (${death.raw}) without explicit posthumous/widow label.`
        );
      } else {
        warnings.push(
          `${labelPrefix}Event ${evId} (${dt.raw}): labeled post-mortem census entry after death (${death.raw}).`
        );
      }
    } else if (!isPostMortemAllowed) {
      errors.push(
        `${labelPrefix}Event ${evId} (${dt.raw}): postdates death (${death.raw}) and is not a burial/probate/obituary/memorial event.`
      );
    }
  }

  if (birth && isMarriage) {
    const isPrincipalSpouse = !isPassivePostMortemRole && (!role || SPOUSE_ROLE_RE.test(role));
    if (isPrincipalSpouse) {
      let ageAtEvent: number | null;
      if (birth.raw.includes('/') || dt.raw.includes('/')) {
        ageAtEvent =
          Number.isFinite(birth.startMs) && Number.isFinite(dt.endMs)
            ? new Date(dt.endMs).getUTCFullYear() - new Date(birth.startMs).getUTCFullYear()
            : null;
      } else {
        const beforeBirthday =
          birth.precision === 'day' &&
          dt.precision === 'day' &&
          birth.month !== null &&
          birth.day !== null &&
          dt.month !== null &&
          dt.day !== null &&
          (dt.month < birth.month || (dt.month === birth.month && dt.day < birth.day));
        ageAtEvent = dt.year - birth.year - (beforeBirthday ? 1 : 0);
      }
      if (ageAtEvent !== null && ageAtEvent < 12) {
        errors.push(
          `${labelPrefix}Event ${evId} (${dt.raw}): marriage at implausible age ${ageAtEvent} (birth ${birth.raw}).`
        );
      }
    }
  }
}

export function runChronologyCheck(
  targetPerson: LooseRecord | null,
  patch: LooseRecord,
  existingPersonEvents: readonly LooseRecord[]
): ChronologyCheckResult {
  const updates = isPlainRecord(patch.person_updates) ? patch.person_updates : {};
  const birthRaw = updates.birth_edtf ?? updates.birth_date ?? targetPerson?.birth_edtf ?? '';
  const deathRaw = updates.death_edtf ?? updates.death_date ?? targetPerson?.death_edtf ?? '';
  const birth = parseAuditEdtf(asString(birthRaw));
  const death = parseAuditEdtf(asString(deathRaw));
  const lifespan = computeLifespan(birth, death);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (birth && death && birth.startMs > death.endMs) {
    errors.push(`Birth (${birth.raw}) is after death (${death.raw}).`);
  }
  if (lifespan.years !== null && (lifespan.years < 0 || lifespan.years > 118)) {
    errors.push(`Implausible lifespan: ${lifespan.label} (${birth?.raw} to ${death?.raw}).`);
  }

  const personId = typeof patch.person_id === 'string' ? patch.person_id : '';
  const stagedPeopleBounds = new Map<
    string,
    { birth: ParsedAuditEdtf | null; death: ParsedAuditEdtf | null }
  >();
  for (const rawPerson of Array.isArray(patch.people) ? patch.people : []) {
    if (!isPlainRecord(rawPerson) || typeof rawPerson.id !== 'string' || !rawPerson.id.trim()) {
      continue;
    }
    const stagedId = rawPerson.id.trim();
    if (stagedId === personId) {
      continue;
    }
    const stagedBirth = parseAuditEdtf(asString(rawPerson.birth_edtf));
    const stagedDeath = parseAuditEdtf(asString(rawPerson.death_edtf));
    const stagedLifespan = computeLifespan(stagedBirth, stagedDeath);
    if (stagedBirth && stagedDeath && stagedBirth.startMs > stagedDeath.endMs) {
      errors.push(`[${stagedId}] Birth (${stagedBirth.raw}) is after death (${stagedDeath.raw}).`);
    }
    if (stagedLifespan.years !== null && (stagedLifespan.years < 0 || stagedLifespan.years > 118)) {
      errors.push(
        `[${stagedId}] Implausible lifespan: ${stagedLifespan.label} (${stagedBirth?.raw} to ${stagedDeath?.raw}).`
      );
    }
    stagedPeopleBounds.set(stagedId, { birth: stagedBirth, death: stagedDeath });
  }

  const eventMap = new Map<string, LooseRecord>();
  for (const ev of existingPersonEvents) {
    if (typeof ev.id === 'string' && ev.id) {
      eventMap.set(ev.id, ev);
    }
  }
  for (const rawEv of Array.isArray(patch.events) ? patch.events : []) {
    if (isPlainRecord(rawEv) && typeof rawEv.id === 'string' && rawEv.id) {
      eventMap.set(rawEv.id, rawEv);
    }
  }
  for (const rawId of Array.isArray(patch.remove_event_ids) ? patch.remove_event_ids : []) {
    if (typeof rawId === 'string' && rawId.trim()) {
      eventMap.delete(rawId.trim());
    }
  }

  let checkedEvents = 0;

  for (const ev of eventMap.values()) {
    const dt = parseAuditEdtf(asString(ev.edtf_date));
    if (!dt) {
      continue;
    }
    checkedEvents += 1;

    const participants = Array.isArray(ev.participants) ? ev.participants : [];
    const participantRecords = participants.filter((pt): pt is LooseRecord => isPlainRecord(pt));
    const subjectPart = participantRecords.find((pt) => pt.person_id === personId);
    const appliesToTarget = participantRecords.length === 0 || subjectPart !== undefined;

    if (appliesToTarget) {
      checkEventChronologyForPerson({
        ev,
        dt,
        personId,
        birth,
        death,
        role: subjectPart ? asString(subjectPart.role) : '',
        labelPrefix: '',
        errors,
        warnings,
      });
    }

    for (const pt of participantRecords) {
      const ptId = typeof pt.person_id === 'string' ? pt.person_id : '';
      if (!ptId || ptId === personId) {
        continue;
      }
      const stagedBounds = stagedPeopleBounds.get(ptId);
      if (!stagedBounds) {
        continue;
      }
      checkEventChronologyForPerson({
        ev,
        dt,
        personId: ptId,
        birth: stagedBounds.birth,
        death: stagedBounds.death,
        role: asString(pt.role),
        labelPrefix: `[${ptId}] `,
        errors,
        warnings,
      });
    }
  }

  return {
    ok: errors.length === 0,
    birth_edtf: birth?.raw ?? null,
    death_edtf: death?.raw ?? null,
    lifespan,
    checkedEvents,
    errors,
    warnings,
  };
}
