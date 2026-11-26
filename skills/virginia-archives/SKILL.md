---
name: virginia-archives
description: Research historical and genealogical records at the Library of Virginia via the bundled `va-archives` CLI: Chancery Records Index search, case detail, and scanned-page download, plus the public Primo catalog API, Land Office and Dunmore's War TIFF scans from image.lva.virginia.gov, and Rosetta (IE id) file downloads, all disk-cached. Also covers Virginia Chronicle newspapers, Land Office patents and grants, Virginia Untold, and ARVAS finding aids, with an honest note on which of those are browser-only. Use when tracing ancestors through Virginia, finding chancery causes, land patents, newspaper notices, or catalog records held by the Library of Virginia, or deciding whether a Virginia record is online, orderable, or visit-only.
---

# Virginia Archives: Library of Virginia

Portal: https://www.lva.virginia.gov/collections
Digital collections: https://www.lva.virginia.gov/collections/digital-collections
Address: 800 East Broad Street, Richmond, Virginia 23219. Phone 804-692-3500.

The Library of Virginia is both the state library and the state archives. It holds more than 130 million items.

## Bundled CLI (`scripts/va-archives`)

Path: `skills/virginia-archives/scripts/va-archives`

A standalone executable Python CLI with a PEP 723 `#!/usr/bin/env -S uv run --script` shebang and inline dependencies (`click`, `httpx`, `pillow`). No virtualenv setup, no API key, no account. Run it from the repo root, e.g. `skills/virginia-archives/scripts/va-archives chancery search Lincoln`.

The Library of Virginia exposes real machine interfaces, verified live on 2026-11-24 (see Verification log). The CLI uses plain HTTP for everything it does; no browser automation is bundled. `--json` objects from `chancery search`, `chancery case`, `catalog`, `grant-tif`, `lva-tif`, `dunmore`, and `download-rosetta` include a boolean `cache_hit`. It is true only when every fetch in that command was read from disk. `chancery localities --json` stays a list and does not include `cache_hit`.

### Chancery Records Index

```bash
# Surname search (match defaults to Starts; 20 records per page)
skills/virginia-archives/scripts/va-archives chancery search Lincoln
skills/virginia-archives/scripts/va-archives chancery search Lincoln --locality "ROCKINGHAM CO" --year-from 1800 --year-to 1850
skills/virginia-archives/scripts/va-archives chancery search Lincoln --match Includes --pages 1-3 --json

# One cause by CFN, with its scanned-page list
skills/virginia-archives/scripts/va-archives chancery case <cfn> --images

# Download scanned pages (real PDFs) plus metadata.json; --zip for the whole-case ZIP
skills/virginia-archives/scripts/va-archives chancery download <cfn> --pages 1-5 --out ./downloads/va-chancery
skills/virginia-archives/scripts/va-archives chancery download <cfn> --zip

# Per-locality coverage: region, time frame, viewing status
skills/virginia-archives/scripts/va-archives chancery localities
skills/virginia-archives/scripts/va-archives chancery localities --status Scanned --json
```

Search options mirror the index form exactly: `--surname2`, `--plaintiff-last` / `--plaintiff-first`, `--defendant-last` / `--defendant-first`, `--index-number`, `--local-case-number`, `--enslaved`, `--free`, `--plats`, `--match Exact|Starts|Includes`. Multiple surnames on one command are ORed (one search each; totals add).

A chancery cause (equity suit: estate divisions, disputed wills, guardianships, divorces, debt suits) can name three generations at once through depositions and exhibits, making it one of the highest-value Virginia genealogical sources. The index covers over 100 of the Commonwealth's 133 localities, with a focus on pre-1913 causes. Check `chancery localities` first: it shows per locality whether indexed data exists, whether images are digitized, and whether the locality is closed for processing.

### Library catalog (Primo PNXS API)

