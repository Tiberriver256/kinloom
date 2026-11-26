---
name: nara-catalog-search
description: Search, inspect, and download records from the National Archives Catalog via the bundled uv-based `nara` CLI, website advanced search, or v2 API. Also searches the public 1950 Census population schedules and downloads schedule JPEGs from the 1950 Census IIIF server. Covers CLI usage, query-string syntax, q operators, fielded parameters, filters, date and Congress ranges, pagination, and worked examples. Use when querying NARA, inspecting NAIDs, downloading digitized archival scans, searching the 1950 Census, downloading a 1950 Census schedule image, or verifying genealogy records.
---

# NARA Catalog Search

This skill includes a standalone executable Python CLI invoked as `kinloom nara` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`, `playwright`). No virtualenv setup or API key is required.

- **Without `NARA_API_KEY` (default):** runs headless Chromium (auto-detecting system `chromium` or `google-chrome`) against `catalog.archives.gov` and reads the structured Catalog JSON responses.
- **With `NARA_API_KEY`:** queries the official v2 API (`https://catalog.archives.gov/api/v2/records/search`) over HTTP directly. Pass `--browser` to force website mode.
- **Compact output by default:** JSON and text outputs keep only non-empty archival citation fields (`naId`, `title`, `url`, `level`, `rg`, `series`, `dates`, `microform`, `access`, `use`, `location`, `scope`, `objectCount`). Full digital object URL lists are excluded unless `--objects` is passed (and can be sliced with `--pages`).

## Bundled CLI (`scripts/nara`)

Command: `kinloom nara`
### Persistent local disk cache

`search`, `get`, `download`, `census1950`, and `census1950-image` cache responses atomically under `~/.cache/kinloom-nara/` (overrideable via `KINLOOM_NARA_CACHE_DIR`) using advisory file locks (`fcntl.flock` on POSIX, safe fallback elsewhere) so concurrent research threads never duplicate downloads and repeat calls make zero HTTP requests. Pass `--refresh` on `search`, `get`, `download`, `census1950`, or `census1950-image` to bypass the cache and fetch fresh data.

Cache layout:

- `records/<naid>.json`: full record metadata and digital object inventory shared by `get` and `download` (upgraded automatically if `--text` is requested later).
- `objects/<naid>/<page>_<safe_filename>`: individual downloaded page scans with sidecar `.meta.json`, so overlapping page slices (for example `--pages 315-350` followed by `--pages 340-360` or another biographer working the same census roll) reuse already-fetched pages straight from disk.
- `downloads/<sha256>.bin` and `downloads/<sha256>.json`: cached direct NARA or NARA S3 URL downloads with stored content type and byte count.
- `_queries/<sha256>.json`: cached `search` query payloads keyed by canonical query parameters with a 168-hour (7-day) default TTL (`--cache-ttl-hours` or `KINLOOM_NARA_QUERY_TTL_HOURS`).
- `--json` on `search`, `get`, `download`, `census1950`, and `census1950-image` includes a boolean `cache_hit` field. `download` streams to a temporary file, retries transient HTTP 429/5xx, timeout, protocol, and incomplete-body errors up to 4 times (honoring `Retry-After`), enforces an `archives.gov` / NARA S3 host allowlist, and refuses HTML error pages or S3 XML errors before caching.
- `census1950/<sha256>.json`: cached `census1950` responses, same TTL and the same `--cache-ttl-hours` / `KINLOOM_NARA_QUERY_TTL_HOURS` knobs. `0` skips cached reads.
- `census1950-images/<sha256>.jpg`: cached `census1950-image` JPEGs. The key is the schedule `image` path plus the requested width (`full` when `--width` is omitted). The same TTL knobs apply. `0` skips cached reads. The command writes a file only after the body starts with the JPEG bytes `FF D8 FF`. HTML, HTTP errors, and non-JPEG bodies are not cached. Each image has its own cache file and its own lock, including when one command downloads several sheets.

### Search records (single or batched in one browser session)

