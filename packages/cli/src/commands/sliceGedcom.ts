import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { type SliceGedcomOptions, type SliceGedcomResult, sliceGedcom } from '@kinloom/core';
import { CliValidationError } from '../errors.js';
import { writeArchiveDataDir } from './dataFiles.js';

export interface SliceGedcomCommandOptions {
  inputPath: string;
  outDir: string;
  root: string;
  surnames?: readonly string[];
  includeUpstreamSpouses?: boolean;
  includeAncestorSiblings?: boolean;
  includeDescendantSpouses?: boolean;
  normalizeMaidenNames?: boolean;
  branchId?: string;
  referenceYear?: number;
}

export interface SliceGedcomCommandResult {
  rootXref: string;
  outDir: string;
  stats: SliceGedcomResult['stats'];
  anomalies: string[];
  writtenFiles: string[];
}

function isGedcomXref(value: string): boolean {
  return /^@[^@\s]+@$/.test(value);
}

export async function runSliceGedcomCommand(
  options: SliceGedcomCommandOptions
): Promise<SliceGedcomCommandResult> {
  const inputPath = options.inputPath.trim();
  const outDir = options.outDir.trim();
  const root = options.root.trim();

  if (!inputPath) {
    throw new CliValidationError('`--input` GEDCOM file path is required.');
  }
  if (!outDir) {
    throw new CliValidationError('`--out` data directory path is required.');
  }
  if (!root) {
    throw new CliValidationError('`--root` person xref (e.g. @I1@) or full name is required.');
  }

  const gedcomText = await readFile(inputPath, 'utf8');

  const ancestorSurnames = (options.surnames ?? [])
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);

  const sliceOptions: SliceGedcomOptions = {
    ...(isGedcomXref(root) ? { rootXref: root } : { rootName: root }),
    ...(ancestorSurnames.length > 0 ? { ancestorSurnames } : {}),
    expandSpouseAncestors: options.includeUpstreamSpouses ?? false,
    includeAncestorSiblings: options.includeAncestorSiblings ?? true,
    includeDescendantSpouses: options.includeDescendantSpouses ?? true,
    normalizeMaidenNames: options.normalizeMaidenNames ?? true,
    ...(options.branchId ? { branchId: options.branchId } : {}),
    ...(options.referenceYear !== undefined ? { referenceYear: options.referenceYear } : {}),
  };

  let result: SliceGedcomResult;
  try {
    result = sliceGedcom(gedcomText, sliceOptions);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(message);
  }

  const resolvedOut = path.resolve(outDir);
  const writtenFiles = await writeArchiveDataDir(resolvedOut, {
    people: result.people,
    events: result.events,
    places: result.places,
    sources: result.sources,
    kinship: result.kinship,
    media: [],
    narratives: [],
  });

  return {
    rootXref: result.rootXref,
    outDir: resolvedOut,
    stats: result.stats,
    anomalies: result.anomalies,
    writtenFiles,
  };
}
