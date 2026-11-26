# Pure-TypeScript CLI migration blueprint (Waves 55B to 57)

**Date:** 2026-11-26  
**Baseline commit:** `f856dc6`  
**Target package:** `@kinloom/cli` (`packages/cli`)  
**Goal:** Migrate every archival research CLI, scan-prep tool, OCR wrapper, narrative-audio tool, and research guide into native TypeScript inside `@kinloom/cli`, then delete `skills/`, `packages/cli/assets/*.py`, `packages/cli/scripts/bundle-skills.mjs`, the `uv`/`python3` runner bridge, and `astral-sh/setup-uv` from CI.

Every file count, line count, dependency, subcommand, alias, environment variable, and test count in this blueprint comes directly from inspecting the repository at `f856dc6`. Regenerate the inventory counts at any time with:

```bash
find skills -type f -not -path '*/__pycache__/*' | sort | xargs wc -l
wc -l packages/cli/assets/*.py packages/cli/assets/*.md
```

---

## 1. Complete inventory of Python files and skill directories

At `f856dc6`, Kinloom contains **24 directories** under `skills/` and **2 Python utilities** under `packages/cli/assets/`. No other `.py` files exist under `scripts/`, `packages/` (outside `packages/cli/dist/` build output), `examples/`, or `e2e/`.

### 1.1 Summary totals

| Category | Files | Lines | Notes |
| --- | ---: | ---: | --- |
| Executable Python CLIs in `skills/*/scripts/` | 21 | 22,216 | 20 archival record CLIs and `narrative-audio` |
| Executable Python utilities in `packages/cli/assets/` | 2 | 3,324 | `prep-scan.py` (1,856) and `cached-ocr.py` (1,468) |
| **Total production Python code** | **23** | **25,540** | **100% replaced by TypeScript in `@kinloom/cli`** |
| Python unit test files in `skills/*/tests/test_*.py` | 20 | 10,033 | 207 `test_*` functions, all executed via `records.test.ts` |
| **Total Python code (production + tests)** | **43** | **35,573** | **Reduced to 0 `.py` files in Wave 57** |
| Markdown guides in `skills/*/SKILL.md` | 24 | 3,220 | 21 script-backed, 2 guide-only, 1 duplicate of TS `pronounce` |
| Markdown reference docs in `skills/*/references/` | 1 | 113 | `skills/narrative-audio/references/script-rules.md` |
| Markdown guides in `packages/cli/assets/*.md` | 2 | 256 | `prep-scan.md` (180) and `ocr.md` (76) |
| **Total embedded guide markdown** | **27** | **3,589** | **Moved into `packages/cli/src/guides/`** |

### 1.2 All 24 directories in `skills/`

#### Executable Python CLIs (21 directories)

All `uv` scripts declare `# requires-python = ">=3.11"` in their PEP 723 `# /// script` header. `archive-org` uses `#!/usr/bin/env -S python3 -S` with Python standard library modules only.

| Skill directory | CLI command (aliases) | Script path | Script lines | PEP 723 deps / external binaries | CLI framework & subcommands (aliases) | Test file (lines / `test_*`) | `SKILL.md` lines |
| --- | --- | --- | ---: | --- | --- | --- | ---: |
| `acpl-persi` | `persi` | `skills/acpl-persi/scripts/persi` | 539 | `click>=8.1`, `httpx>=0.27` | Click: `surname`, `title`, `location`, `search`, `url` | `test_persi.py` (165 / 3) | 121 |
| `archive-org` | `archive-org` (`ia`) | `skills/archive-org/scripts/archive-org` | 2,162 | stdlib only (`python3 -S`) | argparse: `search`, `get` (`metadata`, `show`), `download`, `fulltext`, `grep`, `page`, `text`, `lookup`, `url` | `test_archive_org.py` (1,551 / 21) | 190 |
| `california-archives` | `ca-archives` | `skills/california-archives/scripts/ca-archives` | 614 | `click>=8.1`, `httpx>=0.27`, `playwright>=1.49`; Chromium binary for `oac`/`calisphere` | Click: `search`, `url`, `get` | `test_ca_archives.py` (169 / 4) | 149 |
| `chronicling-america` | `chronam` | `skills/chronicling-america/scripts/chronam` | 1,169 | `click>=8.1`, `httpx>=0.27` | Click: `search`, `get`, `page`, `download`, `url` | `test_chronam.py` (650 / 24) | 141 |
| `findagrave` | `findagrave` | `skills/findagrave/scripts/findagrave` | 1,449 | `click>=8.1`, `httpx>=0.27` | Click: `search`, `get` (`memorial`, `show`), `cemetery`, `place`, `photo` (`photos`), `url` | `test_findagrave.py` (818 / 11) | 153 |
| `finnish-archives` | `fi-archives` | `skills/finnish-archives/scripts/fi_archives.py` | 1,330 | `httpx>=0.27` | argparse: `parishes`, `hiski`, `event`, `archives`, `archive`, `url` | `test_fi_archives.py` (291 / 5) | 122 |
| `hathitrust` | `hathi` | `skills/hathitrust/scripts/hathi` | 379 | `click>=8.1`, `httpx>=0.27` | Click: `bib`, `url` | `test_hathi.py` (197 / 4) | 136 |
| `kentucky-archives` | `ky-archives` | `skills/kentucky-archives/scripts/ky-archives` | 646 | `click>=8.1`, `httpx>=0.27` | Click: `cdm`, `cdm-item`, `collections`, `cdm-url`, `land`, `land-patent`, `preservica`, `urls` | `test_ky_archives.py` (168 / 3) | 143 |
| `library-of-michigan` | `michiganology` | `skills/library-of-michigan/scripts/michiganology` | 1,075 | `click>=8.1`; `curl` binary (Preservica TLS WAF) | Click (`AliasedGroup`): `search`, `get` (`item`, `show`, `info`), `download` (`fetch`), `collections`, `url` | `test_michiganology.py` (531 / 14) | 143 |
| `minnesota-archives` | `mn-archives` | `skills/minnesota-archives/scripts/mn_archives.py` | 1,322 | `httpx>=0.27` | argparse: `death`, `birth`, `census`, `vets`, `people`, `record`, `newspapers` (`search`, `metadata`, `download`), `mdl` | `test_mn_archives.py` (413 / 6) | 121 |
| `missouri-archives` | `mo-archives` | `skills/missouri-archives/scripts/mo-archives` | 751 | `click>=8.1`, `httpx>=0.27` | Click: `death`, `pre1910`, `detail`, `download`, `mdh` | `test_mo_archives.py` (157 / 3) | 128 |
| `nara-catalog-search` | `nara` | `skills/nara-catalog-search/scripts/nara` | 2,860 | `click>=8.1`, `httpx>=0.27`, `playwright>=1.49`; optional Chromium binary | Click: `url`, `search`, `get` (`show`), `download`, `census1950`, `census1950-image` | `test_nara.py` (1,855 / 39) | 213 |
| `narrative-audio` | `narrative-audio` | `skills/narrative-audio/scripts/narrative-audio` | 533 | `click>=8.1`, `httpx>=0.27`, `pyyaml>=6.0`; `ffmpeg`, optional `gcloud` | Click: `list`, `extract`, `check`, `synth`, `transcribe` | None (add TS tests in Wave 56) | 83 (+113 ref) |
| `new-jersey-archives` | `nj-archives` | `skills/new-jersey-archives/scripts/nj-archives` | 869 | `click>=8.1`, `httpx>=0.27` | Click: `databases`, `search`, `monmouth`, `url` | `test_nj_archives.py` (222 / 11) | 154 |
| `openarchieven` | `openarchieven` | `skills/openarchieven/scripts/openarchieven` | 1,412 | `click>=8.1`, `httpx>=0.27` | Click: `search`, `show` (`get`), `download`, `url` | `test_openarchieven.py` (741 / 15) | 149 |
| `swedish-archives` | `se-archives` | `skills/swedish-archives/scripts/se_archives.py` | 1,467 | `httpx>=0.27` | argparse: `search`, `births`, `marriages`, `deeds`, `record`, `collection`, `manifest`, `download`, `census` | `test_se_archives.py` (499 / 6) | 137 |
| `texas-archives` | `texas-archives` | `skills/texas-archives/scripts/texas-archives` | 666 | `click>=8.1`, `httpx>=0.27`; `curl` binary (Preservica RSS2) | Click: `portal search`, `portal item`, `tda`, `url` | `test_texas_archives.py` (250 / 4) | 120 |
| `uk-archives` | `uk-archives` | `skills/uk-archives/scripts/uk-archives` | 969 | `click>=8.1`, `httpx>=0.27` | Click: `tna search`, `tna get` (`detail`, `inspect`), `discovery search`, `discovery detail` (`inspect`, `get`), `freereg search`, `url` | `test_uk_archives.py` (472 / 8) | 132 |
| `usgs-gnis` | `gnis` | `skills/usgs-gnis/scripts/gnis` | 427 | `click>=8.1`, `httpx>=0.27` (`zipfile` stdlib) | Click: `download`, `search`, `get`, `url` | `test_gnis.py` (220 / 3) | 117 |
| `virginia-archives` | `va-archives` | `skills/virginia-archives/scripts/va-archives` | 1,060 | `click>=8.1`, `httpx>=0.27`, `pillow>=10` (TIFF to JPEG) | Click: `chancery search`, `chancery case`, `chancery download`, `chancery localities`, `catalog`, `url`, `grant-tif`, `lva-tif`, `dunmore`, `download-rosetta` | `test_va_archives.py` (409 / 19) | 160 |
| `wikitree` | `wikitree` | `skills/wikitree/scripts/wikitree` | 517 | `click>=8.1`, `httpx>=0.27` | Click: `search`, `person` (`get`, `show`, `profile`), `ancestors`, `bio` | `test_wikitree.py` (255 / 4) | 174 |

