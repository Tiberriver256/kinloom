---
name: minnesota-archives
description: Search Minnesota Historical Society (MNHS) public archives through the bundled `mn_archives.py` CLI: Minnesota Death Certificates Index (1904-2001), Birth Certificates Index (1900-1934), State Censuses (1849-1905), Veterans Graves Registration (1857-1975), WWI rolls, and the Minnesota Digital Newspaper Hub. Also documents the browser-only path for Minnesota Digital Library (MDL). Use when tracing ancestors in Minnesota, verifying vital certificate IDs, locating state census entries, or finding Minnesota newspaper issues.
---

# Minnesota Archives

This skill includes a standalone executable Python CLI at `skills/minnesota-archives/scripts/mn_archives.py` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependency `httpx`. No virtualenv setup or API key is required.

## Bundled CLI (`scripts/mn_archives.py`)

### Search MNHS Death Certificates Index (1904-2001)

```bash
# Search deaths by surname, county, and year range
skills/minnesota-archives/scripts/mn_archives.py death --last Olson --county Hennepin --begin-year 1910 --end-year 1920

# Search by exact certificate ID as JSON
skills/minnesota-archives/scripts/mn_archives.py death --cert-id 1910-MN-016385 --json

# Search by mother's maiden name (indexed for 1955-2001 deaths)
skills/minnesota-archives/scripts/mn_archives.py death --last Johnson --mother-maiden Anderson --begin-year 1955 --end-year 1970
```

Options: `--last`, `--first`, `--middle`, `--mother-maiden`, `--county`, `--match equals|starts-with|ends-with|contains|soundex` (default `equals`), `--begin-year`, `--end-year` (`YYYY` or `YYYY-MM-DD`), `--cert-id`, `--page` (default `1`), `--limit` (default `25`, max `100`), `--json`, `--refresh`, `--cache-ttl-hours`.

### Search MNHS Birth Certificates Index (1900-1934)

```bash
skills/minnesota-archives/scripts/mn_archives.py birth --last Olson --county Steele --begin-year 1915 --end-year 1925
skills/minnesota-archives/scripts/mn_archives.py birth --last Johnson --mother-maiden Nelson --json
```

### Search MNHS State Censuses (1849-1905) and Veterans Graves (1857-1975)

```bash
# Minnesota territorial and state censuses (1849, 1857, 1865, 1875, 1885, 1895, 1905)
skills/minnesota-archives/scripts/mn_archives.py census --last Olson --county "Big Stone" --begin-year 1895 --end-year 1895

# Veterans Graves Registration (1857-1975)
skills/minnesota-archives/scripts/mn_archives.py vets --last Olson --county Hennepin

# Search any MNHS People Records collection directly
skills/minnesota-archives/scripts/mn_archives.py people --type gold-star --last Johnson --json
```

Supported `--type` collections: `death-records` (`death`), `birth-records` (`birth`), `census`, `vets-graves` (`vets`), `gold-star`, `wwi-bonuses`, `wwi-service`, `wwi-soldiers-photos`.

### Fetch a single MNHS People Record detail

```bash
skills/minnesota-archives/scripts/mn_archives.py record <uuid> --type death --json
```

Returns the full MNHS JSON record payload plus the direct MNHS web permalink (`https://www.mnhs.org/search/people/record?uuid=<uuid>&recordType=<type>`).

### Search MNHS Digital Newspaper Hub (`newspapers.mnhs.org`)

```bash
# Full-text search across digitized Minnesota newspapers with a date range
skills/minnesota-archives/scripts/mn_archives.py newspapers search Olson --begin-year 1910 --end-year 1920 --limit 10

# Filter by county and output JSON
skills/minnesota-archives/scripts/mn_archives.py newspapers search Johnson --county Kandiyohi --begin-year 1915 --end-year 1920 --json

# Inspect structured issue metadata (title, collection, publication date, LCCN, OCLC)
skills/minnesota-archives/scripts/mn_archives.py newspapers metadata "<doc_id>" --json

# Download a verified issue thumbnail image
skills/minnesota-archives/scripts/mn_archives.py newspapers download "<doc_id>" --out ./downloads/mn-news/
```

### Minnesota Digital Library (browser only)

```bash
skills/minnesota-archives/scripts/mn_archives.py mdl
```

Prints the browser URLs for Minnesota Digital Library (`https://collection.mndigital.org/`). Automated HTTP requests to `collection.mndigital.org` return HTTP 403 from Cloudflare, so the CLI does not scrape it.

### Disk cache and environment variables

All search and metadata subcommands cache verified responses on disk under `~/.cache/kinloom/mn-archives/` (default TTL `168` hours, advisory `fcntl.flock` lock per cache key, atomic writes). HTTP errors and unverified responses are never cached.

- `--refresh`: bypass cached reads and write the fresh response to disk.
- `--cache-ttl-hours <hours>`: override cache TTL for one call (`0` disables reads).
- `KINLOOM_MN_ARCHIVES_CACHE_DIR`: override the cache directory directly.
- `KINLOOM_CACHE_DIR`: shared Kinloom cache root (stores under `<KINLOOM_CACHE_DIR>/mn-archives`).
- `KINLOOM_MN_ARCHIVES_CACHE_TTL_HOURS`: override default cache TTL in hours.

## Verified interface (verified live 2026-11-26)

- **MNHS People Records Search** (`https://www.mnhs.org/search/people`): backed by public JSON endpoints under `https://www.mnhs.org/_hcms/api` (no API key, no login). Returns structured index records, certificate IDs, dates, counties, and record UUIDs. Full birth and death certificate scans are orderable through MNHS; the RMA media host returns HTTP 403 directly, so this CLI returns the verified index metadata and MNHS record permalink rather than downloading restricted certificate scans.
- **MNHS Digital Newspaper Hub** (`https://newspapers.mnhs.org`): public search via `/jsp/PsSearchResults.jsp`, structured metadata via `/jsp/PsMetadata.jsp?doc_id=<id>`, browser issue viewer via `/jsp/PsImageViewer.jsp?doc_id=<id>`, and JPEG issue thumbnails via `/servlet/PsObjThumb?tnName=<id>`.
- **Minnesota Digital Library** (`https://collection.mndigital.org`): returns HTTP 403 (Cloudflare challenge) to automated clients; use a browser for MDL county histories, plat maps, photographs, and manuscripts.

## Research workflow

1. Start with `death` (1904-2001) and `birth` (1900-1934) by surname, county, and year window to capture exact MNHS certificate IDs and record UUIDs.
2. Run `census` for Minnesota territorial and state censuses (1849-1905) to fill the gap between federal decennial censuses (especially the lost 1890 federal census via the 1885 and 1895 Minnesota state censuses).
3. Follow up with `newspapers search` and `newspapers metadata` for obituaries, probate notices, and local news, then open the viewer URL in a browser to read and clip the full page.
4. For county histories, photographs, and plat books, search Minnesota Digital Library (`https://collection.mndigital.org/`) in a browser.