```bash
# Single exact-phrase search in Record Group 15 (Department of Veterans Affairs pension files)
kinloom nara search '"Harriet Tubman"' --rg 15

# Batch multiple queries sharing one headless Chromium session (fast)
kinloom nara search '"Clara Barton"' '"Frederick Douglass"' 'Gettysburg AND Lincoln' --online --json

# Digital records only, filtered by level, date range, and material type
kinloom nara search '"Abraham Lincoln"' --level fileUnit,item --online --start-date 1860 --end-date 1865 --type "Textual Records"
```

### Inspect one or more NAIDs

```bash
# Compact metadata and file counts for multiple NAIDs (reuses one browser; alias: show)
kinloom nara get <naid-1> <naid-2> --json
kinloom nara show <naid> --json

# Include sliced digital object URLs for large rolls
kinloom nara get <naid> --objects --pages 1-10 --json

# Print extracted OCR or community transcriptions if available
kinloom nara get <naid> --text
```

Note on large multi-page file units: `nara get --text` prints text only when NARA's record object stores `extractedText`, `otherExtractedText`, or community transcriptions, and NARA's catalog search proxy response does not include page-level match highlights. When a search matches inside a large digitized file unit (for example hundreds of pages) with no `extractedText` returned by `get --text`, open `https://catalog.archives.gov/id/<naId>` in a browser to locate the matching page.

### Download digitized scans with compact provenance metadata

```bash
# Download selected 1-based pages plus compact metadata.json (accepts NAID or catalog.archives.gov/id/<naid>)
kinloom nara download <naid> --pages 1-5 --out ./downloads/nara-<naid> --json

# Download all images in a file unit (concurrent up to 4 workers)
kinloom nara download <naid> --out ./downloads/nara-<naid>

# Download a direct NARA or NARA S3 file URL with atomic disk caching
kinloom nara download "https://s3.amazonaws.com/NARAprodstorage/..." --out ./downloads/page.jpg --json
```

### Search the 1950 Census population schedules

`census1950` calls the public JSON API on `https://1950census.archives.gov/api/search`. Measured 2026-11-25, `GET /api/search` returns JSON (`total`, `page`, `size`, `results`) and `GET /api/state` returns `{abbr, name}` rows. That host is not the Catalog v2 API. The command sends the same query names the public site uses: `state` (postal code), `county`, `name`, `ed`, `size` (from `--limit`), and `page` (from `--page`, default 1). The cache key includes `page`. Page 1 keeps the key written before `--page` existed.

```bash
# Surname in one state. Repeat the same command and the second run does not call the network.
kinloom nara census1950 --state IL --name Lincoln --json

# One enumeration district
kinloom nara census1950 --state Illinois --county Sangamon --ed 84-1

# Force a new request
kinloom nara census1950 --state IL --name Lincoln --refresh

# Second page of the same search
kinloom nara census1950 --state IL --name Lincoln --page 2 --json
```

Give at least one of `--state`, `--county`, `--name`, or `--ed`. `--limit` is 1 through 100 (default 25). `--page` is an integer greater than or equal to 1 (default 1). `--json` adds `"cache_hit": true` or `false` and leaves each result object as the API returned it. Text output adds `image <path>` on the schedule line. Pass that path to `census1950-image`. State names and the codes published by `GET /api/state` both work, including territories such as `PR` and `PC` (Panama Canal Zone).

### Download 1950 Census schedule JPEGs

`census1950-image` downloads one or more schedule images from the public IIIF Image API 2 server. Measured 2026-11-26, these URLs return `image/jpeg` and do not redirect:

- `https://1950census.archives.gov/iiif/2/<url-encoded-image>/full/full/0/default.jpg` (full resolution)
- `https://1950census.archives.gov/iiif/2/<url-encoded-image>/full/<width>,/0/default.jpg` (width in pixels)

The command accepts either value:

- The `image` path from `census1950`, for example `1950census/43290879-Illinois/43290879-Illinois-087558/43290879-Illinois-087558-0002.jpg` (leading `/` or URL-encoded `%2F` paths are normalized).
- The `iiifUrl` from the same row (`.../info.json`, bare `/iiif/2/<encoded>` URL, or a `.../default.jpg` URL on `https://1950census.archives.gov/iiif/2/`).

