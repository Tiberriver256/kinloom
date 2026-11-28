# Kinloom architecture

**Diataxis mode:** Explanation and reference.

Kinloom separates archival domain rules, portable HTTP transport, Cloudflare infrastructure bindings, React presentation, and CLI tooling into six lockstep npm workspaces plus one public-domain demo application. This document explains the package dependency graph, hexagonal ports, incremental bundle patching, UI architecture, living-person privacy boundary, and automated CI invariants enforced at `v0.62.0`.

## Monorepo package DAG

Every workspace package in `packages/` publishes on a single lockstep version (`0.62.0` at this commit). Dependencies flow strictly downward with zero cycles.

```text
@kinloom/tokens  (CSS custom properties & DTCG tokens; zero runtime dependencies)
       ▲
       │
  @kinloom/ui ──────────────────────────┐
       ▲                                │
       │                                ▼
  examples/demo                   @kinloom/core  (schemas, EDTF, privacy, compiler, patcher, ports)
                                     ▲     ▲     ▲
                                     │     │     │
                        @kinloom/server ◄──┴─────┘
                          ▲         ▲
                          │         │
                 @kinloom/worker  @kinloom/cli
```

| Workspace | Direct `@kinloom/*` dependencies | Runtime environment | Ownership |
| --- | --- | --- | --- |
| `@kinloom/tokens` | None | CSS and JSON | DTCG light and dark Paper & Ink tokens in `packages/tokens/tokens.json` and `packages/tokens/kinloom.css`. |
| `@kinloom/core` | None | Pure TypeScript (Browser, Node, Workers) | Zod schemas, EDTF parser, residence spans, living-person privacy redaction, GEDCOM 7 import/export, YAML serialization, archive compiler, incremental `patchCompiledBundle()`, and port interfaces (`packages/core/src/contracts.ts`). |
| `@kinloom/server` | `@kinloom/core` | Web-Standard Fetch & WebCrypto | HTTP router, session cookies, CSRF origin guard, RBAC middleware, optimistic concurrency, append-only revision ledger, byte-range media streaming, `KinloomServerPlugin`, built-in opt-in plugins, and `InMemory` test adapters. |
| `@kinloom/worker` | `@kinloom/core`, `@kinloom/server` | Cloudflare Workers | Thin entrypoint `createCloudflareWorker()` plus Cloudflare D1, R2, Email Service, Gemini TTS, and ASSETS adapters and SQL migrations (`packages/worker/migrations/`). |
| `@kinloom/ui` | `@kinloom/core`, `@kinloom/tokens` | React 19 + browser DOM | Archival explorer pages, wiki editors, XState v5 actors, pure view models, `ArchivalLayout` and `ArchivalPrimitives`, `<ArchivalImage>`, `<PersonPortrait>`, and `KinloomUiPlugin`. |
| `@kinloom/cli` | `@kinloom/core`, `@kinloom/server` | Node.js 24+ | Pure TypeScript operator CLI (`init`, `seed`, `sync`, `migrate`, `reconcile`, `verify`, `audit`, `screenshots`), 23 archival research and scan-prep commands, 26 embedded guides, and `KinloomCliPlugin`. |
| `examples/demo` | `@kinloom/core`, `@kinloom/ui` | Vite static SPA | Public-domain 54-person Lincoln and Todd historical archive deployed to GitHub Pages. |

### Why `@kinloom/server` has zero Cloudflare imports

`@kinloom/server` relies only on standard `Request`, `Response`, `Headers`, `URL`, `ReadableStream`, and `crypto.subtle`. That boundary gives you two direct benefits. First, the entire HTTP API, RBAC matrix, CSRF check, and plugin contract suite run in milliseconds inside Node.js using `InMemory` adapters. Second, self-hosted deployments can swap Cloudflare D1 and R2 for Postgres, SQLite, S3, or custom auth providers without modifying core services.

## Hexagonal ports and adapters

