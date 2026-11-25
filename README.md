<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/wordmark-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="brand/wordmark-light.svg" />
    <img src="brand/wordmark-light.svg" width="220" alt="Kinloom" />
  </picture>
</p>

<p align="center">
  <strong>Weave primary sources, places, and family memory into one living archive.</strong>
</p>

Kinloom is an open-source MIT framework for private, collaborative family history wikis grounded in primary archival records. Families explore people, places, timelines, maps, kinship graphs, and primary source transcriptions inside one web application while editing records with append-only revision history, optimistic conflict resolution, and one-click revert.

## Live public demo

Browse the live demo archive at [https://tiberriver256.github.io/kinloom/](https://tiberriver256.github.io/kinloom/).

The demo publishes a 54-person, 10-generation public-domain archive (1622–1985) covering the Lincoln, Todd, Hanks, and Harlan branches across Massachusetts, New Jersey, Pennsylvania, Virginia, Kentucky, Indiana, Illinois, Iowa, Washington, D.C., and Vermont. It includes 35 verified public-domain photographs and NARA record scans, plus one synthetic living test fixture that verifies public redaction.

## Quickstart

Launch a family archive in three commands:

```bash
# 1. Scaffold kinloom.config.yaml, starter YAML records, and Wrangler config
npx kinloom init my-family-archive --family-name "Alder Family" --title "Alder Family Archive"

# 2. Seed the archive database from YAML (or slice an existing GEDCOM first with `npx kinloom slice-gedcom`)
npx kinloom seed --site https://archive.example.org --token "$KINLOOM_AGENT_TOKEN" --data ./data

# 3. Deploy the Cloudflare Worker and static SPA bundle
npx wrangler deploy
```

## Backend modularity seam

Kinloom separates the React explorer (`<KinloomApp />`) from storage and hosting through two clean boundaries:

```text
<KinloomApp />
   │
   ├── StaticDemoDataSource ──────────► Static JSON files (GitHub Pages / local preview)
   │     (reports canEdit: false, hasRevisionHistory: false, hasTalk: false)
   │
   └── HttpWikiDataSource ────────────► @kinloom/server (portable Web-Fetch HTTP router)
         (reports live role capabilities)    │
                                             ├── @kinloom/worker (Cloudflare D1 + R2)
                                             ├── InMemory adapters (local tests / CI)
                                             └── Custom Node, Postgres, or S3 adapters
```

- **Capability-driven UI:** `<KinloomApp />` has no demo-mode switches. `StaticDemoDataSource.getSession()` reports an anonymous session with all write, history, talk, upload, and admin capabilities set to `false`. `HttpWikiDataSource.getSession()` reads `/api/auth/me` from the live server and unlocks Edit, History, Talk, Media Upload, Recent Changes, and Admin surfaces from those capabilities.
- **Zero-Cloudflare server core:** `@kinloom/server` depends only on Web-Standard Fetch and WebCrypto primitives (`Request`, `Response`, `crypto.subtle`). `@kinloom/worker` binds `@kinloom/server` to Cloudflare D1 and R2, while tests or self-hosted deployments can swap in any adapter implementing `ArchiveRepository`, `BundleCache`, `MediaStore`, `EmailSender`, and `AuthProvider`.
- **Incremental bundle patching:** Every live write patches the compiled `ArchiveBundle` in place with `patchCompiledBundle()` in `@kinloom/core` instead of recompiling the entire archive from scratch.

## Architecture and packages

Kinloom ships six npm workspaces, a public-domain demo app, and 19 standalone research skills:

| Package | Role | Key capabilities |
| --- | --- | --- |
| `@kinloom/tokens` | Design tokens | Paper & Ink DTCG color and typography tokens (`Newsreader` + `IBM Plex Mono`) verified to WCAG 2.2 AA and AAA via `npm run check:contrast`. |
| `@kinloom/core` | Domain engine | Typed Zod schemas, EDTF date parser, residence-span derivation, living-person privacy filter, GEDCOM 7 import/export, YAML serialization, revision diffs/reverts, and incremental `patchCompiledBundle()`. |
| `@kinloom/server` | Portable backend | Zero-Cloudflare Web-Fetch HTTP router, auth/invite/magic-link services, optimistic concurrency (`409 Conflict`), append-only revision ledger, HTTP `206 Partial Content` byte-range media streaming, `KinloomServerPlugin`, and `InMemory` test adapters. |
| `@kinloom/worker` | Cloudflare runtime | Thin adapter binding `@kinloom/server` to Cloudflare Workers, D1 SQLite migrations, R2 content-addressed media storage, and R2 incremental bundle caching. |
| `@kinloom/ui` | React 19 explorer & wiki | White-labeled People, Places, Time, Tree, Map, Kinship, and Evidence views; inline editors with `Cited` and `Family memory` badges; `409 Conflict` merge dialog; visual diffs; one-click Revert and Batch Revert; Talk threads; Media Uploader; HTML5 `<video>`/`<audio>` player; and `KinloomUiPlugin`. |
| `@kinloom/cli` | Operator & agent CLI | `kinloom init`, `kinloom seed`, `kinloom slice-gedcom`, `kinloom submit-batch`, and `kinloom export-yaml` for operators, AI research agents, and scheduled Git backups. |

## Typed plugin seam and rich media

Private sites extend Kinloom without forking core packages:

- **`KinloomUiPlugin` (`@kinloom/ui`):** Register custom routes and top-bar links, inject React panels into named page slots (`indexHero`, `personDetail`, `placeDetail`, `sourceReaderFooter`, `evidenceExtra`), or provide custom `mediaRenderers`.
- **`KinloomServerPlugin` (`@kinloom/server`):** Mount authenticated custom API routes that inherit session, RBAC, and CSRF enforcement, or subscribe to `onRevisionCommitted` hooks.
- **Byte-range video and oral histories:** `MediaService` validates and stores images, PDFs, MP4/WebM videos, and audio oral histories under content-addressed SHA-256 keys, streaming `GET /media/:key` with HTTP `206 Partial Content` and `Content-Range` headers for scrubbable `<video>` and `<audio>` playback.

## Bundled genealogy research skills

The `skills/` directory bundles 20 standalone `uv`-based archival research CLIs for both human researchers and AI agents:

`acpl-persi`, `archive-org`, `blm-glo`, `california-archives`, `chronicling-america`, `cyndis-list`, `findagrave`, `hathitrust`, `kentucky-archives`, `library-of-michigan`, `missouri-archives`, `nara-catalog-search`, `narrative-audio`, `new-jersey-archives`, `openarchieven`, `texas-archives`, `uk-archives`, `usgs-gnis`, `virginia-archives`, and `wikitree`.

Agents submit structured multi-entity discoveries through `POST /api/batches` with scoped `write_batch` bearer tokens. Every agent wave appears in `/changes` with a `Research agent` badge and supports one-click reverse-order Batch Revert.

## Living-person privacy policy

Kinloom enforces living-person privacy in both `@kinloom/core` and `@kinloom/server`:

- Any person marked `is_living: true` (or with no death date and a birth year inside the configured living-cutoff window, 101 years by default) has portraits, exact birth dates, street addresses, and residence spans stripped at write and compile time.
- Public builds redact living individuals completely from people lists, narratives, event summaries, and GEDCOM 7 exports.
- Attempting to upload or attach a portrait or photo to a living person is blocked in the uploader UI and rejected by the server with HTTP `422` (`LIVING_MEDIA_FORBIDDEN`) before any file bytes are written to object storage.

## Development and verification

```bash
npm ci
npm run check      # lint, build all 6 workspaces, typecheck, Vitest, WCAG contrast, leak check
npm run test:e2e   # Chromium Playwright suite covering static demo and live wiki flows
```

## License

MIT. See [LICENSE](LICENSE).
