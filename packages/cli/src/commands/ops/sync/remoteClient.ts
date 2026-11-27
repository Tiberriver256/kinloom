import { randomBytes } from 'node:crypto';
import type { BatchSubmission, EntityPatch } from '@kinloom/core';
import { type GetBundleResult, KinloomApiClient, type SubmitBatchResponse } from '../../../client.js';
import { KinloomApiError } from '../../../errors.js';
import {
  type RemoteSnapshotResponse,
  runWithConcurrency,
  type SyncExecutionContext,
  type SyncLiveVerificationFailure,
  type SyncLiveVerificationSummary,
  type SyncRecompileSummary,
  type SyncSubmittedBatch,
} from './types.js';

const LIVE_VERIFY_CONCURRENCY = 6;
const LIVE_VERIFY_TIMEOUT_MS = 15_000;

function createSyncApiClient(ctx: SyncExecutionContext, token: string): KinloomApiClient {
  return new KinloomApiClient({
    baseUrl: ctx.bindings.baseUrl,
    token,
    fetchImpl: ctx.fetchImpl,
  });
}

function isApiResponseValidationError(err: KinloomApiError): boolean {
  return err.code === 'INVALID_JSON_RESPONSE' || err.code === 'INVALID_RESPONSE_SCHEMA';
}

export async function fetchRemoteSnapshot(
  ctx: SyncExecutionContext,
  readToken: string
): Promise<{ etag: string | null; headRevisionId: number; snapshot: RemoteSnapshotResponse }> {
  const client = createSyncApiClient(ctx, readToken);
  try {
    const res = await client.exportSnapshot();
    if (res.status !== 'ok') {
      throw new Error('GET /api/export/snapshot returned unexpected 304 Not Modified.');
    }
    return {
      etag: res.etag,
      headRevisionId: Number(res.snapshot.head_revision_id),
      snapshot: res.snapshot,
    };
  } catch (err: unknown) {
    if (err instanceof KinloomApiError) {
      if (isApiResponseValidationError(err)) {
        throw err;
      }
      throw new Error(
        `GET /api/export/snapshot failed with HTTP ${err.status}: ${err.message.slice(0, 300)}`,
        {
          cause: err,
        }
      );
    }
    throw err;
  }
}

export async function submitPatchChunks(params: {
  ctx: SyncExecutionContext;
  writeToken: string;
  batchLabel: string;
  summary: string;
  patches: readonly EntityPatch[];
  chunkSize: number;
}): Promise<SyncSubmittedBatch[]> {
  const client = createSyncApiClient(params.ctx, params.writeToken);
  const totalChunks = Math.ceil(params.patches.length / params.chunkSize);
  const padWidth = String(totalChunks).length;
  const runStamp = new Date()
    .toISOString()
    .replaceAll(/[^0-9]/g, '')
    .slice(0, 14);
  const safeLabel =
    params.batchLabel
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/g, '-')
      .replaceAll(/^-|-$/g, '') || 'archive';
  const baseBatchId = `sync-${safeLabel}-${runStamp}-${randomBytes(3).toString('hex')}`;

  const responses: SyncSubmittedBatch[] = [];
  for (let i = 0; i < totalChunks; i += 1) {
    const slice = params.patches.slice(i * params.chunkSize, (i + 1) * params.chunkSize);
    const batchId =
      totalChunks === 1 ? baseBatchId : `${baseBatchId}-p${String(i + 1).padStart(padWidth, '0')}`;
    const chunkSummary =
      totalChunks === 1 ? params.summary : `${params.summary} (part ${i + 1}/${totalChunks})`;

    const payload: BatchSubmission = {
      batch_id: batchId,
      author_type: 'agent',
      summary: chunkSummary,
      has_primary_source: true,
      patches: [...slice],
    };

    let submitted: SubmitBatchResponse;
    try {
      submitted = await client.submitBatch(payload);
    } catch (err: unknown) {
      if (err instanceof KinloomApiError) {
        if (isApiResponseValidationError(err)) {
          throw err;
        }
        throw new Error(
          `POST /api/batches (${batchId}, ${slice.length} patches) failed with HTTP ${err.status}: ${err.message.slice(0, 500)}`,
          { cause: err }
        );
      }
      throw err;
    }

    responses.push({
      batch_id: submitted.batch_id,
      patchCount: slice.length,
      head_revision_id: submitted.head_revision_id,
      etag: submitted.etag,
    });
  }

  return responses;
}

export async function purgeCompiledBundleAndRecompile(
  ctx: SyncExecutionContext,
  bearerToken: string
): Promise<SyncRecompileSummary> {
  await ctx.execWrangler(
    ctx.wranglerBin,
    [
      'r2',
      'object',
      'delete',
      `${ctx.bindings.r2Bucket}/compiled/archive.json`,
      '--remote',
      '--config',
      ctx.bindings.configPath,
    ],
    {
      cwd: ctx.repoDir,
      maxBufferBytes: 4 * 1024 * 1024,
      timeoutMs: 45_000,
    }
  );

  const client = createSyncApiClient(ctx, bearerToken);
  let res: GetBundleResult;
  try {
    res = await client.getBundle({ cacheControl: 'no-cache' });
  } catch (err: unknown) {
    if (err instanceof KinloomApiError) {
      if (isApiResponseValidationError(err)) {
        throw err;
      }
      throw new Error(
        `Post-purge GET /api/bundle failed with HTTP ${err.status}: ${err.message.slice(0, 300)}`,
        {
          cause: err,
        }
      );
    }
    throw err;
  }

  if (res.status !== 'ok') {
    throw new Error('Post-purge GET /api/bundle returned unexpected 304 Not Modified.');
  }

  return {
    httpStatus: 200,
    etag: res.etag,
    maxRevisionId: res.bundle.meta.max_revision_id ?? null,
    counts: res.bundle.meta.counts,
  };
}

