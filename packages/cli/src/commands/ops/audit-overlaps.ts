import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseMediaYaml } from '@kinloom/core';
import { CliValidationError } from '../../errors.js';
import {
  inspectImageBuffer,
  runAuditCommand,
  type AuditCommandResult,
} from './audit.js';

const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;

const EVENT_DIFF_FIELDS = ['edtf_date', 'place_id', 'place_precision', 'title'] as const;

export type EventDiffField = (typeof EVENT_DIFF_FIELDS)[number];

export interface ScanCollisionPackage {
  person_id: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
}

export interface ScanFileCollision {
  basename: string;
  bytesIdentical: boolean;
  packages: ScanCollisionPackage[];
}

export interface MediaFileCollisionEntry {
  person_id: string;
  media_id: string;
  file: string;
}

export interface MediaFileCollision {
  file: string;
  mediaIdsConflict: boolean;
  entries: MediaFileCollisionEntry[];
}

export interface SharedMediaId {
  id: string;
  packages: Array<{ person_id: string; file: string }>;
}

export interface SharedSourceId {
  id: string;
  person_ids: string[];
}

export interface SharedEventPackage {
  person_id: string;
  edtf_date: string | null;
  place_id: string | null;
  place_precision: string | null;
  title: string | null;
}

export interface SharedEventOverlap {
  id: string;
  fieldDiffs: EventDiffField[];
  packages: SharedEventPackage[];
}

export interface LiveMediaFileCollision {
  file: string;
  live_media_id: string;
  staged: Array<{ person_id: string; media_id: string; file: string }>;
}

export interface AuditOverlaps {
  scanFileCollisions: ScanFileCollision[];
  mediaFileCollisions: MediaFileCollision[];
  sharedMediaIds: SharedMediaId[];
  sharedSourceIds: SharedSourceId[];
  sharedEventOverlaps: SharedEventOverlap[];
  liveMediaFileCollisions: LiveMediaFileCollision[];
}

export interface AuditBatchSummary {
  people: number;
  passed: number;
  failed: number;
  strictPassed: number;
  scanFileCollisions: number;
  differingScanCollisions: number;
  mediaFileCollisions: number;
  conflictingMediaFileCollisions: number;
  sharedMediaIds: number;
  sharedSourceIds: number;
  sharedEventOverlaps: number;
  sharedEventFieldDiffs: number;
  liveMediaFileCollisions: number;
}

export type AuditBatchPerson = Omit<AuditCommandResult, 'rendered'>;

export interface AuditBatchResult {
  ok: boolean;
  strictOk: boolean;
  repo: string;
  people: AuditBatchPerson[];
  overlaps: AuditOverlaps;
  summary: AuditBatchSummary;
  duration_ms: number;
  rendered: string;
}

interface StagedMediaRef {
  id: string;
  file: string;
  normalizedFile: string;
}

interface StagedSourceRef {
  id: string;
}

interface StagedEventRow extends SharedEventPackage {
  id: string;
}

interface ParsedPackage {
  personId: string;
  packageDir: string;
  media: StagedMediaRef[];
  sources: StagedSourceRef[];
  eventRows: StagedEventRow[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizeMediaFilePath(file: string): string {
  const parts = file
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  return parts.join('/');
}

function comparePersonId(a: { person_id: string }, b: { person_id: string }): number {
  return a.person_id.localeCompare(b.person_id);
}

function uniquePersonCount(personIds: readonly string[]): number {
  return new Set(personIds).size;
}

export function listStagedAuditPersonIds(repoDir: string): string[] {
  const root = path.join(repoDir, 'research', 'people');
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SAFE_PERSON_ID_RE.test(entry.name))
    .map((entry) => entry.name)
    .filter((personId) => fs.existsSync(path.join(root, personId, 'patch.json')))
    .sort((a, b) => a.localeCompare(b));
}

function readPatchObject(patchPath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`patch.json at ${patchPath} is not valid JSON (${detail}).`);
  }
  if (!isPlainRecord(parsed)) {
    throw new CliValidationError(`patch.json at ${patchPath} must contain a JSON object.`);
  }
  return parsed;
}

