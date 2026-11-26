---
name: uk-archives
description: Research historical and genealogical records in England and the UK via the bundled `uk-archives` CLI. Covers The National Archives Discovery free JSON API (wills, Chancery, local deposit catalogues) and FreeREG parish register transcriptions (Rails form over HTTP, no API key). Also documents browser-only paths for Nottinghamshire Archives CalmView, British History Online, and GENUKI, with honest notes on subscription sites (Ancestry UK, Findmypast, GRO PDF ordering). Use when tracing English ancestors before emigration, finding PCC wills, parish baptisms or marriages, or deciding whether a UK record is online, digitised, or visit-only.
---

# UK Archives: England and The National Archives

Portals: [The National Archives Discovery](https://discovery.nationalarchives.gov.uk/), [FreeREG](https://www.freereg.org.uk/), [Nottinghamshire Archives catalogue](https://nawcat.nottinghamshire.gov.uk/), [British History Online](https://www.british-history.ac.uk/), [GENUKI England](https://www.genuki.org.uk/big/eng).

## Bundled CLI (`scripts/uk-archives`)

Command: `kinloom uk-archives`
A standalone executable Python CLI with a PEP 723 `#!/usr/bin/env -S uv run --script` shebang and inline dependencies (`click`, `httpx`). No virtualenv setup, no API key, no account.

### The National Archives (TNA) Discovery API (`tna` / `discovery`)

```bash
# Search PCC wills (PROB 11) in Norfolk for 1550-1620
kinloom uk-archives tna search --query "Smith Norfolk" \
  --collection "PROB 11" --start-date 1550 --end-date 1620 --limit 10 --json

# Inspect one TNA Discovery record by IAID (verified /API/records/v1/details/<iaid>)
kinloom uk-archives tna get D980036 --json

# Alias group `discovery` remains supported (discovery search / discovery detail)
kinloom uk-archives discovery search Lincoln --held-by Norfolk --limit 10
kinloom uk-archives discovery detail D980036 --json
```

Search options: `--query` / `-q` (or positional `QUERY`), `--collection` (series or department reference such as `"PROB 11"`, appended to the query, mapped to `sps.departments` when applicable, and post-filtered by catalogue reference), `--held-by` (extra repository or county text appended to the query), `--start-date` / `--date-from` / `--from-year` and `--end-date` / `--date-to` / `--to-year` (`YYYY` or `YYYY-MM-DD`, mapped to `sps.dateFrom` / `sps.dateTo`), `--limit` (integer `>= 1`), `--page` (`sps.page`), `--refresh`, `--cache-ttl-hours`, and `--json` (returns boolean `cache_hit`).

All TNA requests enforce a strict `discovery.nationalarchives.gov.uk` HTTPS host allowlist (before and after redirects), validate IAIDs against path traversal, and retry transient `429`/`5xx` and network errors with `Retry-After` backoff.

The detail route verified live is `https://discovery.nationalarchives.gov.uk/API/records/v1/details/<iaid>` (not `.../search/v1/records/v1/details/...`, which returns 404).

### FreeREG parish registers

```bash
# Search FreeREG by surname, county Chapman code, and year range
kinloom uk-archives freereg search --surname Lincoln --county NFK \
  --from-year 1550 --to-year 1650

# Filter hits by parish or register text
kinloom uk-archives freereg search --surname Lincoln --county NFK \
  --from-year 1550 --to-year 1650 --place-contains Hingham

# Search Nottinghamshire (NTT) parish registers, JSON output
kinloom uk-archives freereg search --surname Smith --county NTT \
  --from-year 1570 --to-year 1630 --json
```

FreeREG has no public JSON API. The CLI GETs the home page for a Rails `authenticity_token`, POSTs to `/search_queries`, and parses the results table HTML. No CAPTCHA appeared in live tests on 2026-11-24. Chapman codes (for example `NTT` for Nottinghamshire, `LND` for London, `KEN` for Kent, `NFK` for Norfolk) are passed directly to FreeREG.

Options: `--given`, `--county` (Chapman code or county name), `--from-year`, `--to-year`, `--record-type` (`all` / `baptism` / `marriage` / `burial`), `--place-contains`, `--limit`, `--json`.

`--limit` is an integer of 1 or more. The CLI applies it after `--place-contains`. Omit `--limit` to print every match. The cache key does not include `--limit`, so a later call with a different limit reads the same FreeREG response from disk.

### URL builders (no search run)

```bash
kinloom uk-archives url --discovery "Lincoln Norfolk"
kinloom uk-archives url --freereg
kinloom uk-archives url --notts Lincoln
kinloom uk-archives url --bho "Nottinghamshire"
kinloom uk-archives url --genuki nottinghamshire
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
5. Cross-check transcribed parish entries against original register images or Bishop's Transcripts on FamilySearch, Ancestry UK, or Findmypast before citing them in a staged **Research Package** (`research/people/<person_id>/patch.json`).

## Verification log (verified live 2026-11-26)

- TNA Discovery search GET `https://discovery.nationalarchives.gov.uk/API/search/v1/records?sps.searchQuery=Smith+Norfolk+%22PROB+11%22&sps.dateFrom=1550-01-01&sps.dateTo=1620-12-31&rows=5`: HTTP 200 JSON (`count: 18`, `PROB 11` wills including `D980036` / `PROB 11/44/39`). Passing bare 4-digit years (`1550`) without `-01-01` / `-12-31` returns HTTP 500, so the CLI normalizes `YYYY` to `YYYY-01-01` / `YYYY-12-31`.
- TNA Discovery detail GET `https://discovery.nationalarchives.gov.uk/API/records/v1/details/D980036`: HTTP 200 JSON with `citableReference`, `coveringDates`, `digitised`, `scopeContent.description`, and `heldBy`. Path `.../API/search/v1/records/v1/details/<id>` returned **404** (do not use).
- FreeREG GET `https://www.freereg.org.uk/`: HTTP **200**, CSRF token present; POST `/search_queries` returned HTTP **200** with parseable HTML table rows.
- British History Online GET `https://www.british-history.ac.uk/`: HTTP **302** (site up; no search API wired).
- Nottinghamshire CalmView GET `https://nawcat.nottinghamshire.gov.uk/CalmView/`: connection timeout at 45s (browser-only note; no machine search).
- CLI: `tna search`, `tna get`, `discovery search`, `discovery detail`, `freereg search`, and `url` all exited **0**.

## Disk cache and environment variables

`discovery search`, `discovery detail` (`inspect`/`get`), and `freereg search` cache successful responses on disk under `~/.cache/kinloom-uk-archives/` (default TTL `168` hours, advisory `flock` per cache key, atomic temp-file writes). HTTP errors, malformed JSON, missing CSRF tokens, and empty responses are never cached.

- `--refresh`: bypass cached reads and write the fresh response to disk.
- `--cache-ttl-hours <hours>`: override TTL for one call (`0` disables cached reads).
- `KINLOOM_UK_ARCHIVES_CACHE_DIR`: override the cache directory path.
- `KINLOOM_UK_ARCHIVES_CACHE_TTL_HOURS`: override the default TTL in hours.

## What this skill does not cover

- Scotland, Wales, and Ireland beyond what Discovery holds for the whole UK catalogue.
- Subscription sites (Ancestry UK, Findmypast, MyHeritage) and the GRO index ordering flow.
- Do not invent Discovery detail URLs under `/API/search/v1/.../details/` or a FreeREG JSON API. Where no machine interface was verified, the skill says so and gives a URL builder or browser path instead.

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
