export const CONTEXT_HELP = `Usage: kinloom context [person_id] [options]

Produce a privacy-fenced single-shot research context brief for a deceased person.

Arguments:
  person_id              Target person ID in data/people.yaml (positional or --person)

Options:
  --person <person_id>   Target person ID in data/people.yaml (required if positional omitted)
  --repo <dir>           Archive repository root (default: current working directory)
  --ancestry-dir <dir>   Optional external facts JSON export directory (or set KINLOOM_ANCESTRY_FACTS_DIR)
  --include-family       Also include record images for confirmed-deceased children and siblings
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

export const AUDIT_HELP = `Usage: kinloom audit [person_id ...] [options]

Run all 5 deterministic package checks in one pass:
  1. Chronology and lifespan arithmetic
  2. Living-person privacy, SSN, phone, and em-dash style scan
  3. Uncited biographical prose sentence audit on body_md
  4. Pure-Node scan inventory and magic-header/dimension verification
  5. In-process integrate dry-run schema, citation, and privacy check

One person id keeps the original text report and the original JSON scorecard.
Two or more person ids, or --all-staged, audit each package in order and then report cross-package overlaps.

Arguments:
  person_id              One person id, or several person ids. Use a positional id or --person for one person.

Options:
  --person <person_id>   One person id. Do not combine --person with positional ids.
  --all-staged           Audit every research/people/<id>/patch.json package. Ids are sorted. Do not pass person ids with this flag.
  --repo <dir>           Archive repository root (default: current working directory)
  --package-dir <dir>    Custom research package directory for a single person (default: <repo>/research/people/<person_id>)
  --strict               Exit non-zero when a package fails its strict scorecard (uncited prose or an em dash). In a batch, also exit non-zero when two packages stage the same scan basename with different SHA-256 bytes, or when two packages point the same media file path at different media ids. Identical scan bytes and a shared media id do not fail --strict. A staged file that already belongs to a different id in data/media.yaml is reported and does not change the exit code.
  --json                 Emit structured JSON. A batch object is { ok, strictOk, repo, people, overlaps, summary, duration_ms }.
  -h, --help             Show this help message`;

export const VERIFY_HELP = `Usage: kinloom verify [options]

Run full-archive invariants across local data/*.yaml files:
  1. Narrative inline citation integrity (0 dangling src_id or med_id)
  2. Place coordinate validation (-90..90, -180..180, finite, no (0, 0))
  3. SSN pattern scan across all data/*.yaml files
  4. Dual-mode compilation (private and public) with 0 review flags, 0 living leaks, and 0 duplicate residence_spans
  5. Media file presence on disk under archive-media/ or media/

Options:
  --repo <dir>   Archive repository root (default: current working directory)
  --json         Emit structured JSON scorecard
  -h, --help     Show this help message`;

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
  --verify-live             Probe live /api/bundle and every newly uploaded R2 object before revoking temp tokens
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

export const DATES_HELP = `Usage: kinloom dates <subcommand> [arguments] [options]

Deterministic UTC Gregorian calendar arithmetic (leap-year safe across 1600-2100+).

Subcommands:
  weekday <YYYY-MM-DD> [--json]
      Print the weekday and formatted date (e.g., Monday, 7 February 1898)

  diff <start-YYYY-MM-DD> <end-YYYY-MM-DD> [--json]
      Compute exact totalDays, years, remainingDays, yearsMonthsDays, weekdays, and direction

  age <birth-YYYY-MM-DD> --at <YYYY-MM-DD> [--at <YYYY-MM-DD> ...] [--json]
      Compute completed age in years, remaining days, and total days at one or more dates
      (also accepts positional event date(s) when --at is omitted)

Options:
  --at <YYYY-MM-DD>  Target event date for \`age\` (repeatable)
  --json             Emit structured JSON output
  -h, --help         Show this help message`;
