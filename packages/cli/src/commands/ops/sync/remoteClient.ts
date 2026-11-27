import { randomBytes } from 'node:crypto';
import type { ArchiveBundle, EntityPatch } from '@kinloom/core';
import {
  isPlainRecord,
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

export async function fetchRemoteSnapshot(
  ctx: SyncExecutionContext,
  readToken: string
): Promise<{ etag: string | null; headRevisionId: number; snapshot: RemoteSnapshotResponse }> {
  const response = await ctx.fetchImpl(`${ctx.bindings.baseUrl}/api/export/snapshot`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${readToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET /api/export/snapshot failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const body: unknown = await response.json();
  const snapshotRaw = isPlainRecord(body) && isPlainRecord(body.snapshot) ? body.snapshot : body;
  if (
    !isPlainRecord(snapshotRaw) ||
    !Array.isArray(snapshotRaw.entities) ||
    !Array.isArray(snapshotRaw.kinship)
  ) {
    throw new Error('Unexpected response shape from GET /api/export/snapshot.');
  }

  const headRaw = snapshotRaw.head_revision_id ?? (isPlainRecord(body) ? body.head_revision_id : 0) ?? 0;

  return {
    etag: response.headers.get('etag'),
    headRevisionId: Number(headRaw),
    snapshot: snapshotRaw as unknown as RemoteSnapshotResponse,
  };
}

export async function submitPatchChunks(params: {
  ctx: SyncExecutionContext;
  writeToken: string;
  batchLabel: string;
  summary: string;
  patches: readonly EntityPatch[];
  chunkSize: number;
}): Promise<SyncSubmittedBatch[]> {
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

    const payload = {
      batch_id: batchId,
      author_type: 'agent',
      summary: chunkSummary,
      has_primary_source: true,
      patches: slice,
    };

    const response = await params.ctx.fetchImpl(`${params.ctx.bindings.baseUrl}/api/batches`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.writeToken}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `POST /api/batches (${batchId}, ${slice.length} patches) failed with HTTP ${response.status}: ${text.slice(0, 500)}`
      );
    }

    const parsed: unknown = JSON.parse(text);
    const parsedRec = isPlainRecord(parsed) ? parsed : {};
    responses.push({
      batch_id: typeof parsedRec.batch_id === 'string' ? parsedRec.batch_id : batchId,
      patchCount: slice.length,
      head_revision_id: Number(parsedRec.head_revision_id ?? 0),
      etag: typeof parsedRec.etag === 'string' ? parsedRec.etag : '',
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

  const response = await ctx.fetchImpl(`${ctx.bindings.baseUrl}/api/bundle`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${bearerToken}`,
      'Cache-Control': 'no-cache',
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Post-purge GET /api/bundle failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
  }

  const bundle: unknown = await response.json();
  const meta = isPlainRecord(bundle) && isPlainRecord(bundle.meta) ? bundle.meta : null;
  const maxRevisionId = typeof meta?.max_revision_id === 'number' ? meta.max_revision_id : null;
  const counts = isPlainRecord(meta?.counts) ? (meta.counts as ArchiveBundle['meta']['counts']) : null;

  return {
    httpStatus: response.status,
    etag: response.headers.get('etag'),
    maxRevisionId,
    counts,
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
  try {
    const response = await params.ctx.fetchImpl(bundleUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${params.writeToken}`,
        'Cache-Control': 'no-cache',
      },
      signal: AbortSignal.timeout(LIVE_VERIFY_TIMEOUT_MS),
    });
    bundleStatus = response.status;
    if (response.status !== 200) {
      const text = await response.text().catch(() => '');
      failures.push({
        target: 'bundle',
        url: bundleUrl,
        status: response.status,
        reason: `Expected HTTP 200 from /api/bundle, got HTTP ${response.status}${text.trim() ? `: ${text.trim().slice(0, 160)}` : ''}`,
      });
    } else {
      let body: unknown;
      try {
        body = await response.json();
      } catch (err: unknown) {
        failures.push({
          target: 'bundle',
          url: bundleUrl,
          status: response.status,
          reason: `Invalid JSON from /api/bundle: ${err instanceof Error ? err.message : String(err)}`,
        });
        body = null;
      }
      if (body !== null) {
        const meta = isPlainRecord(body) && isPlainRecord(body.meta) ? body.meta : null;
        bundleRevision = typeof meta?.max_revision_id === 'number' ? meta.max_revision_id : null;
        if (params.expectedRevision !== null && bundleRevision !== params.expectedRevision) {
          failures.push({
            target: 'bundle',
            url: bundleUrl,
            status: response.status,
            reason: `Bundle revision mismatch: expected r${params.expectedRevision}, got ${bundleRevision !== null ? `r${bundleRevision}` : 'none'}`,
          });
        }
      }
    }
  } catch (err: unknown) {
    failures.push({
      target: 'bundle',
      url: bundleUrl,
      status: null,
      reason: err instanceof Error ? err.message : String(err),
    });
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
