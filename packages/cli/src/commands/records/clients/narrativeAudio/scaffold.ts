import fs from 'node:fs';
import path from 'node:path';
import type { PhonemeTermHint } from '../../../ops/shared/audio/index.js';
import {
  type CommandParseSpec,
  formatCommandUsage,
  getBooleanOption,
  getStringOption,
  type OptionSpec,
  parseCommandArgs,
} from '../../runtime/args.js';
import { resolveUserPathFromContext } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  loadArchiveForNarrativeAudio,
  narrativeMarkdownToSpokenScript,
  selectNarrativeCandidates,
} from './batchPrep.js';
import { countWords } from './script.js';

export interface ScaffoldedNarrativeItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly script_path: string;
  readonly names_path: string;
  readonly names_count: number;
  readonly word_count: number;
}

export interface ScaffoldSummary {
  readonly ok: true;
  readonly mode: 'scaffold';
  readonly out_dir: string;
  readonly scaffolded: number;
  readonly already_has_audio: number;
  readonly living_skipped: number;
  readonly items: readonly ScaffoldedNarrativeItem[];
}

export const SCAFFOLD_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'repo',
    kind: 'string',
    flags: ['--repo'],
    metavar: 'DIR',
    help: 'Archive repository root (default: current working directory).',
  },
  {
    key: 'out',
    kind: 'string',
    flags: ['-o', '--out'],
    metavar: 'DIR',
    help: 'Output directory for .script.txt and .names.json files (default: <repo>/narrative-audio).',
  },
  {
    key: 'kind',
    kind: 'string',
    flags: ['--kind'],
    metavar: 'KIND',
    help: 'Filter narratives by kind (default: biography; empty string includes all non-living).',
  },
  {
    key: 'force',
    kind: 'boolean',
    flags: ['--force'],
    help: 'Include narratives that already have extensions.narrative_audio metadata.',
  },
  {
    key: 'json',
    kind: 'boolean',
    flags: ['--json'],
    help: 'Emit structured JSON output.',
  },
];

export const SCAFFOLD_PARSE_SPEC: CommandParseSpec = {
  options: SCAFFOLD_OPTIONS,
  allowPositionals: false,
};

export function renderScaffoldHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom narrative-audio scaffold --repo <dir> [--out <dir>] [--json]',
    summary:
      'Generate deterministic .script.txt and lexicon-populated .names.json files from deceased archive narratives.',
    options: SCAFFOLD_OPTIONS,
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeIpaValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('/') && trimmed.endsWith('/') && trimmed.length >= 2) {
    return trimmed;
  }
  const inner = trimmed.replace(/^\/+|\/+$/g, '');
  return `/${inner}/`;
}

export function buildScriptNamesMap(
  scriptText: string,
  lexiconHints: Readonly<Record<string, PhonemeTermHint>>
): Record<string, string> {
  const matched: Record<string, string> = {};
  const sortedEntries = Object.entries(lexiconHints).sort(([a], [b]) => a.localeCompare(b));
  for (const [term, hint] of sortedEntries) {
    const rawIpa = hint.ipa?.trim();
    if (!rawIpa) continue;
    const rx = new RegExp(`(?<!\\w)${escapeRegExp(term)}(?!\\w)`);
    if (rx.test(scriptText)) {
      matched[term] = normalizeIpaValue(rawIpa);
    }
  }
  return matched;
}

export function runScaffold(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, SCAFFOLD_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderScaffoldHelp()) };
  }

  const repoDir = resolveUserPathFromContext(getStringOption(parsed, 'repo') ?? '.', ctx);
  const outArg = getStringOption(parsed, 'out');
  const outDir = outArg ? resolveUserPathFromContext(outArg, ctx) : path.join(repoDir, 'narrative-audio');
  const kindFilter = getStringOption(parsed, 'kind') ?? 'biography';
  const force = getBooleanOption(parsed, 'force');
  const jsonOutput = getBooleanOption(parsed, 'json');

  const archive = loadArchiveForNarrativeAudio(repoDir);
  const { candidates, livingSkipped, alreadyHasAudio } = selectNarrativeCandidates({
    allNarratives: archive.allNarratives,
    livingIds: archive.livingIds,
    kindFilter,
    force,
  });

  const sortedCandidates = candidates
    .map((narrative) => ({ narrative, slug: narrative.slug || narrative.id }))
    .sort((a, b) => a.slug.localeCompare(b.slug) || a.narrative.id.localeCompare(b.narrative.id));

  fs.mkdirSync(outDir, { recursive: true });
  const items: ScaffoldedNarrativeItem[] = [];

  for (const { narrative, slug } of sortedCandidates) {
    const script = narrativeMarkdownToSpokenScript(narrative.body_md, narrative.title);
    const namesMap = buildScriptNamesMap(script, archive.lexiconHints);

    const scriptPath = path.join(outDir, `${slug}.script.txt`);
    const namesPath = path.join(outDir, `${slug}.names.json`);
    fs.writeFileSync(scriptPath, `${script}\n`, 'utf8');
    fs.writeFileSync(namesPath, `${JSON.stringify(namesMap, null, 2)}\n`, 'utf8');

    items.push({
      id: narrative.id,
      slug,
      title: narrative.title,
      script_path: scriptPath,
      names_path: namesPath,
      names_count: Object.keys(namesMap).length,
      word_count: countWords(script),
    });
  }

  const summary: ScaffoldSummary = {
    ok: true,
    mode: 'scaffold',
    out_dir: outDir,
    scaffolded: items.length,
    already_has_audio: alreadyHasAudio,
    living_skipped: livingSkipped,
    items,
  };

  const bytesOut = jsonOutput
    ? emitJsonStdout(ctx.io, summary)
    : emitStdout(
        ctx.io,
        [
          `Scaffolded ${items.length} narrative script(s) into ${outDir} (${alreadyHasAudio} skipped with audio, ${livingSkipped} living excluded)`,
          ...items.map(
            (item) =>
              `  - ${item.id} (${item.slug}): ${item.word_count} words, ${item.names_count} name hints`
          ),
        ].join('\n')
      );
  return { exitCode: 0, bytesOut };
}
