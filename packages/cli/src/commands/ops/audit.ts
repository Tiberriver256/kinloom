import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  parseKinloomConfigYaml,
  resolveEffectiveLiving,
  type PrivacyConfig,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';
import {
  extractYamlBlockId,
  parseMatchingYamlBlocks,
  splitTopLevelYamlList,
} from './context.js';
import { runIntegrateCommand, type IntegrateCommandResult } from './integrate.js';

const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const US_PHONE_RE =
  /(?<!\d)(?:\+1[-.\s]?)?(?:\(\d{3}\)[-.\s]?|\b[2-9]\d{2}[-.\s])[2-9]\d{2}[-.\s]\d{4}(?!\d)/g;
const EM_DASH_RE = /\u2014/g;
const INLINE_CITATION_RE = /\[\^src_[A-Za-z0-9._:-]+(?:\|[A-Za-z0-9._:-]+)?\]/;

const POST_MORTEM_RE =
  /\b(burial|buried|funeral|probate|will|estate|obituary|memorial|gravestone|headstone|cemetery|cenotaph|interment|interred|administration|inventory|tombstone|inquest|posthumous|heirs?|executors?|widow)\b/i;
const PRE_BIRTH_CONTEXT_RE =
  /\b(father|mother|parents?|ancestors?|pre-birth|prior to birth|before birth|family origin)\b/i;
const CENSUS_RE = /\b(census|enumerat\w*)\b/i;
const MARRIAGE_RE = /\b(marr(?:iage|ied)?|wedding|nuptial)\b/i;
const SPOUSE_ROLE_RE = /\b(spouse|bride|groom|husband|wife|principal|subject|partner)\b/i;

const MIN_SCAN_WARN_BYTES = 10 * 1024;
const MAX_SCAN_WARN_BYTES = 10 * 1024 * 1024;

const ABBREVIATIONS = [
  'Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Capt.', 'Col.', 'Lt.', 'Gen.', 'Sgt.', 'Cpl.', 'Pvt.',
  'Rev.', 'Hon.', 'St.', 'Jr.', 'Sr.', 'Prof.', 'Gov.', 'Pres.', 'Vol.', 'Vols.',
  'No.', 'Nos.', 'Lib.', 'Fol.', 'Fols.', 'fol.', 'fols.', 'Ch.', 'Sec.', 'Fig.',
  'Ed.', 'Eds.', 'p.', 'pp.', 'c.', 'ca.', 'cf.', 'e.g.', 'i.e.', 'et al.', 'etc.',
  'vs.', 'v.', 'viz.',
  'Jan.', 'Feb.', 'Mar.', 'Apr.', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Sept.', 'Oct.', 'Nov.', 'Dec.',
  'JAN.', 'FEB.', 'MAR.', 'APR.', 'JUN.', 'JUL.', 'AUG.', 'SEP.', 'SEPT.', 'OCT.', 'NOV.', 'DEC.',
  'U.S.', 'U.S.A.', 'N.J.', 'N.Y.', 'Pa.', 'Va.', 'Md.', 'Mass.', 'Conn.', 'Calif.',
  'Ind.', 'Ill.', 'Mo.', 'Ky.', 'Tenn.', 'N.C.', 'S.C.', 'Inc.', 'Co.', 'Ltd.',
  'B.C.', 'A.D.', 'a.m.', 'p.m.', 'b.', 'd.', 'm.', 'bur.', 'bap.', 'chr.',
] as const;

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

export function parseAuditEdtf(raw: unknown): ParsedAuditEdtf | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const primary = trimmed.includes('/') ? trimmed.split('/')[0].trim() : trimmed;
  const approximate = /[~?%]/.test(trimmed);
  const clean = primary.replaceAll(/[~?%]/g, '');

  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (full) {
    const year = Number(full[1]);
    const month = Number(full[2]);
    const day = Number(full[3]);
    const ms = Date.UTC(year, month - 1, day);
    return {
      raw: trimmed,
      year,
      month,
      day,
      precision: 'day',
      approximate,
      startMs: ms,
      endMs: ms,
    };
  }

  const ym = /^(\d{4})-(\d{2})$/.exec(clean);
  if (ym) {
    const year = Number(ym[1]);
    const month = Number(ym[2]);
    const startMs = Date.UTC(year, month - 1, 1);
    const endMs = Date.UTC(year, month, 0);
    return {
      raw: trimmed,
      year,
      month,
      day: null,
      precision: 'month',
      approximate,
      startMs,
      endMs,
    };
  }

  const y = /^(\d{4})/.exec(clean);
  if (y) {
    const year = Number(y[1]);
    return {
      raw: trimmed,
      year,
      month: null,
      day: null,
      precision: 'year',
      approximate,
      startMs: Date.UTC(year, 0, 1),
      endMs: Date.UTC(year, 11, 31),
    };
  }

  return null;
}

