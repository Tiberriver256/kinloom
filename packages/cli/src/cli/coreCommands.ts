import { type CliExitCode, CliValidationError, EXIT_ERROR, EXIT_OK } from '../errors.js';
import {
  type CliDispatchContext,
  parseOptionalPositiveInt,
  requireStringFlag,
  safeParseArgs,
} from './types.js';

export async function runInit(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values, positionals } = safeParseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      family: { type: 'string' },
      title: { type: 'string' },
      accent: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });
  const targetDir = positionals[0];
  if (!targetDir) {
    throw new CliValidationError('Missing required positional argument `<dir>`.');
  }
  const { runInitCommand } = await import('../commands/init.js');
  const result = await runInitCommand({
    targetDir,
    family: requireStringFlag(values.family, '--family'),
    title: requireStringFlag(values.title, '--title'),
    accent: values.accent,
    force: values.force,
  });
  ctx.io.stdout(
    `Initialized Kinloom archive at ${result.targetDir} (${result.created.length} created, ${result.skipped.length} skipped).`
  );
  return EXIT_OK;
}

export async function runBrandkit(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      config: { type: 'string' },
      out: { type: 'string' },
      title: { type: 'string' },
      subtitle: { type: 'string' },
      metadata: { type: 'string' },
      accent: { type: 'string' },
      surface: { type: 'string' },
      mark: { type: 'string' },
      vignette: { type: 'string' },
      'base-url': { type: 'string' },
      'print-head': { type: 'boolean', default: false },
      'no-force': { type: 'boolean', default: false },
    },
  });
  const surface = values.surface?.trim();
  if (surface && surface !== 'parchment' && surface !== 'navy') {
    throw new CliValidationError("Option `--surface` must be 'parchment' or 'navy'.");
  }
  const { runBrandkitCommand } = await import('../commands/brandkit.js');
  const result = await runBrandkitCommand({
    configPath: values.config,
    outDir: values.out?.trim() || 'public',
    title: values.title,
    subtitle: values.subtitle,
    metadataLine: values.metadata,
    accent: values.accent,
    surface: surface as 'parchment' | 'navy' | undefined,
    markSvgPath: values.mark,
    vignetteImagePath: values.vignette,
    baseUrl: values['base-url'],
    force: !values['no-force'],
    cwd: ctx.cwd,
  });
  const writtenCount = result.files.filter((f) => !f.skipped).length;
  const skippedCount = result.files.length - writtenCount;
  ctx.io.stdout(
    `Generated brandkit in ${result.outDir}: ${writtenCount} written, ${skippedCount} skipped (og-default.png: ${(result.ogBytes / 1024).toFixed(1)} KB).`
  );
  if (values['print-head']) {
    ctx.io.stdout(result.headTags);
  }
  return EXIT_OK;
}

export async function runSliceGedcom(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      input: { type: 'string' },
      out: { type: 'string' },
      root: { type: 'string' },
      surname: { type: 'string', multiple: true },
      branch: { type: 'string' },
      'include-upstream-spouses': { type: 'boolean', default: false },
      'no-ancestor-siblings': { type: 'boolean', default: false },
      'no-descendant-spouses': { type: 'boolean', default: false },
      'no-normalize-maiden': { type: 'boolean', default: false },
      'reference-year': { type: 'string' },
    },
  });
  const { runSliceGedcomCommand } = await import('../commands/sliceGedcom.js');
  const result = await runSliceGedcomCommand({
    inputPath: requireStringFlag(values.input, '--input'),
    outDir: requireStringFlag(values.out, '--out'),
    root: requireStringFlag(values.root, '--root'),
    surnames: values.surname,
    branchId: values.branch,
    includeUpstreamSpouses: values['include-upstream-spouses'],
    includeAncestorSiblings: !values['no-ancestor-siblings'],
    includeDescendantSpouses: !values['no-descendant-spouses'],
    normalizeMaidenNames: !values['no-normalize-maiden'],
    referenceYear: parseOptionalPositiveInt(values['reference-year'], '--reference-year'),
  });
  ctx.io.stdout(
    `Sliced GEDCOM from ${result.rootXref} into ${result.outDir}: ${result.stats.totalPeople} people, ${result.stats.totalEvents} events, ${result.stats.totalPlaces} places, ${result.stats.totalSources} sources, ${result.stats.totalKinshipEdges} kinship edges.`
  );
  if (result.anomalies.length > 0) {
    ctx.io.stderr(`Anomalies (${result.anomalies.length}): ${result.anomalies.join('; ')}`);
  }
  return EXIT_OK;
}

