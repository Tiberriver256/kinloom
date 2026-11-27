import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  compileArchive,
  getMediaPersonIds,
  type MediaItem,
  MediaItemSchema,
  type Narrative,
  NarrativeSchema,
  type Place,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativeEnrichmentsYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  type RawEvent,
  type RawPerson,
  type SourceRecord,
  serializeEventsYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
  validateNarrativeCitations,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';
import { listStagedAuditPersonIds } from './audit-overlaps.js';
import { auditBundlePrivacy } from './integrate.js';
import { normalizeMediaFilePath } from './live-media-collisions.js';
import { findDuplicateNormalizedMediaFiles } from './verify.js';

export { MEDIA_HELP } from './help.js';

const SCAN_MARKDOWN_CITATIONS_RE =
  /```[\s\S]*?```|`[^`\n]+`|\[\^([A-Za-z0-9._:-]+)(?:\|([A-Za-z0-9._:-]+))?\]/g;

export interface MediaDedupeCommandOptions {
  repoDir?: string;
  apply?: boolean;
  preferIds?: readonly string[];
  json?: boolean;
  /** Optional write hook for rollback testing; defaults to atomic temp-file rename. */
  writeFileImpl?: (filePath: string, content: string) => void;
}

export interface MediaDedupeCitationRewrite {
  narrativeId: string;
  sourceId: string;
  fromMediaId: string;
  toMediaId: string;
}

export interface MediaDedupeExtensionRewrite {
  file: string;
  entityId: string;
  fieldPath: string;
  fromMediaId: string;
  toMediaId: string;
}

export interface MediaDedupeGroupPlan {
  normalizedFile: string;
  canonicalId: string;
  retiredIds: string[];
  mergedPersonIds: string[];
  warnings: string[];
  mergedRecord: MediaItem;
}

export interface MediaDedupeStagedWarning {
  personId: string;
  retiredMediaIds: string[];
  canonicalByRetired: Record<string, string>;
}

export interface MediaDedupeCommandResult {
  ok: true;
  apply: boolean;
  dryRun: boolean;
  repo: string;
  duplicateGroupCount: number;
  retiredCount: number;
  groups: MediaDedupeGroupPlan[];
  citationRewrites: MediaDedupeCitationRewrite[];
  extensionRewrites: MediaDedupeExtensionRewrite[];
  warnings: string[];
  stagedPackageWarnings: MediaDedupeStagedWarning[];
  wouldWriteYamlFiles: string[];
  writtenYamlFiles: string[];
  rendered: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function writeFileAtomicUtf8(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(6).toString('hex');
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${suffix}`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function writeFileAtomicBuffer(filePath: string, content: Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(6).toString('hex');
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${suffix}`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

function countInlineMediaReferences(narratives: readonly Narrative[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const narrative of narratives) {
    const scanner = new RegExp(SCAN_MARKDOWN_CITATIONS_RE.source, 'g');
    let match: RegExpExecArray | null = scanner.exec(narrative.body_md);
    while (match !== null) {
      const mediaId = match[2];
      if (mediaId) {
        counts.set(mediaId, (counts.get(mediaId) ?? 0) + 1);
      }
      match = scanner.exec(narrative.body_md);
    }
  }
  return counts;
}

function collectExtensionMediaCounts(value: unknown, counts: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectExtensionMediaCounts(item, counts);
    }
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    if ((key === 'media_ids' || key === 'media_refs') && Array.isArray(val)) {
      for (const entry of val) {
        if (typeof entry === 'string' && entry.trim().length > 0) {
          counts.set(entry, (counts.get(entry) ?? 0) + 1);
        }
      }
    } else if (typeof val === 'object' && val !== null) {
      collectExtensionMediaCounts(val, counts);
    }
  }
}

function computeMetadataCompletenessScore(item: MediaItem): number {
  let score = 0;
  if (item.source_id && item.source_id.trim().length > 0) {
    score += 1;
  }
  if (item.event_id && item.event_id.trim().length > 0) {
    score += 1;
  }
  if (item.provenance && item.provenance.trim().length > 0) {
    score += 1;
  }
  if (item.date_edtf && item.date_edtf.trim().length > 0) {
    score += 1;
  }
  score += getMediaPersonIds(item).length;
  return score;
}

function compareMediaCandidates(
  a: MediaItem,
  b: MediaItem,
  refCounts: ReadonlyMap<string, number>,
  preferSet: ReadonlySet<string>
): number {
  const prefA = preferSet.has(a.id) ? 1 : 0;
  const prefB = preferSet.has(b.id) ? 1 : 0;
  if (prefA !== prefB) {
    return prefB - prefA;
  }
  const refA = refCounts.get(a.id) ?? 0;
  const refB = refCounts.get(b.id) ?? 0;
  if (refA !== refB) {
    return refB - refA;
  }
  const scoreA = computeMetadataCompletenessScore(a);
  const scoreB = computeMetadataCompletenessScore(b);
  if (scoreA !== scoreB) {
    return scoreB - scoreA;
  }
  const capA = a.caption.trim().length;
  const capB = b.caption.trim().length;
  if (capA !== capB) {
    return capB - capA;
  }
  return a.id.localeCompare(b.id);
}

function uniqueNonEmptyStrings(values: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
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

export function mergeDuplicateMediaGroup(
  items: readonly MediaItem[],
  refCounts: ReadonlyMap<string, number>,
  preferSet: ReadonlySet<string>,
  normalizedFile: string
): MediaDedupeGroupPlan {
  const preferredInGroup = items.filter((item) => preferSet.has(item.id));
  if (preferredInGroup.length > 1) {
    throw new CliValidationError(
      `Conflicting \`--prefer\` flags for duplicate media file '${normalizedFile}': ${preferredInGroup.map((i) => i.id).join(', ')}. Specify at most one preferred media_id per duplicate file group.`
    );
  }

  const ordered = [...items].toSorted((a, b) => compareMediaCandidates(a, b, refCounts, preferSet));
  const canonical = structuredClone(ordered[0]);
  const retired = ordered.slice(1);
  const retiredIds = retired.map((item) => item.id).toSorted((a, b) => a.localeCompare(b));
  const warnings: string[] = [];

  // 1. Merge person_id / person_ids losslessly.
  const mergedPersonIds = uniqueNonEmptyStrings(ordered.flatMap((item) => getMediaPersonIds(item)));
  if (mergedPersonIds.length > 0) {
    if (!canonical.person_id) {
      const firstPrimary = ordered.find((item) => Boolean(item.person_id))?.person_id;
      if (firstPrimary) {
        canonical.person_id = firstPrimary;
      }
    }
    if (mergedPersonIds.length > 1 || canonical.person_ids !== undefined) {
      canonical.person_ids = mergedPersonIds;
    }
  }

  // 2. Merge extensions base (retired first in reverse priority so canonical always wins).
  const mergedExtensions: Record<string, unknown> = {};
  for (const item of [...ordered].reverse()) {
    if (item.extensions) {
      for (const [k, v] of Object.entries(item.extensions)) {
        mergedExtensions[k] = structuredClone(v);
      }
    }
  }

  // 3. Caption: keep canonical (or longest non-empty), preserve distinct non-substring alternates.
  let chosenCaption = canonical.caption.trim();
  if (!chosenCaption) {
    const longest = ordered
      .map((item) => item.caption.trim())
      .filter((c) => c.length > 0)
      .toSorted((a, b) => b.length - a.length)[0];
    if (longest) {
      chosenCaption = longest;
      canonical.caption = longest;
    }
  }
  const existingAltCaptions = Array.isArray(mergedExtensions.alternate_captions)
    ? mergedExtensions.alternate_captions.filter((c): c is string => typeof c === 'string')
    : [];
  const altCaptions = uniqueNonEmptyStrings([
    ...existingAltCaptions,
    ...retired
      .map((item) => item.caption.trim())
      .filter((cap) => cap.length > 0 && !chosenCaption.toLowerCase().includes(cap.toLowerCase())),
  ]);
  if (altCaptions.length > 0) {
    mergedExtensions.alternate_captions = altCaptions;
  }

  // 4. Provenance: fill if empty; preserve distinct alternate provenance notes.
  let chosenProvenance = canonical.provenance?.trim() ?? '';
  if (!chosenProvenance) {
    const firstProv = retired.map((item) => item.provenance?.trim() ?? '').find((p) => p.length > 0);
    if (firstProv) {
      chosenProvenance = firstProv;
      canonical.provenance = firstProv;
    }
  }
  const existingAltProv = Array.isArray(mergedExtensions.alternate_provenance)
    ? mergedExtensions.alternate_provenance.filter((p): p is string => typeof p === 'string')
    : [];
  const altProvenance = uniqueNonEmptyStrings([
    ...existingAltProv,
    ...retired
      .map((item) => item.provenance?.trim() ?? '')
      .filter((prov) => prov.length > 0 && prov.toLowerCase() !== chosenProvenance.toLowerCase()),
  ]);
  if (altProvenance.length > 0) {
    mergedExtensions.alternate_provenance = altProvenance;
  }

  // 5. source_id / event_id: fill missing, warn and record conflicts in extensions.
  if (!canonical.source_id) {
    const fallbackSource = retired.find((item) => Boolean(item.source_id?.trim()))?.source_id;
    if (fallbackSource) {
      canonical.source_id = fallbackSource;
    }
  }
  const distinctSources = uniqueNonEmptyStrings(ordered.map((item) => item.source_id));
  const additionalSources = distinctSources.filter((sid) => sid !== canonical.source_id);
  if (additionalSources.length > 0) {
    const prevAdditional = Array.isArray(mergedExtensions.additional_source_ids)
      ? mergedExtensions.additional_source_ids.filter((s): s is string => typeof s === 'string')
      : [];
    mergedExtensions.additional_source_ids = uniqueNonEmptyStrings([...prevAdditional, ...additionalSources]);
    warnings.push(
      `Conflicting source_id on '${normalizedFile}': kept canonical '${canonical.source_id}' on ${canonical.id}; recorded additional [${additionalSources.join(', ')}] in extensions.additional_source_ids.`
    );
  }

  if (!canonical.event_id) {
    const fallbackEvent = retired.find((item) => Boolean(item.event_id?.trim()))?.event_id;
    if (fallbackEvent) {
      canonical.event_id = fallbackEvent;
    }
  }
  const distinctEvents = uniqueNonEmptyStrings(ordered.map((item) => item.event_id));
  const additionalEvents = distinctEvents.filter((eid) => eid !== canonical.event_id);
  if (additionalEvents.length > 0) {
    const prevAdditional = Array.isArray(mergedExtensions.additional_event_ids)
      ? mergedExtensions.additional_event_ids.filter((s): s is string => typeof s === 'string')
      : [];
    mergedExtensions.additional_event_ids = uniqueNonEmptyStrings([...prevAdditional, ...additionalEvents]);
    warnings.push(
      `Conflicting event_id on '${normalizedFile}': kept canonical '${canonical.event_id}' on ${canonical.id}; recorded additional [${additionalEvents.join(', ')}] in extensions.additional_event_ids.`
    );
  }

  // 6. Fill optional scalar metadata in deterministic survivor-score order.
  const fillableKeys = [
    'date_edtf',
    'page',
    'thumb_file',
    'mime_type',
    'duration_seconds',
    'poster_url',
    'transcript_url',
  ] as const;
  for (const key of fillableKeys) {
    const currentVal = canonical[key];
    const isEmpty =
      currentVal === undefined ||
      currentVal === null ||
      (typeof currentVal === 'string' && currentVal.trim().length === 0);
    if (!isEmpty) {
      continue;
    }
    for (const item of retired) {
      const candidateVal = item[key];
      const hasVal =
        candidateVal !== undefined &&
        candidateVal !== null &&
        (typeof candidateVal !== 'string' || candidateVal.trim().length > 0);
      if (hasVal) {
        (canonical as Record<string, unknown>)[key] = candidateVal;
        break;
      }
    }
  }

  // 7. has_primary_source: true if any record in the group has true.
  if (ordered.some((item) => item.has_primary_source === true)) {
    canonical.has_primary_source = true;
  }

  // 8. Record auditability trail in extensions.merged_from_media_ids.
  const prevMergedFrom = Array.isArray(mergedExtensions.merged_from_media_ids)
    ? mergedExtensions.merged_from_media_ids.filter((id): id is string => typeof id === 'string')
    : [];
  mergedExtensions.merged_from_media_ids = uniqueNonEmptyStrings([...prevMergedFrom, ...retiredIds]).toSorted(
    (a, b) => a.localeCompare(b)
  );
  canonical.extensions = mergedExtensions;

  const validated = MediaItemSchema.parse(canonical);

  return {
    normalizedFile,
    canonicalId: validated.id,
    retiredIds,
    mergedPersonIds,
    warnings,
    mergedRecord: validated,
  };
}