#### Pure-markdown workflow skills (3 directories)

| Skill directory | Current CLI status | `SKILL.md` lines | Migration target |
| --- | --- | ---: | --- |
| `blm-glo` | Registered as `kind: 'skill-guide'` (`kinloom blm-glo`) | 73 | `packages/cli/src/guides/blm-glo.ts` (served by `kinloom blm-glo` and `kinloom guide blm-glo`) |
| `cyndis-list` | Registered as `kind: 'skill-guide'` (`kinloom cyndis-list`) | 72 | `packages/cli/src/guides/cyndis-list.ts` (served by `kinloom cyndis-list` and `kinloom guide cyndis-list`) |
| `pronounce` | Already native TS at `packages/cli/src/commands/ops/pronounce.ts` (1,453 lines) | 89 | `packages/cli/src/guides/pronounce.ts` (served by `kinloom pronounce --guide` and `kinloom guide pronounce`) |

### 1.3 Python utilities in `packages/cli/assets/`

| Asset path | CLI command | Lines | PEP 723 deps / external binaries | Subcommands & key flags | Guide file (lines) |
| --- | --- | ---: | --- | --- | --- |
| `packages/cli/assets/prep-scan.py` | `prep-scan` | 1,856 | `httpx>=0.27`, `pillow>=10.0`, optional `pypdf`; system `pdftoppm`, `pdfinfo`, `pdftotext`, optional `timeout` | argparse: `preview`, `crop`, `sheet-strip`, `pdf-pages`, `pdf-grep`, `grid`, `stitch`, `info`, `join` (72 `add_argument` declarations) | `packages/cli/assets/prep-scan.md` (180) |
| `packages/cli/assets/cached-ocr.py` | `ocr` | 1,468 | stdlib `python3 -S`, optional `PIL`/`magick`/`prep-scan.py` fallback; system `tesseract`, optional `timeout`, vision CLI (`KINLOOM_OCR_CLI`, default `agy`) | Manual flag parser: `<image> [image ...]`, `-m`/`--mode`, `--printed`, `--cursive`, `--psm`, `--effort`, `--cache-dir`, `-t`/`--timeout`, `--workers`, `--max-dim`, `--prompt`, `--force`/`--refresh`/`--no-cache`, `--json`, `--boxes`, `--tsv`, `--find` | `packages/cli/assets/ocr.md` (76) |

### 1.4 Infrastructure and workflow files referencing Python or `skills/`

Wave 57 must update or remove every non-`skills/` reference to Python, `uv`, and bundled skills:

- `packages/cli/package.json` (`"build": "tsc -p tsconfig.build.json && node scripts/bundle-skills.mjs"`)
- `packages/cli/scripts/bundle-skills.mjs` (252 lines; note that lines 86 and 165 to 180 also copy `packages/worker/migrations/*.sql` into `packages/cli/dist/migrations` for `kinloom migrate`)
- `packages/cli/src/commands/records/resolve.ts` (100 lines)
- `packages/cli/src/commands/records/runner.ts` (610 lines)
- `packages/cli/src/commands/records/help.ts` (238 lines; replaces filesystem `SKILL.md` reads and legacy regex rewrites)
- `packages/cli/src/commands/records/registry.ts` (304 lines; replaces `skill-script`/`asset-script` file specs with native TS module specs)
- `packages/cli/src/commands/records/records.test.ts` (2,944 lines; includes `python3` PNG generator at line 2674, `unittest` runners at lines 2369 to 2433, `bundle-skills.mjs` assertions at line 949, and `SKILLS_ROOT` parity checks at line 2899)
- `.github/workflows/ci.yml` (line 27: `astral-sh/setup-uv@v7`)
- `.github/workflows/publish.yml` (lines 61 and 239: two `astral-sh/setup-uv@v7` steps)
- `README.md` (lines 59 and 78 to 84: references to `skills/` and `uv`-based research skills)
- `AGENTS.md` (if needed, note pure-TS CLI policy and zero `.py` check)

