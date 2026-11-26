---
name: finnish-archives
description: Search Finnish historical and genealogical records via the bundled `fi_archives.py` CLI. Covers open public HisKi parish register transcriptions (baptisms, marriages, burials, and parish moves across 560+ Finnish parishes from the Genealogical Society of Finland) and Digihakemisto's index to National Archives of Finland (Kansallisarkisto / Astia) church books, tax/population registers (henkikirjat), court books (tuomiokirjat), and estate inventories (perukirjat). Also builds browser URLs for Cloudflare-gated Finna (`www.finna.fi`), Astia, National Library Digi newspapers, and SSHY. Use when tracing Finnish ancestors (17th-19th century), finding parish codes, inspecting church book entries, or locating digitized National Archives volumes.
---

# Finnish Archives (HisKi & National Archives / Digihakemisto)

This skill includes a standalone executable Python CLI invoked as `kinloom fi-archives` using a PEP 723 `#!/usr/bin/env -S uv run --script` shebang with inline dependency `httpx`. No virtualenv setup, account, or API key is required.

## Bundled CLI (`scripts/fi_archives.py`)

### List and resolve Finnish parishes (HisKi)

```bash
# Find 4-digit HisKi parish codes by Finnish or Swedish name
kinloom fi-archives parishes --query Turku --json
kinloom fi-archives parishes --query Ahlainen
```

### Search HisKi parish registers (baptisms, marriages, burials, moves)

```bash
# Search christenings in one parish by 4-digit code or parish name
kinloom fi-archives hiski --parish 0001 --book christened \
  --given Johan --from-year 1750 --to-year 1760 --limit 15

# Nationwide search across all parishes (`--parish "*"`) by surname and year window
kinloom fi-archives hiski --parish "*" --book christened \
  --surname Korhonen --from-year 1800 --to-year 1805 --limit 20 --json

# Search burials or marriages in a named parish
kinloom fi-archives hiski --parish Ahlainen --book buried \
  --given Anders --from-year 1750 --to-year 1770
```

Options: `--book` (`christened`/`births`, `married`/`marriages`, `buried`/`burials`, `moved-in`, `moved-out`, `all`), `--parish` (4-digit code, parish name, comma-separated codes, or `*` for all parishes), `--surname`, `--given`, `--father-given`, `--father-patronymic`, `--mother-given`, `--mother-surname`, `--village`, `--from-year`, `--to-year`, `--limit` (`1`-`1000`), `--json` (returns top-level boolean `cache_hit`), `--refresh`, `--cache-ttl-hours`.

### Inspect one HisKi event detail page

```bash
# Fetch full transcribed fields plus the SSHY Digiarkisto scan link
kinloom fi-archives event 0001/kastetut/418 --json
kinloom fi-archives event "https://hiski.genealogia.fi/hiski?en+0001+kastetut+418"
```

### Search National Archives of Finland (Astia) via Digihakemisto

```bash
# Search parish archives (supports * wildcards)
kinloom fi-archives archives "Turun seurakun*" --limit 15 --json

# Search provincial population/tax registers (henkikirjat) or built-in presets
kinloom fi-archives archives --preset henkikirjat --digitized --limit 20

# Inspect an archive's series and digitized volumes (with Astia links)
kinloom fi-archives archive 1299923671 --json
```

Built-in presets for `archives --preset`: `parishes`, `henkikirjat`, `tax`, `court`, `inventories`, and `say` (Suomen asutuksen yleisluettelo general settlement register).

### Offline browser URL builders

```bash
# Build browser links for Finna (Cloudflare-gated for automated HTTP), Astia, Digi, and SSHY
kinloom fi-archives url --finna "Turku kirkonkirjat"
kinloom fi-archives url --digi "Turku 1850"
kinloom fi-archives url --astia --sshy
```

## Verified endpoints (verified live 2026-11-26)

### Open public endpoints (zero auth, zero CAPTCHA)

