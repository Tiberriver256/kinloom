import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MediaItemSchema, validateMediaSelection } from '@kinloom/core';
import { z } from 'zod';
import { KinloomApiClient, resolveAuthToken, type UploadMediaResponse } from '../client.js';
import { CliValidationError } from '../errors.js';

export interface UploadMediaCommandOptions {
  filePath: string;
  metadataInput: string;
  summary: string;
  siteUrl: string;
  token?: string;
  mimeType?: string;
  allowAudioVideo?: boolean;
  maxUploadBytes?: number;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
}

export interface UploadMediaCommandResult {
  dryRun: boolean;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  response?: UploadMediaResponse;
}

const UploadMetadataInputSchema = MediaItemSchema.omit({ file: true }).extend({
  id: z.string().min(1).optional(),
});

const EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

export function detectMimeType(bytes: Uint8Array, filePath: string): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return 'application/pdf';
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return 'video/mp4';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return 'video/webm';
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return 'audio/ogg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return 'audio/wav';
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return 'audio/mpeg';
  }
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] ?? null;
}

async function parseMetadataInput(rawInput: string): Promise<z.infer<typeof UploadMetadataInputSchema>> {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new CliValidationError('`--metadata` JSON string or @file path is required.');
  }

  let jsonText = trimmed;
  if (trimmed.startsWith('@')) {
    jsonText = await readFile(trimmed.slice(1), 'utf8');
  } else if (!trimmed.startsWith('{')) {
    jsonText = await readFile(trimmed, 'utf8');
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(jsonText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Invalid JSON in \`--metadata\`: ${message}`);
  }

  const validated = UploadMetadataInputSchema.safeParse(parsedRaw);
  if (!validated.success) {
    const issues = validated.error.issues.map(
      (issue) => `metadata.${issue.path.join('.') || '<root>'}: ${issue.message}`
    );
    throw new CliValidationError('Media metadata failed validation.', issues);
  }
  return validated.data;
}

export async function runUploadMediaCommand(
  options: UploadMediaCommandOptions
): Promise<UploadMediaCommandResult> {
  const filePath = options.filePath.trim();
  const summary = options.summary.trim();

  if (!filePath) {
    throw new CliValidationError('`--file` path is required for `kinloom upload-media`.');
  }
  if (summary.length < 3) {
    throw new CliValidationError('`--summary` must be at least 3 characters.');
  }

  const metadata = await parseMetadataInput(options.metadataInput);
  const fileBytes = await readFile(filePath);
  const fileName = path.basename(filePath);
  const mimeType = options.mimeType?.trim() || detectMimeType(fileBytes, filePath) || '';

  const allowAudioVideo =
    options.allowAudioVideo ||
    metadata.kind === 'video_story' ||
    metadata.kind === 'audio_oral_history';

  const validation = validateMediaSelection({
    mimeType,
    sizeBytes: fileBytes.byteLength,
    targetHasLiving: false,
    maxUploadBytes: options.maxUploadBytes,
    allowAudioVideo,
  });

  if (!validation.ok) {
    throw new CliValidationError(validation.message, [validation.reason]);
  }

  if (options.dryRun) {
    return {
      dryRun: true,
      fileName,
      mimeType,
      sizeBytes: fileBytes.byteLength,
    };
  }

  const client = new KinloomApiClient({
    baseUrl: options.siteUrl,
    token: resolveAuthToken(options.token),
    fetchImpl: options.fetchImpl,
  });

  const response = await client.uploadMedia({
    fileBytes,
    fileName,
    mimeType,
    metadata,
    summary,
  });

  return {
    dryRun: false,
    fileName,
    mimeType,
    sizeBytes: fileBytes.byteLength,
    response,
  };
}
