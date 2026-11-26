import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  parseKinloomConfigYaml,
  resolveEffectiveLiving,
  type KinshipEdge,
  type PrivacyConfig,
  type RawEvent,
  type RawPerson,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';
import { parseMatchingYamlBlocks, splitTopLevelYamlList } from './context.js';
import {
  applyKinshipRemovals,
  parseValidDeathEdtf,
  runIntegrateCommand,
  type IntegrateCommandResult,
  type RemoveKinshipEntry,
} from './integrate.js';
import {
  collectLiveMediaCollisions,
  loadLiveMedia,
  readStagedMediaRefs,
} from './live-media-collisions.js';
import {
  NARRATIVE_POSTHUMOUS_HORIZON_YEARS,
  collectLivingNameHitsWithMatcher,
  compileLivingNameMatcher,
  computeSourceMaxYearById,
  extractLatestEdtfYear,
  resolveNarrativeMaxYear,
  type LivingNameTarget,
} from './living-name-matcher.js';
import {
  analyzeTreeHygiene,
  diffTreeHygieneWarnings,
  formatAuditHygieneWarningMessage,
  type TreeHygieneWarning,
} from './tree-hygiene.js';

const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const US_PHONE_RE =
  /(?<!\d)(?:\+1[-.\s]?)?(?:\(\d{3}\)[-.\s]?|\b[2-9]\d{2}[-.\s])[2-9]\d{2}[-.\s]\d{4}(?!\d)/g;
const EM_DASH_RE = /\u2014/g;
const INLINE_CITATION_RE = /\[\^src_[A-Za-z0-9._:-]+(?:\|[A-Za-z0-9._:-]+)?\]/;

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

const MIN_SCAN_WARN_BYTES = 10 * 1024;
const MAX_SCAN_WARN_BYTES = 10 * 1024 * 1024;

const ABBREVIATIONS = [
  'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.', 'Rev.', 'Hon.', 'Gov.', 'Pres.', 'Sen.', 'Rep.',
  'Esq.', 'Fr.', 'Br.', 'Mme.', 'Mlle.', 'Messrs.', 'Supt.', 'Jr.', 'Sr.',
  'Gen.', 'Col.', 'Maj.', 'Capt.', 'Lt.', 'Lieut.', 'Sgt.', 'Sergt.', 'Cpl.', 'Corpl.',
  'Pfc.', 'PFC.', 'Pvt.', 'Adm.', 'Brig.', 'Cmdr.', 'Ens.', 'Spc.', 'Spec.',
  'Nr.', 'Nrs.', 'nr.', 'nrs.', 'No.', 'Nos.', 'Vol.', 'Vols.', 'vol.', 'vols.',
  'Lib.', 'Fol.', 'Fols.', 'fol.', 'fols.', 'Reg.', 'reg.', 'Inv.', 'inv.',
  'Afd.', 'afd.', 'Blz.', 'blz.', 'Hfdst.', 'Vgl.', 'vgl.',
  'Geb.', 'geb.', 'Ged.', 'ged.', 'Overl.', 'overl.', 'Begr.', 'begr.',
  'Ch.', 'ch.', 'Sec.', 'sec.', 'Par.', 'par.', 'Pars.', 'pars.',
  'Fig.', 'Figs.', 'fig.', 'figs.', 'Art.', 'art.', 'Bk.', 'bk.', 'Pt.', 'pt.', 'Ser.', 'ser.',
  'Ed.', 'Eds.', 'ed.', 'eds.', 'p.', 'pp.', 'c.', 'ca.', 'cf.', 'fl.',
  'abt.', 'bef.', 'aft.', 'est.', 'approx.', 'e.g.', 'i.e.', 'et al.', 'etc.', 'vs.', 'v.', 'viz.',
  'Twp.', 'twp.', 'Co.', 'St.', 'Ste.', 'Ave.', 'Blvd.', 'Rd.', 'Ln.', 'Ct.', 'Pl.', 'Sq.',
  'Dist.', 'Pct.', 'Mt.', 'Ft.', 'Isl.', 'R.F.D.', 'R.R.', 'P.O.', 'Bldg.', 'Dept.', 'Assn.',
  'Bros.', 'Inc.', 'Ltd.', 'Corp.', 'Mfg.',
  'Jan.', 'Feb.', 'Mar.', 'Apr.', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Sept.', 'Oct.', 'Nov.', 'Dec.',
  'JAN.', 'FEB.', 'MAR.', 'APR.', 'JUN.', 'JUL.', 'AUG.', 'SEP.', 'SEPT.', 'OCT.', 'NOV.', 'DEC.',
  'U.S.', 'U.S.A.', 'D.C.', 'Ala.', 'Ariz.', 'Ark.', 'Calif.', 'Colo.', 'Conn.', 'Del.', 'Fla.',
  'Ga.', 'Ill.', 'Ind.', 'Kan.', 'Kans.', 'Ky.', 'La.', 'Mass.', 'Md.', 'Mich.', 'Minn.', 'Miss.',
  'Mo.', 'Mont.', 'N.C.', 'N.D.', 'N.H.', 'N.J.', 'N.M.', 'N.Y.', 'Neb.', 'Nebr.', 'Nev.', 'Okla.',
  'Ore.', 'Oreg.', 'Pa.', 'R.I.', 'S.C.', 'S.D.', 'Tenn.', 'Tex.', 'Va.', 'Vt.', 'W.Va.', 'Wash.',
  'Wis.', 'Wisc.', 'Wyo.', 'Ont.', 'Que.', 'N.S.', 'N.B.',
  'B.C.', 'A.D.', 'a.m.', 'p.m.', 'b.', 'd.', 'm.', 'bur.', 'bap.', 'chr.',
] as const;

