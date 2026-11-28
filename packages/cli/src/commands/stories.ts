import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildStorySummary,
  compileStoryHtml,
  type SpecialtyStory,
  type StoryFormat,
  StoryFormatSchema,
  type StoryManifest,
  type StoryManifestEntry,
  StoryManifestSchema,
  type StoryStyle,
  type StoryValidationResult,
  validateStoryBundle,
} from '@kinloom/core';
import type { CliDispatchContext } from '../cli/types.js';
import { type CliExitCode, CliValidationError, EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../errors.js';

export const STORIES_HELP = `Usage: kinloom stories <subcommand> [options]

Subcommands:
  init      Scaffold a typed Specialty Story workspace (story.json, style.json, assets/)
  validate  Run structural, timing, citation, and asset QA checks on a story bundle
  build     Validate and compile a story into portable JSON and self-contained HTML
  publish   Publish a validated story to a local stories manifest or Kinloom server
  list      List published stories from a local manifest or Kinloom server

Examples:
  kinloom stories init --person person-ada --format documentary --title "Ada's Journey"
  kinloom stories validate ./stories/adas-journey
  kinloom stories build ./stories/adas-journey --out ./dist/stories
  kinloom stories publish ./stories/adas-journey --dry-run
  kinloom stories list --person person-ada

Options:
  -h, --help  Show this help message`;

const DEFAULT_STORIES_DIR = path.join('public', 'stories');
const DEFAULT_MANIFEST_FILENAME = 'stories-manifest.json';

interface ParsedFlags {
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<string, string>;
  readonly booleans: ReadonlySet<string>;
}

const VALUE_FLAGS = new Set([
  '--person',
  '--format',
  '--title',
  '--out',
  '--site',
  '--token',
  '--manifest',
  '--aspect-ratio',
]);

function parseStoryArgs(args: readonly string[]): ParsedFlags {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      booleans.add('--help');
      continue;
    }
    if (arg === '--dry-run' || arg === '--json' || arg === '--force') {
      booleans.add(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new CliValidationError(`Option '${arg}' requires a value.`);
      }
      values.set(arg, next);
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new CliValidationError(`Unknown option '${arg}'. Run \`kinloom stories --help\` for usage.`);
    }
    positionals.push(arg);
  }
  return { positionals, values, booleans };
}

export function slugifyStoryTitle(input: string): string {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'specialty-story';
}

interface HydratedPersonFacts {
  readonly fullName: string;
  readonly birthYear?: number;
  readonly deathYear?: number;
}

async function tryHydratePersonFromSite(
  siteUrl: string,
  personId: string,
  token: string | undefined,
  fetchImpl: typeof fetch
): Promise<HydratedPersonFacts | null> {
  const trimmed = siteUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) {
    headers['authorization'] = `Bearer ${token}`;
  }
  const res = await fetchImpl(`${trimmed}/api/bundle`, { headers });
  if (!res.ok) {
    return null;
  }
  const payload = (await res.json()) as {
    people?: Array<{ id?: string; full_name?: string; birth_year?: number; death_year?: number }>;
  };
  const found = payload.people?.find((p) => p.id === personId);
  if (!found?.full_name) {
    return null;
  }
  return {
    fullName: found.full_name,
    ...(typeof found.birth_year === 'number' ? { birthYear: found.birth_year } : {}),
    ...(typeof found.death_year === 'number' ? { deathYear: found.death_year } : {}),
  };
}

