---
name: usgs-gnis
description: Look up historical and current U.S. place names in the USGS Geographic Names Information System (GNIS) via the bundled uv-based `gnis` CLI or the GNIS Domestic Names Search web app. Covers cached per-state bulk downloads, feature-name search, feature classes, coordinates, and defunct places. Use when a deed, memoir, or obituary names a place that no longer exists, or to pin a migration path to exact coordinates.
---

# USGS GNIS (Geographic Names Information System)

This skill includes a standalone executable Python CLI at `skills/usgs-gnis/scripts/gnis` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependencies (`click`, `httpx`). No virtualenv setup or API key is required.

- **What GNIS is:** the federal repository of official geographic names for the U.S., its territories, and Antarctica: natural features, populated places, post offices, schools, cemeteries, churches, and more, current and historical.
- **Access route:** there is **no documented public GNIS search API**. The GNIS Domestic Names Search web app is a JavaScript app whose backing services use authenticated tokens. The verified machine interface is the USGS staged-products bulk download (public S3, no key): per-state pipe-delimited text files plus national topical files. The CLI downloads a state file once, caches it, and searches locally.
- **Refresh cadence:** USGS refreshes the downloadable names data every other month.

## Bundled CLI (`scripts/gnis`)

Path: `skills/usgs-gnis/scripts/gnis`

### Persistent local disk cache

Downloaded state/historical files and `search` query results are cached atomically under `~/.cache/kinloom-gnis/` (overrideable via `KINLOOM_GNIS_CACHE_DIR`, with legacy `GNIS_CACHE_DIR` fallback) using advisory file locks (`fcntl.flock` on POSIX, safe fallback elsewhere) so concurrent processes never race on downloads and repeated searches return immediately with zero HTTP requests or re-parsing. `--json` on `search` and `get` adds a boolean `cache_hit`. For `search` it is true only when the query JSON was read from disk. For `get` it is true when the state or historical table was already on disk and `--refresh` was not set.

Cache layout:

- `<STATE>.txt` and `HistoricalFeatures.txt`: extracted pipe-delimited USGS tables.
- `_queries/<sha256>.json`: cached `search` query JSON keyed by canonical parameters with a 720-hour (30-day) default TTL (`--cache-ttl-hours` or `KINLOOM_GNIS_QUERY_TTL_HOURS`). Pass `--refresh` on `search`, `get`, or `download` to bypass the cache and re-download fresh USGS data.

### Download a state file

```bash
# Cache Illinois
skills/usgs-gnis/scripts/gnis download IL

# Cache California (about 2.7 MB zipped)
skills/usgs-gnis/scripts/gnis download CA
```

Files land in `~/.cache/kinloom-gnis/<STATE>.txt` (override with `KINLOOM_GNIS_CACHE_DIR`).

### Search feature names

```bash
# Any feature in Illinois with "New Salem" in the name
skills/usgs-gnis/scripts/gnis search "New Salem" --state IL

# Exact name match, populated places only, in Sangamon County
skills/usgs-gnis/scripts/gnis search Springfield --state IL --exact --class "Populated Place" --county Sangamon

# JSON output for scripting
skills/usgs-gnis/scripts/gnis search Hannibal --state MO --json

# Defunct places (historical features file, national, downloaded on demand)
skills/usgs-gnis/scripts/gnis search "New Salem" --historical
```

Search matches on `feature_name` (substring unless `--exact`). Output gives the GNIS feature ID, name, class, county, state, decimal latitude/longitude, and map name.

### Look up one feature by ID

```bash
skills/usgs-gnis/scripts/gnis get <feature-id> --state IL
skills/usgs-gnis/scripts/gnis get <feature-id> --state MO --json
```

### Open the web search app

```bash
skills/usgs-gnis/scripts/gnis url "New Salem"
# Prints https://edits.nationalmap.gov/apps/gaz-domestic/public/search/names
# (the app has no stable query-string search URL; enter the name by hand)
```

## Website & download rules (verified live 2026-11-24)

- GNIS search app: `https://edits.nationalmap.gov/apps/gaz-domestic/public/search/names` (200, React app v2.3.1). From the app, up to 2,000 features may be downloaded to CSV. No sign-in is needed for public search.
- Downloads index: `https://www.usgs.gov/us-board-on-geographic-names/download-gnis-data`
- Per-state files: `https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/DomesticNames/DomesticNames_<ST>_Text.zip`, where `<ST>` is the two-letter state/territory code (AK, AL, ..., WY, plus AS, DC, GU, MP, PR, VI). Verified: MI zip 1,014,149 bytes, CA zip 2,695,362 bytes.
- National topical files under `StagedProducts/GeographicNames/Topical/`, including `HistoricalFeatures_National_Text.zip` (defunct features), `AllNames_National_Text.zip`, `PopulatedPlaces_National_Text.zip`, `GovernmentUnits_National_Text.zip`, `FeatureDescriptionHistory_National_Text.zip`.
- File format (verified against live state files): a zip containing one pipe-delimited `.txt` with header `feature_id|feature_name|feature_class|state_name|state_numeric|county_name|county_numeric|map_name|date_created|date_edited|bgn_type|bgn_authority|bgn_date|prim_lat_dms|prim_long_dms|prim_lat_dec|prim_long_dec|source_lat_dms|source_long_dms|source_lat_dec|source_long_dec`. Full column documentation: `https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/GNIS_file_format.pdf`.
- **Coordinates:** use `prim_lat_dec` / `prim_long_dec` (primary location). `source_*` coordinates are where the name was sourced, and can differ. Some rows carry `0.0, 0.0` for source coordinates; treat those as absent, not as a real location.
- **State files are not perfectly state-scoped:** border quads can include neighboring-state rows. Always check the `state_name` field on a hit, and filter by county.
- **No API key, no account.** The S3 downloads and the search app are public.

### What was checked and not found

- The app's JavaScript bundle (`/apps/gaz-domestic/assets/index-*.js`, ~3.8 MB) was inspected 2026-11-24: `search/names` is only a client-side route, and no public `/api` search endpoint is exposed. The app's config (`env-config.js`) shows it uses secure tokens and DOI login for editing. Do not build against undocumented app endpoints; use the bulk downloads.
- The older USGS Search API (a JavaScript location-search widget library from the Texas Water Science Center) is a web widget, not a GNIS query API, and was not used.

## Environment variables

- `KINLOOM_GNIS_CACHE_DIR`: where state text files and query results are cached (default `~/.cache/kinloom-gnis`; `GNIS_CACHE_DIR` is still accepted as a fallback).
- `KINLOOM_GNIS_QUERY_TTL_HOURS`: optional override for the `search` query cache TTL in hours (default `720`, 30 days).

## Research workflow notes

- Start from the place as written in the source (deed, memoir, obituary), then check GNIS for the current name, variant names, feature class, and county: county boundaries and names change, and the county on a hit is the modern one.
- **Civil townships vs populated places:** rural townships are indexed with the suffix `"Township"` under feature class `Civil` (not `Populated Place`). When searching for a township name, omit `--exact` and `--class "Populated Place"`, or pass `--class Civil`.
- Defunct post offices and railroad stops usually appear as `Post Office` / `Locale` / historical features; if a state-file search comes up empty, retry with `--historical`.
- Record the GNIS `feature_id` alongside any place you cite in `data/`: it is the stable identifier when names collide (there are many repeated place names across states).
- Coordinates from GNIS place a feature, not a parcel. For the parcel itself, pair the GNIS hit with the BLM GLO patent's township/range/section (see the `blm-glo` skill).