```bash
skills/virginia-archives/scripts/va-archives catalog Lincoln
skills/virginia-archives/scripts/va-archives catalog Lincoln --field title --limit 5 --offset 5 --json
```

The catalog runs on Primo (`lva.primo.exlibrisgroup.com`). The CLI queries its public, key-free PNXS JSON API (`/primaws/rest/pub/pnxs?q=<field>,contains,<query>&vid=01LVA_INST:01LVA&scope=MyInstitution`). Verified fields are `any`, `title`, and `creator`. Each hit prints title, creator, date, type, and a fulldisplay record URL built from the PNXS recordid in the standard Primo pattern. Use it for books, government publications, archives and manuscript collections, Bible and church records, and select maps. Land Office patents and grants are also discoverable here by surname; see below for the dedicated index.

### URL builders (no search run)

```bash
skills/virginia-archives/scripts/va-archives url --chancery-case <cfn>
skills/virginia-archives/scripts/va-archives url --catalog Lincoln
skills/virginia-archives/scripts/va-archives url --chronicle --land --arvas
```

### Image server scans: `grant-tif` (alias `lva-tif`) and `dunmore`

```bash
# One Land Office patent/grant page (raw TIFF, or JPEG when --out ends in .jpg/.jpeg)
skills/virginia-archives/scripts/va-archives grant-tif /LONN/LO-3/372/372_0195.tif --out patent.tif
skills/virginia-archives/scripts/va-archives lva-tif https://image.lva.virginia.gov/LONN/LO-3/372/372_0195.tif --out patent.jpg

# Dunmore's War (1774) card -> neighbouring page TIFFs; save the card's page (or --page N)
skills/virginia-archives/scripts/va-archives dunmore <DRAWER> <CARD>
skills/virginia-archives/scripts/va-archives dunmore <DRAWER> <CARD> --page 100 --out dw-page100.jpg --json
```

`grant-tif` fetches a single scan from `image.lva.virginia.gov` only. It accepts a full `https://image.lva.virginia.gov/...` URL or a path on that host, and it rejects any other host or scheme (including plain `http://`), credentials, ports, query strings, `.`/`..` segments (raw or percent-encoded), backslashes, and non-image suffixes. If the server redirects to another host, the download is refused. `--out *.jpg` converts TIFF to JPEG when Pillow is importable; Pillow is in the script's inline dependencies, so it is available under `uv run`. Without Pillow, the raw TIFF is written next to the requested file with a `.tif` suffix. Any other suffix gets the raw bytes. Land Office TIFF links appear in Primo catalog records (`catalog <surname> --json`).

`dunmore DRAWER CARD` takes the `dir` and `card` values from the catalog's `GetDW.pl?dir=<dddd>/W<dddd>&card=<n>` links (Dunmore's War payroll and service-claim index cards). The CGI redirects to a `/cgi-bin/drawer` page that lists neighbouring microfilm page TIFFs under `/Microfilm/DW/<reel>/<nnnnn>.tif`. The command lists those pages and marks the card's own page, which is the link with no "Page N" label. `--out` saves the card's page, or the page chosen with `--page N`, through the same validated, cached download as `grant-tif`.

### Rosetta delivered files: `download-rosetta`

```bash
skills/virginia-archives/scripts/va-archives download-rosetta IE3453061 --list
skills/virginia-archives/scripts/va-archives download-rosetta IE3453061 --out item.pdf          # viewer's initial file
skills/virginia-archives/scripts/va-archives download-rosetta IE3453061 --file 2 --json         # e.g. the Transcription
skills/virginia-archives/scripts/va-archives download-rosetta IE3453061 --fl FL3453067
```

