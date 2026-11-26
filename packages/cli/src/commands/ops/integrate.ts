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
  edtfToBounds,
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
  type AlternateDate,
  type ArchiveBundle,
  type BuildMode,
  type EventParticipant,
  type KinshipEdge,
  type PrivacyConfig,
  type RawEvent,
  type RawPerson,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';

const YEAR_ONLY_RE = /^\d{4}$/;
const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;
const SAFE_SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

const ALLOWED_PATCH_KEYS = new Set([
  'person_id',
  'person_updates',
  'people',
  'events',
  'remove_event_ids',
  'places',
  'sources',
  'remove_source_ids',
  'media',
  'remove_media_ids',
  'kinship',
  'remove_kinship',
  'narratives',
]);

const ALLOWED_REMOVE_KINSHIP_KEYS = new Set([
  'from',
  'to',
  'relation',
  'family_xref',
  'symmetric',
]);

const RECIPROCAL_KINSHIP_RELATION: Record<KinshipEdge['relation'], KinshipEdge['relation']> = {
  parent: 'child',
  child: 'parent',
  spouse: 'spouse',
};

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
  'pronunciation',
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

export interface RemoveKinshipEntry {
  from: string;
  to: string;
  relation: KinshipEdge['relation'];
  family_xref?: string;
  symmetric: boolean;
}

export interface RemoveKinshipTarget {
  from: string;
  to: string;
  relation: KinshipEdge['relation'];
  family_xref?: string;
}

export interface RemovedKinshipEdge {
  from: string;
  to: string;
  relation: KinshipEdge['relation'];
  family_xref?: string;
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
    people: UpsertCounts;
    events: UpsertCounts;
    places: UpsertCounts;
    sources: UpsertCounts;
    media: UpsertCounts;
    kinship: UpsertCounts;
    narratives: UpsertCounts;
  };
  removedSourceIds: string[];
  removedEventIds: string[];
  removedMediaIds: string[];
  removedKinshipCount: number;
  removedKinship: RemovedKinshipEdge[];
  removedEvents: number;
  removedMedia: number;
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

export const INTEGRATION_RECEIPT_FILENAME = '.integrated.json';

export interface IntegrationReceiptEntityIds {
  people: string[];
  events: string[];
  places: string[];
  sources: string[];
  media: string[];
  narratives: string[];
}

export interface IntegrationReceipt {
  schema_version: 1;
  person_id: string;
  patch_sha256: string;
  scans_sha256: Record<string, string>;
  integrated_at: string;
  integrated_entity_ids: IntegrationReceiptEntityIds;
}

export interface PackageFingerprints {
  patch_sha256: string;
  scans_sha256: Record<string, string>;
}

export const INTEGRATE_YAML_FILES = [
  'people.yaml',
  'events.yaml',
  'places.yaml',
  'sources.yaml',
  'kinship.yaml',
  'media.yaml',
  'narratives.yaml',
] as const;

export interface IntegrateExecutionOverlay {
  dataDirOverride: string;
  virtualStagedScans: Map<string, string>;
}

export interface MediaLayout {
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
  people: unknown[];
  events: unknown[];
  remove_event_ids: string[];
  places: unknown[];
  sources: unknown[];
  remove_source_ids: string[];
  media: unknown[];
  remove_media_ids: string[];
  kinship: unknown[];
  remove_kinship: RemoveKinshipEntry[];
  narratives: unknown[];
}

function isKinshipRelationValue(value: unknown): value is KinshipEdge['relation'] {
  return value === 'parent' || value === 'child' || value === 'spouse';
}

export function getReciprocalKinshipRelation(
  relation: KinshipEdge['relation']
): KinshipEdge['relation'] {
  return RECIPROCAL_KINSHIP_RELATION[relation];
}

export function parseRemoveKinshipEntries(raw: unknown, label: string): RemoveKinshipEntry[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new CliValidationError(`${label} must be an array.`);
  }
  const entries: RemoveKinshipEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const itemLabel = `${label}[${i}]`;
    const item = raw[i];
    if (!isPlainObject(item)) {
      throw new CliValidationError(`${itemLabel} must be a JSON object.`);
    }
    for (const key of Object.keys(item)) {
      if (!ALLOWED_REMOVE_KINSHIP_KEYS.has(key)) {
        throw new CliValidationError(`Unknown key '${key}' in ${itemLabel}.`);
      }
    }
    if (
      typeof item.from !== 'string' ||
      item.from.length === 0 ||
      item.from !== item.from.trim() ||
      !SAFE_PERSON_ID_RE.test(item.from)
    ) {
      throw new CliValidationError(
        `${itemLabel}.from has invalid person_id '${String(item.from)}'. Only ASCII letters, digits, _, and - are allowed.`
      );
    }
    if (
      typeof item.to !== 'string' ||
      item.to.length === 0 ||
      item.to !== item.to.trim() ||
      !SAFE_PERSON_ID_RE.test(item.to)
    ) {
      throw new CliValidationError(
        `${itemLabel}.to has invalid person_id '${String(item.to)}'. Only ASCII letters, digits, _, and - are allowed.`
      );
    }
    if (!isKinshipRelationValue(item.relation)) {
      throw new CliValidationError(
        `${itemLabel}.relation must be 'parent', 'child', or 'spouse', got '${String(item.relation)}'.`
      );
    }
    let familyXref: string | undefined;
    if (item.family_xref !== undefined) {
      if (typeof item.family_xref !== 'string' || item.family_xref.trim().length === 0) {
        throw new CliValidationError(
          `${itemLabel}.family_xref must be a non-empty string when provided.`
        );
      }
      familyXref = item.family_xref.trim();
    }
    let symmetric = true;
    if (item.symmetric !== undefined) {
      if (typeof item.symmetric !== 'boolean') {
        throw new CliValidationError(`${itemLabel}.symmetric must be a boolean when provided.`);
      }
      symmetric = item.symmetric;
    }
    entries.push({
      from: item.from,
      to: item.to,
      relation: item.relation,
      ...(familyXref !== undefined ? { family_xref: familyXref } : {}),
      symmetric,
    });
  }
  return entries;
}