---

## 2. Target TypeScript architecture inside `@kinloom/cli`

### 2.1 Dependency strategy

`@kinloom/cli` currently declares three runtime dependencies (`@kinloom/core`, `yaml`, `zod`) and runs on Node 22+ (CI runs Node 24). Adding four focused npm dependencies replaces every Python package (`click`, `httpx`, `pillow`, `pypdf`, `pyyaml`, `playwright`) without introducing Python or `uv`:

| Package | Role | Replaces | Why this choice |
| --- | --- | --- | --- |
| `cheerio` | HTML parsing & CSS selection | Python `html.parser` & ad-hoc regexes | Pure JS, zero native addons, handles malformed ASP.NET and legacy archive HTML cleanly across 10 archive clients. |
| `fast-xml-parser` | Namespace-aware XML/RSS/OAI-PMH parsing | `xml.etree.ElementTree` | Pure JS, handles `archive-org` DjVu/scandata XML, `texas-archives` OAI-PMH DC and RSS2, and `ky-archives` Preservica RSS2. |
| `fflate` | ZIP decompression | Python `zipfile` | Pure JS, zero native deps, extracts USGS GNIS state and national ZIP archives in `gnis`. |
| `sharp` | Image resize, rotate, crop, redact, composite, stitch, join, TIFF decode, SVG label overlay | `pillow` and `ImageMagick` fallback | Prebuilt `libvips` binaries for Linux, macOS, and Windows; handles CCITT G4 bi-level TIFFs in `va-archives`, EXIF orientation, compact JPEG KB budgets, and crisp SVG coordinate-grid/header overlays in `prep-scan`, plus in-process downscaling for `ocr`. |
| `playwright-core` *(optional peer dep)* | Headless Chromium fallback only for `ca-archives` (`oac`/`calisphere`) and `nara` (when `NARA_API_KEY` is unset or `--browser` is set) | Python `playwright>=1.49` | Declared under `peerDependencies` with `peerDependenciesMeta["playwright-core"].optional = true`, loaded lazily via `await import('playwright-core')`, reusing system Chrome/Chromium via `NARA_BROWSER` / `CA_ARCHIVES_BROWSER` or `PATH`. Zero install cost for users who never invoke browser fallback. |

System binaries retained directly via `node:child_process` `execFile` (no shell, bounded `AbortSignal` timeouts):
- `tesseract` (`tesseract-ocr`) for `kinloom ocr --mode printed` (`OMP_THREAD_LIMIT=1`).
- `pdftoppm`, `pdfinfo`, and `pdftotext` (`poppler-utils`) for `kinloom prep-scan pdf-pages` and `pdf-grep` (with a tiny pure-JS PDF page-count/text fallback or actionable install message when `pdftotext` is absent, removing `pypdf`).
- `ffmpeg` (and optional `gcloud`) for `kinloom narrative-audio synth`.
- `curl` only as an isolated transport fallback for Preservica WAF hosts (`michigan.access.preservica.com` and `tsl.access.preservica.com`) that reject non-curl TLS fingerprints with HTTP 403. Every other client uses native `fetch`.
- Configured vision CLI (`KINLOOM_OCR_CLI`, default `agy`) for `kinloom ocr --mode cursive`.

### 2.2 Module layout under `packages/cli/src/`

```text
packages/cli/
  scripts/
    copy-migrations.mjs           # Replaces bundle-skills.mjs in Wave 57 (copies worker SQL migrations + chmod cli.js)
  src/
    cli.ts                        # Adds `guide` command; dispatches record commands to records/dispatch.ts
    guides/
      index.ts                    # Typed GuideRegistry (all 26 topics + references) and renderer
      records/                    # 20 archival record guides (nara.ts, archive-org.ts, ...)
      directories/                # blm-glo.ts, cyndis-list.ts
      media/                      # prep-scan.ts, ocr.ts, narrative-audio.ts, narrative-audio-script-rules.ts
      ops/                        # pronounce.ts
    commands/
      records/
        index.ts                  # Public exports
        registry.ts               # Discriminated union: NativeRecordCommandSpec | GuideOnlyCommandSpec
        dispatch.ts               # Replaces runner.ts + resolve.ts; runs native handlers, emits telemetry
        help.ts                   # Renders embedded guides and grouped command catalog (no fs reads)
        runtime/
          args.ts                 # Forgiving CLI flag parser + subcommand alias router + comma-box normalizer
          cache.ts                # Atomic disk cache, lockfiles, TTL parsing, binary + JSON entries
          http.ts                 # Native fetch client with retries, Retry-After, host allowlist, SSRF guard, cookie jar, optional curl transport
          browser.ts              # Lazy optional playwright-core launcher (NARA_BROWSER / CA_ARCHIVES_BROWSER)
          parse.ts                # Shared cheerio HTML table/form/VIEWSTATE helpers, XML helpers, ZIP helper
          image.ts                # Shared sharp helpers (EXIF transpose, compact JPEG budget, TIFF->JPEG, SVG overlays)
          types.ts                # RecordCommandContext, RecordCommandOutcome, RecordHandler
        clients/
          nara.ts                 # Wave 55B
          archive-org.ts          # Wave 55B
          findagrave.ts           # Wave 55B
          openarchieven.ts        # Wave 55B
          wikitree.ts             # Wave 55B
          chronam.ts              # Wave 55B
          hathi.ts                # Wave 55B
          persi.ts                # Wave 55B
          gnis.ts                 # Wave 56
          uk-archives.ts          # Wave 56
          se-archives.ts          # Wave 56
          fi-archives.ts          # Wave 56
          mn-archives.ts          # Wave 56
          michiganology.ts        # Wave 56
          mo-archives.ts          # Wave 56
          nj-archives.ts          # Wave 56
          ca-archives.ts          # Wave 56
          ky-archives.ts          # Wave 56
          texas-archives.ts       # Wave 56
          va-archives.ts          # Wave 56
          prep-scan.ts            # Wave 56
          ocr.ts                  # Wave 56
          narrative-audio.ts      # Wave 56
```