The Library's digital objects live in Ex Libris Rosetta at `rosetta.virginiamemory.com`. Primo records link them as `DeliveryManagerServlet?dps_pid=IE<n>`. The command validates the id with `^IE\d+$` and keeps a single cookie session while it resolves the item. It reads the delivery page's `ieViewer.do` iframe (with its `dps_dvs` token), takes the `FL<n>` file pids and their METS titles from the viewer, and streams the chosen file from `DeliveryManagerServlet?dps_pid=FL<n>&dps_func=stream`. Every hop must stay on `https://rosetta.virginiamemory.com`. If the server returns an HTML page instead of a file, the command treats the item as restricted. The output name defaults to `<IE>_<FL>.<ext>`, with the extension taken from the content type.

### Disk cache

Every network response is cached under `$KINLOOM_VA_ARCHIVES_CACHE_DIR`. The default is `$XDG_CACHE_HOME/kinloom-va-archives`, or `~/.cache/kinloom-va-archives` when `XDG_CACHE_HOME` is unset. Writes go to a temp file that is then renamed into place, under a per-entry `fcntl.flock`.

- `http/`: chancery search/case/images/localities HTML and catalog JSON, keyed by a SHA-256 of the request. These expire after `$KINLOOM_VA_ARCHIVES_TTL_HOURS` (default 168).
- `files/`: chancery page PDFs, ZIPs, and image-server TIFFs, keyed by URL. These never expire.
- `rosetta/<IE>/`: `files.json` (the resolved file list) and `<FL>.bin` (the delivered bytes), keyed by IE id.

To refetch, put `--refresh` before the subcommand to cover the whole run (`va-archives --refresh chancery localities`), or add it to a single command (`grant-tif ... --refresh`).

Tests: `uv run --with click --with httpx python3 -m unittest skills/virginia-archives/tests/test_va_archives.py`. These are mocked-HTTP tests with synthetic fixtures. Vitest also runs them in `packages/cli/src/commands/records/records.test.ts`.

## What is searchable online

- **Chancery Records Index:** https://www.lva.virginia.gov/collections/chancery (search itself lives at https://old.lva.virginia.gov/chancery/). See CLI above. Individual case pages use the verified pattern `case_detail.asp?CFN=<locality-code>-<year>-<number>`.
- **Virginia Chronicle:** https://www.virginiachronicle.com. Free full-text searchable archive of Virginia newspapers, over 5 million pages (the Library's own 2026 update puts the count near 7 million pages and growing). Search by keyword, title, date, or place. No account required. Use it for obituaries, marriage notices, estate sale notices, and local news. **Browser-only:** Cloudflare returns "Just a moment..." to curl and to headless Chromium (verified 2026-11-24), and the site blocks all crawlers in robots.txt. No stable GET search URL was verified; use the Search box on the site. `url --chronicle` prints the home page only.
- **Land Office patents and grants.** The collection covers Virginia land patents 1623-1774 and land grants 1779-February 2000, including Northern Neck Proprietary grants 1690-1874, with survey plats and accompanying papers. Routes: the catalog CLI above (`catalog <surname>`), the libguide https://lva-virginia.libguides.com/land-grants, and the browse-by-volume index https://image.lva.virginia.gov/LONN/LO.html (Virginia Land Office Patents and Grants Index; search is a legacy Aleph form whose host, `lva1.hosted.exlibrisgroup.com`, was unreachable on 2026-11-24, so use the browser for the name search). Early Virginia land ownership is proved here rather than in county deed books alone.
- **Virginia Untold: the African American Narrative.** Digital access to records documenting enslaved and free Black and multiracial people. Reach it through the digital-collections page; no separate machine interface was verified.
- **Bible records, church records, cemetery records, maps, and photographs** are in the digital collections, searchable through the catalog CLI. Family Bible records are a named source for birth, death, and marriage dates.
- **ARVAS finding aids:** https://arvasarchive.org (linked from the Collections page). A consolidated database of manuscripts and archival material in historical societies, libraries, museums, and colleges across Virginia and West Virginia. Use it when the record you need is not at the Library itself. **Browser-only:** plain HTTP returns an empty 202 (verified 2026-11-24); no search API was verified.

