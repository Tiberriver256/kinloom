---
name: cyndis-list
description: Use Cyndi's List, the free categorized directory of 332,000+ genealogy links, to find niche county-specific transcription sites (USGenWeb county pages, volunteer marriage indexes, church registers, cemetery surveys) across US states, counties, and international localities. Covers the category structure, stable URL patterns for US states and counties, the site search, and how to judge a linked site before citing it. Skill-only: there is no CLI, because Cyndi's List is a directory of links, not a records database. Use when you know the county and record type but not which volunteer site holds the transcription.
---

# Cyndi's List

**Skill-only: no CLI.** Cyndi's List is a categorized directory of links, not a records database. There is no API, no search endpoint that returns records, and no stable result set to script against. A CLI would only re-print links a browser visit already shows. What this skill gives instead is the verified URL structure and a repeatable county-first workflow, so a researcher (or an agent with a browser) lands on the right category page in one step.

## What it is

- Cyndi's List of Genealogy Sites on the Internet, `https://www.cyndislist.com/`, maintained by Cyndi Howells for more than 25 years. Free for everyone, no account.
- Roughly 332,000 links in 200+ categories, cross-referenced. Submitters write their own descriptions; Cyndi categorizes them. The waiting list for uncategorized submissions has historically run years, so the newest volunteer sites may not be listed yet.
- Think card catalog, not library: every entry points somewhere else. The value is discovery of small volunteer sites a search engine buries, especially USGenWeb county pages, local society transcription projects, and personal home pages.

## Structure (verified live 2026-11-24)

- **Categories index:** `https://www.cyndislist.com/categories` lists every category with stable slug URLs (`/cemeteries/`, `/marriages/`, `/census-worldwide/`, `/surnames/`, `/maps/`, `/newspapers/`, `/obituaries/`, `/land/`, and more).
- **Top-level divisions:** Localities (by country, then state/province, then county), Records (by type: births, marriages, deaths, cemeteries, census, land, military, newspapers, obituaries), Religions, Ethnic Groups, Occupations, Research Tools, and more.
- **United States index:** `https://www.cyndislist.com/us/` with a page per state, e.g. Michigan at `https://www.cyndislist.com/us/mi/` or Illinois at `https://www.cyndislist.com/us/il/`.
- **State pages** split into record-type subpages: `/us/<st>/bmd/`, `/us/<st>/cemeteries/`, `/us/<st>/census/`, `/us/<st>/counties/`, `/us/<st>/directories/`, `/us/<st>/history/`, `/us/<st>/land/`, `/us/<st>/libraries/`, `/us/<st>/maps/`, `/us/<st>/military/`, `/us/<st>/newspapers/`, `/us/<st>/obituaries/`, `/us/<st>/periodicals/`, `/us/<st>/photos/`, and others.
- **County pages** follow one pattern: `https://www.cyndislist.com/us/<st>/counties/<county>/`, e.g. `https://www.cyndislist.com/us/mi/counties/wayne/`. Each county page links to topic subpages such as `bmd/`, `cemeteries/`, `census/`, `general/`. The counties index for a state lives at `https://www.cyndislist.com/us/<st>/counties/`.
- **Site search:** the search box is a Google Custom Search (Google CSE) over cyndislist.com, not a native index. It finds category pages and link descriptions, not the contents of linked sites. Prefer navigating the category tree over searching when you know the county and record type.

## County-first workflow

1. Start at the county page, not the homepage: `https://www.cyndislist.com/us/<st>/counties/<county>/` (using the two-letter state code and lowercase county name with no spaces, e.g. `/us/il/counties/sangamon/` or `/us/ny/counties/monroe/`). Verify the county page exists before citing it, since county coverage varies by state.
2. On the county page, open the topic subpage matching the record you need: `bmd` for births/marriages/deaths, `cemeteries` for cemetery surveys and tombstone transcriptions, `census` for census transcriptions and indexes, `general` for the county's USGenWeb page and society sites.
3. If the county page is thin, step up to the state record-type page (e.g. `/us/<st>/cemeteries/`) and to the national record-type category (e.g. `/cemeteries/`, `/marriages/`), which list statewide and national transcription projects that cover the county.
4. For surname-specific sites, check `/surnames/`; for church registers, check the religion categories (`/catholic/`, `/baptist/`, `/methodist/`, `/quaker/`, and others).

## Judging a linked site before citing it

Cyndi's List does not vet the contents of linked sites, and links rot. Before citing anything found through it:

- Open the link and confirm it still resolves and the transcription is actually there; dead or hijacked links are common on a directory this old.
- Note who transcribed it, from what source, and when. A volunteer transcription is a finding aid, not a primary source; cite the transcription as a pointer and verify against the original record (county clerk, FamilySearch image, or archive) before recording it as fact in `data/`.
- Prefer links to USGenWeb county pages, county genealogical societies, and library digital collections over undated personal home pages with no source notes.
- If a link is dead, try the Wayback Machine for the URL, then search the county name plus the record type; the project often moved to a new host.

## What Cyndi's List cannot do

- It holds no records itself. Searching it for a surname finds pages that mention that surname in a link description, not individuals in records.
- It has no API and no bulk data download. Do not scrape it wholesale; it is one person's curated directory, and heavy crawling is poor citizenship toward the maintainer.
- Coverage is uneven: a county with an active USGenWeb volunteer has a rich page; a county without one may have almost nothing. An empty county page means "nothing catalogued here", not "no records exist".

## Why there is no CLI

A CLI needs a machine interface: a public API, a stable search URL pattern returning records, or downloadable data. Cyndi's List has none of these. Its pages are hand-curated HTML link lists behind a Google Custom Search box, and the useful output (a handful of links on a county topic page) is read once by a human in a browser. Shipping a CLI that fetches and prints those links would add a tool that saves no work over opening the page, and it would go stale the moment Cyndi recategorizes a page. Skill-only is the honest shape.

## Verified-live note

Homepage, categories index, state pages, counties index, and county topic subpages (`bmd`, `cemeteries`, `census`, and `general`) were verified live returning HTTP 200 on 2026-11-24.