function loadStagedPackage(personId: string, packageDir: string): ParsedPackage {
  const patch = readPatchObject(path.join(packageDir, 'patch.json'));
  const media: StagedMediaRef[] = [];
  for (const rawItem of Array.isArray(patch.media) ? patch.media : []) {
    if (!isPlainRecord(rawItem) || typeof rawItem.id !== 'string' || typeof rawItem.file !== 'string') {
      continue;
    }
    const id = rawItem.id.trim();
    const file = rawItem.file.trim();
    if (!id || !file) {
      continue;
    }
    media.push({ id, file, normalizedFile: normalizeMediaFilePath(file) });
  }

  const sources: StagedSourceRef[] = [];
  for (const rawItem of Array.isArray(patch.sources) ? patch.sources : []) {
    if (!isPlainRecord(rawItem) || typeof rawItem.id !== 'string') {
      continue;
    }
    const id = rawItem.id.trim();
    if (id) {
      sources.push({ id });
    }
  }

  const eventRows: StagedEventRow[] = [];
  for (const rawItem of Array.isArray(patch.events) ? patch.events : []) {
    if (!isPlainRecord(rawItem) || typeof rawItem.id !== 'string') {
      continue;
    }
    const id = rawItem.id.trim();
    if (!id) {
      continue;
    }
    eventRows.push({
      id,
      person_id: personId,
      edtf_date: nullableText(rawItem.edtf_date),
      place_id: nullableText(rawItem.place_id),
      place_precision: nullableText(rawItem.place_precision),
      title: nullableText(rawItem.title),
    });
  }

  return { personId, packageDir, media, sources, eventRows };
}