### 2.3 Shared runtime contracts (`packages/cli/src/commands/records/runtime/`)

#### 1. `types.ts` and `dispatch.ts`

Every native record handler receives one typed `RecordCommandContext` and returns a structured `RecordCommandOutcome`:

```ts
export interface RecordCommandContext {
	readonly io: OpsIo;
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	readonly fetchImpl: typeof fetch;
	readonly execFileImpl?: ExecFileFn;
	readonly sleepFn?: (ms: number) => Promise<void>;
	readonly nowMs?: () => number;
}

export interface RecordCommandOutcome {
	readonly exitCode: number;
	readonly bytesOut: number;
	readonly cacheHit?: boolean;
}
```

This design eliminates four fragility points from the old `runner.ts`:
- No `spawn('uv')` or `UV_OFFLINE=1` cold-cache retry loop.
- No `CacheHitWindow` stdout regex sniffing, because every native handler returns `cacheHit?: boolean` directly.
- Every client accepts injected `fetchImpl`, `execFileImpl`, `env`, `sleepFn`, and `nowMs`, so every Vitest suite runs deterministically offline in milliseconds.
- `dispatch.ts` keeps the exact same `recordTelemetryEvent` schema (`cmd: "records:<command>"`, `subcmd: buildTelemetrySubcmd(...)`, `duration_ms`, `exit_code`, `bytes_out`, `cache_hit`), preserving the `ocr` and `prep-scan` path-leak guard (`SAFE_SUBCMD_TOKEN_RE`).

#### 2. `cache.ts` (compatible with existing user caches)

All 21 caching Python scripts currently repeat nearly identical 80-to-120-line blocks for cache directory resolution, TTL parsing, `fcntl.flock`, atomic temp-file writes, and corrupt-JSON fallback. Centralizing them into `runtime/cache.ts` cuts roughly 2,000 lines of duplicated boilerplate while preserving exact compatibility:

- **Directory precedence:** Explicit `--cache-dir` flag, then command-specific env var (`KINLOOM_<NAME>_CACHE_DIR`, plus legacy `GNIS_CACHE_DIR` for `gnis`), then `KINLOOM_CACHE_DIR` (for `fi-archives`, `mn-archives`, `se-archives`), then `XDG_CACHE_HOME` (where used by `va-archives`, `prep-scan`, `ocr`), then `~/.cache/kinloom-<slug>`.
- **TTL parsing:** Rejects `NaN`, `Infinity`, and negative numbers with exit code `2` (`CliValidationError`). TTL `0` disables reads while still writing fresh entries (matching `ca-archives`, `hathi`, `persi`, `wikitree`, `findagrave`, etc.).
- **Atomic writes:** Writes to `.filename.<pid>.<hrtime>.tmp` in the same directory and calls `fs.renameSync`. Cleans up temp files on error.
- **Cross-platform advisory lock:** Uses exclusive lockfile creation (`fs.openSync(lockPath, 'wx')`) with bounded exponential backoff and stale-lock reclamation (age > 120s or dead PID), avoiding any native `flock` addon while matching POSIX `fcntl.flock` single-flight guarantees.
- **Per-invocation `cache_hit` tracker:** Provides a small `CacheHitTracker` helper (`note(hit: boolean)` and `allHits(): boolean`) so multi-request commands (`va-archives`, `openarchieven`, `nara`, `archive-org`, `ocr`, `prep-scan pdf-pages`) report `cache_hit: true` only when every underlying lookup hit cache.

#### 3. `http.ts` (native `fetch` + security invariants)

Replaces `httpx` and `urllib` across all 21 network clients:
- **Retries and backoff:** Retries HTTP `429`, `500`, `502`, `503`, `504`, `520`, `522`, `524` and transient network errors up to configured max attempts, honoring numeric and HTTP-date `Retry-After` headers capped at `30s`, with jitter.
- **Host allowlist and SSRF protection:** Validates every URL and final post-redirect URL (`response.url`, or manual redirect loop with `redirect: 'manual'` so disallowed hosts are blocked *before* connecting!). Blocks non-HTTPS (except explicit test overrides), loopback, private RFC 1918, link-local, and reserved IPv4/IPv6 addresses (`node:net` `isIP` + CIDR checks for `openarchieven` scan downloads, matching Python `ipaddress`).
- **Content verification:** Rejects HTML error pages (`<!doctype`, `<html`, `<head`, `<body`, `<title`) when expecting binary scans or JSON (`nara`, `michiganology`, `openarchieven`, `ocr`), and verifies `Content-Length` completeness on streamed downloads (`findagrave`, `nara`).
- **Cookie jar and form helpers:** Lightweight `CookieJar` tracking `Set-Cookie` headers across redirects and multi-step requests (`va-archives` Rosetta viewer session, `nj-archives` and `ky-archives` ASP.NET `__VIEWSTATE`/`__EVENTVALIDATION` POST chains, `mo-archives` `__ncforminfo`, `uk-archives` FreeREG CSRF token).
- **Isolated `curl` transport (`fetchWithCurl`):** Used only for `michigan.access.preservica.com` and `tsl.access.preservica.com` where Preservica's WAF blocks non-curl TLS fingerprints with HTTP 403. Invokes `execFile('curl', ['-sSL', ...])` with host allowlist validation, status marker parsing, retryable curl exit codes (`6, 7, 18, 28, 35, 52, 55, 56, 92`), and injectable `execFileImpl` for unit tests.

#### 4. `args.ts` (Click & argparse compatibility layer)

Standardizes CLI argument parsing across all 23 migrated commands without pulling in `commander` or `yargs`:
- Wraps `node:util` `parseArgs` with declarative option specs supporting multiple aliases (`['--limit', '--per-page', '--rows', '-n']`), negated boolean pairs (`--pdf` / `--no-pdf`, `--metadata` / `--no-metadata`, `--exact` / `--no-exact`), repeatable string flags (`multiple: true`), integer/float range validators, enum choices, and Click-style `--flag=value` / `-n 10` syntax.
- Preserves `prep-scan`'s comma-fragment pre-normalizer (`--box 10, 20, 30, 40` -> `--box 10,20,30,40`; `--pages 1-3, 5` -> `--pages 1-3,5`).
- Resolves subcommand aliases (`ia`, `show`, `get`, `metadata`, `memorial`, `photos`, `profile`, `item`, `info`, `fetch`, `detail`, `inspect`, `lva-tif`) via a static lookup table per command.
- Converts every usage error into `CliValidationError` (exit code `2`) and renders clean `--script-help` / `<subcommand> --help` usage text from the same declarative option table.

