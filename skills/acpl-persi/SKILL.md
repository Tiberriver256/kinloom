---
name: acpl-persi
description: Search the Allen County Public Library Genealogy Center's free PERSI (Periodical Source Index) via the bundled `persi` CLI or the website, to find articles in county historical society newsletters and other genealogy periodicals. Covers CLI usage, the three search modes (surname, article title, location), what PERSI is and is not, getting article copies, and planning an in-person visit to Fort Wayne, Indiana. Use when hunting periodical citations for a surname or place, or when a lead points to a society newsletter.
---

# ACPL PERSI

This skill includes a standalone executable Python CLI at `skills/acpl-persi/scripts/persi` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`). No virtualenv setup or API key is required.

- **What PERSI is:** the Periodical Source Index, produced by the staff of The Genealogy Center of the Allen County Public Library (ACPL), Fort Wayne, Indiana. It is the largest subject index to genealogy and local history periodicals, with more than 3.2 million citations to articles in 11,000+ periodical titles from local, state, national, and international societies.
- **What it is not:** a full-text archive. A hit is a citation: article title, periodical, year, publisher. PERSI indexes article titles, not article contents, so search for topics and surnames around an ancestor's life, not for a person's full story. Full text comes from the holding library, the publisher, WorldCat, or the Genealogy Center's copy service.
- **Cost:** free to search. No account, sign-in, or subscription is needed. PERSI was previously on Ancestry and Findmypast behind paywalls; ACPL has hosted it free on its own site since 2022.

## Bundled CLI (`scripts/persi`)

Path: `skills/acpl-persi/scripts/persi`

### Search by surname

```bash
# Lincoln articles, first 25 hits (persi search <Surname> is also accepted as an alias)
skills/acpl-persi/scripts/persi surname Lincoln

# JSON output, 50 hits
skills/acpl-persi/scripts/persi surname Lincoln --limit 50 --json
```

Note: PERSI's surname and article-title forms do **not** accept a `--state` filter; use `persi location --state <ST>` for state/county category counts.

### Search by article-title keyword

```bash
skills/acpl-persi/scripts/persi title Lincoln --limit 25
skills/acpl-persi/scripts/persi title "Clara Barton"
```

### Search by location (category counts)

```bash
# Illinois statewide: returns article counts per category, not articles
skills/acpl-persi/scripts/persi location --state IL

# A single county (county name as PERSI lists it; blank means statewide)
skills/acpl-persi/scripts/persi location --state IL --county Sangamon
```

The location search returns counts per category (for example History, Cemeteries, Military Records, Census Records, Court Records, Deeds, Directories, Land Records, Maps). Pick a category on the website to drill into its articles; the CLI does not drill down because the drill-down links are session pages, not a stable pattern.

### Website search page for a mode

```bash
skills/acpl-persi/scripts/persi url surname
```

PERSI result pages are POST forms, so there is no shareable result URL. This prints the search form URL instead.

## Website search and form rules (verified live 2026-11-24)

- Home: `https://www.genealogycenter.info/persi/`
- Surname form: `https://www.genealogycenter.info/search_persisurname.php`, POST to `results_persisurname.php` with fields `surname`, `sort=title`, `submit=Search`.
- Article-title form: `https://www.genealogycenter.info/search_persiarttitle.php`, POST to `results_persiarttitle.php` with fields `keyword`, `sort=title`, `submit=Search`.
- Location form: `https://www.genealogycenter.info/search_persilocation.php`, POST to `results_persilocation.php` with fields `subloc=USA`, `cosearch=USA`, `usloc=<two-letter state code>`, `county=<name or blank>`, `submit=Search`. The state dropdown uses two-letter codes (`IL`, `CA`, `MO`, `GEN` for US general); the county dropdown is populated by JavaScript after a state is picked, so on the website pick the state first, then the county.
- Results render as a DataTable with columns Article Title, Periodical, Year Published, Publisher. Some rows carry a free-online icon linking directly to a digitized, copyright-clear issue; ACPL adds these links gradually as it finds issues online.
- No wildcards are available. Quoted phrases work in the search boxes.
- There is no public PERSI API. Do not invent one; the POST forms above are the machine interface.

## Getting the article after a hit

1. Check the row for a free-online link first; if present, the issue is one click away.
2. Search the periodical title on WorldCat to find a holding library near you.
3. Contact the publishing society directly; many sell back issues cheaply.
4. Order a copy from the Genealogy Center: the results page links to the article order form. The old form PDF at `acpl.lib.in.us/images/Documents/Gendocs/Forms/articlerequest.pdf` returned 404 on 2026-11-24, so use the link on the live results page and confirm the current fee there before quoting a price. Older guides cite $7.50 per order (up to 6 articles) plus $0.20 per page with a 6-8 week turnaround; treat that as stale until re-confirmed.
5. In person, the Genealogy Center holds the periodicals indexed in PERSI, so a visit resolves the citation on the spot.

## In-person visit

- **Genealogy Center, Allen County Public Library, 900 Library Plaza, Fort Wayne, IN 46801.** Phone 260-421-1225, email Genealogy@ACPL.Info.
- The Center holds more than 558,000 printed volumes and 795,800 microtext items, one of the largest physical genealogy collections in North America.
- Hours change; confirm on `https://genealogycenter.org` (redirects to the ACPL genealogy pages) before visiting.
- Beyond PERSI, the Center's free online databases total over 6 million records and images, including Allen County, Indiana resources (obituaries, cemeteries, marriages, deaths, courthouse records) and an African American gateway.

## Research workflow

1. `persi surname <Surname>` for the broad sweep; note periodical, year, and publisher for every plausible hit.
2. `persi title <Keyword>` catches articles whose title mentions a surname, place, or historical event but whose surname indexing differs.
3. `persi location --state <ST>` (then `--county <County>`) for place-first hunting; the Cemeteries, Court Records, and History categories are often the strongest leads.
4. Repeat across each state along a family's migration path.
5. Record each citation in `data/` with periodical, volume, issue, year, and ACPL call number when shown; mark whether a free-online link existed.

## Disk cache and environment variables

`surname`, `title`, `location`, and `search` cache successful non-empty responses on disk under `~/.cache/kinloom-persi/` (default TTL `168` hours, advisory `flock` per cache key, atomic temp-file writes). HTTP errors and empty responses are never cached.

- `--refresh`: bypass cached reads and write the fresh response to disk.
- `--cache-ttl-hours <hours>`: override TTL for one call (`0` disables cached reads).
- `KINLOOM_PERSI_CACHE_DIR`: override the cache directory path.
- `KINLOOM_PERSI_CACHE_TTL_HOURS`: override the default TTL in hours.

No key or account is needed.

## Verified-live note

All endpoints and form fields above were verified live on 2026-11-24 by direct HTTP and by reading the live forms. Anything marked stale or reported (the old article-order fee) is labeled as such.