export async function verifyLiveEndpoints(params: {
  ctx: SyncExecutionContext;
  writeToken: string;
  expectedRevision: number | null;
  uploadedKeys: readonly string[];
  concurrency: number;
}): Promise<SyncLiveVerificationSummary> {
  const failures: SyncLiveVerificationFailure[] = [];
  let bundleStatus: number | null = null;
  let bundleRevision: number | null = null;

  const bundleUrl = `${params.ctx.bindings.baseUrl}/api/bundle`;
  const client = createSyncApiClient(params.ctx, params.writeToken);
  try {
    const res = await client.getBundle({
      cacheControl: 'no-cache',
      signal: AbortSignal.timeout(LIVE_VERIFY_TIMEOUT_MS),
    });
    if (res.status !== 'ok') {
      bundleStatus = 304;
      failures.push({
        target: 'bundle',
        url: bundleUrl,
        status: 304,
        reason: 'Expected HTTP 200 from /api/bundle, got HTTP 304',
      });
    } else {
      bundleStatus = 200;
      bundleRevision = res.bundle.meta.max_revision_id ?? null;
      if (params.expectedRevision !== null && bundleRevision !== params.expectedRevision) {
        failures.push({
          target: 'bundle',
          url: bundleUrl,
          status: 200,
          reason: `Bundle revision mismatch: expected r${params.expectedRevision}, got ${bundleRevision !== null ? `r${bundleRevision}` : 'none'}`,
        });
      }
    }
  } catch (err: unknown) {
    if (err instanceof KinloomApiError) {
      bundleStatus = err.status;
      if (err.code === 'INVALID_JSON_RESPONSE') {
        failures.push({
          target: 'bundle',
          url: bundleUrl,
          status: err.status,
          reason: `Invalid JSON from /api/bundle: ${err.message}`,
        });
      } else if (err.code === 'INVALID_RESPONSE_SCHEMA') {
        failures.push({
          target: 'bundle',
          url: bundleUrl,
          status: err.status,
          reason: err.message,
        });
      } else {
        failures.push({
          target: 'bundle',
          url: bundleUrl,
          status: err.status,
          reason: `Expected HTTP 200 from /api/bundle, got HTTP ${err.status}${err.message.trim() ? `: ${err.message.trim().slice(0, 160)}` : ''}`,
        });
      }
    } else {
      failures.push({
        target: 'bundle',
        url: bundleUrl,
        status: null,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let mediaFailed = 0;
  const probeConcurrency = Math.max(1, Math.min(params.concurrency, LIVE_VERIFY_CONCURRENCY));
  const mediaProbeFailures = await runWithConcurrency(
    params.uploadedKeys,
    probeConcurrency,
    async (r2Key): Promise<SyncLiveVerificationFailure | null> => {
      const mediaUrl = `${params.ctx.bindings.baseUrl}/${r2Key}`;
      try {
        const response = await params.ctx.fetchImpl(mediaUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${params.writeToken}`,
            'Cache-Control': 'no-cache',
          },
          signal: AbortSignal.timeout(LIVE_VERIFY_TIMEOUT_MS),
        });
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => undefined);
          return {
            target: r2Key,
            url: mediaUrl,
            status: response.status,
            reason: `Expected HTTP 200, got HTTP ${response.status}`,
          };
        }

        const contentLengthHeader = response.headers.get('content-length');
        if (contentLengthHeader !== null && Number(contentLengthHeader) === 0) {
          await response.body?.cancel().catch(() => undefined);
          return {
            target: r2Key,
            url: mediaUrl,
            status: response.status,
            reason: 'Empty response (content-length: 0)',
          };
        }

        let firstChunkBytes = 0;
        const reader = response.body?.getReader();
        if (reader) {
          try {
            while (firstChunkBytes === 0) {
              const chunk = await reader.read();
              if (chunk.done) {
                break;
              }
              firstChunkBytes = chunk.value ? chunk.value.byteLength : 0;
            }
          } finally {
            await reader.cancel().catch(() => undefined);
          }
        } else {
          const buf = await response.arrayBuffer();
          firstChunkBytes = buf.byteLength;
        }

        if (firstChunkBytes === 0) {
          return {
            target: r2Key,
            url: mediaUrl,
            status: response.status,
            reason: 'Empty response body (0 bytes)',
          };
        }

        return null;
      } catch (err: unknown) {
        return {
          target: r2Key,
          url: mediaUrl,
          status: null,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
  );

  for (const failure of mediaProbeFailures) {
    if (failure) {
      mediaFailed += 1;
      failures.push(failure);
    }
  }

  return {
    ok: failures.length === 0,
    bundleStatus,
    bundleRevision,
    expectedRevision: params.expectedRevision,
    mediaChecked: params.uploadedKeys.length,
    mediaFailed,
    failures,
  };
}