export async function runSeed(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      data: { type: 'string' },
      config: { type: 'string' },
      site: { type: 'string' },
      token: { type: 'string' },
      'batch-id': { type: 'string' },
      summary: { type: 'string' },
      'chunk-size': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const dryRun = Boolean(values['dry-run']);
  const siteUrl = dryRun
    ? values.site?.trim() || 'http://localhost'
    : requireStringFlag(values.site, '--site');

  const { runSeedCommand } = await import('../commands/seed.js');
  const result = await runSeedCommand({
    dataDir: requireStringFlag(values.data, '--data'),
    configPath: requireStringFlag(values.config, '--config'),
    siteUrl,
    token: values.token,
    dryRun,
    batchId: values['batch-id'],
    summary: values.summary,
    chunkSize: parseOptionalPositiveInt(values['chunk-size'], '--chunk-size'),
    fetchImpl: ctx.fetchImpl,
  });

  if (result.dryRun) {
    ctx.io.stdout(
      `Dry-run OK for batch ${result.batchId}: ${result.createdCount} entities ready (precompiled ${result.precompiledCounts.people} people, ${result.precompiledCounts.events} events, ${result.precompiledCounts.places} places).`
    );
  } else if (!result.response) {
    ctx.io.stdout(`Seed up to date (${result.unchangedCount} unchanged, 0 created, 0 updated).`);
  } else {
    ctx.io.stdout(
      `Seeded batch ${result.batchId}: ${result.createdCount} created, ${result.updatedCount} updated, ${result.unchangedCount} unchanged (head r${result.response.head_revision_id}, etag ${result.response.etag}).`
    );
  }
  return EXIT_OK;
}

export async function runSubmitBatch(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values, positionals } = safeParseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      site: { type: 'string' },
      token: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const dryRun = Boolean(values['dry-run']);
  const filePath = values.file ?? positionals[0];
  const siteUrl = dryRun
    ? values.site?.trim() || 'http://localhost'
    : requireStringFlag(values.site, '--site');

  const { runSubmitBatchCommand } = await import('../commands/submitBatch.js');
  const result = await runSubmitBatchCommand({
    filePath: requireStringFlag(filePath, '--file'),
    siteUrl,
    token: values.token,
    dryRun,
    fetchImpl: ctx.fetchImpl,
  });

  if (result.dryRun || !result.response) {
    ctx.io.stdout(`Dry-run OK: batch ${result.batchId} (${result.patchCount} patch(es)) passed validation.`);
    return EXIT_OK;
  }

  const revIds = result.response.revisions.map((r) => r.revision_id);
  const revRange =
    revIds.length === 0
      ? 'none'
      : revIds.length === 1
        ? `r${revIds[0]}`
        : `r${Math.min(...revIds)}..r${Math.max(...revIds)}`;
  ctx.io.stdout(
    `Committed batch ${result.response.batch_id}: ${revIds.length} revision(s) (${revRange}), head r${result.response.head_revision_id}, etag ${result.response.etag}.`
  );
  return EXIT_OK;
}

