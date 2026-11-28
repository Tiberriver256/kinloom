export const MEDIA_HELP = `Usage: kinloom media dedupe [options]

Inspect and safely merge duplicate normalized file paths in data/media.yaml.
Runs in read-only dry-run mode by default; pass --apply to write changes atomically with rollback.

Subcommands:
  dedupe                 Detect duplicate file paths, select a deterministic canonical record per group, merge metadata, and rewire narrative citations and extension refs

Options:
  --repo <dir>           Archive repository root (default: current working directory)
  --prefer <media_id>    Prefer a specific media_id as canonical survivor (repeatable; conflicting IDs in one group exit 2)
  --apply                Write merged YAML atomically after full in-memory validation (default: dry-run)
  --json                 Emit structured JSON merge and rewrite report
  -h, --help             Show this help message`;

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
  --pending-only         With --all-staged, skip already-integrated packages (matching .integrated.json receipts or legacy live-superseded packages; broken or modified packages stay pending).
  --mark-integrated      With --all-staged --pending-only, backfill .integrated.json receipts for legacy already-integrated packages without mutating data/*.yaml (alias: --reconcile-receipts).
  --repo <dir>           Archive repository root (default: current working directory)
  --package <dir>        Custom research package directory or patch.json path for a single person (aliases: --package-dir, --patch)
  --package-dir <dir>    Custom research package directory or patch.json path for a single person (default: <repo>/research/people/<person_id>)
  --dry-run              Validate schemas, citations, scans, and privacy without writing files
  --json                 Emit structured JSON summary (single-person object, or batch object with mode: "batch")
  -h, --help             Show this help message`;

export const AUDIT_HELP = `Usage: kinloom audit [person_id ...] [options]

Run all 6 deterministic package checks (plus site plugin auditChecks) in one pass:
  1. Chronology and lifespan arithmetic (including staged patch.people entries)
  2. Living-person privacy, SSN, phone, and em-dash style scan
  3. Uncited biographical prose sentence audit on body_md
  4. Pure-Node scan inventory and magic-header/dimension verification
  5. In-process integrate dry-run schema, citation, and privacy check
  6. Pronunciation audit (living leaks fail; missing/partial coverage, missing provenance, or live pronunciation deletion warn and fail --strict)
  7. Site plugin auditChecks (auto-discovered from extensions/*/cli.{mjs,js} and kinloom.config.yaml plugins)

Accepts person_id defined in data/people.yaml or newly staged in patch.people.
One person id keeps the original text report and the original JSON scorecard.
Two or more person ids, or --all-staged, audit each package in order and then report cross-package overlaps.

Arguments:
  person_id              One person id, or several person ids. Use a positional id or --person for one person.

Options:
  --person <person_id>   One person id (alias: --person-id). Do not combine with positional ids.
  --all-staged           Audit every research/people/<id>/patch.json package. Ids are sorted. Do not pass person ids with this flag.
  --pending-only         With --all-staged, skip already-integrated packages and list them in skippedAlreadyIntegrated (broken packages stay pending).
  --repo <dir>           Archive repository root (default: current working directory)
  --package <dir>        Custom Research Package directory or patch.json path for a single person (aliases: --package-dir, --patch)
  --package-dir <dir>    Custom Research Package directory or patch.json path for a single person (default: <repo>/research/people/<person_id>)
  --strict               Exit non-zero when a package fails its strict scorecard:
                           - Uncited biographical prose or em-dash style violations
                           - Newly introduced tree-hygiene warnings (duplicate vital events, child marriage, parent-child chronology anomalies, excess non-adoptive parents, or placeholder event titles)
                           - Live-media file collision when a staged file already belongs to a different id in data/media.yaml
                           - In batch mode: conflicting scan SHA-256 bytes for the same basename, conflicting media ids on one file path, conflicting patch.people fields/slugs, or contradictory kinship add vs remove_kinship edges
                           (Identical scan bytes, shared media ids, identical patch.people rows, and updates to the same live media id pass.)
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
When that file is absent, the defaults are the current UTC year for referenceYear and livingCutoffYears 101.`;

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

  8. Pronunciation audit (living-person pronunciation leaks fail; coverage gaps warn unless --strict-pronunciation or --strict is set)
  9. External media/audio URL CSP check (flags non-local audio_url, token_audio_urls, portrait_url, or media asset URLs pointing to external hosts; ignores sources.yaml citation URLs; warns unless --strict-external-media or --strict is set)
  10. Tracked binary media check (flags .mp3, .wav, or .mp4 files tracked in Git via git ls-files; warns unless --strict-tracked-media or --strict is set)
  11. Site plugin verifyChecks (auto-discovered from extensions/*/cli.{mjs,js} and kinloom.config.yaml plugins)

Options:
  --repo <dir>              Archive repository root (default: current working directory)
  --strict-hygiene          Fail verification (exit 1) when any tree-hygiene warning is found
  --strict-pronunciation    Fail verification (exit 1) when any pronunciation coverage or provenance warning is found
  --strict-external-media   Fail verification (exit 1) when any rendered media/audio asset points to an external host
  --strict-tracked-media    Fail verification (exit 1) when any .mp3, .wav, or .mp4 binary is tracked in Git
  --strict                  Enable --strict-hygiene, --strict-pronunciation, --strict-external-media, --strict-tracked-media, and plugin strictFailures
  --json                    Emit structured JSON scorecard (includes hygiene.warnings, externalMedia.hits, trackedMedia.files)
  -h, --help                Show this help message`;

