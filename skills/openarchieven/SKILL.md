---
name: openarchieven
description: Search, inspect, and download Dutch and Belgian genealogical archives via the bundled uv-based `openarchieven` CLI or the public OpenArchieven 1.0 JSON API (`api.openarch.nl`). Covers Dutch civil registration (`BS Geboorte`, `BS Huwelijk`, `BS Overlijden`), municipal population registers (`Bevolkingsregisters`), DTB parish registers, and Rotterdam Holland America Line passenger lists (`Passagiersregisters`). Use when researching Dutch or Belgian ancestors, tracing emigrants departing Rotterdam, downloading scan images, or verifying primary vital records across Netherlands regional archives.
---

# OpenArchieven

This skill includes a standalone executable Python CLI invoked as `kinloom openarchieven` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`). No virtualenv setup, account, or API key is required for read queries.

OpenArchieven (`https://www.openarchieven.nl/`) aggregates hundreds of millions of indexed person mentions from Dutch and Belgian municipal and regional archives (including Brabants Historisch Informatie Centrum, West-Brabants Archief, Stadsarchief Rotterdam, Stadsarchief Amsterdam, Zeeuws Archief, Regionaal Historisch Centrum Eindhoven, and Gelders Archief).

## Bundled CLI (`scripts/openarchieven`)

Command: `kinloom openarchieven`
### Search records

```bash
# Search by person name, place, and year (Vincent van Gogh's 1853 Zundert birth)
kinloom openarchieven search --name "Vincent van Gogh" --place Zundert --year 1853

# Filter by Dutch civil registration source type or event type
kinloom openarchieven search --name "Vincent van Gogh" --event-type "BS Geboorte" --place Zundert
kinloom openarchieven search --name "Johannes Vermeer" --event-type Overlijden --limit 5

# Search municipal population registers (Bevolkingsregisters)
kinloom openarchieven search --name "Vincent van Gogh" --source-type Bevolkingsregister --limit 10

# Search Holland America Line passenger lists at Stadsarchief Rotterdam (archive code: srt)
kinloom openarchieven search --name "van Dijk" --source-type Passagiersregisters --archive srt --limit 5

# Year range filter and full JSON output
kinloom openarchieven search --name "Vincent van Gogh" --year 1850-1855 --json

# Page 2 with the default page size (10). This is the same request as --start 10.
kinloom openarchieven search --name "Vincent van Gogh" --limit 10 --page 2
```

`search` also accepts a positional name (`openarchieven search "Vincent van Gogh" --place Zundert`).

`--page` is an integer of 1 or more. The CLI sets `start` to `(page - 1)` times the limit it sends (`number_show`, from 1 to 100). Do not pass `--page` and `--start` in the same command. Omit `--page` to keep `--start` (default 0). Page 1 uses the same cache file as `start` 0. The cache key stores `start` and `number_show`. It does not store `page`.

### Inspect one full record (`show` / `get`)

```bash
# By archive code and UUID from search output (`get` is an alias for `show`)
kinloom openarchieven show bhi 78a37833-d731-ffe5-184c-f9f424826871
kinloom openarchieven get "bhi:78a37833-d731-ffe5-184c-f9f424826871" --json

# Or by compact archive:uuid token or full OpenArchieven URL
kinloom openarchieven show "bhi:78a37833-d731-ffe5-184c-f9f424826871"
kinloom openarchieven show "https://www.openarchieven.nl/bhi:78a37833-d731-ffe5-184c-f9f424826871" --json
```

`show` (or `get`) queries `show.json` and parses the returned A2A (Archives-to-Archives) record: source type, archive institution, inventory/book/document numbers, event date and place, every person named on the deed with their role (`Kind`, `Vader`, `Moeder`, `Bruid`, `Bruidegom`, `Overledene`, `Geregistreerde`), scan image URLs, and the digital original link.

### Download scan images

