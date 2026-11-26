export const CONTEXT_HELP = `Usage: kinloom context [person_id] [options]

Produce a privacy-fenced single-shot research context brief for a deceased person.

Arguments:
  person_id              Target person ID in data/people.yaml (positional or --person)

Options:
  --person <person_id>   Target person ID in data/people.yaml (required if positional omitted)
  --repo <dir>           Archive repository root (default: current working directory)
  --ancestry-dir <dir>   Optional external facts JSON export directory (or set KINLOOM_ANCESTRY_FACTS_DIR)
  --json                 Emit structured JSON instead of compact Markdown
  -h, --help             Show this help message`;

export const INTEGRATE_HELP = `Usage: kinloom integrate [person_id] [options]

Validate and integrate a person research package (patch.json + scans/) into local YAML files.

Arguments:
  person_id              Target person ID in data/people.yaml (positional or --person)

Options:
  --person <person_id>   Target person ID in data/people.yaml (required if positional omitted)
  --repo <dir>           Archive repository root (default: current working directory)
  --package-dir <dir>    Custom research package directory (default: <repo>/research/people/<person_id>)
  --dry-run              Validate schemas, citations, scans, and privacy without writing files
  --json                 Emit structured JSON summary
  -h, --help             Show this help message`;

export const AUDIT_HELP = `Usage: kinloom audit [person_id] [options]

Run all 5 deterministic package checks in one pass:
  1. Chronology and lifespan arithmetic
  2. Living-person privacy, SSN, phone, and em-dash style scan
  3. Uncited biographical prose sentence audit on body_md
  4. Pure-Node scan inventory and magic-header/dimension verification
  5. In-process integrate dry-run schema, citation, and privacy check

Arguments:
  person_id              Target person ID in data/people.yaml (positional or --person)

Options:
  --person <person_id>   Target person ID in data/people.yaml (required if positional omitted)
  --repo <dir>           Archive repository root (default: current working directory)
  --package-dir <dir>    Custom research package directory (default: <repo>/research/people/<person_id>)
  --json                 Emit structured JSON scorecard
  -h, --help             Show this help message`;

export const SYNC_HELP = `Usage: kinloom sync [options]

Synchronize local YAML and media files to a live Cloudflare D1 + R2 Kinloom archive.

Options:
  --repo <dir>              Archive repository root (default: current working directory)
  --site-url <url>          Live archive URL (default: derived from wrangler.jsonc routes[0].pattern)
  --types <csv>             Comma-separated entity types to sync (default: all 7 in dependency order)
  --sync-missing-media      Probe live /media/* paths from media.yaml and upload missing files to R2
  --upload-media <paths...> Upload one or more local media files to R2 in parallel
  --concurrency <N>         Parallel R2 upload concurrency (default: 6)
  --chunk-size <N>          Max patches per POST /api/batches request (default: 25)
  --summary <text>          Batch revision summary (minimum 3 characters)
  --allow-deletes           Emit delete patches for remote entities absent locally
  --delete <type:id,...>    Explicitly soft-delete specific remote entities (e.g. narrative:nar_old)
  --include-living          Include living person records in diff and sync
  --dry-run                 Compute diff and planned actions without mutating remote D1 or R2
  --json                    Emit structured JSON report
  -h, --help                Show this help message`;

export const TELEMETRY_HELP = `Usage: kinloom telemetry report [options]

Summarize local CLI invocation latency, cache hit rate, and failure rate by subcommand.

Options:
  --since-hours <N>  Restrict summary to events recorded within the last N hours
  --file <path>      Override telemetry JSONL file path (default: KINLOOM_TELEMETRY_FILE or ~/.cache/kinloom-telemetry/calls.jsonl)
  --json             Emit structured JSON report instead of a ranked table
  -h, --help         Show this help message`;