#### 5. `image.ts` (`sharp` replacing Pillow)

Powers `prep-scan`, `ocr` downscaling, and `va-archives` TIFF conversion:
- `readImageInfo(path)`: Reads EXIF-oriented `width`, `height`, `format`, `mode` (mapped to Pillow-compatible labels such as `RGB`, `RGBA`, `L`), `bytes`, and `kb`.
- `encodeCompactJpeg(input, { maxWidth, maxKb })`: Mirrors `prep-scan.py`'s exact scale/quality search grid (`scales: [1.0, 0.88, 0.76, 0.64, 0.52, 0.42, 0.34, 0.25]`, `qualities: [84, 76, 68, 60, 52, 44, 36]`) with Lanczos resampling and atomic file writes.
- `drawBlackBoxes(image, boxes)` and `renderGridOverlay(...)` and `buildLabeledContactStrip(...)`: Composites crisp SVG rectangles, coordinate grid lines, pill labels, and header bars onto the base raster via `sharp().composite([{ input: Buffer.from(svg), top: 0, left: 0 }])`.
- `convertTiffToJpeg(srcPath, destPath)`: Decodes CCITT G4 bi-level TIFFs from `image.lva.virginia.gov` via `sharp` and writes archival JPEG for `va-archives grant-tif` / `lva-tif` / `dunmore`.
- `downscaleForOcr(imgPath, maxDim)`: Called directly in-process by `ocr.ts` (replacing the 3-tier `PIL` -> `magick` -> `uv run prep-scan.py` chain in `cached-ocr.py`).

### 2.4 Embedded guides architecture (`packages/cli/src/guides/`)

Legacy `skills/` directories serve two separate jobs today: hosting executable Python scripts and holding Markdown workflow guides (`SKILL.md` plus `references/script-rules.md`). Moving guides into TypeScript modules under `packages/cli/src/guides/` eliminates `skills/` and `dist/bundled-skills/` completely:

1. **Data shape (`packages/cli/src/guides/index.ts`):**
   ```ts
   export interface EmbeddedGuide {
   	readonly id: string;
   	readonly command: string;
   	readonly category: RecordCommandCategory | 'ops';
   	readonly summary: string;
   	readonly body: string;
   	readonly subguides?: Readonly<Record<string, string>>;
   }
   ```
2. **Pre-authored clean text:** Every guide body is migrated from its existing `SKILL.md` / `assets/*.md` / `references/script-rules.md` with frontmatter already stripped and every command example already written as `kinloom <cmd>`. This lets us delete `parseSkillDocument()`, `rewriteSkillCommandExamples()`, and `resolveRecordGuidePath()` in Wave 57.
3. **CLI access paths:**
   - `kinloom <cmd> --help` / `kinloom <cmd> -h` / `kinloom help <cmd>`: Prints the embedded guide for all 25 record/guide/media commands plus footer links (`Aliases: ...`, `CLI flags: kinloom <cmd> --script-help` / `kinloom <cmd> <subcommand> --help`). Identical to today.
   - `kinloom blm-glo` and `kinloom cyndis-list` (with zero args or `--help`): Print their embedded guide and exit `0`. Identical to today.
   - `kinloom <cmd> --guide`: Prints the full embedded guide for any command, including core ops commands like `kinloom pronounce --guide`.
   - `kinloom guide [topic]`: New built-in command (`'guide'` added to `CORE_CLI_COMMANDS` in `packages/cli/src/plugins.ts`). With no topic, lists all 26 embedded guides grouped by category. With a topic (for example `kinloom guide blm-glo`, `kinloom guide pronounce`, or `kinloom guide narrative-audio/script-rules`), prints the guide or subguide directly to stdout.
4. **Build-time hygiene test:** Wave 52B's ubiquitous-language and Living Privacy Rule parity test (`records.test.ts:2899`) migrates to iterate over `EMBEDDED_GUIDES` instead of `SKILLS_ROOT`, ensuring all 26 guides stay free of deprecated terminology, raw `skills/` paths, and leaked test commands.

### 2.5 Preserving `kinloom migrate` when deleting `bundle-skills.mjs`

`packages/cli/scripts/bundle-skills.mjs` currently copies `packages/worker/migrations/*.sql` into `packages/cli/dist/migrations/` (`bundle-skills.mjs:86,165-180`), and `packages/cli/src/commands/ops/migrate.ts:451` falls back to `dist/migrations` when `@kinloom/cli` is installed outside the monorepo.

Before deleting `bundle-skills.mjs` in Wave 57, replace it with a ~35-line `packages/cli/scripts/copy-migrations.mjs` that:
1. Atomically copies `packages/worker/migrations/*.sql` into `packages/cli/dist/migrations/`.
2. Prunes stale `.sql` files in `dist/migrations/`.
3. Ensures `packages/cli/dist/cli.js` has mode `0o755`.

---

## 3. Multi-wave execution plan (Waves 55B to 57)

Each wave leaves `main` green and deployable. During Waves 55B and 56, `registry.ts` supports both `'native'` specs and not-yet-migrated legacy specs so migrated commands run natively in TypeScript immediately while unmigrated commands continue working without regression. Wave 57 switches the final specs to `'native'` and deletes the entire legacy Python/skills stack in one atomic wave.

### Wave 55B: Shared native runtime and core record clients (8 clients)

**Scope:**
1. Add `cheerio` and `fast-xml-parser` to `packages/cli/package.json` (plus optional peer dep `playwright-core` for `nara` browser fallback).
2. Implement shared runtime under `packages/cli/src/commands/records/runtime/`:
   - `types.ts`, `args.ts`, `cache.ts`, `http.ts`, `parse.ts`, `browser.ts`, and `dispatch.ts` (with temporary fallback delegation to `runner.ts` for Wave 56 commands only).
   - Unit tests for `runtime/` (`http.test.ts`, `cache.test.ts`, `args.test.ts`, `parse.test.ts`).
