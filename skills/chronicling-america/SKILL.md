---
name: chronicling-america
description: Search, inspect, and download historic American newspaper pages from the Library of Congress Chronicling America collection via the bundled uv-based `chronam` CLI or the loc.gov JSON API. Covers CLI usage, query parameters, date and state filters, pagination, and worked examples. Use when hunting estate notices, land sales, court dockets, obituaries, or family visits in local weeklies, or verifying newspaper evidence for genealogy.
---

# Chronicling America

This skill includes a standalone executable Python CLI at `skills/chronicling-america/scripts/chronam` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`). No virtualenv setup or API key is required.

- **Coverage:** millions of digitized U.S. newspaper pages, 1736 through 1963 (per the collection record; the site describes it as "through 1963").
- **Access:** the public loc.gov JSON API. No key, no account, no sign-in.
- **Rate limits:** be gentle. LoC asks users to stay within limits; search queries returning more than 100,000 results are too big for the API, so narrow with dates and other filters first. Loc.gov is also slow from some networks; allow up to 90 seconds per request.

## Bundled CLI (`scripts/chronam`)

Path: `skills/chronicling-america/scripts/chronam`

### Search newspaper pages

```bash
# Full-text search for a surname, page level, 10 results
skills/chronicling-america/scripts/chronam search Lincoln

# Surname search narrowed to 1860-1865
skills/chronicling-america/scripts/chronam search Lincoln --dates 1860/1865

# Illinois papers only (client-side state filter), JSON output
skills/chronicling-america/scripts/chronam search Lincoln --dates 1860/1865 --state Illinois --json

# One newspaper title only, by LCCN (Evening Star, Washington, D.C.)
skills/chronicling-america/scripts/chronam search "Clara Barton" --lccn sn83045462

# Second page of results, 25 per page
skills/chronicling-america/scripts/chronam search "Frederick Douglass" --dates 1870/1895 --limit 25 --page 2
```

### Inspect one page

```bash
# By loc.gov resource URL (copy it from a search result)
skills/chronicling-america/scripts/chronam get "https://www.loc.gov/resource/<lccn>/<YYYY-MM-DD>/ed-1/?sp=<seq>"

# Or build the URL from LCCN + date + page sequence
skills/chronicling-america/scripts/chronam get --lccn sn83045462 --date 1865-04-15 --seq 1 --json
```

`get` prints the paper title, date, place, and the download links: `pdf` (full page), `image` (IIIF rendition as served, reduced size), `fulltext_file` (ALTO XML word-coordinates file carrying the OCR text), and `iiif_manifest_url`.

### Download a page

```bash
# PDF + metadata JSON into ./downloads/chronam
skills/chronicling-america/scripts/chronam download --lccn sn83045462 --date 1865-04-15 --seq 1 --out ./downloads/chronam

# Also fetch the OCR (ALTO XML) and the image rendition
skills/chronicling-america/scripts/chronam download --lccn sn83045462 --date 1865-04-15 --seq 1 --out ./downloads/chronam --text --image
```

Files are named `<lccn>_<date>_sp<seq>.pdf` (etc.) with a matching `<stem>.metadata.json`.

### Build a website search URL

```bash
skills/chronicling-america/scripts/chronam url "Susan B. Anthony" --dates 1870/1900
```

## Website search & API rules (verified live 2026-11-24)

- Collection site: `https://www.loc.gov/collections/chronicling-america/`
- JSON API base: `GET https://www.loc.gov/collections/chronicling-america/?{params}&fo=json`
- **Use `q=` for the search words.** `q` runs a full-text search over page OCR and populates `search.query` in the JSON response.
- **Do NOT use `qs=` on the JSON API.** The Library's own data-exploration README documents `qs=` (with `ops=`, `searchType=advanced`), but verified live 2026-11-24 it is ignored by the JSON endpoint: even the README's verbatim example URL (`qs=cat`, California, Oct-Dec 1924) returned the whole collection (23,852,658 hits, first result an unrelated 1913 Atlanta paper). `qs`/`ops` belong to the website's advanced-search form, not to the JSON API. Use the website for phrase/proximity searching, or test `ops` against `q` before relying on it.
- **Date filter `dates=YYYY/YYYY` works** to narrow large full-text result sets.
- **Display level `dl=`:** `page` (default for full-text page results), `issue`, `title`, `all`. Pass `dl=page` for OCR searching.
- **Pagination:** `c=` results per page, `sp=` page number (1-based). `sp` is also the page sequence inside an issue URL (`?sp=1` = 1st page of the issue).
- **Item JSON:** append `fo=json` to a resource URL, e.g. `https://www.loc.gov/resource/<lccn>/<YYYY-MM-DD>/ed-1/?sp=<seq>&fo=json`. The `resources[]` array holds `pdf`, `image`, `fulltext_file`, and `iiif_manifest_url` (`tile.loc.gov` hosts). Note: the storage-services `pdf` URL returns 403 without a `Referer: https://www.loc.gov/` header (verified 2026-11-24); the CLI sends one on downloads. The `image` and `fulltext_file` URLs fetch without it.
- **State / LCCN filters:** the README documents server-side facets (`fa=number_lccn:sn83045462`, `fa=batch:...`, `location_state=california`). Those were NOT re-verified live against the JSON API (see the `qs` finding above), so the CLI filters by `location_state` / `number_lccn` client-side on the returned page instead. If a query is too large to filter client-side, narrow with `dates=` first.
- **Multi-word queries:** `q` with several words was not verified for AND vs OR behavior; treat multi-word `q` as a broad match and verify the hit count before bulk work. For exact-phrase searching use the website's advanced search.

### Example URL patterns

- Surname search, page level: `https://www.loc.gov/collections/chronicling-america/?dl=page&fo=json&q=Lincoln&c=3`
- Date-bounded search: `https://www.loc.gov/collections/chronicling-america/?dl=page&fo=json&q=Lincoln&c=1&dates=1860/1865`
- One page as JSON: `https://www.loc.gov/resource/<lccn>/<YYYY-MM-DD>/ed-1/?sp=<seq>&fo=json`

## What is dead (verified 2026-11-24)

- The old Chronicling America API at `chroniclingamerica.loc.gov/search/pages/results/?...&format=json` returns **404**. Third-party API directories (publicapi.dev, publicapis.io) still document it, including claims that an API key is required. Both claims are wrong now: the endpoint is gone, and the loc.gov API never needs a key.
- `chroniclingamerica.loc.gov/about/api/` returns 403.
- The loc.gov HTML pages return 403 to plain scripted requests; use the `fo=json` endpoints for machine access.

## Environment variables

- None. No key or account is needed.

## Research workflow notes

- OCR is imperfect: try spelling variants and initials (for example `"S. L. Clemens"` and `"Samuel Clemens"`) as separate searches.
- Estate notices, land sales, and court dockets cluster in county-seat weeklies. Once a promising title is found, note its LCCN and re-run with `--lccn` plus a tight `--dates` window.
- A page hit is not a citation yet: open the PDF, confirm the name in context, and record the paper title, date, page (`sp=`), and LCCN alongside the quote.