- **HisKi (`https://hiski.genealogia.fi/hiski`)**:
  - `GET /hiski?en+A00`: HTTP 200 ISO-8859-1 HTML listing 539 Finnish parishes with 4-digit codes.
  - `POST /hiski` (`komento=haku`): HTTP 200 structured HTML tables for single-parish, multi-parish (`0001,0325`), and nationwide (`*`) searches across baptisms (`kastetut`), marriages (`vihityt`), burials (`haudatut`), and moves (`smuutt`, `umuutt`).
  - `GET /hiski?en+<parish>+<book>+<row_id>`: HTTP 200 full event transcription including an SSHY Digiarkisto scan link. (Note: HisKi short `t<id>` permalink URLs trigger a JavaScript challenge, so the CLI queries the direct `<parish>+<book>+<row_id>` URL instead and never solves challenges.)
- **Digihakemisto (`https://digihakemisto.net`)**:
  - `POST /haku`: HTTP 200 HTML searching National Archives of Finland (Astia) archive collections (parish church books, *henkikirjat*, *tuomiokirjat*, *perukirjat*, and SAY).
  - `GET /aineisto/<id>`: HTTP 200 HTML listing child series, volumes, digitization status, and direct Astia links (`https://astia.narc.fi/uusiastia/kortti_aineisto.html?id=<id>`).

### Browser-only or challenged portals (never bypassed)

- **Finna REST API (`https://api.finna.fi/v1/search`, `/v1/record`, `/oai/Server`) and `https://www.finna.fi/`**: Returned HTTP `403` with `Cf-Mitigated: challenge` (Cloudflare managed challenge) in live probes on 2026-11-26. Use `url --finna <query>` and open in a browser.
- **National Archives Astia image viewer (`astia.narc.fi`) and SSHY (`sukuhistoria.fi`)**: Inspect original digitized communion book (*rippikirjat*) and vital register scans in a browser via the Astia and SSHY links returned by `archive` and `event`.

## Disk cache and safety guarantees

All `parishes`, `hiski`, `event`, `archives`, and `archive` commands cache verified responses on disk under `~/.cache/kinloom/fi-archives/` (default TTL `168` hours, per-key `fcntl.flock` lock, atomic writes). HTTP errors, JavaScript/Cloudflare challenges, and invalid responses are never cached.

- `--refresh`: bypass cached reads and write the fresh response to disk.
- `--cache-ttl-hours <hours>`: override cache TTL for one call (`0` disables reads).
- `KINLOOM_FI_ARCHIVES_CACHE_DIR`: override the cache directory directly.
- `KINLOOM_CACHE_DIR`: shared Kinloom cache root (stores under `<KINLOOM_CACHE_DIR>/fi-archives`).
- `KINLOOM_FI_ARCHIVES_CACHE_TTL_HOURS`: override default cache TTL in hours.
- Strict HTTPS host allowlists (`hiski.genealogia.fi`, `digihakemisto.net`) are verified before and after redirects, and transient `429`/`5xx`/network errors retry with `Retry-After` backoff.

## Finnish genealogical research workflow

1. Remember that western Finnish rural records before ~1880 often use **patronymics** (`Anders Johansson`, `Maria Eskilsdotter`) and **farm names** rather than fixed hereditary surnames, while eastern Finland (Savo/Karelia) used hereditary surnames (`Korhonen`, `Laine`) centuries earlier.
2. Search `parishes --query <name>` to confirm the 4-digit HisKi code (Finnish and Swedish parish names are both indexed, for example `Alatornio - Nedertorneå`).
3. Search `hiski` across christenings, marriages, and burials, then run `event` to capture the full transcription and SSHY Digiarkisto scan link.
4. Use `archives` and `archive` to locate the parish's digitized *rippikirjat* (communion/household books) and provincial *henkikirjat* (tax/population rolls) in Astia so you can verify every transcribed entry against the original register scan.

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
