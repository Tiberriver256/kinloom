import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ArchiveBundleSchema,
  KinshipEdgeSchema,
  MediaItemSchema,
  NarrativeSchema,
  PlaceSchema,
  RawEventSchema,
  RawPersonSchema,
  SourceRecordSchema,
  compileArchive,
  extractNarrativeCitations,
  getMediaPersonIds,
  mergeEventSources,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativeEnrichmentsYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  resolveEffectiveLiving,
  serializeEventsYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
  validateMediaForPrivacy,
  validateNarrativeCitations,
  type ArchiveBundle,
  type BuildMode,
  type EventParticipant,
  type KinshipEdge,
  type PrivacyConfig,
  type RawPerson,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';

const YEAR_ONLY_RE = /^\d{4}$/;
const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;

const ALLOWED_PATCH_KEYS = new Set([
  'person_id',
  'person_updates',
  'events',
  'places',
  'sources',
  'media',
  'kinship',
  'narratives',
]);

const ALLOWED_PERSON_UPDATE_KEYS = new Set([
  'id',
  'slug',
  'gedcom_xref',
  'full_name',
  'given_name',
  'surname',
  'alt_names',
  'sex',
  'is_living',
  'living',
  'lineage_group',
  'branch',
  'birth_edtf',
  'death_edtf',
  'birth_date',
  'death_date',
  'portrait_url',
  'thumb_url',
  'has_primary_source',
  'extensions',
  'bio',
  'biography',
  'summary',
  'research_notes',
  'sources',
]);

export { INTEGRATE_HELP } from './help.js';

export interface IntegrateCommandOptions {
  repoDir?: string;
  personId: string;
  packageDir?: string;
  dryRun?: boolean;
  json?: boolean;
}

export interface UpsertCounts {
  added: number;
  updated: number;
  unchanged: number;
}

export interface StagedScanReportItem {
  filename: string;
  sourcePath: string;
  destPath: string;
  url: string;
  r2Key: string;
  status: 'staged' | 'would_stage' | 'unchanged';
  sizeBytes: number;
  sha256: string;
}

export interface IntegrateCommandResult {
  ok: true;
  dryRun: boolean;
  repo: string;
  personId: string;
  packageDir: string;
  mediaLayout: 'archive-media' | 'media';
  counts: {
    personUpdated: boolean;
    events: UpsertCounts;
    places: UpsertCounts;
    sources: UpsertCounts;
    media: UpsertCounts;
    kinship: UpsertCounts;
    narratives: UpsertCounts;
  };
  inlineCitationCount: number;
  stagedScans: StagedScanReportItem[];
  wouldWriteYamlFiles: string[];
  writtenYamlFiles: string[];
  validation: {
    privateCounts: ArchiveBundle['meta']['counts'];
    publicCounts: ArchiveBundle['meta']['counts'];
    privateReviewFlags: number;
    publicReviewFlags: number;
    livingLeaks: number;
  };
  rendered: string;
}

interface MediaLayout {
  layout: 'archive-media' | 'media';
  mediaUrlRoot: string;
  scanDestDir: string;
  scanUrlPrefix: string;
  r2KeyPrefix: string;
}

interface PlannedScan {
  filename: string;
  sourcePath: string;
  destPath: string;
  url: string;
  r2Key: string;
  sizeBytes: number;
  sha256: string;
  alreadyIdentical: boolean;
}

