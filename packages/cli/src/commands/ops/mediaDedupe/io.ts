import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  compileArchive,
  type MediaItem,
  type Narrative,
  type Place,
  type RawEvent,
  type RawPerson,
  type SourceRecord,
  serializeEventsYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  validateNarrativeCitations,
} from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import { loadLocalArchiveRepoSync } from '../../dataFiles.js';
import { auditBundlePrivacy } from '../shared/bundlePrivacy.js';
import { findDuplicateNormalizedMediaFiles } from '../shared/mediaFiles.js';
import { listStagedAuditPersonIds } from '../shared/stagedPackages.js';
import type {
  LoadedDedupeArchive,
  LoadedDedupeArchivePaths,
  MediaDedupeStagedWarning,
  ParsedKinloomConfig,
  ParsedKinshipList,
  ParsedNarrativeEnrichmentsList,
  PendingYamlWrite,
} from './types.js';

export function writeFileAtomicUtf8(filePath: string, content: string): void {
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

export function loadArchiveForMediaDedupe(repoDir: string): LoadedDedupeArchive {
  const loaded = loadLocalArchiveRepoSync(repoDir, {
    requireConfig: true,
    includeEnrichments: true,
  });
  if (!loaded.siteConfig) {
    throw new CliValidationError(`Archive data/ or kinloom.config.yaml not found under ${repoDir}.`);
  }

  const paths: LoadedDedupeArchivePaths = {
    peoplePath: path.join(loaded.dataDir, 'people.yaml'),
    placesPath: path.join(loaded.dataDir, 'places.yaml'),
    eventsPath: path.join(loaded.dataDir, 'events.yaml'),
    sourcesPath: path.join(loaded.dataDir, 'sources.yaml'),
    kinshipPath: path.join(loaded.dataDir, 'kinship.yaml'),
    mediaPath: path.join(loaded.dataDir, 'media.yaml'),
    narrativesPath: path.join(loaded.dataDir, 'narratives.yaml'),
    enrichmentsPath: path.join(loaded.dataDir, 'narrative_enrichments.yaml'),
  };

  return {
    config: loaded.siteConfig,
    paths,
    people: loaded.people,
    places: loaded.places,
    events: loaded.events,
    sources: loaded.sources,
    kinship: loaded.kinship,
    media: loaded.media,
    narratives: loaded.narratives,
    enrichments: loaded.enrichments,
  };
}

export function verifyDeduplicatedArchive(input: {
  config: ParsedKinloomConfig;
  people: RawPerson[];
  places: Place[];
  events: RawEvent[];
  sources: SourceRecord[];
  kinship: ParsedKinshipList;
  media: MediaItem[];
  narratives: Narrative[];
  enrichments: ParsedNarrativeEnrichmentsList;
}): void {
  const remainingDuplicates = findDuplicateNormalizedMediaFiles(input.media);
  if (remainingDuplicates.length > 0) {
    throw new Error(
      `Post-dedupe verification failed: ${remainingDuplicates.length} duplicate media file(s) remain.`
    );
  }
  const sourceIdSet = new Set(input.sources.map((s) => s.id));
  const mediaIdSet = new Set(input.media.map((m) => m.id));
  const citationErrors = validateNarrativeCitations(input.narratives, sourceIdSet, mediaIdSet);
  if (citationErrors.length > 0) {
    throw new Error(`Post-dedupe citation verification failed: ${citationErrors[0]}`);
  }

  const compileBase = {
    siteConfig: input.config,
    people: input.people,
    places: input.places,
    events: input.events,
    sources: input.sources,
    kinship: input.kinship,
    media: input.media,
    narratives: input.narratives,
    ...(input.enrichments.length > 0 ? { enrichments: input.enrichments } : {}),
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
}

export function scanStagedPackagesForRetiredMedia(
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

export function buildPendingYamlWrites(input: {
  paths: LoadedDedupeArchivePaths;
  mergedMedia: MediaItem[];
  nextNarratives: Narrative[];
  nextPeople: RawPerson[];
  nextPlaces: Place[];
  nextEvents: RawEvent[];
  narrativesChanged: boolean;
  peopleChanged: boolean;
  placesChanged: boolean;
  eventsChanged: boolean;
}): PendingYamlWrite[] {
  const pendingWrites: PendingYamlWrite[] = [
    { fullPath: input.paths.mediaPath, content: serializeMediaYaml(input.mergedMedia, { sortById: true }) },
  ];
  if (input.narrativesChanged) {
    pendingWrites.push({
      fullPath: input.paths.narrativesPath,
      content: serializeNarrativesYaml(input.nextNarratives, { sortById: true }),
    });
  }
  if (input.peopleChanged) {
    pendingWrites.push({
      fullPath: input.paths.peoplePath,
      content: serializePeopleYaml(input.nextPeople, { sortById: true }),
    });
  }
  if (input.placesChanged) {
    pendingWrites.push({
      fullPath: input.paths.placesPath,
      content: serializePlacesYaml(input.nextPlaces, { sortById: true }),
    });
  }
  if (input.eventsChanged) {
    pendingWrites.push({
      fullPath: input.paths.eventsPath,
      content: serializeEventsYaml(input.nextEvents, { sortById: true }),
    });
  }
  return pendingWrites;
}

export function applyPendingYamlWritesWithRollback(
  pendingWrites: readonly PendingYamlWrite[],
  writeFileFn: (filePath: string, content: string) => void
): string[] {
  const writtenYamlFiles: string[] = [];
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

  return writtenYamlFiles.toSorted((a, b) => a.localeCompare(b));
}