3. Port **8 core archival record CLIs** (10,467 Python lines -> native TypeScript) and port all **121 Python unit tests** (5,802 test lines) to Vitest under `packages/cli/src/commands/records/clients/*.test.ts`:
   - `nara` (`nara.ts` + `nara.test.ts`, porting 39 tests from `test_nara.py`): Catalog v2 REST API, WAF query-normalization retry, optional `playwright-core` headless Chromium fallback, parallel batch search/download, S3 host allowlist, `census1950`, and `census1950-image`.
   - `archive-org` / `ia` (`archive-org.ts` + `archive-org.test.ts`, porting 21 tests from `test_archive_org.py`): search, `get`/`metadata`/`show`, `download`, `fulltext`, `grep` (gzipped DjVu XML + scandata page mapping), `page`, `text`, `lookup`, and `url`.
   - `findagrave` (`findagrave.ts` + `findagrave.test.ts`, porting 11 tests from `test_findagrave.py`): GraphQL `search`, `get`/`memorial`/`show`, `cemetery`, `place`, `photo`/`photos` (with host allowlist & `Content-Length` verification), and `url`.
   - `openarchieven` (`openarchieven.ts` + `openarchieven.test.ts`, porting 15 tests from `test_openarchieven.py`): `search`, `show`/`get`, `download` (with `proxy.archieven.nl` + private-IP SSRF guard), and `url`.
   - `wikitree` (`wikitree.ts` + `wikitree.test.ts`, porting 4 tests from `test_wikitree.py`): `search`, `person`/`get`/`show`/`profile`, `ancestors`, and `bio`.
   - `chronam` (`chronam.ts` + `chronam.test.ts`, porting 24 tests from `test_chronam.py`): `search`, `get`, `page`, `download` (PDF/IIIF JPEG/JP2/ALTO XML), and `url`.
   - `hathi` (`hathi.ts` + `hathi.test.ts`, porting 4 tests from `test_hathi.py`): `bib` (brief/full multi-ID) and `url`.
   - `persi` (`persi.ts` + `persi.test.ts`, porting 3 tests from `test_persi.py`): `surname`, `title`, `location`, `search`, and `url` via `cheerio`.
4. Flip those 8 entries in `registry.ts` to `kind: 'native'` and remove their 8 `test_*.py` invocations from `records.test.ts`.

**Wave 55B exit gate:**
- All 8 commands execute natively in TypeScript with zero `uv` or `python3` spawns.
- Every ported Vitest suite passes offline with mocked `fetch` and temp cache dirs.
- `npm run check` passes cleanly.

### Wave 56: Regional archives, scan/OCR/audio tools, and embedded guides (15 clients + 26 guides)

To keep commits verifiable and reviewable, execute Wave 56 in two sequential verifiable units (Wave 56A and Wave 56B):

#### Wave 56A: Regional, state, international, and GNIS clients (12 clients)

Add `fflate` and `sharp` to `packages/cli/package.json`. Port the remaining **12 archival record CLIs** (11,216 Python lines) and all **86 Python unit tests** (4,231 test lines) to Vitest:

- `gnis` (`gnis.ts` + `gnis.test.ts`, 3 tests): S3 ZIP download + `fflate` extraction + local pipe-delimited search (`DomesticNames_<ST>` and `HistoricalFeatures`).
- `uk-archives` (`uk-archives.ts` + `uk-archives.test.ts`, 8 tests): TNA Discovery API (`tna`/`discovery` + `detail`/`inspect`/`get` aliases), FreeREG CSRF + HTML table parsing via `cheerio`, and `url`.
- `se-archives` (`se-archives.ts` + `se-archives.test.ts`, 6 tests): Riksarkivet Search API (`search`, `births`, `marriages`, `deeds`, `record`, `collection`), IIIF v3 `manifest` & `download`, and `census` URL builder.
- `fi-archives` (`fi-archives.ts` + `fi-archives.test.ts`, 5 tests): HisKi parish list, form POST search, event detail (preserving ISO-8859-1 / UTF-8 decoding), Digihakemisto archive index, and `url`.
- `mn-archives` (`mn-archives.ts` + `mn-archives.test.ts`, 6 tests): MNHS People Records JSON API (`death`, `birth`, `census`, `vets`, `people`, `record`), MNHS Digital Newspaper Hub (`newspapers search/metadata/download`), and `mdl`.
- `michiganology` (`michiganology.ts` + `michiganology.test.ts`, 14 tests): Preservica search/get/download via isolated `curl` transport, `AliasedGroup` aliases (`item`, `show`, `info`, `fetch`), `collections`, and `url`.
- `mo-archives` (`mo-archives.ts` + `mo-archives.test.ts`, 3 tests): `s1.sos.mo.gov` `__ncforminfo` form POST (`death`, `pre1910`), `detail`, PDF `download`, and `mdh`.
- `nj-archives` (`nj-archives.ts` + `nj-archives.test.ts`, 11 tests): `wwwdnet-dos.nj.gov` ASP.NET `__VIEWSTATE` postback pagination across all NJ databases, fuzzy database suggestion (Levenshtein/SequenceMatcher helper replacing `difflib`), `monmouth` OPRS 1875 census, and `url`.
- `ca-archives` (`ca-archives.ts` + `ca-archives.test.ts`, 4 tests): State Archives Portal HTML + Exhibits Omeka S JSON API via `fetch`, OAC/Calisphere via optional `playwright-core` (`CA_ARCHIVES_BROWSER`), `get`, and `url`.
- `ky-archives` (`ky-archives.ts` + `ky-archives.test.ts`, 3 tests): KHS CONTENTdm API (`cdm`, `cdm-item`, `collections`, `cdm-url`), KY Land Office ASP.NET `VIEWSTATE` (`land`, `land-patent`), KDLA Preservica RSS2 (`preservica`), and `urls`.
- `texas-archives` (`texas-archives.ts` + `texas-archives.test.ts`, 4 tests): Portal to Texas History HTML + OAI-PMH DC XML (`portal search`, `portal item`), TDA Preservica RSS2 via isolated `curl` transport (`tda`), and `url`.
- `va-archives` (`va-archives.ts` + `va-archives.test.ts`, 19 tests): Chancery POST/detail/images/ZIP/localities, Primo PNXS `catalog`, `grant-tif`/`lva-tif` and `dunmore` CCITT G4 TIFF-to-JPEG conversion via `sharp`, `download-rosetta` cookie-session resolution, and `url`. Support `KINLOOM_VA_ARCHIVES_CACHE_TTL_HOURS` as an alias for `KINLOOM_VA_ARCHIVES_TTL_HOURS`.

#### Wave 56B: Media, scan prep, OCR, and embedded guides (3 clients + 26 guides)

1. **`prep-scan` (`prep-scan.ts` + `prep-scan.test.ts`):**
   - Port all 9 subcommands (`preview`, `crop`, `sheet-strip`, `pdf-pages`, `pdf-grep`, `grid`, `stitch`, `info`, `join`) using `sharp`, `fetch` (for `sheet-strip` URLs), and `execFile` (`pdftoppm`, `pdfinfo`, `pdftotext`).
   - Preserve exact forgiving output-flag aliases (`<out>` vs `--out`/`-o`/`--output`, `--out-dir`/`--output-dir`), comma-split `--box`/`--redact`/`--redact-orig`/`--pages`, and SHA-256 disk caches under `<cache>/pdf-pages/` and `<cache>/pdf-text/`.
   - Port every existing `prep-scan` test from `records.test.ts` (EXIF orientation, redactions, grid SVG labels, stitch, join, `pdf-pages` caching, `pdf-grep` caching & exit codes `0`/`1`/`2`).
