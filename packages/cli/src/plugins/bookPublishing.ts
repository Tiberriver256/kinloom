import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compileArchive } from '@kinloom/core';
import {
  BookBindingStyleSchema,
  BookEditionSchema,
  BookPaperStockSchema,
  type BookPhysicalSpec,
  BookPrivacyError,
  type BookPublisherEnvironment,
  type BookPublisherProvider,
  BookPublisherProviderIdSchema,
  type BookShippingAddress,
  BookShippingAddressSchema,
  BookShippingLevelSchema,
  BookTrimPresetIdSchema,
  compileArchivalBook,
  createDeterministicPdfRenderer,
  createLuluBookPublisherAdapter,
  createMockBookPublisherAdapter,
  inspectPdfPrepress,
  normalizeBookPageCount,
  type PdfRendererPort,
} from '@kinloom/server';
import { parseOptionalPositiveInt, safeParseArgs } from '../cli/types.js';
import { loadLocalArchiveRepo } from '../commands/dataFiles.js';
import { type CliExitCode, CliValidationError, EXIT_ERROR, EXIT_OK } from '../errors.js';
import type { KinloomCliCommand, KinloomCliPlugin, KinloomCliPluginContext } from '../pluginTypes.js';
import { createPlaywrightPdfRenderer, type PlaywrightPdfBrowserFactory } from './bookPublishingPdf.js';

export const BOOK_PUBLISHING_CLI_PLUGIN_ID = 'kinloom-book-publishing-cli';
export const BOOK_PUBLISHING_COMMAND_NAME = 'book';

export const BOOK_PUBLISHING_HELP = `Usage: kinloom book <subcommand> [options]

Compile archival landscape hardcover interior & cover PDFs (with mandatory living-person redaction)
and quote, validate, submit, or track print-on-demand hardcover jobs.

Subcommands:
  build   Compile local archive YAML into landscape interior.pdf, cover.pdf, HTML, and prepress-report.json
  quote   Estimate hardcover manufacturing, shipping, and tax costs via Lulu Print API or mock sandbox
  submit  Validate local interior/cover PDFs and submit a dry-run, sandbox, or confirmed production print job
  status  Fetch live status and carrier tracking links for a print job

Examples:
  kinloom book build --out ./dist-book --trim us-letter-landscape --binding hardcover-casewrap-glossy
  kinloom book quote --pages 120 --qty 2 --country US --postal 62701 --provider mock
  kinloom book submit --dir ./dist-book --address-file ./shipping.json --dry-run
  kinloom book status --job-id mock-job-1 --provider mock`;

export interface BookPublishingCliPluginOptions {
  /**
   * When false, returns an inert no-op CLI plugin with zero commands.
   * Defaults to true when the factory is explicitly invoked.
   */
  readonly enabled?: boolean;
  /** Optional injected PDF renderer (defaults to pure-TS deterministic PDF engine). */
  readonly pdfRenderer?: PdfRendererPort;
  /** Optional injected Playwright browser factory used when `--renderer playwright` is selected. */
  readonly playwrightBrowserFactory?: PlaywrightPdfBrowserFactory;
  /** Optional injected publisher provider override for hermetic tests. */
  readonly publisherProvider?: BookPublisherProvider;
  /** Optional environment variable map override (defaults to process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Optional deterministic ISO timestamp for reproducible builds. */
  readonly nowIso?: () => string;
}