Both forms use the same cache entry when `--width` is the same. The command rebuilds the JPEG URL from the path. It does not request any other host. It rejects `..` path segments, a non-`1950census.archives.gov` host, and any URL that is not under `/iiif/2/`. It does not follow redirects.

```bash
# Full archival JPEG. The second run reads the cache and does not call the network.
kinloom nara census1950-image \
  1950census/43290879-Illinois/43290879-Illinois-087558/43290879-Illinois-087558-0002.jpg \
  --out ./schedules --json

# Same file, addressed by the iiifUrl from census1950 --json
kinloom nara census1950-image \
  "https://1950census.archives.gov/iiif/2/1950census%2F43290879-Illinois%2F43290879-Illinois-087558%2F43290879-Illinois-087558-0002.jpg/info.json" \
  --out ./schedules

# Smaller preview. This uses a different cache file from the full-resolution download.
kinloom nara census1950-image \
  1950census/43290879-Illinois/43290879-Illinois-087558/43290879-Illinois-087558-0002.jpg \
  --width 2400 --out ./schedules/page.jpg
```

`-o` / `--out` / `--out-dir` / `--output` is a `.jpg`/`.jpeg` file path or a directory when you pass one image. The default directory is `.`. A directory receives `<basename>.jpg` from the image path. `--width` / `--max-width` is an integer from 1 through 10000. Omit it for the IIIF `full` size. `--timeout` sets the per-image read timeout in seconds (default 45). For one image, `--json` prints `image`, `url`, `path`, `bytes`, `width` (`null` when you omit `--width`), and `cache_hit`. `--refresh` downloads again and replaces the cache file. `--cache-ttl-hours` matches `census1950`.

You can pass up to 25 paths or URLs in one command. The command checks every path before it starts a download. Two or more images require `--out` to be a directory. If `--out` is a `.jpg` or `.jpeg` file in that case, the command stops and tells you to pass a directory. It does not download. JSON for two or more images is an object with `count`, `files`, and `cache_hit`. Each item in `files` has the same fields as the one-image JSON object. `cache_hit` is true only when every image was read from the disk cache. Images that are not in the cache download at the same time through a pooled client, with at most 4 downloads at once. The `files` array stays in the order of the arguments.

The download tries up to 3 times when the status is 429, 500, 502, 503, 504, 520, 522, or 524, or when httpx raises `TimeoutException` or `TransportError`, or when a streamed body stops before `Content-Length`. If the response has a numeric or HTTP-date `Retry-After` header, the command waits that many seconds, capped at 5. If the header is absent, the command waits 0.25 seconds after the first failure and 0.5 seconds after the second. Status 400, 403, and 404 fail on the first response. A failed attempt is not written to the cache.

### Build verified search URLs offline

```bash
kinloom nara url '"Harriet Tubman"' --rg 15 --online
kinloom nara url '"Clara Barton"' --level item --api
```

### Environment variables

