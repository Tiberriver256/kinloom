import fs from 'node:fs';
import path from 'node:path';
import {
  serializeEventsYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from '@kinloom/core';
import { CliValidationError } from '../../../../errors.js';
import { loadLocalArchiveRepoSync } from '../../../dataFiles.js';
import { compileAndAuditMergedArchive } from '../bundlePrivacy.js';
import {
  mergeEventsPatch,
  mergeMediaPatch,
  mergeNarrativesPatch,
  mergePlacesPatch,
  mergeSourcesPatch,
  normalizeAndValidatePatch,
} from './entities.js';
import { validatePatchReferentialIntegrity, validateRetirementIntegrity } from './integrity.js';
import { mergeKinshipPatch } from './kinship.js';
import { detectMediaLayout, planScanStaging, stagePlannedScans, validatePatchMedia } from './media.js';
import { applyPeoplePatch } from './people.js';
import { writeFileAtomic } from './primitives.js';
import { buildIntegrationReceiptForPackage, writeIntegrationReceipt } from './receipts.js';
import {
  type IntegrateCommandOptions,
  type IntegrateCommandResult,
  type IntegrateExecutionOverlay,
  SAFE_PERSON_ID_RE,
} from './types.js';

function resolveIntegratePaths(
  options: IntegrateCommandOptions,
  overlay?: IntegrateExecutionOverlay
): {
  repoDir: string;
  personId: string;
  dryRun: boolean;
  packageDir: string;
  realDataDir: string;
  dataDir: string;
  configPath: string;
  patchPath: string;
} {
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

  let packageDir = path.resolve(
    options.packageDir?.trim() || path.join(repoDir, 'research', 'people', personId)
  );
  if (options.packageDir?.trim()) {
    const pkgStat = fs.statSync(packageDir, { throwIfNoEntry: false });
    if (pkgStat?.isFile() && path.basename(packageDir) === 'patch.json') {
      packageDir = path.dirname(packageDir);
    }
  }
  const realDataDir = path.join(repoDir, 'data');
  const dataDir = overlay ? overlay.dataDirOverride : realDataDir;
  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  const patchPath = path.join(packageDir, 'patch.json');

  if (!options.preloadedRepo || overlay) {
    const repoStat = fs.statSync(repoDir, { throwIfNoEntry: false });
    if (!repoStat?.isDirectory()) {
      throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
    }
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
  }
  if (!options.preparsedPatch && !fs.existsSync(patchPath)) {
    throw new CliValidationError(
      `Missing person patch file: ${patchPath} (pass --package <dir> if the package lives outside research/people/${personId}).`
    );
  }

  return { repoDir, personId, dryRun, packageDir, realDataDir, dataDir, configPath, patchPath };
}

export async function runIntegrateCommand(options: IntegrateCommandOptions): Promise<IntegrateCommandResult> {
  return executeIntegrateSingle(options);
}

export async function executeIntegrateSingle(
  options: IntegrateCommandOptions,
  overlay?: IntegrateExecutionOverlay
): Promise<IntegrateCommandResult> {
  const { repoDir, personId, dryRun, packageDir, realDataDir, dataDir, patchPath } = resolveIntegratePaths(
    options,
    overlay
  );

  const loaded =
    options.preloadedRepo && !overlay
      ? options.preloadedRepo
      : loadLocalArchiveRepoSync(repoDir, {
          dataDirOverride: dataDir,
          requireConfig: true,
          requirePeopleFile: true,
          includeEnrichments: true,
        });
  const siteConfig = loaded.siteConfig;
  if (!siteConfig) {
    throw new CliValidationError(`Missing kinloom.config.yaml under ${repoDir}.`);
  }

  const rawPatch: unknown =
    options.preparsedPatch && !overlay
      ? options.preparsedPatch
      : JSON.parse(fs.readFileSync(patchPath, 'utf8'));
  const patch = normalizeAndValidatePatch(rawPatch, personId);

  const { mergedPeople, personUpdated, peopleCounts, peopleById, livingIds } = applyPeoplePatch(
    loaded.people,
    patch,
    personId,
    dataDir,
    siteConfig.privacy
  );

  const placesMerge = mergePlacesPatch(loaded.places, patch.places);
  const sourcesMerge = mergeSourcesPatch(loaded.sources, patch.sources, patch.remove_source_ids);
  const eventsMerge = mergeEventsPatch(loaded.events, patch.events, patch.remove_event_ids);
  const mediaMerge = mergeMediaPatch(loaded.media, patch.media, patch.remove_media_ids);
  const kinshipMerge = mergeKinshipPatch(loaded.kinship, patch.kinship, patch.remove_kinship);

  const placeIds = new Set<string>();
  for (let i = 0; i < placesMerge.items.length; i += 1) {
    placeIds.add(placesMerge.items[i].id);
  }
  const sourceIds = new Set<string>();
  for (let i = 0; i < sourcesMerge.items.length; i += 1) {
    sourceIds.add(sourcesMerge.items[i].id);
  }
  const mediaIds = new Set<string>();
  for (let i = 0; i < mediaMerge.items.length; i += 1) {
    mediaIds.add(mediaMerge.items[i].id);
  }
  const eventsById = new Map<string, (typeof eventsMerge.items)[number]>();
  for (let i = 0; i < eventsMerge.items.length; i += 1) {
    const ev = eventsMerge.items[i];
    eventsById.set(ev.id, ev);
  }

  const narrativesMerge = mergeNarrativesPatch(
    loaded.narratives,
    patch.narratives,
    personId,
    sourceIds,
    mediaIds
  );

  validatePatchReferentialIntegrity({
    cleanedPatchEvents: eventsMerge.cleanedPatchEvents,
    patchKinship: kinshipMerge.parsedPatchKinship,
    normalizedPatchNarratives: narrativesMerge.normalizedPatchNarratives,
    peopleById,
    livingIds,
    placeIds,
    sourceIds,
    eventsById,
  });

  validateRetirementIntegrity({
    topLevelRemoveEventIds: eventsMerge.topLevelRemoveEventIds,
    topLevelRemoveMediaIds: mediaMerge.topLevelRemoveMediaIds,
    topLevelRemoveSourceIds: sourcesMerge.topLevelRemoveSourceIds,
    mergedPeople,
    finalEvents: eventsMerge.items,
    finalMedia: mediaMerge.items,
    finalNarratives: narrativesMerge.items,
    sourceIds,
    mediaIds,
  });

  const mediaLayout = detectMediaLayout(repoDir);
  const plannedScans = planScanStaging(repoDir, packageDir, mediaLayout, overlay?.virtualStagedScans);
  validatePatchMedia({
    patchMedia: patch.media,
    repoDir,
    packageDir,
    mediaLayout,
    plannedScans,
    peopleById,
    livingIds,
    eventsById,
    sourceIds,
    overlay,
  });

  const { privateResult, publicResult, livingLeaks } = compileAndAuditMergedArchive(
    {
      people: mergedPeople,
      events: eventsMerge.items,
      places: placesMerge.items,
      sources: sourcesMerge.items,
      kinship: kinshipMerge.items,
      media: mediaMerge.items,
      narratives: narrativesMerge.items,
      ...(loaded.enrichments.length > 0 ? { enrichments: loaded.enrichments } : {}),
      siteConfig,
    },
    { skipBundleRevalidation: true }
  );

  const stagedScansReport = stagePlannedScans(plannedScans, dryRun, overlay);

  const shouldSerializeYaml = !dryRun || Boolean(overlay);
  const wouldWriteFiles: string[] = [];
  const pendingWrites: Array<{ file: string; content: string }> = [];

  if (personUpdated || peopleCounts.added > 0 || peopleCounts.updated > 0) {
    wouldWriteFiles.push('people.yaml');
    if (shouldSerializeYaml) {
      pendingWrites.push({
        file: 'people.yaml',
        content: serializePeopleYaml(mergedPeople, { sortById: true }),
      });
    }
  }
  if (
    eventsMerge.counts.added > 0 ||
    eventsMerge.counts.updated > 0 ||
    eventsMerge.removedEventIds.length > 0
  ) {
    wouldWriteFiles.push('events.yaml');
    if (shouldSerializeYaml) {
      pendingWrites.push({
        file: 'events.yaml',
        content: serializeEventsYaml(eventsMerge.items, { sortById: true }),
      });
    }
  }
  if (placesMerge.counts.added > 0 || placesMerge.counts.updated > 0) {
    wouldWriteFiles.push('places.yaml');
    if (shouldSerializeYaml) {
      pendingWrites.push({
        file: 'places.yaml',
        content: serializePlacesYaml(placesMerge.items, { sortById: true }),
      });
    }
  }
  if (
    sourcesMerge.counts.added > 0 ||
    sourcesMerge.counts.updated > 0 ||
    sourcesMerge.removedSourceIds.length > 0
  ) {
    wouldWriteFiles.push('sources.yaml');
    if (shouldSerializeYaml) {
      pendingWrites.push({
        file: 'sources.yaml',
        content: serializeSourcesYaml(sourcesMerge.items, { sortById: true }),
      });
    }
  }
  if (kinshipMerge.counts.added > 0 || kinshipMerge.counts.updated > 0 || kinshipMerge.removed.length > 0) {
    wouldWriteFiles.push('kinship.yaml');
    if (shouldSerializeYaml) {
      pendingWrites.push({
        file: 'kinship.yaml',
        content: serializeKinshipYaml(kinshipMerge.items, { sortDeterministic: true }),
      });
    }
  }
  if (mediaMerge.counts.added > 0 || mediaMerge.counts.updated > 0 || mediaMerge.removedMediaIds.length > 0) {
    wouldWriteFiles.push('media.yaml');
    if (shouldSerializeYaml) {
      pendingWrites.push({
        file: 'media.yaml',
        content: serializeMediaYaml(mediaMerge.items, { sortById: true }),
      });
    }
  }
  if (narrativesMerge.counts.added > 0 || narrativesMerge.counts.updated > 0) {
    wouldWriteFiles.push('narratives.yaml');
    if (shouldSerializeYaml) {
      pendingWrites.push({
        file: 'narratives.yaml',
        content: serializeNarrativesYaml(narrativesMerge.items, { sortById: true }),
      });
    }
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
      personUpdated,
      people: peopleCounts,
      events: eventsMerge.counts,
      places: placesMerge.counts,
      sources: sourcesMerge.counts,
      media: mediaMerge.counts,
      kinship: kinshipMerge.counts,
      narratives: narrativesMerge.counts,
    },
    removedSourceIds: sourcesMerge.removedSourceIds,
    removedEventIds: eventsMerge.removedEventIds,
    removedMediaIds: mediaMerge.removedMediaIds,
    removedKinshipCount: kinshipMerge.removed.length,
    removedKinship: kinshipMerge.removed,
    removedEvents: eventsMerge.removedEventIds.length,
    removedMedia: mediaMerge.removedMediaIds.length,
    inlineCitationCount: narrativesMerge.inlineCitationCount,
    stagedScans: stagedScansReport,
    wouldWriteYamlFiles: wouldWriteFiles.map((file) => path.join(realDataDir, file)),
    writtenYamlFiles,
    validation: {
      privateCounts: privateResult.bundle.meta.counts,
      publicCounts: publicResult.bundle.meta.counts,
      privateReviewFlags: privateResult.reviewFlags.length,
      publicReviewFlags: publicResult.reviewFlags.length,
      livingLeaks,
    },
  };

  const rendered = options.json
    ? JSON.stringify(summaryBase, null, 2)
    : `Integrate ${dryRun ? 'dry-run ' : ''}OK for ${personId}: ` +
      `person=${personUpdated ? 'updated' : 'unchanged'}, ` +
      `people=+${peopleCounts.added}/~${peopleCounts.updated}, ` +
      `events=+${eventsMerge.counts.added}/~${eventsMerge.counts.updated}${eventsMerge.removedEventIds.length > 0 ? `/-${eventsMerge.removedEventIds.length}` : ''}, ` +
      `places=+${placesMerge.counts.added}/~${placesMerge.counts.updated}, ` +
      `sources=+${sourcesMerge.counts.added}/~${sourcesMerge.counts.updated}${sourcesMerge.removedSourceIds.length > 0 ? `/-${sourcesMerge.removedSourceIds.length}` : ''}, ` +
      `media=+${mediaMerge.counts.added}/~${mediaMerge.counts.updated}${mediaMerge.removedMediaIds.length > 0 ? `/-${mediaMerge.removedMediaIds.length}` : ''}, ` +
      `${kinshipMerge.counts.added > 0 || kinshipMerge.counts.updated > 0 || kinshipMerge.removed.length > 0 ? `kinship=+${kinshipMerge.counts.added}/~${kinshipMerge.counts.updated}${kinshipMerge.removed.length > 0 ? `/-${kinshipMerge.removed.length}` : ''}, ` : ''}` +
      `narratives=+${narrativesMerge.counts.added}/~${narrativesMerge.counts.updated}, ` +
      `inlineCitations=${narrativesMerge.inlineCitationCount}, scans=${stagedScansReport.length}, ` +
      `written=${writtenYamlFiles.length}`;

  return {
    ...summaryBase,
    rendered,
  };
}
