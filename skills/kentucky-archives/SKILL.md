---
name: kentucky-archives
description: Research historical and genealogical records in Kentucky through the Kentucky Historical Society (KHS) Digital Collections, the Kentucky Department for Libraries and Archives (KDLA) Preservica e-archives, and the Kentucky Secretary of State Land Office patent databases, using the bundled `ky-archives` CLI. Covers CONTENTdm surname and collection search, Confederate pension packets, County Court Orders patents (1835-2000), Virginia and Old Kentucky patents, and what is browser-only or visit-only. Use when tracing ancestors from Virginia into Kentucky, finding Kentucky land patents, family papers, photographs, oral histories, or a Confederate pension packet, or deciding whether a Kentucky record is online, orderable, or visit-only.
---

# Kentucky Archives

Kentucky has three primary repositories for genealogical research, and they hold different collections. Do not treat them as one repository.

This skill includes a standalone executable Python CLI at `skills/kentucky-archives/scripts/ky-archives` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`). No virtualenv setup or API key is needed. Run it from the repo root, for example `./skills/kentucky-archives/scripts/ky-archives cdm Lincoln`.

## Bundled CLI (`scripts/ky-archives`)

| Command | What it does | Interface (verified live 2026-11-24) |
|---|---|---|
| `cdm <query> [--collection ALIAS] [--field FIELD] [--limit N] [--json]` | Search KHS Digital Collections | CONTENTdm dmwebservices API, key-free: `GET https://www.kyhistory.com/digital/api/search/collection/<alias>/searchterm/<term>/field/<field>/maxRecords/<n>` |
| `cdm-item <alias> <id> [--json]` | Full metadata for one CONTENTdm item | `GET https://www.kyhistory.com/digital/api/singleitem/collection/<alias>/id/<id>` |
| `collections [--json]` | List the 16 CONTENTdm collections and aliases | `GET https://www.kyhistory.com/digital/api/collections` |
| `cdm-url <query>` | Print the verified catalog web search URL (no request) | `https://www.kyhistory.com/cdm/search/searchterm/<term>/mode/exact` |
| `land <term> [--by grantee\|county\|watercourse\|survey-name\|survey-year\|grant-year\|patent\|warrant\|grant-book] [--limit 10\|25\|50\|100] [--json]` | Advanced search, County Court Orders patents | ASP.NET form POST to `https://web.sos.ky.gov/land/ccorders.aspx` (GET state, postback to open the advanced panel, POST the search) |
| `land-patent <number> [--book N] [--page N] [--json]` | Quick search by patent number (or grant book/page) | Same ASP.NET form, quick-search fields |
| `preservica <query> [--limit N] [--json]` | Search KDLA Preservica e-archives | WordPress search RSS feed: `GET https://kdla.access.preservica.com/search/<term>/feed/rss2/`; human search page is `https://kdla.access.preservica.com/?s=<term>` |
| `urls <query>` | Print every verified Kentucky search URL (no requests) | See the URLs in the sections below |

Notes on the interfaces:

- The CONTENTdm API returns `totalResults` and items with `collectionAlias`, `itemId`, `title`, `filetype`, `itemLink`, and `metadataFields`. The API's `itemLink` has no `/digital` prefix; the CLI adds it, because the bare link (`https://www.kyhistory.com/singleitem/...`) returns 403 from OCLC, while the `/digital/...` form returns 200 (verified live 2026-11-24).
- The KHS web UI returns 403 to a bare Linux-Chrome user agent and 200 to a Windows Chrome user agent. The CLI sends a Windows Chrome UA on every request for that reason. The CONTENTdm API itself accepts either.
- The Land Office form is ASP.NET with `__VIEWSTATE`/`__EVENTVALIDATION`; the CLI does the three-request dance (GET, postback to reveal the advanced panel, search POST) and parses the results table into patent, grantee, grant book/page, acreage, county, watercourse, survey name, survey/grant dates, and grant note.
- The Preservica host has no public Preservica search API (`/wp-json/` returns a Preservica "Page Not Found" page). The WordPress search RSS feed is the machine route; it returns up to 100 items per query. The site's search is full-text over titles, descriptions, creators, and document contents, so a hit's title often does not show why it matched: open the hit to confirm. Viewing a packet's scans needs the browser.
- No account or API key is needed to search any portal in this skill. Fees apply only to ordering copies, noted per repository below.

## Kentucky Historical Society (KHS)