export function expandRemoveKinshipTargets(
  entries: readonly RemoveKinshipEntry[]
): RemoveKinshipTarget[] {
  const targets: RemoveKinshipTarget[] = [];
  const seen = new Set<string>();
  const pushTarget = (target: RemoveKinshipTarget): void => {
    const key = `${target.from}|${target.to}|${target.relation}|${target.family_xref ?? '*'}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  };
  for (const entry of entries) {
    const xrefPart = entry.family_xref !== undefined ? { family_xref: entry.family_xref } : {};
    pushTarget({
      from: entry.from,
      to: entry.to,
      relation: entry.relation,
      ...xrefPart,
    });
    if (entry.symmetric) {
      pushTarget({
        from: entry.to,
        to: entry.from,
        relation: getReciprocalKinshipRelation(entry.relation),
        ...xrefPart,
      });
    }
  }
  return targets;
}

function matchesRemoveKinshipTarget(edge: KinshipEdge, target: RemoveKinshipTarget): boolean {
  if (edge.from !== target.from || edge.to !== target.to || edge.relation !== target.relation) {
    return false;
  }
  if (target.family_xref !== undefined) {
    return edge.family_xref === target.family_xref;
  }
  return true;
}

function normalizedXref(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function applyKinshipRemovals(
  existingList: readonly KinshipEdge[],
  entries: readonly RemoveKinshipEntry[],
  incomingList?: readonly KinshipEdge[]
): { remaining: KinshipEdge[]; removed: RemovedKinshipEdge[] } {
  if (entries.length === 0) {
    return {
      remaining: existingList.map((edge) => structuredClone(edge)),
      removed: [],
    };
  }
  const targets = expandRemoveKinshipTargets(entries);
  const incomingByExactKey = new Set<string>();
  for (const edge of incomingList ?? []) {
    incomingByExactKey.add(
      `${edge.from}|${edge.to}|${edge.relation}|${normalizedXref(edge.family_xref) ?? ''}`
    );
  }
  const remaining: KinshipEdge[] = [];
  const removed: RemovedKinshipEdge[] = [];
  for (const edge of existingList) {
    const matched = targets.some((target) => matchesRemoveKinshipTarget(edge, target));
    if (!matched) {
      remaining.push(structuredClone(edge));
      continue;
    }
    // Preserve an edge that patch.kinship would immediately re-insert identically so re-runs stay idempotent.
    const exactKey = `${edge.from}|${edge.to}|${edge.relation}|${normalizedXref(edge.family_xref) ?? ''}`;
    if (incomingByExactKey.has(exactKey)) {
      remaining.push(structuredClone(edge));
      continue;
    }
    const xref = normalizedXref(edge.family_xref);
    removed.push({
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      ...(xref !== null ? { family_xref: xref } : {}),
    });
  }
  return { remaining, removed };
}

function verifyKinshipSymmetryForRemovedPairs(
  finalKinship: readonly KinshipEdge[],
  removeEntries: readonly RemoveKinshipEntry[]
): void {
  if (removeEntries.length === 0) {
    return;
  }
  const edgeByDirectedKey = new Map<string, KinshipEdge>();
  for (const edge of finalKinship) {
    edgeByDirectedKey.set(`${edge.from}|${edge.to}|${edge.relation}`, edge);
  }
  const orphaned: string[] = [];
  const checked = new Set<string>();
  for (const entry of removeEntries) {
    const forwardKey = `${entry.from}|${entry.to}|${entry.relation}`;
    const reciprocalRelation = getReciprocalKinshipRelation(entry.relation);
    const reciprocalKey = `${entry.to}|${entry.from}|${reciprocalRelation}`;
    const pairKey = forwardKey < reciprocalKey ? `${forwardKey}<>${reciprocalKey}` : `${reciprocalKey}<>${forwardKey}`;
    if (checked.has(pairKey)) {
      continue;
    }
    checked.add(pairKey);
    const forwardEdge = edgeByDirectedKey.get(forwardKey);
    const reciprocalEdge = edgeByDirectedKey.get(reciprocalKey);
    if (Boolean(forwardEdge) === Boolean(reciprocalEdge)) {
      continue;
    }
    const surviving = forwardEdge ?? reciprocalEdge!;
    const missingKey = forwardEdge ? reciprocalKey : forwardKey;
    const xrefLabel =
      typeof surviving.family_xref === 'string' && surviving.family_xref.length > 0
        ? ` [family_xref=${surviving.family_xref}]`
        : '';
    orphaned.push(
      `surviving '${surviving.from} -> ${surviving.to} (${surviving.relation})'${xrefLabel} is missing reciprocal '${missingKey.replaceAll('|', ' -> ')}'`
    );
  }
  if (orphaned.length > 0) {
    throw new CliValidationError(
      `Asymmetric kinship graph after remove_kinship: ${orphaned.join('; ')}. ` +
        `Use symmetric: true (default), omit family_xref if inverse edges differ, or remove both directions explicitly.`
    );
  }
}

function parseOptionalStringList(raw: unknown, label: string): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${label}[${i}] must be a non-empty string.`);
    }
    const trimmed = item.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
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

