import fs from 'node:fs';
import path from 'node:path';
import { parseYaml } from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import { parseRemoveKinshipEntries } from '../shared/integrateEngine/kinship.js';
import { isPlainObject, parseOptionalStringList } from '../shared/integrateEngine/primitives.js';
import type { NormalizedMultiEntityPatch, PatchCommandOptions } from './types.js';

const ALLOWED_MULTI_ENTITY_PATCH_KEYS = new Set([
  'people',
  'places',
  'events',
  'kinship',
  'sources',
  'media',
  'narratives',
  'remove_event_ids',
  'remove_source_ids',
  'remove_media_ids',
  'remove_narrative_ids',
  'remove_kinship',
]);

async function readProcessStdinUtf8(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliValidationError(
      'Missing patch input on stdin. Pass a patch file path or pipe JSON/YAML into `kinloom patch -`.'
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function loadRawPatchText(
  options: Pick<PatchCommandOptions, 'patchFile' | 'patchContent' | 'readStdin'>
): Promise<{ rawText: string; inputSource: string; formatHint: 'json' | 'yaml' | 'auto' }> {
  if (options.patchContent !== undefined) {
    return {
      rawText: options.patchContent,
      inputSource: options.patchFile?.trim() || '<inline>',
      formatHint: 'auto',
    };
  }

  const target = options.patchFile?.trim() ?? '';
  if (!target) {
    throw new CliValidationError(
      'Missing patch input. Pass `<file-or-stdin>` (a JSON/YAML file path or `-` for stdin).'
    );
  }

  if (target === '-') {
    const reader = options.readStdin ?? readProcessStdinUtf8;
    const rawText = await reader();
    return { rawText, inputSource: '<stdin>', formatHint: 'auto' };
  }

  const resolvedPath = path.resolve(target);
  const stat = fs.statSync(resolvedPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw new CliValidationError(`Patch file does not exist: ${resolvedPath}`);
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const formatHint = ext === '.json' ? 'json' : ext === '.yaml' || ext === '.yml' ? 'yaml' : 'auto';
  return {
    rawText: fs.readFileSync(resolvedPath, 'utf8'),
    inputSource: resolvedPath,
    formatHint,
  };
}

export function parsePatchDocumentText(
  rawText: string,
  formatHint: 'json' | 'yaml' | 'auto' = 'auto'
): unknown {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    throw new CliValidationError('Patch document is empty.');
  }

  if (formatHint === 'json') {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new CliValidationError(`Invalid JSON patch document: ${detail}`);
    }
  }

  if (formatHint === 'auto' && trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      // Fall through to YAML parser (e.g. flow-style YAML mapping).
    }
  }

  try {
    return parseYaml(trimmed);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Invalid YAML/JSON patch document: ${detail}`);
  }
}

function readOptionalArrayField(root: Record<string, unknown>, field: string): readonly unknown[] {
  const value = root[field];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new CliValidationError(`Patch field '${field}' must be an array.`);
  }
  return value;
}

function parseOptionalStringListField(raw: unknown, label: string): readonly string[] {
  try {
    return parseOptionalStringList(raw, label);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(detail);
  }
}

export function normalizeMultiEntityPatch(rawPatch: unknown): NormalizedMultiEntityPatch {
  if (!isPlainObject(rawPatch)) {
    throw new CliValidationError('Patch document root must be a JSON or YAML object.');
  }

  for (const key of Object.keys(rawPatch)) {
    if (!ALLOWED_MULTI_ENTITY_PATCH_KEYS.has(key)) {
      throw new CliValidationError(`Unknown top-level key '${key}' in patch document.`);
    }
  }

  return {
    people: readOptionalArrayField(rawPatch, 'people'),
    places: readOptionalArrayField(rawPatch, 'places'),
    events: readOptionalArrayField(rawPatch, 'events'),
    kinship: readOptionalArrayField(rawPatch, 'kinship'),
    sources: readOptionalArrayField(rawPatch, 'sources'),
    media: readOptionalArrayField(rawPatch, 'media'),
    narratives: readOptionalArrayField(rawPatch, 'narratives'),
    remove_event_ids: parseOptionalStringListField(rawPatch['remove_event_ids'], 'patch.remove_event_ids'),
    remove_source_ids: parseOptionalStringListField(rawPatch['remove_source_ids'], 'patch.remove_source_ids'),
    remove_media_ids: parseOptionalStringListField(rawPatch['remove_media_ids'], 'patch.remove_media_ids'),
    remove_narrative_ids: parseOptionalStringListField(
      rawPatch['remove_narrative_ids'],
      'patch.remove_narrative_ids'
    ),
    remove_kinship: parseRemoveKinshipEntries(rawPatch['remove_kinship'], 'patch.remove_kinship'),
  };
}
