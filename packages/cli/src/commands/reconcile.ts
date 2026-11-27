import { readFile } from 'node:fs/promises';
import {
  type ArchiveBundle,
  type BuildMode,
  compileArchive,
  computeEntityDiff,
  type EntityPayload,
  type FieldDiff,
  parseKinloomConfigYaml,
} from '@kinloom/core';
import { KinloomApiClient, resolveAuthToken } from '../client.js';
import { CliValidationError } from '../errors.js';
import { snapshotToCompileInput } from './dataFiles.js';

export interface ReconcileCommandOptions {
  siteUrl: string;
  configPath: string;
  token?: string;
  mode?: BuildMode;
  fetchImpl?: typeof fetch;
}

export interface ReconcileCommandResult {
  inSync: boolean;
  headRevisionId: number;
  cachedRevisionId: number | null;
  mode: BuildMode;
  drifts: FieldDiff[];
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out;
  }
  return value;
}

function bundleToComparablePayload(bundle: ArchiveBundle): EntityPayload {
  const normalized = stripUndefinedDeep({
    meta: {
      version: bundle.meta.version,
      build_mode: bundle.meta.build_mode,
      max_revision_id: bundle.meta.max_revision_id,
      uncited_entity_keys: bundle.meta.uncited_entity_keys,
      counts: bundle.meta.counts,
    },
    people: bundle.people,
    events: bundle.events,
    residence_spans: bundle.residence_spans,
    places: bundle.places,
    place_ancestors: bundle.place_ancestors,
    kinship: bundle.kinship,
    sources: bundle.sources,
    media: bundle.media ?? [],
    ...(bundle.narratives !== undefined ? { narratives: bundle.narratives } : {}),
  });
  return normalized as EntityPayload;
}

export async function runReconcileCommand(options: ReconcileCommandOptions): Promise<ReconcileCommandResult> {
  const configPath = options.configPath.trim();
  if (!configPath) {
    throw new CliValidationError('`--config` kinloom.config.yaml path is required for `kinloom reconcile`.');
  }

  const configText = await readFile(configPath, 'utf8');
  let siteConfig;
  try {
    siteConfig = parseKinloomConfigYaml(configText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Invalid config '${configPath}': ${message}`);
  }

  const client = new KinloomApiClient({
    baseUrl: options.siteUrl,
    token: resolveAuthToken(options.token),
    fetchImpl: options.fetchImpl,
  });

  const [bundleResult, snapshotResult] = await Promise.all([client.getBundle(), client.exportSnapshot()]);

  if (bundleResult.status !== 'ok') {
    throw new Error('Expected 200 OK from GET /api/bundle during reconcile.');
  }
  if (snapshotResult.status !== 'ok') {
    throw new Error('Expected 200 OK from GET /api/export/snapshot during reconcile.');
  }

  const cachedBundle = bundleResult.bundle;
  const snapshot = snapshotResult.snapshot;
  const mode: BuildMode = options.mode ?? cachedBundle.meta.build_mode;

  const compileInput = snapshotToCompileInput({
    snapshot,
    siteConfig,
    mode,
    generatedAt: cachedBundle.meta.generated_at,
    version: cachedBundle.meta.version,
    includeEmptyNarratives: cachedBundle.narratives !== undefined,
  });

  const recompiled = compileArchive(compileInput).bundle;
  const diff = computeEntityDiff(
    bundleToComparablePayload(cachedBundle),
    bundleToComparablePayload(recompiled)
  );

  return {
    inSync: !diff.hasChanges,
    headRevisionId: snapshot.head_revision_id,
    cachedRevisionId: cachedBundle.meta.max_revision_id ?? null,
    mode,
    drifts: diff.fields,
  };
}
