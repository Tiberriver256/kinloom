import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../errors.js';
import { loadLocalArchiveRepoSync } from '../dataFiles.js';
import { applyAndValidateMultiEntityPatch } from './patch/apply.js';
import {
  applyPatchYamlWritesWithRollback,
  buildPendingPatchYamlWrites,
  formatPatchTextReport,
  renderPatchResult,
  writeFileAtomicUtf8,
} from './patch/io.js';
import { loadRawPatchText, normalizeMultiEntityPatch, parsePatchDocumentText } from './patch/parse.js';
import {
  assertLivingPersonPrivacyInvariants,
  assertPatchedRelationsLivingPrivacy,
  isEffectiveLivingPerson,
} from './patch/privacy.js';
import type {
  NormalizedMultiEntityPatch,
  PatchAllEntityCounts,
  PatchCommandOptions,
  PatchCommandResult,
  PatchEntityCounts,
  PatchValidationSummary,
  PendingPatchYamlWrite,
} from './patch/types.js';

export { PATCH_HELP } from './help.js';
export {
  applyPatchYamlWritesWithRollback,
  assertLivingPersonPrivacyInvariants,
  assertPatchedRelationsLivingPrivacy,
  formatPatchTextReport,
  isEffectiveLivingPerson,
  type NormalizedMultiEntityPatch,
  normalizeMultiEntityPatch,
  type PatchAllEntityCounts,
  type PatchCommandOptions,
  type PatchCommandResult,
  type PatchEntityCounts,
  type PatchValidationSummary,
  type PendingPatchYamlWrite,
  parsePatchDocumentText,
};

export async function runPatchCommand(options: PatchCommandOptions = {}): Promise<PatchCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const dryRun = Boolean(options.dryRun);
  const allowLiving = Boolean(options.allowLiving);
  const writeFileFn = options.writeFileImpl ?? writeFileAtomicUtf8;

  const repoStat = fs.statSync(repoDir, { throwIfNoEntry: false });
  if (!repoStat?.isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }

  const dataDir = path.join(repoDir, 'data');
  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  if (!fs.existsSync(path.join(dataDir, 'people.yaml'))) {
    throw new CliValidationError(
      `Missing ${path.join(dataDir, 'people.yaml')} (pass --repo <archive-root> if running outside the archive root).`
    );
  }
  if (!fs.existsSync(configPath)) {
    throw new CliValidationError(
      `Missing ${configPath} (pass --repo <archive-root> if running outside the archive root).`
    );
  }

  const { rawText, inputSource, formatHint } = await loadRawPatchText(options);
  const rawPatch = parsePatchDocumentText(rawText, formatHint);
  const patch = normalizeMultiEntityPatch(rawPatch);

  const loaded = loadLocalArchiveRepoSync(repoDir, {
    requireConfig: true,
    requirePeopleFile: true,
    includeEnrichments: true,
  });

  const applied = applyAndValidateMultiEntityPatch({
    loaded,
    patch,
    allowLiving,
  });

  const pendingWrites = buildPendingPatchYamlWrites(loaded.dataDir, applied);
  const wouldWriteYamlFiles = pendingWrites
    .map((item) => item.fullPath)
    .toSorted((a, b) => a.localeCompare(b));
  const writtenYamlFiles = dryRun ? [] : applyPatchYamlWritesWithRollback(pendingWrites, writeFileFn);

  return renderPatchResult(
    {
      ok: true,
      dryRun,
      allowLiving,
      repo: repoDir,
      inputSource,
      counts: applied.counts,
      livingPeopleTouched: applied.livingPeopleTouched,
      wouldWriteYamlFiles,
      writtenYamlFiles,
      validation: applied.validation,
    },
    Boolean(options.json)
  );
}
