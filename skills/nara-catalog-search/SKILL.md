---
name: nara-catalog-search
description: Search, inspect, and download records from the National Archives Catalog via the bundled uv-based `nara` CLI, website advanced search, or v2 API. Covers CLI usage, query-string syntax, q operators, fielded parameters, filters, date and Congress ranges, pagination, and worked examples. Use when querying NARA, inspecting NAIDs, downloading digitized archival scans, or verifying genealogy records.
---

# NARA Catalog Search

This skill includes a standalone executable Python CLI at `skills/nara-catalog-search/scripts/nara` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`, `playwright`). No virtualenv setup or API key is required.

- **Without `NARA_API_KEY` (default):** runs headless Chromium (auto-detecting system `chromium` or `google-chrome`) against `catalog.archives.gov` and reads the structured Catalog JSON responses.
- **With `NARA_API_KEY`:** queries the official v2 API (`https://catalog.archives.gov/api/v2/records/search`) over HTTP directly. Pass `--browser` to force website mode.
- **Compact output by default:** JSON and text outputs keep only non-empty archival citation fields (`naId`, `title`, `url`, `level`, `rg`, `series`, `dates`, `microform`, `access`, `use`, `location`, `scope`, `objectCount`). Full digital object URL lists are excluded unless `--objects` is passed (and can be sliced with `--pages`).

## Bundled CLI (`scripts/nara`)

Path: `skills/nara-catalog-search/scripts/nara`

### Persistent local disk cache

`search`, `get`, and `download` cache responses atomically under `~/.cache/kinloom-nara/` (overrideable via `KINLOOM_NARA_CACHE_DIR`) using advisory file locks (`fcntl.flock` on POSIX, safe fallback elsewhere) so concurrent research threads never duplicate downloads and repeat calls make zero HTTP requests. Pass `--refresh` on `search`, `get`, or `download` to bypass the cache and fetch fresh data.

Cache layout:

- `records/<naid>.json`: full record metadata and digital object inventory shared by `get` and `download` (upgraded automatically if `--text` is requested later).
- `objects/<naid>/<page>_<safe_filename>`: individual downloaded page scans, so overlapping page slices (for example `--pages 315-350` followed by `--pages 340-360` or another biographer working the same census roll) reuse already-fetched pages straight from disk.
- `_queries/<sha256>.json`: cached `search` query payloads keyed by canonical query parameters with a 168-hour (7-day) default TTL (`--cache-ttl-hours` or `KINLOOM_NARA_QUERY_TTL_HOURS`).

### Search records (single or batched in one browser session)

```bash
# Single exact-phrase search in Record Group 15 (Department of Veterans Affairs pension files)
skills/nara-catalog-search/scripts/nara search '"Harriet Tubman"' --rg 15

# Batch multiple queries sharing one headless Chromium session (fast)
skills/nara-catalog-search/scripts/nara search '"Clara Barton"' '"Frederick Douglass"' 'Gettysburg AND Lincoln' --online --json

# Digital records only, filtered by level, date range, and material type
skills/nara-catalog-search/scripts/nara search '"Abraham Lincoln"' --level fileUnit,item --online --start-date 1860 --end-date 1865 --type "Textual Records"
```

### Inspect one or more NAIDs

```bash
# Compact metadata and file counts for multiple NAIDs (reuses one browser)
skills/nara-catalog-search/scripts/nara get <naid-1> <naid-2> --json

# Include sliced digital object URLs for large rolls
skills/nara-catalog-search/scripts/nara get <naid> --objects --pages 1-10 --json

# Print extracted OCR or community transcriptions if available
skills/nara-catalog-search/scripts/nara get <naid> --text
```

Note on large multi-page file units: `nara get --text` prints text only when NARA's record object stores `extractedText`, `otherExtractedText`, or community transcriptions, and NARA's catalog search proxy response does not include page-level match highlights. When a search matches inside a large digitized file unit (for example hundreds of pages) with no `extractedText` returned by `get --text`, open `https://catalog.archives.gov/id/<naId>` in a browser to locate the matching page.

### Download digitized scans with compact provenance metadata

```bash
# Download selected 1-based pages plus compact metadata.json
skills/nara-catalog-search/scripts/nara download <naid> --pages 1-5 --out ./downloads/nara-<naid>

# Download all images in a file unit
skills/nara-catalog-search/scripts/nara download <naid> --out ./downloads/nara-<naid>
```

### Build verified search URLs offline

```bash
skills/nara-catalog-search/scripts/nara url '"Harriet Tubman"' --rg 15 --online
skills/nara-catalog-search/scripts/nara url '"Clara Barton"' --level item --api
```

### Environment variables

- `NARA_API_KEY`: optional NARA Catalog v2 API key for direct HTTP queries.
- `NARA_BROWSER`: optional path to a Chromium or Chrome binary (defaults to `chromium`, `chromium-browser`, `google-chrome`, or Playwright's bundled browser).
- `KINLOOM_NARA_CACHE_DIR`: optional override for the local disk cache directory (default `~/.cache/kinloom-nara`).
- `KINLOOM_NARA_QUERY_TTL_HOURS`: optional override for the `search` query cache TTL in hours (default `168`).

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
