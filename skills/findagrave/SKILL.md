---
name: findagrave
description: Search and read Find a Grave memorials, cemeteries, and places via the bundled uv-based `findagrave` CLI, the website search, or the site's own GraphQL API. Covers CLI usage, memorial and cemetery URL patterns, search filters, photo downloads, and what works vs what does not. Use when finding burial records, birth/death dates and places, cemetery details, linked family, or gravestone photos for genealogy research.
---

# Find a Grave

This skill includes a standalone executable Python CLI at `skills/findagrave/scripts/findagrave` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`). No virtualenv setup or API key is required.

## Bundled CLI (`scripts/findagrave`)

Path: `skills/findagrave/scripts/findagrave`

### Persistent local disk cache

`get`/`memorial`, `cemetery`, `photo`, `search`, and `place` cache responses atomically under `~/.cache/kinloom-findagrave/` (overrideable via `KINLOOM_FINDAGRAVE_CACHE_DIR`) using advisory file locks (`fcntl.flock` on POSIX, safe fallback elsewhere) so concurrent research threads never re-download shared memorials, cemeteries, or gravestone photos. Pass `--refresh` on any command to bypass the local cache and fetch fresh data. `--json` on `search`, `cemetery`, `place`, and `photo` adds a top-level boolean `cache_hit`. `get` and `memorial` keep a JSON list, so they do not add `cache_hit`. For `photo`, `cache_hit` is true only when the memorial record and every saved photo file came from disk.

Cache layout:

- `memorials/<id>.json`: parsed memorial JSON shared by `get`/`memorial` and `photo` (168-hour default TTL via `--cache-ttl-hours` or `KINLOOM_FINDAGRAVE_CACHE_TTL_HOURS`).
- `cemeteries/<id>.json`: parsed cemetery JSON for `cemetery <id>` (168-hour default TTL).
- `photos/<memorial_id>/<photo_id><ext>`: downloaded gravestone, portrait, family, and other image files. A file is stored only when the body is a non-empty JPEG, PNG, GIF, or WebP, or the response content type is one of those image types. HTML and empty bodies are not stored. The photo file uses the same TTL as memorial JSON (`--cache-ttl-hours` or `KINLOOM_FINDAGRAVE_CACHE_TTL_HOURS`, default 168). A later `photo` call copies the cached file into `--out` and does not send a second HTTP request.
- `_queries/<search|cemetery_search|place>/<sha256>.json`: cached search and typeahead JSON responses (168-hour default TTL).

### Search memorials

```bash
# Search memorials by first and last name
skills/findagrave/scripts/findagrave search --first Abraham --last Lincoln

# Narrow by years and place
skills/findagrave/scripts/findagrave search --first Clara --last Barton --birth-year 1821 --year-range 2
skills/findagrave/scripts/findagrave search --last Douglass --death-year 1895 --death-year-filter exact

# In one cemetery, or in one place (place id from the place command)
skills/findagrave/scripts/findagrave search --last Lincoln --cemetery-id <cemetery-id>
skills/findagrave/scripts/findagrave search --last Lincoln --location-id <location-id>

# Biography text, any-text, or a linked relative; full JSON output
skills/findagrave/scripts/findagrave search --last Lincoln --bio president --limit 5
skills/findagrave/scripts/findagrave search --first Harriet --last Tubman --json
```

Names match the site's default matching unless `--exact` is passed. Married women are also found under their maiden name by default (`--no-include-maiden` turns that off). A search returns at most 50 rows per call; use `--limit` and `--offset` to page. The site only reaches the first 10,000 results of a search, so narrow by place, years, or cemetery when totals are large.

### Read one or more memorials in full

```bash
# Read one memorial by id from search output (alias: memorial)
skills/findagrave/scripts/findagrave get <memorial-id>

# Full bio/inscription text, photo list, and JSON output (includes cemetery_lat / cemetery_lng and coordinates)
skills/findagrave/scripts/findagrave get <memorial-id> --full --photos
skills/findagrave/scripts/findagrave get <memorial-id-1> <memorial-id-2> --json
```

A `get` (or `memorial`) returns name (with maiden name separate), birth/death dates and places, memorial GPS `coordinates`, cemetery (with `coordinates`, `lat`/`lng`, `physicalAddress`, and top-level `cemetery_lat`/`cemetery_lng` in JSON), plot, inscription, bio, veteran flag, grave-photo flag, photo count, linked relationships (each with its own memorial id to read next), and created/modified dates. `familyRelations` is usually null in search-shaped responses; use `relationships` for linked family. In `--json` output, `bio` and `inscription` are returned as `{"value": "..."}` objects or `null` (matching the GraphQL schema).

### Cemeteries and places

```bash
# Cemeteries by name
skills/findagrave/scripts/findagrave cemetery --name "Oak Ridge"
skills/findagrave/scripts/findagrave cemetery --name "Oak Ridge" --place "Sangamon County, Illinois"

# One cemetery by id (positional id or --id both work; JSON includes coordinates, lat, lng, physicalAddress)
skills/findagrave/scripts/findagrave cemetery <cemetery-id> --json
skills/findagrave/scripts/findagrave cemetery --id <cemetery-id>

# Resolve a place name to ids (for use with search --location-id)
skills/findagrave/scripts/findagrave place --name Springfield
```

Place ids look like `city_<id>`, `county_<id>`, or a plain cemetery id. Resolve the name first and check it before using an id: the typeahead ranks by its own relevance, and a name can fit several places.

### Download photos

```bash
# Downloads a memorial's photos into ./photos
skills/findagrave/scripts/findagrave photo <memorial-id> --out ./photos
skills/findagrave/scripts/findagrave photo <memorial-id> --type Grave --out ./photos
skills/findagrave/scripts/findagrave photo <memorial-id> --all --out ./photos