const ABBREVIATION_RE = new RegExp(
  `(?<![A-Za-z])(?:${[...ABBREVIATIONS]
    .toSorted((a, b) => b.length - a.length)
    .map((abbr) => abbr.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})`,
  'g'
);
const LOWERCASE_NUMBER_ABBR_RE = /(?<![A-Za-z])nos?\.(?=\s+(?:\d|[IVX]+\b|[A-Za-z]\d))/g;
const CITATION_FOLLOWS_RE = /^["”’')]*\[\^[^\]]+\]/;

export { AUDIT_HELP } from './help.js';

export interface AuditCommandOptions {
  repoDir?: string;
  personId: string;
  packageDir?: string;
  json?: boolean;
}

export interface ParsedAuditEdtf {
  raw: string;
  year: number;
  month: number | null;
  day: number | null;
  precision: 'day' | 'month' | 'year';
  approximate: boolean;
  startMs: number;
  endMs: number;
}

export interface LifespanSummary {
  exact: boolean;
  years: number | null;
  days: number | null;
  totalDays: number | null;
  label: string | null;
}

export interface ChronologyCheckResult {
  ok: boolean;
  birth_edtf: string | null;
  death_edtf: string | null;
  lifespan: LifespanSummary;
  checkedEvents: number;
  errors: string[];
  warnings: string[];
}

export interface PrivacyAndStyleCheckResult {
  ok: boolean;
  livingPeopleChecked: number;
  livingNameHits: Array<{ location: string; match: string }>;
  ssnHits: Array<{ location: string; match: string }>;
  phoneHits: Array<{ location: string; match: string }>;
  emDashCount: number;
  emDashHits: Array<{ location: string; count: number }>;
  errors: string[];
  warnings: string[];
}

export interface UncitedSentenceItem {
  narrative_id: string;
  paragraph: number;
  text: string;
}

export interface CitationsCheckResult {
  ok: boolean;
  totalSentences: number;
  citedSentences: number;
  uncitedCount: number;
  uncitedSentences: UncitedSentenceItem[];
}

export interface InspectedImageHeader {
  valid: boolean;
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'unknown';
  width: number | null;
  height: number | null;
  error: string | null;
}

export interface AuditedScanFile {
  media_id: string | null;
  file: string;
  disk_path: string;
  source: 'package_scans' | 'repo_media' | 'unreferenced_scan';
  format: InspectedImageHeader['format'];
  width: number | null;
  height: number | null;
  bytes: number;
  kb: number;
  valid: boolean;
}

export interface ScansCheckResult {
  ok: boolean;
  checkedCount: number;
  unreferencedScans: string[];
  files: AuditedScanFile[];
  errors: string[];
  warnings: string[];
}

export interface DryRunCheckResult {
  ok: boolean;
  durationMs: number;
  inlineCitationCount: number;
  reviewFlags: number;
  livingLeaks: number | null;
  counts: IntegrateCommandResult['counts'] | null;
  error: string | null;
}

export interface AuditCommandResult {
  ok: boolean;
  strictOk: boolean;
  repo: string;
  person_id: string;
  package_dir: string;
  duration_ms: number;
  zeroCoordinatePlaces: string[];
  hygieneWarnings: TreeHygieneWarning[];
  checks: {
    chronology: ChronologyCheckResult;
    privacy: PrivacyAndStyleCheckResult;
    citations: CitationsCheckResult;
    scans: ScansCheckResult;
    dryRun: DryRunCheckResult;
  };
  errors: string[];
  warnings: string[];
  rendered: string;
}

interface LooseRecord {
  [key: string]: unknown;
}

function isPlainRecord(value: unknown): value is LooseRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

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
    const years =
      new Date(death.endMs).getUTCFullYear() - new Date(birth.startMs).getUTCFullYear();
    return {
      exact: false,
      years,
      days: null,
      totalDays: null,
      label: `~${years} years`,
    };
  }
  if (
    birth.precision === 'day' &&
    death.precision === 'day' &&
    birth.month !== null &&
    birth.day !== null
  ) {
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
  const normalizedRole = role.trim().toLowerCase().replaceAll(/[\s-]+/g, '_');
  const isPassivePostMortemRole = POST_MORTEM_PASSIVE_ROLES.has(normalizedRole);
  const isPreBirthContext = PRE_BIRTH_CONTEXT_RE.test(textBlob);
  const isCensus = CENSUS_RE.test(`${evId} ${asString(ev.title)}`);
  const isMarriage = MARRIAGE_RE.test(`${evId} ${asString(ev.event_kind)} ${asString(ev.title)}`);

  const birthMinMs = birth ? auditLowerMs(birth) : null;
  const deathMaxMs = death ? auditUpperMs(death) : null;

  if (birth && birthMinMs !== null && dt.endMs < birthMinMs) {
    if (isCensus) {
      if (!isPreBirthContext) {
        errors.push(`${labelPrefix}Event ${evId} (${dt.raw}): census predates birth (${birth.raw}) without context label.`);
      } else {
        warnings.push(`${labelPrefix}Event ${evId} (${dt.raw}): labeled pre-birth census context before birth (${birth.raw}).`);
      }
    } else if (isPreBirthContext) {
      warnings.push(`${labelPrefix}Event ${evId} (${dt.raw}): pre-birth family context before birth (${birth.raw}).`);
    } else {
      errors.push(`${labelPrefix}Event ${evId} (${dt.raw}): predates birth (${birth.raw}).`);
    }
  }

  if (death && deathMaxMs !== null && dt.startMs > deathMaxMs && !isPassivePostMortemRole) {
    if (isCensus) {
      if (!isPostMortemAllowed) {
        errors.push(`${labelPrefix}Event ${evId} (${dt.raw}): census postdates death (${death.raw}) without explicit posthumous/widow label.`);
      } else {
        warnings.push(`${labelPrefix}Event ${evId} (${dt.raw}): labeled post-mortem census entry after death (${death.raw}).`);
      }
    } else if (!isPostMortemAllowed) {
      errors.push(`${labelPrefix}Event ${evId} (${dt.raw}): postdates death (${death.raw}) and is not a burial/probate/obituary/memorial event.`);
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
        errors.push(`${labelPrefix}Event ${evId} (${dt.raw}): marriage at implausible age ${ageAtEvent} (birth ${birth.raw}).`);
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
    if (
      stagedLifespan.years !== null &&
      (stagedLifespan.years < 0 || stagedLifespan.years > 118)
    ) {
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

export interface PrivacyScanDateContext {
  targetPerson?: LooseRecord | null;
  allPeople?: readonly LooseRecord[];
  liveEvents?: readonly LooseRecord[];
}

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

function stringListField(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
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
    (patchPersonId ? allPeople.find((person) => person.id === patchPersonId) ?? null : null);
  const targetId =
    typeof targetPerson?.id === 'string' && targetPerson.id ? targetPerson.id : patchPersonId;
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
    !targetIsLiving && targetDeathYear !== null
      ? targetDeathYear + NARRATIVE_POSTHUMOUS_HORIZON_YEARS
      : null;

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
  const sourceMaxYearById = computeSourceMaxYearById([
    ...mergedEventsById.values(),
    ...anonymousPatchEvents,
  ]);

  const livingNameTargets: LivingNameTarget[] = [];

  const scanTarget = (
    label: string,
    text: string,
    maxYear: number | null,
    checkEmDash: boolean
  ): void => {
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
            (stagedId ? deathYearByPersonId.get(stagedId) ?? null : null);
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
            (linkedEventId ? eventMaxYearById.get(linkedEventId) ?? null : null);
        }
        collectStringsWithPath(rawItem, `patch.media[${i}]`, mediaMaxYear, patchStrings);
      }
      continue;
    }
    if (key === 'sources' && Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const rawSource = value[i];
        const sourceId =
          isPlainRecord(rawSource) && typeof rawSource.id === 'string' ? rawSource.id : '';
        const sourceMaxYear = sourceId ? sourceMaxYearById.get(sourceId) ?? null : null;
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
                typeof rawNarrative.subject_person_id === 'string'
                  ? rawNarrative.subject_person_id
                  : null,
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
      item.path.endsWith('.body_md') ||
      item.path.endsWith('.biography') ||
      item.path.endsWith('.bio');
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

export function splitParagraphIntoSentences(paragraph: string): string[] {
  let protectedText = paragraph.replaceAll(/\s+/g, ' ').trim();
  if (!protectedText) {
    return [];
  }

  // Mask punctuation inside inline code spans (e.g. gravestone text `AUG. 29, 1926`).
  protectedText = protectedText.replaceAll(/`[^`]+`/g, (m) =>
    m.replaceAll('.', '\u0001').replaceAll('!', '\u0002').replaceAll('?', '\u0003')
  );

  // Mask abbreviations without hiding a final period that ends a cited sentence.
  const maskAbbreviation = (match: string, offset: number, full: string): string => {
    const after = full.slice(offset + match.length);
    if (CITATION_FOLLOWS_RE.test(after) && match.endsWith('.')) {
      return `${match.slice(0, -1).replaceAll('.', '\u0001')}.`;
    }
    return match.replaceAll('.', '\u0001');
  };
  protectedText = protectedText.replaceAll(ABBREVIATION_RE, maskAbbreviation);
  protectedText = protectedText.replaceAll(LOWERCASE_NUMBER_ABBR_RE, maskAbbreviation);
  protectedText = protectedText.replaceAll(
    /(?<![A-Za-z])([A-Z])\.(?=\s+[A-Za-z&(])/g,
    '$1\u0001'
  );

  // Keep inline citation tokens attached to the preceding sentence punctuation.
  const rawParts = protectedText.split(
    /(?<=[.!?]["”’')]*?(?:\[\^[^\]]+\])*)\s+(?=[A-Z0-9"“‘'([]|[^a-z\s])/
  );

  return rawParts
    .map((s) =>
      s.replaceAll('\u0001', '.').replaceAll('\u0002', '!').replaceAll('\u0003', '?').trim()
    )
    .filter((s) => s.length > 0);
}

export function runUncitedSentenceCheck(patch: LooseRecord): CitationsCheckResult {
  const narratives = Array.isArray(patch.narratives) ? patch.narratives : [];
  let totalSentences = 0;
  let citedSentences = 0;
  const uncitedSentences: UncitedSentenceItem[] = [];

  for (const rawNar of narratives) {
    if (!isPlainRecord(rawNar)) {
      continue;
    }
    const body = typeof rawNar.body_md === 'string' ? rawNar.body_md : '';
    if (!body) {
      continue;
    }
    const narId = typeof rawNar.id === 'string' ? rawNar.id : 'unknown';

    const withoutCode = body.replaceAll(/```[\s\S]*?```/g, '\n');
    const lines = withoutCode.replaceAll('\r\n', '\n').split('\n');

    const proseParagraphs: string[] = [];
    let current: string[] = [];
    const flush = (): void => {
      if (current.length > 0) {
        proseParagraphs.push(current.join(' ').trim());
        current = [];
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        flush();
        continue;
      }
      if (
        /^#{1,6}\s/.test(line) ||
        line.startsWith('>') ||
        /^[-*_]{3,}$/.test(line) ||
        line.startsWith('|') ||
        /^\[\^[^\]]+\]:/.test(line) ||
        line.startsWith('![')
      ) {
        flush();
        continue;
      }
      if (/^(?:[-*+]|\d+[.)])\s/.test(line)) {
        flush();
        const stripped = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim();
        if (
          stripped.endsWith(':') ||
          !/[.!?](?:\[\^[^\]]+\])*$/.test(stripped) ||
          stripped.length < 40
        ) {
          continue;
        }
        proseParagraphs.push(stripped);
        continue;
      }
      if (/^\*\*[^*]+\*\*:?$/.test(line)) {
        flush();
        continue;
      }
      current.push(line);
    }
    flush();

    for (let pIdx = 0; pIdx < proseParagraphs.length; pIdx += 1) {
      const sentences = splitParagraphIntoSentences(proseParagraphs[pIdx]);
      for (const sentence of sentences) {
        if (sentence.split(/\s+/).length < 4) {
          continue;
        }
        totalSentences += 1;
        if (INLINE_CITATION_RE.test(sentence)) {
          citedSentences += 1;
        } else {
          uncitedSentences.push({
            narrative_id: narId,
            paragraph: pIdx + 1,
            text: sentence.length > 220 ? `${sentence.slice(0, 217)}...` : sentence,
          });
        }
      }
    }
  }

  return {
    ok: uncitedSentences.length === 0,
    totalSentences,
    citedSentences,
    uncitedCount: uncitedSentences.length,
    uncitedSentences,
  };
}

export function inspectImageBuffer(buf: Buffer): InspectedImageHeader {
  if (buf.length < 12) {
    return { valid: false, format: 'unknown', width: null, height: null, error: 'file too short' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR width/height at offsets 16..24.
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    if (buf.length < 24) {
      return { valid: false, format: 'png', width: null, height: null, error: 'truncated PNG IHDR' };
    }
    return {
      valid: true,
      format: 'png',
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      error: null,
    };
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    let offset = 2;
    while (offset + 4 < buf.length) {
      while (offset < buf.length && buf[offset] !== 0xff) {
        offset += 1;
      }
      while (offset < buf.length && buf[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= buf.length) {
        break;
      }
      const marker = buf[offset];
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) {
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (offset + 2 > buf.length) {
        break;
      }
      const segLen = buf.readUInt16BE(offset);
      if (segLen < 2 || offset + segLen > buf.length) {
        break;
      }
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && segLen >= 7) {
        const height = buf.readUInt16BE(offset + 3);
        const width = buf.readUInt16BE(offset + 5);
        return { valid: true, format: 'jpeg', width, height, error: null };
      }
      offset += segLen;
    }
    return { valid: true, format: 'jpeg', width: null, height: null, error: null };
  }

  // WebP: RIFF....WEBP
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunk = buf.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X' && buf.length >= 30) {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { valid: true, format: 'webp', width, height, error: null };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      return { valid: true, format: 'webp', width, height, error: null };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return { valid: true, format: 'webp', width, height, error: null };
    }
    return { valid: true, format: 'webp', width: null, height: null, error: null };
  }

  // GIF87a / GIF89a
  const sig6 = buf.subarray(0, 6).toString('ascii');
  if ((sig6 === 'GIF87a' || sig6 === 'GIF89a') && buf.length >= 10) {
    return {
      valid: true,
      format: 'gif',
      width: buf.readUInt16LE(6),
      height: buf.readUInt16LE(8),
      error: null,
    };
  }

  return {
    valid: false,
    format: 'unknown',
    width: null,
    height: null,
    error: 'unrecognized image magic header',
  };
}

export function runScanInventoryCheck(
  repoDir: string,
  packageDir: string,
  patch: LooseRecord
): ScansCheckResult {
  const scansDir = path.join(packageDir, 'scans');
  const archiveMediaRoot = path.join(repoDir, 'archive-media');
  const hasArchiveMedia =
    fs.existsSync(archiveMediaRoot) && fs.statSync(archiveMediaRoot).isDirectory();
  const mediaRoot = hasArchiveMedia ? archiveMediaRoot : repoDir;

  const errors: string[] = [];
  const warnings: string[] = [];
  const files: AuditedScanFile[] = [];
  const checkedPaths = new Set<string>();

  const inspectFile = (
    diskPath: string,
    mediaId: string | null,
    fileUrl: string | null,
    source: AuditedScanFile['source']
  ): void => {
    const resolved = path.resolve(diskPath);
    if (checkedPaths.has(resolved)) {
      return;
    }
    checkedPaths.add(resolved);
    if (!fs.existsSync(resolved)) {
      errors.push(`Missing scan file for ${mediaId ?? 'scans/'}: ${fileUrl ?? resolved}`);
      return;
    }
    const stat = fs.statSync(resolved);
    if (stat.size === 0) {
      errors.push(`Empty (0 byte) scan file: ${resolved}`);
      return;
    }
    const fd = fs.openSync(resolved, 'r');
    const readLen = Math.min(stat.size, 65_536);
    const buf = Buffer.allocUnsafe(readLen);
    try {
      fs.readSync(fd, buf, 0, readLen, 0);
    } finally {
      fs.closeSync(fd);
    }
    const info = inspectImageBuffer(buf);
    if (!info.valid) {
      errors.push(`Invalid image file (${info.error}): ${resolved}`);
    }
    if (stat.size < MIN_SCAN_WARN_BYTES) {
      warnings.push(`Tiny scan (< 10 KB, ${stat.size} bytes): ${path.basename(resolved)}`);
    } else if (stat.size > MAX_SCAN_WARN_BYTES) {
      warnings.push(
        `Huge scan (> 10 MB, ${(stat.size / (1024 * 1024)).toFixed(1)} MB): ${path.basename(resolved)}`
      );
    }
    files.push({
      media_id: mediaId,
      file: fileUrl ?? path.basename(resolved),
      disk_path: resolved,
      source,
      format: info.format,
      width: info.width,
      height: info.height,
      bytes: stat.size,
      kb: Number((stat.size / 1024).toFixed(1)),
      valid: info.valid,
    });
  };

  const referencedBasenames = new Set<string>();
  for (const rawItem of Array.isArray(patch.media) ? patch.media : []) {
    const item = isPlainRecord(rawItem) ? rawItem : {};
    const mediaId = typeof item.id === 'string' ? item.id : null;
    const fileUrl = typeof item.file === 'string' ? item.file : null;
    if (!fileUrl) {
      errors.push(`Media entry '${mediaId ?? 'unknown'}' missing 'file' field.`);
      continue;
    }
    const base = path.basename(fileUrl);
    referencedBasenames.add(base);
    const stagedCandidate = path.join(scansDir, base);
    const repoCandidate = path.resolve(mediaRoot, ...fileUrl.replace(/^\/+/, '').split('/'));
    if (fs.existsSync(stagedCandidate)) {
      inspectFile(stagedCandidate, mediaId, fileUrl, 'package_scans');
    } else if (fs.existsSync(repoCandidate)) {
      inspectFile(repoCandidate, mediaId, fileUrl, 'repo_media');
    } else {
      errors.push(
        `Missing scan for media '${mediaId ?? 'unknown'}': '${fileUrl}' not found in scans/ or repo media.`
      );
    }
  }

  const unreferencedScans: string[] = [];
  if (fs.existsSync(scansDir) && fs.statSync(scansDir).isDirectory()) {
    const entries = fs
      .readdirSync(scansDir, { withFileTypes: true })
      .toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        errors.push(`Forbidden subdirectory inside scans/: ${entry.name}`);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const fullPath = path.join(scansDir, entry.name);
      if (!referencedBasenames.has(entry.name)) {
        unreferencedScans.push(entry.name);
        warnings.push(`Unreferenced file in scans/: ${entry.name}`);
        inspectFile(fullPath, null, entry.name, 'unreferenced_scan');
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedCount: files.length,
    unreferencedScans,
    files,
    errors,
    warnings,
  };
}

function isKinshipRelation(value: string): value is KinshipEdge['relation'] {
  return value === 'parent' || value === 'child' || value === 'spouse';
}

function toHygienePerson(record: LooseRecord): RawPerson | null {
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) {
    return null;
  }
  return {
    id,
    slug: typeof record.slug === 'string' && record.slug.trim() ? record.slug.trim() : id,
    full_name: asString(record.full_name).trim() || id,
    given_name: asString(record.given_name).trim(),
    surname: asString(record.surname).trim(),
    alt_names: stringListField(record.alt_names),
    sex: asString(record.sex).trim() || 'U',
    is_living: record.is_living === true || record.living === true,
    lineage_group: asString(record.lineage_group).trim() || 'extended',
    birth_edtf: asString(record.birth_edtf ?? record.birth_date).trim(),
    death_edtf: asString(record.death_edtf ?? record.death_date).trim(),
    portrait_url: typeof record.portrait_url === 'string' ? record.portrait_url : null,
    ...(isPlainRecord(record.extensions) ? { extensions: structuredClone(record.extensions) } : {}),
  };
}

function applyPersonFieldsForHygiene(existing: RawPerson, patchFields: LooseRecord): RawPerson {
  const next: RawPerson = {
    ...existing,
    ...(existing.extensions ? { extensions: structuredClone(existing.extensions) } : {}),
  };
  if (typeof patchFields.full_name === 'string' && patchFields.full_name.trim()) {
    next.full_name = patchFields.full_name.trim();
  }
  if (typeof patchFields.sex === 'string' && patchFields.sex.trim()) {
    next.sex = patchFields.sex.trim();
  }
  if (typeof patchFields.lineage_group === 'string' && patchFields.lineage_group.trim()) {
    next.lineage_group = patchFields.lineage_group.trim();
  }
  if (patchFields.birth_edtf !== undefined || patchFields.birth_date !== undefined) {
    next.birth_edtf = asString(patchFields.birth_edtf ?? patchFields.birth_date).trim();
  }
  if (patchFields.death_edtf !== undefined || patchFields.death_date !== undefined) {
    next.death_edtf = asString(patchFields.death_edtf ?? patchFields.death_date).trim();
  }
  if (isPlainRecord(patchFields.extensions)) {
    next.extensions = {
      ...next.extensions,
      ...structuredClone(patchFields.extensions),
    };
  }
  return next;
}

function extractHygieneParticipants(raw: unknown): RawEvent['participants'] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: RawEvent['participants'] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const personId = typeof item.person_id === 'string' ? item.person_id.trim() : '';
    if (!personId) {
      continue;
    }
    out.push({
      person_id: personId,
      role: asString(item.role).trim(),
    });
  }
  return out;
}

function mergeHygieneParticipants(
  existing: readonly RawEvent['participants'][number][],
  incoming: readonly RawEvent['participants'][number][]
): RawEvent['participants'] {
  const incomingPersonIds = new Set(incoming.map((participant) => participant.person_id));
  const out: RawEvent['participants'] = [];
  const seen = new Set<string>();
  const pushUnique = (participant: RawEvent['participants'][number]): void => {
    const key = `${participant.person_id}|${participant.role}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ person_id: participant.person_id, role: participant.role });
    }
  };
  for (const participant of existing) {
    if (!incomingPersonIds.has(participant.person_id)) {
      pushUnique(participant);
    }
  }
  for (const participant of incoming) {
    pushUnique(participant);
  }
  return out;
}