function resolveCliPublisher(params: {
  readonly providerName: string;
  readonly environment: BookPublisherEnvironment;
  readonly pluginOptions: BookPublishingCliPluginOptions;
  readonly fetchImpl?: typeof fetch;
}): BookPublisherProvider {
  if (params.pluginOptions.publisherProvider) {
    return params.pluginOptions.publisherProvider;
  }
  const parsed = BookPublisherProviderIdSchema.safeParse(params.providerName);
  if (!parsed.success) {
    throw new CliValidationError(`Invalid --provider '${params.providerName}'. Expected 'mock' or 'lulu'.`);
  }
  if (parsed.data === 'mock') {
    return createMockBookPublisherAdapter({ nowIso: params.pluginOptions.nowIso });
  }
  const env = params.pluginOptions.env ?? process.env;
  const clientId = env.KINLOOM_LULU_CLIENT_ID?.trim() || env.KINLOOM_LULU_CLIENT_KEY?.trim() || '';
  const clientSecret = env.KINLOOM_LULU_CLIENT_SECRET?.trim() || '';
  if (!clientId || !clientSecret) {
    throw new CliValidationError(
      'Lulu Print API requires KINLOOM_LULU_CLIENT_ID (or KINLOOM_LULU_CLIENT_KEY) and KINLOOM_LULU_CLIENT_SECRET environment variables.'
    );
  }
  return createLuluBookPublisherAdapter({
    environment: params.environment,
    clientId,
    clientSecret,
    webhookSecret: env.KINLOOM_LULU_WEBHOOK_SECRET?.trim() || undefined,
    fetchImpl: params.fetchImpl,
  });
}

