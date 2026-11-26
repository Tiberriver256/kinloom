---
name: archive-org
description: Search, inspect, grep cached OCR text, and download pages or files from Internet Archive items via the bundled Python 3.11+ `archive-org` CLI or the public advancedsearch and metadata APIs. Covers CLI usage, persistent local disk caching (`KINLOOM_IA_CACHE_DIR`), exact printed-page to leaf resolution, Lucene query syntax, field selection, pagination, file downloads, and worked examples. Use when finding digitized books, genealogies, newspapers, audio, or other archived material, or when searching inside or downloading scans from Internet Archive for family-history research.
---

# Archive.org

This skill includes a standalone executable Python 3.11+ standard-library CLI at `skills/archive-org/scripts/archive-org` (`#!/usr/bin/env -S python3 -S`). No virtualenv, `uv`, third-party packages, or API key is required. The APIs are public and read-only.

## Bundled CLI (`scripts/archive-org`)

Path: `skills/archive-org/scripts/archive-org`

### Persistent local disk cache (all network commands)

Every network command (`get`, `grep`, `text`, `lookup`, `page`, `download`, `search`, and `fulltext`) writes atomically under `~/.cache/kinloom-ia/` (overrideable via `KINLOOM_IA_CACHE_DIR`) using per-item advisory locks (`fcntl.flock`) so concurrent processes never duplicate downloads and repeat calls make zero HTTP requests. Pass `--refresh` on any command to bypass the local cache and fetch fresh data. `--json` on `search`, `get`, `fulltext`, `grep`, `text`, `lookup`, and `page` adds a top-level boolean `cache_hit`. `download` and `url` do not print that object.

Cache layout:

- `<item_id>/metadata.json`: item metadata and file inventory from `/metadata/<item_id>`, shared by `get`, `grep`, `page`, and `download`.
- `<item_id>/scandata.xml`: raw IA leaf/page scan metadata (when present).
- `<item_id>/page_index.json`: pre-parsed bidirectional lookup table mapping `scandata` `leafNum`, BookReader `n<leaf>` index (skipping deleted/non-access leaves), and `printed_page` label so cache hits never re-parse XML.
- `<item_id>/djvu.txt`: form-feed (`\x0c`) page-delimited OCR text (fetched from `_djvu.txt` first; falls back to `_hocr_searchtext.txt.gz` + `_hocr_pageindex.json.gz` only when `_djvu.txt` is absent, fails, or lacks `\x0c` page breaks).
- `<item_id>/pages/n<leaf>_<suffix>.jpg`: cached rendered page JPEGs (for example `n127_w2400.jpg` or `n127_s2.jpg`) served directly to `--out` on repeat `page` calls.
- `<item_id>/files/<relpath>`: cached item files downloaded via `download` (with path-traversal validation; exact raw `scandata.xml` and `_djvu.txt` artifacts are also reused without re-downloading).
- `_queries/<search|fulltext>/<sha256>.json`: cached JSON responses for `search` and `fulltext` keyed by canonical query parameters with a 168-hour (7-day) default TTL (`--cache-ttl-hours` or `KINLOOM_IA_QUERY_TTL_HOURS`).

Transient HTTP `429`, `500`, `502`, `503`, and `504` responses (plus `IncompleteRead` / `RemoteDisconnected`) retry politely up to 2 times (honoring numeric or HTTP-date `Retry-After` capped at 5s), while `403`, `404`, and socket timeouts fail fast with 0 retries.

### Search inside cached digitized books (`grep`)

Downloads missing metadata, `scandata.xml`, and OCR text in parallel (`max_workers=6`, `timeout=25`) on cache miss, then searches line by line (never `re.S` + `.*`) and maps every match to its exact BookReader `leaf`, `printed_page`, snippet, and direct JPEG URL. Accepts `--pattern` or `-e` (repeatable), `--context` or `-C`, and `--limit` or `-m`. Exits `0` on zero matches. In multi-item batches, per-item download errors are reported in `errors` (or stderr warnings) instead of discarding matches from healthy items:

```bash
# Search one or more digitized books (cache miss populates ~/.cache/kinloom-ia/<id>/)
skills/archive-org/scripts/archive-org grep ourmartyrpreside00banc --pattern 'Gettysburg' --context 240 --limit 25

# Case-insensitive multi-item regex grep with structured JSON output
skills/archive-org/scripts/archive-org grep item_a item_b --pattern 'Lincoln|Douglass' -i --json
```