interface NormalizedPatch {
  person_id: string;
  person_updates: Record<string, unknown> | null;
  events: unknown[];
  places: unknown[];
  sources: unknown[];
  media: unknown[];
  kinship: unknown[];
  narratives: unknown[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOptionalUtf8(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

function sha256File(filePath: string): { sizeBytes: number; sha256: string } {
  const buf = fs.readFileSync(filePath);
  return {
    sizeBytes: buf.byteLength,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

function dedupeStrings(
  existing: readonly string[] | undefined,
  additions: readonly unknown[] | undefined
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(existing ?? []), ...(additions ?? [])]) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function dedupeExtensionSources(
  existing: readonly unknown[] | undefined,
  additions: readonly unknown[] | undefined
): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  const keyFor = (entry: unknown): string => {
    if (typeof entry === 'string') {
      return `str:${entry.trim()}`;
    }
    if (isPlainObject(entry) && typeof entry.source_id === 'string') {
      return `sid:${entry.source_id}`;
    }
    return `json:${JSON.stringify(entry)}`;
  };
  for (const entry of [...(existing ?? []), ...(additions ?? [])]) {
    if (entry === null || entry === undefined) {
      continue;
    }
    const key = keyFor(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(structuredClone(entry));
  }
  return out;
}

function dedupeParticipants(
  existing: readonly EventParticipant[] | undefined,
  additions: readonly EventParticipant[] | undefined
): EventParticipant[] {
  const out: EventParticipant[] = [];
  const seen = new Set<string>();
  for (const pt of [...(existing ?? []), ...(additions ?? [])]) {
    const key = `${pt.person_id}|${pt.role}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ person_id: pt.person_id, role: pt.role });
  }
  return out;
}

function normalizeAndValidatePatch(rawPatch: unknown, expectedPersonId: string): NormalizedPatch {
  if (!isPlainObject(rawPatch)) {
    throw new Error('patch.json root must be a JSON object.');
  }

  for (const key of Object.keys(rawPatch)) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      throw new Error(`Unknown top-level key '${key}' in patch.json.`);
    }
  }

  if (typeof rawPatch.person_id !== 'string' || rawPatch.person_id !== expectedPersonId) {
    throw new Error(
      `patch.json person_id '${String(rawPatch.person_id)}' does not match --person '${expectedPersonId}'.`
    );
  }

  const rawUpdates = rawPatch.person_updates ?? null;
  if (rawUpdates !== null && !isPlainObject(rawUpdates)) {
    throw new Error('patch.json person_updates must be an object when provided.');
  }
  if (rawUpdates) {
    for (const key of Object.keys(rawUpdates)) {
      if (!ALLOWED_PERSON_UPDATE_KEYS.has(key)) {
        throw new Error(`Unknown key '${key}' in patch.json person_updates.`);
      }
    }
  }

  const readArrayField = (field: string): unknown[] => {
    const val = rawPatch[field];
    if (val === undefined) {
      return [];
    }
    if (!Array.isArray(val)) {
      throw new Error(`patch.json '${field}' must be an array.`);
    }
    return val;
  };

  return {
    person_id: rawPatch.person_id,
    person_updates: rawUpdates,
    events: readArrayField('events'),
    places: readArrayField('places'),
    sources: readArrayField('sources'),
    media: readArrayField('media'),
    kinship: readArrayField('kinship'),
    narratives: readArrayField('narratives'),
  };
}

function assertValidPlaceCoordinates(place: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(place)) {
    throw new Error(`${label} must be an object.`);
  }
  const placeIdLabel = typeof place.id === 'string' ? place.id : 'unknown';
  const hasLng = place.lng !== undefined && place.lng !== null;
  const hasLon = place.lon !== undefined && place.lon !== null;
  if (!hasLng && !hasLon) {
    throw new Error(`${label} (${placeIdLabel}) is missing coordinates (lat/lng).`);
  }
  if (hasLng && hasLon && Number(place.lng) !== Number(place.lon)) {
    throw new Error(
      `${label} (${placeIdLabel}) specifies conflicting lng (${String(place.lng)}) and lon (${String(place.lon)}).`
    );
  }
  const lat = Number(place.lat);
  const lng = Number(hasLng ? place.lng : place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`${label} (${placeIdLabel}) has non-finite coordinates.`);
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error(`${label} (${placeIdLabel}) coordinates out of range: (${lat}, ${lng}).`);
  }
  if (Math.abs(lat) < 1e-9 && Math.abs(lng) < 1e-9) {
    throw new Error(`${label} (${placeIdLabel}) has forbidden (0, 0) coordinates.`);
  }
  const copy: Record<string, unknown> = { ...place, lat, lng };
  delete copy.lon;
  return copy;
}

function mergePersonUpdates(
  existingPerson: RawPerson,
  updates: Record<string, unknown> | null,
  privacyConfig: Partial<PrivacyConfig>
): { updated: RawPerson; changed: boolean } {
  if (!updates || Object.keys(updates).length === 0) {
    return { updated: structuredClone(existingPerson), changed: false };
  }

  if (updates.id !== undefined && updates.id !== existingPerson.id) {
    throw new Error(
      `person_updates cannot change person id from '${existingPerson.id}' to '${String(updates.id)}'.`
    );
  }
  if (updates.is_living === true || updates.living === true) {
    throw new Error(`person_updates cannot mark target '${existingPerson.id}' as living.`);
  }
  if (
    updates.birth_edtf !== undefined &&
    updates.birth_date !== undefined &&
    String(updates.birth_edtf) !== String(updates.birth_date)
  ) {
    throw new Error('person_updates has conflicting birth_edtf and birth_date.');
  }
  if (
    updates.death_edtf !== undefined &&
    updates.death_date !== undefined &&
    String(updates.death_edtf) !== String(updates.death_date)
  ) {
    throw new Error('person_updates has conflicting death_edtf and death_date.');
  }
  if (
    updates.bio !== undefined &&
    updates.biography !== undefined &&
    String(updates.bio) !== String(updates.biography)
  ) {
    throw new Error('person_updates has conflicting bio and biography.');
  }

  const next: Record<string, unknown> = structuredClone(existingPerson);
  const directFields = [
    'slug',
    'gedcom_xref',
    'full_name',
    'given_name',
    'surname',
    'sex',
    'lineage_group',
    'branch',
    'portrait_url',
    'thumb_url',
    'has_primary_source',
  ] as const;

  for (const field of directFields) {
    if (updates[field] !== undefined) {
      next[field] = updates[field];
    }
  }

  const birthVal = updates.birth_edtf !== undefined ? updates.birth_edtf : updates.birth_date;
  if (birthVal !== undefined) {
    next.birth_edtf = birthVal === null ? '' : String(birthVal);
  }
  const deathVal = updates.death_edtf !== undefined ? updates.death_edtf : updates.death_date;
  if (deathVal !== undefined) {
    next.death_edtf = deathVal === null ? '' : String(deathVal);
  }

  if (updates.alt_names !== undefined) {
    if (!Array.isArray(updates.alt_names)) {
      throw new Error('person_updates.alt_names must be an array of strings.');
    }
    next.alt_names = dedupeStrings(existingPerson.alt_names, updates.alt_names);
  }

  const existingExt: Record<string, unknown> = isPlainObject(existingPerson.extensions)
    ? structuredClone(existingPerson.extensions)
    : {};
  let extTouched = false;

  if (updates.extensions !== undefined) {
    if (!isPlainObject(updates.extensions)) {
      throw new Error('person_updates.extensions must be an object.');
    }
    for (const [k, v] of Object.entries(updates.extensions)) {
      if (k === 'sources' && Array.isArray(v)) {
        existingExt.sources = dedupeExtensionSources(
          Array.isArray(existingExt.sources) ? existingExt.sources : [],
          v
        );
      } else {
        existingExt[k] = structuredClone(v);
      }
    }
    extTouched = true;
  }

  const bioVal = updates.biography !== undefined ? updates.biography : updates.bio;
  if (bioVal !== undefined) {
    existingExt.biography = String(bioVal);
    extTouched = true;
  }
  if (updates.summary !== undefined) {
    existingExt.summary = String(updates.summary);
    extTouched = true;
  }
  if (updates.research_notes !== undefined) {
    existingExt.research_notes = String(updates.research_notes);
    extTouched = true;
  }
  if (updates.sources !== undefined) {
    if (!Array.isArray(updates.sources)) {
      throw new Error('person_updates.sources must be an array.');
    }
    existingExt.sources = dedupeExtensionSources(
      Array.isArray(existingExt.sources) ? existingExt.sources : [],
      updates.sources
    );
    extTouched = true;
  }

  if (extTouched) {
    next.extensions = existingExt;
  }

  const parsed = RawPersonSchema.parse(next);
  if (resolveEffectiveLiving(parsed, privacyConfig)) {
    throw new Error(
      `Refusing update: merged person '${parsed.id}' resolves as living under privacy rules.`
    );
  }

  const changed = JSON.stringify(existingPerson) !== JSON.stringify(parsed);
  return { updated: parsed, changed };
}

function upsertById<T extends { id: string }>(
  existingList: readonly T[],
  incomingList: readonly unknown[],
  parseItem: (raw: unknown) => T,
  mergeExisting?: (prev: T, incoming: T) => unknown
): { items: T[]; counts: UpsertCounts } {
  const result = existingList.map((item) => structuredClone(item));
  const idxById = new Map<string, number>(result.map((item, idx) => [item.id, idx]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const raw of incomingList) {
    const incoming = parseItem(raw);
    const existingIdx = idxById.get(incoming.id);
    if (existingIdx === undefined) {
      idxById.set(incoming.id, result.length);
      result.push(incoming);
      added += 1;
      continue;
    }
    const prev = result[existingIdx];
    const merged = mergeExisting ? parseItem(mergeExisting(prev, incoming)) : incoming;
    if (JSON.stringify(prev) === JSON.stringify(merged)) {
      unchanged += 1;
    } else {
      result[existingIdx] = merged;
      updated += 1;
    }
  }

  return { items: result, counts: { added, updated, unchanged } };
}

function upsertKinship(
  existingList: readonly KinshipEdge[],
  incomingList: readonly unknown[]
): { items: KinshipEdge[]; counts: UpsertCounts } {
  const result = existingList.map((item) => structuredClone(item));
  const keyOf = (edge: KinshipEdge): string => `${edge.from}|${edge.to}|${edge.relation}`;
  const idxByKey = new Map<string, number>(result.map((edge, idx) => [keyOf(edge), idx]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const raw of incomingList) {
    const incoming = KinshipEdgeSchema.parse(raw);
    const key = keyOf(incoming);
    const existingIdx = idxByKey.get(key);
    if (existingIdx === undefined) {
      idxByKey.set(key, result.length);
      result.push(incoming);
      added += 1;
      continue;
    }
    const prev = result[existingIdx];
    const merged = KinshipEdgeSchema.parse({
      ...prev,
      ...incoming,
      family_xref: incoming.family_xref !== undefined ? incoming.family_xref : prev.family_xref,
    });
    if (JSON.stringify(prev) === JSON.stringify(merged)) {
      unchanged += 1;
    } else {
      result[existingIdx] = merged;
      updated += 1;
    }
  }

  return { items: result, counts: { added, updated, unchanged } };
}

function detectMediaLayout(repoDir: string): MediaLayout {
  const archiveMediaRoot = path.join(repoDir, 'archive-media');
  if (fs.existsSync(archiveMediaRoot) && fs.statSync(archiveMediaRoot).isDirectory()) {
    // Archives with an `archive-media/` directory store `/media/scans/<file>` at
    // `archive-media/media/scans/<file>` so R2 uploads map directly to `media/scans/<file>`.
    return {
      layout: 'archive-media',
      mediaUrlRoot: archiveMediaRoot,
      scanDestDir: path.join(archiveMediaRoot, 'media', 'scans'),
      scanUrlPrefix: '/media/scans/',
      r2KeyPrefix: 'media/scans/',
    };
  }
  return {
    layout: 'media',
    mediaUrlRoot: repoDir,
    scanDestDir: path.join(repoDir, 'media'),
    scanUrlPrefix: '/media/',
    r2KeyPrefix: 'media/',
  };
}

function resolveMediaDiskPath(fileUrl: string, repoDir: string, mediaLayout: MediaLayout): string {
  if (!fileUrl.startsWith('/media/')) {
    throw new Error(`Media file URL must start with '/media/', got '${fileUrl}'.`);
  }
  const relPosix = fileUrl.slice(1);
  const parts = relPosix.split('/');
  if (parts.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new Error(`Unsafe media file URL '${fileUrl}'.`);
  }
  const diskPath = path.resolve(mediaLayout.mediaUrlRoot, ...parts);
  const publicMediaDir = path.resolve(repoDir, 'public', 'media');
  if (diskPath === publicMediaDir || diskPath.startsWith(`${publicMediaDir}${path.sep}`)) {
    throw new Error(`Media file URL '${fileUrl}' resolves inside forbidden public/media/.`);
  }
  const rootPrefix = `${path.resolve(mediaLayout.mediaUrlRoot)}${path.sep}`;
  if (!diskPath.startsWith(rootPrefix)) {
    throw new Error(`Media file URL '${fileUrl}' escapes media root.`);
  }
  return diskPath;
}

function planScanStaging(
  repoDir: string,
  packageDir: string,
  mediaLayout: MediaLayout
): PlannedScan[] {
  const scansSourceDir = path.join(packageDir, 'scans');
  if (!fs.existsSync(scansSourceDir)) {
    return [];
  }
  const entries = fs
    .readdirSync(scansSourceDir, { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const planned: PlannedScan[] = [];
  const publicDir = path.resolve(repoDir, 'public');

  for (const entry of entries) {
    if (entry.isDirectory()) {
      throw new Error(
        `Unexpected subdirectory '${entry.name}' inside ${scansSourceDir}. Place scan files directly in scans/.`
      );
    }
    if (!entry.isFile()) {
      continue;
    }
    if (
      entry.name.includes('/') ||
      entry.name.includes('\\') ||
      entry.name === '..' ||
      entry.name === '.'
    ) {
      throw new Error(`Unsafe scan filename '${entry.name}'.`);
    }
    const sourcePath = path.join(scansSourceDir, entry.name);
    const destPath = path.resolve(mediaLayout.scanDestDir, entry.name);
    if (destPath === publicDir || destPath.startsWith(`${publicDir}${path.sep}`)) {
      throw new Error(`Scan destination '${destPath}' must never target public/.`);
    }
    const { sizeBytes, sha256 } = sha256File(sourcePath);
    if (sizeBytes === 0) {
      throw new Error(`Scan file '${sourcePath}' is empty (0 bytes).`);
    }
    let alreadyIdentical = false;
    if (fs.existsSync(destPath)) {
      const existing = sha256File(destPath);
      alreadyIdentical = existing.sha256 === sha256;
    }
    planned.push({
      filename: entry.name,
      sourcePath,
      destPath,
      url: `${mediaLayout.scanUrlPrefix}${entry.name}`,
      r2Key: `${mediaLayout.r2KeyPrefix}${entry.name}`,
      sizeBytes,
      sha256,
      alreadyIdentical,
    });
  }

  return planned;
}

export function auditBundlePrivacy(bundle: ArchiveBundle, mode: BuildMode): string[] {
  const livingPeople = bundle.people.filter((p) => Boolean(p.is_living));
  const livingIds = new Set(livingPeople.map((p) => p.id));
  const leaks: string[] = [];

  for (const person of livingPeople) {
    const birthEdtf = person.birth_edtf.trim();
    if (mode === 'public') {
      if (person.full_name !== 'Living') {
        leaks.push(`public:person:${person.id}:full_name`);
      }
      if (birthEdtf.length > 0) {
        leaks.push(`public:person:${person.id}:birth_edtf`);
      }
      if (person.alt_names.length > 0) {
        leaks.push(`public:person:${person.id}:alt_names`);
      }
    } else if (birthEdtf.length > 0 && !YEAR_ONLY_RE.test(birthEdtf)) {
      leaks.push(`private:person:${person.id}:birth_edtf=${birthEdtf}`);
    }
    if (person.primary_place_id) {
      leaks.push(`${mode}:person:${person.id}:primary_place_id`);
    }
    if (person.portrait_url || person.thumb_url) {
      leaks.push(`${mode}:person:${person.id}:portrait`);
    }
    if (typeof person.media_count === 'number' && person.media_count > 0) {
      leaks.push(`${mode}:person:${person.id}:media_count=${person.media_count}`);
    }
  }

  const livingEventIds = new Set<string>();
  for (const ev of bundle.events) {
    const hasLiving = ev.participants.some((pt) => livingIds.has(pt.person_id));
    if (!hasLiving) {
      continue;
    }
    livingEventIds.add(ev.id);
    const edtfDate = ev.edtf_date.trim();
    if (mode === 'private' && edtfDate.length > 0 && !YEAR_ONLY_RE.test(edtfDate)) {
      leaks.push(`private:event:${ev.id}:edtf_date=${edtfDate}`);
    }
    if (ev.place_id) {
      leaks.push(`${mode}:event:${ev.id}:place_id`);
    }
    if (ev.photo_url) {
      leaks.push(`${mode}:event:${ev.id}:photo_url`);
    }
  }

  for (const span of bundle.residence_spans) {
    if (livingIds.has(span.person_id)) {
      leaks.push(`${mode}:residence_span:${span.id}`);
    }
  }

  for (const item of bundle.media ?? []) {
    const linkedLiving =
      Boolean(item.person_id && livingIds.has(item.person_id)) ||
      Boolean(item.person_ids?.some((pid) => livingIds.has(pid))) ||
      Boolean(item.event_id && livingEventIds.has(item.event_id));
    if (linkedLiving) {
      leaks.push(`${mode}:media:${item.id}`);
    }
  }

  for (const nar of bundle.narratives ?? []) {
    if (nar.subject_person_id && livingIds.has(nar.subject_person_id)) {
      leaks.push(`${mode}:narrative:${nar.id}:subject_person_id`);
    }
    if (nar.person_ids.some((pid) => livingIds.has(pid))) {
      leaks.push(`${mode}:narrative:${nar.id}`);
    }
  }

  return leaks;
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export async function runIntegrateCommand(
  options: IntegrateCommandOptions
): Promise<IntegrateCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const personId = options.personId.trim();
  const dryRun = Boolean(options.dryRun);

  if (!personId) {
    throw new CliValidationError('Missing required option `--person <person_id>`.');
  }
  if (!SAFE_PERSON_ID_RE.test(personId)) {
    throw new CliValidationError(
      `Invalid person_id '${personId}'. Only ASCII letters, digits, _, and - are allowed.`
    );
  }
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }

  const packageDir = path.resolve(
    options.packageDir?.trim() || path.join(repoDir, 'research', 'people', personId)
  );
  const dataDir = path.join(repoDir, 'data');
  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  const patchPath = path.join(packageDir, 'patch.json');

  if (!fs.existsSync(path.join(dataDir, 'people.yaml'))) {
    throw new CliValidationError(`Missing ${path.join(dataDir, 'people.yaml')}.`);
  }
  if (!fs.existsSync(configPath)) {
    throw new CliValidationError(`Missing ${configPath}.`);
  }
  if (!fs.existsSync(patchPath)) {
    throw new CliValidationError(`Missing person patch file: ${patchPath}`);
  }

  const siteConfig = parseKinloomConfigYaml(fs.readFileSync(configPath, 'utf8'));
  const rawPatch: unknown = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  const patch = normalizeAndValidatePatch(rawPatch, personId);

  const existingPeople = parsePeopleYaml(readOptionalUtf8(path.join(dataDir, 'people.yaml')));
  const existingEvents = parseEventsYaml(readOptionalUtf8(path.join(dataDir, 'events.yaml')));
  const existingPlaces = parsePlacesYaml(readOptionalUtf8(path.join(dataDir, 'places.yaml')));
  const existingSources = parseSourcesYaml(readOptionalUtf8(path.join(dataDir, 'sources.yaml')));
  const existingKinship = parseKinshipYaml(readOptionalUtf8(path.join(dataDir, 'kinship.yaml')));
  const existingMedia = parseMediaYaml(readOptionalUtf8(path.join(dataDir, 'media.yaml')));
  const existingNarratives = parseNarrativesYaml(
    readOptionalUtf8(path.join(dataDir, 'narratives.yaml'))
  );
  const enrichments = parseNarrativeEnrichmentsYaml(
    readOptionalUtf8(path.join(dataDir, 'narrative_enrichments.yaml'))
  );

  // Invariant 1: Target person must exist and must not be living.
  const targetIdx = existingPeople.findIndex((p) => p.id === personId);
  if (targetIdx === -1) {
    throw new Error(
      `Target person '${personId}' does not exist in ${path.join(dataDir, 'people.yaml')}.`
    );
  }
  const targetPerson = existingPeople[targetIdx];
  if (targetPerson.is_living || resolveEffectiveLiving(targetPerson, siteConfig.privacy)) {
    throw new Error(
      `PRIVACY REFUSAL: Target person '${personId}' resolves as living. Living people cannot be researched or patched.`
    );
  }

  // Merge person_updates.
  const mergedPeople = existingPeople.map((p) => structuredClone(p));
  const personMerge = mergePersonUpdates(targetPerson, patch.person_updates, siteConfig.privacy);
  mergedPeople[targetIdx] = personMerge.updated;

  const peopleById = new Map(mergedPeople.map((p) => [p.id, p]));
  const livingIds = new Set(
    mergedPeople
      .filter((p) => p.is_living || resolveEffectiveLiving(p, siteConfig.privacy))
      .map((p) => p.id)
  );

  // Invariant 2: Every place in patch.places and merged places must have valid non-(0, 0) coordinates.
  const validatedPatchPlaces = patch.places.map((pl, idx) =>
    PlaceSchema.parse(assertValidPlaceCoordinates(pl, `patch.places[${idx}]`))
  );
  const placesMerge = upsertById(existingPlaces, validatedPatchPlaces, (p) => PlaceSchema.parse(p));
  for (const pl of placesMerge.items) {
    assertValidPlaceCoordinates(pl, `merged place '${pl.id}'`);
  }

  // Sources upsert.
  const sourcesMerge = upsertById(existingSources, patch.sources, (s) =>
    SourceRecordSchema.parse(s)
  );

  // Events upsert preserving existing participants and sources on partial updates.
  const eventsMerge = upsertById(
    existingEvents,
    patch.events,
    (ev) => RawEventSchema.parse(ev),
    (prev, incoming) => ({
      ...prev,
      ...incoming,
      participants: dedupeParticipants(prev.participants, incoming.participants),
      sources: mergeEventSources(prev.sources, incoming.sources),
    })
  );

  // Media upsert.
  const mediaMerge = upsertById(existingMedia, patch.media, (m) => MediaItemSchema.parse(m));

  // Kinship upsert keyed by from|to|relation.
  const kinshipMerge = upsertKinship(existingKinship, patch.kinship);

  // Lookup sets before narrative normalization so inline citations are validated and auto-linked.
  const placeIds = new Set(placesMerge.items.map((p) => p.id));
  const sourceIds = new Set(sourcesMerge.items.map((s) => s.id));
  const mediaIds = new Set(mediaMerge.items.map((m) => m.id));
  const eventsById = new Map(eventsMerge.items.map((e) => [e.id, e]));

  let inlineCitationCount = 0;
  const normalizedPatchNarratives = patch.narratives.map((rawNar) => {
    if (!isPlainObject(rawNar)) {
      return rawNar;
    }
    const copy: Record<string, unknown> = { ...rawNar };
    if (copy.kind === undefined) {
      copy.kind = 'biography';
    }
    if (copy.kind === 'biography' && copy.subject_person_id === undefined) {
      copy.subject_person_id = personId;
    }
    if (typeof copy.body_md === 'string') {
      const citationErrors = validateNarrativeCitations(
        [{ id: typeof copy.id === 'string' ? copy.id : 'unknown', body_md: copy.body_md }],
        sourceIds,
        mediaIds
      );
      if (citationErrors.length > 0) {
        throw new Error(citationErrors[0]);
      }
      const extracted = extractNarrativeCitations(copy.body_md);
      if (extracted.references.length > 0) {
        const citedSourceIds = extracted.references.map((ref) => ref.sourceId);
        copy.source_ids = dedupeStrings(
          Array.isArray(copy.source_ids)
            ? copy.source_ids.filter((id): id is string => typeof id === 'string')
            : [],
          citedSourceIds
        );
      }
      inlineCitationCount += extracted.occurrences.length;
    }
    return copy;
  });

  const narrativesMerge = upsertById(existingNarratives, normalizedPatchNarratives, (n) =>
    NarrativeSchema.parse(n)
  );

  // Referential integrity & privacy checks on patch additions/updates.
  for (const rawEv of patch.events) {
    const ev = RawEventSchema.parse(rawEv);
    if (ev.place_id && !placeIds.has(ev.place_id)) {
      throw new Error(`Event '${ev.id}' references missing place_id '${ev.place_id}'.`);
    }
    let touchesLiving = false;
    for (const pt of ev.participants) {
      if (!peopleById.has(pt.person_id)) {
        throw new Error(`Event '${ev.id}' references missing person_id '${pt.person_id}'.`);
      }
      if (livingIds.has(pt.person_id)) {
        touchesLiving = true;
      }
    }
    if (touchesLiving) {
      throw new Error(`PRIVACY REFUSAL: Patch event '${ev.id}' includes a living participant.`);
    }
    for (const ref of ev.sources) {
      if (!sourceIds.has(ref.source_id)) {
        throw new Error(`Event '${ev.id}' references missing source_id '${ref.source_id}'.`);
      }
    }
  }

  for (const rawEdge of patch.kinship) {
    const edge = KinshipEdgeSchema.parse(rawEdge);
    if (!peopleById.has(edge.from)) {
      throw new Error(`Kinship edge references missing 'from' person '${edge.from}'.`);
    }
    if (!peopleById.has(edge.to)) {
      throw new Error(`Kinship edge references missing 'to' person '${edge.to}'.`);
    }
  }

  for (const rawNar of normalizedPatchNarratives) {
    const nar = NarrativeSchema.parse(rawNar);
    if (nar.subject_person_id !== undefined) {
      if (!peopleById.has(nar.subject_person_id)) {
        throw new Error(
          `Narrative '${nar.id}' references missing subject_person_id '${nar.subject_person_id}'.`
        );
      }
      if (livingIds.has(nar.subject_person_id)) {
        throw new Error(
          `PRIVACY REFUSAL: Narrative '${nar.id}' references living subject_person_id '${nar.subject_person_id}'.`
        );
      }
    }
    for (const pid of nar.person_ids) {
      if (!peopleById.has(pid)) {
        throw new Error(`Narrative '${nar.id}' references missing person_id '${pid}'.`);
      }
      if (livingIds.has(pid)) {
        throw new Error(`PRIVACY REFUSAL: Narrative '${nar.id}' references living person '${pid}'.`);
      }
    }
    for (const plId of nar.place_ids) {
      if (!placeIds.has(plId)) {
        throw new Error(`Narrative '${nar.id}' references missing place_id '${plId}'.`);
      }
    }
    for (const evId of nar.event_ids) {
      if (!eventsById.has(evId)) {
        throw new Error(`Narrative '${nar.id}' references missing event_id '${evId}'.`);
      }
    }
    for (const srcId of nar.source_ids) {
      if (!sourceIds.has(srcId)) {
        throw new Error(`Narrative '${nar.id}' references missing source_id '${srcId}'.`);
      }
    }
  }

  // Scan staging plan & verify every patch.media[].file exists on disk or in packageDir/scans/.
  const mediaLayout = detectMediaLayout(repoDir);
  const plannedScans = planScanStaging(repoDir, packageDir, mediaLayout);
  const stagedDestSet = new Set(plannedScans.map((s) => s.destPath));

  for (const rawMedia of patch.media) {
    const item = MediaItemSchema.parse(rawMedia);
    const privacyCheck = validateMediaForPrivacy(item, livingIds, eventsById);
    if (!privacyCheck.ok) {
      throw new Error(`PRIVACY REFUSAL: ${privacyCheck.message}`);
    }
    for (const pid of getMediaPersonIds(item)) {
      if (!peopleById.has(pid)) {
        throw new Error(`Media '${item.id}' references missing person_id '${pid}'.`);
      }
    }
    if (item.event_id && !eventsById.has(item.event_id)) {
      throw new Error(`Media '${item.id}' references missing event_id '${item.event_id}'.`);
    }
    if (item.source_id && !sourceIds.has(item.source_id)) {
      throw new Error(`Media '${item.id}' references missing source_id '${item.source_id}'.`);
    }

    const expectedDiskPath = resolveMediaDiskPath(item.file, repoDir, mediaLayout);
    if (!fs.existsSync(expectedDiskPath) && !stagedDestSet.has(expectedDiskPath)) {
      throw new Error(
        `Missing scan file for media '${item.id}': '${item.file}' expected at '${expectedDiskPath}' (not on disk and not staged from ${path.join(packageDir, 'scans')}).`
      );
    }
  }

  // Compile merged archive in both private and public modes before writing anything.
  const compileBase = {
    people: mergedPeople,
    events: eventsMerge.items,
    places: placesMerge.items,
    sources: sourcesMerge.items,
    kinship: kinshipMerge.items,
    media: mediaMerge.items,
    narratives: narrativesMerge.items,
    ...(enrichments.length > 0 ? { enrichments } : {}),
    siteConfig,
  };

  const privateResult = compileArchive({ ...compileBase, mode: 'private' });
  const publicResult = compileArchive({ ...compileBase, mode: 'public' });

  ArchiveBundleSchema.parse(privateResult.bundle);
  ArchiveBundleSchema.parse(publicResult.bundle);

  const privateLeaks = auditBundlePrivacy(privateResult.bundle, 'private');
  const publicLeaks = auditBundlePrivacy(publicResult.bundle, 'public');
  const allLeaks = [...privateLeaks, ...publicLeaks];

  if (allLeaks.length > 0) {
    throw new Error(`PRIVACY LEAK DETECTED (${allLeaks.length}): ${allLeaks.join('; ')}`);
  }
  if (privateResult.reviewFlags.length > 0 || publicResult.reviewFlags.length > 0) {
    throw new Error(
      `PRIVACY REVIEW FLAGS DETECTED (private=${privateResult.reviewFlags.length}, public=${publicResult.reviewFlags.length}): ${[
        ...privateResult.reviewFlags,
        ...publicResult.reviewFlags,
      ].join('; ')}`
    );
  }

  // Stage scans and write modified YAML files when not dryRun.
  const stagedScansReport: StagedScanReportItem[] = [];
  for (const scan of plannedScans) {
    let status: StagedScanReportItem['status'];
    if (dryRun) {
      status = scan.alreadyIdentical ? 'unchanged' : 'would_stage';
    } else if (scan.alreadyIdentical) {
      status = 'unchanged';
    } else {
      fs.mkdirSync(path.dirname(scan.destPath), { recursive: true });
      fs.copyFileSync(scan.sourcePath, scan.destPath);
      status = 'staged';
    }
    stagedScansReport.push({
      filename: scan.filename,
      sourcePath: scan.sourcePath,
      destPath: scan.destPath,
      url: scan.url,
      r2Key: scan.r2Key,
      status,
      sizeBytes: scan.sizeBytes,
      sha256: scan.sha256,
    });
  }

  const pendingWrites: Array<{ file: string; content: string }> = [];
  if (personMerge.changed) {
    pendingWrites.push({
      file: 'people.yaml',
      content: serializePeopleYaml(mergedPeople, { sortById: true }),
    });
  }
  if (eventsMerge.counts.added > 0 || eventsMerge.counts.updated > 0) {
    pendingWrites.push({
      file: 'events.yaml',
      content: serializeEventsYaml(eventsMerge.items, { sortById: true }),
    });
  }
  if (placesMerge.counts.added > 0 || placesMerge.counts.updated > 0) {
    pendingWrites.push({
      file: 'places.yaml',
      content: serializePlacesYaml(placesMerge.items, { sortById: true }),
    });
  }
  if (sourcesMerge.counts.added > 0 || sourcesMerge.counts.updated > 0) {
    pendingWrites.push({
      file: 'sources.yaml',
      content: serializeSourcesYaml(sourcesMerge.items, { sortById: true }),
    });
  }
  if (kinshipMerge.counts.added > 0 || kinshipMerge.counts.updated > 0) {
    pendingWrites.push({
      file: 'kinship.yaml',
      content: serializeKinshipYaml(kinshipMerge.items, { sortDeterministic: true }),
    });
  }
  if (mediaMerge.counts.added > 0 || mediaMerge.counts.updated > 0) {
    pendingWrites.push({
      file: 'media.yaml',
      content: serializeMediaYaml(mediaMerge.items, { sortById: true }),
    });
  }
  if (narrativesMerge.counts.added > 0 || narrativesMerge.counts.updated > 0) {
    pendingWrites.push({
      file: 'narratives.yaml',
      content: serializeNarrativesYaml(narrativesMerge.items, { sortById: true }),
    });
  }

  const writtenYamlFiles: string[] = [];
  if (!dryRun) {
    for (const item of pendingWrites) {
      const fullPath = path.join(dataDir, item.file);
      writeFileAtomic(fullPath, item.content);
      writtenYamlFiles.push(fullPath);
    }
  }

  const summaryBase = {
    ok: true as const,
    dryRun,
    repo: repoDir,
    personId,
    packageDir,
    mediaLayout: mediaLayout.layout,
    counts: {
      personUpdated: personMerge.changed,
      events: eventsMerge.counts,
      places: placesMerge.counts,
      sources: sourcesMerge.counts,
      media: mediaMerge.counts,
      kinship: kinshipMerge.counts,
      narratives: narrativesMerge.counts,
    },
    inlineCitationCount,
    stagedScans: stagedScansReport,
    wouldWriteYamlFiles: pendingWrites.map((w) => path.join(dataDir, w.file)),
    writtenYamlFiles,
    validation: {
      privateCounts: privateResult.bundle.meta.counts,
      publicCounts: publicResult.bundle.meta.counts,
      privateReviewFlags: privateResult.reviewFlags.length,
      publicReviewFlags: publicResult.reviewFlags.length,
      livingLeaks: allLeaks.length,
    },
  };

  const rendered = options.json
    ? JSON.stringify(summaryBase, null, 2)
    : `Integrate ${dryRun ? 'dry-run ' : ''}OK for ${personId}: ` +
      `person=${personMerge.changed ? 'updated' : 'unchanged'}, ` +
      `events=+${eventsMerge.counts.added}/~${eventsMerge.counts.updated}, ` +
      `places=+${placesMerge.counts.added}/~${placesMerge.counts.updated}, ` +
      `sources=+${sourcesMerge.counts.added}/~${sourcesMerge.counts.updated}, ` +
      `media=+${mediaMerge.counts.added}/~${mediaMerge.counts.updated}, ` +
      `narratives=+${narrativesMerge.counts.added}/~${narrativesMerge.counts.updated}, ` +
      `inlineCitations=${inlineCitationCount}, scans=${stagedScansReport.length}, ` +
      `written=${writtenYamlFiles.length}`;

  return {
    ...summaryBase,
    rendered,
  };
}
