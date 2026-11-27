import { type CliExitCode, CliValidationError, EXIT_ERROR, EXIT_OK } from '../errors.js';
import {
  type CliDispatchContext,
  parseOptionalPositiveInt,
  safeParseArgs,
  writeRenderedOutput,
} from './types.js';

export async function runPronounce(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const sub = rest[0];
  if (sub !== 'lookup' && sub !== 'audit' && sub !== 'deduplicate' && sub !== 'synth') {
    throw new CliValidationError(
      sub
        ? `Unknown pronounce subcommand '${sub}'. Expected \`lookup\`, \`audit\`, \`deduplicate\`, or \`synth\`.`
        : 'Missing pronounce subcommand. Expected `lookup`, `audit`, `deduplicate`, or `synth`.'
    );
  }
  const subArgs = rest.slice(1);
  const [
    {
      runPronounceAuditCommand,
      runPronounceDeduplicateCommand,
      runPronounceLookupCommand,
      runPronounceSynthCommand,
    },
    { measureCommand },
  ] = await Promise.all([import('../commands/ops/pronounce.js'), import('../commands/ops/telemetry.js')]);

  if (sub === 'synth') {
    const { values } = safeParseArgs({
      args: subArgs,
      allowPositionals: false,
      options: {
        repo: { type: 'string' },
        backend: { type: 'string' },
        endpoint: { type: 'string' },
        'api-key': { type: 'string' },
        model: { type: 'string' },
        voice: { type: 'string' },
        'phoneme-mode': { type: 'string' },
        'ref-audio': { type: 'string' },
        'ref-text': { type: 'string' },
        'out-dir': { type: 'string' },
        format: { type: 'string' },
        scope: { type: 'string' },
        'skip-existing': { type: 'boolean', default: true },
        force: { type: 'boolean', default: false },
        'update-config': { type: 'boolean', default: false },
        'export-manifest': { type: 'string' },
        'import-dir': { type: 'string' },
        concurrency: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
    });
    const rawBackend = values.backend?.trim().toLowerCase();
    if (rawBackend !== undefined && rawBackend !== 'gemini' && rawBackend !== 'openai-speech') {
      throw new CliValidationError(
        `Invalid --backend '${values.backend}': choose from gemini, openai-speech.`
      );
    }
    const rawFormat = values.format?.trim().toLowerCase();
    if (rawFormat !== undefined && rawFormat !== 'wav' && rawFormat !== 'mp3') {
      throw new CliValidationError(`Invalid --format '${values.format}': choose from wav, mp3.`);
    }
    const rawScope = values.scope?.trim().toLowerCase();
    if (rawScope !== undefined && rawScope !== 'lexicon' && rawScope !== 'curated' && rawScope !== 'all') {
      throw new CliValidationError(`Invalid --scope '${values.scope}': choose from lexicon, curated, all.`);
    }
    const rawPhoneme = values['phoneme-mode']?.trim().toLowerCase();
    if (
      rawPhoneme !== undefined &&
      rawPhoneme !== 'ipa' &&
      rawPhoneme !== 'arpabet' &&
      rawPhoneme !== 'plain'
    ) {
      throw new CliValidationError(
        `Invalid --phoneme-mode '${values['phoneme-mode']}': choose from ipa, arpabet, plain.`
      );
    }
    const result = await measureCommand(
      {
        subcmd: values['dry-run'] ? 'pronounce synth --dry-run' : 'pronounce synth',
        extractResultMeta: (res) => ({
          exitCode: EXIT_OK,
          bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
        }),
      },
      () =>
        runPronounceSynthCommand({
          repoDir: values.repo ?? ctx.cwd,
          backend: rawBackend,
          endpoint: values.endpoint,
          apiKey: values['api-key'],
          model: values.model,
          voice: values.voice,
          phonemeMode: rawPhoneme,
          refAudioPath: values['ref-audio'],
          refText: values['ref-text'],
          outDir: values['out-dir'],
          format: rawFormat,
          scope: rawScope,
          skipExisting: values['skip-existing'],
          force: values.force,
          updateConfig: values['update-config'],
          exportManifestPath: values['export-manifest'],
          importDir: values['import-dir'],
          concurrency: parseOptionalPositiveInt(values.concurrency, '--concurrency'),
          dryRun: values['dry-run'],
          json: values.json,
          fetchImpl: ctx.fetchImpl,
        })
    );
    writeRenderedOutput(ctx.io, result.rendered);
    return EXIT_OK;
  }

  if (sub === 'lookup') {
    const { values, positionals } = safeParseArgs({
      args: subArgs,
      allowPositionals: true,
      options: {
        lang: { type: 'string' },
        refresh: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
    });
    const term = positionals.join(' ').trim();
    if (!term) {
      throw new CliValidationError(
        'Usage: kinloom pronounce lookup <term> [--lang nl|sv|fi|pl|de|en] [--refresh] [--json]'
      );
    }
    const result = await measureCommand(
      {
        subcmd: 'pronounce lookup',
        extractResultMeta: (res) => ({
          exitCode: EXIT_OK,
          cacheHit: res.cache_hit,
          bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
        }),
      },
      () =>
        runPronounceLookupCommand({
          term,
          lang: values.lang,
          refresh: values.refresh,
          json: values.json,
          fetchImpl: ctx.fetchImpl,
        })
    );
    writeRenderedOutput(ctx.io, result.rendered);
    return EXIT_OK;
  }

  if (sub === 'deduplicate') {
    const { values } = safeParseArgs({
      args: subArgs,
      allowPositionals: false,
      options: {
        repo: { type: 'string' },
        apply: { type: 'boolean', default: false },
        'promote-tokens': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
    });
    const result = await measureCommand(
      {
        subcmd: 'pronounce deduplicate',
        extractResultMeta: (res) => ({
          exitCode: EXIT_OK,
          bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
        }),
      },
      async () =>
        runPronounceDeduplicateCommand({
          repoDir: values.repo ?? ctx.cwd,
          apply: values.apply,
          promoteTokens: values['promote-tokens'],
          force: values.force,
          json: values.json,
        })
    );
    writeRenderedOutput(ctx.io, result.rendered);
    return EXIT_OK;
  }

  const { values } = safeParseArgs({
    args: subArgs,
    allowPositionals: false,
    options: {
      repo: { type: 'string' },
      strict: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const result = await measureCommand(
    {
      subcmd: 'pronounce audit',
      extractResultMeta: (res) => ({
        exitCode: res.ok ? EXIT_OK : EXIT_ERROR,
        bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
      }),
    },
    async () =>
      runPronounceAuditCommand({
        repoDir: values.repo ?? ctx.cwd,
        strict: values.strict,
        json: values.json,
      })
  );
  writeRenderedOutput(ctx.io, result.rendered);
  return result.ok ? EXIT_OK : EXIT_ERROR;
}