`download` reads the same cached `show` record. It does not call `show.json` again when that cache is fresh. It saves the full-resolution `a2a_Uri` (or a flat `uri`). When `a2a_Uri` points to an HTML viewer page (such as `www.archieven.nl`, `www.zeeuwsarchief.nl`, or `hdl.handle.net`) or returns HTML, `download` upgrades `proxy.archieven.nl/thumb/...` to full-resolution `proxy.archieven.nl/download/...` and falls back to `a2a_UriPreview` automatically. Direct scan image URLs are also accepted. Pass `--preview` to save `a2a_UriPreview` (or `uri_preview`) directly.

```bash
# List scan index, order, label, and URL. This does not download files.
kinloom openarchieven download "bhi:78a37833-d731-ffe5-184c-f9f424826871" --list
kinloom openarchieven download "bhi:78a37833-d731-ffe5-184c-f9f424826871" --list --json

# Download scan 1 (the default) to one file.
kinloom openarchieven download bhi 78a37833-d731-ffe5-184c-f9f424826871 --out /tmp/van-gogh-birth.jpg

# Download every scan into a directory. File names look like bhi-78a37833-scan-01.jpg.
kinloom openarchieven download "https://www.openarchieven.nl/bhi:78a37833-d731-ffe5-184c-f9f424826871" --all --out-dir /tmp/van-gogh-scans --json
```

`--out`, `--output`, and `-o` are the same option. With `--all`, that option is the output directory. `--out-dir` and `--output-dir` are the same directory option.

The command accepts the same record reference as `show`. Pass `ARCHIVE IDENTIFIER`, `archive:uuid`, or an `https://www.openarchieven.nl/...` record URL.

`--scan-index` is 1-based. The default is `1`. `--all` downloads every scan and does not read `--scan-index`.

JSON output includes `cache_hit`. A download also includes `files`. `--list --json` includes `scans` instead of `files`. `cache_hit` is true only when the record lookup and every saved file came from disk.

If the record has no scan URL, `--list` prints an empty scan list and exits 0. A download exits 1.

The command saves an image or a PDF only. If the URL returns HTML, another non-image body, or an HTTP error, the command exits 1 and does not write that response to the output file or to the scan cache.

### Build a shareable website URL offline

```bash
kinloom openarchieven url --name "Vincent van Gogh" --place Zundert --year 1853
kinloom openarchieven url --record "bhi:78a37833-d731-ffe5-184c-f9f424826871"
```

## API rules and quirks (verified live 2026-11-25)

