---
name: california-archives
description: Research historical and genealogical records in California archives: the Online Archive of California (OAC) finding aids, Calisphere digitized items, the California State Archives catalog (Minerva), the California Archives Search Portal and exhibits, and the California Digital Newspaper Collection (CDNC). Gives the verified portal URLs, what is genuinely searchable online versus in-person only, and the bundled `ca-archives` CLI. Use when tracing ancestors in California, finding county collections, land-grant and probate records, digitized photographs, or California newspaper mentions.
---

# California Archives

This skill covers California repositories for historical and family-history research across finding aids, digitized photographs, state archive catalogs, and historical newspapers.

It includes a standalone executable Python CLI invoked as `kinloom ca-archives` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`, `playwright`). No virtualenv setup or API key is required. The CLI needs a Chromium/Chrome executable for the two browser sources (auto-detected as `chromium`, `chromium-browser`, `google-chrome`, or `google-chrome-stable`; override with `CA_ARCHIVES_BROWSER`).

No account or API key is needed to search any source in this skill. Fees apply only to ordering copies, noted per source.

## Bundled CLI (`scripts/ca-archives`)

```bash
# Search all four machine-searchable sources (OAC and Calisphere share one browser session)
kinloom ca-archives search "Samuel Clemens" --limit 5

# Search a surname across every source
kinloom ca-archives search Lincoln --limit 3

# Only the plain-HTTP sources (fast, no browser)
kinloom ca-archives search Sacramento --source portal --source exhibits --limit 3

# JSON output
kinloom ca-archives search Sacramento --json

# Print verified search URLs without running any search (includes CDNC and Minerva)
kinloom ca-archives url "Clara Barton"

# Inspect one item found by search
kinloom ca-archives get --portal <portal-id>
kinloom ca-archives get --exhibits <exhibits-id>
```

### Disk cache and environment variables

`search` (per source) and `get` cache successful responses on disk under `~/.cache/kinloom-ca-archives/` (default TTL `168` hours, advisory `flock` per cache key, atomic temp-file writes). HTTP errors and blocked/empty pages without a parsed total are never cached.

- `--refresh`: bypass cached reads and write the fresh response to disk.
- `--cache-ttl-hours <hours>`: override TTL for one call (`0` disables cached reads).
- `KINLOOM_CA_ARCHIVES_CACHE_DIR`: override the cache directory path.
- `KINLOOM_CA_ARCHIVES_CACHE_TTL_HOURS`: override the default TTL in hours.
- `CA_ARCHIVES_BROWSER`: override the Chromium/Chrome executable path for `oac` and `calisphere`.

## Verification log (verified live 2026-11-24)

- OAC home page `oac.cdlib.org/` returns 200. Its search page `https://oac.cdlib.org/search?q=<query>` returns an AWS WAF JavaScript challenge (HTTP 202, empty body) to plain curl, but loads and returns real results in headless Chromium. The `q` parameter is the search form's own field (verified in the home-page form markup).
- Calisphere home page `calisphere.org/` returns 200. Its search page `https://calisphere.org/search/?q=<query>` also intermittently returns the WAF challenge (HTTP 202, empty body) to plain curl, but loads in headless Chromium. The `q` parameter is the search form's own field.
- California State Archives pages `sos.ca.gov/archives`, `/archives/collections`, and `/archives/collections/minerva` all returned 200. The Minerva launch URL below was extracted from the Collections Overview page and itself returned 200.
- California Archives Search Portal `archives.sos.ca.gov/` returns 200. Search URL `https://archives.sos.ca.gov/Items?SearchText=<query>` returns `"Search Results X to Y of N"` with titled `/Items/Details/<id>` links.
- Archives exhibits Omeka S API `https://exhibits.sos.ca.gov/api/items?search=Sacramento&per_page=3` returned 200 `application/ld+json` with real items. The API base is the Omeka S site linked from the Portal home page.
- CDNC `cdnc.ucr.edu/` and its Veridian search URL return HTTP 403 with a Cloudflare "Just a moment..." challenge to plain curl, and the same challenge page in headless Chromium even with automation flags. CDNC is therefore URL-builder only in this skill (see below); no CDNC search result has been verified live end to end.
- Minerva search runs inside a GenCat (Minisis) web app reached through the launch URL; its search is a POST/JS flow and no machine search route was verified, so Minerva is launch-URL only in this skill.

## Sources and their machine interfaces