- `NARA_API_KEY`: optional NARA Catalog v2 API key for direct HTTP queries.
- `NARA_BROWSER`: optional path to a Chromium or Chrome binary (defaults to `chromium`, `chromium-browser`, `google-chrome`, or Playwright's bundled browser).
- `KINLOOM_NARA_CACHE_DIR`: optional override for the local disk cache directory (default `~/.cache/kinloom-nara`).
- `KINLOOM_NARA_QUERY_TTL_HOURS`: optional override for the `search`, `census1950`, and `census1950-image` cache TTL in hours (default `168`).

## Website search & query string rules (verified live 2026-11-23)

- Basic: `https://catalog.archives.gov/search?q=<query>&page=<n>`
- Advanced builder: `https://catalog.archives.gov/advanced-search` (submits to `/search`)
- Record page: `https://catalog.archives.gov/id/<naId>`
- Help: `https://www.archives.gov/research/catalog/help/using`
- No sign-in or API key is needed for the website.

Rules:
- The search goes to `/search`, with `q=` first.
- Filters are separate parameters joined by `&`.
- Defaults add nothing: "All Archival Descriptions" and "All fields" produce no parameter.
- Multiple values in one filter are comma-separated inside a single parameter, never repeated keys. Example: `levelOfDescription=item%2CfileUnit`.
- URL encoding: space `%20`, double quote `%22`, comma `%2C`.
- Level values are lowercase camelCase: `recordGroup`, `collection`, `series`, `fileUnit`, `item`.

### Example URL patterns

- Exact phrase, item level: `https://catalog.archives.gov/search?q=%22Clara%20Barton%22&levelOfDescription=item`
- Keyword, digital content only: `https://catalog.archives.gov/search?q=Harriet%20Tubman&availableOnline=true&dataSource=description`
- Two levels: `https://catalog.archives.gov/search?q=Frederick%20Douglass&levelOfDescription=item%2CfileUnit`

## `q` syntax

- Boolean operators `AND`, `OR`, `NOT`; wildcard `*`; exact phrase with double quotes: `"Clara Barton"`.
- Plain keywords match broadly (`Clara Barton` unquoted matches either word anywhere). Quote exact names to narrow results.
- Wildcards: `photo*`, `WJC*`, `4*`.
- Comma-separated lists in control-number fields: `21-A-1, 5635483`; record group: `255, 404`; collection: `WJC-FCIP, WJC-WHOO`.

## Field-selector mapping to API parameters

- All fields -> `q` (verified)
- Title -> `title` (exact: `title_is`)
- Creator -> `creators`
- Person or Organization -> `personOrOrg`
- Geographic Reference -> `geographicReference`
- Tags -> `tagContribution`; Transcriptions -> `transcriptionContribution`; Comments -> `commentContribution`
- Local Identifier -> `localIdentifier` (`localIdentifier_is`); National Archives Identifier -> `naId` (`naId_is`); Record Group Number -> `recordGroupNumber`; Collection Identifier -> `collectionIdentifier`
- Location -> `referenceUnits`
- Type of Material -> `typeOfMaterials` (`Textual Records`, `Photographs and other Graphic Materials`, `Moving Images`, `Maps and Charts`, `Architectural and Engineering Drawings`, `Data Files`, `Sound Recordings`, `Artifacts`)
- Beginning/Ending Date -> `startDate` / `endDate` (`YYYY`, `YYYY-MM`, or `YYYY-MM-DD`); exact date -> `exactDate`
- Beginning/Ending Congress -> `beginCongress` / `endCongress` / `congressNumber`

## API v2 reference (optional key)

- Base: `GET https://catalog.archives.gov/api/v2/records/search`
- Auth: `x-api-key` header (request a free read-only key by emailing `Catalog_API@nara.gov`; limit 10,000 queries/month; never commit keys).
- Docs: `https://catalog.archives.gov/api/v2/api-docs/` (`swagger.json` at `https://catalog.archives.gov/api/v2/swagger.json`).
- Other endpoints: `/records/parentNaId/{parentNaId}`, `/extractedText/{naId}`, `/records/stats`, `/records/search/by-tag`, `/by-transcription`, `/by-comment`.
- Attribution: services using the API must display "This product uses the National Archives Catalog API but is not endorsed or certified by the National Archives and Records Administration."
- Terms note: do not scrape or bulk-mirror the whole Catalog; use the AWS Registry of Open Data dataset for bulk transfers.

## Kinloom Research Package workflow

Never edit `data/*.yaml` directly from a research session. Follow Kinloom's staged **Research Package** workflow and **Living Privacy Rule** (never include living people's portraits, exact birth dates, street addresses, or pronunciations in public archives):

1. Discover research targets with `kinloom status --missing-biography` or `kinloom status --end-of-line`.
2. Gather privacy-fenced context with `kinloom context <person_id> --include-family`.
3. Prepare downloaded scans with `kinloom prep-scan` (for example `kinloom prep-scan crop --redact-orig`) and run `kinloom ocr` as needed, then stage scans under `research/people/<person_id>/scans/`.
4. Write cited findings into `research/people/<person_id>/patch.json`.
5. Audit, integrate, verify, and sync:

```bash
kinloom audit --all-staged --pending-only --strict
kinloom integrate --all-staged --pending-only
kinloom pronounce audit --strict
kinloom verify
kinloom migrate
kinloom sync --sync-missing-media --verify-live
```