export function buildScaffoldStory(options: {
  readonly personId: string;
  readonly format: StoryFormat;
  readonly title: string;
  readonly personName?: string | undefined;
  readonly birthYear?: number | undefined;
  readonly aspectRatio?: '16:9' | '9:16' | undefined;
}): SpecialtyStory {
  const slug = slugifyStoryTitle(options.title);
  const subjectLabel = options.personName ?? options.personId;
  const startYear = options.birthYear ?? 1880;
  const baseCitation = {
    id: 'cite-1',
    label: `Archive record for ${subjectLabel}`,
    detail: 'Replace with primary archival citation before publishing.',
  };

  const common = {
    schemaVersion: 1 as const,
    id: `story-${slug}`,
    slug,
    personId: options.personId,
    ...(options.personName ? { personName: options.personName } : {}),
    title: options.title,
    summary: `Interactive ${options.format} specialty story exploring the life of ${subjectLabel}.`,
    citations: [baseCitation],
    style: {
      palette: 'parchment' as const,
      accentToken: 'accent-primary' as const,
      motion: 'standard' as const,
      captionPosition: 'bottom' as const,
    },
  };

  if (options.format === 'documentary') {
    return {
      ...common,
      format: 'documentary',
      aspectRatio: options.aspectRatio ?? '16:9',
      beats: [
        {
          id: 'beat-1',
          title: 'Opening',
          startMs: 0,
          durationMs: 6000,
          dateLabel: String(startYear),
          narration: `Introduce ${subjectLabel} with a verified archival fact and historical context.`,
          caption: `${subjectLabel} (${startYear})`,
          citationIds: ['cite-1'],
        },
        {
          id: 'beat-2',
          title: 'Turning Point',
          startMs: 6000,
          durationMs: 6000,
          dateLabel: String(startYear + 20),
          narration: `Describe a pivotal milestone in ${subjectLabel}'s life backed by primary records.`,
          caption: `Milestone in ${startYear + 20}`,
          citationIds: ['cite-1'],
        },
      ],
    };
  }

  if (options.format === 'scroll') {
    return {
      ...common,
      format: 'scroll',
      beats: [
        {
          id: 'beat-1',
          key: 'opening',
          title: 'Early Years',
          dateLabel: String(startYear),
          body: `Set the archival scene for ${subjectLabel}'s early life and family surroundings.`,
          caption: `Early life of ${subjectLabel}`,
          citationIds: ['cite-1'],
        },
        {
          id: 'beat-2',
          key: 'legacy',
          title: 'Lasting Record',
          dateLabel: String(startYear + 25),
          body: `Highlight the documents, letters, or census entries that preserve ${subjectLabel}'s story.`,
          caption: `Primary archival evidence for ${subjectLabel}`,
          citationIds: ['cite-1'],
        },
      ],
    };
  }

  return {
    ...common,
    format: 'map',
    beats: [
      {
        id: 'stop-1',
        title: 'Origin',
        date: String(startYear),
        year: startYear,
        placeLabel: 'Birthplace (update with verified locality)',
        coordinates: { lat: 42.8695, lng: -85.8648 },
        narrative: `Record where ${subjectLabel}'s documented journey begins.`,
        caption: `${startYear}: Origin stop`,
        citationIds: ['cite-1'],
      },
      {
        id: 'stop-2',
        title: 'Migration Destination',
        date: String(startYear + 20),
        year: startYear + 20,
        placeLabel: 'Destination (update with verified locality)',
        coordinates: { lat: 42.9634, lng: -85.6681 },
        narrative: `Document the move and archival evidence placing ${subjectLabel} here.`,
        caption: `${startYear + 20}: Later residence`,
        citationIds: ['cite-1'],
      },
    ],
  };
}

async function resolveStoryFilePath(
  inputPath: string,
  cwd: string
): Promise<{
  readonly storyFile: string;
  readonly storyDir: string;
}> {
  const abs = path.resolve(cwd, inputPath);
  const info = await stat(abs).catch(() => null);
  if (!info) {
    throw new CliValidationError(`Story path not found: ${inputPath}`);
  }
  if (info.isDirectory()) {
    const storyFile = path.join(abs, 'story.json');
    const fileInfo = await stat(storyFile).catch(() => null);
    if (!fileInfo?.isFile()) {
      throw new CliValidationError(`No story.json found in directory: ${inputPath}`);
    }
    return { storyFile, storyDir: abs };
  }
  return { storyFile: abs, storyDir: path.dirname(abs) };
}

async function collectWorkspaceAssets(storyDir: string): Promise<ReadonlySet<string>> {
  const assets = new Set<string>();
  async function walk(relDir: string): Promise<void> {
    const full = path.join(storyDir, relDir);
    const entries = await readdir(full, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const nextRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(nextRel);
      } else if (entry.isFile()) {
        assets.add(nextRel.replaceAll('\\', '/'));
      }
    }
  }
  await walk('assets');
  return assets;
}

