import {
  AUDIT_HELP,
  CONTEXT_HELP,
  DATES_HELP,
  DESIGN_AUDIT_HELP,
  INTEGRATE_HELP,
  MEDIA_HELP,
  MIGRATE_HELP,
  PRONOUNCE_HELP,
  SCREENSHOTS_HELP,
  STATUS_HELP,
  SYNC_HELP,
  TELEMETRY_HELP,
  VERIFY_HELP,
  VERIFY_LIVE_HELP,
} from '../commands/ops/help.js';
import { formatRecordCommandsHelp } from '../commands/records/help.js';

export type BuiltInCommandCategory = 'lifecycle' | 'ops' | 'meta';

export interface BuiltInCliCommandMeta {
  readonly name: string;
  readonly category: BuiltInCommandCategory;
  readonly summary: string;
  readonly help: string;
}

export const BUILTIN_CLI_COMMAND_SPECS = [
  {
    name: 'init',
    category: 'lifecycle',
    summary: 'Scaffold a thin private family archive repository',
    help: `Usage: kinloom init <dir> --family <name> --title <title> [options]

Options:
  --family <name>     Primary family surname or lineage name (required)
  --title <title>     Display title for the archive site (required)
  --accent <hex>      6-digit hex theme accent color (default: #7A4612)
  --force             Overwrite existing files
  -h, --help          Show this help message`,
  },
  {
    name: 'brandkit',
    category: 'lifecycle',
    summary: 'Generate all-device favicons, PWA icons, manifest, service worker, and Open Graph image',
    help: `Usage: kinloom brandkit [options]

Options:
  --config <path>      Path to kinloom.config.yaml (optional; uses Kinloom defaults if omitted)
  --out <dir>          Output directory for brandkit assets (default: public)
  --title <text>       Override OG card & manifest title
  --subtitle <text>    Override OG card subtitle
  --metadata <text>    Override OG card monospace metadata line
  --accent <hex>       Override 6-digit hex accent color (e.g. #2F5245)
  --surface <theme>    Card/icon surface theme: 'parchment' or 'navy' (default: parchment)
  --mark <svg-path>    Custom SVG mark file to embed instead of default KinloomMark
  --vignette <imgPath> Optional archival vignette image for split-layout OG card
  --base-url <path>    Optional deployment base path (default: /, e.g. /kinloom/)
  --print-head         Print ready-to-paste HTML <head> meta & icon tags
  --no-force           Skip files that already exist
  -h, --help           Show this help message`,
  },
  {
    name: 'slice-gedcom',
    category: 'lifecycle',
    summary: 'Slice a combined GEDCOM export into deterministic YAML files',
    help: `Usage: kinloom slice-gedcom --input <file.ged> --out <data-dir> --root <xref-or-name> [options]

Options:
  --input <path>               Source GEDCOM file path (required)
  --out <dir>                  Output directory for YAML files (required)
  --root <xref-or-name>        Root person xref (@I1@) or full name (required)
  --surname <name>             Ancestor surname filter (repeatable or comma-separated)
  --branch <id>                Branch identifier stamped on output people
  --include-upstream-spouses   Expand ancestors of married-in spouses
  --no-ancestor-siblings       Exclude sibling sets of direct ancestors
  --no-descendant-spouses      Exclude spouses of descendants
  --no-normalize-maiden        Keep original GEDCOM surnames instead of maiden primary
  --reference-year <year>      Reference year for 100-year living cutoff
  -h, --help                   Show this help message`,
  },
  {
    name: 'seed',
    category: 'lifecycle',
    summary: 'Load local YAML + config and submit an idempotent seed batch',
    help: `Usage: kinloom seed --data <data-dir> --config <kinloom.config.yaml> --site <url> [options]

Options:
  --data <dir>         Directory containing people.yaml, events.yaml, etc. (required)
  --config <path>      Path to kinloom.config.yaml (required)
  --site <url>         Target Kinloom server URL (required unless --dry-run)
  --token <secret>     Bearer token (defaults to KINLOOM_TOKEN)
  --batch-id <id>      Explicit batch identifier (default: content-hashed)
  --chunk-size <N>     Max patches per POST /api/batches request (default: 25)
  --summary <text>     Revision summary for the seed batch
  --dry-run            Validate YAML, run compileArchive locally, and skip HTTP
  -h, --help           Show this help message`,
  },
  {
    name: 'submit-batch',
    category: 'lifecycle',
    summary: 'Validate and submit a typed BatchSubmission JSON/YAML file',
    help: `Usage: kinloom submit-batch --file <patch_spec.json|yaml> --site <url> [options]

Options:
  --file <path>        BatchSubmission JSON or YAML file (or first positional arg)
  --site <url>         Target Kinloom server URL (required unless --dry-run)
  --token <secret>     Bearer token (defaults to KINLOOM_TOKEN)
  --dry-run            Validate envelope and per-entity payloads without HTTP
  -h, --help           Show this help message`,
  },
  {
    name: 'export-yaml',
    category: 'lifecycle',
    summary: 'Export deterministic YAML snapshot with ETag/304 support',
    help: `Usage: kinloom export-yaml --site <url> --out <data-dir> [options]

Options:
  --site <url>         Target Kinloom server URL (required)
  --out <dir>          Output directory for deterministic YAML files (required)
  --token <secret>     Bearer token (defaults to KINLOOM_TOKEN)
  --state-file <path>  Revision state file (default: <out>/.last-backup-revision)
  -h, --help           Show this help message`,
  },
  {
    name: 'upload-media',
    category: 'lifecycle',
    summary: 'Validate and upload a media scan or recording via multipart POST',
    help: `Usage: kinloom upload-media --file <path> --metadata <json|@file> --summary <text> --site <url> [options]

Options:
  --file <path>          Local media file to upload (required)
  --metadata <json>      Media metadata JSON string or @file path (required)
  --summary <text>       Edit summary (minimum 3 characters, required)
  --site <url>           Target Kinloom server URL (required unless --dry-run)
  --token <secret>       Bearer token (defaults to KINLOOM_TOKEN)
  --mime <type>          Override detected MIME type
  --allow-audio-video    Allow MP4/WebM/MP3/M4A/OGG/WAV uploads
  --max-bytes <n>        Override maximum allowed file size in bytes
  --dry-run              Validate file and metadata locally without HTTP
  -h, --help             Show this help message`,
  },
  {
    name: 'reconcile',
    category: 'lifecycle',
    summary: 'Compare cached GET /api/bundle against full compileArchive',
    help: `Usage: kinloom reconcile --site <url> --config <kinloom.config.yaml> [options]

Options:
  --site <url>         Target Kinloom server URL (required)
  --config <path>      Path to kinloom.config.yaml (required)
  --token <secret>     Bearer token (defaults to KINLOOM_TOKEN)
  --mode <mode>        Override build mode ('private' or 'public')
  -h, --help           Show this help message`,
  },
  {
    name: 'context',
    category: 'ops',
    summary: 'Dump privacy-fenced YAML context, relatives, and leads for a person',
    help: CONTEXT_HELP,
  },
  {
    name: 'integrate',
    category: 'ops',
    summary: 'Validate and merge one or more person research packages into local YAML',
    help: INTEGRATE_HELP,
  },
  {
    name: 'audit',
    category: 'ops',
    summary: 'Run 6-check package audits (plus plugin checks) for one person or a staged batch',
    help: AUDIT_HELP,
  },
  {
    name: 'verify',
    category: 'ops',
    summary: 'Run full-archive invariant checks over local data/*.yaml files',
    help: VERIFY_HELP,
  },
  {
    name: 'verify-live',
    category: 'ops',
    summary: 'Verify live deployments (401 gate, plugins, living privacy, browser/PWA, D1 cleanup)',
    help: VERIFY_LIVE_HELP,
  },
  {
    name: 'media',
    category: 'ops',
    summary: 'Inspect and deduplicate local archive media records (dry-run by default)',
    help: MEDIA_HELP,
  },
  {
    name: 'status',
    category: 'ops',
    summary: 'Report archive totals and the deceased biography queue',
    help: STATUS_HELP,
  },
  {
    name: 'sync',
    category: 'ops',
    summary: 'Diff and sync local YAML + R2 media to a live Cloudflare archive',
    help: SYNC_HELP,
  },
  {
    name: 'migrate',
    category: 'ops',
    summary: 'Idempotently inspect and apply pending Cloudflare D1 SQL migrations',
    help: MIGRATE_HELP,
  },
  {
    name: 'dates',
    category: 'ops',
    summary: 'Compute exact Gregorian weekdays, date diffs, and ages',
    help: DATES_HELP,
  },
  {
    name: 'pronounce',
    category: 'ops',
    summary: 'Look up verified Wikimedia IPA/audio and audit pronunciation lexicons',
    help: PRONOUNCE_HELP,
  },
  {
    name: 'telemetry',
    category: 'ops',
    summary: 'Report local CLI latency, cache hit rate, and failure summary',
    help: TELEMETRY_HELP,
  },
  {
    name: 'screenshots',
    category: 'ops',
    summary: 'Export UI review screenshots, component states, and HTML contact sheet',
    help: SCREENSHOTS_HELP,
  },
  {
    name: 'design-audit',
    category: 'ops',
    summary: 'Run deterministic UI/UX design audits (APCA, WCAG 2.2, DTCG tokens, SARIF 2.1.0)',
    help: DESIGN_AUDIT_HELP,
  },
  {
    name: 'guide',
    category: 'ops',
    summary: 'Browse embedded research, archive, OCR, and workflow guides',
    help: `Usage: kinloom guide [topic]

Browse all embedded Kinloom archival, scan-prep, OCR, audio, and workflow guides.

Examples:
  kinloom guide                              List all 28 embedded guides by category
  kinloom guide nara                         Show the National Archives (NARA) workflow guide
  kinloom guide ocr                          Show the safe batch OCR workflow guide
  kinloom guide pronounce                    Show the pronunciation lookup & audit guide
  kinloom guide narrative-audio/script-rules Show the narrative audio script rules subguide

Options:
  -h, --help  Show this help message`,
  },
  {
    name: 'help',
    category: 'meta',
    summary: 'Show full help or research guide for any command',
    help: 'Usage: kinloom help [command]\n\nShow full help or research guide for any command.',
  },
] as const satisfies readonly BuiltInCliCommandMeta[];