- **Search endpoint:** `GET https://api.openarch.nl/1.0/records/search.json`
- **Record detail endpoint:** `GET https://api.openarch.nl/1.0/records/show.json?archive=<code>&identifier=<uuid>`
- **Auth:** none for read methods (`search.json`, `show.json`). Only comment write endpoints require an API key.
- **Rate limit & retries:** 4 requests per second per IP address. The CLI spaces requests by 0.25 s, sends a `kinloom` User-Agent header, retries transient `429`/`5xx` and network errors up to 3 attempts (respecting `Retry-After`), enforces an `api.openarch.nl` HTTPS allowlist on API calls (and blocks private/loopback hosts on scan downloads), and exits 0 cleanly on `BrokenPipeError`.
- **Year and range filtering:** OpenArchieven's `search.json` ignores `eventyear=`, `year=`, and `period=` parameters. Pass a single year (`1853`) or range (`1850-1860`) inside the `name` query string (the CLI appends `--year` to `name` automatically).
- **Archive code parameter on v1.0:** Pass the short `archive_code` (such as `bhi`, `wba`, `srt`, `rhe`, `saa`, `zal`), not the full institution name, to `archive=` on both `1.0/records/search.json` and `1.0/records/show.json`. (OpenArchieven's newer OpenAPI spec documents `archive_code` for v1.1, while v1.0 reads `archive`.)
- **`sourcetype` vs `eventtype`:** Civil registration categories such as `BS Geboorte`, `BS Huwelijk`, `BS Overlijden`, `Bevolkingsregister`, and `Passagiersregisters` belong in `sourcetype`, while event verbs such as `Geboorte`, `Huwelijk`, `Overlijden`, `Registratie`, and `Vertrek` belong in `eventtype`. The CLI routes `BS ...`, `DTB ...`, and known source-type labels passed via `--event-type` to `sourcetype` automatically so queries do not silently return zero hits.
- **Error signaling:** Invalid archive codes or identifiers can return HTTP 200 with `{"error_code": 1, "error_description": "Invalid archive"}`; the CLI checks for `error_code` and exits non-zero.
- **Paging cap:** `number_show` accepts up to 100 rows per call. `start` accepts offsets up to 10,000. `--page` 1 is the first page (`start` 0). `--page` 2 with `--limit` 10 is `start` 10.

## Key Dutch record types for genealogy

| Source type | Dutch label | Typical coverage | Value |
|---|---|---|---|
| Civil birth | `BS Geboorte` | 1811 to ~1925 (100-year privacy rule) | Exact birth date/time, place, parents' names, father's occupation and age |
| Civil marriage | `BS Huwelijk` | 1811 to ~1950 (75-year privacy rule) | Bride/groom ages, birthplaces, occupations, and both sets of parents |
| Civil death | `BS Overlijden` | 1811 to ~1975 (50-year privacy rule) | Death date, age, spouse, and parents' names |
| Population register | `Bevolkingsregister` | ca. 1850 to 1939 | Household composition, birth dates/places, religion, moves in and out (including emigration dates) |
| Parish registers (pre-1811) | `DTB Dopen`, `DTB Trouwen`, `DTB Begraven` | ca. 1580 to 1811 | Baptisms, marriage banns, and burials before civil registration |
| Passenger lists | `Passagiersregisters` | late 1800s to 1969 | Holland America Line departures at Stadsarchief Rotterdam (`srt`), ship name, departure date, destination |

## Research workflow notes

- **Search two people at once with `&`:** OpenArchieven supports combining two names in `--name`, such as `"Theodorus van Gogh & Anna Cornelia Carbentus"`, to pull every civil record naming a married couple together.
- **Mind Dutch tussenvoegsels and patronymics:** Prefixes (`van`, `van der`, `de`, `den`) are indexed alongside the surname; pre-1811 DTB records often index people by patronymic rather than a fixed surname (for example, 17th-century Leiden records before hereditary surnames became mandatory in 1811).
- **Follow `Bevolkingsregisters` across municipalities:** When a civil record shows a move or emigration, inspect the household entry with `show` to capture destination columns (`vertrokken naar`) before checking Rotterdam `Passagiersregisters` (`--archive srt`).
- **Verify against the original scan:** Indexed A2A transcripts occasionally misread handwritten dates or ages. Download the scan with `download`, or open the scan URL from `show`, before you treat a date as final.

## Disk cache and environment variables

`search` and `show` cache successful responses on disk under `~/.cache/kinloom-openarchieven/` (default TTL `168` hours, advisory `flock` per cache key, atomic temp-file writes). `download` reuses the `show` cache. It stores image and PDF bodies under `~/.cache/kinloom-openarchieven/scans/`. HTTP errors, API `error_code` responses, invalid payloads, empty bodies, and HTML responses are never cached.

- `--refresh`: bypass cached reads and write the fresh response to disk.
- `--cache-ttl-hours <hours>`: override TTL for one call (`0` disables cached reads).
- `KINLOOM_OPENARCHIEVEN_CACHE_DIR`: override the cache directory path.
- `KINLOOM_OPENARCHIEVEN_CACHE_TTL_HOURS`: override the default TTL in hours.

No key or account is needed for OpenArchieven read queries.

## Kinloom Research Package workflow

Never edit `data/*.yaml` directly from a research session. Follow Kinloom's staged **Research Package** workflow and **Living Privacy Rule** (never include living people's portraits, exact birth dates, street addresses, or pronunciations in public archives):

1. Discover research targets with `kinloom status --missing-biography` or `kinloom status --end-of-line`.
2. Gather privacy-fenced context with `kinloom context <person_id> --include-family`.
3. Prepare downloaded scans with `kinloom prep-scan` (for example `kinloom prep-scan crop --redact-orig`) and run `kinloom ocr` as needed, then stage scans under `research/people/<person_id>/scans/`.
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