# Add a self-describing filename prefix and a provenance sidecar JSON file
skills/findagrave/scripts/findagrave photo <memorial-id> --type Grave --prefix lincoln-abraham --metadata --out ./photos

# Print memorial_id, files, and cache_hit. cache_hit is true only when the memorial and every photo came from disk.
skills/findagrave/scripts/findagrave photo <memorial-id> --out ./photos --json
skills/findagrave/scripts/findagrave photo <memorial-id> --out ./photos --refresh --json
```

Files are saved as `<photo-id>.jpg` by default, or `<prefix>_<photo-id>.jpg` when `--prefix` is set (`--metadata` writes `<prefix>_<memorial-id>.metadata.json`). `--type` keeps one photo type, such as `Grave`, `Portrait`, `Family`, or `Other`. `--all` downloads every type, which is also the default when you omit `--type`. `--refresh` bypasses the memorial cache and the photo cache. `--cache-ttl-hours` sets the age limit for both. Read a gravestone photo before trusting a memorial's transcribed dates. The stone is the better source.

### Build a website search URL offline

```bash
skills/findagrave/scripts/findagrave url --first Abraham --last Lincoln --birth-year 1809
```

## Website search & URL patterns (verified live 2026-11-24)

- Memorial page: `https://www.findagrave.com/memorial/<memorial-id>` (name slug optional after the id, e.g. `https://www.findagrave.com/memorial/<memorial-id>/abraham-lincoln`)
- Cemetery page: `https://www.findagrave.com/cemetery/<cemetery-id>`
- Website search: `https://www.findagrave.com/memorial/search?firstname=Abraham&lastname=Lincoln&birthyear=1809&deathyear=1865`
- No sign-in is needed to search or read public memorials. Signed-in-only features (virtual cemeteries, flower leaving, edit requests, photo requests) are out of scope for this skill.

## GraphQL API rules (verified live 2026-11-24)

There is no public Find a Grave API. The CLI uses the site's own undocumented internal GraphQL API, which answers anonymously with no key, login, or cookies:

- Endpoint: `POST https://www.findagrave.com/orc/graphql`
- Headers: `Content-Type: application/json` plus a browser `User-Agent`. No auth headers.
- Top-level queries used by the CLI: `memorialSearch(search: MemorialSearchInput)`, `memorialsById(ids: [ID!]!)`, `cemeteries(ids:, search: CemeterySearchInput)`, `locationsByTypeahead(search: LocationSearchInput)`.
- `memorialSearch` returns `{ total, memorials }`. `MemorialSearchInput` fields verified live include `firstName`, `lastName`, `birthYear`, `deathYear`, `birthYearFilter`, `deathYearFilter`, `birthYearRange`, `deathYearRange`, `locationId`, `cemeteryIds`, `bio`, `fullText`, `linkedToName`, `exactName`, `includeMaidenName`, `from`, `size`. Year filters use the `MemorialSearchYearFilter` enum (`before`, `after`, `exact`, `unknown`).
- `Memorial` fields verified live include `id`, `name { first last maiden }`, `birth { date { year month day circa } place { names { name } } }`, `death` (same shape), `cemetery { id names { name } memorialCount }`, `plot`, `inscription { value }`, `bio { value }`, `isVeteran`, `hasGravePhoto`, `dateCreated`, `dateModified`, `relationships { type yearMarried memorial { id name { first last } } }`, `photos { total photos { id path caption type } }`.
- `Place` is a union of `Location` and `Cemetery`; use inline fragments (`... on Location`, `... on Cemetery`) when querying it.
- Full schema introspection is disabled, but `{ __type(name: "Memorial") { fields { name } } }` lists a type's fields, and `{ __type(name: "Query") { fields { name } } }` lists top-level queries. That is how the field lists above were verified.
- Because the API is undocumented, it can change without notice. If a query starts failing with `GRAPHQL_VALIDATION_FAILED`, re-probe the type with `__type` before assuming the data is gone.

## What works vs what does not

- Works: anonymous GraphQL `search`/`get`/`cemetery`/`place`/`photo` reads, and plain `curl` fetches of the website search HTML (verified live 2026-11-24).
- IP sensitivity: automated fetches can occasionally receive HTTP 403 depending on originating IP reputation; when that happens, fall back to a live browser.
- Cloudflare challenges bursts: space requests at least 250 ms apart (the CLI waits 0.3 s per request). If a 403 appears, wait a few minutes and retry once; if it persists, fall back to the website in a real browser.
- No bulk export: there is no dump or bulk-download endpoint. Work memorial by memorial and cite each one.

## Data quality: treat memorials as leads

Find a Grave is contributor-written. Dates, family links, and biographies are claims, often unsourced and sometimes copied from online trees. Prefer what a stone in a photo shows, cross-check dates against vital records and census data, and cite the memorial (id and URL) for every fact taken from it. A recently deceased person's memorial can show limited details.

## Environment variables

- `KINLOOM_FINDAGRAVE_CACHE_DIR`: optional override for the local disk cache directory (default `~/.cache/kinloom-findagrave`).
- `KINLOOM_FINDAGRAVE_CACHE_TTL_HOURS`: optional override for memorial, cemetery, and query cache TTL in hours (default `168`). No API key, login, or account is needed for anything in this skill.