export function rewriteNarrativeMediaCitations(
  markdown: string,
  retiredToCanonical: ReadonlyMap<string, string>,
  narrativeId: string
): { bodyMd: string; rewrites: MediaDedupeCitationRewrite[] } {
  const rewrites: MediaDedupeCitationRewrite[] = [];
  const scanner = new RegExp(SCAN_MARKDOWN_CITATIONS_RE.source, 'g');
  const bodyMd = markdown.replace(scanner, (fullMatch, sourceId?: string, mediaId?: string) => {
    if (!sourceId || !mediaId) {
      return fullMatch;
    }
    const replacement = retiredToCanonical.get(mediaId);
    if (!replacement || replacement === mediaId) {
      return fullMatch;
    }
    rewrites.push({
      narrativeId,
      sourceId,
      fromMediaId: mediaId,
      toMediaId: replacement,
    });
    return `[^${sourceId}|${replacement}]`;
  });
  return { bodyMd, rewrites };
}

function rewriteMediaRefsInExtensionsObject(
  obj: unknown,
  retiredToCanonical: ReadonlyMap<string, string>,
  file: string,
  entityId: string,
  prefix: string,
  rewrites: MediaDedupeExtensionRewrite[]
): boolean {
  if (Array.isArray(obj)) {
    let changed = false;
    for (let i = 0; i < obj.length; i += 1) {
      if (
        rewriteMediaRefsInExtensionsObject(
          obj[i],
          retiredToCanonical,
          file,
          entityId,
          `${prefix}[${i}]`,
          rewrites
        )
      ) {
        changed = true;
      }
    }
    return changed;
  }
  if (!isPlainRecord(obj)) {
    return false;
  }
  let changed = false;
  for (const [key, val] of Object.entries(obj)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if ((key === 'media_ids' || key === 'media_refs') && Array.isArray(val)) {
      const nextArr: unknown[] = [];
      const seenStrings = new Set<string>();
      let arrayChanged = false;
      for (const entry of val) {
        if (typeof entry === 'string') {
          const replacement = retiredToCanonical.get(entry);
          const effective = replacement ?? entry;
          if (replacement && replacement !== entry) {
            arrayChanged = true;
            rewrites.push({
              file,
              entityId,
              fieldPath,
              fromMediaId: entry,
              toMediaId: replacement,
            });
          }
          if (!seenStrings.has(effective)) {
            seenStrings.add(effective);
            nextArr.push(effective);
          } else {
            arrayChanged = true;
          }
        } else {
          nextArr.push(entry);
        }
      }
      if (arrayChanged) {
        obj[key] = nextArr;
        changed = true;
      }
    } else if (typeof val === 'object' && val !== null) {
      if (rewriteMediaRefsInExtensionsObject(val, retiredToCanonical, file, entityId, fieldPath, rewrites)) {
        changed = true;
      }
    }
  }
  return changed;
}