### Online Archive of California (OAC)

Portal: https://oac.cdlib.org/
Search URL: `https://oac.cdlib.org/search?q=<query>` (browser only, see verification log)

OAC, run by the California Digital Library, provides free public access to detailed descriptions of primary-source collections (finding aids) held by more than 200 contributing institutions throughout California. It is a finding-aid database, not a records database. A search returns collection guides that describe what an institution holds and how to request it; it does not usually return the digitized record itself. Search results can be viewed grouped by collection or as all results. Clicking a result opens the collection guide, which gives the contents, the holding institution, and a Request Item link that goes to that institution's own request page. The CLI labels each hit `[collection]` or `[component]`: a component is one folder or series inside a collection guide (its URL carries an `_aspace_` suffix), and the collection hit is the guide itself. Record the collection title, the holding institution, and the collection identifier (the `ark:/13030/...` in the guide URL); that is the citation you use to request the boxes. No account is needed to search OAC; the holding institution may ask you to create a free account to request material.

Do not rely on the older `search.findingaid.html` address that appears in California Secretary of State press releases; it was not verified as the current search route.

### Calisphere

Portal: https://calisphere.org/
Search URL: `https://calisphere.org/search/?q=<query>` (browser only, see verification log)

Calisphere, a service of the UC Libraries powered by the California Digital Library, searches over two million digitized items (photographs, documents, ephemera) contributed by California libraries, archives, and museums. Unlike OAC it returns the digitized items themselves, with thumbnails, contributing institution, and collection. A hit gives an item page at `https://calisphere.org/item/<uuid>/`. Use it for photographs and local-history ephemera: a town street scene, a school photo, or an agricultural or ranch image. The CLI reports the total ("N item(s) found") and the item titles with links.

### California State Archives: Minerva

Portal: https://www.sos.ca.gov/archives
Collections overview: https://www.sos.ca.gov/archives/collections
Family history resources: https://www.sos.ca.gov/archives/collections/family-history-resources
Minerva launch URL (verified 200, 2026-11-24): `https://gencat.sos.ca.gov/webcat/request/DoMenuRequest?SystemName=California+State+Archives&UserName=csa+public&Password=&TemplateProcessID=6000_3355&bCachable=1&MenuName=Minerva+Online+Catalog`
Address: 1500 11th Street, Sacramento, CA 95814. Phone 916-653-6814.

Minerva is the Archives' online catalog: search descriptions of the collections, organized by state agency. Open the launch URL in a browser and use its search box (basic or advanced); the CLI's `url` command prints the launch URL but cannot search Minerva itself. The Archives holds over 105,000 cubic feet of records: millions of documents and bound volumes, 20,000 maps and architectural drawings, 250,000 photographs, and 7,500 video and audio tapes.

### California Archives Search Portal and exhibits

Portal: https://archives.sos.ca.gov/
Search URL: `https://archives.sos.ca.gov/Items?SearchText=<query>` (plain HTTP, CLI `search --source portal`)
Exhibits API: `https://exhibits.sos.ca.gov/api/items?search=<query>&per_page=<n>` (plain HTTP, CLI `search --source exhibits`)

The Portal is the Archives' newer search tool over its digital collections and exhibits, currently using data from Omeka S. Use it for digitized photographs and exhibits; the CLI parses the "Search Results X to Y of N" count and the titled item links. The exhibits site is the Omeka S front end behind the Portal; its public JSON-LD API is the only true API in this skill, and the CLI uses it directly. An exhibits item page is `https://exhibits.sos.ca.gov/s/exhibits/item/<id>`.

### California Digital Newspaper Collection (CDNC)

Portal: https://cdnc.ucr.edu/cgi-bin/cdnc
Search URL (browser only, not verified end to end): `https://cdnc.ucr.edu/cgi-bin/cdnc?a=q&r=1&results=1&txq=<query>&e=-------en--20--1--txt-txIN-------`

CDNC, at UC Riverside's Center for Bibliographical Studies and Research, is a text-searchable collection of historical California newspapers from 1846 to the present, including the Californian and the Daily Alta California, plus current papers collected as PDFs. It is free to use; pre-1930 papers are in the public domain. The search URL pattern is the site's Veridian search form (`a=q`, `txq` = query text, the `e=` value = all years, English, 20 results per page), corroborated by published CDNC result URLs. It is a URL builder only: Cloudflare's bot challenge blocks both curl and headless Chromium (verified 2026-11-24), so open the URL the CLI prints in a real browser and run the search there. The CLI never claims a CDNC search succeeded. Use CDNC for obituaries, marriage and death notices, and local news.

