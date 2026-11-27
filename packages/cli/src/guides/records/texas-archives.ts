import type { EmbeddedGuide } from '../types.js';

export const TEXAS_ARCHIVES_GUIDE: EmbeddedGuide = {
  id: 'texas-archives',
  command: 'texas-archives',
  category: 'state-archives',
  summary: 'Search Portal to Texas History, TSLAC, and Texas GLO land grants',
  body: `# Texas Archives

Texas genealogical research splits across three primary repositories, queried via \`kinloom texas-archives\`.

Portal: https://texashistory.unt.edu/
TSLAC Texas Digital Archive: https://tsl.access.preservica.com/
Texas GLO land grants (state, not federal): https://s3.glo.texas.gov/lookup/index.php
TSLAC home: https://www.tsl.texas.gov/

No account or API key is needed for anything the CLI runs. Texas was not a U.S. public-land state, so federal BLM GLO patents do not cover antebellum Texas land. Use the Texas GLO lookup for Spanish and Mexican grants and republic-era patents, and county deed books for later transfers.

## CLI usage (\`kinloom texas-archives\`)

\`\`\`bash
kinloom texas-archives portal search "Sam Houston" --county Travis --limit 5
kinloom texas-archives portal search Houston --county Harris --limit 5 --json
kinloom texas-archives portal search "Texas Rangers" --type text_newspaper --limit 5
kinloom texas-archives portal item <metapth-id> --json
kinloom texas-archives tda Houston --limit 10
kinloom texas-archives url Austin
\`\`\`

| Command | Machine interface (verified 2026-11-24) |
|---|---|
| \`portal search QUERY... [--county] [--date-from] [--date-to] [--type] [--limit N] [--pages N] [--json]\` | \`GET https://texashistory.unt.edu/search/opensearch/?q=<query>&format=json&pw=<page>\` — 100 hits per page, \`opensearch:totalResults\` in JSON |
| \`portal item ARK [--json]\` | \`GET https://texashistory.unt.edu/oai/?verb=GetRecord&identifier=ark:/67531/<id>&metadataPrefix=oai_dc\` |
| \`tda QUERY [--limit N] [--json]\` | \`GET https://tsl.access.preservica.com/search/<term>/feed/rss2/\` fetched with **curl** (direct HTTP clients get HTTP 403 on this host) |
| \`url [QUERY] [--portal] [--tda] [--glo] [--rangers] [--tslac]\` | Prints verified URLs only; no HTTP search |

\`portal search\` accepts multiple words (\`Texas Rangers\`). \`--county\` adds the county name to the OpenSearch query and filters hits whose title or description mentions that county. \`--date-from\` / \`--date-to\` filter on the OpenSearch \`dc:date\` field after pages are fetched. \`--type\` filters \`dc:type\` (for example \`text_newspaper\`). OpenSearch query parameters for county or type were **not** verified on the server side. The CLI applies filters locally.

## Portal to Texas History (UNT)

The Portal holds digitized newspapers, local histories, maps, photographs, and yearbooks from Texas partners across the state.

**Search (CLI):** OpenSearch JSON is public. No ALTCHA and no API key. \`portal search\` returns up to 100 hits per OpenSearch page along with \`opensearch:totalResults\`, titles, dates, types, and ARK identifiers.

**Item metadata (CLI):** OAI-PMH \`GetRecord\` with \`identifier=ark:/67531/<metapth...>\` returns Dublin Core metadata (titles, creators, dates, subjects, types, and descriptions).

**Browser-only:** HTML search at \`/search/?q=...&t=fulltext\` redirects to \`/dam/\` (ALTCHA challenge). Item landing pages, page images (\`/m1/\`), and per-page OCR URLs return the same challenge or 404 to plain HTTP. Read newspapers and books in the browser after the CLI gives you the ARK and URL.

**OCR / IIIF:** No public OCR download URL or IIIF manifest was verified live for sample ARKs (\`ocr.txt\`, \`iiif/manifest\`, \`mets.xml\` returned 404). Use the item page in the browser for full text where the Portal provides it.

## Texas State Library and Archives Commission (TSLAC)

**Texas Digital Archive (TDA):** Preservica Universal Access at \`tsl.access.preservica.com\`. The WordPress search RSS feed lists up to about 25 hits per query. The CLI uses **curl** for that feed because other HTTP clients receive HTTP 403 on this host while curl receives HTTP 200 (verified same day). Full-text search in the feed covers titles, descriptions, and (per TSLAC) document content, so open each hit to see why it matched.

Ranger pensions and Adjutant General muster rolls are **not** fully exposed through this RSS route. Use open-records or reading-room paths documented on \`tsl.texas.gov\`.

**Texas Rangers:** Collection pointer \`https://www.tsl.texas.gov/agency/items/texas-rangers\`. Muster rolls and service files require a specific record series citation from TSLAC or the Adjutant General, then mail or an in-person visit.

## Texas General Land Office (state grants)

\`https://s3.glo.texas.gov/lookup/index.php\` returned HTTP 200 with a Salesforce/semantic UI shell (live 2026-11-24). A POST with name and county fields did not return a parseable results table to the CLI. Treat grant search as **browser-only**. Federal patents belong in \`kinloom guide blm-glo\` only for public-land states, not for republic-era or state Texas land.

## Research workflow

Worked order for tracing a person or family in Texas:

1. \`kinloom texas-archives portal search "<Full Name>" --county <County>\` and \`kinloom texas-archives portal search <Surname> --county <County> --type text_newspaper\` for local newspapers and county histories.
2. Search name variants (initials, spouse's maiden name, and town names) with \`--county\` or \`--date-from\` / \`--date-to\`.
3. For Texas Ranger service claims, search background material in the Portal, then follow TSLAC Ranger collection pointers and open-records request paths for muster rolls.
4. Run \`kinloom texas-archives portal item <ark>\` on promising hits to pull Dublin Core metadata, then open the Portal URL in a browser to read scans.
5. Run \`kinloom texas-archives tda <Surname>\` and \`kinloom texas-archives tda <Town>\` for state-archive newspapers and agency records not duplicated on the Portal.
6. Search the Texas GLO lookup in the browser for land grants, then follow up in county clerk deed books and vital records.

## Verification log (verified live 2026-11-24)

- \`https://texashistory.unt.edu/\` — HTTP 200.
- OpenSearch JSON (\`?q=<query>&format=json\`) — HTTP 200, \`application/json\`, \`opensearch:totalResults\` present.
- OAI \`ListSets\` and \`GetRecord\` (\`metadataPrefix=oai_dc\`) — HTTP 200, valid Dublin Core XML.
- Portal HTML search (\`/search/?q=...&t=fulltext\`) and item image views (\`/ark:/67531/.../m1/\`) — HTTP 302 to \`/dam/?next=...\` (ALTCHA). Browser-only for HTML UI and images.
- \`https://tsl.access.preservica.com/\` — HTTP 200.
- TDA RSS (\`/search/<term>/feed/rss2/\`) — HTTP 200 via curl (up to 25 \`<item>\` elements); HTTP 403 via plain TLS client (same User-Agent).
- \`https://s3.glo.texas.gov/lookup/index.php\` — HTTP 200 SPA shell; no verified machine search API.
- \`https://www.tsl.texas.gov/\` — HTTP 200.
- CLI \`portal search\`, \`portal item\`, \`tda\`, \`url\` — all exited 0 on verification runs.

## Disk cache and environment variables

\`portal search\` (per OpenSearch page), \`portal item\`, and \`tda\` cache successful responses on disk under \`~/.cache/kinloom-texas-archives/\` (default TTL \`168\` hours, advisory locking per cache key, atomic temp-file writes). HTTP errors, curl failures, OAI errors, and empty/unverified payloads are never cached.

- \`--refresh\`: bypass cached reads and write the fresh response to disk.
- \`--cache-ttl-hours <hours>\`: override TTL for one call (\`0\` disables cached reads).
- \`KINLOOM_TEXAS_ARCHIVES_CACHE_DIR\`: override the cache directory path.
- \`KINLOOM_TEXAS_ARCHIVES_CACHE_TTL_HOURS\`: override the default TTL in hours.

## What this guide does not cover

- Federal BLM GLO (public-land states) — see \`kinloom guide blm-glo\`; Texas state land is separate.
- FamilySearch, Ancestry, or Fold3 indexes; cite them only when a Texas portal points there.
- County clerk vital records and deed books. The Portal and TDA may name people in newspapers or books, but they do not replace certified copies.
- Do not claim a machine API for Portal HTML, GLO grant search, or Ranger muster rolls without a live verified endpoint.

## Kinloom Research Package workflow

Never edit \`data/*.yaml\` directly from a research session. Follow Kinloom's staged **Research Package** workflow and **Living Privacy Rule** (never include living people's portraits, exact birth dates, street addresses, or pronunciations in public archives):

1. Discover research targets with \`kinloom status --missing-biography\` or \`kinloom status --end-of-line\`.
2. Gather privacy-fenced context with \`kinloom context <person_id> --include-family\`.
3. Stage any downloaded images or documents under \`research/people/<person_id>/scans/\` and prepare them with \`kinloom prep-scan\` or \`kinloom ocr\` when needed.
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