export async function runExportYaml(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      site: { type: 'string' },
      out: { type: 'string' },
      token: { type: 'string' },
      'state-file': { type: 'string' },
    },
  });
  const { runExportYamlCommand } = await import('../commands/exportYaml.js');
  const result = await runExportYamlCommand({
    siteUrl: requireStringFlag(values.site, '--site'),
    outDir: requireStringFlag(values.out, '--out'),
    token: values.token,
    stateFile: values['state-file'],
    fetchImpl: ctx.fetchImpl,
  });

  if (result.status === 'not_modified') {
    ctx.io.stdout(
      `Not modified (304) at revision ${result.revisionId !== null ? `r${result.revisionId}` : 'unknown'}.`
    );
    return EXIT_OK;
  }

  ctx.io.stdout(
    `Exported ${result.writtenFiles.length} YAML file(s) at r${result.revisionId} via ${result.source} (state: ${result.stateFile}).`
  );
  return EXIT_OK;
}

export async function runUploadMedia(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      file: { type: 'string' },
      metadata: { type: 'string' },
      summary: { type: 'string' },
      site: { type: 'string' },
      token: { type: 'string' },
      mime: { type: 'string' },
      'allow-audio-video': { type: 'boolean', default: false },
      'max-bytes': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const dryRun = Boolean(values['dry-run']);
  const siteUrl = dryRun
    ? values.site?.trim() || 'http://localhost'
    : requireStringFlag(values.site, '--site');

  const { runUploadMediaCommand } = await import('../commands/uploadMedia.js');
  const result = await runUploadMediaCommand({
    filePath: requireStringFlag(values.file, '--file'),
    metadataInput: requireStringFlag(values.metadata, '--metadata'),
    summary: requireStringFlag(values.summary, '--summary'),
    siteUrl,
    token: values.token,
    mimeType: values.mime,
    allowAudioVideo: values['allow-audio-video'],
    maxUploadBytes: parseOptionalPositiveInt(values['max-bytes'], '--max-bytes'),
    dryRun,
    fetchImpl: ctx.fetchImpl,
  });

  if (result.dryRun || !result.response) {
    ctx.io.stdout(
      `Dry-run OK: ${result.fileName} (${result.mimeType}, ${result.sizeBytes} bytes) passed media guards.`
    );
    return EXIT_OK;
  }

  ctx.io.stdout(
    `Uploaded ${result.response.media.id} -> ${result.response.url} (r${result.response.revision.revision_id}, etag ${result.response.etag}).`
  );
  return EXIT_OK;
}

export async function runReconcile(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      site: { type: 'string' },
      config: { type: 'string' },
      token: { type: 'string' },
      mode: { type: 'string' },
    },
  });

  let mode: 'private' | 'public' | undefined;
  if (values.mode !== undefined) {
    if (values.mode !== 'private' && values.mode !== 'public') {
      throw new CliValidationError(`Invalid \`--mode\` '${values.mode}'. Expected 'private' or 'public'.`);
    }
    mode = values.mode;
  }

  const { runReconcileCommand } = await import('../commands/reconcile.js');
  const result = await runReconcileCommand({
    siteUrl: requireStringFlag(values.site, '--site'),
    configPath: requireStringFlag(values.config, '--config'),
    token: values.token,
    mode,
    fetchImpl: ctx.fetchImpl,
  });

  if (result.inSync) {
    ctx.io.stdout(
      `Reconcile OK: cached bundle matches full compileArchive at r${result.headRevisionId} (${result.mode} mode).`
    );
    return EXIT_OK;
  }

  ctx.io.stderr(
    `Reconcile DRIFT detected (head r${result.headRevisionId}, cached ${result.cachedRevisionId !== null ? `r${result.cachedRevisionId}` : 'none'}): ${result.drifts.length} difference(s).`
  );
  for (const drift of result.drifts.slice(0, 20)) {
    ctx.io.stderr(
      `  [${drift.kind}] ${drift.path}: cached=${JSON.stringify(drift.before)} recompiled=${JSON.stringify(drift.after)}`
    );
  }
  return EXIT_ERROR;
}