Core services under `packages/server/src/services/` depend only on interfaces declared in `packages/core/src/contracts.ts` (and `PageVisitStatsStore` in `packages/server/src/plugins/pageVisitStatsTypes.ts`). Concrete storage and network integrations live in `packages/server/src/adapters/` (portable and in-memory) and `packages/worker/src/adapters/` (Cloudflare).

### Server ports

| Port interface | Composed or primary responsibility | In-memory adapter (`@kinloom/server`) | Cloudflare adapter (`@kinloom/worker`) |
| --- | --- | --- | --- |
| `ArchiveRepository` | Composes `EntityReadStore`, `AtomicMutationStore`, `RevisionLogStore`, `TalkCommentStore`, and `AccessControlStore`. | `createInMemoryArchiveRepository` / `InMemoryArchiveRepository` | `createD1ArchiveRepository` / `D1ArchiveRepository` |
| `BundleCache` | Serves conditional `ETag` archive bundles and applies incremental mutation patches. | `InMemoryIncrementalBundleCache` | `R2IncrementalPatchBundleCache` |
| `MediaStore` | Stores and streams content-addressed SHA-256 media with HTTP `206` byte ranges. | `InMemoryMediaStore` | `R2MediaStore` |
| `EmailSender` | Sends magic-link sign-in emails (`sendMagicLink`). | `InMemoryEmailSender` | `CloudflareEmailSender` |
| `AuthProvider` | Builds PKCE OAuth authorization URLs and exchanges callback codes. | `FakeAuthProvider` | `GoogleOAuthProvider` (from `@kinloom/server`) |
| `Clock` | Provides deterministic timestamps (`nowIso()`, `nowMs()`). | `FixedClock` | `SystemClock` (from `@kinloom/server`) |
| `AssetHandler` | Serves static SPA assets and `/data/*` fallback responses. | Optional custom stub | `createCloudflareAssetHandler` |
| `PluginSettingsStore` | Separates non-secret `plugin_settings` values from write-only `plugin_setting_secrets`. | `InMemoryPluginSettingsStore` | `D1PluginSettingsStore` |
| `PluginDatabaseFactory` | Creates namespace-scoped `PluginDatabasePort` instances (`plugin_<namespace>_*`). | Test SQLite/mock factory | `D1PluginDatabaseFactory` |
| `PronunciationAudioGenerator` | Synthesizes pronunciation clips from text, IPA, or phonetic spelling. | Optional stub | `GeminiPronunciationAudioGenerator` |
| `PronunciationLexiconStore` | Persists archive pronunciation overrides (`pronunciation_lexicon`). | `InMemoryPronunciationLexiconStore` | `D1PronunciationLexiconStore` |
| `PageVisitStatsStore` | Stores privacy-preserving daily visit and cache aggregates. | `InMemoryPageVisitStatsStore` | `D1PageVisitStatsStore` |

### UI data ports

The UI layer never imports concrete HTTP or static-file adapters inside `machines/`, `components/`, or `pages/`. Instead, it reads through three contracts:

- `ArchiveDataSource` (`@kinloom/core`): Loads the compiled `ArchiveBundle`, session capabilities, entity writes, revision history, talk comments, media uploads, and pronunciations.
- `AdminDataSource` (`@kinloom/core`): Manages users, invites, agent tokens, plugin settings, and system diagnostics.
- `PluginApiClient` (`@kinloom/ui`): Provides CSRF-safe `requestJson`, `uploadMultipart`, `deleteNoContent`, and `resolveUrl` helpers for UI plugins without violating the `no-raw-ui-api-fetch` invariant.

## Incremental bundle patching and optimistic concurrency

Every write to a person, event, place, source, media item, kinship edge, or narrative passes through `WikiWriteService` in `packages/server/src/services/wikiWriteService.ts`.