function scanStagedPackagesForRetiredMedia(
  repoDir: string,
  retiredToCanonical: ReadonlyMap<string, string>
): MediaDedupeStagedWarning[] {
  if (retiredToCanonical.size === 0) {
    return [];
  }
  const warnings: MediaDedupeStagedWarning[] = [];
  const personIds = listStagedAuditPersonIds(repoDir);
  for (const personId of personIds) {
    const patchPath = path.join(repoDir, 'research', 'people', personId, 'patch.json');
    if (!fs.existsSync(patchPath)) {
      continue;
    }
    try {
      const rawText = fs.readFileSync(patchPath, 'utf8');
      const matched: string[] = [];
      const canonicalByRetired: Record<string, string> = {};
      for (const [retiredId, canonicalId] of retiredToCanonical) {
        if (rawText.includes(retiredId)) {
          matched.push(retiredId);
          canonicalByRetired[retiredId] = canonicalId;
        }
      }
      if (matched.length > 0) {
        matched.sort((a, b) => a.localeCompare(b));
        warnings.push({ personId, retiredMediaIds: matched, canonicalByRetired });
      }
    } catch {
      // Ignore unreadable staged patch in advisory scan.
    }
  }
  return warnings;
}

export function formatMediaDedupeTextReport(report: Omit<MediaDedupeCommandResult, 'rendered'>): string {
  const lines: string[] = [];
  const modeLabel = report.apply ? 'apply' : 'dry-run';
  if (report.duplicateGroupCount === 0) {
    lines.push(`Media dedupe (${modeLabel}) OK: 0 duplicate file groups found.`);
    lines.push(`  Repo: ${report.repo}`);
    return lines.join('\n');
  }

  lines.push(
    `Media dedupe (${modeLabel}) OK: ${report.duplicateGroupCount} duplicate file group(s), ` +
      `${report.retiredCount} retired record(s), ` +
      `${report.citationRewrites.length} inline citation rewrite(s), ` +
      `${report.extensionRewrites.length} extension ref rewrite(s)`
  );
  lines.push(`  Repo: ${report.repo}`);
  for (const group of report.groups) {
    lines.push(
      `  File ${group.normalizedFile}: keep ${group.canonicalId}, retire [${group.retiredIds.join(', ')}]` +
        (group.mergedPersonIds.length > 0 ? ` (people: ${group.mergedPersonIds.join(', ')})` : '')
    );
  }
  if (report.warnings.length > 0) {
    lines.push('  Warnings:');
    for (const w of report.warnings) {
      lines.push(`    - ${w}`);
    }
  }
  if (report.stagedPackageWarnings.length > 0) {
    lines.push('  Staged package warnings (read-only, research/ not modified):');
    for (const sw of report.stagedPackageWarnings) {
      const pairs = sw.retiredMediaIds.map((id) => `${id} -> ${sw.canonicalByRetired[id]}`).join(', ');
      lines.push(`    - research/people/${sw.personId}/patch.json references retired media: ${pairs}`);
    }
  }
  if (!report.apply) {
    lines.push(
      `  Dry-run only: 0 files written (${report.wouldWriteYamlFiles.length} file(s) would be updated; pass '--apply' to write).`
    );
  } else {
    lines.push(
      `  Written YAML files (${report.writtenYamlFiles.length}): ${report.writtenYamlFiles.join(', ')}`
    );
  }
  return lines.join('\n');
}

