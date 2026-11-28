import { performance } from 'node:perf_hooks';
import { validateNarrativeCitations } from '@kinloom/core';
import {
  discoverSiteCliPlugins,
  type ExecutedPluginCheckResult,
  type KinloomVerifyCheckContext,
  resolvePluginCommands,
  runRegisteredCheck,
} from '../../plugins.js';
import { createPronunciationVerifyCheck } from './pronunciation-checks.js';
import {
  analyzeTreeHygiene,
  diffTreeHygieneWarnings,
  formatAuditHygieneWarningMessage,
  TREE_HYGIENE_CATEGORIES,
  type TreeHygieneCategory,
  type TreeHygieneSummary,
  type TreeHygieneWarning,
} from './tree-hygiene.js';
import {
  findDuplicateResidenceSpans,
  runDualCompileCheck,
  runDualCompileCheckWithArtifacts,
  scanPublicLivingNames,
  scanYamlFilesForSsns,
  validatePlaceCoordinates,
} from './verify/checks.js';
import { loadVerifyArchive } from './verify/loader.js';
import { findDuplicateNormalizedMediaFiles, verifyMediaFilesOnDisk } from './verify/mediaCheck.js';
import { collectVerifyDiagnostics, formatVerifyTextReport } from './verify/report.js';
import type { VerifyCitationsResult, VerifyCommandOptions, VerifyCommandResult } from './verify/types.js';

export { VERIFY_HELP } from './help.js';
export type {
  VerifyCitationsResult,
  VerifyCommandOptions,
  VerifyCommandResult,
  VerifyCompileResult,
  VerifyDuplicateMediaFile,
  VerifyInvalidPlace,
  VerifyLivingNamesResult,
  VerifyMediaResult,
  VerifyMissingMediaFile,
  VerifyPlacesResult,
  VerifySsnHit,
  VerifySsnResult,
} from './verify/types.js';
export {
  analyzeTreeHygiene,
  diffTreeHygieneWarnings,
  findDuplicateNormalizedMediaFiles,
  findDuplicateResidenceSpans,
  formatAuditHygieneWarningMessage,
  formatVerifyTextReport,
  runDualCompileCheck,
  scanPublicLivingNames,
  scanYamlFilesForSsns,
  TREE_HYGIENE_CATEGORIES,
  type TreeHygieneCategory,
  type TreeHygieneSummary,
  type TreeHygieneWarning,
  validatePlaceCoordinates,
  verifyMediaFilesOnDisk,
};

export async function runVerifyCommand(options: VerifyCommandOptions = {}): Promise<VerifyCommandResult> {
  const t0 = performance.now();
  const archive = await loadVerifyArchive(options.repoDir);
  const { repoDir, dataDir, siteConfig, people, events, places, sources, kinship, media, narratives } =
    archive;

  // 1. Validate narrative inline citations against known source and media IDs.
  const sourceIds = new Set<string>();
  for (const src of sources) {
    sourceIds.add(src.id);
  }
  const mediaIds = new Set<string>();
  for (const item of media) {
    mediaIds.add(item.id);
  }
  const citationErrors = validateNarrativeCitations(narratives, sourceIds, mediaIds);
  const citations: VerifyCitationsResult = {
    ok: citationErrors.length === 0,
    narrativesChecked: narratives.length,
    errors: citationErrors,
  };

  // 2. Validate place coordinates.
  const placesCheck = validatePlaceCoordinates(places);

  // 3. Scan every data/*.yaml file for SSN patterns.
  const ssnCheck = scanYamlFilesForSsns(archive.yamlTexts);

  // 4. Run dual-mode compilation (private and public) via @kinloom/core.
  //    Input entities were just schema-validated by loadVerifyArchive and placesCheck validates coordinate bounds.
  const {
    result: compileCheck,
    publicNarratives,
    publicMedia,
  } = runDualCompileCheckWithArtifacts(archive, {
    skipBundleRevalidation: placesCheck.ok,
  });

  // 5. Verify every media.yaml file path exists on disk under archive-media/ or media/.
  const mediaCheck = verifyMediaFilesOnDisk(repoDir, media);

  // 6. Living names on text that public export keeps (reusing already-scrubbed public narratives and media).
  const livingNames = scanPublicLivingNames({
    people,
    events,
    sources,
    media,
    narratives,
    privacy: siteConfig.privacy,
    precomputedPublicNarratives: publicNarratives,
    precomputedPublicMedia: publicMedia ?? [],
  });

  // 7. Non-breaking tree-hygiene diagnostics (fail only when --strict-hygiene is enabled).
  const strictHygiene = Boolean(options.strictHygiene);
  const strictPronunciation = Boolean(options.strictPronunciation);
  const hygiene = analyzeTreeHygiene({ people, events, kinship });

  // 8. Built-in pronunciation check + site plugin verifyChecks.
  const verifyCheckCtx: KinloomVerifyCheckContext = {
    repoDir,
    dataDir,
    siteConfig,
    people,
    events,
    places,
    sources,
    kinship,
    media,
    narratives,
    strictHygiene,
    strictPronunciation,
  };
  const pronunciationCheck = await runRegisteredCheck(
    'builtin',
    createPronunciationVerifyCheck(),
    verifyCheckCtx
  );

  let pluginDiscoveryWarnings: string[] = [];
  let resolvedPluginVerifyChecks = resolvePluginCommands(options.plugins ?? []);
  if (options.plugins === undefined) {
    const discovered = await discoverSiteCliPlugins(repoDir);
    resolvedPluginVerifyChecks = resolvePluginCommands(discovered.plugins);
    pluginDiscoveryWarnings = discovered.warnings;
  }
  const pluginChecks: ExecutedPluginCheckResult[] = [];
  for (const reg of resolvedPluginVerifyChecks.verifyChecks) {
    pluginChecks.push(await runRegisteredCheck(reg.pluginId, reg.check, verifyCheckCtx));
  }

  const { warnings, errors } = collectVerifyDiagnostics({
    citations,
    places: placesCheck,
    ssn: ssnCheck,
    compile: compileCheck,
    media: mediaCheck,
    livingNames,
    hygiene,
    pronunciation: pronunciationCheck,
    pluginDiscoveryWarnings,
    pluginChecks,
    strictHygiene,
    strictPronunciation,
  });

  const durationMs = Math.round(performance.now() - t0);
  const baseReport: Omit<VerifyCommandResult, 'rendered'> = {
    ok: errors.length === 0,
    repo: repoDir,
    duration_ms: durationMs,
    strictHygiene,
    strictPronunciation,
    checks: {
      citations,
      places: placesCheck,
      ssn: ssnCheck,
      compile: compileCheck,
      media: mediaCheck,
      livingNames,
      pronunciation: pronunciationCheck,
    },
    pluginChecks,
    hygiene,
    warnings,
    errors,
  };

  const rendered = options.json
    ? `${JSON.stringify(baseReport, null, 2)}\n`
    : formatVerifyTextReport(baseReport);

  return {
    ...baseReport,
    rendered,
  };
}