1. **Prefetch and privacy sanitization.** The service loads the current entity state and living-person set, validates the Zod payload, and strips disallowed living-person fields (`sanitizePersonForWrite`, `sanitizeEventForWrite`).
2. **Optimistic concurrency check.** Updates and deletes carry `expected_parent_revision_id`. If the stored entity revision does not match, `AtomicMutationStore.commitAtomicMutations` rejects the write with HTTP `409` (`OptimisticConflictError`) and returns the latest server record so the UI can open `ConflictMergeDialog`.
3. **Append-only revision ledger.** Accepted mutations commit atomically to the `entities` and `revisions` tables (with an optional `batch_id` for multi-entity agent batches that support one-click reverse-order revert).
4. **Incremental bundle patch.** Instead of recompiling the entire archive from D1 on every write, `BundleCache.applyMutationsAndStore` (and `tryApplyMutationsFromMemo`) calls `patchCompiledBundle()` in `packages/core/src/patchArchive.ts`. The patcher clones only affected structures in `O(affected_people)` time and reconciles five derived slices in order:
   - `reconcileNewlyLivingEntities`
   - `reconcileAffectedMedia`
   - `reconcilePlaceAncestorsAndSpans`
   - `reconcilePersonAndEventDerivedStats`
   - `reconcileResidenceSpans`
5. **Post-commit plugin notification.** After the revision commits, `WikiWriteService` invokes each registered server plugin's `onRevisionCommitted({ revisions, headRevisionId })` hook inside fault-isolated error handling (`onPluginError`).

## UI architecture and XState v5

### Capability-driven shell

`<KinloomApp />` has no demo-mode boolean flags. `StaticDemoDataSource.getSession()` reports an anonymous session where every write, history, talk, upload, and admin capability is `false`. `HttpWikiDataSource.getSession()` calls `/api/auth/me` and enables Edit, Create, History, Talk, Media Upload, Recent Changes, and Admin screens strictly from the returned `ArchiveCapabilities` object.

### Pure view models and XState v5 actors

Complex display logic lives in pure TypeScript modules under `packages/ui/src/lib/` (such as `archivalTreeModel.ts`, `pluginNav.ts`, `pluginSettingsForm.ts`, `themeModel.ts`, and `adminDiagnostics.ts`). CI verifies that none of these modules import React, MapLibre, or browser globals.

Stateful asynchronous UI flows run as explicit XState v5 actors exported from `packages/ui/src/machines/index.ts`:

- `authSessionMachine` (`AuthSessionActorContext`): Hydrates `/api/auth/me`, handles Google OAuth and magic-link callback errors, and transitions cleanly across sign-in, invite redemption, and sign-out states.
- `entityEditorMachine` (aliased as `wikiEditorMachine`): Drives entity edit, save, delete, `409 Conflict` detection, reload-latest, and merge resolution.
- `mediaUploadMachine`: Coordinates client-side SHA-256 hashing (`defaultHashFileSha256`), file upload (`defaultUploadMediaActor`), and entity attachment (`defaultAttachMediaActor`).

### Archival media components (`<ArchivalImage>` and `<PersonPortrait>`)

All archive photography and person avatars render through two deterministic media components in `packages/ui/src/components/Atoms.tsx`:

- `<ArchivalImage>`: Tracks image state through the discriminated union `ArchivalImageStatus` (`empty | loading | loaded | error`), resolves relative paths against `baseUrl`, never combines `fetchPriority="high"` with `loading="lazy"` (automatically promoting high-priority images to `loading="eager"`), and replaces empty or failed URLs with an accessible archival plate fallback instead of a broken-image icon.
- `<PersonPortrait>`: Wraps `useArchivalImageStatus` with two variants (`print` and `circle`) and five sizes (`xs`, `sm`, `md`, `card`, `lg`). It renders an archival monogram (`initialsOf(name)`) beneath the image frame so missing or failed portraits degrade cleanly without layout shift.

### Intrinsic CSS layout primitives and `ArchivalLayout`

To prevent brittle viewport breakpoints and style duplication across pages and plugins, `@kinloom/ui` exposes three layers of layout building blocks:

1. **Intrinsic CSS classes in `packages/ui/src/styles/base.css`.** `.kl-stack` (vertical flow spaced by `--kl-space`), `.kl-cluster` (wrapping inline flex row spaced by `--kl-space`), and `.kl-switcher` (flexbox threshold switcher controlled by `--kl-threshold`, default `30rem`, that switches from row to column without media queries).
2. **Page layout shells in `packages/ui/src/components/ArchivalLayout.tsx`.** `ArchivalPageShell` (`variant="standard"` 1100px reading measure or `variant="wide"` 1180px index folio), `ArchivalBanner`, `ArchivalMetrics`, `ArchivalSection`, `ArchivalMediaGrid`, and `ArchivalStoryCard`.
3. **Interactive primitives in `packages/ui/src/components/ArchivalPrimitives.tsx`.** `ArchivalCardGrid` (`repeat(auto-fill, minmax(min(270px, 100%), 1fr))`), `ArchivalFilterBar`, keyboard-navigable `ArchivalTabs`, `ArchivalTagPill`, live-region `ArchivalToast`, `ArchivalEmptyState`, and focus-trapped `<dialog>` components `ArchivalModal` and `ArchivalDrawer`.

### AAA archival dark mode tokens

`@kinloom/tokens` defines both light (`color.semantic`) and dark (`color.semanticDark`) Paper & Ink palettes in `packages/tokens/tokens.json` and mirrors them in `packages/tokens/kinloom.css` across three CSS rule blocks:

- `:root` for the default Cotton Rag (`#F5EFE2`) light palette.
- `@media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { ... } }` for automatic dark mode on the Warm Slate (`#171614`) canvas.
- `:root[data-theme='dark']` for explicit dark theme overrides managed by `useThemePreference` and `packages/ui/src/lib/themeModel.ts` (`localStorage` key `kinloom-theme`, supporting `'system' | 'light' | 'dark'`).

`npm run check:contrast` (`scripts/check-contrast.mjs`) runs 48 WCAG 2.2 contrast assertions (24 light pairs and 24 dark pairs, requiring `7.0:1` AAA on primary text, secondary metadata, headers, badges, diffs, and conflict states, `4.5:1` AA on `--accent-primary` over `--surface-canvas`, and `3.0:1` on `--border-control`) plus byte-exact hex parity between `tokens.json` and all three CSS blocks in `kinloom.css`. See [DESIGN.md](../../DESIGN.md) for the full palette and typography specification.

## Living-person privacy boundary

Living-person privacy is enforced across three layers so private details never depend on UI-only hiding:

1. **Deterministic clock rule (`packages/core/src/privacy.ts`).** Every privacy evaluation takes an explicit `referenceYear` rather than calling ambient `new Date()`. A person is classified as living when `is_living: true` or when they have no death date and their birth year falls within `privacy.livingCutoffYears` (default `101`) of `referenceYear`.
2. **Write-time and compile-time redaction.** `WikiWriteService` sanitizes incoming living-person records before persistence, and `MediaService` rejects portrait or photo attachments to living people with HTTP `422` (`LIVING_MEDIA_FORBIDDEN`) before writing bytes to `MediaStore`. In `public` mode, `applyPrivacyFilter` and `compileLivingNameMatcher` strip living individuals, residence spans, portraits, and living-name mentions across narratives, events, and GEDCOM 7 exports.
3. **Deceased-only plugin helpers.** `useKinloomPluginContext()` exposes `getDeceasedPersonById` and `searchDeceasedPeople`, which filter out every record where `person.is_living` is `true` or `person.full_name === 'Living'`. The `personRelated` UI slot renders strictly on deceased person profiles.

## Automated architecture invariants

`npm run check:arch` runs `scripts/check-architecture.mjs` over every non-test `.ts` and `.tsx` file under `packages/` and `examples/demo/src/`. Any violation fails CI with `file:line` diagnostics.