function readOptionalYaml<T>(filePath: string, parser: (raw: string) => T[]): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return parser(fs.readFileSync(filePath, 'utf8'));
}

export async function runMediaDedupeCommand(
  options: MediaDedupeCommandOptions = {}
): Promise<MediaDedupeCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const apply = Boolean(options.apply);
  const preferSet = new Set((options.preferIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
  const writeFileFn = options.writeFileImpl ?? writeFileAtomicUtf8;

  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }
  const dataDir = path.join(repoDir, 'data');
  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  if (!fs.existsSync(dataDir) || !fs.existsSync(configPath)) {
    throw new CliValidationError(`Archive data/ or kinloom.config.yaml not found under ${repoDir}.`);
  }

  const config = parseKinloomConfigYaml(fs.readFileSync(configPath, 'utf8'));
  const peoplePath = path.join(dataDir, 'people.yaml');
  const placesPath = path.join(dataDir, 'places.yaml');
  const eventsPath = path.join(dataDir, 'events.yaml');
  const sourcesPath = path.join(dataDir, 'sources.yaml');
  const kinshipPath = path.join(dataDir, 'kinship.yaml');
  const mediaPath = path.join(dataDir, 'media.yaml');
  const narrativesPath = path.join(dataDir, 'narratives.yaml');
  const enrichmentsPath = path.join(dataDir, 'narrative_enrichments.yaml');

  const people: RawPerson[] = readOptionalYaml(peoplePath, parsePeopleYaml);
  const places: Place[] = readOptionalYaml(placesPath, parsePlacesYaml);
  const events: RawEvent[] = readOptionalYaml(eventsPath, parseEventsYaml);
  const sources: SourceRecord[] = readOptionalYaml(sourcesPath, parseSourcesYaml);
  const kinship = readOptionalYaml(kinshipPath, parseKinshipYaml);
  const media: MediaItem[] = readOptionalYaml(mediaPath, parseMediaYaml);
  const narratives: Narrative[] = readOptionalYaml(narrativesPath, parseNarrativesYaml);
  const enrichments = readOptionalYaml(enrichmentsPath, parseNarrativeEnrichmentsYaml);

  // Validate any --prefer ids exist in media.yaml.
  const mediaById = new Map(media.map((item) => [item.id, item]));
  for (const prefId of preferSet) {
    if (!mediaById.has(prefId)) {
      throw new CliValidationError(`Preferred media_id '${prefId}' does not exist in data/media.yaml.`);
    }
  }

  // Group media records by normalized file path.
  const groupedByFile = new Map<string, MediaItem[]>();
  for (const item of media) {
    const normalized = normalizeMediaFilePath(item.file);
    if (!normalized) {
      continue;
    }
    const bucket = groupedByFile.get(normalized) ?? [];
    bucket.push(item);
    groupedByFile.set(normalized, bucket);
  }

  const duplicateEntries = [...groupedByFile.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .toSorted(([a], [b]) => a.localeCompare(b));

  if (duplicateEntries.length === 0) {
    const emptyBase: Omit<MediaDedupeCommandResult, 'rendered'> = {
      ok: true,
      apply,
      dryRun: !apply,
      repo: repoDir,
      duplicateGroupCount: 0,
      retiredCount: 0,
      groups: [],
      citationRewrites: [],
      extensionRewrites: [],
      warnings: [],
      stagedPackageWarnings: [],
      wouldWriteYamlFiles: [],
      writtenYamlFiles: [],
    };
    return {
      ...emptyBase,
      rendered: options.json ? JSON.stringify(emptyBase, null, 2) : formatMediaDedupeTextReport(emptyBase),
    };
  }

  // Compute reference counts across narratives + extensions across all entity files.
  const refCounts = countInlineMediaReferences(narratives);
  for (const p of people) {
    if (p.extensions) {
      collectExtensionMediaCounts(p.extensions, refCounts);
    }
  }
  for (const pl of places) {
    if (pl.extensions) {
      collectExtensionMediaCounts(pl.extensions, refCounts);
    }
  }
  for (const ev of events) {
    if (ev.extensions) {
      collectExtensionMediaCounts(ev.extensions, refCounts);
    }
  }
  for (const nar of narratives) {
    if (nar.extensions) {
      collectExtensionMediaCounts(nar.extensions, refCounts);
    }
  }
  for (const enr of enrichments) {
    if ('extensions' in enr && enr.extensions) {
      collectExtensionMediaCounts(enr.extensions, refCounts);
    }
  }

  const groups: MediaDedupeGroupPlan[] = [];
  const retiredToCanonical = new Map<string, string>();
  const canonicalReplacementById = new Map<string, MediaItem>();
  const warnings: string[] = [];

  for (const [normalizedFile, bucket] of duplicateEntries) {
    const plan = mergeDuplicateMediaGroup(bucket, refCounts, preferSet, normalizedFile);
    groups.push(plan);
    canonicalReplacementById.set(plan.canonicalId, plan.mergedRecord);
    for (const retiredId of plan.retiredIds) {
      retiredToCanonical.set(retiredId, plan.canonicalId);
    }
    warnings.push(...plan.warnings);
  }

  // Build deduplicated media array preserving validated records.
  const mergedMedia: MediaItem[] = [];
  for (const item of media) {
    if (retiredToCanonical.has(item.id)) {
      continue;
    }
    const replacement = canonicalReplacementById.get(item.id);
    mergedMedia.push(MediaItemSchema.parse(replacement ?? item));
  }

  // Rewrite inline narrative citations and extension references in memory.
  const citationRewrites: MediaDedupeCitationRewrite[] = [];
  const extensionRewrites: MediaDedupeExtensionRewrite[] = [];

  const nextNarratives = narratives.map((nar) => {
    const cloned = structuredClone(nar);
    const { bodyMd, rewrites } = rewriteNarrativeMediaCitations(
      cloned.body_md,
      retiredToCanonical,
      cloned.id
    );
    if (rewrites.length > 0) {
      cloned.body_md = bodyMd;
      citationRewrites.push(...rewrites);
    }
    if (cloned.extensions) {
      rewriteMediaRefsInExtensionsObject(
        cloned.extensions,
        retiredToCanonical,
        'narratives.yaml',
        cloned.id,
        'extensions',
        extensionRewrites
      );
    }
    return NarrativeSchema.parse(cloned);
  });

  const nextPeople = people.map((p) => structuredClone(p));
  let peopleChanged = false;
  for (const p of nextPeople) {
    if (
      p.extensions &&
      rewriteMediaRefsInExtensionsObject(
        p.extensions,
        retiredToCanonical,
        'people.yaml',
        p.id,
        'extensions',
        extensionRewrites
      )
    ) {
      peopleChanged = true;
    }
  }

  const nextPlaces = places.map((pl) => structuredClone(pl));
  let placesChanged = false;
  for (const pl of nextPlaces) {
    if (
      pl.extensions &&
      rewriteMediaRefsInExtensionsObject(
        pl.extensions,
        retiredToCanonical,
        'places.yaml',
        pl.id,
        'extensions',
        extensionRewrites
      )
    ) {
      placesChanged = true;
    }
  }

  const nextEvents = events.map((ev) => structuredClone(ev));
  let eventsChanged = false;
  for (const ev of nextEvents) {
    if (
      ev.extensions &&
      rewriteMediaRefsInExtensionsObject(
        ev.extensions,
        retiredToCanonical,
        'events.yaml',
        ev.id,
        'extensions',
        extensionRewrites
      )
    ) {
      eventsChanged = true;
    }
  }

  const narrativesChanged =
    citationRewrites.length > 0 || extensionRewrites.some((rw) => rw.file === 'narratives.yaml');

  // Pre-write verification: zero duplicates, valid citations, clean dual-mode compilation & privacy.
  const remainingDuplicates = findDuplicateNormalizedMediaFiles(mergedMedia);
  if (remainingDuplicates.length > 0) {
    throw new Error(
      `Post-dedupe verification failed: ${remainingDuplicates.length} duplicate media file(s) remain.`
    );
  }
  const sourceIdSet = new Set(sources.map((s) => s.id));
  const mediaIdSet = new Set(mergedMedia.map((m) => m.id));
  const citationErrors = validateNarrativeCitations(nextNarratives, sourceIdSet, mediaIdSet);
  if (citationErrors.length > 0) {
    throw new Error(`Post-dedupe citation verification failed: ${citationErrors[0]}`);
  }

  const compileBase = {
    siteConfig: config,
    people: nextPeople,
    places: nextPlaces,
    events: nextEvents,
    sources,
    kinship,
    media: mergedMedia,
    narratives: nextNarratives,
    ...(enrichments.length > 0 ? { enrichments } : {}),
  };
  const privateResult = compileArchive({ ...compileBase, mode: 'private' });
  const publicResult = compileArchive({ ...compileBase, mode: 'public' });

  if (privateResult.reviewFlags.length > 0 || publicResult.reviewFlags.length > 0) {
    throw new Error(
      `Post-dedupe compile verification raised review flags (private=${privateResult.reviewFlags.length}, public=${publicResult.reviewFlags.length}).`
    );
  }
  const privacyLeaks = [
    ...auditBundlePrivacy(privateResult.bundle, 'private'),
    ...auditBundlePrivacy(publicResult.bundle, 'public'),
  ];
  if (privacyLeaks.length > 0) {
    throw new Error(`Post-dedupe privacy verification failed: ${privacyLeaks[0]}`);
  }

  // Read-only staged-package advisory check.
  const stagedPackageWarnings = scanStagedPackagesForRetiredMedia(repoDir, retiredToCanonical);

  // Build pending YAML writes.
  const pendingWrites: Array<{ fullPath: string; content: string }> = [
    { fullPath: mediaPath, content: serializeMediaYaml(mergedMedia, { sortById: true }) },
  ];
  if (narrativesChanged) {
    pendingWrites.push({
      fullPath: narrativesPath,
      content: serializeNarrativesYaml(nextNarratives, { sortById: true }),
    });
  }
  if (peopleChanged) {
    pendingWrites.push({
      fullPath: peoplePath,
      content: serializePeopleYaml(nextPeople, { sortById: true }),
    });
  }
  if (placesChanged) {
    pendingWrites.push({
      fullPath: placesPath,
      content: serializePlacesYaml(nextPlaces, { sortById: true }),
    });
  }
  if (eventsChanged) {
    pendingWrites.push({
      fullPath: eventsPath,
      content: serializeEventsYaml(nextEvents, { sortById: true }),
    });
  }

  // Also ensure sources.yaml stays available if future extension support is added; unused import guard.
  void serializeSourcesYaml;

  const wouldWriteYamlFiles = pendingWrites
    .map((item) => item.fullPath)
    .toSorted((a, b) => a.localeCompare(b));
  const writtenYamlFiles: string[] = [];

  if (apply) {
    const byteSnapshot = new Map<string, Buffer | null>();
    for (const item of pendingWrites) {
      byteSnapshot.set(item.fullPath, fs.existsSync(item.fullPath) ? fs.readFileSync(item.fullPath) : null);
    }

    try {
      for (const item of pendingWrites) {
        writeFileFn(item.fullPath, item.content);
        writtenYamlFiles.push(item.fullPath);
      }
    } catch (writeErr: unknown) {
      let rollbackNote = '';
      try {
        let restored = 0;
        for (const [filePath, origBytes] of byteSnapshot) {
          if (origBytes === null) {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
              restored += 1;
            }
          } else if (!fs.existsSync(filePath) || !fs.readFileSync(filePath).equals(origBytes)) {
            writeFileAtomicBuffer(filePath, origBytes);
            restored += 1;
          }
        }
        rollbackNote = ` Rollback succeeded: ${restored} YAML file(s) restored byte-for-byte.`;
      } catch (rbErr: unknown) {
        const rbDetail = rbErr instanceof Error ? rbErr.message : String(rbErr);
        rollbackNote = ` Rollback FAILED: ${rbDetail}.`;
      }
      const detail = writeErr instanceof Error ? writeErr.message : String(writeErr);
      throw new Error(`Media dedupe write failed: ${detail}.${rollbackNote}`, { cause: writeErr });
    }
  }

  writtenYamlFiles.sort((a, b) => a.localeCompare(b));

  const baseResult: Omit<MediaDedupeCommandResult, 'rendered'> = {
    ok: true,
    apply,
    dryRun: !apply,
    repo: repoDir,
    duplicateGroupCount: groups.length,
    retiredCount: retiredToCanonical.size,
    groups,
    citationRewrites,
    extensionRewrites,
    warnings,
    stagedPackageWarnings,
    wouldWriteYamlFiles,
    writtenYamlFiles,
  };

  return {
    ...baseResult,
    rendered: options.json ? JSON.stringify(baseResult, null, 2) : formatMediaDedupeTextReport(baseResult),
  };
}