export type BuiltInCliCommandName = (typeof BUILTIN_CLI_COMMAND_SPECS)[number]['name'];
export type BuiltInExecutableCommandName = Exclude<BuiltInCliCommandName, 'help'>;

export const CORE_CLI_COMMANDS: ReadonlySet<string> = new Set(
  BUILTIN_CLI_COMMAND_SPECS.map((spec) => spec.name)
);

const COMMAND_HELP_MAP: Record<string, string> = {};
for (const spec of BUILTIN_CLI_COMMAND_SPECS) {
  if (spec.category !== 'meta') {
    COMMAND_HELP_MAP[spec.name] = spec.help;
  }
}

export const COMMAND_HELP: Readonly<Record<string, string>> = Object.freeze(COMMAND_HELP_MAP);

function formatCategorySection(heading: string, category: Exclude<BuiltInCommandCategory, 'meta'>): string {
  const rows = BUILTIN_CLI_COMMAND_SPECS.filter((spec) => spec.category === category).map(
    (spec) => `  ${spec.name.padEnd(19)}${spec.summary}`
  );
  return `${heading}:\n${rows.join('\n')}`;
}

export const ROOT_HELP = `Usage: kinloom <command> [options]

${formatCategorySection('Archive lifecycle', 'lifecycle')}

${formatCategorySection('Research & archive ops', 'ops')}

${formatRecordCommandsHelp()}

Global options:
  -h, --help         Show help for kinloom or a specific command
  help <command>     Show full help or research guide for any command
  <command> --guide  Show the embedded workflow guide for any supported command

Environment variables:
  KINLOOM_TOKEN               Bearer token used when --token is omitted
  KINLOOM_ANCESTRY_FACTS_DIR  Optional external facts JSON directory for \`kinloom context\`
  KINLOOM_PRONOUNCE_CACHE_DIR Override pronunciation lookup cache dir (~/.cache/kinloom-pronounce)
  KINLOOM_TELEMETRY_FILE      Override JSONL telemetry path (~/.cache/kinloom-telemetry/calls.jsonl)

Exit codes:
  0  Success
  1  Runtime, HTTP, audit, or reconciliation drift error
  2  CLI usage or boundary validation error
  3  Optimistic concurrency conflict (HTTP 409)`;