function toHygieneEvent(record: LooseRecord): RawEvent | null {
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  if (!id) {
    return null;
  }
  return {
    id,
    title: asString(record.title),
    scope: 'personal',
    event_kind: 'point_event',
    ...(typeof record.category === 'string' ? { category: record.category } : {}),
    edtf_date: asString(record.edtf_date).trim(),
    place_id: typeof record.place_id === 'string' ? record.place_id : null,
    summary: asString(record.summary),
    participants: extractHygieneParticipants(record.participants),
    sources: [],
  };
}

function toHygieneRemoveKinship(record: LooseRecord): RemoveKinshipEntry | null {
  const from = typeof record.from === 'string' ? record.from.trim() : '';
  const to = typeof record.to === 'string' ? record.to.trim() : '';
  const rawRelation = typeof record.relation === 'string' ? record.relation.trim() : '';
  if (!from || !to || !isKinshipRelation(rawRelation)) {
    return null;
  }
  const familyXref =
    typeof record.family_xref === 'string' && record.family_xref.trim().length > 0
      ? record.family_xref.trim()
      : undefined;
  const symmetric = typeof record.symmetric === 'boolean' ? record.symmetric : true;
  return {
    from,
    to,
    relation: rawRelation,
    ...(familyXref !== undefined ? { family_xref: familyXref } : {}),
    symmetric,
  };
}