export const SYNC_HELP = `Usage: kinloom sync [options]

Synchronize local YAML and media files to a live Cloudflare D1 + R2 Kinloom archive.

Options:
  --repo <dir>              Archive repository root (default: current working directory)
  --site-url <url>          Live archive URL (alias: --site; default: derived from wrangler.jsonc/json/toml routes[0].pattern)
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

Deterministic UTC Gregorian, historical Julian (OS), and Swedish (1700-1753) calendar arithmetic.

Subcommands:
  weekday <YYYY-MM-DD> [--json]
      Print the weekday and formatted date (e.g., Monday, 7 February 1898)

  diff <start-YYYY-MM-DD> <end-YYYY-MM-DD> [--json]
      Compute exact totalDays, years, remainingDays, yearsMonthsDays, weekdays, and direction

  age <birth-YYYY-MM-DD> --at <YYYY-MM-DD> [--at <YYYY-MM-DD> ...] [--json]
      Compute completed age in years, remaining days, and total days at one or more dates
      (also accepts positional event date(s) when --at is omitted)

  convert <YYYY-MM-DD> --from julian|swedish|gregorian --to gregorian|julian|swedish [--region gb|se-fi|nl] [--json]
      Convert historical dates across Julian (OS), Swedish (1700-1753, including 1712-02-30), and
      Gregorian (NS) calendars using exact Julian Day Number (JDN) arithmetic

Options:
  --at <YYYY-MM-DD>                  Target event date for \`age\` (repeatable)
  --from <julian|swedish|gregorian>  Source calendar system for \`convert\`
  --to <gregorian|julian|swedish>    Target calendar system for \`convert\`
  --region <gb|se-fi|nl>             Optional regional transition context for \`convert\`
  --json                             Emit structured JSON output
  -h, --help                         Show this help message`;

