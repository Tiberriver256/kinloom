import type { EmbeddedGuide } from '../types.js';

export const CHRONAM_GUIDE: EmbeddedGuide = {
  id: 'chronam',
  command: 'chronam',
  category: 'federal-general',
  summary: 'Search and download Library of Congress Chronicling America newspapers',
  body: `# Chronicling America

Search, inspect, and download historic American newspaper pages from the Library of Congress Chronicling America collection via \`kinloom chronam\`. No API key or login is required.

- **Coverage:** millions of digitized U.S. newspaper pages, 1736 through 1963 (per the collection record; the site describes it as "through 1963").
- **Access:** the public loc.gov JSON API. No key, no account, no sign-in.
- **Latency (measured 2026-11-25):** every loc.gov collection search takes **20-45 s** on the server side. Connect + TLS take under 0.1 s, but time-to-first-byte was 19-43 s for every query shape tried (with or without \`q\`, \`dates\`, \`fa=location_state\`, \`dl=page\`, \`at=results\` vs \`at=search,results\`, HTTP/1.1 vs HTTP/2, kinloom vs browser User-Agent). One probe under 6 parallel requests took 70 s. The old 8 s default timeout therefore failed 80%+ of searches. The default \`--timeout\` is now **120 s**. \`/newspapers/?fo=json\` returned 0 hits for the same query, and \`/search/?fa=partof:chronicling+america\` 302-redirects to the collection endpoint, so neither is faster.
- **Disk cache:** every successful search, every \`get\` item record, and every \`download\` file is cached, so a repeat returns with no network call. See [Disk cache](#disk-cache).
- **Rate limits:** be gentle. LoC asks users to stay within limits; search queries returning more than 100,000 results are too big for the API, so narrow with \`--dates\`, \`--state\`, or \`--lccn\` first. The CLI retries HTTP 429, 500, 502, 503, 504, 520, 522, and 524 plus transport and timeout errors up to 4 attempts, honoring numeric or HTTP-date \`Retry-After\` headers (capped at 30 s) with jittered exponential backoff.
- **Unstable hit counts (measured 2026-11-25):** loc.gov can return very different \`hits\` for byte-identical requests. \`Merced\` + California + 1900/1920 returned 32, then 34,133, then 35,404. \`Abraham Lincoln\` returned 0, then 25,392, then 77,301. So a low or zero count is **not** evidence of absence. The CLI never caches a zero-hit answer. To recheck a suspiciously low count, rerun with \`--refresh\`.

## CLI usage (\`kinloom chronam\`)

### Search newspaper pages

\`\`\`bash
# Full-text search for a surname, page level, 10 results
kinloom chronam search Lincoln

# Multi-word queries need no quotes; postal codes work for --state
kinloom chronam search Abraham Lincoln --state IL --dates 1860/1865

# Surname search narrowed to 1860-1865 (or --date-from 1860 --date-to 1865)
kinloom chronam search Lincoln --dates 1860/1865

# Illinois papers only (server-side state facet), JSON output
kinloom chronam search Lincoln --dates 1860/1865 --state Illinois --json

# One newspaper title only, by LCCN (Evening Star, Washington, D.C.)
# Use one distinctive word with --lccn: measured 2026-11-25, "Clara Barton" + this LCCN
# returned 0 hits on three tries, while "Barton" + the same LCCN returned 38,628.
kinloom chronam search Barton --lccn sn83045462

# Second page of results, 25 per page (--per-page is an alias for --limit)
kinloom chronam search "Frederick Douglass" --dates 1870/1895 --limit 25 --page 2
\`\`\`

Options: \`--dates YYYY/YYYY\` or \`YYYY\` (or \`--date-from\`/\`--from-year\`/\`--date1\`/\`--year1\` and \`--date-to\`/\`--to-year\`/\`--date2\`/\`--year2\`), \`--state\` (name or postal code), \`--lccn\`, \`--level\` (\`page\`/\`issue\`/\`title\`/\`all\`), \`--limit\` / \`--per-page\` / \`--rows\` / \`-n\`, \`--page\` / \`-p\`, \`--timeout\` (seconds, default \`120\`), \`--terms\` / \`--query\` / \`-q\` (alias for positional query), \`--refresh\`, \`--cache-ttl-hours\`, \`--json\`. JSON output carries \`"cache_hit": true|false\`; text output marks hits with \`[cache]\`.

### Disk cache

- Location: \`~/.cache/kinloom-chronam/\` (override with \`KINLOOM_CHRONAM_CACHE_DIR\`).
- Search and \`get\` store one JSON file per request, keyed by the SHA-256 of the URL and sorted query parameters.
- \`download\` streams each \`https://*.loc.gov\` file into a temporary file under \`files/<sha256>.bin\` with a sidecar \`files/<sha256>.json\`, validates that HTML error pages are refused for PDF, JPEG, JP2, and ALTO XML assets, and renames atomically. A cache hit copies those bytes to \`--out\` and does not open a connection. Output names are a single path segment, so a date or LCCN that contains \`..\` or a slash cannot write outside \`--out\`.
- \`--json\` on \`search\`, \`get\`, \`page\` (alias for \`get\`), and \`download\` emits a top-level boolean \`cache_hit\`.
- TTL: 168 hours (override with \`--cache-ttl-hours\` or \`KINLOOM_CHRONAM_CACHE_TTL_HOURS\`; \`0\` disables reads). The same TTL covers search JSON, \`get\`/\`page\` JSON, and downloaded files.
- \`--refresh\` re-queries loc.gov and rewrites the entry, including downloaded files.
- Zero-hit search answers are never cached (see unstable hit counts above). Empty downloads are not cached.
- Writes are atomic (temp file + rename). Per-key advisory locking makes concurrent agents that run the same request wait for the first one and then read its file, so loc.gov sees one request.

### Inspect one page

\`\`\`bash
# By loc.gov resource URL (copy it from a search result)
kinloom chronam get "https://www.loc.gov/resource/<lccn>/<YYYY-MM-DD>/ed-1/?sp=<seq>"

# Or build the URL from LCCN + date + page sequence
kinloom chronam get --lccn sn83045462 --date 1865-04-15 --seq 1 --json
\`\`\`

\`get\` prints the paper title, date, place, and the download links: \`pdf\` (full page), \`image\` (IIIF rendition as served, reduced size), \`fulltext_file\` (ALTO XML word-coordinates file carrying the OCR text), and \`iiif_manifest_url\`.

### Download a page

\`\`\`bash
# PDF + metadata JSON into ./downloads/chronam
kinloom chronam download --lccn sn83045462 --date 1865-04-15 --seq 1 --out ./downloads/chronam

# Also fetch the OCR (ALTO XML) and the image rendition
kinloom chronam download --lccn sn83045462 --date 1865-04-15 --seq 1 --out ./downloads/chronam --text --image
\`\`\`

Files are named \`<lccn>_<date>_sp<seq>.pdf\` (etc.) with a matching \`<stem>.metadata.json\`. The first download fetches the file. The next download of the same URL copies it from \`~/.cache/kinloom-chronam/files/\` and makes no HTTP request. \`--refresh\` fetches again. A hit line ends with \`[cache]\`.

### Build a website search URL

\`\`\`bash
kinloom chronam url "Susan B. Anthony" --dates 1870/1900
\`\`\`

## Website search & API rules (verified live 2026-11-24)

- Collection site: \`https://www.loc.gov/collections/chronicling-america/\`
- JSON API base: \`GET https://www.loc.gov/collections/chronicling-america/?{params}&fo=json\`
- **Use \`q=\` for the search words.** \`q\` runs a full-text search over page OCR and populates \`search.query\` in the JSON response.
- **Do NOT use \`qs=\` on the JSON API.** The Library's own data-exploration README documents \`qs=\` (with \`ops=\`, \`searchType=advanced\`), but verified live 2026-11-24 it is ignored by the JSON endpoint: even the README's verbatim example URL (\`qs=cat\`, California, Oct-Dec 1924) returned the whole collection (23,852,658 hits, first result an unrelated 1913 Atlanta paper). \`qs\`/\`ops\` belong to the website's advanced-search form, not to the JSON API. Use the website for phrase/proximity searching, or test \`ops\` against \`q\` before relying on it.
- **Date filter \`dates=YYYY/YYYY\` works** to narrow large full-text result sets.
- **Display level \`dl=\`:** \`page\` (default for full-text page results), \`issue\`, \`title\`, \`all\`. Pass \`dl=page\` for OCR searching.
- **Pagination:** \`c=\` results per page, \`sp=\` page number (1-based). \`sp\` is also the page sequence inside an issue URL (\`?sp=1\` = 1st page of the issue).
- **Item JSON:** append \`fo=json\` to a resource URL, e.g. \`https://www.loc.gov/resource/<lccn>/<YYYY-MM-DD>/ed-1/?sp=<seq>&fo=json\`. The \`resources[]\` array holds \`pdf\`, \`image\`, \`fulltext_file\`, and \`iiif_manifest_url\` (\`tile.loc.gov\` hosts). Note: the storage-services \`pdf\` URL returns 403 without a \`Referer: https://www.loc.gov/\` header (verified 2026-11-24); the CLI sends one on downloads. The \`image\` and \`fulltext_file\` URLs fetch without it.
- **State / LCCN filters (verified live 2026-11-25):** server-side facets \`fa=location_state:<lowercase-state>\` (for example \`fa=location_state:illinois\`) and \`fa=number_lccn:<lccn>\` work on the \`fo=json\` endpoint; bare \`location_state=<state>\` is ignored. The CLI sends \`fa=\` filters server-side so common surnames are not hidden behind nationwide hits. Note two LoC quirks: \`loc.gov\` occasionally drops a connection or returns a transient 0-hit response under load (the CLI retries once on dropped connections and warns when \`hits > 0\` with empty \`results\`), and a handful of digitized titles carry an incorrect \`location_state\` in LoC's metadata even when \`location_county\` is right, so verify by \`--lccn\` when targeting a known local paper.
- **Multi-word queries:** \`q\` with several words was not verified for AND vs OR behavior; treat multi-word \`q\` as a broad match and verify the hit count before bulk work. For exact-phrase searching use the website's advanced search.

### Example URL patterns

- Surname search, page level: \`https://www.loc.gov/collections/chronicling-america/?dl=page&fo=json&q=Lincoln&c=3\`
- Date-bounded search: \`https://www.loc.gov/collections/chronicling-america/?dl=page&fo=json&q=Lincoln&c=1&dates=1860/1865\`
- One page as JSON: \`https://www.loc.gov/resource/<lccn>/<YYYY-MM-DD>/ed-1/?sp=<seq>&fo=json\`

## What is dead (verified 2026-11-24)

- The old Chronicling America API at \`chroniclingamerica.loc.gov/search/pages/results/?...&format=json\` returned **404** on 2026-11-24 and a Cloudflare **308** redirect on 2026-11-25. Third-party API directories (publicapi.dev, publicapis.io) still document it, including claims that an API key is required. Both claims are wrong now: the endpoint is gone, and the loc.gov API never needs a key.
- \`chroniclingamerica.loc.gov/about/api/\` returns 403.
- The loc.gov HTML pages return 403 to plain scripted requests; use the \`fo=json\` endpoints for machine access.

## Environment variables

- No key or account is needed.
- \`KINLOOM_CHRONAM_CACHE_DIR\` (optional): cache directory (default \`~/.cache/kinloom-chronam\`).
- \`KINLOOM_CHRONAM_CACHE_TTL_HOURS\` (optional): cache TTL in hours (default \`168\`).

## Research workflow notes

- OCR is imperfect: try spelling variants and initials (for example \`"S. L. Clemens"\` and \`"Samuel Clemens"\`) as separate searches.
- Estate notices, land sales, and court dockets cluster in county-seat weeklies. Once a promising title is found, note its LCCN and re-run with \`--lccn\` plus a tight \`--dates\` window.
- A page hit is not a citation yet: open the PDF, confirm the name in context, and record the paper title, date, page (\`sp=\`), and LCCN alongside the quote.

## Kinloom Research Package workflow

Never edit \`data/*.yaml\` directly from a research session. Follow Kinloom's staged **Research Package** workflow and **Living Privacy Rule** (never include living people's portraits, exact birth dates, street addresses, or pronunciations in public archives):

1. Discover research targets with \`kinloom status --missing-biography\` or \`kinloom status --end-of-line\`.
2. Gather privacy-fenced context with \`kinloom context <person_id> --include-family\`.
3. Prepare downloaded scans with \`kinloom prep-scan\` (for example \`kinloom prep-scan crop --redact-orig\`) and run \`kinloom ocr\` as needed, then stage scans under \`research/people/<person_id>/scans/\`.
4. Write cited findings into \`research/people/<person_id>/patch.json\`.
5. Audit, integrate, verify, and sync:

\`\`\`bash
kinloom audit --all-staged --pending-only --strict
kinloom integrate --all-staged --pending-only
kinloom pronounce audit --strict
kinloom verify
kinloom migrate
kinloom sync --sync-missing-media --verify-live
\`\`\``,
};