## What is in-person or subscription-only

- Original deed books, will books, and order books stay with the clerk of the circuit court in each county or independent city. The Library holds microfilm of many older volumes and the original volumes, loose papers, and microfilm for most localities. County records lost to courthouse fires and the April 1865 Richmond evacuation fire are a known gap; the Library keeps a Lost Records Localities list, so check it before concluding a record never existed.
- Birth and death registers 1853-1896 and marriage records before 1936 survive on microfilm. The Library partners with Ancestry.com for select digital collections (births, deaths, marriages, personal property tax records), freely accessible to Virginians in their homes. A non-Virginian uses the same collections through a personal Ancestry subscription or in the Richmond reading rooms.
- Subscription databases are available in the reading rooms; Virginia residents can reach many remotely after registering for a Library of Virginia account.

## Research workflow

Worked order for tracing a family through Virginia (for example before a westward move into Kentucky or the Midwest):

1. Search the Chancery Records Index by surname and locality (`va-archives chancery search <surname>`).
2. Search Land Office patents and grants by surname (`va-archives catalog <surname>` plus the LONN index).
3. Search Virginia Chronicle in a browser by surname and county for notices and obituaries.
4. Search the catalog for Bible records, church registers, and manuscript collections.
5. If the chancery index shows a cause without digitized images, record the index number and locality in `data/` and check `chancery localities` before requesting copies or visiting, since active processing can temporarily close a locality.

## Verification log (verified live 2026-11-24)

- LVA Collections page, Digital Collections page, Chancery landing page, and Chancery information page: all 200 via plain curl.
- Chancery search POST to `old.lva.virginia.gov/chancery/default.asp`: 200 with 20 records per page and `intPage=N` pagination.
- Case detail GET `case_detail.asp?CFN=<cfn>`: 200, structured locality/index/plaintiff/defendant/surname/plat/format tables.
- Case images GET `case_images.asp?CFN=<cfn>`: 200, lists page PDFs under `/ChanceryImg/...` plus a whole-case ZIP link; both individual PDFs and ZIP archives download over plain HTTP.
- Primo PNXS GET (`q=any,contains,<term>` and `q=title,contains,<term>` with `limit` and `offset`): 200 JSON, no key or auth.
- Chancery availability GET `available.asp`: 200, locality table (locality, region, time frame, viewing status, notes).
- Virginia Chronicle: curl 403 with Cloudflare "Just a moment..."; headless Chromium also returns the challenge page. Browser-only.
- ARVAS: plain HTTP returns 202 with an empty body. Browser-only.
- LONN volume index `image.lva.virginia.gov/LONN/LO.html`: 200, browse-by-volume table; its Aleph name-search host was unreachable (connection failed).
- Image server and Rosetta (verified 2026-11-26): `image.lva.virginia.gov/LONN/LO-3/372/372_0195.tif` returns `image/tiff` (CCITT G4). `cgi-bin/GetDW.pl?dir=<DRAWER>&card=<CARD>` redirects to a `cgi-bin/drawer` page listing `/Microfilm/DW/001/*.tif` pages. `rosetta.virginiamemory.com/delivery/DeliveryManagerServlet?dps_pid=IE3453061` embeds `view/action/ieViewer.do?...dps_dvs=...`, which lists `FL3453066` (Original) and `FL3453067` (Transcription). Both stream as `application/pdf` via `dps_func=stream`.
- No account or API key is needed for anything the CLI does. Fees apply only to ordering copies, noted per collection above.

## What this skill does not cover

- Other state archive repositories (see sibling skills such as `kentucky-archives`, `missouri-archives`, `new-jersey-archives`, `california-archives`, and `texas-archives`).
- Do not invent an API endpoint, a query-string search URL, or an auth requirement for Virginia Chronicle, ARVAS, Virginia Untold, or the Aleph Land Office search. Where no machine interface was verified, the skill says so and gives the click path instead.
