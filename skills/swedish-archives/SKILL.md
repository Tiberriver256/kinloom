---
name: swedish-archives
description: Search Sweden's National Archives (Riksarkivet) open public APIs through the bundled `se_archives.py` CLI: general archives and parish church books (Kyrkoarkiv and Husförhörslängder), HTR transcribed historical volumes, indexed birth records (Födelseregister), marriage records (Vigselregister), title deeds (Lagfartsregister), IIIF Presentation v3 collections and manifests, and verified JPEG scan downloads from `lbiiif.riksarkivet.se`. Also builds browser URLs for CAPTCHA-gated Swedish National Censuses (Folkräkningar 1860-1930) on `sok.riksarkivet.se`. Use when tracing Swedish ancestors, locating parish church books, inspecting digitized Swedish manuscripts, or downloading IIIF scans.
---

# Swedish National Archives (Riksarkivet)

This skill includes a standalone executable Python CLI at `skills/swedish-archives/scripts/se_archives.py` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependency `httpx`. No virtualenv setup, account, or API key is required.

## Bundled CLI (`scripts/se_archives.py`)

### Search archives, church books, volumes, and HTR transcripts

```bash
# Search digitized parish church books (Husförhörslängder) for Uppsala
skills/swedish-archives/scripts/se_archives.py search --text "Husförhörslängd" --place Uppsala --type volume --digitized

# Search handwritten text recognition (HTR) transcripts across digitized volumes
skills/swedish-archives/scripts/se_archives.py search --transcribed "Anders Andersson" --year-min 1840 --year-max 1860 --json

# Search parish archives (RecordSets) to locate an archive ID for IIIF browsing
skills/swedish-archives/scripts/se_archives.py search --text "Uppsala domkyrkoförsamlings kyrkoarkiv" --type archive --limit 5
```

Options: `--text`, `--name`, `--place`, `--transcribed` (automatically enables `only_digitised_materials=true`), `--type all|volume|archive|recordset|birth|marriage|deed|title-deed|map|photo|document|agent`, `--facet`, `--digitized`, `--year-min`, `--year-max`, `--sort relevance|alphaAsc|alphaDesc|timeAsc|timeDesc`, `--limit` (default `20`, max `100`), `--offset`, `--json`, `--refresh`, `--cache-ttl-hours`.

### Search indexed birth, marriage, and title deed registers

```bash
# Birth records (Födelseregister) by child name, parents, place, and year range
skills/swedish-archives/scripts/se_archives.py births --first Anders --father Andersson --year-min 1880 --year-max 1900

# Marriage records (Vigselregister) by groom, bride, parish, or county
skills/swedish-archives/scripts/se_archives.py marriages --groom "Erik Johansson" --bride "Karin Persdotter" --year-min 1830 --year-max 1870

# Title deeds index (Lagfartsregister) by parish or farm name
skills/swedish-archives/scripts/se_archives.py deeds --parish Akebäck --year-min 1800 --year-max 1850 --json

# Fetch full register detail JSON (includes archive code, volume citation, notes, and IIIF link)
skills/swedish-archives/scripts/se_archives.py record HcyoChOvigzCJOoDJWqC3 --json
```

### Browse IIIF archive collections and volume manifests

```bash
# List digitized series in a parish archive (from archive ID returned by `search`)
skills/swedish-archives/scripts/se_archives.py collection AS96bDX9rH6cxG02H087k3

# List digitized volume manifests in a series (for example, A I aa Husförhörslängder)
skills/swedish-archives/scripts/se_archives.py collection 39TJaymaweZJTe018W43t3 --json

# Inspect every page (canvas) in a digitized church book manifest
skills/swedish-archives/scripts/se_archives.py manifest 00124895 --limit 20
skills/swedish-archives/scripts/se_archives.py manifest "https://lbiiif.riksarkivet.se/arkis!80002567/manifest" --json
```

### Download verified IIIF page scans

```bash
# Download a full-resolution church-book scan by page bildid
skills/swedish-archives/scripts/se_archives.py download 00124895_00001 --full --out ./downloads/helsingborg-1894-p1.jpg

# Download a scaled preview (1200 px wide) by volume bildid and 1-based page number
skills/swedish-archives/scripts/se_archives.py download 80002567 --page 5 --width 1200 --out ./downloads/

# Download directly from a bildvisning URL or HTR page id (leading underscores are normalized)
skills/swedish-archives/scripts/se_archives.py download "https://sok.riksarkivet.se/bildvisning/00124895_00001" --width 800 --out ./downloads/p1.jpg --json
```

`download` enforces a strict `lbiiif.riksarkivet.se` download host allowlist, rejects `..` output path traversal, refuses HTML error pages, and validates JPEG/PNG/GIF/WEBP magic bytes before writing atomically.

### Swedish National Censuses (Folkräkningar 1860-1930, browser only)

