import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  type ArchiveBundle,
  type ArchiveRawSnapshot,
  type BatchSubmission,
  compileArchive,
  computeEntityDiff,
  deriveKinshipEdgeId,
  type EntityPatch,
  type EntityPayload,
  type EntityType,
  parseKinloomConfigYaml,
} from '@kinloom/core';
import { KinloomApiClient, resolveAuthToken, type SubmitBatchResponse } from '../client.js';
import { CliValidationError, KinloomApiError } from '../errors.js';
import { type LocalArchiveData, loadArchiveDataDir } from './dataFiles.js';
import { validateBatchSubmission } from './submitBatch.js';

export interface SeedCommandOptions {
  dataDir: string;
  configPath: string;
  siteUrl: string;
  token?: string;
  dryRun?: boolean;
  batchId?: string;
  summary?: string;
  chunkSize?: number;
  fetchImpl?: typeof fetch;
}

export interface SeedCommandResult {
  dryRun: boolean;
  batchId: string;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  totalEntities: number;
  chunksSubmitted?: number;
  precompiledCounts: ArchiveBundle['meta']['counts'];
  reviewFlagsCount: number;
  response?: SubmitBatchResponse;
}

interface SeedEntityEntry {
  entity_type: EntityType;
  entity_id: string;
  data: EntityPayload;
  has_primary_source: boolean;
}

function collectSeedEntries(data: LocalArchiveData): SeedEntityEntry[] {
  const entries: SeedEntityEntry[] = [];

  for (const place of data.places) {
    entries.push({
      entity_type: 'place',
      entity_id: place.id,
      data: place,
      has_primary_source: place.has_primary_source ?? true,
    });
  }
  for (const source of data.sources) {
    entries.push({
      entity_type: 'source',
      entity_id: source.id,
      data: source,
      has_primary_source: source.has_primary_source ?? true,
    });
  }
  for (const person of data.people) {
    entries.push({
      entity_type: 'person',
      entity_id: person.id,
      data: person,
      has_primary_source: person.has_primary_source ?? true,
    });
  }
  for (const event of data.events) {
    entries.push({
      entity_type: 'event',
      entity_id: event.id,
      data: event,
      has_primary_source: event.has_primary_source ?? true,
    });
  }
  for (const edge of data.kinship) {
    entries.push({
      entity_type: 'kinship_edge',
      entity_id: deriveKinshipEdgeId(edge),
      data: edge,
      has_primary_source: true,
    });
  }
  for (const media of data.media) {
    entries.push({
      entity_type: 'media',
      entity_id: media.id,
      data: media,
      has_primary_source: media.has_primary_source ?? true,
    });
  }
  for (const narrative of data.narratives) {
    entries.push({
      entity_type: 'narrative',
      entity_id: narrative.id,
      data: narrative,
      has_primary_source: narrative.has_primary_source ?? true,
    });
  }

  return entries;
}

function deriveDeterministicBatchId(entries: readonly SeedEntityEntry[]): string {
  const hash = createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 12);
  return `seed-${hash}`;
}

function indexRemoteSnapshot(
  snapshot: ArchiveRawSnapshot
): Map<string, { revisionId: number; data: EntityPayload }> {
  const index = new Map<string, { revisionId: number; data: EntityPayload }>();
  for (const row of snapshot.entities) {
    if (row.deleted_at !== null) {
      continue;
    }
    index.set(`${row.entity_type}:${row.entity_id}`, {
      revisionId: row.current_revision_id,
      data: row.data,
    });
  }
  for (const row of snapshot.kinship) {
    if (row.deleted_at !== null) {
      continue;
    }
    index.set(`kinship_edge:${row.edge_id}`, {
      revisionId: row.current_revision_id,
      data: row.edge,
    });
  }
  return index;
}

