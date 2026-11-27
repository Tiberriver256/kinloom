import path from 'node:path';
import { CliValidationError } from '../../errors.js';
import {
  applyPendingYamlWritesWithRollback,
  buildPendingYamlWrites,
  loadArchiveForMediaDedupe,
  scanStagedPackagesForRetiredMedia,
  verifyDeduplicatedArchive,
  writeFileAtomicUtf8,
} from './mediaDedupe/io.js';
import {
  groupDuplicateMediaByFile,
  mergeDuplicateMediaGroup,
  planDuplicateMediaMerges,
} from './mediaDedupe/merge.js';
import { formatMediaDedupeTextReport, renderMediaDedupeResult } from './mediaDedupe/report.js';
import {
  applyMediaReferenceRewrites,
  collectArchiveMediaReferenceCounts,
  rewriteNarrativeMediaCitations,
} from './mediaDedupe/rewrite.js';
import type { MediaDedupeCommandOptions, MediaDedupeCommandResult } from './mediaDedupe/types.js';

export { MEDIA_HELP } from './help.js';
export type {
  MediaDedupeCitationRewrite,
  MediaDedupeCommandOptions,
  MediaDedupeCommandResult,
  MediaDedupeExtensionRewrite,
  MediaDedupeGroupPlan,
  MediaDedupeStagedWarning,
} from './mediaDedupe/types.js';
export { formatMediaDedupeTextReport, mergeDuplicateMediaGroup, rewriteNarrativeMediaCitations };

export async function runMediaDedupeCommand(
  options: MediaDedupeCommandOptions = {}
): Promise<MediaDedupeCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const apply = Boolean(options.apply);
  const preferSet = new Set((options.preferIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
  const writeFileFn = options.writeFileImpl ?? writeFileAtomicUtf8;

  const archive = loadArchiveForMediaDedupe(repoDir);

  const mediaById = new Map(archive.media.map((item) => [item.id, item]));
  for (const prefId of preferSet) {
    if (!mediaById.has(prefId)) {
      throw new CliValidationError(`Preferred media_id '${prefId}' does not exist in data/media.yaml.`);
    }
  }

  const duplicateEntries = groupDuplicateMediaByFile(archive.media);
  if (duplicateEntries.length === 0) {
    return renderMediaDedupeResult(
      {
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
      },
      Boolean(options.json)
    );
  }

  const refCounts = collectArchiveMediaReferenceCounts({
    narratives: archive.narratives,
    people: archive.people,
    places: archive.places,
    events: archive.events,
    enrichments: archive.enrichments,
  });

  const { groups, retiredToCanonical, warnings, mergedMedia } = planDuplicateMediaMerges({
    media: archive.media,
    duplicateEntries,
    refCounts,
    preferSet,
  });

  const rewritten = applyMediaReferenceRewrites({
    narratives: archive.narratives,
    people: archive.people,
    places: archive.places,
    events: archive.events,
    retiredToCanonical,
  });

  verifyDeduplicatedArchive({
    config: archive.config,
    people: rewritten.nextPeople,
    places: rewritten.nextPlaces,
    events: rewritten.nextEvents,
    sources: archive.sources,
    kinship: archive.kinship,
    media: mergedMedia,
    narratives: rewritten.nextNarratives,
    enrichments: archive.enrichments,
  });

  const stagedPackageWarnings = scanStagedPackagesForRetiredMedia(repoDir, retiredToCanonical);

  const pendingWrites = buildPendingYamlWrites({
    paths: archive.paths,
    mergedMedia,
    nextNarratives: rewritten.nextNarratives,
    nextPeople: rewritten.nextPeople,
    nextPlaces: rewritten.nextPlaces,
    nextEvents: rewritten.nextEvents,
    narrativesChanged: rewritten.narrativesChanged,
    peopleChanged: rewritten.peopleChanged,
    placesChanged: rewritten.placesChanged,
    eventsChanged: rewritten.eventsChanged,
  });

  const wouldWriteYamlFiles = pendingWrites
    .map((item) => item.fullPath)
    .toSorted((a, b) => a.localeCompare(b));
  const writtenYamlFiles = apply ? applyPendingYamlWritesWithRollback(pendingWrites, writeFileFn) : [];

  return renderMediaDedupeResult(
    {
      ok: true,
      apply,
      dryRun: !apply,
      repo: repoDir,
      duplicateGroupCount: groups.length,
      retiredCount: retiredToCanonical.size,
      groups,
      citationRewrites: rewritten.citationRewrites,
      extensionRewrites: rewritten.extensionRewrites,
      warnings,
      stagedPackageWarnings,
      wouldWriteYamlFiles,
      writtenYamlFiles,
    },
    Boolean(options.json)
  );
}