2. **`ocr` (`ocr.ts` + `ocr.test.ts`):**
   - Port full `cached-ocr.py` behavior: multi-file bounded worker pool (`--workers`, default 4, max 8) preserving input order, magic-byte validation (exit `2` on missing, directory, 0-byte, HTML, PDF, corrupt image), SHA-256 disk caches (`<sha256>_<slug>.json`, `.tsv`, `.boxes.json`), `tesseract` via `execFile` with `OMP_THREAD_LIMIT=1` and Node timeout (no external GNU `timeout` binary required), TSV coordinate rescaling back to original pixels, `--boxes`/`--find`/`--tsv`, and `--mode cursive` calling `KINLOOM_OCR_CLI`.
   - Call `image.ts` (`sharp`) **in-process** for both printed-scan downscaling (`--max-dim 3500`) and cursive-scan downscaling (`> 350 KB` -> `<= 285 KB`, max width `2400px`). Zero nested subprocess spawns!
   - Replace the `python3` synthetic PNG generator in `records.test.ts:2674` with pure Node `sharp` or `node:zlib`.
3. **`narrative-audio` (`narrative-audio.ts` + `narrative-audio.test.ts`):**
   - Port all 5 subcommands (`list`, `extract`, `check`, `synth`, `transcribe`) using `@kinloom/cli`'s existing `yaml` package, native `fetch` (Google Cloud Text-to-Speech Chirp 3: HD + Gemini TTS/transcription), pure-TS RIFF/WAV header stripping (`DataView`), `execFile('gcloud', ...)` for ADC token/project lookup, and `execFile('ffmpeg', ...)` for PCM-to-MP3 encoding.
   - Add full Vitest unit tests (previously missing in Python!) covering `speakDates`, `speakNumbers`, `applyNames`, `buildChirpPronunciations`, `splitToByteLimit`, `stripWavHeader`, `check` lint rules, `synth --dry-run`, mocked Chirp 3: HD + Gemini HTTP payloads, and `extensions.narrative_audio` YAML snippet output.
4. **Embedded guides (`packages/cli/src/guides/`):**
   - Author all 26 embedded guide modules plus `narrative-audio/script-rules` subguide.
   - Wire `kinloom guide [topic]`, `kinloom <cmd> --guide`, `kinloom <cmd> --help`, and `kinloom help <cmd>` in `help.ts` and `cli.ts`. Add `'guide'` to `CORE_CLI_COMMANDS` in `packages/cli/src/plugins.ts`.

**Wave 56 exit gate:**
- All 25 registered record/guide/media commands plus `pronounce` and `guide` execute 100% natively in TypeScript.
- Zero `uv` or `python3` invocations anywhere in `vitest run`.
- `npm run check` passes cleanly.

### Wave 57: Final cutover, deletion, and CI cleanup

**Scope:**
1. **Delete legacy Python and skill directories:**
   - `git rm -r skills/` (deletes all 24 skill directories, 21 scripts, 20 Python test files, 24 `SKILL.md` files, 1 reference doc).
   - `git rm -r packages/cli/assets/` (deletes `prep-scan.py`, `cached-ocr.py`, `prep-scan.md`, `ocr.md`).
   - `git rm packages/cli/scripts/bundle-skills.mjs`.
   - `git rm packages/cli/src/commands/records/resolve.ts packages/cli/src/commands/records/runner.ts`.
2. **Replace migration copy step:**
   - Add `packages/cli/scripts/copy-migrations.mjs` (copies `packages/worker/migrations/*.sql` into `packages/cli/dist/migrations` and `chmod 0o755 dist/cli.js`).
   - Update `packages/cli/package.json` `"build"` script to `"tsc -p tsconfig.build.json && node scripts/copy-migrations.mjs"`.
3. **Clean up exports and tests:**
   - Remove deleted `resolve.ts` / `runner.ts` exports from `packages/cli/src/commands/records/index.ts`.
   - Update `packages/cli/src/commands/records/records.test.ts` to assert:
     - Every registered command in `RECORD_COMMAND_SPECS` is native TS or embedded guide-only.
     - All 26 embedded guides pass the Wave 52B ubiquitous-language, Living Privacy Rule, and zero-legacy-path checks.
     - `copy-migrations.mjs` copies `packages/worker/migrations/*.sql` cleanly.
     - No test spawns `uv` or `python3`.
4. **Clean up GitHub Actions workflows:**
   - Remove the `Setup uv` (`astral-sh/setup-uv@v7`) step from `.github/workflows/ci.yml` (line 26 to 29).
   - Remove both `Setup uv` (`astral-sh/setup-uv@v7`) steps from `.github/workflows/publish.yml` (lines 60 to 63 and lines 238 to 241).
   - Keep `tesseract-ocr` and `poppler-utils` in CI and publish workflows because `ocr` and `prep-scan` call those system binaries directly.
5. **Update public documentation:**
   - Update `README.md` to describe the built-in pure-TypeScript `@kinloom/cli` research commands and `kinloom guide` (removing references to `skills/` and `uv`).
   - Update `AGENTS.md` to add a zero-Python guardrail (`find . -name '*.py'` must stay empty).

**Wave 57 exit gate (hard cutover verification):**
```bash
# 1. Zero Python files anywhere in the repository (excluding node_modules and .git)
test -z "$(find . -path './node_modules' -prune -o -path './.git' -prune -o -name '*.py' -print)"

# 2. Legacy directories and scripts are gone
test ! -d skills
test ! -d packages/cli/assets
test ! -f packages/cli/scripts/bundle-skills.mjs
test ! -f packages/cli/src/commands/records/resolve.ts
test ! -f packages/cli/src/commands/records/runner.ts

# 3. Zero references to uv or bundled-skills in code, package manifests, or CI
! grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=docs \
  -E 'astral-sh/setup-uv|bundle-skills|bundled-skills|\buv run\b' .

# 4. Full verification suite passes without uv or python3 on PATH
npm run check
npm run test:e2e
```

---

## 4. Backward compatibility and verification matrix

### 4.1 CLI command, alias, and help compatibility

Every command currently invoked by archive operators, shell scripts, and AI research agents must continue working with identical arguments and output contracts.

