---
name: library-of-michigan
description: Research Michigan branches at the Library of Michigan (Lansing) and its Michiganology digital portal via the bundled `michiganology` CLI or the website. Covers CLI search, the searchable digital collections (death certificates 1897-1952, Michigan state census, naturalization, WWI service cards, surveyor notebooks and maps, photographs, maps), what is online vs in-person only (tax rolls, plat maps, state census schedules, Abrams Foundation Historical Collection), and planning a Lansing visit. Use when family lines touch Michigan or neighboring Midwest migration routes.
---

# Library of Michigan

This skill includes a standalone executable Python CLI at `skills/library-of-michigan/scripts/michiganology` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependency (`click`). It shells out to system `curl` for fetches, because Preservica's front door 403s Python httpx requests while curl succeeds; curl must be installed. No virtualenv setup or API key is required.

Two institutions share one building and one research mission in Lansing, and the skill covers both:

- **Library of Michigan**, 702 W. Kalamazoo St., Lansing, MI 48915. Reference desk 517-335-1477, librarian@michigan.gov. Open Mon-Fri 10 am to 5 pm, Sat 10 am to 4 pm; free admission. Its Abrams Foundation Historical Collection (2nd floor) is one of the largest genealogy collections in the US: census records, cemetery transcriptions, city directories, county and family histories, newspapers from all 83 Michigan counties, land records, vital records, and military indexes.
- **Archives of Michigan**, same building. Open Mon-Fri 1 to 5 pm, Sat 10 am to 4 pm, phone 517-335-2576. Holds state government records, including the collections digitized on Michiganology.

## Bundled CLI (`scripts/michiganology`)

Path: `skills/library-of-michigan/scripts/michiganology`

### Search all digital collections

```bash
# Search a surname across every Michiganology collection
skills/library-of-michigan/scripts/michiganology search Lincoln

# JSON output, 20 hits
skills/library-of-michigan/scripts/michiganology search Lincoln --limit 20 --json
```

Note on multi-word queries: Preservica simple search treats unquoted multi-word queries (such as `"Abraham Lincoln"`) as broad OR matches across collections, so a broad search can return county tax rolls or unrelated files. Inspect individual hits with `get` or narrow with Advanced Search on the website.

### Inspect an item (`get`) and download the scan (`download`)

Search output prints only the item title (often just a surname or certificate number) and URL. Use `get` to read the full Preservica `Item Data` fields (given name, death date, county, city, parents) and `download` to pull the full-resolution JPEG or PDF directly via `curl`:

```bash
# Read parsed Item Data metadata and direct download link
skills/library-of-michigan/scripts/michiganology get IO_<uuid>
skills/library-of-michigan/scripts/michiganology get "https://michigan.access.preservica.com/uncategorized/IO_<uuid>/" --json

# Download the full-resolution file (filename inferred from Content-Disposition)
skills/library-of-michigan/scripts/michiganology download IO_<uuid> --out ./downloads/michiganology
```

### List the digital collections

```bash
skills/library-of-michigan/scripts/michiganology collections
```

### Shareable search URL

```bash
skills/library-of-michigan/scripts/michiganology url Lincoln
# https://michigan.access.preservica.com/?s=Lincoln
```

## Michiganology: what is searchable online (verified live 2026-11-24)

Michiganology (`https://michiganology.org/`) is the Michigan History Center portal; its searchable collections live on Preservica Universal Access at `https://michigan.access.preservica.com/`. Simple search is a stable GET, `/?s=<query>`, and results are server-rendered, so plain HTTP works with no browser, no key, and no sign-in. The CLI shows the first page only; use the website (with its sort and filter sidebar) to page through large result sets.

Collections and their live URLs:

| Collection | URL |
|---|---|
| Death Certificates, 1897-1952 | `https://michigan.access.preservica.com/death-certificates-1897-1952/` |
| Michigan State Census, 1827-1894 | `https://michigan.access.preservica.com/michigan-state-census/` |
| Naturalization Records | `https://michigan.access.preservica.com/naturalization-records/` |
| World War I, Service Cards | `https://michigan.access.preservica.com/world-war-i-service-cards/` |
| Surveyor Field Notebooks, 1815-1918 | `https://michigan.access.preservica.com/surveyor-field-notebooks/` |
| Surveyor Maps, 1816-1860 | `https://michigan.access.preservica.com/surveyor-maps/` |
| General Photograph Collection, ca. 1860-1990 | `https://michigan.access.preservica.com/general-photograph-collection/` |
| Archives of Michigan Map Collection, ca. 1810-1970 | `https://michigan.access.preservica.com/archives-of-michigan-map-collection/` |
| Corporation Annual Reports, 1997-2006 | `https://michigan.access.preservica.com/corporation-annual-reports/` |

Collection notes:

- Death certificates: the index covers 1897-1952. Per library guides (reported, not verified live), digitized certificate images are viewable for records older than 75 years; newer entries are index-only. Michigan death records 1867-1897 predate this collection; use FamilySearch for those.
- Michigan state census schedules (1827-1894) fill gaps between federal censuses and are a strong online source for pre-1900 Michigan households.
- Naturalization indexes cover 29 counties (per library guides); the actual records may need an in-person or copy request.
- The website also has an Advanced Search page with fielded filters (Family Name, Given Name, County, Birth/Death Date, Place, and more), but it is JavaScript-driven with no stable GET pattern verified, so the CLI covers simple search only. Use the website for fielded searches.

## What is in-person only

Not everything is digitized. Expect to visit Lansing (or order copies) for:

- County-level tax rolls and plat maps in physical form; some plat maps and atlases are digitized through the Michigan County Histories and Atlases project (University of Michigan), not Michiganology.
- State census schedules beyond what Michiganology has digitized, and manuscript census material.
- Most newspapers: the library holds microfilm newspapers from all 83 counties, but only a subset is online (see the Digital Michigan Newspaper Portal at Central Michigan University's Clarke Historical Library).
- Vital records on microfilm, probate and court records, and manuscript collections in the Archives.
- The library catalog (ANSWER) is searchable online before a visit; use it to pull call numbers in advance so reading-room time is spent reading, not searching.

## Subscription databases (Michigan residents, library card required)

Michigan residents can use the Library of Michigan's subscription databases remotely with a Library of Michigan library card and PIN, via `michigan.gov/libraryofmichigan` online resources. This includes Ancestry Library Edition style resources and MyHeritage Library Edition. These need a personal library card; the CLI does not touch them and no credentials belong in this repo.

## Research workflow

1. `michiganology search <Surname>` for the broad sweep; note the total count and the strongest first-page hits.
2. Narrow on the website with Advanced Search: Family Name plus County (for example Wayne, Ingham, or Washtenaw), and filter to the Death Certificates collection for 1897-1952 deaths.
3. Combine surname and locality (for example `michiganology search "Lincoln Detroit"`) when the surname alone is too noisy; simple search matches either word anywhere, so quote exact names to narrow.
4. For pre-1897 Michigan deaths and marriages, cross-check FamilySearch Michigan collections; Michiganology's death run starts in 1897.
5. For land and neighborhood context, pair surveyor maps and the map collection with county plat maps and atlases held in Lansing or digitized at the University of Michigan.
6. Record every hit in `data/` with its Michiganology item URL; item URLs are stable (`michigan.access.preservica.com/uncategorized/SO_<uuid>` or `IO_<uuid>`).

## Environment variables

None. No key or account is needed for Michiganology search.

## Verified-live note

The Michiganology homepage, the Preservica search (`/?s=<query>`), the collections list, and the Library of Michigan address, hours, and phone were verified live on 2026-11-24. Items marked "per library guides" or "reported" were not re-verified live and are labeled as such.