async function runBookBuildSubcommand(
  args: readonly string[],
  ctx: KinloomCliPluginContext,
  pluginOptions: BookPublishingCliPluginOptions
): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args,
    allowPositionals: false,
    options: {
      repo: { type: 'string' },
      data: { type: 'string' },
      out: { type: 'string' },
      title: { type: 'string' },
      subtitle: { type: 'string' },
      dedication: { type: 'string' },
      trim: { type: 'string', default: 'us-letter-landscape' },
      binding: { type: 'string', default: 'hardcover-casewrap-glossy' },
      paper: { type: 'string', default: '80lb-coated-white-color' },
      edition: { type: 'string', default: 'public' },
      'include-living': { type: 'boolean', default: false },
      'allow-living-portraits': { type: 'boolean', default: false },
      'acknowledge-review-flags': { type: 'boolean', default: false },
      branch: { type: 'string' },
      'root-person': { type: 'string' },
      renderer: { type: 'string', default: 'deterministic' },
      'proof-marks': { type: 'boolean', default: false },
      'strict-prepress': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  const trimParsed = BookTrimPresetIdSchema.safeParse(values.trim);
  if (!trimParsed.success) {
    throw new CliValidationError(`Invalid --trim '${values.trim}'.`);
  }
  const bindingParsed = BookBindingStyleSchema.safeParse(values.binding);
  if (!bindingParsed.success) {
    throw new CliValidationError(`Invalid --binding '${values.binding}'.`);
  }
  const paperParsed = BookPaperStockSchema.safeParse(values.paper);
  if (!paperParsed.success) {
    throw new CliValidationError(`Invalid --paper '${values.paper}'.`);
  }
  const editionParsed = BookEditionSchema.safeParse(values.edition);
  if (!editionParsed.success) {
    throw new CliValidationError(`Invalid --edition '${values.edition}'. Expected 'public' or 'private'.`);
  }

  const repoDir = path.resolve(ctx.cwd, values.repo?.trim() || '.');
  const dataDirOverride = values.data?.trim() ? path.resolve(ctx.cwd, values.data.trim()) : undefined;
  const outDir = path.resolve(ctx.cwd, values.out?.trim() || 'dist-book');

  const loaded = await loadLocalArchiveRepo(repoDir, {
    dataDirOverride,
    requireConfig: true,
    requirePeopleFile: true,
  });
  if (!loaded.siteConfig) {
    throw new CliValidationError(`Missing kinloom.config.yaml in ${repoDir}.`);
  }

  const nowIso = pluginOptions.nowIso ? pluginOptions.nowIso() : new Date().toISOString();
  const parsedYear = Number.parseInt(nowIso.slice(0, 4), 10);
  const referenceYear =
    loaded.siteConfig.privacy.referenceYear ??
    (Number.isInteger(parsedYear) && parsedYear >= 1900 ? parsedYear : 2026);

  const { bundle } = compileArchive({
    people: loaded.people,
    events: loaded.events,
    places: loaded.places,
    sources: loaded.sources,
    kinship: loaded.kinship,
    media: loaded.media,
    narratives: loaded.narratives,
    siteConfig: loaded.siteConfig,
    mode: 'private',
    generatedAt: nowIso,
    referenceYear,
  });

  // Preserve raw media list on the bundle so the book privacy gate always evaluates and reports living media stripping.
  const bundleForBook = { ...bundle, media: loaded.media };

  let compiled: ReturnType<typeof compileArchivalBook>;
  try {
    compiled = compileArchivalBook({
      bundle: bundleForBook,
      siteConfig: loaded.siteConfig,
      options: {
        title: values.title,
        subtitle: values.subtitle,
        dedication: values.dedication,
        trimPreset: trimParsed.data,
        binding: bindingParsed.data,
        paperStock: paperParsed.data,
        edition: editionParsed.data,
        includeLiving: Boolean(values['include-living']),
        allowLivingPortraits: Boolean(values['allow-living-portraits']),
        acknowledgeReviewFlags: Boolean(values['acknowledge-review-flags']),
        branchId: values.branch,
        rootPersonId: values['root-person'],
        proofMarks: Boolean(values['proof-marks']),
        generatedAtIso: nowIso,
        referenceYear,
      },
    });
  } catch (err) {
    if (err instanceof BookPrivacyError) {
      throw new CliValidationError(err.message, [...err.reviewFlags]);
    }
    throw err;
  }

  if (values['strict-prepress'] && compiled.report.warnings.some((w) => w.code === 'low_resolution_image')) {
    throw new CliValidationError(
      'Strict prepress check failed due to low-resolution (< 200 DPI) images.',
      compiled.report.warnings.filter((w) => w.code === 'low_resolution_image').map((w) => w.message)
    );
  }

  let pdfRenderer: PdfRendererPort;
  if (pluginOptions.pdfRenderer) {
    pdfRenderer = pluginOptions.pdfRenderer;
  } else if (values.renderer === 'playwright') {
    pdfRenderer = createPlaywrightPdfRenderer({
      browserFactory: pluginOptions.playwrightBrowserFactory,
    });
  } else if (values.renderer === 'deterministic') {
    pdfRenderer = createDeterministicPdfRenderer();
  } else {
    throw new CliValidationError(
      `Invalid --renderer '${values.renderer}'. Expected 'deterministic' or 'playwright'.`
    );
  }

  const [interiorPdf, coverPdf] = await Promise.all([
    pdfRenderer.renderInterior(compiled),
    pdfRenderer.renderCover(compiled, compiled.report.coverDimensions),
  ]);

  const interiorCheck = inspectPdfPrepress(interiorPdf);
  const coverCheck = inspectPdfPrepress(coverPdf);

  await mkdir(outDir, { recursive: true });
  const interiorPdfPath = path.join(outDir, 'interior.pdf');
  const coverPdfPath = path.join(outDir, 'cover.pdf');
  const interiorHtmlPath = path.join(outDir, 'interior.html');
  const coverHtmlPath = path.join(outDir, 'cover.html');
  const reportPath = path.join(outDir, 'prepress-report.json');

  await Promise.all([
    writeFile(interiorPdfPath, interiorPdf),
    writeFile(coverPdfPath, coverPdf),
    writeFile(interiorHtmlPath, compiled.interiorHtml, 'utf8'),
    writeFile(coverHtmlPath, compiled.coverHtml, 'utf8'),
    writeFile(reportPath, `${JSON.stringify(compiled.report, null, 2)}\n`, 'utf8'),
  ]);

  const summary = {
    outDir,
    renderer: pdfRenderer.adapterKind,
    report: compiled.report,
    files: {
      interiorPdf: interiorPdfPath,
      coverPdf: coverPdfPath,
      interiorHtml: interiorHtmlPath,
      coverHtml: coverHtmlPath,
      prepressReport: reportPath,
    },
    pdfVerification: {
      interiorValid: interiorCheck.validHeader && interiorCheck.validEof,
      interiorPages: interiorCheck.pageCount,
      interiorBytes: interiorCheck.byteLength,
      coverValid: coverCheck.validHeader && coverCheck.validEof,
      coverBytes: coverCheck.byteLength,
    },
  };

  if (values.json) {
    ctx.io.stdout(JSON.stringify(summary, null, 2));
  } else {
    ctx.io.stdout(
      [
        `Built archival landscape book: ${compiled.report.title} (${compiled.report.edition} edition)`,
        `  Pages: ${compiled.report.counts.finalPageCount} (${compiled.report.counts.paddingPages} padding), Spine: ${compiled.report.coverDimensions.spineWidthIn} in`,
        `  Cover: ${compiled.report.coverDimensions.totalWidthIn} x ${compiled.report.coverDimensions.totalHeightIn} in (${compiled.report.coverDimensions.providerSku})`,
        `  Privacy: ${compiled.report.counts.includedPeople} included, ${compiled.report.counts.excludedLivingPeople} living excluded`,
        `  Output: ${outDir}`,
      ].join('\n')
    );
  }
  return EXIT_OK;
}

