---
name: hathitrust
description: Search HathiTrust Digital Library for out-of-copyright county histories, regimental rosters, and published genealogies via the bundled uv-based `hathi` CLI (no key needed), the catalog website, or the Data API with a key. Covers the Bibliographic API by identifier, catalog search URL patterns, rights (Full view vs Limited search-only), and worked examples. Use when checking whether a book is in HathiTrust, reading its rights and volume list, or finding a readable copy.
---

# HathiTrust Digital Library

This skill includes a standalone executable Python CLI at `skills/hathitrust/scripts/hathi` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`). No virtualenv setup or API key is required for the Bibliographic API or the catalog search URLs.

- **Bibliographic API (no key, no login):** returns bibliographic, rights, and volume information for a known identifier (OCLC, LCCN, ISBN, ISSN, HathiTrust ID, record number). This is what the CLI uses. It is identifier lookup only: it cannot keyword-search by title or author.
- **Catalog website (no login for searching):** keyword search by title, author, subject, or all fields. Use the `hathi url` command to build a verified search URL and open it in a browser.
- **Full-text search (login):** searching inside the text of volumes needs a partner-institution login or a free University of Michigan "Friend" account. The CLI does not cover it.
- **Data API (key needed):** page images, OCR text, and whole-volume packages need an access key from the Key Generation Service at `https://babel.hathitrust.org/cgi/kgs/request`. The CLI does not implement it; see below.

## Bundled CLI (`scripts/hathi`)

Path: `skills/hathitrust/scripts/hathi`

### Look up a record by identifier (Bibliographic API)

```bash
# Official HathiTrust Bib API example (OCLC 424023)
skills/hathitrust/scripts/hathi bib oclc 424023

# Same record by its 9-digit HathiTrust record number
skills/hathitrust/scripts/hathi bib recordnumber 000578050

# One volume by its HathiTrust ID, with full MARC-XML
skills/hathitrust/scripts/hathi bib htid <htid> --full

# Several identifiers in one call (fetched one at a time, merged output)
skills/hathitrust/scripts/hathi bib --id oclc:424023 --id recordnumber:000578050

# Raw JSON exactly as the API returned it
skills/hathitrust/scripts/hathi bib oclc 424023 --json
```

Identifier types: `oclc`, `lccn`, `issn`, `isbn`, `htid`, `recordnumber`. Values are URL-encoded by the CLI (LCCNs can contain spaces and slashes). A lookup that finds nothing prints empty `records` / `items` (the API returns `{ "records": {}, "items": [] }`, not an error), so check for that before concluding a title is absent under a different identifier.

Compact output keeps title, record URL, publish dates, identifiers, and for each item: originating library, HathiTrust ID, rights string, and item URL. `--full` adds the complete MARC-XML for the record.

### Build a verified catalog search URL

```bash
# Title search (open the printed URL in a browser)
skills/hathitrust/scripts/hathi url "Abraham Lincoln" --type title

# Author search
skills/hathitrust/scripts/hathi url "Douglass, Frederick" --type author

# Keyword search across all fields
skills/hathitrust/scripts/hathi url "Clara Barton" --type all
```

This only prints the URL; it does not fetch results. Fetching catalog search HTML from a server is unreliable (Cloudflare challenges curl intermittently; see "Verified live"), so run the search in a real browser.

## Website search and URL rules (verified live 2026-11-24)

- Catalog search: `https://catalog.hathitrust.org/Search/Home?lookfor=<query>&type=<type>&inst=`
  - `lookfor` is the URL-encoded query. `type` is `all`, `title`, `author`, or `subject`. `inst=` is left empty when no partner institution is selected.
  - Verified URL patterns:
    - Author: `https://catalog.hathitrust.org/Search/Home?lookfor=%22Douglass%2C+Frederick%22&type=author&inst=`
    - Subject: `https://catalog.hathitrust.org/Search/Home?lookfor=%22+Astrolabes%22&type=subject&inst=`
  - `type=all` returned HTTP 200 with a results page in a live fetch on 2026-11-24. `type=title` is the catalog's field name for title search (per HathiTrust library guides) but a live fetch of a title search on the same day was met with a Cloudflare challenge (403), so treat `type=title` as documented and open it in a browser.
