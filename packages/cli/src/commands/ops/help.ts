export const CONTEXT_HELP = `Usage: kinloom context [person_id] [options]

Produce a privacy-fenced single-shot research context brief for a deceased person.

Arguments:
  person_id              Target person ID in data/people.yaml (positional or --person)

Options:
  --person <person_id>   Target person ID in data/people.yaml (required if positional omitted)
  --repo <dir>           Archive repository root (default: current working directory)
  --ancestry-dir <dir>   Optional external facts JSON export directory (or set KINLOOM_ANCESTRY_FACTS_DIR)
  --include-family       Also include record images for confirmed-deceased children and siblings, plus live data/media.yaml items for confirmed-deceased parents, spouses, children, and siblings
  --json                 Emit structured JSON instead of compact Markdown
  -h, --help             Show this help message`;

export const INTEGRATE_HELP = `Usage: kinloom integrate [person_id ...] [options]

Validate and integrate one or more person research packages (patch.json + scans/) into local YAML files.
Supports patch.people to add newly proven deceased ancestors (including when person_id itself is introduced by patch.people).
Supports patch.remove_kinship ([{ from, to, relation, family_xref?, symmetric? }]) to retire disproved parent, child, or spouse edges before upserting patch.kinship; symmetric defaults to true and removes the reciprocal edge automatically.
Living people and slug collisions are always rejected.

One person id keeps the original single-person text summary and JSON output.
Two or more person ids, or --all-staged, run in batch mode with:
  - Pre-flight cross-package and live-media overlap checking before any file is mutated
  - Sequential dry-run isolation so later packages see earlier packages' staged changes
  - All-or-nothing transactional rollback of data/*.yaml and newly staged scans if any package fails

Arguments:
  person_id              One person id, or several person ids. Use a positional id or --person for one person.

Options:
  --person <person_id>   Single target person ID in data/people.yaml or patch.people (alias: --person-id). Do not combine with positional ids or --all-staged.
  --all-staged           Integrate every research/people/<id>/patch.json package in sorted order. Do not pass person ids with this flag.
  --pending-only         With --all-staged, skip packages whose dry-run diff has no unintegrated changes (broken packages stay pending).
  --repo <dir>           Archive repository root (default: current working directory)
  --package <dir>        Custom research package directory or patch.json path for a single person (aliases: --package-dir, --patch)
  --package-dir <dir>    Custom research package directory or patch.json path for a single person (default: <repo>/research/people/<person_id>)
  --dry-run              Validate schemas, citations, scans, and privacy without writing files
  --json                 Emit structured JSON summary (single-person object, or batch object with mode: "batch")
  -h, --help             Show this help message`;

export const AUDIT_HELP = `Usage: kinloom audit [person_id ...] [options]

Run all 5 deterministic package checks in one pass:
  1. Chronology and lifespan arithmetic (including staged patch.people entries)
  2. Living-person privacy, SSN, phone, and em-dash style scan
  3. Uncited biographical prose sentence audit on body_md
  4. Pure-Node scan inventory and magic-header/dimension verification
  5. In-process integrate dry-run schema, citation, and privacy check

Accepts person_id defined in data/people.yaml or newly staged in patch.people.
One person id keeps the original text report and the original JSON scorecard.
Two or more person ids, or --all-staged, audit each package in order and then report cross-package overlaps.

Arguments:
  person_id              One person id, or several person ids. Use a positional id or --person for one person.

Options:
  --person <person_id>   One person id. Do not combine --person with positional ids.
  --all-staged           Audit every research/people/<id>/patch.json package. Ids are sorted. Do not pass person ids with this flag.
  --pending-only         With --all-staged, skip already-integrated packages and list them in skippedAlreadyIntegrated (broken packages stay pending).
  --repo <dir>           Archive repository root (default: current working directory)
  --package-dir <dir>    Custom research package directory for a single person (default: <repo>/research/people/<person_id>)
  --strict               Exit non-zero when a package fails its strict scorecard (uncited prose, an em dash, or newly introduced tree-hygiene warnings such as duplicate vital events, child marriage, parent-child chronology anomalies, excess non-adoptive parents, or placeholder event titles). A single person and a batch both exit non-zero when a staged file already belongs to a different id in data/media.yaml. In a batch, also exit non-zero when two packages stage the same scan basename with different SHA-256 bytes, point the same media file path at different media ids, define the same patch.people id with conflicting fields, reuse the same patch.people slug for different person ids, or contradict each other by adding a kinship edge that another package lists in remove_kinship. Identical scan bytes, a shared media id, identical patch.people rows, and an update of the same live media id do not fail --strict.
  --json                 Emit structured JSON. A batch object is { ok, strictOk, repo, people, overlaps, summary, skippedAlreadyIntegrated?, duration_ms }.
  -h, --help             Show this help message`;