async function runBookQuoteSubcommand(
  args: readonly string[],
  ctx: KinloomCliPluginContext,
  pluginOptions: BookPublishingCliPluginOptions
): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args,
    allowPositionals: false,
    options: {
      pages: { type: 'string' },
      qty: { type: 'string', default: '1' },
      trim: { type: 'string', default: 'us-letter-landscape' },
      binding: { type: 'string', default: 'hardcover-casewrap-glossy' },
      paper: { type: 'string', default: '80lb-coated-white-color' },
      shipping: { type: 'string', default: 'ground' },
      name: { type: 'string', default: 'Archive Steward' },
      street: { type: 'string', default: '100 Main St' },
      city: { type: 'string', default: 'Springfield' },
      state: { type: 'string' },
      country: { type: 'string', default: 'US' },
      postal: { type: 'string' },
      phone: { type: 'string', default: '+15555550100' },
      provider: { type: 'string', default: 'mock' },
      sandbox: { type: 'boolean', default: false },
      production: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  const rawPages = parseOptionalPositiveInt(values.pages, '--pages');
  if (!rawPages) {
    throw new CliValidationError('Missing required --pages <n> option.');
  }
  if (!values.postal?.trim()) {
    throw new CliValidationError('Missing required --postal <code> option.');
  }

  const quantity = parseOptionalPositiveInt(values.qty, '--qty') ?? 1;
  const trim = BookTrimPresetIdSchema.parse(values.trim);
  const binding = BookBindingStyleSchema.parse(values.binding);
  const paperStock = BookPaperStockSchema.parse(values.paper);
  const shippingLevel = BookShippingLevelSchema.parse(values.shipping);
  const address: BookShippingAddress = BookShippingAddressSchema.parse({
    name: values.name,
    street1: values.street,
    city: values.city,
    stateCode: values.state,
    countryCode: values.country,
    postalCode: values.postal,
    phoneNumber: values.phone,
  });

  const normalized = normalizeBookPageCount(rawPages);
  const spec: BookPhysicalSpec = {
    trimPreset: trim,
    binding,
    paperStock,
    interiorPageCount: normalized.finalPages,
  };
  const environment: BookPublisherEnvironment = values.production ? 'production' : 'sandbox';
  const provider = resolveCliPublisher({
    providerName: values.provider ?? 'mock',
    environment,
    pluginOptions,
    fetchImpl: ctx.fetchImpl,
  });

  const [coverDimensions, quote] = await Promise.all([
    provider.getCoverDimensions(spec),
    provider.estimateCost({
      spec,
      quantity,
      shippingAddress: address,
      shippingLevel,
    }),
  ]);

  if (values.json) {
    ctx.io.stdout(JSON.stringify({ quote, coverDimensions }, null, 2));
  } else {
    ctx.io.stdout(
      [
        `Quote from ${provider.displayName} (${quote.providerSku}):`,
        `  Manufacturing: $${(quote.manufacturingCostCents / 100).toFixed(2)}`,
        `  Shipping (${shippingLevel}): $${(quote.shippingCostCents / 100).toFixed(2)}`,
        `  Fulfillment: $${(quote.fulfillmentFeeCents / 100).toFixed(2)}`,
        `  Tax: $${(quote.taxCents / 100).toFixed(2)}`,
        `  Total: $${(quote.totalCostCents / 100).toFixed(2)} ${quote.currency}`,
      ].join('\n')
    );
  }
  return EXIT_OK;
}

