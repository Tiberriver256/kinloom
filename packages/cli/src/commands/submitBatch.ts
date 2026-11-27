import { readFile } from 'node:fs/promises';
import {
  type BatchSubmission,
  BatchSubmissionSchema,
  type EntityType,
  KinshipEdgeSchema,
  MediaItemSchema,
  NarrativeSchema,
  PlaceSchema,
  parseYaml,
  RawEventSchema,
  RawPersonSchema,
  SourceRecordSchema,
  safeParseEntityPayload,
} from '@kinloom/core';
import type { z } from 'zod';
import { KinloomApiClient, resolveAuthToken, type SubmitBatchResponse } from '../client.js';
import { CliValidationError } from '../errors.js';

export interface SubmitBatchCommandOptions {
  filePath: string;
  siteUrl: string;
  token?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
}

export interface SubmitBatchCommandResult {
  dryRun: boolean;
  batchId: string;
  patchCount: number;
  response?: SubmitBatchResponse;
}

function validatePartialEntityData(
  entityType: EntityType,
  raw: Record<string, unknown>
): z.ZodSafeParseResult<unknown> {
  switch (entityType) {
    case 'person':
      return RawPersonSchema.partial().safeParse(raw);
    case 'event':
      return RawEventSchema.partial().safeParse(raw);
    case 'place':
      return PlaceSchema.partial().safeParse(raw);
    case 'source':
      return SourceRecordSchema.partial().safeParse(raw);
    case 'media':
      return MediaItemSchema.partial().safeParse(raw);
    case 'narrative':
      return NarrativeSchema.partial().safeParse(raw);
    case 'kinship_edge':
      return KinshipEdgeSchema.partial().safeParse(raw);
    default: {
      const _exhaustive: never = entityType;
      throw new Error(`Unexpected entity_type: ${String(_exhaustive)}`);
    }
  }
}

function formatZodIssues(prefix: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const subPath = issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
    return `${prefix}${subPath}: ${issue.message}`;
  });
}

/**
 * Validates a BatchSubmission envelope and every per-entity payload strictly at the CLI boundary.
 */
export function validateBatchSubmission(raw: unknown): BatchSubmission {
  const envelope = BatchSubmissionSchema.safeParse(raw);
  if (!envelope.success) {
    throw new CliValidationError(
      'Batch submission failed schema validation.',
      formatZodIssues('batch', envelope.error)
    );
  }

  const batch = envelope.data;
  const issues: string[] = [];

  for (let index = 0; index < batch.patches.length; index += 1) {
    const patch = batch.patches[index];
    const patchPrefix = `patches[${index}] (${patch.action} ${patch.entity_type}/${patch.entity_id})`;

    switch (patch.action) {
      case 'create': {
        const res = safeParseEntityPayload(patch.entity_type, patch.data);
        if (!res.success) {
          issues.push(...formatZodIssues(`${patchPrefix}.data`, res.error));
        }
        break;
      }
      case 'update': {
        if (Object.keys(patch.data).length === 0) {
          issues.push(`${patchPrefix}.data: Update payload must contain at least one field.`);
          break;
        }
        const res = patch.merge
          ? validatePartialEntityData(patch.entity_type, patch.data)
          : safeParseEntityPayload(patch.entity_type, patch.data);
        if (!res.success) {
          issues.push(...formatZodIssues(`${patchPrefix}.data`, res.error));
        }
        break;
      }
      case 'delete':
        break;
      case 'restore': {
        if (patch.data !== undefined) {
          const res = validatePartialEntityData(patch.entity_type, patch.data);
          if (!res.success) {
            issues.push(...formatZodIssues(`${patchPrefix}.data`, res.error));
          }
        }
        break;
      }
      default: {
        const _exhaustive: never = patch;
        throw new Error(`Unhandled patch action: ${String(_exhaustive)}`);
      }
    }
  }

  if (issues.length > 0) {
    throw new CliValidationError(
      `Batch submission has ${issues.length} payload validation error(s).`,
      issues
    );
  }

  return batch;
}

function parseBatchText(text: string, filePath: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new CliValidationError(`Batch file '${filePath}' is empty.`);
  }
  if (filePath.toLowerCase().endsWith('.json')) {
    try {
      return JSON.parse(trimmed);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliValidationError(`Failed to parse JSON in '${filePath}': ${msg}`);
    }
  }
  try {
    return parseYaml(trimmed);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Failed to parse YAML/JSON in '${filePath}': ${msg}`);
  }
}

export async function runSubmitBatchCommand(
  options: SubmitBatchCommandOptions
): Promise<SubmitBatchCommandResult> {
  const filePath = options.filePath.trim();
  if (!filePath) {
    throw new CliValidationError('`--file` patch spec path is required for `kinloom submit-batch`.');
  }

  const rawText = await readFile(filePath, 'utf8');
  const parsedRaw = parseBatchText(rawText, filePath);
  const batch = validateBatchSubmission(parsedRaw);

  if (options.dryRun) {
    return {
      dryRun: true,
      batchId: batch.batch_id,
      patchCount: batch.patches.length,
    };
  }

  const client = new KinloomApiClient({
    baseUrl: options.siteUrl,
    token: resolveAuthToken(options.token),
    fetchImpl: options.fetchImpl,
  });

  const response = await client.submitBatch(batch);
  return {
    dryRun: false,
    batchId: response.batch_id,
    patchCount: batch.patches.length,
    response,
  };
}