function toHygieneKinship(record: LooseRecord): KinshipEdge | null {
  const from = typeof record.from === 'string' ? record.from.trim() : '';
  const to = typeof record.to === 'string' ? record.to.trim() : '';
  const rawRelation = typeof record.relation === 'string' ? record.relation.trim() : '';
  if (!from || !to || !isKinshipRelation(rawRelation)) {
    return null;
  }
  return {
    from,
    to,
    relation: rawRelation,
    ...(typeof record.family_xref === 'string'
      ? { family_xref: record.family_xref }
      : record.family_xref === null
        ? { family_xref: null }
        : {}),
  };
}

export function runAuditHygieneRegressionCheck(input: {
  personId: string;
  patch: LooseRecord;
  livePeople: readonly LooseRecord[];
  liveEvents: readonly LooseRecord[];
  liveKinship: readonly LooseRecord[];
}): TreeHygieneWarning[] {
  const prePeople: RawPerson[] = [];
  for (const raw of input.livePeople) {
    const person = toHygienePerson(raw);
    if (person) {
      prePeople.push(person);
    }
  }
  const preEvents: RawEvent[] = [];
  for (const raw of input.liveEvents) {
    const event = toHygieneEvent(raw);
    if (event) {
      preEvents.push(event);
    }
  }
  const preKinship: KinshipEdge[] = [];
  for (const raw of input.liveKinship) {
    const edge = toHygieneKinship(raw);
    if (edge) {
      preKinship.push(edge);
    }
  }

  const touchedPersonIds = new Set<string>([input.personId]);
  const touchedEventIds = new Set<string>();

  const postPeopleMap = new Map<string, RawPerson>(
    prePeople.map((person) => [person.id, structuredClone(person)])
  );
  for (const rawPerson of Array.isArray(input.patch.people) ? input.patch.people : []) {
    if (!isPlainRecord(rawPerson) || typeof rawPerson.id !== 'string' || !rawPerson.id.trim()) {
      continue;
    }
    const stagedId = rawPerson.id.trim();
    touchedPersonIds.add(stagedId);
    const existing = postPeopleMap.get(stagedId);
    if (existing) {
      if (!existing.is_living) {
        postPeopleMap.set(stagedId, applyPersonFieldsForHygiene(existing, rawPerson));
      }
    } else {
      const created = toHygienePerson(rawPerson);
      if (created) {
        postPeopleMap.set(stagedId, created);
      }
    }
  }
  const updates = isPlainRecord(input.patch.person_updates) ? input.patch.person_updates : null;
  if (updates) {
    const existingTarget = postPeopleMap.get(input.personId);
    if (existingTarget && !existingTarget.is_living) {
      postPeopleMap.set(input.personId, applyPersonFieldsForHygiene(existingTarget, updates));
    }
  }

  const postEventsMap = new Map<string, RawEvent>(
    preEvents.map((event) => [event.id, structuredClone(event)])
  );
  for (const rawEv of Array.isArray(input.patch.events) ? input.patch.events : []) {
    if (!isPlainRecord(rawEv) || typeof rawEv.id !== 'string' || !rawEv.id.trim()) {
      continue;
    }
    const evId = rawEv.id.trim();
    touchedEventIds.add(evId);
    const incomingParticipants = extractHygieneParticipants(rawEv.participants);
    for (const participant of incomingParticipants) {
      touchedPersonIds.add(participant.person_id);
    }
    const existing = postEventsMap.get(evId);
    if (existing) {
      const mergedParticipants = mergeHygieneParticipants(
        existing.participants,
        incomingParticipants
      );
      for (const participant of mergedParticipants) {
        touchedPersonIds.add(participant.person_id);
      }
      postEventsMap.set(evId, {
        ...existing,
        ...(typeof rawEv.title === 'string' ? { title: rawEv.title } : {}),
        ...(rawEv.edtf_date !== undefined ? { edtf_date: asString(rawEv.edtf_date).trim() } : {}),
        ...(typeof rawEv.category === 'string' || rawEv.category === null
          ? { category: rawEv.category }
          : {}),
        participants: mergedParticipants,
      });
    } else {
      const created = toHygieneEvent(rawEv);
      if (created) {
        postEventsMap.set(evId, created);
      }
    }
  }
  for (const rawId of Array.isArray(input.patch.remove_event_ids)
    ? input.patch.remove_event_ids
    : []) {
    if (typeof rawId === 'string' && rawId.trim()) {
      const trimmed = rawId.trim();
      touchedEventIds.add(trimmed);
      postEventsMap.delete(trimmed);
    }
  }

  const removeKinshipEntries: RemoveKinshipEntry[] = [];
  for (const rawEntry of Array.isArray(input.patch.remove_kinship)
    ? input.patch.remove_kinship
    : []) {
    if (!isPlainRecord(rawEntry)) {
      continue;
    }
    const entry = toHygieneRemoveKinship(rawEntry);
    if (!entry) {
      continue;
    }
    touchedPersonIds.add(entry.from);
    touchedPersonIds.add(entry.to);
    removeKinshipEntries.push(entry);
  }

  const stagedKinshipEdges: KinshipEdge[] = [];
  for (const rawEdge of Array.isArray(input.patch.kinship) ? input.patch.kinship : []) {
    if (!isPlainRecord(rawEdge)) {
      continue;
    }
    const edge = toHygieneKinship(rawEdge);
    if (!edge) {
      continue;
    }
    touchedPersonIds.add(edge.from);
    touchedPersonIds.add(edge.to);
    stagedKinshipEdges.push(edge);
  }

  const { remaining: kinshipAfterRemovals } = applyKinshipRemovals(
    preKinship,
    removeKinshipEntries,
    stagedKinshipEdges
  );
  const postKinshipMap = new Map<string, KinshipEdge>(
    kinshipAfterRemovals.map((edge) => [
      `${edge.from}|${edge.to}|${edge.relation}`,
      structuredClone(edge),
    ])
  );
  for (const edge of stagedKinshipEdges) {
    const key = `${edge.from}|${edge.to}|${edge.relation}`;
    const existing = postKinshipMap.get(key);
    postKinshipMap.set(key, {
      ...(existing ?? edge),
      ...edge,
      family_xref: edge.family_xref !== undefined ? edge.family_xref : existing?.family_xref,
    });
  }

  const preHygiene = analyzeTreeHygiene({
    people: prePeople,
    events: preEvents,
    kinship: preKinship,
  });
  const postHygiene = analyzeTreeHygiene({
    people: [...postPeopleMap.values()],
    events: [...postEventsMap.values()],
    kinship: [...postKinshipMap.values()],
  });

  return diffTreeHygieneWarnings({
    preWarnings: preHygiene.warnings,
    postWarnings: postHygiene.warnings,
    touchedPersonIds,
    touchedEventIds,
  });
}