async function runBookSubmitSubcommand(
  args: readonly string[],
  ctx: KinloomCliPluginContext,
  pluginOptions: BookPublishingCliPluginOptions
): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args,
    allowPositionals: false,
    options: {
      dir: { type: 'string', default: 'dist-book' },
      'address-file': { type: 'string' },
      title: { type: 'string' },
      email: { type: 'string', default: 'steward@archive.example' },
      qty: { type: 'string', default: '1' },
      shipping: { type: 'string', default: 'ground' },
      provider: { type: 'string', default: 'mock' },
      'interior-url': { type: 'string' },
      'cover-url': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      sandbox: { type: 'boolean', default: false },
      production: { type: 'boolean', default: false },
      'confirm-production': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  if (!values['address-file']?.trim()) {
    throw new CliValidationError('Missing required --address-file <path-to-json> option.');
  }

  const outDir = path.resolve(ctx.cwd, values.dir?.trim() || 'dist-book');
  const addressFilePath = path.resolve(ctx.cwd, values['address-file'].trim());
  const [reportRaw, addressRaw, interiorBytes, coverBytes] = await Promise.all([
    readFile(path.join(outDir, 'prepress-report.json'), 'utf8'),
    readFile(addressFilePath, 'utf8'),
    readFile(path.join(outDir, 'interior.pdf')),
    readFile(path.join(outDir, 'cover.pdf')),
  ]);

  const report = JSON.parse(reportRaw) as {
    title: string;
    edition: string;
    spec: BookPhysicalSpec;
    counts: { finalPageCount: number; excludedLivingPeople: number };
  };
  const shippingAddress = BookShippingAddressSchema.parse(JSON.parse(addressRaw));
  const shippingLevel = BookShippingLevelSchema.parse(values.shipping);
  const quantity = parseOptionalPositiveInt(values.qty, '--qty') ?? 1;

  const interiorCheck = inspectPdfPrepress(new Uint8Array(interiorBytes));
  const coverCheck = inspectPdfPrepress(new Uint8Array(coverBytes));
  if (
    !interiorCheck.validHeader ||
    !interiorCheck.validEof ||
    !coverCheck.validHeader ||
    !coverCheck.validEof
  ) {
    throw new CliValidationError('Local interior.pdf or cover.pdf failed PDF integrity inspection.');
  }

  const environment: BookPublisherEnvironment = values.production ? 'production' : 'sandbox';
  if (environment === 'production' && !values['dry-run'] && !values['confirm-production']) {
    throw new CliValidationError(
      'Production print submission requires --confirm-production to prevent accidental paid print orders.'
    );
  }

  const isDryRun = Boolean(values['dry-run']);
  const provider = resolveCliPublisher({
    providerName: isDryRun ? 'mock' : (values.provider ?? 'mock'),
    environment,
    pluginOptions,
    fetchImpl: ctx.fetchImpl,
  });

  const quote = await provider.estimateCost({
    spec: report.spec,
    quantity,
    shippingAddress,
    shippingLevel,
  });

  if (isDryRun) {
    const dryPayload = {
      dryRun: true,
      providerId: provider.id,
      title: values.title?.trim() || report.title,
      edition: report.edition,
      spec: report.spec,
      quantity,
      quote,
      localVerification: {
        interiorPages: interiorCheck.pageCount,
        interiorBytes: interiorCheck.byteLength,
        coverBytes: coverCheck.byteLength,
      },
    };
    if (values.json) {
      ctx.io.stdout(JSON.stringify(dryPayload, null, 2));
    } else {
      ctx.io.stdout(
        `Dry-run preflight passed for '${dryPayload.title}' (${report.spec.interiorPageCount} pages, est. $${(quote.totalCostCents / 100).toFixed(2)} ${quote.currency}). Zero external orders submitted.`
      );
    }
    return EXIT_OK;
  }

  const interiorPdfUrl = values['interior-url']?.trim() || `file://${path.join(outDir, 'interior.pdf')}`;
  const coverPdfUrl = values['cover-url']?.trim() || `file://${path.join(outDir, 'cover.pdf')}`;

  const validation = await provider.validateInteriorAndCover({
    spec: report.spec,
    interiorPdfUrl,
    coverPdfUrl,
  });
  if (!validation.interior.ok || !validation.cover.ok) {
    ctx.io.stderr('Publisher preflight validation failed.');
    return EXIT_ERROR;
  }

  const job = await provider.createPrintJob({
    externalId: `kinloom-cli-${Date.now()}`,
    title: values.title?.trim() || report.title,
    contactEmail: values.email?.trim() || 'steward@archive.example',
    spec: report.spec,
    quantity,
    interiorPdfUrl,
    coverPdfUrl,
    shippingAddress,
    shippingLevel,
  });

  if (values.json) {
    ctx.io.stdout(JSON.stringify({ job, quote, validation }, null, 2));
  } else {
    ctx.io.stdout(`Submitted print job ${job.jobId} (${job.status}, sandbox=${String(job.sandbox)}).`);
  }
  return EXIT_OK;
}