- Catalog record page: `https://catalog.hathitrust.org/Record/<9-digit-record-number>`, for example `https://catalog.hathitrust.org/Record/000578050`.
- Item (PageTurner) page: `https://babel.hathitrust.org/cgi/pt?id=<htid>`, or the persistent form `https://hdl.handle.net/2027/<htid>`.
- Search tips: use the catalog search for descriptive data (title, author, date); use full-text search for words inside a volume. Filter results by Full View to show only volumes readable online.

## Bibliographic API reference (no key)

- Docs: `https://www.hathitrust.org/bib_api` and `https://www.hathitrust.org/member-libraries/resources-for-librarians/improve-discovery/integrate-records/`
- Brief: `https://catalog.hathitrust.org/api/volumes/brief/<id-type>/<id-value>.json`
- Full (adds complete MARC-XML): `https://catalog.hathitrust.org/api/volumes/full/<id-type>/<id-value>.json`
- Id types: `oclc` (digits only), `lccn`, `issn`, `isbn` (ISBN-10 is searched as both ISBN-10 and ISBN-13), `htid` (for example `mdp.39015058510069`), `recordnumber` (9-digit HathiTrust record number, also the `ht_bib_key` in the HathiFiles).
- Response shape: `records` keyed by record number (recordURL, titles, isbns, issns, oclcs, lccns, publishDates, plus `marc-xml` for full), and `items` (orig, fromRecord, htid, itemURL, rightsCode, lastUpdate, enumcron, usRightsString).
- Intended for small numbers of items at a time (multi-id form supports up to 20 records). Bulk retrieval uses OAI or the HathiFiles tab-delimited inventory files; do not bulk-scrape the Bib API.

## Rights: what you can actually read

The `usRightsString` on each item decides readability:

- `Full view`: public domain (or otherwise open). Readable online by anyone, no login.
- `Limited (search-only)`: in copyright or undetermined. Searchable, but pages are not readable online without a partner-institution login.
- Common `rightsCode` values: `pd` (public domain), `pdus` (public domain in the US only), `ic` (in copyright), `und` (undetermined), `icus` (in copyright in the US), plus Creative Commons codes (`cc-by-4.0`, etc.).

Check the rights string before promising a readable copy. A title can be in HathiTrust and still not be readable online.

## Data API (key needed, not in the CLI)

- Docs: `https://www.hathitrust.org/data_api` (Data API v2, revised 26 May 2015).
- What it returns: page images, OCR text, structural metadata, and in some cases whole-volume packages, plus metadata resources.
- Access: metadata resources are unrestricted; content (data) resources vary. Two routes: the web client at `https://babel.hathitrust.org/cgi/htdc` (needs login; non-members use a University of Michigan "Friend" account), or programmatic access with a key from the Key Generation Service at `https://babel.hathitrust.org/cgi/kgs/request`.
- URL scheme: `https://babel.hathitrust.org/cgi/htd/<resource>/<id>[/<fileid|seq>]`.
- The CLI does not implement the Data API. If a Full View volume is needed as OCR text, first try the item URL in a browser; request a key only if programmatic bulk access is genuinely needed.

## Environment variables

- None. The Bibliographic API needs no key and the CLI reads no environment variables.

## Research workflow notes

- **County histories and regimental rosters:** these are usually pre-1929 and therefore often `Full view`. Search the catalog by title or subject, then confirm `usRightsString` is `Full view` with `hathi bib` before linking a readable copy. Use the HathiTrust record number as the stable citation, not the item URL alone, since items are per-scan.
- **Check WorldCat OCLC numbers carefully:** do not assume a title is in HathiTrust from a WorldCat listing alone, because WorldCat OCLC numbers and HathiTrust holdings differ. Confirm any hit with `hathi bib` before citing it; if HathiTrust returns empty records, check Internet Archive (`archive-org` skill) for an alternate scan.

## Verified live 2026-11-24

- Bib API brief `oclc/424023` returns 200 JSON: record `000578050`, "Infinite series", 1962 (the documentation's own example).
- Bib API full `oclc/424023` returns 200 JSON including `marc-xml`.
- Catalog search `type=all` returned 200 HTML in one live fetch; subsequent fetches of catalog search pages and record pages returned 403 Cloudflare challenge pages (about 5.7 KB). The Bib API was reliable on every attempt; catalog HTML was not. That is why the CLI looks records up through the Bib API and only builds catalog search URLs for a real browser instead of scraping result pages.
- Full-text Large Scale Search (`https://babel.hathitrust.org/cgi/ls?a=srchls&q1=...`) returns 403 unauthenticated, so full-text search is documented as login-only and is not in the CLI.