```bash
# Build ready-to-open browser search URLs without making automated requests to CAPTCHA pages
skills/swedish-archives/scripts/se_archives.py census --surname Andersson --given Anders --year 1890 --parish Uppsala
```

Automated HTTP requests to `https://sok.riksarkivet.se/folkrakningar`, `/kyrkoarkiv`, `/digitala-arkiv`, and `/nad` redirect to `https://sok.riksarkivet.se/captcha`. The CLI never attempts to bypass that CAPTCHA and instead prints direct browser links.

### Disk cache and environment variables

All search, register detail, collection, and manifest subcommands cache verified JSON responses on disk under `~/.cache/kinloom/se-archives/` (default TTL `168` hours, advisory `fcntl.flock` lock per cache key, atomic writes). HTTP errors and unverified payloads are never cached.

- `--refresh`: bypass cached reads and write the fresh response to disk.
- `--cache-ttl-hours <hours>`: override cache TTL for one call (`0` disables reads).
- `KINLOOM_SE_ARCHIVES_CACHE_DIR`: override the cache directory directly.
- `KINLOOM_CACHE_DIR`: shared Kinloom cache root (stores under `<KINLOOM_CACHE_DIR>/se-archives`).
- `KINLOOM_SE_ARCHIVES_CACHE_TTL_HOURS`: override default cache TTL in hours.

## Verified interface (verified live 2026-11-26)

### Public open-access endpoints (zero auth, zero CAPTCHA)

- **Riksarkivet Search API** (`https://data.riksarkivet.se`, OpenAPI v1, CC0 1.0 Public Domain):
  - `GET /api/records`: general archive, volume, register, and HTR `transcribed_text` search (`transcribed_text` requires `only_digitised_materials=true`).
  - `GET /api/records/birthrecords`: regional birth register index (*Födelseregister*), frequently linking directly to IIIF volume manifests under `_links.image`.
  - `GET /api/records/marriagerecords`: regional marriage register index (*Vigselregister*).
  - `GET /api/records/indexoftitledeeds`: property title deeds index (*Lagfartsregister*).
  - `GET /register/<id>`: full JSON detail for any indexed register record.
- **Riksarkivet IIIF Presentation v3 and Image API** (`https://lbiiif.riksarkivet.se`):
  - `GET /collection/arkiv/<archive_id>`: IIIF Collection listing digitized series and open volume manifests for a parish archive.
  - `GET /arkis!<bildid>/manifest`: IIIF Manifest listing every digitized page (`<bildid>_00001`, dimensions, and source citations).
  - `GET /arkis!<page_id>/full/<size>/0/default.jpg`: JPEG scan download (`max` or `<width>,`).

### Restricted, partial, or browser-only datasets

- **Swedish National Censuses (`Folkräkningar` 1860-1930) and `sok.riksarkivet.se` web search:** `sok.riksarkivet.se/folkrakningar`, `/kyrkoarkiv`, and `/nad` enforce a web CAPTCHA on automated HTTP clients. Open the URL from `census` in a browser. Census years 1860-1910 and 1930 are searchable on Riksarkivet's web portal; newer population records within Sweden's 70-year privacy window remain restricted.
- **Regional coverage of `/api/records/birthrecords` and `/marriagerecords`:** These endpoints index Riksarkivet's transcribed regional registers (such as Skåne, Blekinge, Halland, Malmö, Gotland, and selected counties) rather than every parish in Sweden. For parishes outside the indexed registers, locate the parish archive with `search --type archive` and browse its digitized volumes via `collection` and `manifest`.
- **IIIF access on microfiche `C`-series volumes:** Open IIIF manifests (`00...`, `80...`, `A00...`, `R00...`, and volumes returned by `collection`) download directly with HTTP 200. Certain legacy `C`-prefixed microfiche volumes return HTTP 403 on `lbiiif.riksarkivet.se` and must be inspected in a browser at `https://sok.riksarkivet.se/bildvisning/<bildid>`.

## Swedish parish research workflow

1. Identify the ancestor's parish (*församling*) and county (*län*), then run `births` or `marriages` for indexed regions or `search --transcribed` for HTR-indexed volumes.
2. When you have a parish name, run `search --text "<parish> kyrkoarkiv" --type archive` to get the archive ID.
3. Walk the parish hierarchy with `collection <archive_id>` to find *Husförhörslängder* (`A I`, household examination rolls), *Födelse- och dopböcker* (`C`, births and baptisms), *Lysnings- och vigselböcker* (`E`, marriages), and *Död- och begravningsböcker* (`F`, deaths and burials).
4. Inspect the volume with `manifest <bildid>` and download the exact page scan with `download <page_id> --full --out <path>`.
5. Run `census` to generate browser links for *Folkräkningar* (1860-1930) to confirm household residence across census decades.