async function runBookStatusSubcommand(
  args: readonly string[],
  ctx: KinloomCliPluginContext,
  pluginOptions: BookPublishingCliPluginOptions
): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args,
    allowPositionals: false,
    options: {
      'job-id': { type: 'string' },
      provider: { type: 'string', default: 'mock' },
      sandbox: { type: 'boolean', default: false },
      production: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  const jobId = values['job-id']?.trim();
  if (!jobId) {
    throw new CliValidationError('Missing required --job-id <id> option.');
  }

  const environment: BookPublisherEnvironment = values.production ? 'production' : 'sandbox';
  const provider = resolveCliPublisher({
    providerName: values.provider ?? 'mock',
    environment,
    pluginOptions,
    fetchImpl: ctx.fetchImpl,
  });
  const job = await provider.getPrintJobStatus(jobId);

  if (values.json) {
    ctx.io.stdout(JSON.stringify(job, null, 2));
  } else {
    ctx.io.stdout(`Job ${job.jobId}: status=${job.status} (updated ${job.updatedAt})`);
  }
  return EXIT_OK;
}

function createBookCommand(pluginOptions: BookPublishingCliPluginOptions): KinloomCliCommand {
  return {
    name: BOOK_PUBLISHING_COMMAND_NAME,
    summary: 'Build archival landscape hardcover book PDFs and manage POD publishing',
    help: BOOK_PUBLISHING_HELP,
    async run(args: readonly string[], ctx: KinloomCliPluginContext): Promise<CliExitCode> {
      const [subcommand, ...rest] = args;
      if (!subcommand || subcommand === '-h' || subcommand === '--help') {
        ctx.io.stdout(BOOK_PUBLISHING_HELP);
        return EXIT_OK;
      }
      switch (subcommand) {
        case 'build':
          return runBookBuildSubcommand(rest, ctx, pluginOptions);
        case 'quote':
          return runBookQuoteSubcommand(rest, ctx, pluginOptions);
        case 'submit':
          return runBookSubmitSubcommand(rest, ctx, pluginOptions);
        case 'status':
          return runBookStatusSubcommand(rest, ctx, pluginOptions);
        default:
          throw new CliValidationError(
            `Unknown 'book' subcommand '${subcommand}'. Expected one of: build, quote, submit, status.`
          );
      }
    },
  };
}

/**
 * Optional, off-by-default Kinloom CLI plugin for archival hardcover book PDF generation
 * and print-on-demand quoting/submission (`kinloom book build|quote|submit|status`).
 */
export function createBookPublishingCliPlugin(
  options: BookPublishingCliPluginOptions = {}
): KinloomCliPlugin {
  if (options.enabled === false) {
    return {
      id: BOOK_PUBLISHING_CLI_PLUGIN_ID,
      name: 'Kinloom Archival Book Publishing CLI (disabled)',
      commands: [],
    };
  }

  return {
    id: BOOK_PUBLISHING_CLI_PLUGIN_ID,
    name: 'Kinloom Archival Book Publishing CLI',
    commands: [createBookCommand(options)],
  };
}
