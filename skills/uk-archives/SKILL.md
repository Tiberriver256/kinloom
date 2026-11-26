---
name: uk-archives
description: Research historical and genealogical records in England and the UK via the bundled `uk-archives` CLI. Covers The National Archives Discovery free JSON API (wills, Chancery, local deposit catalogues) and FreeREG parish register transcriptions (Rails form over HTTP, no API key). Also documents browser-only paths for Nottinghamshire Archives CalmView, British History Online, and GENUKI, with honest notes on subscription sites (Ancestry UK, Findmypast, GRO PDF ordering). Use when tracing English ancestors before emigration, finding PCC wills, parish baptisms or marriages, or deciding whether a UK record is online, digitised, or visit-only.
---

# UK Archives: England and The National Archives

Portals: [The National Archives Discovery](https://discovery.nationalarchives.gov.uk/), [FreeREG](https://www.freereg.org.uk/), [Nottinghamshire Archives catalogue](https://nawcat.nottinghamshire.gov.uk/), [British History Online](https://www.british-history.ac.uk/), [GENUKI England](https://www.genuki.org.uk/big/eng).

## Bundled CLI (`scripts/uk-archives`)

Path: `skills/uk-archives/scripts/uk-archives`

A standalone executable Python CLI with a PEP 723 `#!/usr/bin/env -S uv run --script` shebang and inline dependencies (`click`, `httpx`). No virtualenv setup, no API key, no account.

### The National Archives Discovery

```bash
# Search Discovery catalogue hits filtered by county text
skills/uk-archives/scripts/uk-archives discovery search Lincoln --held-by Norfolk --limit 10

# PCC wills (PROB 11) for a surname and date range
skills/uk-archives/scripts/uk-archives discovery search Lincoln \
  --date-from 1550 --date-to 1660 --collection "PROB 11" --limit 20 --json

# One record (verified detail endpoint uses /API/records/v1/details/<id>; aliases: inspect, get)
skills/uk-archives/scripts/uk-archives discovery detail <record-id> --json
```

Search options: `--held-by` (free text appended to the query), `--date-from` / `--from-year` and `--date-to` / `--to-year` (YYYY or YYYY-MM-DD, mapped to `sps.dateFrom` / `sps.dateTo`), `--collection` (appended to the query and used to post-filter by catalogue reference), `--limit` (the API returns at most 15 rows per request; the CLI slices to your limit), `--query` / `-q` (alias for positional query). Each hit prints id, reference, dates, title, places, and a Discovery web URL.

The detail route verified live is `https://discovery.nationalarchives.gov.uk/API/records/v1/details/<id>` (not `.../search/v1/records/v1/details/...`, which returns 404).

### FreeREG parish registers

```bash
# Search FreeREG by surname, county Chapman code, and year range
skills/uk-archives/scripts/uk-archives freereg search --surname Lincoln --county NFK \
  --from-year 1550 --to-year 1650

# Filter hits by parish or register text
skills/uk-archives/scripts/uk-archives freereg search --surname Lincoln --county NFK \
  --from-year 1550 --to-year 1650 --place-contains Hingham

# Search Nottinghamshire (NTT) parish registers, JSON output
skills/uk-archives/scripts/uk-archives freereg search --surname Smith --county NTT \
  --from-year 1570 --to-year 1630 --json
```

FreeREG has no public JSON API. The CLI GETs the home page for a Rails `authenticity_token`, POSTs to `/search_queries`, and parses the results table HTML. No CAPTCHA appeared in live tests on 2026-11-24. Chapman codes (for example `NTT` for Nottinghamshire, `LND` for London, `KEN` for Kent, `NFK` for Norfolk) are passed directly to FreeREG.

Options: `--given`, `--county` (Chapman code or county name), `--from-year`, `--to-year`, `--record-type` (`all` / `baptism` / `marriage` / `burial`), `--place-contains`, `--json`.

### URL builders (no search run)

```bash
skills/uk-archives/scripts/uk-archives url --discovery "Lincoln Norfolk"
skills/uk-archives/scripts/uk-archives url --freereg
skills/uk-archives/scripts/uk-archives url --notts Lincoln
skills/uk-archives/scripts/uk-archives url --bho "Nottinghamshire"
skills/uk-archives/scripts/uk-archives url --genuki nottinghamshire
```

## What is searchable online

- **Discovery:** Key-free JSON search and detail for the national catalogue (PCC wills `PROB 11`, Chancery, records held at TNA and other repositories). Digitised will images are linked from the Discovery record page when `digitised: true`.
- **FreeREG:** Volunteer transcriptions of Church of England registers (and related collections). Strong for English counties when parish registers are not on FamilySearch.
- **British History Online:** Open scholarly texts and Victoria County History material. Plain HTTP returned 302 to the site home on 2026-11-24. Use `url --bho` and search in the browser (no stable API verified).
- **GENUKI:** Parish and county guidance pages. Use `url --genuki` for England or county hubs (`england`, `kent`, `london`, `nottingham`, `nottinghamshire`, `yorkshire`).

## What is browser-only or subscription-only

- **County Archives CalmView catalogues** (such as Nottinghamshire Archives `nawcat.nottinghamshire.gov.uk`): HTTPS timed out after 45s in automated checks on 2026-11-24. Use `url --notts` and search in a browser.
- **Ancestry UK / Findmypast / GRO certificate PDF ordering:** Subscription or pay-per-item. Not implemented; no API verified.
- **Discovery advanced held-by filter parameters** (`sps.heldByReference`, `sps.departmentReference`, and similar) did not narrow results in live tests. Use `--held-by` as query text (for example `Nottinghamshire` or `Norfolk`) instead.

## Research workflow

Priority order for English pre-emigration and parish research:

1. **FreeREG** for parish baptisms, marriages, and burials by surname, Chapman county code, and year window.
2. **Discovery** for PCC wills (`PROB 11`) and Chancery records when parish registers do not establish family links.
3. **County archive manuscript catalogues** in the browser when Discovery points to local deposit references.
4. **BHO / GENUKI** for parish history, boundary changes, and manorial context.
5. Cross-check transcribed parish entries against original register images or Bishop's Transcripts on FamilySearch, Ancestry UK, or Findmypast before recording them as proved in `data/`.

## Verification log (verified live 2026-11-24)

- Discovery search GET `https://discovery.nationalarchives.gov.uk/API/search/v1/records?sps.searchQuery=...&rows=15`: HTTP 200 JSON with `count` and `records[]`.
- Discovery date filtering (`sps.dateFrom`, `sps.dateTo`) and `PROB 11` post-filtering: HTTP 200 JSON with valid catalogue references.
- Discovery detail GET `https://discovery.nationalarchives.gov.uk/API/records/v1/details/<id>`: HTTP 200 JSON with `digitised` and `citableReference`. Path `.../API/search/v1/records/v1/details/<id>` returned **404** (do not use).
- FreeREG GET `https://www.freereg.org.uk/`: HTTP **200**, CSRF token present; POST `/search_queries` returned HTTP **200** with parseable HTML table rows.
- British History Online GET `https://www.british-history.ac.uk/`: HTTP **302** (site up; no search API wired).
- Nottinghamshire CalmView GET `https://nawcat.nottinghamshire.gov.uk/CalmView/`: connection timeout at 45s (browser-only note; no machine search).
- CLI: `uv run --script skills/uk-archives/scripts/uk-archives --help`, `discovery search`, `discovery detail`, `freereg search`, and `url` all exited **0** on 2026-11-24.

## What this skill does not cover

- Scotland, Wales, and Ireland beyond what Discovery holds for the whole UK catalogue.
- Subscription sites (Ancestry UK, Findmypast, MyHeritage) and the GRO index ordering flow.
- Do not invent Discovery detail URLs under `/API/search/v1/.../details/` or a FreeREG JSON API. Where no machine interface was verified, the skill says so and gives a URL builder or browser path instead.