Portal: https://history.ky.gov/
Digital collections catalog: https://www.kyhistory.com/
Research and genealogy starting page: https://history.ky.gov/research-genealogy
Address: Thomas D. Clark Center for Kentucky History, 100 West Broadway, Frankfort, KY 40601. The Martin F. Schmidt Research Library on the second floor holds the largest genealogical collection in the state: over 16,000 rolls of microfilm, 90,000 books and periodicals, 30,000 vertical files, 1,900 cubic feet of manuscripts, 2,000 maps, 8,000 oral histories, and 200,000 historic photographs.

KHS Digital Collections is a searchable database of digital images and files from KHS collections: print, archival, graphic, audio, and video files, plus finding aids, photographs, oral histories, and manuscripts. It runs on CONTENTdm (16 collections, including Manuscripts `MS`, Resources and Finding Aids `LIB`, Printed Materials `RB`, Visual Materials `PH`, Maps and Atlases `Maps`, Kentucky Ancestors `p16602coll3`, and Oral History `Ohist`).

```bash
# Surname search across all collections
skills/kentucky-archives/scripts/ky-archives cdm Lincoln
# Manuscripts only
skills/kentucky-archives/scripts/ky-archives cdm Lincoln --collection MS --limit 25
# Full metadata for one hit
skills/kentucky-archives/scripts/ky-archives cdm-item <alias> <item-id>
```

The verified web search pattern, from KHS's own research blog, is `https://www.kyhistory.com/cdm/search/searchterm/<term>/mode/exact`, for example `https://www.kyhistory.com/cdm/search/searchterm/SC%201261/mode/exact` for a manuscript collection. Use it for a known collection number or a distinctive term; for a surname use the CLI or the catalog's surname search, which searches all manuscript collections and family histories at once.

Other KHS online tools:

- Pass the Word: a discovery tool for oral history collections across the Commonwealth, sponsored by the Kentucky Oral History Commission. Over 25,000 interviews from more than 100 archives, searchable by interviewee name and topic. Browser only, no machine interface found: https://passtheword.ky.gov/ (returned 200 live 2026-11-24).
- Kentucky Ancestors back issues, Vol. 1 (July 1965) through Vol. 48 (Summer 2013), digitized as PDFs through the Digital Collections Catalog (collection `p16602coll3`). Not indexed as of the KHS notice; search within each issue PDF.
- Civil War Governors of Kentucky Digital Documentary Edition, a KHS digital humanities project.
- The Register, the KHS scholarly journal, is available through Project Muse and JSTOR, not free on the KHS site.

What is in-person only at KHS: most manuscript collections are described in the catalog but only partly digitized. Ancestry.com Library Edition, HeritageQuest, American Periodicals 1740-1940, and the Louisville Courier-Journal 1830-1922 are free on site in the research library, not remotely. Copies can be ordered for a fee.

## Kentucky Department for Libraries and Archives (KDLA), Kentucky State Archives

Portal: https://kdla.ky.gov/
E-archives (Preservica): https://kdla.access.preservica.com/

KDLA is the state archives proper. Its e-archives hold state government records including the Confederate pension files. Older guidance says KDLA search results often tell you where a document is filed and you then order a copy for a fee, rather than showing the whole document online. That is now only partly true: the Preservica e-archives do show scanned pension packets online.

```bash
# Search the e-archives (full-text; open hits to confirm the match)
skills/kentucky-archives/scripts/ky-archives preservica Lincoln --limit 10
```

Confederate Pension Application Packets are browsable in Preservica in numbered folders (for example packets 1526-1550, 2001-2025, 1101-1125), each packet a scanned application by a soldier or a widow, filed starting in 1912 when Kentucky began granting Confederate pensions. Search by surname to locate relevant packets, then view the scanned packet in a browser.

## Kentucky Secretary of State, Land Office

Portal: https://www.sos.ky.gov/land/Pages/default.aspx
County Court Orders patents search: https://web.sos.ky.gov/land/ccorders.aspx

The Land Office is the repository for all Kentucky land patents, including those issued by Virginia before Kentucky statehood in 1792. Because Kentucky is not a federal public-land state, early Kentucky land ownership is proved through Virginia warrants and Kentucky state patents rather than federal BLM GLO patents.

Searchable online, verified 2026-11-24:

