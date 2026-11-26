---
name: openarchieven
description: Search and inspect Dutch and Belgian genealogical archives via the bundled uv-based `openarchieven` CLI or the public OpenArchieven 1.0 JSON API (`api.openarch.nl`). Covers Dutch civil registration (`BS Geboorte`, `BS Huwelijk`, `BS Overlijden`), municipal population registers (`Bevolkingsregisters`), DTB parish registers, and Rotterdam Holland America Line passenger lists (`Passagiersregisters`). Use when researching Dutch or Belgian ancestors, tracing emigrants departing Rotterdam, or verifying primary vital records across Netherlands regional archives.
---

# OpenArchieven

This skill includes a standalone executable Python CLI at `skills/openarchieven/scripts/openarchieven` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`). No virtualenv setup, account, or API key is required for read queries.

OpenArchieven (`https://www.openarchieven.nl/`) aggregates hundreds of millions of indexed person mentions from Dutch and Belgian municipal and regional archives (including Brabants Historisch Informatie Centrum, West-Brabants Archief, Stadsarchief Rotterdam, Stadsarchief Amsterdam, Zeeuws Archief, Regionaal Historisch Centrum Eindhoven, and Gelders Archief).

## Bundled CLI (`scripts/openarchieven`)

Path: `skills/openarchieven/scripts/openarchieven`

### Search records

```bash
# Search by person name, place, and year (Vincent van Gogh's 1853 Zundert birth)
skills/openarchieven/scripts/openarchieven search --name "Vincent van Gogh" --place Zundert --year 1853

# Filter by Dutch civil registration source type or event type
skills/openarchieven/scripts/openarchieven search --name "Vincent van Gogh" --event-type "BS Geboorte" --place Zundert
skills/openarchieven/scripts/openarchieven search --name "Johannes Vermeer" --event-type Overlijden --limit 5

# Search municipal population registers (Bevolkingsregisters)
skills/openarchieven/scripts/openarchieven search --name "Vincent van Gogh" --source-type Bevolkingsregister --limit 10

# Search Holland America Line passenger lists at Stadsarchief Rotterdam (archive code: srt)
skills/openarchieven/scripts/openarchieven search --name "van Dijk" --source-type Passagiersregisters --archive srt --limit 5

# Year range filter and full JSON output
skills/openarchieven/scripts/openarchieven search --name "Vincent van Gogh" --year 1850-1855 --json
```

`search` also accepts a positional name (`openarchieven search "Vincent van Gogh" --place Zundert`).

### Inspect one full record (`show`)

```bash
# By archive code and UUID from search output
skills/openarchieven/scripts/openarchieven show bhi 78a37833-d731-ffe5-184c-f9f424826871

# Or by compact archive:uuid token or full OpenArchieven URL
skills/openarchieven/scripts/openarchieven show "bhi:78a37833-d731-ffe5-184c-f9f424826871"
skills/openarchieven/scripts/openarchieven show "https://www.openarchieven.nl/bhi:78a37833-d731-ffe5-184c-f9f424826871" --json
```

`show` queries `show.json` and parses the returned A2A (Archives-to-Archives) record: source type, archive institution, inventory/book/document numbers, event date and place, every person named on the deed with their role (`Kind`, `Vader`, `Moeder`, `Bruid`, `Bruidegom`, `Overledene`, `Geregistreerde`), scan image URLs, and the digital original link.

### Build a shareable website URL offline

```bash
skills/openarchieven/scripts/openarchieven url --name "Vincent van Gogh" --place Zundert --year 1853
skills/openarchieven/scripts/openarchieven url --record "bhi:78a37833-d731-ffe5-184c-f9f424826871"
```

## API rules and quirks (verified live 2026-11-25)

- **Search endpoint:** `GET https://api.openarch.nl/1.0/records/search.json`
- **Record detail endpoint:** `GET https://api.openarch.nl/1.0/records/show.json?archive=<code>&identifier=<uuid>`
- **Auth:** none for read methods (`search.json`, `show.json`). Only comment write endpoints require an API key.
- **Rate limit:** 4 requests per second per IP address. The CLI sleeps 0.25 s per request and sends a `kinloom` User-Agent header.
- **Year and range filtering:** OpenArchieven's `search.json` ignores `eventyear=`, `year=`, and `period=` parameters. Pass a single year (`1853`) or range (`1850-1860`) inside the `name` query string (the CLI appends `--year` to `name` automatically).
- **Archive code parameter on v1.0:** Pass the short `archive_code` (such as `bhi`, `wba`, `srt`, `rhe`, `saa`, `zal`), not the full institution name, to `archive=` on both `1.0/records/search.json` and `1.0/records/show.json`. (OpenArchieven's newer OpenAPI spec documents `archive_code` for v1.1, while v1.0 reads `archive`.)
- **`sourcetype` vs `eventtype`:** Civil registration categories such as `BS Geboorte`, `BS Huwelijk`, `BS Overlijden`, `Bevolkingsregister`, and `Passagiersregisters` belong in `sourcetype`, while event verbs such as `Geboorte`, `Huwelijk`, `Overlijden`, `Registratie`, and `Vertrek` belong in `eventtype`. The CLI routes `BS ...`, `DTB ...`, and known source-type labels passed via `--event-type` to `sourcetype` automatically so queries do not silently return zero hits.
- **Error signaling:** Invalid archive codes or identifiers can return HTTP 200 with `{"error_code": 1, "error_description": "Invalid archive"}`; the CLI checks for `error_code` and exits non-zero.
- **Paging cap:** `number_show` accepts up to 100 rows per call; `start` accepts offsets up to 10,000.

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
- **Verify against the original scan:** Indexed A2A transcripts occasionally misread handwritten dates or ages; open the `a2a_SourceAvailableScans` or `Original` URL from `show` before treating a date as final.

## Disk cache and environment variables

`search` and `show` cache successful responses on disk under `~/.cache/kinloom-openarchieven/` (default TTL `168` hours, advisory `flock` per cache key, atomic temp-file writes). HTTP errors, API `error_code` responses, and invalid payloads are never cached.

- `--refresh`: bypass cached reads and write the fresh response to disk.
- `--cache-ttl-hours <hours>`: override TTL for one call (`0` disables cached reads).
- `KINLOOM_OPENARCHIEVEN_CACHE_DIR`: override the cache directory path.
- `KINLOOM_OPENARCHIEVEN_CACHE_TTL_HOURS`: override the default TTL in hours.

No key or account is needed for OpenArchieven read queries.