function hashAndMeasure(diskPath: string): ScanCollisionPackage & { person_id: string } {
  const stat = fs.statSync(diskPath);
  const hash = crypto.createHash('sha256');
  const headerLen = Math.min(stat.size, 65_536);
  const header = Buffer.allocUnsafe(headerLen);
  const fd = fs.openSync(diskPath, 'r');
  try {
    let offset = 0;
    const buf = Buffer.allocUnsafe(1024 * 1024);
    while (offset < stat.size) {
      const read = fs.readSync(fd, buf, 0, Math.min(buf.length, stat.size - offset), offset);
      if (read <= 0) {
        break;
      }
      hash.update(buf.subarray(0, read));
      if (offset < headerLen) {
        buf.copy(header, offset, 0, Math.min(read, headerLen - offset));
      }
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  const info =
    headerLen === 0
      ? { width: null, height: null }
      : inspectImageBuffer(header.subarray(0, headerLen));
  return {
    person_id: '',
    bytes: stat.size,
    width: info.width,
    height: info.height,
    sha256: hash.digest('hex'),
  };
}

function collectScanCollisions(packages: readonly ParsedPackage[]): ScanFileCollision[] {
  const grouped = new Map<string, ScanCollisionPackage[]>();
  for (const staged of packages) {
    const scansDir = path.join(staged.packageDir, 'scans');
    if (!fs.existsSync(scansDir)) {
      continue;
    }
    const names = fs
      .readdirSync(scansDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const measured = hashAndMeasure(path.join(scansDir, name));
      const row: ScanCollisionPackage = {
        person_id: staged.personId,
        bytes: measured.bytes,
        width: measured.width,
        height: measured.height,
        sha256: measured.sha256,
      };
      const rows = grouped.get(name) ?? [];
      rows.push(row);
      grouped.set(name, rows);
    }
  }

  const collisions: ScanFileCollision[] = [];
  for (const [basename, rows] of grouped) {
    if (uniquePersonCount(rows.map((row) => row.person_id)) < 2) {
      continue;
    }
    const packagesForFile = rows.toSorted(comparePersonId);
    const firstHash = packagesForFile[0]?.sha256 ?? '';
    collisions.push({
      basename,
      bytesIdentical: packagesForFile.every((row) => row.sha256 === firstHash),
      packages: packagesForFile,
    });
  }
  return collisions.toSorted((a, b) => a.basename.localeCompare(b.basename));
}

function collectMediaFileCollisions(packages: readonly ParsedPackage[]): MediaFileCollision[] {
  const grouped = new Map<string, MediaFileCollisionEntry[]>();
  for (const staged of packages) {
    for (const item of staged.media) {
      if (!item.normalizedFile) {
        continue;
      }
      const rows = grouped.get(item.normalizedFile) ?? [];
      rows.push({
        person_id: staged.personId,
        media_id: item.id,
        file: item.file,
      });
      grouped.set(item.normalizedFile, rows);
    }
  }
  const collisions: MediaFileCollision[] = [];
  for (const [file, entries] of grouped) {
    if (uniquePersonCount(entries.map((entry) => entry.person_id)) < 2) {
      continue;
    }
    const sorted = entries.toSorted(
      (a, b) => a.person_id.localeCompare(b.person_id) || a.media_id.localeCompare(b.media_id)
    );
    const mediaIds = new Set(sorted.map((entry) => entry.media_id));
    collisions.push({
      file,
      mediaIdsConflict: mediaIds.size > 1,
      entries: sorted,
    });
  }
  return collisions.toSorted((a, b) => a.file.localeCompare(b.file));
}

function collectSharedMediaIds(packages: readonly ParsedPackage[]): SharedMediaId[] {
  const grouped = new Map<string, Array<{ person_id: string; file: string }>>();
  for (const staged of packages) {
    const seenInPackage = new Set<string>();
    for (const item of staged.media) {
      if (seenInPackage.has(item.id)) {
        continue;
      }
      seenInPackage.add(item.id);
      const rows = grouped.get(item.id) ?? [];
      rows.push({ person_id: staged.personId, file: item.file });
      grouped.set(item.id, rows);
    }
  }
  const shared: SharedMediaId[] = [];
  for (const [id, rows] of grouped) {
    if (uniquePersonCount(rows.map((row) => row.person_id)) < 2) {
      continue;
    }
    shared.push({ id, packages: rows.toSorted(comparePersonId) });
  }
  return shared.toSorted((a, b) => a.id.localeCompare(b.id));
}

function collectSharedSourceIds(packages: readonly ParsedPackage[]): SharedSourceId[] {
  const grouped = new Map<string, string[]>();
  for (const staged of packages) {
    const seenInPackage = new Set<string>();
    for (const source of staged.sources) {
      if (seenInPackage.has(source.id)) {
        continue;
      }
      seenInPackage.add(source.id);
      const rows = grouped.get(source.id) ?? [];
      rows.push(staged.personId);
      grouped.set(source.id, rows);
    }
  }
  const shared: SharedSourceId[] = [];
  for (const [id, personIds] of grouped) {
    const unique = [...new Set(personIds)].sort((a, b) => a.localeCompare(b));
    if (unique.length < 2) {
      continue;
    }
    shared.push({ id, person_ids: unique });
  }
  return shared.toSorted((a, b) => a.id.localeCompare(b.id));
}

function collectSharedEvents(packages: readonly ParsedPackage[]): SharedEventOverlap[] {
  const grouped = new Map<string, StagedEventRow[]>();
  for (const staged of packages) {
    const seenInPackage = new Set<string>();
    for (const event of staged.eventRows) {
      if (seenInPackage.has(event.id)) {
        continue;
      }
      seenInPackage.add(event.id);
      const rows = grouped.get(event.id) ?? [];
      rows.push(event);
      grouped.set(event.id, rows);
    }
  }
  const overlaps: SharedEventOverlap[] = [];
  for (const [id, rows] of grouped) {
    if (uniquePersonCount(rows.map((row) => row.person_id)) < 2) {
      continue;
    }
    const sorted = rows.toSorted(comparePersonId);
    const fieldDiffs = EVENT_DIFF_FIELDS.filter((field) => {
      const first = sorted[0]?.[field] ?? null;
      return sorted.some((row) => row[field] !== first);
    });
    overlaps.push({
      id,
      fieldDiffs: [...fieldDiffs],
      packages: sorted.map((row) => ({
        person_id: row.person_id,
        edtf_date: row.edtf_date,
        place_id: row.place_id,
        place_precision: row.place_precision,
        title: row.title,
      })),
    });
  }
  return overlaps.toSorted((a, b) => a.id.localeCompare(b.id));
}

function collectLiveMediaCollisions(
  packages: readonly ParsedPackage[],
  liveMedia: readonly { id: string; file: string }[]
): LiveMediaFileCollision[] {
  const liveByFile = new Map<string, string[]>();
  for (const item of liveMedia) {
    const normalized = normalizeMediaFilePath(item.file);
    if (!normalized) {
      continue;
    }
    const ids = liveByFile.get(normalized) ?? [];
    ids.push(item.id);
    liveByFile.set(normalized, ids);
  }

  const grouped = new Map<string, LiveMediaFileCollision>();
  for (const staged of packages) {
    for (const item of staged.media) {
      const liveIds = liveByFile.get(item.normalizedFile) ?? [];
      for (const liveId of liveIds) {
        if (liveId === item.id) {
          continue;
        }
        const key = `${item.normalizedFile}\0${liveId}`;
        const existing = grouped.get(key) ?? {
          file: item.normalizedFile,
          live_media_id: liveId,
          staged: [],
        };
        existing.staged.push({
          person_id: staged.personId,
          media_id: item.id,
          file: item.file,
        });
        grouped.set(key, existing);
      }
    }
  }

  return [...grouped.values()]
    .map((collision) => ({
      ...collision,
      staged: collision.staged.toSorted(
        (a, b) => a.person_id.localeCompare(b.person_id) || a.media_id.localeCompare(b.media_id)
      ),
    }))
    .toSorted(
      (a, b) => a.file.localeCompare(b.file) || a.live_media_id.localeCompare(b.live_media_id)
    );
}

function computeAuditOverlaps(input: {
  packages: readonly ParsedPackage[];
  liveMedia: readonly { id: string; file: string }[];
}): AuditOverlaps {
  return {
    scanFileCollisions: collectScanCollisions(input.packages),
    mediaFileCollisions: collectMediaFileCollisions(input.packages),
    sharedMediaIds: collectSharedMediaIds(input.packages),
    sharedSourceIds: collectSharedSourceIds(input.packages),
    sharedEventOverlaps: collectSharedEvents(input.packages),
    liveMediaFileCollisions: collectLiveMediaCollisions(input.packages, input.liveMedia),
  };
}

function loadLiveMedia(repoDir: string): Array<{ id: string; file: string }> {
  const mediaPath = path.join(repoDir, 'data', 'media.yaml');
  if (!fs.existsSync(mediaPath)) {
    return [];
  }
  return parseMediaYaml(fs.readFileSync(mediaPath, 'utf8')).map((item) => ({
    id: item.id,
    file: item.file,
  }));
}

function summarizeBatch(
  people: readonly AuditBatchPerson[],
  overlaps: AuditOverlaps
): AuditBatchSummary {
  return {
    people: people.length,
    passed: people.filter((person) => person.ok).length,
    failed: people.filter((person) => !person.ok).length,
    strictPassed: people.filter((person) => person.strictOk).length,
    scanFileCollisions: overlaps.scanFileCollisions.length,
    differingScanCollisions: overlaps.scanFileCollisions.filter((row) => !row.bytesIdentical).length,
    mediaFileCollisions: overlaps.mediaFileCollisions.length,
    conflictingMediaFileCollisions: overlaps.mediaFileCollisions.filter((row) => row.mediaIdsConflict)
      .length,
    sharedMediaIds: overlaps.sharedMediaIds.length,
    sharedSourceIds: overlaps.sharedSourceIds.length,
    sharedEventOverlaps: overlaps.sharedEventOverlaps.length,
    sharedEventFieldDiffs: overlaps.sharedEventOverlaps.filter((row) => row.fieldDiffs.length > 0)
      .length,
    liveMediaFileCollisions: overlaps.liveMediaFileCollisions.length,
  };
}

function showNullable(value: string | null): string {
  return value ?? '-';
}

export function formatAuditBatchTextReport(report: Omit<AuditBatchResult, 'rendered'>): string {
  const lines: string[] = [];
  lines.push(
    `Batch audit [${report.ok ? 'PASS' : 'FAIL'}] strict [${report.strictOk ? 'PASS' : 'FAIL'}] ` +
      `${report.summary.people} people (${report.duration_ms} ms)`
  );
  lines.push(`  Repo: ${report.repo}`);
  for (const person of report.people) {
    lines.push(
      `  ${person.person_id}: ${person.ok ? 'PASS' : 'FAIL'} strict ${person.strictOk ? 'PASS' : 'FAIL'}`
    );
    for (const err of person.errors) {
      lines.push(`    ERROR: ${err}`);
    }
  }

  lines.push('Overlaps:');
  if (report.overlaps.scanFileCollisions.length === 0) {
    lines.push('  Scan files: none');
  }
  for (const collision of report.overlaps.scanFileCollisions) {
    lines.push(
      `  Scan file ${collision.basename}: ${collision.bytesIdentical ? 'identical bytes' : 'different bytes'}`
    );
    for (const staged of collision.packages) {
      const dims =
        staged.width === null || staged.height === null
          ? 'unknown size'
          : `${staged.width}x${staged.height}`;
      lines.push(`    ${staged.person_id} ${staged.bytes} bytes ${dims} sha256=${staged.sha256}`);
    }
  }

  if (report.overlaps.mediaFileCollisions.length === 0) {
    lines.push('  Media files: none');
  }
  for (const collision of report.overlaps.mediaFileCollisions) {
    lines.push(
      `  Media file ${collision.file}: ${collision.mediaIdsConflict ? 'conflicting media ids' : 'same media id'}`
    );
    for (const entry of collision.entries) {
      lines.push(`    ${entry.person_id} media_id=${entry.media_id} file=${entry.file}`);
    }
  }

  if (report.overlaps.sharedMediaIds.length === 0) {
    lines.push('  Shared media ids: none');
  }
  for (const shared of report.overlaps.sharedMediaIds) {
    const detail = shared.packages.map((row) => `${row.person_id} file=${row.file}`).join('; ');
    lines.push(`  Shared media id ${shared.id}: ${detail}`);
  }

  if (report.overlaps.sharedSourceIds.length === 0) {
    lines.push('  Shared source ids: none');
  }
  for (const shared of report.overlaps.sharedSourceIds) {
    lines.push(`  Shared source id ${shared.id}: ${shared.person_ids.join(', ')}`);
  }

  if (report.overlaps.sharedEventOverlaps.length === 0) {
    lines.push('  Shared events: none');
  }
  for (const overlap of report.overlaps.sharedEventOverlaps) {
    const diff =
      overlap.fieldDiffs.length === 0
        ? 'same edtf_date, place_id, place_precision, and title'
        : `differs in ${overlap.fieldDiffs.join(', ')}`;
    lines.push(`  Event ${overlap.id}: ${diff}`);
    for (const staged of overlap.packages) {
      lines.push(
        `    ${staged.person_id} date=${showNullable(staged.edtf_date)} place=${showNullable(staged.place_id)} precision=${showNullable(staged.place_precision)} title=${showNullable(staged.title)}`
      );
    }
  }

  if (report.overlaps.liveMediaFileCollisions.length === 0) {
    lines.push('  Live media files: none');
  }
  for (const collision of report.overlaps.liveMediaFileCollisions) {
    lines.push(`  Live media file ${collision.file}: live id ${collision.live_media_id}`);
    for (const staged of collision.staged) {
      lines.push(`    ${staged.person_id} media_id=${staged.media_id} file=${staged.file}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export async function runAuditBatchCommand(options: {
  repoDir?: string;
  personIds: readonly string[];
  json?: boolean;
}): Promise<AuditBatchResult> {
  const started = performance.now();
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const personIds = options.personIds.map((personId) => personId.trim()).filter((personId) => personId.length > 0);
  if (personIds.length === 0) {
    throw new CliValidationError('Batch audit requires at least one staged person id.');
  }
  const seen = new Set<string>();
  for (const personId of personIds) {
    if (!SAFE_PERSON_ID_RE.test(personId)) {
      throw new CliValidationError(`Invalid person_id '${personId}'.`);
    }
    if (seen.has(personId)) {
      throw new CliValidationError(`Duplicate person_id '${personId}'.`);
    }
    seen.add(personId);
  }

  const people: AuditBatchPerson[] = [];
  for (const personId of personIds) {
    const result = await runAuditCommand({ repoDir, personId, json: false });
    const { rendered: _rendered, ...person } = result;
    people.push(person);
  }

  const packages = personIds.map((personId) =>
    loadStagedPackage(personId, path.join(repoDir, 'research', 'people', personId))
  );
  const overlaps = computeAuditOverlaps({
    packages,
    liveMedia: loadLiveMedia(repoDir),
  });
  const summary = summarizeBatch(people, overlaps);
  const report: Omit<AuditBatchResult, 'rendered'> = {
    ok: people.every((person) => person.ok),
    strictOk:
      people.every((person) => person.strictOk) &&
      summary.differingScanCollisions === 0 &&
      summary.conflictingMediaFileCollisions === 0,
    repo: repoDir,
    people,
    overlaps,
    summary,
    duration_ms: Math.round(performance.now() - started),
  };
  const rendered = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatAuditBatchTextReport(report);
  return { ...report, rendered };
}