### Download single high-res pages (`page`) by printed page or leaf

Resolve printed book page numbers to exact BookReader leaves automatically via cached `page_index.json` (eliminating off-by-one leaf offsets), or pass `--leaf` / legacy positional `<leaf>` directly:

```bash
# Resolve printed page "12" automatically and save at BookReader scale 2
skills/archive-org/scripts/archive-org page ourmartyrpreside00banc --printed-page 12 --scale 2 --out ./page12.jpg

# Fetch an explicit BookReader leaf n0 into a file or directory
skills/archive-org/scripts/archive-org page ourmartyrpreside00banc --leaf 0 --scale 2 --out ./cover.jpg
skills/archive-org/scripts/archive-org page ourmartyrpreside00banc 0 --width 1200 --out ./downloads

# Fetch several BookReader leaves in one call (max 25). --out must be a directory.
skills/archive-org/scripts/archive-org page ourmartyrpreside00banc --leaves 120-123,130 --scale 2 --out ./pages

# Fetch several printed pages. Ranges such as 670-674 are inclusive printed labels.
skills/archive-org/scripts/archive-org page ourmartyrpreside00banc --printed-pages 674,707,732 --out ./pages --json
```

Single-page URL patterns: `https://archive.org/download/<identifier>/page/n<leaf>_s<scale>.jpg` and `https://archive.org/download/<identifier>/page/n<leaf>_w<width>.jpg`. Returns HTTP 403 on borrow-only / `inlibrary` items.

`--leaves` and `--printed-pages` download the uncached JPEGs together, at most 4 at a time, and print them in the order you asked. Cached pages make no network request. Do not combine `--leaves` with `--printed-pages`. Do not combine either flag with `--leaf`, `--printed-page`, or a positional leaf. A call that asks for more than 25 pages exits with an error and does not fetch. When the call asks for more than one page, `--out` must be a directory. A `.jpg` path is rejected with an error that tells you to pass a directory.

A single page keeps the existing text line and the existing JSON object. More than one page with `--json` prints `identifier`, `count`, `pages`, and `cache_hit`. `cache_hit` is true only when every requested page came from disk. When the call uses `--printed-pages`, the page index must come from disk too.

### Read OCR text for specific pages (`text`) and resolve page numbers (`lookup`)

`text` reads the cached `djvu.txt` + `page_index.json` (populating them on a cache miss, same as `grep`), resolves printed page labels to BookReader leaves, and prints that page's OCR text with its leaf / printed-page / scandata-leaf metadata plus `image_url` and `details_url`. It never downloads a JPEG; use `page` only when you need to look at the scan. Pass exactly one of `--printed-page`, `--leaf`, or `--pages <p1-p2>` (inclusive printed-page range, which also covers unnumbered leaves between the endpoints):

```bash
# OCR text of printed page 12 (cache-hit repeat calls make zero HTTP requests)
kinloom ia text ourmartyrpreside00banc --printed-page 12

# A printed-page range or an explicit BookReader leaf, as JSON
kinloom ia text ourmartyrpreside00banc --pages 12-14 --json
kinloom ia text ourmartyrpreside00banc --leaf 7 --json
```

JSON shape: `{identifier, cached, pages: [{leaf, scandata_leaf, printed_page, text, image_url, details_url}]}`. An unknown printed page, out-of-range leaf, reversed range, or OCR text without page breaks exits nonzero with a clear message.

`lookup` resolves printed page <-> BookReader leaf <-> scandata leaf using only `metadata.json` + `page_index.json` (never fetches `djvu.txt` or JPEGs). Pass exactly one of `--printed-page`, `--leaf`, or `--scandata-leaf`:

```bash
kinloom ia lookup ourmartyrpreside00banc --printed-page 12
kinloom ia lookup ourmartyrpreside00banc --leaf 20 --json
kinloom ia lookup ourmartyrpreside00banc --scandata-leaf 21 --json
```

Both accept `--refresh` to re-fetch cached metadata/scandata (and OCR text for `text`).

### Search item metadata (`search`) vs full-text OCR (`fulltext`)

`search` calls `advancedsearch.php`, which searches **item metadata only** (title, creator, description, subjects), NOT the OCR text inside digitized books. Use `fulltext` to search across books, and `grep` to search inside specific known items:

```bash
# Metadata search: titles mentioning Lincoln
skills/archive-org/scripts/archive-org search 'title:(Lincoln)'

# Narrow metadata search to digitized texts for a historical figure
skills/archive-org/scripts/archive-org search '"Frederick Douglass"' --mediatype texts

# Sort by popularity, second page, full JSON
skills/archive-org/scripts/archive-org search 'title:(Lincoln)' --sort 'downloads desc' --rows 5
skills/archive-org/scripts/archive-org search 'title:(Lincoln)' --page 2
skills/archive-org/scripts/archive-org search 'title:(Lincoln)' --json

# Full-text OCR search inside digitized books (returns highlighted OCR snippets)
skills/archive-org/scripts/archive-org fulltext '"Abraham Lincoln" Gettysburg' --rows 5
skills/archive-org/scripts/archive-org fulltext '"Clara Barton" Red Cross' --json
```

The `search` query is Lucene syntax (see below). Default returned fields are `identifier`, `title`, `creator`, `date`, `mediatype`; pass `--field` (repeatable) to change them. A zero-hit `search` means no item metadata matched; run `fulltext` before concluding a name is absent from digitized directories or county histories.

### Read an item's metadata and files

```bash
skills/archive-org/scripts/archive-org get <identifier>
skills/archive-org/scripts/archive-org get <identifier> --files
skills/archive-org/scripts/archive-org get <identifier> --json
```

### Download files

```bash
# List an item's files first, then download the OCR text or PDF
skills/archive-org/scripts/archive-org download <identifier> --list
skills/archive-org/scripts/archive-org download <identifier> <identifier>_djvu.txt --out ./downloads
skills/archive-org/scripts/archive-org download <identifier> <identifier>.pdf --out ./downloads
```

The CLI refuses a file name that is not in the item's file list, so list first when unsure. Download URLs follow the site's redirect to the file server automatically.

### Build a website search URL offline

```bash
skills/archive-org/scripts/archive-org url 'title:(Lincoln)' --mediatype texts
```

## Advanced Search API (verified live 2026-11-24)

- Endpoint: `GET https://archive.org/advancedsearch.php`
- Auth: none for read access. No key is normally needed.
- Required params: `q` (Lucene query), `output=json`. Common params: `fl[]` (repeatable field list), `rows` (results per page, default 50), `page` (page number), `sort[]` (repeatable, e.g. `downloads desc`, `date asc`).
- Response shape: `{ responseHeader: { status: 0, QTime }, response: { numFound, start, docs: [...] } }`. `status: 0` means success.
- The human search UI lives at the same URL: `https://archive.org/advancedsearch.php` (interactive query builder at `https://archive.org/advancedsearch.php#raw`).
- Docs: `https://archive.org/help/json.php` and `https://archive.org/developers/index-apis.html`.

### Lucene query syntax (verified live)

- Fielded: `title:(Lincoln)`, `creator:(Douglass)`, `mediatype:(texts)`, `collection:(...)`, `year:1895`.
- Boolean: `title:(Lincoln) AND mediatype:(texts)`, `OR`, `NOT`, parentheses for grouping.
- Exact phrase: `"Clara Barton"`.
- Wildcard: `Clemens*`.
- Plain keywords match broadly across fields; quote exact names and use fielded queries to narrow results.

## Metadata API (verified live 2026-11-24)

- Endpoint: `GET https://archive.org/metadata/<identifier>`
- Auth: none. Returns JSON with `metadata` (title, creator, date, mediatype, collection, description, subject) and `files` (each with `name`, `format`, `size`, `md5`, `sha1`, `mtime`, `source`).
- Item page: `https://archive.org/details/<identifier>` (the metadata endpoint is the same path with `/details/` swapped to `/metadata/`).

## File download (verified live 2026-11-24)

- Pattern: `GET https://archive.org/download/<identifier>/<filename>` (follows a redirect to the file server; the CLI follows it).
- Common derivative files for a scanned book: `<id>.pdf` (full scan), `<id>_djvu.txt` (OCR text), `<id>_djvu.xml`, `<id>_files.xml` (file inventory), `<id>_meta.sqlite`. Always list the item's files first; not every derivative exists for every item.
- Be a good citizen: download only the files the research needs, one item at a time. Do not bulk-mirror collections. Uploads and writes need an account and are out of scope for this skill.

## Environment variables

- `KINLOOM_IA_CACHE_DIR` (optional): overrides the default `~/.cache/kinloom-ia` cache directory used by all network commands.
- `KINLOOM_IA_QUERY_TTL_HOURS` (optional): overrides the default `168` hour (7-day) TTL for cached `search` and `fulltext` responses. No API key or login is required.