| # | Invariant | Enforced rule IDs | What it prevents |
| --- | --- | --- | --- |
| 1 | Zero circular imports (Tarjan SCC) | `no-circular-imports-runtime`, `no-circular-imports-type-inclusive`, `no-circular-imports-dynamic` | Runtime, `import type`, and `import()` dependency cycles across `packages/**`. |
| 2 | Zero reverse-layer imports | `no-reverse-layer-server`, `no-reverse-layer-ui-css`, `no-peer-ops-imports`, `no-reverse-layer-core`, `no-reverse-layer-server-pkg`, `no-ui-adapter-leak`, `no-cross-page-css-import`, `no-atom-drawer-css-import` | Server services importing adapters; core depending on server/worker/ui/cli/oxlint; server depending on worker/ui/cli; UI machines/components/pages importing adapters; peer CLI ops commands importing each other; UI components, `KinloomApp`, atoms, or pages importing another page or drawer CSS module. |
| 3 | Pure UI lib and view models | `pure-ui-model-imports`, `pure-ui-model-globals` | `packages/ui/src/lib/**` or `*ViewModel.ts` importing `react`, `react-dom`, or `maplibre-gl`, or referencing `window`, `document`, `navigator`, or `fetch`. |
| 4 | UI boundary discipline | `no-instanceof-http-datasource`, `no-css-module-spread`, `no-raw-ui-api-fetch` | `instanceof HttpWikiDataSource` checks; `{ ...aStyles, ...bStyles }` CSS module spreads; raw `fetch` or `navigator.sendBeacon` calls targeting `api/` outside `packages/ui/src/adapters/**`. |
| 5 | Zero type or lint escape hatches | `no-as-unknown-as`, `no-explicit-any`, `no-ts-ignore`, `no-ts-expect-error`, `no-ts-nocheck`, `no-eslint-disable` | Unsafe type casts, explicit `any`, and compiler/linter suppression comments in source files. |
| 6 | Lazy CLI record registry | `lazy-record-registry` | Eager static `.js` client imports in `packages/cli/src/commands/records/registry.ts` (record clients must use dynamic `import()`). |
| 7 | Deterministic privacy clock | `no-ambient-date-in-privacy` | Ambient `new Date()` calls inside `packages/core/src/privacy.ts` or `packages/core/src/privacy/**`. |

## Local development, quality gates, and coverage norms

Kinloom targets Node.js `24+` and uses Biome for formatting and linting, Vitest for unit and contract tests, and Playwright for end-to-end and Core Web Vitals checks.

### Verification commands

```bash
npm ci                                        # Install exact lockfile dependencies
npm run check                                 # Full CI gate: arch, lint, build, typecheck, test, contrast, leaks, docs
npm run check:docs                            # Relative link/anchor check and synthetic-domain privacy guard
node scripts/check-docs.mjs --typecheck-snippets  # Compile ts/tsx kinloom-check snippets against workspace builds
npm run test:coverage                         # Enforce >= 90% V8 coverage thresholds
npm run test:e2e                              # Chromium Playwright suite for static demo and live wiki flows
npm run test:cwv                              # Core Web Vitals budget assertions against the demo build
npm run format                                # Format modified files with Biome
```

### Vitest projects and `>= 90%` V8 coverage thresholds

`vitest.config.ts` splits the test suite into three projects: `node` (core, server, worker, cli, pure UI `.test.ts`, and `scripts/**/*.test.ts`), `ui-jsdom` (fast shared-thread jsdom tests), and `ui-jsdom-isolated` (isolated jsdom suites that mock MapLibre).

Global V8 coverage requires at least `90%` lines, statements, functions, and branches. Per-package thresholds in `vitest.config.ts` enforce `>= 90%` lines, statements, and functions across all five TypeScript packages, plus `>= 90%` branch coverage on `@kinloom/core` and `@kinloom/cli`.

### Canonical vocabulary

Use the terms defined in [docs/ubiquitous-language.md](../ubiquitous-language.md) across all reader copy, CLI help text, and documentation (for example, **Person Profile** instead of "dossier", **Family Tree** instead of "2D Tree", and **Direct Line** instead of "Direct Spine").