export const STATUS_HELP = `Usage: kinloom status [options]

Read-only archive totals and a biography queue for confirmed-deceased people.
Living people affect only the integer people.living count.
The command does not print a living person's id, name, or birth date.

Options:
  --repo <dir>                             Archive repository root (default: current working directory)
  --limit <N>                              Text list length. Default 8. 0 shows every matching row.
  --filter <pending|staged|done_live>      Text list status. Default pending (or all statuses when --end-of-line or --missing-biography is set without --filter).
  --sort <sparsest|richest|chronological>  Queue sort order. Default sparsest.
  --end-of-line                            Filter queue to confirmed-deceased end-of-line ancestors (>= 1 child and 0 parents in kinship.yaml).
  --missing-biography                      Filter queue to confirmed-deceased people lacking an individual biography narrative (combinable with --filter, --sort, --limit, --end-of-line, --json).
  --json                                   Emit the status object as JSON
  -h, --help                               Show this help message

Text output prints the totals, biography coverage, queue counts, and a list of deceased people with a Bio=yes/no column.
The list uses --filter, --sort, --end-of-line, --missing-biography, and stops after --limit rows.
JSON ignores --limit and --filter.
JSON applies --sort, --end-of-line, and --missing-biography, includes sort, endOfLine, endOfLineCount, missingBiography, and biographies coverage, and returns the matching deceased array and queue counts.

JSON object:
  repo                       Absolute repository path
  sort                       Active queue sort mode (sparsest, richest, or chronological)
  endOfLine                  true when --end-of-line filtering is active
  endOfLineCount             Confirmed-deceased ancestors with >= 1 child and 0 parents in data/kinship.yaml
  missingBiography           true when --missing-biography filtering is active
  people.total               Rows in data/people.yaml
  people.deceased            People who are not effective-living
  people.living              People who are effective-living (count only)
  events                     Rows in data/events.yaml
  places                     Rows in data/places.yaml
  zeroCoordPlaces            Places whose latitude and longitude are both within 1e-9 of 0
  sources                    Rows in data/sources.yaml
  media                      Rows in data/media.yaml
  narratives                 Rows in data/narratives.yaml
  biographies.complete       Confirmed-deceased people with an individual kind=biography narrative
  biographies.missing        Confirmed-deceased people lacking an individual kind=biography narrative
  biographies.totalDeceased  Total confirmed-deceased people in data/people.yaml
  queue.done_live            Deceased people in the active queue with a biography narrative
  queue.staged               Deceased people in the active queue with research/people/<id>/patch.json and no biography
  queue.pending              Deceased people in the active queue with neither a biography nor a staged patch
  deceased                   Deceased people only (ordered pending, staged, done_live; or directly by --sort when --end-of-line is set)

Each deceased item has:
  id, full_name, birth_edtf, death_edtf
  events               Distinct events that list the person in participants
  sources              Distinct source ids on those events
  media                Distinct media rows whose person_id or person_ids include the person
  hasBiography         true when a biography narrative has subject_person_id equal to id (also exposed as has_biography)
  biographyId          Matching biography narrative id, or null when missing
  has_staged_patch     true when research/people/<id>/patch.json exists
  status               done_live if hasBiography, else staged if has_staged_patch, else pending

Within each status group (pending, staged, done_live), items sort by --sort:
  sparsest       events asc, sources asc, media asc, birthYear asc (null last), id asc
  richest        events desc, sources desc, media desc, birthYear asc (null last), id asc
  chronological  birthYear asc (null last), deathYear asc (null last), events asc, id asc
Effective living status uses resolveEffectiveLiving with privacy.referenceYear and privacy.livingCutoffYears from kinloom.config.yaml.
When that file is absent, the defaults are referenceYear 2026 and livingCutoffYears 101.`;

export const VERIFY_HELP = `Usage: kinloom verify [options]

Run full-archive invariants across local data/*.yaml files:
  1. Narrative inline citation integrity (0 dangling src_id or med_id)
  2. Place coordinate validation (-90..90, -180..180, finite, no (0, 0))
  3. SSN pattern scan across all data/*.yaml files
  4. Dual-mode compilation (private and public) with 0 review flags, 0 living leaks, and 0 duplicate residence_spans
  5. Media file presence on disk under archive-media/ or media/, and no two media ids share one normalized file path
  6. Living-name scan of public text. The scan reads narrative title, summary, and body after public redaction. It reads captions and provenance of media that public export keeps. It reads source citations. It reads titles and summaries of events that have no living participant. Living-only events and other events with a living participant are omitted, because public export drops or redacts them.
  7. Tree hygiene diagnostics (warnings by default; fail only with --strict-hygiene):
     - Excess parents (>2 non-adoptive parents or >1 non-adoptive mother/father)
     - Parent-child chronology (child born before parent age 13, after mother's death, or >1 year after father's death)
     - Child marriage (spouse with known birth year under age 14 at marriage date)
     - Duplicate vital events (multiple births/deaths on one person, or duplicate marriages for one couple)
     - Empty GEDCOM placeholder events (title starting with "Recorded event for ")

Options:
  --repo <dir>       Archive repository root (default: current working directory)
  --strict-hygiene   Fail verification (exit 1) when any tree-hygiene warning is found
  --json             Emit structured JSON scorecard (includes hygiene.warnings and hygiene.counts)
  -h, --help         Show this help message`;

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