export async function runSeedCommand(options: SeedCommandOptions): Promise<SeedCommandResult> {
  const dataDir = options.dataDir.trim();
  const configPath = options.configPath.trim();

  if (!dataDir) {
    throw new CliValidationError('`--data` directory is required for `kinloom seed`.');
  }
  if (!configPath) {
    throw new CliValidationError('`--config` kinloom.config.yaml path is required for `kinloom seed`.');
  }

  const configText = await readFile(configPath, 'utf8');
  let siteConfig;
  try {
    siteConfig = parseKinloomConfigYaml(configText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Invalid config '${configPath}': ${message}`);
  }

  let data: LocalArchiveData;
  try {
    data = await loadArchiveDataDir(dataDir);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Invalid archive YAML in '${dataDir}': ${message}`);
  }

  const precompiled = compileArchive({
    people: data.people,
    events: data.events,
    places: data.places,
    sources: data.sources,
    kinship: data.kinship,
    media: data.media,
    ...(data.narratives.length > 0 ? { narratives: data.narratives } : {}),
    siteConfig,
    mode: 'private',
  });

  const entries = collectSeedEntries(data);
  const batchId = options.batchId?.trim() || deriveDeterministicBatchId(entries);
  const summary = options.summary?.trim() || `Seed ${siteConfig.site.familyName} archive from YAML`;

  if (options.dryRun) {
    const createPatches: EntityPatch[] = entries.map((entry) => ({
      action: 'create',
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      data: entry.data,
      has_primary_source: entry.has_primary_source,
    }));
    if (createPatches.length > 0) {
      validateBatchSubmission({
        batch_id: batchId,
        author_type: 'system_seed',
        summary,
        has_primary_source: true,
        patches: createPatches,
      });
    }
    return {
      dryRun: true,
      batchId,
      createdCount: createPatches.length,
      updatedCount: 0,
      unchangedCount: 0,
      totalEntities: entries.length,
      precompiledCounts: precompiled.bundle.meta.counts,
      reviewFlagsCount: precompiled.reviewFlags.length,
    };
  }

  const client = new KinloomApiClient({
    baseUrl: options.siteUrl,
    token: resolveAuthToken(options.token),
    fetchImpl: options.fetchImpl,
  });

  let remoteIndex: Map<string, { revisionId: number; data: EntityPayload }> | null = null;
  try {
    const snapshotResult = await client.exportSnapshot();
    if (snapshotResult.status === 'ok') {
      remoteIndex = indexRemoteSnapshot(snapshotResult.snapshot);
    }
  } catch (err: unknown) {
    // Scoped write_batch tokens or minimal servers may disallow /api/export/snapshot.
    if (!(err instanceof KinloomApiError && (err.kind === 'forbidden' || err.kind === 'not_found'))) {
      throw err;
    }
  }

  const patches: EntityPatch[] = [];
  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const entry of entries) {
    const existing = remoteIndex?.get(`${entry.entity_type}:${entry.entity_id}`);
    if (!existing) {
      patches.push({
        action: 'create',
        entity_type: entry.entity_type,
        entity_id: entry.entity_id,
        data: entry.data,
        has_primary_source: entry.has_primary_source,
      });
      createdCount += 1;
      continue;
    }

    const diff = computeEntityDiff(existing.data, entry.data);
    if (!diff.hasChanges) {
      unchangedCount += 1;
      continue;
    }

    patches.push({
      action: 'update',
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      ...(existing.revisionId > 0 ? { parent_revision_id: existing.revisionId } : {}),
      data: entry.data,
      merge: false,
      has_primary_source: entry.has_primary_source,
    });
    updatedCount += 1;
  }

  if (patches.length === 0) {
    return {
      dryRun: false,
      batchId,
      createdCount: 0,
      updatedCount: 0,
      unchangedCount,
      totalEntities: entries.length,
      precompiledCounts: precompiled.bundle.meta.counts,
      reviewFlagsCount: precompiled.reviewFlags.length,
    };
  }

  const chunkSize = options.chunkSize ?? 100;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new CliValidationError('`--chunk-size` must be a positive integer.');
  }

  let lastResponse: SubmitBatchResponse | undefined;
  let chunksSubmitted = 0;

  if (patches.length <= chunkSize) {
    const batch: BatchSubmission = validateBatchSubmission({
      batch_id: batchId,
      author_type: 'system_seed',
      summary,
      has_primary_source: true,
      patches,
    });
    lastResponse = await client.submitBatch(batch);
    chunksSubmitted = 1;
  } else {
    const totalChunks = Math.ceil(patches.length / chunkSize);
    const padWidth = String(totalChunks).length;
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkSize;
      const slice = patches.slice(start, start + chunkSize);
      const partLabel = String(index + 1).padStart(padWidth, '0');
      const chunkBatchId = `${batchId}-p${partLabel}`;
      const batch: BatchSubmission = validateBatchSubmission({
        batch_id: chunkBatchId,
        author_type: 'system_seed',
        summary: `${summary} (part ${index + 1}/${totalChunks})`,
        has_primary_source: true,
        patches: slice,
      });
      lastResponse = await client.submitBatch(batch);
      chunksSubmitted += 1;
    }
  }

  return {
    dryRun: false,
    batchId: chunksSubmitted === 1 && lastResponse ? lastResponse.batch_id : batchId,
    createdCount,
    updatedCount,
    unchangedCount,
    totalEntities: entries.length,
    chunksSubmitted,
    precompiledCounts: precompiled.bundle.meta.counts,
    reviewFlagsCount: precompiled.reviewFlags.length,
    response: lastResponse,
  };
}