async function loadAndValidateStory(
  inputPath: string,
  cwd: string
): Promise<{
  readonly storyFile: string;
  readonly storyDir: string;
  readonly result: StoryValidationResult;
}> {
  const { storyFile, storyDir } = await resolveStoryFilePath(inputPath, cwd);
  const rawText = await readFile(storyFile, 'utf8');
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawText);
  } catch (err) {
    throw new CliValidationError(
      `Invalid JSON in ${storyFile}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const existingAssets = await collectWorkspaceAssets(storyDir);
  const result = validateStoryBundle(rawJson, { existingAssets });
  return { storyFile, storyDir, result };
}

function formatDiagnostics(result: StoryValidationResult): string {
  if (result.diagnostics.length === 0) {
    return '0 issues found.';
  }
  return result.diagnostics
    .map((d) => `  [${d.severity.toUpperCase()}] ${d.code} (${d.path}): ${d.message}`)
    .join('\n');
}

async function runStoriesInit(args: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const parsed = parseStoryArgs(args);
  if (parsed.booleans.has('--help')) {
    ctx.io.stdout(STORIES_HELP);
    return EXIT_OK;
  }
  const personId = parsed.values.get('--person');
  const formatRaw = parsed.values.get('--format');
  if (!personId) {
    throw new CliValidationError('Missing required option --person <id>.');
  }
  const formatParsed = StoryFormatSchema.safeParse(formatRaw);
  if (!formatParsed.success) {
    throw new CliValidationError("Missing or invalid --format. Expected 'documentary', 'scroll', or 'map'.");
  }
  const aspectRaw = parsed.values.get('--aspect-ratio');
  if (aspectRaw !== undefined && aspectRaw !== '16:9' && aspectRaw !== '9:16') {
    throw new CliValidationError("Invalid --aspect-ratio. Expected '16:9' or '9:16'.");
  }

  let hydrated: HydratedPersonFacts | null = null;
  const siteUrl = parsed.values.get('--site');
  if (siteUrl) {
    const token = parsed.values.get('--token') ?? process.env['KINLOOM_TOKEN'];
    const fetchFn = ctx.fetchImpl ?? globalThis.fetch;
    hydrated = await tryHydratePersonFromSite(siteUrl, personId, token, fetchFn).catch(() => null);
  }

  const formatLabel = `${formatParsed.data.charAt(0).toUpperCase()}${formatParsed.data.slice(1)}`;
  const title = parsed.values.get('--title') ?? `${hydrated?.fullName ?? personId} — ${formatLabel} Story`;
  const story = buildScaffoldStory({
    personId,
    format: formatParsed.data,
    title,
    personName: hydrated?.fullName,
    birthYear: hydrated?.birthYear,
    aspectRatio: aspectRaw,
  });

  const outDir = path.resolve(ctx.cwd, parsed.values.get('--out') ?? path.join('stories', story.slug));
  const storyPath = path.join(outDir, 'story.json');
  const stylePath = path.join(outDir, 'style.json');
  const assetsDir = path.join(outDir, 'assets');

  const existing = await stat(storyPath).catch(() => null);
  if (existing && !parsed.booleans.has('--force')) {
    throw new CliValidationError(`Story file already exists at ${storyPath}. Pass --force to overwrite.`);
  }

  await mkdir(assetsDir, { recursive: true });
  const stylePayload: StoryStyle = story.style ?? {
    palette: 'parchment',
    accentToken: 'accent-primary',
    motion: 'standard',
    captionPosition: 'bottom',
  };
  await writeFile(storyPath, `${JSON.stringify(story, null, 2)}\n`, 'utf8');
  await writeFile(stylePath, `${JSON.stringify(stylePayload, null, 2)}\n`, 'utf8');
  await writeFile(path.join(assetsDir, '.gitkeep'), '', 'utf8');

  ctx.io.stdout(
    `Scaffolded ${story.format} story '${story.title}' (${story.slug}) for ${story.personId} in ${outDir}`
  );
  return EXIT_OK;
}

async function runStoriesValidate(args: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const parsed = parseStoryArgs(args);
  if (parsed.booleans.has('--help')) {
    ctx.io.stdout(STORIES_HELP);
    return EXIT_OK;
  }
  const target = parsed.positionals[0];
  if (!target) {
    throw new CliValidationError('Usage: kinloom stories validate <path> [--json]');
  }

  const { storyFile, result } = await loadAndValidateStory(target, ctx.cwd);
  if (parsed.booleans.has('--json')) {
    ctx.io.stdout(
      JSON.stringify({ file: storyFile, valid: result.valid, diagnostics: result.diagnostics }, null, 2)
    );
    return result.valid ? EXIT_OK : EXIT_USAGE;
  }

  if (!result.valid) {
    ctx.io.stderr(`Story validation FAILED for ${storyFile}:\n${formatDiagnostics(result)}`);
    return EXIT_USAGE;
  }
  const warnings = result.diagnostics.filter((d) => d.severity === 'warning');
  ctx.io.stdout(
    `Story validation PASSED for ${storyFile} (${result.story?.format}, ${result.story?.beats.length ?? 0} beats, ${warnings.length} warning(s)).`
  );
  if (warnings.length > 0) {
    ctx.io.stdout(formatDiagnostics(result));
  }
  return EXIT_OK;
}

async function runStoriesBuild(args: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const parsed = parseStoryArgs(args);
  if (parsed.booleans.has('--help')) {
    ctx.io.stdout(STORIES_HELP);
    return EXIT_OK;
  }
  const target = parsed.positionals[0];
  if (!target) {
    throw new CliValidationError('Usage: kinloom stories build <path> [--out <dir>]');
  }

  const { storyFile, storyDir, result } = await loadAndValidateStory(target, ctx.cwd);
  if (!result.valid || !result.story) {
    ctx.io.stderr(`Cannot build invalid story ${storyFile}:\n${formatDiagnostics(result)}`);
    return EXIT_USAGE;
  }

  const story = result.story;
  const outDir = path.resolve(ctx.cwd, parsed.values.get('--out') ?? path.join(storyDir, 'dist'));
  await mkdir(outDir, { recursive: true });

  const jsonOut = path.join(outDir, `${story.slug}.story.json`);
  const htmlOut = path.join(outDir, `${story.slug}.html`);
  await writeFile(jsonOut, `${JSON.stringify(story, null, 2)}\n`, 'utf8');
  await writeFile(htmlOut, compileStoryHtml(story), 'utf8');

  const srcAssets = path.join(storyDir, 'assets');
  const assetsStat = await stat(srcAssets).catch(() => null);
  if (assetsStat?.isDirectory()) {
    await cp(srcAssets, path.join(outDir, 'assets'), { recursive: true });
  }

  ctx.io.stdout(`Built specialty story '${story.slug}' -> ${jsonOut} and ${htmlOut}`);
  return EXIT_OK;
}

async function readLocalManifest(manifestPath: string): Promise<StoryManifest> {
  const raw = await readFile(manifestPath, 'utf8').catch(() => null);
  if (!raw) {
    return { version: 1, updatedAt: new Date().toISOString(), stories: [] };
  }
  const parsed = StoryManifestSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new CliValidationError(`Corrupt stories manifest at ${manifestPath}`);
  }
  return parsed.data;
}

async function runStoriesPublish(args: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const parsed = parseStoryArgs(args);
  if (parsed.booleans.has('--help')) {
    ctx.io.stdout(STORIES_HELP);
    return EXIT_OK;
  }
  const target = parsed.positionals[0];
  if (!target) {
    throw new CliValidationError(
      'Usage: kinloom stories publish <path> [--out <dir>] [--manifest <file>] [--site <url>] [--dry-run]'
    );
  }

  const { storyFile, result } = await loadAndValidateStory(target, ctx.cwd);
  if (!result.valid || !result.story) {
    ctx.io.stderr(`Cannot publish invalid story ${storyFile}:\n${formatDiagnostics(result)}`);
    return EXIT_USAGE;
  }

  const story = result.story;
  const dryRun = parsed.booleans.has('--dry-run');
  const siteUrl = parsed.values.get('--site');
  const publishedAt = story.publishedAt ?? new Date().toISOString();
  const bundleFileName = `${story.slug}.story.json`;
  const entry = buildStorySummary(story, { bundlePath: bundleFileName, publishedAt });

  if (dryRun) {
    ctx.io.stdout(
      `[dry-run] Validated '${story.title}' (${story.slug}, ${story.format}, ${entry.beatCount} beats) for ${story.personId}. Ready to publish.`
    );
    return EXIT_OK;
  }

  if (siteUrl) {
    const trimmed = siteUrl.replace(/\/+$/, '');
    const token = parsed.values.get('--token') ?? process.env['KINLOOM_TOKEN'];
    const fetchFn = ctx.fetchImpl ?? globalThis.fetch;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) {
      headers['authorization'] = `Bearer ${token}`;
    }
    const res = await fetchFn(`${trimmed}/api/plugins/stories/publish`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ story, summary: entry }),
    });
    if (!res.ok) {
      ctx.io.stderr(
        `Remote publish failed with HTTP ${res.status} at ${trimmed}/api/plugins/stories/publish`
      );
      return EXIT_ERROR;
    }
    ctx.io.stdout(`Published '${story.slug}' to ${trimmed}`);
    return EXIT_OK;
  }

  const outDir = path.resolve(ctx.cwd, parsed.values.get('--out') ?? DEFAULT_STORIES_DIR);
  const manifestPath = path.resolve(
    ctx.cwd,
    parsed.values.get('--manifest') ?? path.join(outDir, DEFAULT_MANIFEST_FILENAME)
  );
  await mkdir(outDir, { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });

  const manifest = await readLocalManifest(manifestPath);
  const nextStories = [...manifest.stories.filter((s) => s.slug !== entry.slug), entry].toSorted((a, b) =>
    a.title.localeCompare(b.title)
  );
  const nextManifest: StoryManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    stories: nextStories,
  };

  await writeFile(path.join(outDir, bundleFileName), `${JSON.stringify(story, null, 2)}\n`, 'utf8');
  await writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, 'utf8');
  ctx.io.stdout(`Published '${story.slug}' (${story.format}) to ${manifestPath}`);
  return EXIT_OK;
}

async function runStoriesList(args: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const parsed = parseStoryArgs(args);
  if (parsed.booleans.has('--help')) {
    ctx.io.stdout(STORIES_HELP);
    return EXIT_OK;
  }
  const personFilter = parsed.values.get('--person');
  const siteUrl = parsed.values.get('--site');

  let stories: readonly StoryManifestEntry[];
  if (siteUrl) {
    const trimmed = siteUrl.replace(/\/+$/, '');
    const token = parsed.values.get('--token') ?? process.env['KINLOOM_TOKEN'];
    const fetchFn = ctx.fetchImpl ?? globalThis.fetch;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) {
      headers['authorization'] = `Bearer ${token}`;
    }
    const qs = personFilter ? `?person=${encodeURIComponent(personFilter)}` : '';
    const res = await fetchFn(`${trimmed}/api/plugins/stories${qs}`, { headers });
    if (!res.ok) {
      ctx.io.stderr(`Failed to list stories from ${trimmed} (HTTP ${res.status})`);
      return EXIT_ERROR;
    }
    const data = (await res.json()) as { stories?: StoryManifestEntry[] };
    stories = data.stories ?? [];
  } else {
    const manifestPath = path.resolve(
      ctx.cwd,
      parsed.values.get('--manifest') ?? path.join(DEFAULT_STORIES_DIR, DEFAULT_MANIFEST_FILENAME)
    );
    const manifest = await readLocalManifest(manifestPath);
    stories = personFilter ? manifest.stories.filter((s) => s.personId === personFilter) : manifest.stories;
  }

  if (parsed.booleans.has('--json')) {
    ctx.io.stdout(JSON.stringify({ stories }, null, 2));
    return EXIT_OK;
  }

  if (stories.length === 0) {
    ctx.io.stdout(
      personFilter
        ? `No published specialty stories found for person '${personFilter}'.`
        : 'No published specialty stories found.'
    );
    return EXIT_OK;
  }

  const lines = stories.map(
    (s) => `  ${s.slug.padEnd(28)} [${s.format.padEnd(11)}] ${s.beatCount} beats · ${s.personId} · ${s.title}`
  );
  ctx.io.stdout(`Published specialty stories (${stories.length}):\n${lines.join('\n')}`);
  return EXIT_OK;
}

export async function runStoriesCommand(
  rest: readonly string[],
  ctx: CliDispatchContext
): Promise<CliExitCode> {
  const sub = rest[0];
  if (!sub || sub === '--help' || sub === '-h') {
    ctx.io.stdout(STORIES_HELP);
    return EXIT_OK;
  }
  const subArgs = rest.slice(1);
  switch (sub) {
    case 'init':
      return runStoriesInit(subArgs, ctx);
    case 'validate':
      return runStoriesValidate(subArgs, ctx);
    case 'build':
      return runStoriesBuild(subArgs, ctx);
    case 'publish':
      return runStoriesPublish(subArgs, ctx);
    case 'list':
      return runStoriesList(subArgs, ctx);
    default:
      throw new CliValidationError(
        `Unknown stories subcommand '${sub}'. Run \`kinloom stories --help\` for usage.`
      );
  }
}