| Surface | Existing invocation | Post-migration behavior |
| --- | --- | --- |
| Top-level alias | `kinloom ia ...` | Resolves to `archive-org` (identical) |
| Top-level guide help | `kinloom <cmd> --help`, `kinloom <cmd> -h`, `kinloom help <cmd>` | Prints embedded guide from `packages/cli/src/guides/` with `CLI flags:` footer (identical) |
| Raw flag usage | `kinloom <cmd> --script-help` | Kept as alias printing raw CLI flag usage from `args.ts` |
| Subcommand help | `kinloom <cmd> <subcmd> --help` | Prints subcommand-specific option table from `args.ts` |
| Explicit guide lookup | `kinloom guide`, `kinloom guide <topic>`, `kinloom <cmd> --guide` | New pure-TS guide browser covering all 26 guides and subguides (`narrative-audio/script-rules`) |
| Guide-only commands | `kinloom blm-glo`, `kinloom cyndis-list` | Prints embedded guide and exits `0` without network or child processes |
| Subcommand aliases | `archive-org get` (`metadata`, `show`); `findagrave get` (`memorial`, `show`) & `photo` (`photos`); `nara get` (`show`); `openarchieven show` (`get`); `wikitree person` (`get`, `show`, `profile`); `michiganology get` (`item`, `show`, `info`) & `download` (`fetch`); `uk-archives tna get` (`detail`, `inspect`) & `discovery detail` (`inspect`, `get`); `va-archives grant-tif` (`lva-tif`) | 100% preserved in each command's subcommand alias table |
| Forgiving output & box flags | `prep-scan`: positional `<out>` or `--out`/`-o`/`--output`, `--out-dir`/`--output-dir`, `--pages`/`--page`/`-p`, shell-split `--box 10, 20, 30, 40` | 100% preserved via `args.ts` pre-normalizer |
| `ocr` mode & refresh aliases | `-m`/`--mode`, `--printed`, `--cursive`, `--force`/`--refresh`/`--no-cache`, `-t`/`--timeout` | 100% preserved |

### 4.2 JSON stdout, cache, telemetry, and exit-code contracts

| Contract | Requirement | Verification |
| --- | --- | --- |
| Top-level `cache_hit` boolean | All 22 caching commands emit top-level boolean `cache_hit` in `--json` output (`ocr` also keeps `cached` and multi-file `cache_hits`). Single-file `ocr --json` stays a flat object; multi-file `ocr --json` wraps `{ files, count, cache_hits, cache_hit }`. | Ported unit tests per client + `records.test.ts` telemetry matrix |
| Telemetry JSONL schema | `~/.cache/kinloom-telemetry/calls.jsonl` (or `KINLOOM_TELEMETRY_FILE`) continues recording `{ ts, cmd: "records:<command>", subcmd, person_id: null, duration_ms, cache_hit, exit_code, bytes_out }`. Honors `KINLOOM_TELEMETRY_PARENT=1`. `ocr` logs `ocr <mode>` and `prep-scan` strips path arguments so private file paths never enter telemetry. | `records.test.ts` telemetry & path-leak tests |
| Disk cache paths & env vars | All existing `KINLOOM_*_CACHE_DIR`, `KINLOOM_*_CACHE_TTL_HOURS`, `KINLOOM_VA_ARCHIVES_TTL_HOURS` (+ alias `KINLOOM_VA_ARCHIVES_CACHE_TTL_HOURS`), `KINLOOM_CACHE_DIR`, `GNIS_CACHE_DIR`, `KINLOOM_OCR_CACHE_DIR`, `KINLOOM_OCR_CLI`, `KINLOOM_OCR_MODEL`, `NARA_API_KEY`, `NARA_BROWSER`, `CA_ARCHIVES_BROWSER`, `WIKITREE_APP_ID`, `NARRATIVE_AUDIO_BACKEND`, `NARRATIVE_AUDIO_LANGUAGE`, `GOOGLE_CLOUD_TTS_API_KEY`, `GOOGLE_CLOUD_ACCESS_TOKEN`, `GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, and `XDG_CACHE_HOME` remain honored with identical defaults. | Unit tests per client setting env overrides against temp directories |
| Exit codes | `0` = success (including `EPIPE` on piped stdout); `1` = runtime/HTTP/network error, or 0 matches in `prep-scan pdf-grep`, or failed lint in `narrative-audio check`; `2` = CLI usage, bad flag, invalid regex, out-of-range `--pages`, invalid `--box`/`--redact`, or missing/empty/HTML/PDF/corrupt image in `ocr`; `3` = HTTP `409` optimistic conflict (core API commands). | Boundary error tests in every client test file |

### 4.3 Per-wave verification matrix

| Wave | New/updated test coverage | Required checks before commit |
| --- | --- | --- |
| **55B** | Runtime unit tests (`http`, `cache`, `args`, `parse`) + 8 client Vitest suites porting all 121 tests from `test_nara.py`, `test_archive_org.py`, `test_findagrave.py`, `test_openarchieven.py`, `test_wikitree.py`, `test_chronam.py`, `test_hathi.py`, `test_persi.py` | `npm run lint`, `npm run build`, `npm run typecheck`, `npm test`, `npm run check:contrast`, `npm run check:leaks` |
| **56A** | 12 regional/GNIS client Vitest suites porting all 86 tests from `test_gnis.py`, `test_uk_archives.py`, `test_se_archives.py`, `test_fi_archives.py`, `test_mn_archives.py`, `test_michiganology.py`, `test_mo_archives.py`, `test_nj_archives.py`, `test_ca_archives.py`, `test_ky_archives.py`, `test_texas_archives.py`, `test_va_archives.py` | `npm run lint`, `npm run build`, `npm run typecheck`, `npm test`, `npm run check:contrast`, `npm run check:leaks` |
| **56B** | Native Vitest suites for `prep-scan` (all 9 subcommands), `ocr` (single/multi-file, parallel workers, downscale+TSV rescale, exit 2 invalid-input matrix), `narrative-audio` (all 5 subcommands + dry-run + mocked Chirp/Gemini HTTP), and `guides/` parity tests | `npm run lint`, `npm run build`, `npm run typecheck`, `npm test`, `npm run check:contrast`, `npm run check:leaks` |
| **57** | Final cutover verification: zero `.py` files, `skills/` absent, `packages/cli/assets/` absent, `copy-migrations.mjs` verified against `kinloom migrate`, CI/publish YAML validated with zero `setup-uv` | Full `npm run check`, `npm run test:e2e`, plus `PATH` smoke test running `kinloom --help`, `kinloom guide`, `kinloom nara url Lincoln`, `kinloom prep-scan info`, and `kinloom ocr` with `uv` and `python3` masked out |