- Virginia Patent Series and Old Kentucky Patent Series: searchable by patent number or grantee. These cover patents finalized by Virginia grants before 1792 and the 7,771 Old Kentucky patents. Many patent files link to scanned color images. Related warrant databases are also searchable by name: Virginia Treasury Warrants (search by warrant number or by last name, first name), Revolutionary War Warrants, Lincoln Entries, Certificates of Settlement, and Preemption Warrants.
- County Court Orders series: 70,241 patents, 1835-2000, the largest series. Quick search by patent number (5 digits) or book and page; advanced search by county, watercourse, grant name, survey name, survey year, and grant year. Some patent numbers 0001.0-8241.0 link to scanned images of patent files.
- West of Tennessee River Military Patents: 242 patents, with scanned images of warrants, entries, surveys, and grants. West of Tennessee River Non-Military Patents: over 8,500 patent files with scanned images, plus a Jackson Purchase Locator.

```bash
# Grantee search in the County Court Orders series (the CLI's `land` command)
skills/kentucky-archives/scripts/ky-archives land Lincoln --by grantee
# Other fields: --by county, --by watercourse, --by survey-year, --by grant-year
skills/kentucky-archives/scripts/ky-archives land Hardin --by county --limit 25
# Quick search by patent number
skills/kentucky-archives/scripts/ky-archives land-patent <patent-number>
```

Not online: the South of Green River, Tellico, Kentucky Land Warrants, South of Walker's Line, and Warrants for Headrights series are not available online as of the Land Office's own series summary. Request those files by online order form or email to the Land Office, using Jillson's *The Kentucky Land Grants* to determine grantee, patent series, and citation first. Copies of grants can also be ordered from the KHS library and KDLA in Frankfort.

Browser only, no machine interface: the Virginia / Old Kentucky Patent Series browser at `https://web.sos.ky.gov/land/vakypatentseries.aspx` is a series dropdown plus a patent list (verified live 2026-11-24: series options are Virginia Patent Series and Old Kentucky Patent Series; there is no name search field). Use it in the browser to browse a series by patent number once the CLI or Jillson gives you the citation.

## Kentucky vital records

Kentucky has no statewide vital-records database at KHS or KDLA. The University of Kentucky's Kentucky Vital Records Index covers deaths 1911-1992, marriages 1973-1993, and divorces 1973-1993. Earlier Kentucky vital events are in county records, church records, and subscription indexes. Do not expect the state archives to produce a Kentucky birth or marriage certificate. Note: the index's old URL `http://ukcc.uky.edu/vitalrec/` did not resolve live 2026-11-24, so no URL is given here; find the current index through the University of Kentucky Libraries site. Inferred, not verified: FamilySearch's Kentucky, Vital Record Indexes, 1911-1999 collection covers much of the same ground.

## Research workflow

For families migrating into Kentucky from Virginia, check repositories in this order:

1. Land Office Virginia and Old Kentucky Patent Series by grantee surname (this proves early land ownership and often names assignees and warrant holders).
2. County Court Orders series (`ky-archives land <surname> --by grantee`) if the family held or acquired land after 1835.
3. KHS Digital Collections (`ky-archives cdm <surname>`) for family papers, county indexes, and photographs.
4. KDLA Preservica (`ky-archives preservica <surname>`) for Confederate pension packets and state agency files.
5. Record the patent series, patent number, and survey year for every hit; the same individual often appears under both a Virginia warrant and a Kentucky patent.

## Verification log (verified live 2026-11-24)

- `history.ky.gov` and `kdla.ky.gov` returned 200; `kyhistory.com` returned 200 to a Windows Chrome UA (403 to a bare Linux-Chrome UA); `kdla.access.preservica.com` returned 200; `web.sos.ky.gov/land/ccorders.aspx` and `www.sos.ky.gov/land/Pages/default.aspx` returned 200.
- CONTENTdm API: `/digital/api/collections` returned 16 collections; `/digital/api/search/...` and `/digital/api/singleitem/...` returned full JSON metadata. Item links verified: `/digital/singleitem/...` 200, `/digital/compoundobject/...` 200, bare `/singleitem/...` 403.
- Land Office: advanced search POST and quick search by patent number returned parsed results tables through the CLI.
- Preservica: WordPress search RSS feed returned up to 100 items per query; `/wp-json/` returned a Preservica "Page Not Found" page, confirming no public Preservica search API on this host.
- Pass the Word `https://passtheword.ky.gov/` returned 200. The UK Vital Records Index old URL `http://ukcc.uky.edu/vitalrec/` did not resolve (connection failure). The Virginia / Old Kentucky Patent Series page `vakypatentseries.aspx` returned 200 and shows series + patent dropdowns only.
- KDLA Preservica Confederate pension packets and Land Office patent series counts (County Court Orders 70,241 patents 1835-2000; 7,771 Old Kentucky patents) were confirmed on 2026-11-24.