// Incoming roles replace a person's existing roles on the event. A person keeps
// several roles only when the incoming patch lists each one explicitly.
function dedupeParticipants(
  existing: readonly EventParticipant[] | undefined,
  additions: readonly EventParticipant[] | undefined
): EventParticipant[] {
  const incomingIds = new Set((additions ?? []).map((pt) => pt.person_id));
  const retained = (existing ?? []).filter((pt) => !incomingIds.has(pt.person_id));
  const out: EventParticipant[] = [];
  const seen = new Set<string>();
  for (const pt of [...retained, ...(additions ?? [])]) {
    const key = `${pt.person_id}|${pt.role}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ person_id: pt.person_id, role: pt.role });
  }
  return out;
}

function alternateDateKey(entry: AlternateDate): string {
  return `${entry.edtf_date}\u0000${entry.source_id}\u0000${entry.note}`;
}

function mergeAlternateDates(
  existing: readonly AlternateDate[] | undefined,
  incoming: readonly AlternateDate[] | undefined,
): AlternateDate[] | undefined {
  if (incoming === undefined) {
    return existing?.map((entry) => ({ ...entry }));
  }
  const merged: AlternateDate[] = [];
  const seen = new Set<string>();
  for (const entry of [...(existing ?? []), ...incoming]) {
    const key = alternateDateKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push({
      edtf_date: entry.edtf_date,
      source_id: entry.source_id,
      note: entry.note,
    });
  }
  return merged;
}

function mergedPrimarySourceFlag(
  existing: boolean | undefined,
  incoming: boolean | undefined,
): boolean | undefined {
  if (existing === true || incoming === true) {
    return true;
  }
  if (existing === false || incoming === false) {
    return false;
  }
  return undefined;
}

function mergeSharedEvent(prev: RawEvent, incoming: RawEvent, removeSourceIds: Set<string> | undefined): RawEvent {
  const retainedPrevSources = removeSourceIds
    ? prev.sources.filter((ref) => !removeSourceIds.has(ref.source_id))
    : prev.sources;
  const merged: RawEvent = {
    ...prev,
    ...incoming,
    participants: dedupeParticipants(prev.participants, incoming.participants),
    sources: mergeEventSources(retainedPrevSources, incoming.sources),
  };

  const hasPrimarySource = mergedPrimarySourceFlag(
    prev.has_primary_source,
    incoming.has_primary_source,
  );
  if (hasPrimarySource === undefined) {
    delete merged.has_primary_source;
  } else {
    merged.has_primary_source = hasPrimarySource;
  }

  const alternateDates = mergeAlternateDates(prev.alternate_dates, incoming.alternate_dates);
  if (alternateDates === undefined) {
    delete merged.alternate_dates;
  } else {
    merged.alternate_dates = alternateDates;
  }

  if (!Object.hasOwn(incoming, 'place_precision')) {
    if (prev.place_precision === undefined) {
      delete merged.place_precision;
    } else {
      merged.place_precision = prev.place_precision;
    }
  }

  return merged;
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
    people: readArrayField('people'),
    events: readArrayField('events'),
    remove_event_ids: parseOptionalStringList(
      rawPatch.remove_event_ids,
      'patch.json remove_event_ids'
    ),
    places: readArrayField('places'),
    sources: readArrayField('sources'),
    remove_source_ids: parseOptionalStringList(
      rawPatch.remove_source_ids,
      'patch.json remove_source_ids'
    ),
    media: readArrayField('media'),
    remove_media_ids: parseOptionalStringList(
      rawPatch.remove_media_ids,
      'patch.json remove_media_ids'
    ),
    kinship: readArrayField('kinship'),
    remove_kinship: parseRemoveKinshipEntries(
      rawPatch.remove_kinship,
      'patch.json remove_kinship'
    ),
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

export function parseValidDeathEdtf(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const trimmed = String(raw).trim();
  const slashIdx = trimmed.indexOf('/');
  if (!trimmed || (slashIdx !== -1 && trimmed.indexOf('/', slashIdx + 1) !== -1)) {
    return null;
  }
  return edtfToBounds(trimmed) !== null ? trimmed : null;
}

function resolveValidDeathEdtfUpdate(updates: Record<string, unknown> | null): string | null {
  if (!updates) {
    return null;
  }
  if (
    updates.death_edtf !== undefined &&
    updates.death_date !== undefined &&
    String(updates.death_edtf) !== String(updates.death_date)
  ) {
    throw new Error('person_updates has conflicting death_edtf and death_date.');
  }
  const raw = updates.death_edtf !== undefined ? updates.death_edtf : updates.death_date;
  return parseValidDeathEdtf(raw);
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
    'pronunciation',
    'has_primary_source',
  ] as const;

  for (const field of directFields) {
    if (updates[field] !== undefined) {
      next[field] = structuredClone(updates[field]);
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

function assertPersonAllowedForPatch(
  person: RawPerson,
  label: string,
  privacyConfig: Partial<PrivacyConfig>
): void {
  if (person.full_name.trim().length === 0) {
    throw new CliValidationError(`${label} ('${person.id}') must have a non-empty full_name.`);
  }
  if (!SAFE_SLUG_RE.test(person.slug)) {
    throw new CliValidationError(
      `${label} ('${person.id}') has invalid slug '${person.slug}'. Use lowercase ASCII letters, digits, hyphens, or underscores.`
    );
  }
  if (person.is_living || resolveEffectiveLiving(person, privacyConfig)) {
    throw new CliValidationError(
      `PRIVACY REFUSAL: ${label} ('${person.id}') resolves as living under archive privacy rules (birth_edtf='${person.birth_edtf}', death_edtf='${person.death_edtf}').`
    );
  }
}

function mergeStagedPersonWithExisting(
  existing: RawPerson,
  rawObj: Record<string, unknown>,
  parsedIncoming: RawPerson,
  label: string,
  privacyConfig: Partial<PrivacyConfig>
): RawPerson {
  const next: Record<string, unknown> = structuredClone(existing);
  const directFields = [
    'slug',
    'gedcom_xref',
    'full_name',
    'given_name',
    'surname',
    'sex',
    'is_living',
    'lineage_group',
    'branch',
    'birth_edtf',
    'death_edtf',
    'portrait_url',
    'thumb_url',
    'pronunciation',
    'has_primary_source',
  ] as const;

  for (const field of directFields) {
    if (Object.hasOwn(rawObj, field) && rawObj[field] !== undefined) {
      next[field] = structuredClone(parsedIncoming[field]);
    }
  }

  if (Object.hasOwn(rawObj, 'alt_names') && rawObj.alt_names !== undefined) {
    next.alt_names = dedupeStrings(existing.alt_names, parsedIncoming.alt_names);
  }

  if (Object.hasOwn(rawObj, 'extensions') && rawObj.extensions !== undefined) {
    const existingExt: Record<string, unknown> = isPlainObject(existing.extensions)
      ? structuredClone(existing.extensions)
      : {};
    for (const [k, v] of Object.entries(parsedIncoming.extensions ?? {})) {
      if (k === 'sources' && Array.isArray(v)) {
        existingExt.sources = dedupeExtensionSources(
          Array.isArray(existingExt.sources) ? existingExt.sources : [],
          v
        );
      } else {
        existingExt[k] = structuredClone(v);
      }
    }
    next.extensions = existingExt;
  }

  const parsedMerged = RawPersonSchema.parse(next);
  assertPersonAllowedForPatch(parsedMerged, label, privacyConfig);
  return parsedMerged;
}

function upsertPatchPeople(
  existingPeople: readonly RawPerson[],
  incomingPeople: readonly unknown[],
  privacyConfig: Partial<PrivacyConfig>
): {
  items: RawPerson[];
  idxById: Map<string, number>;
  slugToId: Map<string, string>;
  counts: UpsertCounts;
} {
  const items = existingPeople.map((p) => structuredClone(p));
  const idxById = new Map<string, number>();
  const slugToId = new Map<string, string>();
  for (let i = 0; i < items.length; i += 1) {
    const person = items[i];
    idxById.set(person.id, i);
    slugToId.set(person.slug, person.id);
  }

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const seenPatchIds = new Set<string>();

  for (let i = 0; i < incomingPeople.length; i += 1) {
    const label = `patch.people[${i}]`;
    const raw = incomingPeople[i];
    if (!isPlainObject(raw)) {
      throw new CliValidationError(`${label} must be a JSON object.`);
    }
    if (raw.is_living === true || raw.living === true) {
      throw new CliValidationError(
        `PRIVACY REFUSAL: ${label} ('${String(raw.id ?? 'unknown')}') cannot insert or mark a person as living.`
      );
    }
    if (typeof raw.id !== 'string' || !SAFE_PERSON_ID_RE.test(raw.id) || raw.id !== raw.id.trim()) {
      throw new CliValidationError(
        `${label} has invalid id '${String(raw.id)}'. Only ASCII letters, digits, _, and - are allowed.`
      );
    }
    if (seenPatchIds.has(raw.id)) {
      throw new CliValidationError(`Duplicate person id '${raw.id}' in patch.people.`);
    }
    seenPatchIds.add(raw.id);

    const parsedResult = RawPersonSchema.safeParse(raw);
    if (!parsedResult.success) {
      const detail = parsedResult.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ');
      throw new CliValidationError(`Invalid person in ${label}: ${detail}`);
    }
    const parsed = parsedResult.data;
    assertPersonAllowedForPatch(parsed, label, privacyConfig);

    const existingIdx = idxById.get(parsed.id);
    if (existingIdx === undefined) {
      const slugOwner = slugToId.get(parsed.slug);
      if (slugOwner !== undefined && slugOwner !== parsed.id) {
        throw new CliValidationError(
          `Slug collision: ${label} ('${parsed.id}') reuses slug '${parsed.slug}' already owned by '${slugOwner}'.`
        );
      }
      idxById.set(parsed.id, items.length);
      slugToId.set(parsed.slug, parsed.id);
      items.push(parsed);
      added += 1;
      continue;
    }

    const existing = items[existingIdx];
    if (existing.is_living || resolveEffectiveLiving(existing, privacyConfig)) {
      throw new CliValidationError(
        `PRIVACY REFUSAL: ${label} cannot modify existing living person '${existing.id}'.`
      );
    }
    const merged = mergeStagedPersonWithExisting(existing, raw, parsed, label, privacyConfig);
    const slugOwner = slugToId.get(merged.slug);
    if (slugOwner !== undefined && slugOwner !== merged.id) {
      throw new CliValidationError(
        `Slug collision: ${label} ('${merged.id}') reuses slug '${merged.slug}' already owned by '${slugOwner}'.`
      );
    }
    if (canonicalJsonStringify(existing) === canonicalJsonStringify(merged)) {
      unchanged += 1;
    } else {
      if (existing.slug !== merged.slug && slugToId.get(existing.slug) === existing.id) {
        slugToId.delete(existing.slug);
      }
      slugToId.set(merged.slug, merged.id);
      items[existingIdx] = merged;
      updated += 1;
    }
  }

  return { items, idxById, slugToId, counts: { added, updated, unchanged } };
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted((a, b) =>
      a.localeCompare(b)
    )) {
      const prop = (value as Record<string, unknown>)[key];
      if (prop !== undefined) {
        sorted[key] = canonicalizeJsonValue(prop);
      }
    }
    return sorted;
  }
  return value;
}

function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

function mergeRecordExtensions(
  prevExt?: Readonly<Record<string, unknown>>,
  incomingExt?: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined {
  if (!prevExt && !incomingExt) {
    return undefined;
  }
  return {
    ...(prevExt ? structuredClone(prevExt) : {}),
    ...(incomingExt ? structuredClone(incomingExt) : {}),
  };
}

export function computePackageFingerprints(packageDir: string): PackageFingerprints {
  const patchPath = path.join(packageDir, 'patch.json');
  const patch_sha256 = sha256File(patchPath).sha256;
  const scans_sha256: Record<string, string> = {};
  const scansDir = path.join(packageDir, 'scans');
  if (fs.existsSync(scansDir) && fs.statSync(scansDir).isDirectory()) {
    const entries = fs
      .readdirSync(scansDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter(
        (name) => !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..'
      )
      .toSorted((a, b) => a.localeCompare(b));
    for (const name of entries) {
      scans_sha256[name] = sha256File(path.join(scansDir, name)).sha256;
    }
  }
  return { patch_sha256, scans_sha256 };
}

export function readIntegrationReceipt(packageDir: string): IntegrationReceipt | null {
  const receiptPath = path.join(packageDir, INTEGRATION_RECEIPT_FILENAME);
  if (!fs.existsSync(receiptPath)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    if (!isPlainObject(parsed)) {
      return null;
    }
    if (
      parsed.schema_version !== 1 ||
      typeof parsed.person_id !== 'string' ||
      typeof parsed.patch_sha256 !== 'string' ||
      !isPlainObject(parsed.scans_sha256) ||
      typeof parsed.integrated_at !== 'string' ||
      !isPlainObject(parsed.integrated_entity_ids)
    ) {
      return null;
    }
    const scans: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.scans_sha256)) {
      if (typeof v !== 'string') {
        return null;
      }
      scans[k] = v;
    }
    const readIds = (field: unknown): string[] =>
      Array.isArray(field) ? field.filter((item): item is string => typeof item === 'string') : [];
    const ids = parsed.integrated_entity_ids;
    return {
      schema_version: 1,
      person_id: parsed.person_id,
      patch_sha256: parsed.patch_sha256,
      scans_sha256: scans,
      integrated_at: parsed.integrated_at,
      integrated_entity_ids: {
        people: readIds(ids.people),
        events: readIds(ids.events),
        places: readIds(ids.places),
        sources: readIds(ids.sources),
        media: readIds(ids.media),
        narratives: readIds(ids.narratives),
      },
    };
  } catch {
    return null;
  }
}

export function doesReceiptMatchPackage(
  receipt: IntegrationReceipt,
  fingerprints: PackageFingerprints
): boolean {
  if (receipt.patch_sha256 !== fingerprints.patch_sha256) {
    return false;
  }
  const receiptKeys = Object.keys(receipt.scans_sha256).toSorted((a, b) => a.localeCompare(b));
  const currentKeys = Object.keys(fingerprints.scans_sha256).toSorted((a, b) => a.localeCompare(b));
  if (receiptKeys.length !== currentKeys.length) {
    return false;
  }
  for (let i = 0; i < receiptKeys.length; i += 1) {
    const key = receiptKeys[i];
    if (key !== currentKeys[i] || receipt.scans_sha256[key] !== fingerprints.scans_sha256[key]) {
      return false;
    }
  }
  return true;
}

export function writeIntegrationReceipt(packageDir: string, receipt: IntegrationReceipt): string {
  const receiptPath = path.join(packageDir, INTEGRATION_RECEIPT_FILENAME);
  writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receiptPath;
}

function collectIdsFromRawList(list: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const item of list) {
    if (isPlainObject(item) && typeof item.id === 'string' && item.id.trim().length > 0) {
      out.add(item.id.trim());
    }
  }
  return [...out].toSorted((a, b) => a.localeCompare(b));
}

export function buildIntegrationReceiptForPackage(
  packageDir: string,
  personId: string,
  integratedAt = new Date().toISOString()
): IntegrationReceipt {
  const fingerprints = computePackageFingerprints(packageDir);
  const patchPath = path.join(packageDir, 'patch.json');
  const raw: unknown = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  const obj = isPlainObject(raw) ? raw : {};
  const peopleIds = new Set<string>(collectIdsFromRawList(Array.isArray(obj.people) ? obj.people : []));
  peopleIds.add(personId);
  return {
    schema_version: 1,
    person_id: personId,
    patch_sha256: fingerprints.patch_sha256,
    scans_sha256: fingerprints.scans_sha256,
    integrated_at: integratedAt,
    integrated_entity_ids: {
      people: [...peopleIds].toSorted((a, b) => a.localeCompare(b)),
      events: collectIdsFromRawList(Array.isArray(obj.events) ? obj.events : []),
      places: collectIdsFromRawList(Array.isArray(obj.places) ? obj.places : []),
      sources: collectIdsFromRawList(Array.isArray(obj.sources) ? obj.sources : []),
      media: collectIdsFromRawList(Array.isArray(obj.media) ? obj.media : []),
      narratives: collectIdsFromRawList(Array.isArray(obj.narratives) ? obj.narratives : []),
    },
  };
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
    if (canonicalJsonStringify(prev) === canonicalJsonStringify(merged)) {
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
    if (canonicalJsonStringify(prev) === canonicalJsonStringify(merged)) {
      unchanged += 1;
    } else {
      result[existingIdx] = merged;
      updated += 1;
    }
  }

  return { items: result, counts: { added, updated, unchanged } };
}

export function detectMediaLayout(repoDir: string): MediaLayout {
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
  mediaLayout: MediaLayout,
  virtualStagedScans?: ReadonlyMap<string, string>
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
    const virtualHash = virtualStagedScans?.get(destPath);
    if (virtualHash !== undefined) {
      alreadyIdentical = virtualHash === sha256;
    } else if (fs.existsSync(destPath)) {
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
  return executeIntegrateSingle(options);
}

export async function executeIntegrateSingle(
  options: IntegrateCommandOptions,
  overlay?: IntegrateExecutionOverlay
): Promise<IntegrateCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const personId = options.personId.trim();
  const dryRun = Boolean(options.dryRun || overlay);

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

  let packageDir = path.resolve(
    options.packageDir?.trim() || path.join(repoDir, 'research', 'people', personId)
  );
  if (
    options.packageDir?.trim() &&
    fs.existsSync(packageDir) &&
    fs.statSync(packageDir).isFile() &&
    path.basename(packageDir) === 'patch.json'
  ) {
    packageDir = path.dirname(packageDir);
  }
  const realDataDir = path.join(repoDir, 'data');
  const dataDir = overlay ? overlay.dataDirOverride : realDataDir;
  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  const patchPath = path.join(packageDir, 'patch.json');

  if (!fs.existsSync(path.join(dataDir, 'people.yaml'))) {
    throw new CliValidationError(
      `Missing ${path.join(realDataDir, 'people.yaml')} (pass --repo <archive-root> if running outside the archive root).`
    );
  }
  if (!fs.existsSync(configPath)) {
    throw new CliValidationError(
      `Missing ${configPath} (pass --repo <archive-root> if running outside the archive root).`
    );
  }
  if (!fs.existsSync(patchPath)) {
    throw new CliValidationError(
      `Missing person patch file: ${patchPath} (pass --package <dir> if the package lives outside research/people/${personId}).`
    );
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

  // Upsert optional patch.people first so upward ancestor patches can also introduce patch.person_id.
  const peopleMerge = upsertPatchPeople(existingPeople, patch.people, siteConfig.privacy);
  const mergedPeople = peopleMerge.items;

  // Invariant 1: Target person must exist (in people.yaml or patch.people) and must not be living.
  const targetIdx = peopleMerge.idxById.get(personId);
  if (targetIdx === undefined) {
    throw new Error(
      `Target person '${personId}' does not exist in ${path.join(dataDir, 'people.yaml')} or patch.people.`
    );
  }
  const targetPerson = mergedPeople[targetIdx];
  if (targetPerson.is_living) {
    throw new Error(
      `PRIVACY REFUSAL: Target person '${personId}' resolves as living. Living people cannot be researched or patched.`
    );
  }
  const updatedDeathEdtf = resolveValidDeathEdtfUpdate(patch.person_updates);
  const candidateTargetPerson =
    updatedDeathEdtf !== null ? { ...targetPerson, death_edtf: updatedDeathEdtf } : targetPerson;
  if (resolveEffectiveLiving(candidateTargetPerson, siteConfig.privacy)) {
    throw new Error(
      `PRIVACY REFUSAL: Target person '${personId}' resolves as living. Living people cannot be researched or patched.`
    );
  }

  // Merge person_updates.
  const personMerge = mergePersonUpdates(targetPerson, patch.person_updates, siteConfig.privacy);
  if (personMerge.updated.slug !== targetPerson.slug) {
    if (!SAFE_SLUG_RE.test(personMerge.updated.slug)) {
      throw new CliValidationError(
        `person_updates ('${personId}') has invalid slug '${personMerge.updated.slug}'.`
      );
    }
    const slugOwner = peopleMerge.slugToId.get(personMerge.updated.slug);
    if (slugOwner !== undefined && slugOwner !== personId) {
      throw new CliValidationError(
        `Slug collision: person_updates ('${personId}') reuses slug '${personMerge.updated.slug}' already owned by '${slugOwner}'.`
      );
    }
    if (peopleMerge.slugToId.get(targetPerson.slug) === personId) {
      peopleMerge.slugToId.delete(targetPerson.slug);
    }
    peopleMerge.slugToId.set(personMerge.updated.slug, personId);
  }
  mergedPeople[targetIdx] = personMerge.updated;

  const peopleById = new Map(mergedPeople.map((p) => [p.id, p]));
  const livingIds = new Set(
    mergedPeople
      .filter((p) => p.is_living || resolveEffectiveLiving(p, siteConfig.privacy))
      .map((p) => p.id)
  );

  // Invariant 2: Every place in patch.places and merged places must have valid non-(0, 0) coordinates.
  const placeIdsWithExplicitPronunciation = new Set<string>();
  const validatedPatchPlaces = patch.places.map((pl, idx) => {
    const normalized = assertValidPlaceCoordinates(pl, `patch.places[${idx}]`);
    const parsed = PlaceSchema.parse(normalized);
    if (Object.hasOwn(normalized, 'pronunciation')) {
      placeIdsWithExplicitPronunciation.add(parsed.id);
    }
    return parsed;
  });
  const placesMerge = upsertById(
    existingPlaces,
    validatedPatchPlaces,
    (p) => PlaceSchema.parse(p),
    (prev, incoming) => {
      const merged: Record<string, unknown> = { ...incoming };
      if (
        !placeIdsWithExplicitPronunciation.has(incoming.id) &&
        incoming.pronunciation === undefined &&
        prev.pronunciation !== undefined
      ) {
        merged.pronunciation = structuredClone(prev.pronunciation);
      }
      const hasPrimary = mergedPrimarySourceFlag(
        prev.has_primary_source,
        incoming.has_primary_source
      );
      if (hasPrimary !== undefined) {
        merged.has_primary_source = hasPrimary;
      }
      if (incoming.sources === undefined && prev.sources !== undefined) {
        merged.sources = structuredClone(prev.sources);
      }
      const mergedExt = mergeRecordExtensions(prev.extensions, incoming.extensions);
      if (mergedExt !== undefined) {
        merged.extensions = mergedExt;
      }
      return merged;
    }
  );
  for (const pl of placesMerge.items) {
    assertValidPlaceCoordinates(pl, `merged place '${pl.id}'`);
  }

  // Sources upsert + optional top-level source retirement (preserving live-only optional fields).
  const sourcesMerge = upsertById(
    existingSources,
    patch.sources,
    (s) => SourceRecordSchema.parse(s),
    (prev, incoming) => {
      const merged: Record<string, unknown> = { ...incoming };
      const hasPrimary = mergedPrimarySourceFlag(
        prev.has_primary_source,
        incoming.has_primary_source
      );
      if (hasPrimary !== undefined) {
        merged.has_primary_source = hasPrimary;
      }
      if (incoming.author === undefined && prev.author !== undefined) {
        merged.author = prev.author;
      }
      if (incoming.publisher === undefined && prev.publisher !== undefined) {
        merged.publisher = prev.publisher;
      }
      if (incoming.repository === undefined && prev.repository !== undefined) {
        merged.repository = prev.repository;
      }
      if (incoming.url === undefined && prev.url !== undefined) {
        merged.url = prev.url;
      }
      if (incoming.gedcom_xref === undefined && prev.gedcom_xref !== undefined) {
        merged.gedcom_xref = prev.gedcom_xref;
      }
      return merged;
    }
  );
  const topLevelRemoveSourceIds = new Set(patch.remove_source_ids);
  if (topLevelRemoveSourceIds.size > 0) {
    const patchedSourceIds = new Set(
      patch.sources.map((s) => SourceRecordSchema.parse(s).id)
    );
    for (const removeId of topLevelRemoveSourceIds) {
      if (patchedSourceIds.has(removeId)) {
        throw new Error(
          `patch.json cannot both add/update and remove source '${removeId}' in the same patch.`
        );
      }
    }
  }
  const removedSourceIds: string[] = [];
  const finalSources = sourcesMerge.items.filter((src) => {
    if (topLevelRemoveSourceIds.has(src.id)) {
      removedSourceIds.push(src.id);
      return false;
    }
    return true;
  });

  // Extract optional per-event remove_source_ids before schema parsing.
  const eventRemoveSourceIds = new Map<string, Set<string>>();
  const cleanedPatchEvents = patch.events.map((rawEv, idx) => {
    if (!isPlainObject(rawEv)) {
      return rawEv;
    }
    const removeIds = parseOptionalStringList(
      rawEv.remove_source_ids,
      `patch.events[${idx}].remove_source_ids`
    );
    const copy: Record<string, unknown> = { ...rawEv };
    delete copy.remove_source_ids;
    const parsedEv = RawEventSchema.parse(copy);
    if (removeIds.length > 0) {
      const removeSet = new Set(removeIds);
      for (const ref of parsedEv.sources) {
        if (removeSet.has(ref.source_id)) {
          throw new Error(
            `Event '${parsedEv.id}' cannot both attach and remove source '${ref.source_id}'.`
          );
        }
      }
      const existingSet = eventRemoveSourceIds.get(parsedEv.id);
      if (existingSet) {
        for (const id of removeSet) {
          existingSet.add(id);
        }
      } else {
        eventRemoveSourceIds.set(parsedEv.id, removeSet);
      }
    }
    return parsedEv;
  });

  // Events upsert preserving existing participants and sources on partial updates,
  // while pruning any source IDs explicitly listed in remove_source_ids.
  const eventsMerge = upsertById(
    existingEvents,
    cleanedPatchEvents,
    (ev) => RawEventSchema.parse(ev),
    (prev, incoming) => mergeSharedEvent(prev, incoming, eventRemoveSourceIds.get(incoming.id))
  );
  const topLevelRemoveEventIds = new Set(patch.remove_event_ids);
  if (topLevelRemoveEventIds.size > 0) {
    const patchedEventIds = new Set(cleanedPatchEvents.map((ev) => RawEventSchema.parse(ev).id));
    for (const removeId of topLevelRemoveEventIds) {
      if (patchedEventIds.has(removeId)) {
        throw new Error(
          `patch.json cannot both add/update and remove event '${removeId}' in the same patch.`
        );
      }
    }
  }
  const removedEventIds: string[] = [];
  const finalEvents = eventsMerge.items.filter((ev) => {
    if (topLevelRemoveEventIds.has(ev.id)) {
      removedEventIds.push(ev.id);
      return false;
    }
    return true;
  });

  // Media upsert + optional top-level media retirement (preserving live-only optional fields).
  const mediaMerge = upsertById(
    existingMedia,
    patch.media,
    (m) => MediaItemSchema.parse(m),
    (prev, incoming) => {
      const merged: Record<string, unknown> = { ...incoming };
      const hasPrimary = mergedPrimarySourceFlag(
        prev.has_primary_source,
        incoming.has_primary_source
      );
      if (hasPrimary !== undefined) {
        merged.has_primary_source = hasPrimary;
      }
      const optionalKeys = [
        'thumb_file',
        'provenance',
        'date_edtf',
        'page',
        'mime_type',
        'duration_seconds',
        'poster_url',
        'transcript_url',
      ] as const;
      for (const key of optionalKeys) {
        if (incoming[key] === undefined && prev[key] !== undefined) {
          merged[key] = prev[key];
        }
      }
      const mergedExt = mergeRecordExtensions(prev.extensions, incoming.extensions);
      if (mergedExt !== undefined) {
        merged.extensions = mergedExt;
      }
      return merged;
    }
  );
  const topLevelRemoveMediaIds = new Set(patch.remove_media_ids);
  if (topLevelRemoveMediaIds.size > 0) {
    const patchedMediaIds = new Set(patch.media.map((m) => MediaItemSchema.parse(m).id));
    for (const removeId of topLevelRemoveMediaIds) {
      if (patchedMediaIds.has(removeId)) {
        throw new Error(
          `patch.json cannot both add/update and remove media '${removeId}' in the same patch.`
        );
      }
    }
  }
  const removedMediaIds: string[] = [];
  const finalMedia = mediaMerge.items.filter((item) => {
    if (topLevelRemoveMediaIds.has(item.id)) {
      removedMediaIds.push(item.id);
      return false;
    }
    return true;
  });

  // Apply remove_kinship before upserting patch.kinship so parent/spouse/xref replacements work in one patch.
  const parsedPatchKinship = patch.kinship.map((rawEdge) => KinshipEdgeSchema.parse(rawEdge));
  const kinshipRemovals = applyKinshipRemovals(
    existingKinship,
    patch.remove_kinship,
    parsedPatchKinship
  );
  const removedKinship = kinshipRemovals.removed;

  // Kinship upsert keyed by from|to|relation.
  const kinshipMerge = upsertKinship(kinshipRemovals.remaining, parsedPatchKinship);
  verifyKinshipSymmetryForRemovedPairs(kinshipMerge.items, patch.remove_kinship);

  // Lookup sets before narrative normalization so inline citations are validated and auto-linked.
  const placeIds = new Set(placesMerge.items.map((p) => p.id));
  const sourceIds = new Set(finalSources.map((s) => s.id));
  const mediaIds = new Set(finalMedia.map((m) => m.id));
  const eventsById = new Map(finalEvents.map((e) => [e.id, e]));

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

  const narrativesMerge = upsertById(
    existingNarratives,
    normalizedPatchNarratives,
    (n) => NarrativeSchema.parse(n),
    (prev, incoming) => {
      const merged: Record<string, unknown> = { ...incoming };
      const hasPrimary = mergedPrimarySourceFlag(
        prev.has_primary_source,
        incoming.has_primary_source
      );
      if (hasPrimary !== undefined) {
        merged.has_primary_source = hasPrimary;
      }
      if (incoming.updated_at === undefined && prev.updated_at !== undefined) {
        merged.updated_at = prev.updated_at;
      }
      if (incoming.summary === undefined && prev.summary !== undefined) {
        merged.summary = prev.summary;
      }
      const mergedExt = mergeRecordExtensions(prev.extensions, incoming.extensions);
      if (mergedExt !== undefined) {
        merged.extensions = mergedExt;
      }
      return merged;
    }
  );

  // Referential integrity & privacy checks on patch additions/updates.
  for (const rawEv of cleanedPatchEvents) {
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

  // Ensure top-level event removal never leaves dangling references in surviving media or narratives.
  if (topLevelRemoveEventIds.size > 0) {
    for (const item of finalMedia) {
      if (item.event_id && topLevelRemoveEventIds.has(item.event_id)) {
        throw new Error(
          `Cannot remove event '${item.event_id}': media '${item.id}' still references it.`
        );
      }
    }
    for (const nar of narrativesMerge.items) {
      for (const evId of nar.event_ids) {
        if (topLevelRemoveEventIds.has(evId)) {
          throw new Error(
            `Cannot remove event '${evId}': narrative '${nar.id}' still references it in event_ids.`
          );
        }
      }
    }
  }

  // Ensure top-level media removal never breaks surviving narrative inline citations.
  if (topLevelRemoveMediaIds.size > 0) {
    for (const nar of narrativesMerge.items) {
      const extracted = extractNarrativeCitations(nar.body_md);
      for (const occ of extracted.occurrences) {
        if (occ.mediaId && topLevelRemoveMediaIds.has(occ.mediaId)) {
          throw new Error(
            `Cannot remove media '${occ.mediaId}': narrative '${nar.id}' still cites it inline.`
          );
        }
      }
    }
  }

  // Ensure top-level source removal never breaks citations or references anywhere in the archive.
  if (topLevelRemoveSourceIds.size > 0) {
    for (const ev of finalEvents) {
      for (const ref of ev.sources) {
        if (topLevelRemoveSourceIds.has(ref.source_id)) {
          throw new Error(
            `Cannot remove source '${ref.source_id}': event '${ev.id}' still cites it.`
          );
        }
      }
    }
    for (const item of finalMedia) {
      if (item.source_id && topLevelRemoveSourceIds.has(item.source_id)) {
        throw new Error(
          `Cannot remove source '${item.source_id}': media '${item.id}' still references it.`
        );
      }
    }
    for (const nar of narrativesMerge.items) {
      for (const srcId of nar.source_ids) {
        if (topLevelRemoveSourceIds.has(srcId)) {
          throw new Error(
            `Cannot remove source '${srcId}': narrative '${nar.id}' still lists it in source_ids.`
          );
        }
      }
    }
    const allCitationErrors = validateNarrativeCitations(
      narrativesMerge.items,
      sourceIds,
      mediaIds
    );
    if (allCitationErrors.length > 0) {
      throw new Error(allCitationErrors[0]);
    }
    for (const person of mergedPeople) {
      const extSources = isPlainObject(person.extensions) && Array.isArray(person.extensions.sources)
        ? person.extensions.sources
        : [];
      for (const entry of extSources) {
        const refId =
          typeof entry === 'string'
            ? entry.trim()
            : isPlainObject(entry) && typeof entry.source_id === 'string'
              ? entry.source_id
              : null;
        if (refId && topLevelRemoveSourceIds.has(refId)) {
          throw new Error(
            `Cannot remove source '${refId}': person '${person.id}' still cites it in extensions.sources.`
          );
        }
      }
    }
  }

  // Scan staging plan & verify every patch.media[].file exists on disk or in packageDir/scans/.
  const mediaLayout = detectMediaLayout(repoDir);
  const plannedScans = planScanStaging(
    repoDir,
    packageDir,
    mediaLayout,
    overlay?.virtualStagedScans
  );
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
    if (
      !fs.existsSync(expectedDiskPath) &&
      !stagedDestSet.has(expectedDiskPath) &&
      !overlay?.virtualStagedScans.has(expectedDiskPath)
    ) {
      throw new Error(
        `Missing scan file for media '${item.id}': '${item.file}' expected at '${expectedDiskPath}' (not on disk and not staged from ${path.join(packageDir, 'scans')}).`
      );
    }
  }

  // Compile merged archive in both private and public modes before writing anything.
  const compileBase = {
    people: mergedPeople,
    events: finalEvents,
    places: placesMerge.items,
    sources: finalSources,
    kinship: kinshipMerge.items,
    media: finalMedia,
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
      if (overlay && !scan.alreadyIdentical) {
        overlay.virtualStagedScans.set(scan.destPath, scan.sha256);
      }
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
  if (personMerge.changed || peopleMerge.counts.added > 0 || peopleMerge.counts.updated > 0) {
    pendingWrites.push({
      file: 'people.yaml',
      content: serializePeopleYaml(mergedPeople, { sortById: true }),
    });
  }
  if (eventsMerge.counts.added > 0 || eventsMerge.counts.updated > 0 || removedEventIds.length > 0) {
    pendingWrites.push({
      file: 'events.yaml',
      content: serializeEventsYaml(finalEvents, { sortById: true }),
    });
  }
  if (placesMerge.counts.added > 0 || placesMerge.counts.updated > 0) {
    pendingWrites.push({
      file: 'places.yaml',
      content: serializePlacesYaml(placesMerge.items, { sortById: true }),
    });
  }
  if (sourcesMerge.counts.added > 0 || sourcesMerge.counts.updated > 0 || removedSourceIds.length > 0) {
    pendingWrites.push({
      file: 'sources.yaml',
      content: serializeSourcesYaml(finalSources, { sortById: true }),
    });
  }
  if (
    kinshipMerge.counts.added > 0 ||
    kinshipMerge.counts.updated > 0 ||
    removedKinship.length > 0
  ) {
    pendingWrites.push({
      file: 'kinship.yaml',
      content: serializeKinshipYaml(kinshipMerge.items, { sortDeterministic: true }),
    });
  }
  if (mediaMerge.counts.added > 0 || mediaMerge.counts.updated > 0 || removedMediaIds.length > 0) {
    pendingWrites.push({
      file: 'media.yaml',
      content: serializeMediaYaml(finalMedia, { sortById: true }),
    });
  }
  if (narrativesMerge.counts.added > 0 || narrativesMerge.counts.updated > 0) {
    pendingWrites.push({
      file: 'narratives.yaml',
      content: serializeNarrativesYaml(narrativesMerge.items, { sortById: true }),
    });
  }

  const writtenYamlFiles: string[] = [];
  if (overlay) {
    for (const item of pendingWrites) {
      writeFileAtomic(path.join(dataDir, item.file), item.content);
    }
  } else if (!dryRun) {
    for (const item of pendingWrites) {
      const fullPath = path.join(dataDir, item.file);
      writeFileAtomic(fullPath, item.content);
      writtenYamlFiles.push(fullPath);
    }
    const receipt = buildIntegrationReceiptForPackage(packageDir, personId);
    writeIntegrationReceipt(packageDir, receipt);
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
      people: peopleMerge.counts,
      events: eventsMerge.counts,
      places: placesMerge.counts,
      sources: sourcesMerge.counts,
      media: mediaMerge.counts,
      kinship: kinshipMerge.counts,
      narratives: narrativesMerge.counts,
    },
    removedSourceIds,
    removedEventIds,
    removedMediaIds,
    removedKinshipCount: removedKinship.length,
    removedKinship,
    removedEvents: removedEventIds.length,
    removedMedia: removedMediaIds.length,
    inlineCitationCount,
    stagedScans: stagedScansReport,
    wouldWriteYamlFiles: pendingWrites.map((w) => path.join(realDataDir, w.file)),
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
      `people=+${peopleMerge.counts.added}/~${peopleMerge.counts.updated}, ` +
      `events=+${eventsMerge.counts.added}/~${eventsMerge.counts.updated}${removedEventIds.length > 0 ? `/-${removedEventIds.length}` : ''}, ` +
      `places=+${placesMerge.counts.added}/~${placesMerge.counts.updated}, ` +
      `sources=+${sourcesMerge.counts.added}/~${sourcesMerge.counts.updated}${removedSourceIds.length > 0 ? `/-${removedSourceIds.length}` : ''}, ` +
      `media=+${mediaMerge.counts.added}/~${mediaMerge.counts.updated}${removedMediaIds.length > 0 ? `/-${removedMediaIds.length}` : ''}, ` +
      `${kinshipMerge.counts.added > 0 || kinshipMerge.counts.updated > 0 || removedKinship.length > 0 ? `kinship=+${kinshipMerge.counts.added}/~${kinshipMerge.counts.updated}${removedKinship.length > 0 ? `/-${removedKinship.length}` : ''}, ` : ''}` +
      `narratives=+${narrativesMerge.counts.added}/~${narrativesMerge.counts.updated}, ` +
      `inlineCitations=${inlineCitationCount}, scans=${stagedScansReport.length}, ` +
      `written=${writtenYamlFiles.length}`;

  return {
    ...summaryBase,
    rendered,
  };
}
