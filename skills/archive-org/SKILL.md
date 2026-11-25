---
name: archive-org
description: Search, inspect, and download Internet Archive items via the bundled uv-based `archive-org` CLI or the public advancedsearch and metadata APIs. Covers CLI usage, Lucene query syntax, field selection, pagination, file downloads, and worked examples. Use when finding digitized books, genealogies, newspapers, audio, or other archived material, or when downloading a full text or scan for family-history research.
---

# Archive.org

This skill includes a standalone executable Python CLI at `skills/archive-org/scripts/archive-org` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`). No virtualenv setup or API key is required. The APIs are public and read-only.

## Bundled CLI (`scripts/archive-org`)

Path: `skills/archive-org/scripts/archive-org`

### Search item metadata (`search`) vs full-text OCR (`fulltext`)

`search` calls `advancedsearch.php`, which searches **item metadata only** (title, creator, description, subjects), NOT the OCR text inside digitized books. Use `fulltext` to search inside digitized book and directory OCR pages:

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

### Download single high-res pages (`page`) without pulling huge PDFs

For large 100 to 250 MB county plat atlases or city directories, download `_djvu.txt` or `_hocr_pageindex.json.gz` first to identify the target leaf number (`n<leaf>`), then fetch just that single rendered JPEG page on unrestricted public-domain items:

```bash
# Fetch leaf 0 at 1200px or 2400px width (instead of downloading a 200 MB PDF)
skills/archive-org/scripts/archive-org page ourmartyrpreside00banc 0 --width 1200 --out ./downloads
```

Single-page URL pattern: `https://archive.org/download/<identifier>/page/n<leaf>_w<width>.jpg`. Returns HTTP 403 on borrow-only / `inlibrary` items.

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

None. No key, login, or account is needed for anything in this skill.