export const PRONOUNCE_HELP = `Usage: kinloom pronounce <subcommand> [arguments] [options]

Look up verified IPA and audio from Wikimedia and run Pronunciation Audits over an archive.

Subcommands:
  lookup <term> [--lang nl|sv|fi|pl|de|en] [--refresh] [--json]
      Query Wiktionary and Wikipedia (disk-cached in ~/.cache/kinloom-pronounce/)
      for verified IPA transcriptions, Wikimedia Commons native audio URLs, and
      canonical source citations. Never fabricates IPA when upstream has none.

  audit [--repo <path>] [--strict] [--json]
      Run a 100%-coverage Pronunciation Audit over kinloom.config.yaml, every
      confirmed-deceased person in data/people.yaml (full-name coverage), and
      every place in data/places.yaml. Verifies 0 living people have any
      pronunciation entry (fails loudly on any living leak), and reports
      surname-only fallbacks, missing places, homonymous bare place collisions,
      unsourced entries, IPA symbols inside phonetic (Respelling), redundant
      per-person overrides, and IPA quality warnings.

  deduplicate [--repo <path>] [--apply] [--promote-tokens] [--force] [--json]
      Dry-run by default. Finds deceased people whose explicit person.pronunciation
      override is 100% losslessly redundant because shared lexicon tokens already
      resolve full-name coverage with matching Respelling and IPA (without dropping
      unique notes, variants, or custom audio). Pass --promote-tokens to safely
      promote unambiguous missing single tokens into kinloom.config.yaml, and
      --apply to write YAML updates.

  synth [--repo <path>] [--backend gemini|openai-speech] [--endpoint <url>] [options]
      Batch-synthesize privacy-filtered pronunciation clips into media/ with
      deterministic v2 SHA-256 filenames (pronunciation-<hash>.wav|mp3). Supports
      live Gemini TTS, OpenAI-compatible /v1/audio/speech GPU servers (such as
      SGLang-Omni on Google Colab G4), or offline --export-manifest / --import-dir
      workflows. Strictly excludes living people (0 living leaks).

Options:
  --lang <code>            Language filter for \`lookup\` (e.g. nl, sv, fi, pl, de, en)
  --refresh                Bypass disk cache on \`lookup\` and re-fetch from Wikimedia
  --repo <dir>             Archive repository root for \`audit\`, \`deduplicate\`, and \`synth\` (default: current directory)
  --strict                 Exit non-zero if any deceased person lacks full-name coverage, any place lacks coverage, any homonymous collision exists, any IPA symbol appears inside phonetic (Respelling), or any living leak exists
  --apply                  Write YAML updates in \`deduplicate\` (dry-run by default)
  --promote-tokens         Promote unambiguous single missing tokens into the shared lexicon during \`deduplicate\`
  --force                  In \`deduplicate\`, override differing Respelling/IPA; in \`synth\`, regenerate existing files and overwrite config audio_url
  --backend <id>           TTS backend for \`synth\`: gemini (default) or openai-speech
  --endpoint <url>         Base URL for OpenAI-compatible /v1/audio/speech server (or KINLOOM_TTS_ENDPOINT)
  --api-key <secret>       Bearer/API key override (or OPENAI_SPEECH_API_KEY / GEMINI_API_KEY)
  --model <id>             Model ID (default: fishaudio/drama-3 for openai-speech, gemini-3.8-flash-tts for gemini)
  --voice <name>           Voice name (default: Charon)
  --phoneme-mode <mode>    Phoneme formatting for \`synth\`: ipa (default), arpabet, or plain
  --ref-audio <path>       Reference audio clip for zero-shot voice cloning (openai-speech)
  --ref-text <text>        Transcript of --ref-audio for voice cloning (openai-speech)
  --out-dir <dir>          Output directory for synthesized clips (default: <repo>/media)
  --format <wav|mp3>       Output audio format for \`synth\` (default: wav, 24 kHz mono -16 LUFS)
  --scope <mode>           Target set for \`synth\`: lexicon, curated (default), or all
  --skip-existing          Skip targets whose cached audio file already exists (default: true)
  --update-config          Write /media/pronunciation-<hash>.<ext> into audio_url in kinloom.config.yaml
  --export-manifest <path> Export privacy-filtered batch JSON manifest for offline/Colab rendering
  --import-dir <dir>       Import rendered clips matching v2 filenames from a directory into --out-dir
  --concurrency <N>        Parallel synthesis workers (default: 2 for gemini, 4 for openai-speech)
  --dry-run                Preview planned targets without calling TTS APIs or writing audio files
  --json                   Emit structured JSON output
  -h, --help               Show this help message

Environment variables:
  KINLOOM_PRONOUNCE_CACHE_DIR  Override disk cache directory (default ~/.cache/kinloom-pronounce)
  KINLOOM_TTS_ENDPOINT         Default endpoint URL for \`--backend openai-speech\`
  OPENAI_SPEECH_API_KEY        Optional Bearer token for \`--backend openai-speech\``;

export const MIGRATE_HELP = `Usage: kinloom migrate [options]

Inspect a Kinloom Cloudflare D1 database and idempotently apply only pending SQL migrations.
Checks sqlite_master and PRAGMA table_info(...) so existing databases created before d1_migrations tracking existed never fail on already-present tables or columns.
Auto-discovers enabled built-in @kinloom/server plugin SQL migrations (such as recipes and book-publishing) from kinloom.config.yaml and worker entry files alongside <repo>/migrations/plugins/.

Options:
  --repo <dir>                  Archive repository root containing wrangler.jsonc, wrangler.json, or wrangler.toml (default: current directory)
  --plugin-migrations <dir>     Optional directory containing namespaced plugin migrations (<dir>/<namespace>/<NNNN>_<id>.sql); auto-discovers <repo>/migrations/plugins when present
  --include-enabled-plugins     Auto-discover and apply enabled built-in @kinloom/server plugin SQL migrations (default: true)
  --no-include-enabled-plugins  Skip auto-discovery of built-in @kinloom/server plugin SQL migrations
  --remote                      Target the remote Cloudflare D1 database (default)
  --local                       Target the local Wrangler D1 database
  --dry-run                     Inspect schema and report applied vs pending migrations without executing any writes
  --json                        Emit structured JSON status and verification report
  -h, --help                    Show this help message`;