## What is searchable online versus in-person

- Online: catalog descriptions (Minerva), finding aids (OAC), digitized photographs and exhibits (Search Portal and exhibits API), digitized items (Calisphere), newspapers (CDNC, browser only), and the Disenos Collection of Spanish and Mexican land-grant maps (linked from the Archives collections pages; verify the link from the Collections page if it moves).
- In-person or by reference request: the county records themselves (probate case files, wills, naturalizations, deeds, homesteads, vital records for the 28 counties, 1850-1987), census schedules (1852 state, 1860 and 1880 federal, filed alphabetically by county with indexes), and state agency collections. Per Government Code section 12237, records 75 years or older from the date of last activity are open to the public; younger records containing personal, medical, employment, or correctional information are restricted.
- State agency collections of interest to genealogists: California National Guard 1849-1942, Folsom and San Quentin Prisons 1850-1945, early California Youth Authority 1891-1932, Yountville Veterans' Home Registers 1884-1910, and professional and vocational licensing boards 1885-1968. Also Spanish and Mexican Land Grants, court records, and the Root Cellar-Sacramento Genealogical Society library housed at the Archives.
- The Archives is not the official repository for California vital records; those are kept by the county and the California Department of Public Health. The Archives does hold some vital records from 28 counties as microfilmed copies and originals, including probate, marriage, birth, death, and naturalization records. Check the Local Government Records inventory on the Archives site for whether a target county and which record types are among the 28; do not assume a county is covered.

## Research workflow

Worked order for tracing a person or family in a California county:

1. Check Minerva for State Archives collections naming the county or locality.
2. Search OAC for finding aids from county repositories and university special collections (such as the Bancroft Library).
3. Search Calisphere and the Search Portal for digitized photographs and local ephemera.
4. Search CDNC in a browser for obituaries, marriage notices, and local newspaper mentions.
5. Check the Local Government Records inventory to see whether the county's probate, deed, or vital records are among the Archives' 28 counties. California vital records themselves come from the county recorder or the Department of Public Health, not the State Archives. For early land titles, check the Spanish and Mexican Land Grants collection and county deed records; use the 1852 state census and 1860/1880 federal schedules at the Archives to track households between censuses.

## How to use this skill

1. Pick the source for the record type: finding aid (OAC), digitized item or photo (Calisphere, Portal, exhibits), catalog description (Minerva), newspaper (CDNC).
2. Run the CLI search first; it is faster than clicking through four portals and gives totals per source.
3. For CDNC and Minerva, use `ca-archives url <query>` and search in the browser.
4. Stage the repository, collection, and exact citation (collection identifier, Portal item ID, Calisphere item UUID, or CDNC paper/date/page) in a **Research Package** (`research/people/<person_id>/patch.json`). Portals rename and redesign; the citation is what survives. An index hit is not the record: order the copy or plan the visit as the section above says.
5. When a portal has no online index for the record you need, check the subscription indexes named on the state pages (FamilySearch, Ancestry) before assuming the record is visit-only. The state page usually says which one holds the digitized copy.

## What this skill does not cover

- Federal records (census, military service and pension files at NARA). Use the `nara-catalog-search` skill for those.
- Subscription indexes (Ancestry, FamilySearch, MyHeritage). They are named above only where a state portal itself points to them as the holder of a digitized copy.
- County courthouses and county historical societies. County records are usually the follow-up once a state index gives a book and page.
- No public, key-free API was verified live for OAC, Calisphere, the Portal, Minerva, or CDNC on 2026-11-24. Do not invent one. The exhibits Omeka S API is the only API in this skill.

## Kinloom Research Package workflow

Never edit `data/*.yaml` directly from a research session. Follow Kinloom's staged **Research Package** workflow and **Living Privacy Rule** (never include living people's portraits, exact birth dates, street addresses, or pronunciations in public archives):

1. Discover research targets with `kinloom status --missing-biography` or `kinloom status --end-of-line`.
2. Gather privacy-fenced context with `kinloom context <person_id> --include-family`.
3. Stage any downloaded images or documents under `research/people/<person_id>/scans/` and prepare them with `kinloom prep-scan` or `kinloom ocr` when needed.
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