export function computeLifespan(
  birth: ParsedAuditEdtf | null,
  death: ParsedAuditEdtf | null
): LifespanSummary {
  if (!birth || !death) {
    return { exact: false, years: null, days: null, totalDays: null, label: null };
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

  const personId = typeof patch.person_id === 'string' ? patch.person_id : '';
  let checkedEvents = 0;

  for (const ev of eventMap.values()) {
    const dt = parseAuditEdtf(asString(ev.edtf_date));
    if (!dt) {
      continue;
    }
    checkedEvents += 1;

    const evId = asString(ev.id);
    const textBlob = `${evId} ${asString(ev.event_kind)} ${asString(ev.title)} ${asString(ev.summary)}`;
    const isPostMortemAllowed = POST_MORTEM_RE.test(textBlob);
    const isPreBirthContext = PRE_BIRTH_CONTEXT_RE.test(textBlob);
    const isCensus = CENSUS_RE.test(`${evId} ${asString(ev.title)}`);
    const isMarriage = MARRIAGE_RE.test(`${evId} ${asString(ev.event_kind)} ${asString(ev.title)}`);

    const birthMinMs = birth
      ? birth.approximate
        ? Date.UTC(birth.year - 1, 0, 1)
        : birth.startMs
      : null;
    const deathMaxMs = death
      ? death.approximate
        ? Date.UTC(death.year + 1, 11, 31)
        : death.endMs
      : null;

    if (birth && birthMinMs !== null && dt.endMs < birthMinMs) {
      if (isCensus) {
        if (!isPreBirthContext) {
          errors.push(`Event ${evId} (${dt.raw}): census predates birth (${birth.raw}) without context label.`);
        } else {
          warnings.push(`Event ${evId} (${dt.raw}): labeled pre-birth census context before birth (${birth.raw}).`);
        }
      } else if (isPreBirthContext) {
        warnings.push(`Event ${evId} (${dt.raw}): pre-birth family context before birth (${birth.raw}).`);
      } else {
        errors.push(`Event ${evId} (${dt.raw}): predates birth (${birth.raw}).`);
      }
    }

    if (death && deathMaxMs !== null && dt.startMs > deathMaxMs) {
      if (isCensus) {
        if (!isPostMortemAllowed) {
          errors.push(`Event ${evId} (${dt.raw}): census postdates death (${death.raw}) without explicit posthumous/widow label.`);
        } else {
          warnings.push(`Event ${evId} (${dt.raw}): labeled post-mortem census entry after death (${death.raw}).`);
        }
      } else if (!isPostMortemAllowed) {
        errors.push(`Event ${evId} (${dt.raw}): postdates death (${death.raw}) and is not a burial/probate/obituary/memorial event.`);
      }
    }

    if (birth && isMarriage) {
      const participants = Array.isArray(ev.participants) ? ev.participants : [];
      const subjectPart = participants.find(
        (pt) => isPlainRecord(pt) && pt.person_id === personId
      );
      const role = isPlainRecord(subjectPart) ? asString(subjectPart.role) : '';
      const isPrincipalSpouse = !role || SPOUSE_ROLE_RE.test(role);
      if (isPrincipalSpouse) {
        const beforeBirthday =
          birth.precision === 'day' &&
          dt.precision === 'day' &&
          birth.month !== null &&
          birth.day !== null &&
          dt.month !== null &&
          dt.day !== null &&
          (dt.month < birth.month || (dt.month === birth.month && dt.day < birth.day));
        const ageAtEvent = dt.year - birth.year - (beforeBirthday ? 1 : 0);
        if (ageAtEvent < 12) {
          errors.push(`Event ${evId} (${dt.raw}): marriage at implausible age ${ageAtEvent} (birth ${birth.raw}).`);
        }
      }
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

function collectStringsWithPath(
  value: unknown,
  prefix: string,
  out: Array<{ path: string; text: string }>
): void {
  if (typeof value === 'string') {
    out.push({ path: prefix, text: value });
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectStringsWithPath(value[i], `${prefix}[${i}]`, out);
    }
    return;
  }
  if (isPlainRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      collectStringsWithPath(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
}

function compileAuditLivingNameRegex(livingPeople: readonly LooseRecord[]): RegExp | null {
  const names = new Set<string>();
  for (const p of livingPeople) {
    const alts = Array.isArray(p.alt_names) ? p.alt_names : [];
    for (const raw of [p.full_name, ...alts]) {
      if (typeof raw !== 'string') {
        continue;
      }
      const cleaned = raw.trim();
      // Multi-word names >= 6 chars prevent common single-token false positives.
      if (cleaned.length >= 6 && cleaned.includes(' ')) {
        names.add(cleaned);
      }
    }
  }
  if (names.size === 0) {
    return null;
  }
  const escaped = [...names]
    .toSorted((a, b) => b.length - a.length)
    .map((n) => n.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![A-Za-z])(?:${escaped.join('|')})(?![A-Za-z])`, 'gi');
}

export function runPrivacyAndStyleScan(
  dossierText: string,
  patch: LooseRecord,
  livingPeople: readonly LooseRecord[]
): PrivacyAndStyleCheckResult {
  const livingNameRegex = compileAuditLivingNameRegex(livingPeople);
  const livingNameHits: Array<{ location: string; match: string }> = [];
  const ssnHits: Array<{ location: string; match: string }> = [];
  const phoneHits: Array<{ location: string; match: string }> = [];
  const emDashHits: Array<{ location: string; count: number }> = [];

  const scanTarget = (label: string, text: string, checkEmDash: boolean): void => {
    if (!text) {
      return;
    }
    if (livingNameRegex) {
      for (const m of text.matchAll(livingNameRegex)) {
        if (livingNameHits.length < 50) {
          livingNameHits.push({ location: label, match: m[0] });
        }
      }
    }
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
    scanTarget('dossier.md', dossierText, true);
  }

  const patchStrings: Array<{ path: string; text: string }> = [];
  collectStringsWithPath(patch, 'patch', patchStrings);
  for (const item of patchStrings) {
    const isBioProse =
      item.path.endsWith('.body_md') ||
      item.path.endsWith('.biography') ||
      item.path.endsWith('.bio');
    scanTarget(item.path, item.text, isBioProse);
  }

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

  // Mask common abbreviations and single-letter initials (e.g. "C. P. and Emma Alder").
  for (const abbr of ABBREVIATIONS) {
    const escaped = abbr.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![A-Za-z])${escaped}`, 'g');
    protectedText = protectedText.replaceAll(re, (m) => m.replaceAll('.', '\u0001'));
  }
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

  const [patchText, dossierText, peopleText, eventsText, configText] = await Promise.all([
    readFile(patchPath, 'utf8'),
    fs.existsSync(dossierPath) ? readFile(dossierPath, 'utf8') : Promise.resolve(''),
    readFile(peoplePath, 'utf8'),
    fs.existsSync(path.join(dataDir, 'events.yaml'))
      ? readFile(path.join(dataDir, 'events.yaml'), 'utf8')
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
  const relevantPeopleBlocks = peopleBlocks.filter((block) => {
    const id = extractYamlBlockId(block);
    if (id === personId) {
      return true;
    }
    if (/\b(?:is_living|living):\s*true\b/.test(block)) {
      return true;
    }
    const dm = /^\s+death_edtf:\s*(.*)$/m.exec(block);
    const dv = dm ? dm[1].trim().replaceAll(/^["']|["']$/g, '') : '';
    return dv.length === 0 || dv === 'null' || dv === '~';
  });

  const parsedPeople = parseMatchingYamlBlocks(relevantPeopleBlocks);
  const targetPerson = parsedPeople.find((p) => p.id === personId) ?? null;

  const livingPeople = parsedPeople.filter((p) => {
    if (p.id === personId) {
      return false;
    }
    if (p.is_living === true || p.living === true) {
      return true;
    }
    const birthEdtf = asString(p.birth_edtf).trim();
    const deathEdtf = asString(p.death_edtf).trim();
    return resolveEffectiveLiving(
      { is_living: false, birth_edtf: birthEdtf, death_edtf: deathEdtf },
      privacyConfig
    );
  });

  const existingPersonEventBlocks = splitTopLevelYamlList(eventsText).filter((b) =>
    b.includes(personId)
  );
  const existingPersonEvents = parseMatchingYamlBlocks(existingPersonEventBlocks).filter(
    (ev) =>
      Array.isArray(ev.participants) &&
      ev.participants.some((pt) => isPlainRecord(pt) && pt.person_id === personId)
  );

  const chronology = runChronologyCheck(targetPerson, patch, existingPersonEvents);
  const privacy = runPrivacyAndStyleScan(dossierText, patch, livingPeople);
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
  const allWarnings: string[] = [
    ...chronology.warnings.map((w) => `chronology: ${w}`),
    ...privacy.warnings.map((w) => `style: ${w}`),
    ...(citations.uncitedCount > 0
      ? [`citations: ${citations.uncitedCount} uncited prose sentence(s) in body_md`]
      : []),
    ...scans.warnings.map((w) => `scans: ${w}`),
  ];

  const durationMs = Math.round(performance.now() - t0);
  const baseReport: Omit<AuditCommandResult, 'rendered'> = {
    ok: allErrors.length === 0,
    strictOk: allErrors.length === 0 && citations.uncitedCount === 0 && privacy.emDashCount === 0,
    repo: repoDir,
    person_id: personId,
    package_dir: packageDir,
    duration_ms: durationMs,
    zeroCoordinatePlaces,
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