export const SCREENSHOTS_HELP = `Usage: kinloom screenshots --url <baseUrl> [options]

Export full-page UI review screenshots, interactive component states, and plugin screens
from any live Kinloom server URL, along with a machine-readable manifest.json and
zero-dependency browsable index.html contact sheet.

Options:
  --url <baseUrl>             Target Kinloom server URL (required unless derived via --with-temp-auth)
  --repo <dir>                Archive repository root for --with-temp-auth wrangler lookup (default: cwd)
  --out-dir <dir>             Output directory (default: ./kinloom-screenshots)
  --viewports <list>          Comma-separated presets or name:WxH specs
                              (default: mobile:390x844,tablet:768x1024,desktop:1440x900)
  --themes <light,dark>       Color schemes to capture (default: light,dark)
  --include <scopes>          Capture categories: pages,components,plugins (default: all)
  --routes <csv>              Optional extra page routes (repeatable or comma-separated)
  --plugin-routes <csv>       Optional explicit plugin routes to capture under plugins/
  --sample-people <N>         Representative person dossiers discovered from bundle (default: 1)
  --sample-places <N>         Representative place dossiers discovered from bundle (default: 1)
  --auth-cookie <cookie>      Optional Cookie header for authenticated previews (never saved)
  --auth-header <name: value> Optional HTTP header for authenticated previews (repeatable, never saved)
  --with-temp-auth            Mint and auto-revoke a temporary D1 viewer invite via Wrangler
  --full-page                 Capture full scrollable page height (default: true)
  --no-full-page              Capture viewport-only height for page screenshots
  --wait-ms <ms>              Settle delay after load and font readiness (default: 350)
  --timeout-ms <ms>           Per-capture timeout in milliseconds (default: 20000)
  --concurrency <N>           Parallel viewport/theme contexts (default: 2, max: 8)
  --json                      Emit structured JSON summary and manifest
  -h, --help                  Show this help message`;

export const DESIGN_AUDIT_HELP = `Usage: kinloom design-audit [subcommand] [options]

Run deterministic-first UI/UX design audits (APCA 0.0.98G-4g-base-W3, WCAG 2.2 AA/AAA,
W3C DTCG 2025.10 tokens, CSS entropy, UI Stack states, OASIS SARIF 2.1.0, and Executive Dossier).

Subcommands:
  run (default)        Run full Playwright capture + deterministic probes + CSS/DTCG + SARIF 2.1.0
  init                 Scaffold a starter design-audit plan JSON file
  css                  Run offline CSS entropy and W3C DTCG 2025.10 token checks
  sarif                Aggregate bundle findings into SARIF 2.1.0 + Executive Dossier with baseline ratchet
  archetypes           Inspect calibrated UI archetypes (editorial, saas, ecommerce, mobile-app)
  standards            Print pinned WCAG/APCA/DTCG/ISO/SARIF standards

Options:
  --url <baseUrl>      Target server URL (e.g. http://127.0.0.1:4173); omits live capture if absent
  --plan <path>        Path to an existing design-audit plan JSON
  --out-dir <dir>      Output artifact bundle directory (default: .audit-artifacts/<run-id>)
  --repo <dir>         Repository root for CSS and DTCG token discovery (default: cwd)
  --archetype <id>     UI archetype: editorial (default), saas, ecommerce, or mobile-app
  --routes <csv>       Comma-separated or repeatable route paths (default: /)
  --themes <csv>       Color schemes: light, dark, more-contrast (default: light,dark)
  --states <csv>       UI Stack states: ideal, loading, empty-first, empty-zero, partial, error
  --css <path>         Explicit CSS file path(s) to audit (repeatable or comma-separated)
  --tokens <path>      Explicit .tokens.json or .resolver.json path(s) (repeatable or comma-separated)
  --bundle <dir>       Existing artifact bundle directory (for \`css\` and \`sarif\`)
  --baseline <sarif>   Baseline SARIF 2.1.0 file for ratchet regression diffing
  --auth-cookie <str>  Optional Cookie header for authenticated private-archive audits (never saved)
  --auth-header <hdr>  Optional HTTP header (\`Name: value\`, repeatable, never saved)
  --with-temp-auth     Mint and auto-revoke a temporary D1 viewer invite via Wrangler
  --static-only        Skip browser capture and run static CSS/DTCG checks only
  --fail-on-error      Exit with code 1 when any blocking error finding is detected
  --force              Overwrite existing plan file in \`init\`
  --json               Emit structured JSON output
  --guide              Show the embedded design-audit workflow guide
  -h, --help           Show this help message`;