function countZeroCoordPlaces(patch: LooseRecord): string[] {
  const bad: string[] = [];
  for (const rawPl of Array.isArray(patch.places) ? patch.places : []) {
    const pl = isPlainRecord(rawPl) ? rawPl : {};
    const lat = Number(pl.lat);
    const lng = Number(pl.lng ?? pl.lon);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      (Math.abs(lat) < 1e-9 && Math.abs(lng) < 1e-9)
    ) {
      bad.push(typeof pl.id === 'string' ? pl.id : 'unknown');
    }
  }
  return bad;
}

export function formatAuditTextReport(report: Omit<AuditCommandResult, 'rendered'>): string {
  const lines: string[] = [];
  const status = report.ok ? 'PASS' : 'FAIL';
  lines.push(`Audit [${status}] ${report.person_id} (${report.duration_ms} ms)`);
  lines.push(`  Repo: ${report.repo}`);
  lines.push(
    `  1. Chronology: ${report.checks.chronology.ok ? 'PASS' : 'FAIL'} | ` +
      `${report.checks.chronology.birth_edtf ?? '?'} .. ${report.checks.chronology.death_edtf ?? '?'} ` +
      `(${report.checks.chronology.lifespan.label ?? 'unknown'}) | ` +
      `events=${report.checks.chronology.checkedEvents} errors=${report.checks.chronology.errors.length} warnings=${report.checks.chronology.warnings.length}`
  );
  lines.push(
    `  2. Privacy/Style: ${report.checks.privacy.ok ? 'PASS' : 'FAIL'} | ` +
      `livingHits=${report.checks.privacy.livingNameHits.length} ssn=${report.checks.privacy.ssnHits.length} ` +
      `phones=${report.checks.privacy.phoneHits.length} emDashes=${report.checks.privacy.emDashCount}`
  );
  lines.push(
    `  3. Citations: ${report.checks.citations.ok ? 'PASS' : 'WARN'} | ` +
      `cited=${report.checks.citations.citedSentences}/${report.checks.citations.totalSentences} ` +
      `uncited=${report.checks.citations.uncitedCount} inlineTokens=${report.checks.dryRun.inlineCitationCount}`
  );
  lines.push(
    `  4. Scans: ${report.checks.scans.ok ? 'PASS' : 'FAIL'} | ` +
      `checked=${report.checks.scans.checkedCount} errors=${report.checks.scans.errors.length} warnings=${report.checks.scans.warnings.length}`
  );
  lines.push(
    `  5. Dry-Run: ${report.checks.dryRun.ok ? 'PASS' : 'FAIL'} (${report.checks.dryRun.durationMs} ms) | ` +
      `reviewFlags=${report.checks.dryRun.reviewFlags} livingLeaks=${report.checks.dryRun.livingLeaks} zeroCoordPlaces=${report.zeroCoordinatePlaces.length}`
  );
  for (const err of report.errors) {
    lines.push(`  ERROR: ${err}`);
  }
  for (const warn of report.warnings) {
    lines.push(`  WARN: ${warn}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runInProcessIntegrateDryRun(params: {
  repoDir: string;
  personId: string;
  packageDir: string;
}): Promise<DryRunCheckResult> {
  const t0 = performance.now();
  try {
    const res = await runIntegrateCommand({
      repoDir: params.repoDir,
      personId: params.personId,
      packageDir: params.packageDir,
      dryRun: true,
    });
    return {
      ok: res.ok,
      durationMs: Math.round(performance.now() - t0),
      inlineCitationCount: res.inlineCitationCount,
      reviewFlags: res.validation.privateReviewFlags + res.validation.publicReviewFlags,
      livingLeaks: res.validation.livingLeaks,
      counts: res.counts,
      error: null,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      durationMs: Math.round(performance.now() - t0),
      inlineCitationCount: 0,
      reviewFlags: 0,
      livingLeaks: null,
      counts: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runAuditCommand(options: AuditCommandOptions): Promise<AuditCommandResult> {
  const t0 = performance.now();
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const personId = options.personId.trim();
  if (!personId) {
    throw new CliValidationError('Missing required option `--person <person_id>`.');
  }
  if (!SAFE_PERSON_ID_RE.test(personId)) {
    throw new CliValidationError(`Invalid person_id '${personId}'.`);
  }

  const packageDir = path.resolve(
    options.packageDir?.trim() || path.join(repoDir, 'research', 'people', personId)
  );
  const patchPath = path.join(packageDir, 'patch.json');
  const dossierPath = path.join(packageDir, 'dossier.md');
  if (!fs.existsSync(patchPath)) {
    throw new CliValidationError(`Missing patch.json at ${patchPath}.`);
  }

  const dataDir = path.join(repoDir, 'data');
  const peoplePath = path.join(dataDir, 'people.yaml');
  if (!fs.existsSync(peoplePath)) {
    throw new CliValidationError(`Missing data/people.yaml at ${peoplePath}.`);
  }

  const [patchText, dossierText, peopleText, eventsText, kinshipText, configText] = await Promise.all([
    readFile(patchPath, 'utf8'),
    fs.existsSync(dossierPath) ? readFile(dossierPath, 'utf8') : Promise.resolve(''),
    readFile(peoplePath, 'utf8'),
    fs.existsSync(path.join(dataDir, 'events.yaml'))
      ? readFile(path.join(dataDir, 'events.yaml'), 'utf8')
      : Promise.resolve(''),
    fs.existsSync(path.join(dataDir, 'kinship.yaml'))
      ? readFile(path.join(dataDir, 'kinship.yaml'), 'utf8')
      : Promise.resolve(''),
    fs.existsSync(path.join(repoDir, 'kinloom.config.yaml'))
      ? readFile(path.join(repoDir, 'kinloom.config.yaml'), 'utf8')
      : Promise.resolve(''),
  ]);

  const parsedPatch: unknown = JSON.parse(patchText);
  if (!isPlainRecord(parsedPatch)) {
    throw new CliValidationError(`patch.json at ${patchPath} must contain a JSON object.`);
  }
  const patch = parsedPatch;

  const privacyConfig: Partial<PrivacyConfig> = configText
    ? parseKinloomConfigYaml(configText).privacy
    : {};

  const peopleBlocks = splitTopLevelYamlList(peopleText);
  const parsedPeople = parseMatchingYamlBlocks(peopleBlocks);

  const isEffectiveLivingPerson = (person: LooseRecord): boolean => {
    if (person.is_living === true || person.living === true) {
      return true;
    }
    return resolveEffectiveLiving(
      {
        is_living: false,
        birth_edtf: asString(person.birth_edtf).trim(),
        death_edtf: asString(person.death_edtf).trim(),
      },
      privacyConfig
    );
  };

  const stagedPeopleById = new Map<string, LooseRecord>();
  for (const rawPerson of Array.isArray(patch.people) ? patch.people : []) {
    if (!isPlainRecord(rawPerson) || typeof rawPerson.id !== 'string' || !rawPerson.id.trim()) {
      continue;
    }
    stagedPeopleById.set(rawPerson.id.trim(), rawPerson);
  }

  const personUpdates = isPlainRecord(patch.person_updates) ? patch.person_updates : null;
  let targetDeathUpdate: string | null = null;
  if (personUpdates) {
    const hasConflict =
      personUpdates.death_edtf !== undefined &&
      personUpdates.death_date !== undefined &&
      String(personUpdates.death_edtf) !== String(personUpdates.death_date);
    if (!hasConflict) {
      const rawDeath =
        personUpdates.death_edtf !== undefined
          ? personUpdates.death_edtf
          : personUpdates.death_date;
      targetDeathUpdate = parseValidDeathEdtf(rawDeath);
    }
  }

  const mergedAuditPeople: LooseRecord[] = [];
  const seenAuditPersonIds = new Set<string>();
  for (const person of parsedPeople) {
    const id = typeof person.id === 'string' ? person.id : '';
    if (id) {
      seenAuditPersonIds.add(id);
    }
    const explicitlyLiving = person.is_living === true || person.living === true;
    let effectivePerson: LooseRecord = person;
    if (id === personId && !explicitlyLiving && targetDeathUpdate !== null) {
      const candidate = { ...person, death_edtf: targetDeathUpdate };
      if (!isEffectiveLivingPerson(candidate)) {
        effectivePerson = candidate;
      }
    }
    const staged = id ? stagedPeopleById.get(id) : undefined;
    if (staged && !isEffectiveLivingPerson(effectivePerson)) {
      mergedAuditPeople.push({ ...effectivePerson, ...staged });
    } else {
      mergedAuditPeople.push(effectivePerson);
    }
  }
  for (const [id, stagedPerson] of stagedPeopleById) {
    if (!seenAuditPersonIds.has(id)) {
      mergedAuditPeople.push(stagedPerson);
    }
  }

  const targetPerson = mergedAuditPeople.find((p) => p.id === personId) ?? null;

  const livingPeople = parsedPeople.filter(
    (person) => person.id !== personId && isEffectiveLivingPerson(person)
  );
  const deceasedPeople = mergedAuditPeople.filter((person) => !isEffectiveLivingPerson(person));

  const allLiveEvents = parseMatchingYamlBlocks(splitTopLevelYamlList(eventsText));
  const allLiveKinship = kinshipText
    ? parseMatchingYamlBlocks(splitTopLevelYamlList(kinshipText))
    : [];
  const existingPersonEvents = allLiveEvents.filter(
    (ev) =>
      Array.isArray(ev.participants) &&
      ev.participants.some((pt) => isPlainRecord(pt) && pt.person_id === personId)
  );

  const chronology = runChronologyCheck(targetPerson, patch, existingPersonEvents);
  const hygieneWarnings = runAuditHygieneRegressionCheck({
    personId,
    patch,
    livePeople: parsedPeople,
    liveEvents: allLiveEvents,
    liveKinship: allLiveKinship,
  });
  const privacy = runPrivacyAndStyleScan(dossierText, patch, livingPeople, deceasedPeople, {
    targetPerson,
    allPeople: mergedAuditPeople,
    liveEvents: allLiveEvents,
  });
  const citations = runUncitedSentenceCheck(patch);
  const scans = runScanInventoryCheck(repoDir, packageDir, patch);
  const zeroCoordinatePlaces = countZeroCoordPlaces(patch);
  const dryRun = await runInProcessIntegrateDryRun({ repoDir, personId, packageDir });

  const allErrors: string[] = [
    ...chronology.errors.map((e) => `chronology: ${e}`),
    ...privacy.errors.map((e) => `privacy: ${e}`),
    ...scans.errors.map((e) => `scans: ${e}`),
    ...zeroCoordinatePlaces.map((id) => `places: zero or missing coordinates on '${id}'`),
    ...(dryRun.error ? [`dryRun: ${dryRun.error}`] : []),
  ];
  const liveMediaFileCollisions = collectLiveMediaCollisions(
    [{ personId, media: readStagedMediaRefs(patch.media) }],
    loadLiveMedia(repoDir)
  );
  const liveMediaWarnings = liveMediaFileCollisions.flatMap((collision) =>
    collision.staged.map(
      (staged) =>
        `media: file '${collision.file}' already belongs to live media id '${collision.live_media_id}' (staged media id '${staged.media_id}')`
    )
  );
  const hygieneWarningMessages = hygieneWarnings.map(
    (warning) => `hygiene(${warning.category}): ${formatAuditHygieneWarningMessage(warning)}`
  );
  const allWarnings: string[] = [
    ...chronology.warnings.map((w) => `chronology: ${w}`),
    ...hygieneWarningMessages,
    ...privacy.warnings.map((w) => `style: ${w}`),
    ...(citations.uncitedCount > 0
      ? [`citations: ${citations.uncitedCount} uncited prose sentence(s) in body_md`]
      : []),
    ...scans.warnings.map((w) => `scans: ${w}`),
    ...liveMediaWarnings,
  ];

  const durationMs = Math.round(performance.now() - t0);
  const baseReport: Omit<AuditCommandResult, 'rendered'> = {
    ok: allErrors.length === 0,
    strictOk:
      allErrors.length === 0 &&
      citations.uncitedCount === 0 &&
      privacy.emDashCount === 0 &&
      liveMediaFileCollisions.length === 0 &&
      hygieneWarnings.length === 0,
    repo: repoDir,
    person_id: personId,
    package_dir: packageDir,
    duration_ms: durationMs,
    zeroCoordinatePlaces,
    hygieneWarnings,
    checks: {
      chronology,
      privacy,
      citations,
      scans,
      dryRun,
    },
    errors: allErrors,
    warnings: allWarnings,
  };

  const rendered = options.json
    ? `${JSON.stringify(baseReport, null, 2)}\n`
    : formatAuditTextReport(baseReport);

  return {
    ...baseReport,
    rendered,
  };
}