export const VERIFY_LIVE_HELP = `Usage: kinloom verify-live [options]

Verify a live Kinloom deployment end to end with automatic ephemeral Cloudflare D1 auth:
  1. Anonymous GET /api/bundle returns HTTP 401 (privacy gate active)
  2. Authenticated synthetic probe + plugin health checks (--expect-plugins)
  3. Live /api/bundle living-person privacy invariants (0 living portraits, 0 exact YYYY-MM-DD living birthdates, 0 living residence spans, 0 living media/narratives)
  4. Optional headless Playwright smoke check (--browser: visible H1, 0 pageerror, 0 failed /assets/* or /api/* requests)
  5. Optional PWA & brandkit asset checks (--check-pwa: /site.webmanifest, /sw.js, /favicon-light.svg, /favicon-dark.svg)
  6. Guaranteed ephemeral D1 cleanup (backupCount === 1 before/after and remainingTmpCount === 0)

Options:
  --repo <dir>            Archive repository root for wrangler config lookup (default: cwd)
  --url <url>             Target archive URL (default: derived from wrangler routes[0].pattern)
  --token <secret>        Explicit bearer token (skips ephemeral D1 auth)
  --with-temp-auth        Require ephemeral D1 auth (default when --token is omitted and wrangler config exists)
  --expect-plugins <csv>  Comma-separated server plugin IDs required to be active and healthy
  --browser               Run headless Playwright smoke check against / using an ephemeral viewer invite
  --check-pwa             Verify /site.webmanifest, /sw.js, /favicon-light.svg, and /favicon-dark.svg
  --timeout-ms <ms>       Per-request/check timeout in milliseconds (default: 15000)
  --json                  Emit machine-readable JSON verification report
  --guide                 Show the embedded verify-live workflow guide
  -h, --help              Show this help message`;

export const QUERY_HELP = `Usage: kinloom query <target> [options]

Read-only schema-aware inspection of local archive YAML files and kinship traversal.
Defaults strictly to confirmed-deceased records unless --include-living is passed on a local private repository.

Targets:
  people       Query data/people.yaml (supports living/deceased filters and bounded BFS kinship traversal)
  places       Query data/places.yaml
  events       Query data/events.yaml
  narratives   Query data/narratives.yaml
  sources      Query data/sources.yaml
  media        Query data/media.yaml
  schema       Report entity counts and exact key frequencies across all data/*.yaml files

Options:
  --repo <dir>             Archive repository root (default: current working directory)
  --deceased               Restrict \`people\` to confirmed-deceased records (default)
  --living                 Restrict \`people\` to effective-living records (requires --include-living)
  --include-living         Include effective-living records on a local private repository
  --descendants-of <id>    Run bounded BFS descendant traversal from person <id> with generation grouping & spouse pairing
  --ancestors-of <id>      Run bounded BFS ancestor traversal from person <id> with generation grouping & spouse pairing
  --depth <N>              Max BFS generation depth for traversal (non-negative integer, default: 6)
  --match <regex>          Case-insensitive regex filter across record field values
  --kind <k>               Filter by entity kind/type (place_type, event_kind/scope/category, narrative kind, source_type, media kind)
  --missing <field>        Filter to records missing a field (dot-paths supported, e.g. death_edtf, pronunciation.ipa)
  --person <id>            Filter places, events, narratives, sources, or media associated with person <id>
  --fields <csv>           Comma-separated list of fields to project in table and JSON output
  --json                   Emit deterministic structured JSON instead of compact text/table output
  -h, --help               Show this help message`;

export const PATCH_HELP = `Usage: kinloom patch <file-or-stdin> [options]

Transactionally validate and apply a multi-entity JSON or YAML patch document across
people, places, events, kinship, sources, media, and narratives in local data/*.yaml files.
Validates every entry against @kinloom/core Zod schemas, checks referential integrity and
dual-mode archive compilation invariants, and writes deterministic sorted YAML atomically
with byte-for-byte rollback on error.

Living people are rejected by default. Pass --allow-living to explicitly permit
privacy-compliant living-person entries (enforces explicit is_living: true, zero portraits,
zero full YYYY-MM-DD DOBs, and zero residence spans).

Arguments:
  file-or-stdin          Path to a JSON or YAML patch file, or \`-\` to read from stdin

Options:
  --repo <dir>           Archive repository root (default: current working directory)
  --file <path>          Alias for positional <file-or-stdin>
  --dry-run              Validate schemas, invariants, and diff summary without writing files
  --allow-living         Explicitly permit privacy-compliant living-person records (default: false)
  --json                 Emit deterministic structured JSON summary
  -h, --help             Show this help message`;
