# Kinloom Architecture Scorecard

Tracking document for GitHub Issue #17 (`Decompose 1.5K+ LOC monoliths and iterate to 10/10 across decoupling, cohesion, data flow, layering, modularity, and extensibility`).

Evaluation date: `2026-11-27` (measured via Python `datetime.now(timezone.utc)`).

## Scoring Rubric (1-10)

| Axis | Definition |
| --- | --- |
| **Decoupling** | Modules depend on narrow ports and minimal inputs so changes in one bounded context do not ripple across unrelated code. |
| **Cohesion** | Each module owns one clear domain concept rather than mixing schemas, policy, transport, and storage in one file. |
| **Data flow** | Inputs cross validated boundaries once and flow through explicit, deterministic pipelines without duplicated state transitions. |
| **Layering** | Strict hexagonal separation across `@kinloom/core` (pure domain), `@kinloom/server` (ports, services, HTTP), `@kinloom/worker` (Cloudflare adapters), and `@kinloom/ui` (pure view models vs. React views). |
| **Modularity** | Deep modules hide real algorithmic, SQL, or routing complexity behind small public interfaces with zero unjustified 1,000+ LOC god-modules. |
| **Extensibility** | Adding a new route domain, persistence capability, pronunciation rule, or tree projection requires adding a small module rather than editing a multi-hundred-line switch or `if`-ladder. |

## Baseline Evaluation (Pre-Iteration 1)

Measured prior to Iteration 1 at commit `677200a`:

| Target Area | File | Baseline LOC | Primary Architectural Bottlenecks |
| --- | --- | ---: | --- |
| Core schemas & pronunciation | `packages/core/src/schemas/entities.ts` | 1,354 | Embedded 919 LOC of pronunciation lexicon resolution and geographic/language lookup tables inside the core entity Zod schema file. |
| Server write orchestration | `packages/server/src/services/wikiWriteService.ts` | 1,445 | Combined payload validation/privacy policy, TTS generation, batch working-set simulation, conflict formatting, cache patching, and plugin notification in one class with duplicated commit/conflict sequences. |
| Server HTTP routing | `packages/server/src/http/router.ts` | 1,325 | Single 930-line `handleRequest()` function dispatching 8 unrelated HTTP domains inline alongside Zod request schemas and browser auth redirect helpers. (`packages/worker/src/index.ts` was already a thin 312 LOC Cloudflare adapter shell with no separate `worker/src/router.ts`.) |
| Worker D1 persistence | `packages/worker/src/adapters/d1Repository.ts` | 1,530 | Single class owning D1 statement caching, 2 MB JSON chunking, 8 SQLite row mappers, snapshot/revision reads, set-based atomic `DB.batch()` SQL generation, conflict forensics, and 5 auth/talk tables. |
| UI tree view-model | `packages/ui/src/lib/archivalTreeModel.ts` | 1,879 | Packed types/constants/formatters, fixed-point generation inference, couple/union graph construction, 4-sweep barycenter 2D orthogonal layout, lineage spotlight DFS, and fuzzy person search into one file. |
| Remaining monoliths (deferred to Iteration 2) | `packages/ui/src/pages/{PersonPage,MapPage,TreePage,EvidencePage}.tsx`, `EntityEditDrawer.tsx`, `CreateEntityModal.tsx`, `packages/cli/src/**` | 943-3,983 each | Large React page/drawer components and CLI record/ops commands outside Iteration 1 ownership (CLI ops/plugins reserved for Issue #22). |

### Baseline Scores (Repo-Wide / Iteration 1 Scope)

| Axis | Baseline (Repo-Wide) | Baseline (Iteration 1 Scope) | Rationale |
| --- | :---: | :---: | --- |
| **Decoupling** | 6.0 / 10 | 6.0 / 10 | Hexagonal ports already existed between core, server, and worker, yet internal services, HTTP domains, and D1 tables remained tightly fused inside 1.3K-1.9K LOC files. |
| **Cohesion** | 5.0 / 10 | 4.5 / 10 | `entities.ts`, `router.ts`, `wikiWriteService.ts`, `d1Repository.ts`, and `archivalTreeModel.ts` each bundled 3-8 distinct responsibilities. |
| **Data flow** | 7.0 / 10 | 7.0 / 10 | Validation at boundaries and append-only revision flow were strong, though batch conflict checks and commit/cache/plugin propagation repeated across 7 write paths. |
| **Layering** | 8.0 / 10 | 8.0 / 10 | Package boundaries (`core` -> `server` -> `worker`, pure `ui/src/lib`) were respected, though pronunciation resolution logic leaked into `schemas/entities.ts`. |
| **Modularity** | 5.0 / 10 | 4.0 / 10 | All 5 Iteration 1 targets exceeded 1,300 LOC, creating high reader load and forcing broad context loading for localized edits. |
| **Extensibility** | 6.0 / 10 | 5.5 / 10 | Adding HTTP route domains required editing a 930-line `if`-chain; adding D1 tables or tree projections required editing 1.5K-1.9K LOC files. |

## Iteration 1 Changes (DDD Bounded Contexts, Deep Modules & Seams)

Iteration 1 preserved 100% of exported symbols and runtime contracts while decomposing all 5 target monoliths into focused deep modules with zero `any`, `@ts-ignore`, or `@ts-expect-error` escape hatches.

### 1. Core Entity Schemas & Pronunciation Bounded Context (`packages/core/src/schemas/`)

- `packages/core/src/schemas/entities.ts` (`1,354` -> `449` LOC): Retains core entity Zod schemas, bundle schemas, read-model interfaces, `getMediaPersonIds`, and re-exports the pronunciation public API for full backward compatibility.
- `packages/core/src/schemas/pronunciation.ts` (`603` LOC): Owns `PronunciationSchema`, `PronunciationVariantSchema`, lexicon merging (`mergePronunciationLexicons`), compositional person resolution (`resolvePersonPronunciation`), and place specificity resolution (`resolvePlacePronunciation`).
- `packages/core/src/schemas/pronunciationGeo.ts` (`306` LOC): Deep policy module hiding US state, European/global province token tables, and BCP-47 language-country compatibility behind `splitPlaceSegments`, `getPlaceQualifierSegments`, `inferCountryCodeFromSegments`, and `isBareLexiconEntryCompatibleWithPlace`. Covered directly by `pronunciationGeo.test.ts` (`62` LOC).

### 2. Server Wiki Write Pipeline (`packages/server/src/services/`)

- `packages/server/src/services/wikiWriteService.ts` (`1,445` -> `480` LOC): Preserves `WikiWriteService` and `WikiWriteServiceDeps`, coordinating single-entity CRUD, revision revert, batch submit, and batch revert across three seams.
- `packages/server/src/services/wikiWrite/payloadPolicy.ts` (`352` LOC): Encapsulates entity ID derivation, schema validation, living-person privacy sanitization, working privacy-context updates, entity batch prefetching, and conditional TTS pronunciation audio synthesis.
- `packages/server/src/services/wikiWrite/batchCompiler.ts` (`567` LOC): Compiles multi-patch batch submissions and reverse-order batch reverts into `AtomicMutationOp[]` with unified intra-batch parent-revision conflict checks (`resolveBatchExpectedParent`).
- `packages/server/src/services/wikiWrite/commitPipeline.ts` (`209` LOC): Unifies atomic commit, 409 conflict construction, incremental/initial bundle cache refresh (`buildInitialSnapshotFromRevisions`), and fault-isolated plugin notifications behind `commitAndPropagate()`. Covered directly by `commitPipeline.test.ts` (`72` LOC).

### 3. Server HTTP Router (`packages/server/src/http/`)

- `packages/server/src/http/router.ts` (`1,325` -> `234` LOC): Instantiates services once, executes an ordered `HttpRouteHandler[]` pipeline, dispatches plugin routes and SPA asset fallback, and applies security headers and error mapping.
- `packages/server/src/http/httpPrimitives.ts` (`167` LOC): Shared transport parsing/response utilities (`HttpRequestContext`, `HttpRouteHandler`, `jsonResponse`, `redirectResponse`, `readJsonBody`) and browser auth error redirect helpers.
- `packages/server/src/http/routes/authRoutes.ts` (`260` LOC): Google OAuth PKCE, magic-link request/verify, invite redemption, session introspection, and logout.
- `packages/server/src/http/routes/wikiRoutes.ts` (`286` LOC): Bundle read, entity CRUD/restore, revision listing/revert, batch submit/revert, and YAML/snapshot backup exports with shared conditional ETag header formatting.
- `packages/server/src/http/routes/pronunciationRoutes.ts` (`223` LOC): Pronunciation audio generation and shared pronunciation lexicon GET/PUT endpoints.
- `packages/server/src/http/routes/mediaAndTalkRoutes.ts` (`167` LOC): Multipart media upload, HTTP 206 byte-range media/source streaming, and Talk comment CRUD.
- `packages/server/src/http/routes/adminRoutes.ts` (`112` LOC): Admin-only invite, scoped agent token, and user management behind a single sub-router CSRF + RBAC guard.

### 4. Worker Cloudflare D1 Persistence (`packages/worker/src/adapters/`)

- `packages/worker/src/adapters/d1Repository.ts` (`1,530` -> `185` LOC): Preserves `D1ArchiveRepository` (`ArchiveRepository`) as a thin composition root over three domain-scoped D1 stores.
- `packages/worker/src/adapters/d1/sqlHelpers.ts` (`149` LOC): WeakMap prepared-statement cache, 2 MB-safe UTF-8 JSON array chunker (`chunkJsonArrayWithRanges`), constraint-error classifier, and revision record builder. Covered directly by `sqlHelpers.test.ts` (`73` LOC).
- `packages/worker/src/adapters/d1/rowMappers.ts` (`238` LOC): Boundary SQLite row types and Zod-validated deserializers for all 8 D1 tables.
- `packages/worker/src/adapters/d1/entityReadStore.ts` (`289` LOC): Entity lookups, set-based batch reads, living-person projection, zero-N+1 active snapshot loading, and revision ledger queries.
- `packages/worker/src/adapters/d1/atomicMutationStore.ts` (`619` LOC): Atomic `DB.batch()` SQL compiler, set-based `json_each()` create-run batching, optimistic lock predicates, and SQLite constraint conflict forensics.
- `packages/worker/src/adapters/d1/accessAndTalkStore.ts` (`332` LOC): Persistence for `talk_comments`, `users`, `invites`, `magic_links`, and `agent_tokens`.

### 5. UI Archival Tree View-Model (`packages/ui/src/lib/`)

- `packages/ui/src/lib/archivalTreeModel.ts` (`1,879` -> `56` LOC): Pure barrel re-exporting every type, constant, and algorithm from `packages/ui/src/lib/tree/`.
- `packages/ui/src/lib/tree/types.ts` (`388` LOC): Domain/layout types, geometry constants, and pure display/classification helpers.
- `packages/ui/src/lib/tree/treeGraphBuilder.ts` (`711` LOC): Fixed-point generation inference, couple/single-parent union assembly, marriage chronological ordering, collateral sibling collapsing, and multi-marriage family unit grouping.
- `packages/ui/src/lib/tree/diagramLayout.ts` (`543` LOC): 4-sweep barycenter crossing minimization, unit footprint sizing, marriage hub placement, early-loss strips, 2-column hanging grids, 90-degree orthogonal buses, and tight bounding box calculation.
- `packages/ui/src/lib/tree/treeProjections.ts` (`349` LOC): Lineage spotlight traversal, breadcrumb/pivot kinship path projection, focus planning, and ranked person search.

## Post-Iteration 1 Scores

| Axis | Baseline (It. 1 Scope) | Post-Iteration 1 (It. 1 Scope) | Post-Iteration 1 (Repo-Wide) | Key Drivers & Remaining Gaps |
| --- | :---: | :---: | :---: | --- |
| **Decoupling** | 6.0 / 10 | **9.0 / 10** | 7.2 / 10 | Each HTTP domain, D1 store, write seam, and tree stage depends only on its narrow peer interfaces; UI pages and CLI commands remain for Iteration 2. |
| **Cohesion** | 4.5 / 10 | **9.2 / 10** | 7.0 / 10 | Pronunciation policy, SQL row mapping, atomic batch compilation, route domains, and 2D layout each own one crisp domain concept. |
| **Data flow** | 7.0 / 10 | **9.2 / 10** | 8.0 / 10 | Single `commitAndPropagate()` pipeline, unified batch parent-lock checking, and explicit `Graph -> Layout -> Projection` tree data flow. |
| **Layering** | 8.0 / 10 | **9.5 / 10** | 8.5 / 10 | Zero cross-layer leaks; `@kinloom/core` remains pure, `@kinloom/server` stays runtime-agnostic, `@kinloom/worker` isolates CF SQL/D1, and `ui/src/lib/tree/` stays pure with zero DOM side effects. |
| **Modularity** | 4.0 / 10 | **9.0 / 10** | 6.8 / 10 | Zero files above 711 LOC across all 5 target areas (down from 1,325-1,879 LOC). Remaining 1K+ LOC files are in UI React pages/drawers, CSS modules, and CLI commands. |
| **Extensibility** | 5.5 / 10 | **9.0 / 10** | 7.2 / 10 | Route handler array (`HttpRouteHandler[]`), independent D1 sub-stores, and separated tree stages make adding features additive rather than invasive. |

## Iteration 2A Changes (CLI Entrypoint & Ops Monoliths)

Measured at commit `2f508a2` before decomposition (`11,305` LOC across 6 files) and verified after decomposition with zero `any`, `@ts-ignore`, or `@ts-expect-error` escape hatches, 0 Biome errors/warnings across 439 files, and 100% backward-compatible exports from every original file path.

### Iteration 2A Before/After LOC Table

| Target Monolith | Before LOC | After Entrypoint LOC | Extracted Submodules | Max Submodule LOC |
| --- | ---: | ---: | ---: | ---: |
| `packages/cli/src/commands/ops/integrate.ts` | 2,294 | 374 | 9 modules under `ops/integrate/` | 607 |
| `packages/cli/src/commands/ops/audit.ts` | 2,156 | 365 | 7 modules under `ops/audit/` | 423 |
| `packages/cli/src/commands/ops/pronounce.ts` | 1,841 | 33 | 4 modules under `ops/pronounce/` | 691 |
| `packages/cli/src/commands/ops/sync.ts` | 1,804 | 257 | 6 modules under `ops/sync/` | 456 |
| `packages/cli/src/cli.ts` | 1,688 | 123 | 5 modules under `cli/` | 596 |
| `packages/cli/src/commands/ops/context.ts` | 1,522 | 215 | 6 modules under `ops/context/` | 514 |

### 1. Research Package Integrator (`packages/cli/src/commands/ops/integrate.ts` & `ops/integrate/`)

- `integrate.ts` (`2,294` -> `374` LOC): Coordinates single-package YAML load/write, receipt creation, and report rendering while re-exporting all 29 original public symbols.
- `integrate/types.ts` (`165` LOC) & `integrate/primitives.ts` (`94` LOC): Shared option/receipt/kinship types, validation regexes, atomic file I/O, and SHA-256 helpers.
- `integrate/receipts.ts` (`138` LOC): Package fingerprinting and `.integrated.json` receipt read/write/match lifecycle.
- `integrate/kinship.ts` (`288` LOC): `remove_kinship` parsing, reciprocal expansion, removal, and symmetric edge upsert.
- `integrate/people.ts` (`481` LOC): EDTF death-date parsing (`parseValidDeathEdtf`), living-person privacy guards, slug collision checks, and `person_updates`/`people` merging.
- `integrate/entities.ts` (`607` LOC): `patch.json` normalization and merge/retirement rules for places, sources, events, media, and narratives.
- `integrate/integrity.ts` (`215` LOC): Cross-entity referential integrity and retirement dangling-reference checks.
- `integrate/media.ts` (`208` LOC): Media layout detection, scan staging planning, and live/dry-run/overlay scan staging.
- `integrate/privacy.ts` (`121` LOC): `auditBundlePrivacy` and dual-mode (`private`/`public`) archive compilation checks.

### 2. Research Package Auditor (`packages/cli/src/commands/ops/audit.ts` & `ops/audit/`)

- `audit.ts` (`2,156` -> `365` LOC): Orchestrates `runAuditCommand`, in-process integrate dry-run, place coordinate checks, and plugin/pronunciation wiring while re-exporting all 25 original symbols.
- `audit/types.ts` (`157` LOC): Public check result types and plain-record helpers.
- `audit/chronology.ts` (`423` LOC): EDTF parsing (`parseAuditEdtf`), lifespan math (`computeLifespan`), and event chronology checks (`runChronologyCheck`).
- `audit/citations.ts` (`371` LOC): Abbreviation-aware sentence splitting (`splitParagraphIntoSentences`) and uncited prose detection (`runUncitedSentenceCheck`).
- `audit/hygiene.ts` (`333` LOC): Staged patch projection and tree hygiene regression diffing (`runAuditHygieneRegressionCheck`).
- `audit/privacyStyle.ts` (`266` LOC): Living-relative name scanning, SSN/phone detection, and em-dash prose scanning (`runPrivacyAndStyleScan`).
- `audit/scans.ts` (`246` LOC): Binary image header inspection (`inspectImageBuffer`) and scan inventory verification (`runScanInventoryCheck`).
- `audit/report.ts` (`50` LOC): Text report formatting (`formatAuditTextReport`).

### 3. Pronunciation Lookup & Audit (`packages/cli/src/commands/ops/pronounce.ts` & `ops/pronounce/`)

- `pronounce.ts` (`1,841` -> `33` LOC): Pure backward-compatible barrel facade.
- `pronounce/types.ts` (`202` LOC): Supported languages, tier rankings, lookup/audit interfaces, and language-code normalization.
- `pronounce/mediaWiki.ts` (`334` LOC): Pure MediaWiki template parser, IPA/Commons audio extraction (`extractMediaWikiPronunciations`), and wiki target planning.
- `pronounce/lookup.ts` (`691` LOC): MediaWiki and Forvo API fetchers with retry, disk cache (`getPronounceCacheDir`), manual source builders, ranking/corroboration, and `runPronounceLookupCommand`.
- `pronounce/audit.ts` (`681` LOC): Lexicon loader (`loadArchivePronunciationLexicon`), shared foreign-IPA quality rules, living-leak detection, coverage checks, homonym collision checks, and `runPronounceAuditCommand`.

### 4. Live Archive Sync (`packages/cli/src/commands/ops/sync.ts` & `ops/sync/`)

- `sync.ts` (`1,804` -> `257` LOC): Orchestrates `runSyncCommand` with guaranteed temporary token cleanup and preserves all original exports.
- `sync/types.ts` (`254` LOC): Public sync option/plan/report types, `SYNC_DEPENDENCY_ORDER`, and bounded concurrency runner.
- `sync/wrangler.ts` (`385` LOC): JSONC/TOML Wrangler config parsing (`loadWranglerBindings`), D1 SQL builders, and temp token mint/cleanup lifecycle.
- `sync/planner.ts` (`456` LOC): Type/delete arg parsers, local YAML loader, living-person sanitization (`buildSanitizedLocalEntries`), remote snapshot indexing, and diff planning (`computeSyncPlan`).
- `sync/media.ts` (`176` LOC): Media layout detection, R2 target resolution, remote existence probing, and concurrent R2 uploads.
- `sync/remoteClient.ts` (`328` LOC): Snapshot fetch, chunked batch submission, R2 bundle cache purge/recompile, and live endpoint verification.
- `sync/report.ts` (`78` LOC): Human-readable sync report formatter (`formatSyncReport`).

### 5. Person Research Context (`packages/cli/src/commands/ops/context.ts` & `ops/context/`)

- `context.ts` (`1,522` -> `215` LOC): Orchestrates `runContextCommand` and re-exports all 20 original symbols.
- `context/types.ts` (`155` LOC): Context payload types and `REDACTED_RELATIVE_LABEL`.
- `context/yamlScanner.ts` (`118` LOC): Selective YAML block splitting/parsing (`splitTopLevelYamlList`, `extractYamlBlockId`, `parseMatchingYamlBlocks`) and parallel archive loading.
- `context/privacy.ts` (`174` LOC): Living-person fence construction and recursive string/object redaction.
- `context/graph.ts` (`514` LOC): Kinship traversal, event/media/narrative/place/source collection, and relative archive media assembly.
- `context/ancestry.ts` (`457` LOC): External Ancestry JSON matching, fact/source redaction, and record image discovery.
- `context/formatter.ts` (`173` LOC): Markdown and JSON context rendering (`formatPersonContextMarkdown`).

### 6. CLI Entrypoint (`packages/cli/src/cli.ts` & `cli/`)

- `cli.ts` (`1,688` -> `123` LOC): Thin executable entrypoint preserving the `#!/usr/bin/env node` shebang, `isExecutedDirectly()` guard with `EPIPE` handling, top-level error/exit-code mapping, and all original exports.
- `cli/types.ts` (`84` LOC): Shared `CliIo`, `RunCliOptions`, `CliDispatchContext`, and arg-parsing/output boundary helpers.
- `cli/pluginAndGuideCommands.ts` (`322` LOC): `ROOT_HELP`, site plugin discovery, help/guide dispatch, pre-help record command dispatch, and plugin fallback.
- `cli/coreCommands.ts` (`319` LOC): Archive lifecycle and API command dispatch (`init`, `slice-gedcom`, `seed`, `submit-batch`, `export-yaml`, `upload-media`, `reconcile`).
- `cli/researchOpsCommands.ts` (`596` LOC): Local research ops command dispatch (`context`, `integrate`, `audit`, `media`, `verify`, `status`) with shared package target parsing.
- `cli/liveAndUtilityCommands.ts` (`455` LOC): Live deployment and utility command dispatch (`sync`, `migrate`, `dates`, `pronounce`, `telemetry`).

## Post-Iteration 2A Scores

| Axis | Post-It. 1 (Repo-Wide) | Post-It. 2A (It. 2A Scope) | Post-It. 2A (Repo-Wide) | Key Drivers & Remaining Gaps |
| --- | :---: | :---: | :---: | --- |
| **Decoupling** | 7.2 / 10 | **9.2 / 10** | **8.0 / 10** | CLI entrypoint dispatch, D1/R2 sync transport, MediaWiki parsers, audit checks, and integrate merge stages now depend on narrow typed seams; UI pages and CLI record clients remain for Iterations 2B and 3. |
| **Cohesion** | 7.0 / 10 | **9.3 / 10** | **8.0 / 10** | Each CLI ops domain separates pure planning, validation, external I/O, and report rendering into single-responsibility modules. |
| **Data flow** | 8.0 / 10 | **9.2 / 10** | **8.5 / 10** | Explicit pipelines across `load -> sanitize -> diff -> execute -> report` (sync), `parse -> merge -> integrity -> privacy -> write` (integrate), and `help -> records -> core -> ops -> plugins` (CLI). |
| **Layering** | 8.5 / 10 | **9.4 / 10** | **8.9 / 10** | Pure parsers, validators, and formatters are separated from Wrangler/HTTP/filesystem shells across all 6 CLI ops/entrypoint domains. |
| **Modularity** | 6.8 / 10 | **9.1 / 10** | **7.7 / 10** | All 6 Iteration 2A monoliths dropped from 1,522-2,294 LOC to 33-374 LOC entrypoints with every submodule under 700 LOC (max 691 LOC). Remaining 1K+ LOC files are UI pages/drawers/CSS and `records/clients/`. |
| **Extensibility** | 7.2 / 10 | **9.2 / 10** | **8.0 / 10** | Adding a CLI command group, audit check, integrate entity merger, or pronunciation provider now targets one focused module rather than a 1.5K-2.3K LOC file. |

## Iteration 2B Changes (UI Pages, Entity Form Registry & CSS Module Decomposition)

Measured at commit `da30f03` before decomposition (`12,960` LOC across 10 target monoliths: 7 TSX files totaling `8,094` LOC and 3 CSS Modules totaling `4,866` LOC) and verified after decomposition with zero `any`, `@ts-ignore`, or `@ts-expect-error` escape hatches, 0 Biome errors/warnings, 0 impeccable audit findings across static/desktop/mobile, 100% Playwright E2E pass rate, and 100% backward-compatible public exports from `packages/ui/src/index.ts`.

### Iteration 2B Before/After LOC Table

| Target Monolith | Before LOC | After Entrypoint LOC | Extracted Submodules | Max Submodule LOC |
| --- | ---: | ---: | --- | ---: |
| `packages/ui/src/pages/PersonPage.tsx` | 1,542 | 471 | 6 modules under `pages/person/` | 309 |
| `packages/ui/src/pages/MapPage.tsx` | 1,432 | 306 | 5 modules under `pages/map/` | 527 |
| `packages/ui/src/pages/TreePage.tsx` | 1,327 | 523 | 4 modules under `pages/tree/` | 473 |
| `packages/ui/src/pages/EvidencePage.tsx` | 1,006 | 274 | 4 modules under `pages/evidence/` | 388 |
| `packages/ui/src/components/wiki/EntityEditDrawer.tsx` | 946 | 561 | Shared `entityForms/{fieldTypes,editRegistry,EntityDrawerChrome}` | 308 |
| `packages/ui/src/components/wiki/CreateEntityModal.tsx` | 944 | 430 | Shared `entityForms/{fieldTypes,createRegistry}` | 448 |
| `packages/ui/src/components/wiki/PronunciationEditorSection.tsx` | 897 | 296 | 3 modules under `components/wiki/pronunciation/` | 338 |
| `packages/ui/src/pages/TreeAndMapPage.module.css` | 2,119 | removed | `TreePage`, `MapPage`, `TreePedigreeRoll`, `TreeFocusDrawer`, `ArchiveStatusShell`, `CanvasSurfacePrimitives` | 608 |
| `packages/ui/src/components/wiki/WikiSurfaces.module.css` | 1,679 | removed | `WikiChrome`, `WikiAuth`, `WikiPanels`, `WikiForms` (+ domain rules moved to `ArchiveStatusShell`, `MediaGallery`, `KinshipPage`) | 512 |
| `packages/ui/src/pages/PersonPage.module.css` | 1,068 | 479 | `PersonNarratives.module.css`, `ArchivalMarkdown.module.css`, `MediaGallery.module.css` | 261 |

### 1. Entity Form Registry Seam & Wiki Drawers (`packages/ui/src/components/wiki/`)

- `entityForms/fieldTypes.ts` (`240` LOC): Pure field normalizers (`asString`, `asStringArray`, `slugify`, `buildUniquePersonIdentity`, `parsePersonSex`, `parsePersonLineageGroup`, `parseKinshipRelation`), typed `CreateEntityDraft` factory, relative relation specs, and registry interfaces.
- `entityForms/editRegistry.tsx` (`308` LOC): Typed `ENTITY_EDIT_FORM_REGISTRY` seam (`person`, `place`, `event`, `narrative`, plus `JsonFallbackEditFields`) owning per-entity field views, pronunciation capability predicates, and `prepareSubmitDraft` hooks so `EntityEditDrawer` contains zero entity-type switches.
- `entityForms/createRegistry.tsx` (`448` LOC): Typed `ENTITY_CREATE_FORM_REGISTRY` seam (`person`, `event`, `place`, `kinship_edge`) with discriminated-union `validateAndBuild` results, shared `PersonCreateFields`, and `LinkExistingRelativeFields`.
- `entityForms/EntityDrawerChrome.tsx` (`202` LOC): Focused status banners (`EntityDrawerStatusBanners`) and soft-delete confirmation section (`EntityDangerZone`).
- `EntityEditDrawer.tsx` (`946` -> `561` LOC) & `CreateEntityModal.tsx` (`944` -> `430` LOC): Clean lifecycle shells preserving 100% of original exports and XState machine contracts.
- `PronunciationEditorSection.tsx` (`897` -> `296` LOC) & `pronunciation/{pronunciationDraft.ts,SharedTokenPronunciationEditor.tsx,PersonalPronunciationOverrideForm.tsx}` (`189`, `338`, `221` LOC): Separates draft normalization and boundary API requests from shared token chip editing and personal override form rendering.

### 2. Person Profile Bounded Context (`packages/ui/src/pages/PersonPage.tsx` & `pages/person/`)

- `PersonPage.tsx` (`1,542` -> `471` LOC): Page shell composing archive data, timeline sync hook, wiki tabs, and modal/drawer surfaces.
- `person/personViewModel.ts` (`264` LOC): Pure, unit-tested view-model selectors (`collectPersonMedia`, `collectPersonResidenceSpans`, `buildImmediateFamily`, `buildTimelineScrubberTicks`, `buildPersonSectionJumpItems`, `resolvePortraitLightboxState`, `buildPersonEditInitialData`, `triggerPersonGedcomDownload`).
- `person/usePersonTimelineSync.ts` (`156` LOC): Encapsulates `?event=` URL query sync, initial card scroll, RAF scroll-spy via `pickActiveTimelineEventId`, active year updates, and pivot breadcrumb push.
- `person/PersonProfileHeader.tsx` (`309` LOC), `person/PersonNarrativesSection.tsx` (`237` LOC, unifying duplicated Biography and Family Stories rendering), `person/PersonMediaSection.tsx` (`241` LOC, grid + keyboard lightbox), and `person/PersonLifeTimelineSection.tsx` (`130` LOC).

### 3. Migration Map & Family Tree Pages (`pages/map/` & `pages/tree/`)

- `MapPage.tsx` (`1,432` -> `306` LOC), `map/mapOverlayData.ts` (`144` LOC, pure MapLibre-free GeoJSON overlay and bounds builders), `map/mapLibreLayers.ts` (`313` LOC, MapLibre worker setup, paper style, and layer bindings), `map/useMigrationMapController.ts` (`527` LOC, map lifecycle, OHM date filtering, camera easing, playback loop, and keyboard shortcuts), `map/MapToolbar.tsx` (`146` LOC), and `map/MapStopDrawerAndDock.tsx` (`264` LOC).
- `TreePage.tsx` (`1,327` -> `523` LOC), `tree/treePageHelpers.ts` (`42` LOC), `tree/useTreeViewportTransform.ts` (`473` LOC, transform RAF queue, smooth easing, inertia physics, fit/center, and zoom helpers), `tree/useTreeCanvasInteractions.ts` (`415` LOC, multi-pointer drag/pinch/double-tap, wheel zoom, and keyboard navigation), and `tree/TreeZoomControls.tsx` (`65` LOC).

### 4. Evidence & Provenance Page (`pages/EvidencePage.tsx` & `pages/evidence/`)

- `EvidencePage.tsx` (`1,006` -> `274` LOC): Clean tablist shell and banner metrics.
- `evidence/evidenceViewModel.ts` (`158` LOC): Pure selectors for conflict events, discrepancy claims, unverified GEDCOM entries, citation metrics, source search/sort, and media category filtering.
- `evidence/EvidenceDiscrepanciesTab.tsx` (`123` LOC), `evidence/EvidenceSourcesTab.tsx` (`270` LOC), and `evidence/EvidenceMediaTab.tsx` (`388` LOC, gallery + undigitized checklist + lightbox).
- Pure view-model and registry contracts are covered directly by `packages/ui/src/pages/uiViewModels.test.ts` (`322` LOC).

### 5. Layered CSS Modules Decomposition

- Eliminated all three `1,000+` LOC CSS Module monoliths (`TreeAndMapPage.module.css` `2,119` LOC, `WikiSurfaces.module.css` `1,679` LOC, `PersonPage.module.css` `1,068` LOC) and resolved upward layering inversions where reusable components (`ArchivalMarkdown`, `CitationPopover`, `InlineEntityMention`, `MediaPlayer`, `SourceReaderDrawer`, `AppErrorBoundary`, `KinloomApp`, `PluginContext`) previously depended on page CSS modules.
- Every CSS Module in `packages/ui/src/` is now strictly `< 700` LOC (max `608` LOC across all Iteration 2B split stylesheets), preserving cascade order, `>= 44px` mobile touch targets, `0px` horizontal overflow, and `@media print` fidelity.

## Post-Iteration 2B Scores

| Axis | Post-It. 2A (Repo-Wide) | Post-It. 2B (It. 2B Scope) | Post-It. 2B (Repo-Wide) | Key Drivers & Remaining Gaps |
| --- | :---: | :---: | :---: | --- |
| **Decoupling** | 8.0 / 10 | **9.6 / 10** | **8.8 / 10** | UI pages, wiki drawers, pronunciation editors, and CSS modules now depend on narrow typed seams (`ENTITY_EDIT_FORM_REGISTRY`, `ENTITY_CREATE_FORM_REGISTRY`, pure view-models, component-layer CSS); CLI record clients remain for Iteration 3. |
| **Cohesion** | 8.0 / 10 | **9.6 / 10** | **8.8 / 10** | Each UI page separates pure view-model derivation, browser/DOM/MapLibre/pointer controllers, and focused presentational panels; Biography and Family Stories share one unified narrative renderer; non-wiki CSS moved out of `WikiSurfaces`. |
| **Data flow** | 8.5 / 10 | **9.5 / 10** | **9.0 / 10** | Deterministic `Bundle -> Pure View-Model -> Presentational Component` pipelines across Person, Map, Tree, and Evidence pages; single typed `CreateEntityDraft` + discriminated-union payload builder replaces 18 scattered `useState` hooks. |
| **Layering** | 8.9 / 10 | **9.8 / 10** | **9.4 / 10** | Pure UI view-models (`personViewModel`, `evidenceViewModel`, `mapOverlayData`, `entityForms/fieldTypes`) carry zero React/DOM/MapLibre runtime coupling, and component CSS modules no longer reach upward into `pages/*.module.css`. |
| **Modularity** | 7.7 / 10 | **9.5 / 10** | **8.6 / 10** | All 10 Iteration 2B monoliths dropped cleanly under 600 LOC (TS/TSX max `561` LOC) and 700 LOC (CSS max `608` LOC). Remaining 1K+ LOC files are exclusively in `packages/cli/src/commands/records/clients/` and secondary backend/core files queued for Iteration 3. |
| **Extensibility** | 8.0 / 10 | **9.7 / 10** | **8.9 / 10** | Adding a new entity editor or creatable entity kind is now a single typed entry in `ENTITY_EDIT_FORM_REGISTRY` / `ENTITY_CREATE_FORM_REGISTRY`; adding an evidence tab, person profile section, or map overlay layer touches one focused module. |

## Iteration 3A Changes (Shared Records Runtime Primitives & 7 Core/Media Record Clients)

Measured at commit `8f1018d` before decomposition (`19,086` LOC across the 7 largest CLI record/media clients) and verified on `2026-11-27` (UTC via Python) with zero `any`, `@ts-ignore`, or `@ts-expect-error` escape hatches, 0 circular imports across all 39 extracted submodules, 0 Biome errors/warnings across 533 files, and 100% export parity (`239/239` exported symbols preserved across all 7 facades).

### Shared Cross-Client Runtime Extraction

- `packages/cli/src/commands/records/runtime/primitives.ts` (`233` LOC, covered by `primitives.test.ts`): Centralizes duplicated cross-client primitives previously copy-pasted across 2-6 clients (`isPlainRecord`, `hasControlChar`, `isBrokenPipeError`, `hasMagicPrefix`, `stripLeadingBomAndWs`, `looksLikeHtmlBuffer`, `JPEG_MAGIC`, `PNG_MAGIC`, `PDF_MAGIC`, `HTML_ERROR_PREFIXES`, `IncompleteDownloadError`, `atomicWriteCompactJson`, `atomicCopyFileSync`, `readJsonRecordIfValid`, `sha256FileSync`, `resolveSafeChildPath`, `resolveUserPathFromContext`, `resolveEnvCacheTtlHours`, `runWithConcurrency`, `fetchWithTimeout`), re-exported from `runtime/index.ts`.

### Iteration 3A Before/After LOC Table

| Target Monolith | Before LOC | After Entrypoint LOC | Extracted Submodules | Max Submodule LOC |
| --- | ---: | ---: | --- | ---: |
| `packages/cli/src/commands/records/clients/nara.ts` | 4,103 | 136 | 9 modules under `clients/nara/` | 628 |
| `packages/cli/src/commands/records/clients/archive-org.ts` | 3,398 | 106 | 7 modules under `clients/archiveOrg/` | 622 |
| `packages/cli/src/commands/records/clients/prep-scan.ts` | 2,988 | 78 | 6 modules under `clients/prepScan/` | 614 |
| `packages/cli/src/commands/records/clients/ocr.ts` | 2,615 | 204 | 5 modules under `clients/ocr/` | 590 |
| `packages/cli/src/commands/records/clients/findagrave.ts` | 2,185 | 70 | 4 modules under `clients/findagrave/` | 585 |
| `packages/cli/src/commands/records/clients/openarchieven.ts` | 1,980 | 51 | 4 modules under `clients/openarchieven/` | 618 |
| `packages/cli/src/commands/records/clients/chronam.ts` | 1,817 | 91 | 4 modules under `clients/chronam/` | 644 |

### Domain Folder Breakdown

1. **NARA Catalog & 1950 Census (`clients/nara.ts` & `clients/nara/`)**:
   - `nara.ts` (`4,103` -> `136` LOC): Thin `createNaraCommand`/`runNaraCommand` facade re-exporting all 74 original symbols.
   - `nara/{types,queryAndRecords,browserFallback,catalogTransport,downloads,census1950,cliSpecs,catalogCommands,censusCommands}.ts` (`253`-`628` LOC): Separates pure NAID/URL/page-spec/record projection logic, Playwright fallback, HTTP catalog transport, cached object/direct downloads, 1950 Census + IIIF JPEG bounded context, CLI option specs, and catalog/census subcommand handlers.
2. **Internet Archive (`clients/archive-org.ts` & `clients/archiveOrg/`)**:
   - `archive-org.ts` (`3,398` -> `106` LOC): Thin `runArchiveOrgCommand` facade re-exporting all 35 original symbols.
   - `archiveOrg/{types,transport,itemCache,pageAndGrep,cliSpecs,searchCommands,pageCommands}.ts` (`268`-`622` LOC): Separates IA URL/identifier/retry rules, HTTP transport, metadata/scandata XML/hOCR/DJVU artifact caching, printed-page/leaf range parsing and cached OCR grep, CLI specs, and search/page command runners.
3. **Archival Scan Preparation (`clients/prep-scan.ts` & `clients/prepScan/`)**:
   - `prep-scan.ts` (`2,988` -> `78` LOC): Thin `runPrepScanCommand` facade re-exporting all 18 original symbols.
   - `prepScan/{geometry,imageOps,cliSpecs,rasterCommands,sheetAndStitchCommands,pdfCommands}.ts` (`359`-`614` LOC): Separates pure box/page-range/color/argv parsers, Sharp raster/deskew/redaction/SVG grid/contact-strip primitives, CLI specs, raster commands, multi-panel strip/stitch commands, and cached PDF page/grep commands.
4. **SHA-256 Cached OCR (`clients/ocr.ts` & `clients/ocr/`)**:
   - `ocr.ts` (`2,615` -> `204` LOC): Thin `runOcrCommand` facade re-exporting all 47 original symbols (including `runWithConcurrency` from `runtime/primitives.js`).
   - `ocr/{types,cliArgs,imageAndTsv,engines,pipeline}.ts` (`258`-`590` LOC): Separates OCR config/error models, CLI arg parsing/usage, binary image header inspection and Tesseract TSV rescaling/parsing, timeout-enforced subprocess/printed/cursive engines, and SHA-256 cached single/batch execution pipelines.
5. **Find a Grave (`clients/findagrave.ts` & `clients/findagrave/`)**:
   - `findagrave.ts` (`2,185` -> `70` LOC): Thin `runFindagraveCommand` facade re-exporting all 18 original symbols.
   - `findagrave/{domain,transport,cliSpecs,commands}.ts` (`493`-`585` LOC): Separates GraphQL queries, entity/photo validators, and enrichment formatters from rate-limited GraphQL/photo transport and caching, CLI specs, and command runners.
6. **OpenArchieven (`clients/openarchieven.ts` & `clients/openarchieven/`)**:
   - `openarchieven.ts` (`1,980` -> `51` LOC): Thin `runOpenarchievenCommand` facade re-exporting all 4 original symbols.
   - `openarchieven/{domain,transport,cliSpecs,commands}.ts` (`328`-`618` LOC): Separates A2A record/scan extraction and formatting from rate-limited HTTP/cache transport, CLI specs, and command runners.
7. **Chronicling America (`clients/chronam.ts` & `clients/chronam/`)**:
   - `chronam.ts` (`1,817` -> `91` LOC): Thin `runChronamCommand` facade re-exporting all 43 original symbols (including `atomicCopyFileSync` from `runtime/primitives.js`).
   - `chronam/{domain,transport,cliSpecs,commands}.ts` (`332`-`644` LOC): Separates LOC URL/state/date/query/IIIF asset resolvers from redirect-following HTTP/streaming-download/cache transport, CLI specs, and command runners.

## Post-Iteration 3A Scores

| Axis | Post-It. 2B (Repo-Wide) | Post-It. 3A (It. 3A Scope) | Post-It. 3A (Repo-Wide) | Key Drivers & Remaining Gaps |
| --- | :---: | :---: | :---: | --- |
| **Decoupling** | 8.8 / 10 | **9.6 / 10** | **9.2 / 10** | All 7 largest CLI record/media clients now separate pure domain parsers/validators, HTTP/Playwright/Sharp/Tesseract adapters, CLI specs, and thin subcommand runners while sharing `runtime/primitives.ts`; state/international clients remain for Iteration 3B. |
| **Cohesion** | 8.8 / 10 | **9.6 / 10** | **9.2 / 10** | Every created submodule owns one bounded context (e.g. NARA 1950 Census IIIF, IA scandata/item cache, OCR TSV layout parsing, prep-scan geometry) with zero circular imports across all 39 submodules. |
| **Data flow** | 9.0 / 10 | **9.5 / 10** | **9.3 / 10** | Explicit `CLI Parse -> Pure Validation/Query Build -> Cached Transport/Adapter -> Domain Projection -> Output` pipelines replace interleaved multi-thousand-line files. |
| **Layering** | 9.4 / 10 | **9.7 / 10** | **9.5 / 10** | Pure domain/geometry/TSV/A2A/IIIF modules carry zero network or subprocess side effects, and duplicated filesystem/concurrency/HTML-detection helpers now live once in `records/runtime/primitives.ts`. |
| **Modularity** | 8.6 / 10 | **9.6 / 10** | **9.1 / 10** | All 7 largest monoliths (`1,817`-`4,103` LOC) dropped to `51`-`204` LOC facades with every extracted module strictly `< 650` LOC (max `644` LOC). Remaining `1,000+` LOC files are smaller state/international record clients and secondary backend/core/ops files queued for Iteration 3B. |
| **Extensibility** | 8.9 / 10 | **9.6 / 10** | **9.3 / 10** | Adding a NARA collection, IA command, prep-scan operation, OCR backend, or archive subcommand targets one focused module and reuses `records/runtime/primitives.ts` directly. |

## Iteration 3B Changes (Regional Record Clients, Runtime URL Policy & Remaining CLI Ops)

Measured at commit `110eed9` before decomposition (`26,184` LOC across all 24 remaining CLI files above `650` LOC) and verified on `2026-11-27` (UTC via Python) with zero `any`, `@ts-ignore`, or `@ts-expect-error` escape hatches, 0 circular imports across all 238 non-test files in `packages/cli/src/commands/` (including breaking the pre-existing `pronounce/audit.ts` <-> `pronounce/deduplicate.ts` cycle), 0 Biome errors/warnings across 635 files, 89/89 Vitest test files (`707/707` tests) passing, and 100% export parity (`367/367` exported symbols preserved across all 24 targets). Every non-test file in `packages/cli/src/` is now strictly `< 650` LOC (max `644` LOC from Iteration 3A; max `525` LOC across all 102 newly extracted Iteration 3B submodules).

### Shared Cross-Client Runtime Extensions

- `packages/cli/src/commands/records/runtime/urlPolicy.ts` (`306` LOC): Extracted IPv4/IPv6 private-IP classification (`isPrivateOrReservedIp`), SSRF guard (`assertSafeUrl`, `SsrfBlockedError`), `HttpStatusError`, `CookieJar`, `parseRetryAfterMs`, and `looksLikeHtmlErrorPage` out of `runtime/http.ts` (`724` -> `444` LOC, re-exporting all original symbols).
- `packages/cli/src/commands/records/runtime/primitives.ts` (`259` LOC, covered by `primitives.test.ts`): Added `encodeUrlPathPreservingSlashes` (eliminating 4x duplicated `pyQuote`) and `handleRecordCommandError` (eliminating duplicated CLI error-mapping catch ladders across all 15 record client facades), alongside existing `isPlainRecord`, `resolveEnvCacheTtlHours`, `resolveUserPathFromContext`, `resolveSafeChildPath`, `looksLikeHtmlBuffer`, and `atomicCopyFileSync` reused across all decomposed clients.
- `packages/cli/src/commands/records/runtime/parse.ts` (`100` LOC): Added shared `cleanHtmlText` (with optional `<script>`/`<style>` stripping) reused across regional HTML parsers.

### Iteration 3B Before/After LOC Table

| Target Monolith | Before LOC | After Entrypoint LOC | Extracted Submodules | Max Submodule LOC |
| --- | ---: | ---: | --- | ---: |
| `packages/cli/src/commands/records/clients/se-archives.ts` | 2,140 | 58 | 6 modules under `clients/seArchives/` | 502 |
| `packages/cli/src/commands/records/clients/va-archives.ts` | 2,100 | 120 | 6 modules under `clients/vaArchives/` | 414 |
| `packages/cli/src/commands/records/clients/mn-archives.ts` | 1,762 | 97 | 5 modules under `clients/mnArchives/` | 487 |
| `packages/cli/src/commands/records/clients/fi-archives.ts` | 1,680 | 65 | 5 modules under `clients/fiArchives/` | 525 |
| `packages/cli/src/commands/records/clients/nj-archives.ts` | 1,314 | 48 | 5 modules under `clients/njArchives/` | 330 |
| `packages/cli/src/commands/records/clients/narrative-audio.ts` | 1,304 | 58 | 4 modules under `clients/narrativeAudio/` | 510 |
| `packages/cli/src/commands/records/clients/ca-archives.ts` | 1,178 | 64 | 4 modules under `clients/caArchives/` | 423 |
| `packages/cli/src/commands/records/clients/uk-archives.ts` | 1,153 | 67 | 4 modules under `clients/ukArchives/` | 359 |
| `packages/cli/src/commands/records/clients/ky-archives.ts` | 1,053 | 64 | 4 modules under `clients/kyArchives/` | 380 |
| `packages/cli/src/commands/records/clients/mo-archives.ts` | 1,018 | 41 | 4 modules under `clients/moArchives/` | 347 |
| `packages/cli/src/commands/records/clients/texas-archives.ts` | 994 | 63 | 4 modules under `clients/texasArchives/` | 378 |
| `packages/cli/src/commands/records/clients/michiganology.ts` | 941 | 45 | 4 modules under `clients/michiganology/` | 305 |
| `packages/cli/src/commands/records/clients/gnis.ts` | 821 | 42 | 4 modules under `clients/gnis/` | 247 |
| `packages/cli/src/commands/records/clients/wikitree.ts` | 714 | 32 | 4 modules under `clients/wikitree/` | 283 |
| `packages/cli/src/commands/records/clients/persi.ts` | 688 | 37 | 4 modules under `clients/persi/` | 249 |
| `packages/cli/src/commands/records/runtime/http.ts` | 724 | 444 | `runtime/urlPolicy.ts` | 306 |
| `packages/cli/src/commands/ops/audit-overlaps.ts` | 1,040 | 157 | 4 modules under `ops/auditOverlaps/` | 412 |
| `packages/cli/src/commands/ops/media-dedupe.ts` | 956 | 147 | 5 modules under `ops/mediaDedupe/` | 302 |
| `packages/cli/src/commands/ops/migrate.ts` | 857 | 124 | 5 modules under `ops/migrate/` | 302 |
| `packages/cli/src/commands/ops/tree-hygiene.ts` | 808 | 8 | 5 modules under `ops/treeHygiene/` | 409 |
| `packages/cli/src/commands/ops/verify.ts` | 787 | 184 | 5 modules under `ops/verify/` | 278 |
| `packages/cli/src/commands/ops/integrate-batch.ts` | 730 | 155 | 5 modules under `ops/integrateBatch/` | 177 |
| `packages/cli/src/commands/ops/pronounce/audit.ts` | 731 | 279 | `auditRules.ts`, `auditReport.ts`, `lexiconLoader.ts` | 335 |
| `packages/cli/src/commands/ops/pronounce/lookup.ts` | 691 | 271 | `lookupCache.ts`, `lookupProviders.ts` | 341 |

### Domain Breakdown Summary

1. **15 Record & Audio Clients (`clients/{seArchives,vaArchives,mnArchives,fiArchives,njArchives,narrativeAudio,caArchives,ukArchives,kyArchives,moArchives,texasArchives,michiganology,gnis,wikitree,persi}/`)**: Each client separates pure domain types/validators/parsers (`domain.ts`, `parsers.ts`, `catalog.ts`, `script.ts`), external HTTP/curl/Playwright/TTS/disk adapters (`transport.ts`, `synthesis.ts`), CLI option/help definitions (`cliSpecs.ts`), and subcommand handlers (`commands.ts` or split `searchCommands.ts`/`resourceCommands.ts` & `chanceryCommands.ts`/`collectionCommands.ts`) behind a `< 125` LOC facade reusing `records/runtime/{primitives,parse}.ts`.
2. **8 CLI Ops Modules (`ops/{auditOverlaps,mediaDedupe,migrate,treeHygiene,verify,integrateBatch}/` & `ops/pronounce/`)**: Each ops domain isolates pure rules/planners/rewriters/SQL parsers (`detectors.ts`, `merge.ts`, `rewrite.ts`, `sqlParser.ts`, `dates.ts`, `classifiers.ts`, `checks.ts`, `classify.ts`, `auditRules.ts`) from filesystem/D1/Wrangler/HTTP adapters (`loader.ts`, `io.ts`, `discovery.ts`, `d1Client.ts`, `mediaCheck.ts`, `snapshot.ts`, `executor.ts`, `lookupCache.ts`, `lookupProviders.ts`, `lexiconLoader.ts`) and text/JSON report renderers (`report.ts`, `auditReport.ts`).

## Post-Iteration 3B Scores

| Axis | Post-It. 3A (Repo-Wide) | Post-It. 3B (It. 3B Scope) | Post-It. 3B (Repo-Wide) | Key Drivers & Remaining Gaps |
| --- | :---: | :---: | :---: | --- |
| **Decoupling** | 9.2 / 10 | **9.8 / 10** | **9.6 / 10** | Every CLI record client and ops command now depends on narrow typed domain/transport/report seams and shared `records/runtime/` primitives; 0 circular imports across all 238 non-test files in `packages/cli/src/commands/`. |
| **Cohesion** | 9.2 / 10 | **9.8 / 10** | **9.6 / 10** | Every CLI module owns one bounded responsibility (parsers vs transport vs CLI specs vs handlers; pure audit/dedupe/migration rules vs disk/D1/HTTP adapters). |
| **Data flow** | 9.3 / 10 | **9.7 / 10** | **9.6 / 10** | Uniform `CLI Parse -> Pure Validation/Parsing -> Cached Transport/Adapter -> Domain Projection -> Output` and `Load -> Pure Plan/Check -> Atomic Write/Rollback -> Report` pipelines across all CLI commands. |
| **Layering** | 9.5 / 10 | **9.9 / 10** | **9.7 / 10** | Zero network, subprocess, or filesystem side effects leak into pure parser/domain/rule modules; SSRF URL policy cleanly separated from HTTP/curl transport; `pronounce/lexiconLoader.ts` eliminates the last ops module cycle. |
| **Modularity** | 9.1 / 10 | **9.9 / 10** | **9.6 / 10** | Zero non-test files `>= 650` LOC remain anywhere in `@kinloom/cli` (max `644` LOC across the entire CLI package, max `525` LOC across Iteration 3B) or `@kinloom/worker`. Only 4 core/server files remain above `950` LOC repo-wide. |
| **Extensibility** | 9.3 / 10 | **9.8 / 10** | **9.6 / 10** | Adding a new regional archive client, record subcommand, ops check, or pronunciation provider now composes directly over `records/runtime/{primitives,parse,urlPolicy,http}.ts` and small single-purpose modules. |

## Iteration 3C Changes (Final Core, Server & UI Modules Below 750 LOC)

Measured at commit `9280285` before decomposition (`6,977` LOC across all 7 remaining non-test files above `750` LOC repo-wide) and verified on `2026-11-27` (UTC via Python) with zero `any`, `@ts-ignore`, or `@ts-expect-error` escape hatches, 0 circular imports across `packages/core/src/`, `packages/server/src/`, and `packages/ui/src/`, 0 Biome errors/warnings, and 100% backward-compatible exports across all 7 facades. Every non-test TypeScript/TSX file across the entire monorepo is now strictly `< 750` LOC (repo-wide max: `742` LOC in `packages/ui/src/components/tree/TreeOrthogonalCanvas.tsx`).

### Iteration 3C Before/After LOC Table

| Target Module | Before LOC | After Entrypoint LOC | Extracted Submodules | Max Submodule LOC |
| --- | ---: | ---: | --- | ---: |
| `packages/server/src/testing/adapterContractSuite.ts` | 1,332 | 34 | 5 modules under `testing/contract/` | 422 |
| `packages/core/src/patchArchive.ts` | 1,098 | 92 | 3 modules under `core/src/patch/` | 459 |
| `packages/core/src/gedcom/slice.ts` | 1,028 | 77 | 4 modules under `core/src/gedcom/slice*.ts` | 445 |
| `packages/server/src/adapters/inMemory.ts` | 964 | 230 | 4 modules under `adapters/inMemory/` | 360 |
| `packages/core/src/schemas/pronunciation.ts` | 897 | 24 | 3 modules under `core/src/schemas/pronunciation*.ts` | 553 |
| `packages/ui/src/components/ArchivalMarkdown.tsx` | 859 | 231 | 3 modules under `components/markdown/` | 284 |
| `packages/ui/src/components/Atoms.tsx` | 799 | 10 | 4 modules under `components/atoms/` | 421 |

### Domain Module Breakdown

1. **Backend Adapter Contract Suite (`packages/server/src/testing/adapterContractSuite.ts` & `testing/contract/`)**:
   - `adapterContractSuite.ts` (`1,332` -> `34` LOC): Thin Vitest suite coordinator re-exporting all 9 fixtures, types, and `runBackendAdapterContractTests`.
   - `contract/{harness,entityAndPrivacyContract,batchAndRevisionContract,mediaContract,authAndTokenContract}.ts` (`106`-`422` LOC): Separates synthetic fixtures/cookies/clock harness from entity CRUD & living-person privacy tests, multi-op rollback & >100-entity zero-N+1 batch tests, SHA-256 & HTTP 206 range media tests, and OAuth/magic-link/rate-limit/agent-token tests.
2. **Incremental Bundle Patcher (`packages/core/src/patchArchive.ts` & `core/src/patch/`)**:
   - `patchArchive.ts` (`1,098` -> `92` LOC): Thin pure orchestration facade (`applyPatchMutation` -> 5 incremental reconcilers -> immutable `ArchiveBundle` assembly).
   - `patch/{patchState,entityMutators,reconcilers}.ts` (`258`-`459` LOC): Isolates lazy-indexed `PatchWorkingState` and dirty-tracking sets, per-entity mutation appliers with shared primary-source resolution, and O(affected) post-mutation reconcilers (newly living redaction, affected media cleanup, place ancestor/proximity spans, event/media counts & portraits, and residence span splicing).
3. **GEDCOM Lineage Slicer (`packages/core/src/gedcom/slice.ts` & `core/src/gedcom/slice*.ts`)**:
   - `slice.ts` (`1,028` -> `77` LOC): Clean pipeline facade (`parseGedcomText` -> `selectGedcomLineage` -> `buildPlacesFromRaw` -> `buildSlicePeople` -> `buildSliceKinship` -> `buildSliceEventsAndSources`).
   - `{sliceTypes,sliceTraversal,sliceNormalization,sliceBuilders}.ts` (`89`-`445` LOC): Separates option/result contracts, ancestor/sibling/descendant graph traversal, maiden-name/living-status/place normalization, and Kinloom entity emission with anomaly tracking.
4. **In-Memory Server Adapters (`packages/server/src/adapters/inMemory.ts` & `adapters/inMemory/`)**:
   - `inMemory.ts` (`964` -> `230` LOC): Mirrors `D1ArchiveRepository` by composing `InMemoryArchiveRepository` over two domain stores while re-exporting all adapter classes and `createInMemoryServerPorts`.
   - `inMemory/{entityAndMutationStore,accessAndTalkStore,bundleAndMediaStores,authAndEmailFakes}.ts` (`73`-`360` LOC): Separates atomic clone-and-swap entity/revision persistence, talk/user/invite/magic-link/agent-token persistence, snapshot extraction + bundle cache + byte-range media + lexicon stores, and OAuth/email test doubles.
5. **Pronunciation Bounded Context (`packages/core/src/schemas/pronunciation.ts` & `pronunciation*.ts`)**:
   - `pronunciation.ts` (`897` -> `24` LOC): Pure backward-compatible barrel preserving all 18 exported schemas, types, and functions.
   - `{pronunciationSchema,pronunciationPhonetics,pronunciationResolve}.ts` (`65`-`553` LOC): Separates Zod contracts/types, IPA validation/lexicon merging/tokenization helpers, and compositional person/place resolution; `pronunciationGeo.ts` imports `Pronunciation` directly from `pronunciationSchema.ts` for strict acyclicity.
6. **Archival Markdown Renderer (`packages/ui/src/components/ArchivalMarkdown.tsx` & `components/markdown/`)**:
   - `ArchivalMarkdown.tsx` (`859` -> `231` LOC): Clean block renderer composing pure parser, popover hook, and inline renderer (all 4 files `< 285` LOC).
   - `markdown/{archivalMarkdownParser,archivalInlineRenderer,useCitationPopover}.ts` (`207`-`284` LOC): Separates React-free block AST/entity-matcher parsing, inline token/citation/mention React rendering, and citation popover hover/focus/pin lifecycle state.
7. **UI Atom Primitives (`packages/ui/src/components/Atoms.tsx` & `components/atoms/`)**:
   - `Atoms.tsx` (`799` -> `10` LOC): Pure backward-compatible barrel preserving all 9 exported utilities and components.
   - `atoms/{formatters,ArchivalPrimitives,ArchivalPhotoFrame,SourceCitationTag}.ts(x)` (`58`-`421` LOC): Separates React-free `initialsOf`/`resolveAssetUrl` formatters, compact display primitives, photo zoom lightbox frame, and expandable source citation/discrepancy card list with scan lightbox (trimming unused CSS module imports per component).

## Pre-Review 6-Axis Readiness Summary (Iteration 4 Fresh-Eyes Gate)

| Axis | Post-It. 3B (Repo-Wide) | Post-It. 3C Readiness (Repo-Wide) | Evidence Across `@kinloom/{core,server,worker,cli,ui}` |
| --- | :---: | :---: | --- |
| **Decoupling** | 9.6 / 10 | **9.9 / 10 (pre-review)** | Every core engine, server service/adapter/contract suite, worker D1 store, CLI command/client, and UI page/component depends on narrow typed ports and domain seams with 0 circular imports across all decomposed packages. |
| **Cohesion** | 9.6 / 10 | **9.9 / 10 (pre-review)** | All 52 original monoliths across Iterations 1, 2A, 2B, 3A, 3B, and 3C now own one clear bounded context per file (schemas vs phonetics vs resolution; parser vs traversal vs builders; pure state vs mutators vs reconcilers; pure markdown AST vs popover state vs React renderers). |
| **Data flow** | 9.6 / 10 | **9.8 / 10 (pre-review)** | Deterministic unidirectional pipelines across archive compilation/patching, GEDCOM slicing, HTTP routing, atomic D1/InMemory commits, CLI sync/integrate/audit/records, and UI view-model projections. |
| **Layering** | 9.7 / 10 | **9.9 / 10 (pre-review)** | Strict hexagonal separation preserved end-to-end: `@kinloom/core` stays runtime-agnostic and pure, `@kinloom/server` stays portable Web Fetch, `@kinloom/worker` isolates Cloudflare D1/R2, `@kinloom/cli` isolates external HTTP/disk/subprocess adapters from pure domain rules, and `@kinloom/ui` separates pure view-models/formatters/parsers from React views. |
| **Modularity** | 9.6 / 10 | **9.9 / 10 (pre-review)** | **0** non-test TS/TSX files `>= 750` LOC remain repo-wide (down from `4,103` LOC max at baseline to `742` LOC max repo-wide); **0** CSS modules `>= 700` LOC remain; every Iteration 3C facade is `10`-`231` LOC and every extracted submodule is `58`-`553` LOC. |
| **Extensibility** | 9.6 / 10 | **9.9 / 10 (pre-review)** | Adding a backend contract domain, patch reconciler, GEDCOM slice builder, pronunciation policy rule, HTTP route group, entity form kind, CLI archive client, or UI primitive targets one small module with zero modification of god-files. |

Ready for **Iteration 4 independent fresh-eyes `10/10` architectural review**.

## Fresh-Eyes Independent Review #1 (`14b8fdd`) & Iteration 4A Remediation (Core, Server & Worker)

Evaluated on `2026-11-27` (UTC via Python `datetime.now(timezone.utc)`) against commit `14b8fdd`. Fresh-Eyes Review #1 identified concrete layering, port-segregation, runtime-purity, and type-safety findings across `@kinloom/core`, `@kinloom/server`, and `@kinloom/worker`. Iteration 4A resolved every Core, Server, and Worker finding while preserving 100% backward compatibility across public exports and keeping all `dist/` outputs rebuilt in place.

### Findings Remediated in Iteration 4A

| Review Finding | Root Cause Before Iteration 4A | Measured Fix in Iteration 4A |
| --- | --- | --- |
| **#2 Reverse-layer import** | `packages/server/src/services/bundleReadService.ts` imported `extractCollectionsFromSnapshot` upward from `../adapters/inMemory.js` (and `worker/src/adapters/r2BundleCache.ts` pulled it through `@kinloom/server`). | Moved `extractCollectionsFromSnapshot` into `packages/core/src/compile/snapshot.ts` (re-exported from `@kinloom/core` and `packages/server/src/index.ts`). `rg 'adapters/inMemory' packages/server/src/services packages/worker/src` = `0`. |
| **#3 Portable `/privacy` & `/og/*` + `PronunciationService`** | `packages/worker/src/index.ts` intercepted `/privacy` and `/og/*` inline, `packages/worker/src/ogCard.ts` typed `repository` against concrete `D1ArchiveRepository`, and `router.ts` passed raw `KinloomServerPorts` to `createPronunciationRouteHandler`. | Moved `renderPrivacyPolicyHtml` and `handleDynamicOgRequest` into `packages/server/src/http/routes/privacyAndOgRoutes.ts` typed strictly against `Pick<EntityReadStore, 'getEntity'>`, wired them into `createKinloomServer` before auth resolution, thinned `packages/worker/src/index.ts` (`337` -> `164` LOC), and extracted `PronunciationService` (`packages/server/src/services/pronunciationService.ts`) so zero HTTP route handlers receive raw `KinloomServerPorts`. `rg 'D1ArchiveRepository' packages/server/src packages/worker/src/ogCard.ts` = `0`. |
| **#4 & #6 Port segregation, unified `KinloomServerPorts`, `AdminDataSource`, & D1 composition** | `ArchiveRepository` was a 36-method monolithic interface; `KinloomServerPorts` was split between `core/src/contracts.ts` and `server/src/ports.ts`; `AdminPage` lacked an `AdminDataSource` contract; `d1Repository.ts` had 185 LOC of 1-line delegation methods. | Segregated `ArchiveRepository` into `EntityReadStore`, `AtomicMutationStore`, `RevisionLogStore`, `TalkCommentStore`, and `AccessControlStore` and narrowed every Layer 2 service and `authMiddleware.ts` to only its required sub-ports; unified `PronunciationAudioGenerator`, `PronunciationLexiconStore`, and `KinloomServerPorts` in `packages/core/src/contracts.ts` (deleting `packages/server/src/ports.ts`); added `AdminDataSource` (+ optional `admin` sub-port on `ArchiveDataSource`, wired on `HttpWikiDataSource`); replaced `d1Repository.ts` pass-through methods with `createD1ArchiveRepository` store composition (`185` -> `58` LOC). |
| **#10 Pure `@kinloom/core` boundaries** | `packages/core/src/oxlint/plugin.ts` bundled lint AST tooling inside `@kinloom/core`; `PrivacyViolationError` carried HTTP `status = 422`; `packages/core/src/privacy.ts` silently read `new Date().getUTCFullYear()`. | Moved `noHardcodedArchiveCountsRule` to `scripts/archive-count-rule.ts` (+ `scripts/check-archive-counts.test.ts`), removed `packages/core/src/oxlint/` and `./oxlint-plugin` export; removed HTTP `status` from `PrivacyViolationError` and mapped HTTP `422` inside `packages/server/src/errors.ts`; removed all `new Date()` calls from `packages/core/src/privacy.ts` (`0` matches), making `referenceYear` explicit and passing `Clock.currentYear()` at server/worker boundaries and `getCurrentReferenceYear()` at CLI boundaries. |
| **#11a, #12b, #13d Zero `as unknown as`, canonical `ENTITY_ID_PREFIX`, & `compileArchive` split** | 26 `as unknown as` casts existed across `core/src`, `server/src`, and `worker/src`; `ENTITY_ID_PREFIX` was local to `payloadPolicy.ts`; `entity_type` switch ladders existed in `core` and `server`; `compileArchive.ts` was `736` LOC. | Exported canonical `ENTITY_ID_PREFIX`, `buildEntityId()`, `toEntityPayload()`, and `storedRecordToEntityPayload()` from `@kinloom/core`; split `redactSingleRawPerson` / `redactCompiledPerson` and `sanitizeRawEventForWrite` / `sanitizeCompiledEventForWrite` in `privacy.ts`; added D1 boundary row parsers in `packages/worker/src/adapters/d1/rowMappers.ts`; replaced `entity_type` switch ladders in `core` and `server` with typed dispatch maps; decomposed `packages/core/src/compileArchive.ts` (`736` -> `220` LOC) into `compile/{types,snapshot,enrichment,mediaAndStats}.ts` (`83`-`262` LOC). `rg 'as unknown as' packages/core/src packages/server/src packages/worker/src --glob '!*.test.*'` = `0`. |

### Iteration 4A Measured Verification Snapshot

- `rg 'as unknown as' packages/core/src packages/server/src packages/worker/src --glob '!*.test.*'`: **`0` matches**
- `rg 'adapters/inMemory' packages/server/src/services packages/worker/src`: **`0` matches**
- `rg 'D1ArchiveRepository' packages/server/src packages/worker/src/ogCard.ts`: **`0` matches**
- `rg 'new Date' packages/core/src/privacy.ts`: **`0` matches**
- `rg 'status = 422' packages/core/src`: **`0` matches**
- Explicit `any`, `@ts-ignore`, `@ts-expect-error` across `packages/{core,server,worker}/src` (non-test): **`0` matches**
- `npx biome check --reporter=summary .`: **`0` errors, `0` warnings** across `677` files
- `npm run check`: `lint` + `check:counts` (`614` files, `0` violations) + in-place `build` (`6/6` workspaces) + `typecheck` (`7/7` tsconfigs) + Vitest (`99/99` files, `737/737` tests) + `check:contrast` (`15/15`) + `check:leaks` (`0` leaks)
- `npm run test:e2e`: **`40/40` Playwright E2E tests passed**
- External leak check (`check-kinloom-leaks.sh`): **`0` leaks** across `11` external blocklist terms

## Iteration 4B Remediation (UI Layering, CSS Ownership, Editor State, & Plugin Seams)

Evaluated on `2026-11-27` (UTC via Python `datetime.now(timezone.utc)`) on top of Iteration 4A (`9c698b2`). Iteration 4B resolved every `@kinloom/ui` finding from Fresh-Eyes Review #1 (`#4`, `#5`, `#8`, `#12a`, `#13a/b/c/e`) while preserving 100% public export parity in `packages/ui/src/index.ts`, zero edits to `packages/cli`, and in-place builds of `packages/*/dist`.

### Findings Remediated in Iteration 4B

| Review Finding | Root Cause Before Iteration 4B | Measured Fix in Iteration 4B |
| --- | --- | --- |
| **#4 `instanceof HttpWikiDataSource` leak** | `AdminPage.tsx` and `AuthSignInFlow.tsx` imported concrete `HttpWikiDataSource` and narrowed with `instanceof`; `ArchiveDataContext.tsx` lacked an `adminDataSource` port and carried an `as unknown` cast. | Exposed `adminDataSource: AdminDataSource \| null` from `ArchiveDataContext.tsx` (removing the `as unknown` cast), typed `AdminPage.tsx` strictly against `AdminDataSource`, replaced `instanceof` in `AuthSignInFlow.tsx` with a structural `hasGoogleSignInUrl` guard, and proved plain-object `ArchiveDataSource.admin` wiring in `AdminPage.test.tsx`. `instanceof HttpWikiDataSource` across `packages/ui/src` = `0`. |
| **#5 Pure `lib/` and `*ViewModel.ts` boundaries** | `packages/ui/src/lib/` mixed React hooks (`useDialogFocusTrap.ts`, `keyboardNav.ts`) and browser/MapLibre adapters (`clientTelemetry.ts`, `ohmStyle.ts`) alongside pure functions; `personViewModel.ts` touched `document` and `URL.createObjectURL`. | Relocated browser adapters into `packages/ui/src/browser/{clientTelemetry,ohmStyle,download,motion}.ts` and React/DOM hooks into `packages/ui/src/hooks/{useDialogFocusTrap,keyboardNav}.ts`; moved `triggerPersonGedcomDownload` out of `personViewModel.ts`; kept `packages/ui/src/index.ts` re-exports intact. Forbidden framework/browser imports or globals in `packages/ui/src/lib/` and `*ViewModel.ts` = `0`. |
| **#8 CSS ownership, reverse-layer imports, & module spreads** | `23` component files imported `pages/*.module.css` upward; `39` files spread multiple CSS modules into flat `uiStyles` grab-bag objects; `TimePage.module.css` (`665` LOC), `Atoms.module.css` (`689` LOC), and `TreePage.module.css` (`609` LOC) held shared primitives. | Extracted shared primitives into `styles/{Controls,Overlays}.module.css` and co-located component styles (`LocalSurveyMap.module.css`, `MilestoneStoryCard.module.css`, `tree/{TreeCanvas,TreeToolbar}.module.css`, `time/TimeScrubber.module.css`); deduplicated `.wiki-role-chip:global(.is-self)` into `WikiChrome.module.css` (`0` duplicate local classes across `37` CSS modules, `745` classes); added `joinClasses` to `lib/cx.ts` and migrated all `73` TSX files to direct CSS module references (`0` reverse imports in `components/`, `0` multi-CSS-module spreads, `0` class-owner mismatches). |
| **#12a `EntityEditDrawer` shadow state & canonical ID prefixes** | `EntityEditDrawer.tsx` kept 5 parallel `useState` flags (`syncingRevision`, `deleteConfirmOpen`, `deleteSummary`, `deleteBusy`, `deleteError`) and a `getEntity` `useEffect` outside `entityEditorMachine`; `createRegistry.tsx` hardcoded `pl_` instead of `ENTITY_ID_PREFIX.place` (`plc_`). | Moved `syncingRevision`, `confirmingDelete`, `deleting`, and `deleted` states plus `loadLatestEntity` and `deleteEntity` actors into `entityEditorMachine.ts` (with extracted `machines/entityEditor/{types,actors,reducers}.ts`), removing all 5 `useState` shadow states from `EntityEditDrawer.tsx`; switched `createRegistry.tsx` and `fieldTypes.ts` to canonical `buildEntityId` from `@kinloom/core` (`plc_`, `evt_`, `per_`), verified in `machines.test.ts` and `uiViewModels.test.ts`. |
| **#13a/b/c/e Large UI decomposition & plugin-open entity forms** | `12` non-test TS/TSX files and `3` CSS modules exceeded `550` LOC (up to `743` LOC); `entityEditForms` and `entityCreateForms` registries were closed to `KinloomUiPlugin`. | Decomposed all `12` large TS/TSX files plus `TimePage.tsx` into focused domain/view-model/UI submodules (every non-test TS/TSX and CSS file in `packages/ui/src/` is now strictly `< 550` LOC; max `544` LOC across `184` files); opened `entityEditForms` and `entityCreateForms` on `KinloomUiPlugin`, merged them in `PluginContext.tsx`, consumed them in `EntityEditDrawer.tsx` and `CreateEntityModal.tsx`, and proved plugin registration in `PluginsAndMedia.test.tsx`. |

### Iteration 4B Before/After LOC Table

| Target UI Module | Before LOC (`9c698b2`) | After LOC | Extracted Submodules |
| --- | ---: | ---: | --- |
| `packages/ui/src/components/tree/TreeOrthogonalCanvas.tsx` | 743 | 153 | `components/tree/{TreeEdgesLayer,TreeNodesLayer}.tsx`, `TreeCanvas.module.css` |
| `packages/ui/src/machines/authSessionMachine.ts` | 721 | 491 | `machines/authSession/{types,actors}.ts` |
| `packages/ui/src/lib/tree/treeGraphBuilder.ts` | 712 | 290 | `lib/tree/{generationInference,unionAssembly}.ts` |
| `packages/ui/src/pages/AdminPage.tsx` | 691 | 319 | `pages/admin/{adminHelpers.ts,MembersSection.tsx,InvitesSection.tsx,AgentTokensSection.tsx}` |
| `packages/ui/src/components/Atoms.module.css` | 689 | 484 | Shared controls & overlays moved to `styles/{Controls,Overlays}.module.css` |
| `packages/ui/src/pages/TimePage.module.css` | 665 | 436 | `pages/time/TimeScrubber.module.css` |
| `packages/ui/src/pages/PlacePage.tsx` | 640 | 296 | `pages/place/{placeViewModel.ts,PlaceSections.tsx}` |
| `packages/ui/src/plugins/narrativeAudioPlugin.tsx` | 622 | 105 | `plugins/narrativeAudio/{audioContext,NarrativeAudioPlayers}.tsx` |
| `packages/ui/src/components/SourceReaderDrawer.tsx` | 609 | 514 | `components/sourceReader/SourceReaderStage.tsx` |
| `packages/ui/src/pages/TreePage.module.css` | 609 | 136 | `components/tree/{TreeCanvas,TreeToolbar}.module.css` |
| `packages/ui/src/machines/mediaUploadMachine.ts` | 601 | 332 | `machines/mediaUpload/{types,actors}.ts` |
| `packages/ui/src/adapters/httpWikiDataSource.ts` | 579 | 446 | `adapters/httpWiki/{httpClient,adminClient}.ts` |
| `packages/ui/src/components/wiki/authErrorCopy.ts` | 572 | 214 | `components/wiki/authError/feedbackCatalog.ts` |
| `packages/ui/src/context/ArchiveDataContext.tsx` | 566 | 439 | `context/archiveDataHelpers.ts` |
| `packages/ui/src/pages/RecentChangesPage.tsx` | 564 | 352 | `pages/recentChanges/{recentChangesViewModel.ts,RevisionFeedItem.tsx}` |
| `packages/ui/src/pages/TimePage.tsx` | 545 | 477 | `pages/time/TimeEntryCards.tsx` |

### Iteration 4B Measured Verification Snapshot

- Reverse CSS imports (`pages/*.module.css` inside `packages/ui/src/components/`): **`0` matches**
- Multi-CSS-module object spreads (`{ ...aStyles, ...bStyles }`) in `packages/ui/src/`: **`0` matches**
- `instanceof HttpWikiDataSource` in `packages/ui/src/`: **`0` matches**
- Framework/browser globals in `packages/ui/src/lib/` and `*ViewModel.ts`: **`0` violations**
- Explicit `any`, `@ts-ignore`, `@ts-expect-error`, `as unknown as` in non-test `packages/ui/src/`: **`0` matches**
- Runtime or type circular imports across `packages/ui/src/`: **`0` cycles**
- Max non-test file LOC across all `184` TS/TSX/CSS files in `packages/ui/src/`: **`544` LOC** (`0` files `>= 550` LOC)
- `npm run check`: `biome check` (`714` files, `0` errors, `0` warnings) + `check:counts` (`644` files, `0` violations) + in-place `build` (`6/6` workspaces) + `typecheck` (`7/7` tsconfigs) + Vitest (`100/100` files, `741/741` tests) + `check:contrast` (`15/15`) + `check:leaks` (`0` leaks)
- `npm run audit:impeccable`: **`PASS` (`0` primary findings across static source and live desktop/mobile routes)**
- `npm run test:e2e`: **`40/40` Playwright E2E tests passed**

## Iteration 4C Remediation (CLI Cycles, Declarative Registry, Deduplication, Type-Safety Polish, & CI Architecture Gate)

Evaluated on `2026-11-27` (UTC via Python `datetime.now(timezone.utc)`) on top of Iteration 4B (`da57f21`). Iteration 4C resolved every remaining finding from Fresh-Eyes Review #1 (`#1`, `#7`, `#9`, `#11b`, remaining entity-type switches, and repo-wide `<= 550` LOC polish) and codified all architectural invariants into an automated CI gate (`scripts/check-architecture.mjs`).

### Findings Remediated in Iteration 4C

| Review Finding | Root Cause Before Iteration 4C | Measured Fix in Iteration 4C |
| --- | --- | --- |
| **#1 CLI circular import SCC** | `plugins.ts` imported `CliIo` from `cli.ts`, forming a circular SCC across `cli.ts`, `plugins.ts`, `cli/types.ts`, and command dispatchers. | Extracted `CliIo` and `DEFAULT_IO` into zero-dependency leaf `packages/cli/src/io.ts` and plugin contracts into `packages/cli/src/pluginTypes.ts`; kept backward-compatible re-exports on `cli.ts` and `plugins.ts`. Tarjan SCC across all `575` non-test TS/TSX files: **`0` runtime cycles and `0` type-inclusive cycles**. |
| **#7 Single `BUILTIN_CLI_COMMANDS` registry & lazy record clients** | Four duplicated built-in command lists drifted (`isBuiltInCliCommand('media')` returned `false`); `records/registry.ts` statically imported all 23 record client modules on every CLI startup. | Built single declarative `BUILTIN_CLI_COMMAND_SPECS` / `BUILTIN_CLI_COMMANDS` (`cli/builtinCatalog.ts`, `cli/builtinCommands.ts`) from which `ROOT_HELP`, `COMMAND_HELP`, `CORE_CLI_COMMANDS`, `isBuiltInCliCommand()`, and `dispatchBuiltInCliCommand()` derive with compile-time exhaustiveness; converted all 23 `RECORD_COMMAND_SPECS` handlers to lazy dynamic `import()` thunks. Proven in `packages/cli/src/cliRegistry.test.ts` (`isBuiltInCliCommand('media') === true`, `0` static `./clients/*` imports in `registry.ts`). |
| **#9 Privacy, EDTF, YAML loading, & peer ops deduplication** | CLI duplicated ASCII-only living-name matching (`living-name-matcher.ts`) instead of using Unicode `\p{L}` boundaries and `edtfToBounds()`; 5 ops loaders duplicated `data/*.yaml` parsing; peer ops commands imported each other (`mediaDedupe/io.ts` -> `audit-overlaps.ts`, `integrate.ts`, `verify.ts`, plus `migrate` -> `sync`, `audit` -> `context`/`integrate`). | Moved year-aware Unicode living-name matching into `@kinloom/core` (`packages/core/src/privacy/livingNameMatcher.ts`, using `\p{L}` boundaries, `edtfToBounds()` via `edtfYearBounds()`, and explicit `referenceYear` with `0` ambient `new Date()`) and delegated `living-name-matcher.ts` to `@kinloom/core`, tested with Swedish/Finnish diacritics (`Å`, `Ä`, `Ö`) in `livingNameMatcher.test.ts`; unified local YAML loading into `loadLocalArchiveRepo()` / `loadLocalArchiveRepoSync()` in `packages/cli/src/commands/dataFiles.ts` across `verify/loader.ts`, `mediaDedupe/io.ts`, `shared/integrateEngine/execute.ts`, `status.ts`, and `sync/planner.ts`; extracted `packages/cli/src/commands/ops/shared/` (`bundlePrivacy`, `mediaFiles`, `stagedPackages`, `wrangler`, `yamlScanner`, `imageHeader`, `stagedOverlaps/`, `integrateEngine/`) so peer ops commands have **`0` cross-command imports**. |
| **#11b & Repo-wide `10/10` polish** | `11` `as unknown as` casts remained in non-test CLI files; `dataFiles.ts` and `submitBatch.ts` kept `switch (entityType)` ladders; `24` non-test TS/TSX files exceeded `550` LOC (including `timeSnapshot.ts` at `695` LOC and `privacy.ts` at `742` LOC). | Replaced all `11` `as unknown as` casts with Zod boundary schemas and typed builders (`0` `as unknown as`, `0` `any`, `0` `@ts-ignore`, `0` `@ts-expect-error`, `0` `eslint-disable` across all `575` non-test TS/TSX files); replaced entity-type switch ladders in `dataFiles.ts` and `submitBatch.ts` with exhaustive `Record<..., ...>` lookup tables; decomposed `timeSnapshot.ts` (`695` -> `452` LOC + `placesDirectory.ts`), `privacy.ts` (`742` -> `64` LOC + `privacy/{policy,redaction,livingNameMatcher}.ts`), `gedcom/export.ts`, `brandkit.ts`, `contracts.ts`, `geoMap.ts`, `pronunciationResolve.ts`, `batchCompiler.ts`, `atomicMutationStore.ts`, and all `16` remaining `> 550` LOC CLI submodules so **every non-test TS/TSX file across the entire monorepo is `<= 550` LOC (repo-wide max: `549` LOC)**. |
| **Automated CI architecture gate** | Architectural invariants were checked manually during reviews. | Added `scripts/check-architecture.mjs` (`npm run check:arch`), wired into `npm run check` and `.github/workflows/ci.yml`, enforcing all 7 structural invariants automatically on every build/PR. |

### Iteration 4C Measured Verification Snapshot

- Non-test TS/TSX files across `packages/*` and `examples/demo/src`: **`575` files, max `549` LOC (`0` files `> 550` LOC)**
- `npm run check:arch`: **`PASS` (`0` violations across `575` files: `0` runtime cycles, `0` type cycles, `0` reverse-layer imports, `0` pure-UI leaks, `0` `instanceof HttpWikiDataSource`, `0` CSS module spreads, `0` escape hatches, `0` static record-client imports in `registry.ts`, `0` ambient `new Date()` in `privacy`)**
- `npm run lint`: Biome **`0` errors, `0` warnings** across `775` files + `check:counts` **`0` violations** across `704` files
- `npm run build`: **`6/6` workspaces** built cleanly in place (`packages/*/dist` preserved)
- `npm run typecheck`: **`7/7` tsconfigs** (`0` errors)
- `npm test`: **`118/118` test files, `801/801` tests passed** (including `livingNameMatcher.test.ts` and `cliRegistry.test.ts`)
- `npm run check:contrast`: **`15/15` passed**
- `npm run check:leaks`: **`0` leaks**
- Live CLI smoke checks: `kinloom --help`, `kinloom status --help`, `kinloom media --help` all exit `0`

Ready for **Iteration 5 zero-context fresh-eyes `10/10` architectural review**.

## Fresh-Eyes Independent Review #2 (`4a7c1d4`) & Iteration 5A Remediation (Core, Server, Worker & CLI)

Evaluated on `2026-11-27` (UTC via Python `datetime.now(timezone.utc)`) on top of commit `4a7c1d4`. Iteration 5A resolved every Core, Server, Worker, and CLI finding from Fresh-Eyes Review #2 (`DF-1`, `E-3`, `DF-2`, `DF-3 Worker/CLI`, `D-2 Core Contracts`, `M-1`, `M-2 Core`) while keeping all `packages/*/dist` outputs rebuilt in place and leaving UI refactoring and CI gate expansion cleanly scoped to Iteration 5B.

### Findings Remediated in Iteration 5A

| Review Finding | Root Cause Before Iteration 5A | Measured Fix in Iteration 5A |
| --- | --- | --- |
| **DF-1 (P0) Dropped `pronunciations` in `patchCompiledBundle`** | `packages/core/src/patchArchive.ts` omitted `pronunciations` on non-empty incremental patches, diverging from `compileArchive.ts`. | Preserved `pronunciations` using `siteConfig.pronunciations` with `previousBundle.pronunciations` fallback and `structuredClone` in both empty and non-empty branches; added full-recompile parity and immutability regression tests in `packages/core/src/patchArchive.test.ts`. |
| **E-3 (P1) Prefix-stem interception & unvalidated server plugins** | `matchPluginRoute` in `packages/server/src/http/router.ts` used raw `pathname.startsWith(route.pathPrefix)` so `/api/foo` matched `/api/foobar`, and `createKinloomServer` did not reject duplicate plugin IDs or conflicting route prefixes. | Normalized plugin `pathPrefix` (trimming trailing `/` unless root `/`), enforced segment-boundary matching (`pathname === prefix \|\| pathname.startsWith(\`${prefix}/\`)`), and added startup validation rejecting empty/duplicate plugin IDs and overlapping/shadowed route prefixes for overlapping HTTP methods (`*` or equal method); verified in `packages/server/src/http/pluginRouter.test.ts`. |
| **DF-2 (P1) Duplicated EDTF parser in CLI chronology audit** | `packages/cli/src/commands/ops/audit/chronology.ts` maintained parallel `parseClosedEdtfPoint`/`parseAuditEndpoint`/`parseAuditEdtf` logic that also missed `192X` decade syntax. | Consolidated structured EDTF interval parsing (`ParsedEdtfPrecision`, `ParsedEdtfInterval`, `parseEdtfInterval`) into `packages/core/src/edtf.ts` (extracting pure calendar primitives to `packages/core/src/edtf/calendar.ts` so `edtf.ts` stays at `501` LOC), refactored `chronology.ts` (`423` -> `318` LOC) and `audit/types.ts` to consume `@kinloom/core`, and added open-interval, approximate, and `192X` decade tests in `packages/core/src/edtf.test.ts` and `packages/cli/src/commands/ops/ops.test.ts`. |
| **D-1 / D-2 Core Port Contracts (5B prep)** | UI layers lacked a port-level API error type guard and optional pronunciation/OAuth methods on `ArchiveDataSource`. | Added `ArchiveApiErrorShape`, `isArchiveApiError(err: unknown)`, `PronunciationLexicon`, `UpsertPronunciationTermResult`, `GeneratePronunciationAudioInput`, `GeneratedPronunciationAudioResult`, and optional `loadPronunciations?`, `upsertPronunciationTerm?`, `generatePronunciationAudio?`, and `getGoogleSignInUrl?` to `packages/core/src/contractsUi.ts` (exported from `@kinloom/core`), aligned `ApiClientError` via `implements ArchiveApiErrorShape`, and added unit tests in `packages/core/src/contractsUi.test.ts`. |
| **DF-3 (P1) Untyped D1 `.first<T>`/`.all<T>` reads & CLI `!` assertions** | `entityReadStore.ts`, `accessAndTalkStore.ts`, `atomicMutationStore.ts`, and `d1PronunciationLexiconStore.ts` trusted generic SQLite row casts without runtime parsing; `nara/browserFallback.ts` used two `page.waitForFunction!` non-null assertions. | Added runtime `parseDb*Row` boundary parsers for revisions, talk comments, users, invites, magic links, agent tokens, counts, author names, living projections, and pronunciation lexicon rows in `packages/worker/src/adapters/d1/rowMappers.ts` (`526` LOC), updated every `.first()`/`.all()` call across all four D1 stores to read `unknown` and parse (`0` unvalidated typed D1 calls remain), added `packages/worker/src/adapters/d1/rowMappers.test.ts`, and replaced both `waitForFunction!` assertions in `packages/cli/src/commands/records/clients/nara/browserFallback.ts` with explicit local bindings (`0` remaining). |
| **M-1 & M-2 (P2) Delegation boilerplate, unused layout engine, & trivial shims** | `InMemoryArchiveRepository` held 30 one-line delegation methods (`231` LOC); `packages/core/src/domain/treeLayout.ts` (`526` LOC) had 0 production callers; `packages/worker/src/ogCard.ts` (`1` LOC) and `packages/cli/src/commands/ops/living-name-matcher.ts` (`19` LOC) were trivial re-export shims. | Composed `InMemoryArchiveRepository` via `bindPrototypeMethods` + `createInMemoryArchiveRepository` (`231` -> `107` LOC) matching `createD1ArchiveRepository`; deleted unused `treeLayout.ts` and its orphaned tests; deleted `ogCard.ts` and `living-name-matcher.ts` and pointed callers directly to `@kinloom/server` and `@kinloom/core`. |

### Iteration 5A Measured Verification Snapshot

- Non-test TS/TSX files across `packages/*` and `examples/demo/src`: **`573` files, max `548` LOC (`0` files `> 550` LOC)**
- Unvalidated typed D1 `.first<T>`/`.all<T>` calls in `packages/worker/src/`: **`0` matches**
- Non-null `waitForFunction!` assertions in `packages/cli/src/commands/records/clients/nara/browserFallback.ts`: **`0` matches**
- `npm run build`: **`6/6` workspaces** built cleanly in place (`packages/*/dist` preserved)
- `npm run check:arch`: **`PASS` (`0` violations across `573` non-test TS/TSX files)**
- `npm run lint`: Biome **`0` errors, `0` warnings** across `776` files + `check:counts` **`0` violations** across `705` files
- `npm run typecheck`: **`7/7` tsconfigs** (`0` errors)
- `npm test`: **`121/121` test files, `810/810` tests passed**
- `npm run check:contrast`: **`15/15` passed**
- `npm run check:leaks`: **`0` leaks**
- Live CLI smoke check: `kinloom --help` exits `0`

Ready for **Iteration 5B (UI port adoption & CI architecture gate expansion)**.

## Iteration 5B Remediation (UI Port Isolation, CSS Ownership, Layout Primitives & Hardened CI Gate)

Evaluated on `2026-11-27` (UTC via Python `datetime.now(timezone.utc)`) on top of rebased Iteration 5A (`384c222`, cleanly rebased onto `b0288a3` preserving 100% of `#18` behavioral suites). Iteration 5B resolved every remaining Fresh-Eyes Review #2 finding across `@kinloom/ui`, `examples/demo`, Biome rules, and `scripts/check-architecture.mjs` (`D-1`, `D-2`, `D-3`, `C-1`, `C-2`, `DF-3 UI`, `DF-4`, `L-1`, `L-2`, `M-1 UI`, `M-2 UI`, `E-1`, `E-2`).

### Findings Remediated in Iteration 5B

| Review Finding | Root Cause Before Iteration 5B | Measured Fix in Iteration 5B |
| --- | --- | --- |
| **D-1 (P0) Raw `/api/pronunciations*` fetches outside adapters** | `ArchiveDataContext.tsx` and `pronunciationDraft.ts` called raw `fetch('/api/pronunciations...')` and `fetch('/api/pronunciation/generate')` with inconsistent `credentials: 'include'`, bypassing `apiBaseUrl` and `fetchImpl`. | Implemented `loadPronunciations`, `upsertPronunciationTerm`, and `generatePronunciationAudio` on `HttpWikiDataSource` using `credentials: 'same-origin'`, `apiBase`, and `fetchImpl`; routed `ArchiveDataContext.tsx`, `PronunciationEditorSection.tsx`, and `pronunciationDraft.ts` strictly through `ArchiveDataSource`. Raw `/api/` fetches outside `packages/ui/src/adapters/**` = `0`. |
| **D-2 (P0) Adapter imports & duck-typing in UI layers** | `mediaUpload/actors.ts` and `authErrorCopy.ts` imported `ApiClientError` from `adapters/httpWikiDataSource.js`; `AuthSignInFlow.tsx` duck-typed `getGoogleSignInUrl`. | Replaced `instanceof ApiClientError` with `isArchiveApiError(error)` from `@kinloom/core`, removed all `adapters/` imports from `machines/`, `components/`, and `pages/`, and called `dataSource.getGoogleSignInUrl?.(...)` directly in `AuthSignInFlow.tsx`. |
| **D-3 (P0) Drifted raw `/api/` fallbacks in XState actors** | `authSession/actors.ts`, `entityEditor/actors.ts`, and `mediaUpload/actors.ts` contained raw `fetch('/api/...')` fallback branches targeting non-existent or drifted endpoints (`/api/auth/google/verify`, `/api/media/attach`, wrong-contract `/api/auth/magic-link/verify`). | Deleted all raw `/api/` fetch fallbacks across all three XState actor modules so every actor executes I/O strictly through injected `ArchiveDataSource` port methods (or explicit actor overrides in tests). |
| **E-2 (P1) `CreateEntityModal` entity-kind mismatch & `!` assertion** | `CreateEntityModal.tsx` fell back via `createRegistry.entries.person!` while submitting under `kind`, silently posting a person payload under `'source'` or `'narrative'`. | Added `resolveSupportedKind` using `ENTITY_CREATE_FORM_REGISTRY.person` (zero `!`), submitted strictly under `activeCreateEntry.kind`, and added a regression test in `wikiEditorsBehavioral.test.tsx` proving `defaultKind="source"` and `"narrative"` never submit mismatched payloads. |
| **C-1, E-1, L-1 (P1) Cross-page CSS, atom-to-drawer CSS & plugin layout primitives** | `KinloomApp` and 6 pages imported `IndexPage.module.css`; `IndexPage` imported `PersonPage.module.css`; `SourceCitationTag` (atom), `MediaPlayer`, `CitationPopover`, and tabs imported `*Drawer.module.css`; `demoStoryPlugin.tsx` depended on unexported raw class names; `PersonPage` mobile portrait rules leaked into `narrativeAudioPlugin.module.css`. | Extracted shared layout rules into `styles/Layout.module.css`, citation card/tier rules into `styles/Citations.module.css`, scan lightbox rules into `styles/Overlays.module.css`, `.person-card-media-badge` into `components/Atoms.module.css`, and moved `PersonPage` mobile portrait grid rules into `PersonPage.module.css`; exported `ArchivalPageShell`, `ArchivalBanner`, `ArchivalMetrics`, `ArchivalSection`, `ArchivalMediaGrid`, and `ArchivalStoryCard` from `@kinloom/ui` (`components/ArchivalLayout.tsx`) and migrated `examples/demo/src/demoStoryPlugin.tsx` to them. |
| **DF-3 UI, DF-4, C-2, M-1 UI, M-2 UI (P1/P2)** | `HttpWikiDataSource.requestJson` cast responses with `as T`; 7 production `!` assertions remained repo-wide; `authSessionMachine.ts` had 0 production callers while `AuthSignInFlow.tsx` duplicated auth state in `useState`/`useEffect`; `HttpWikiDataSource` carried 10 redundant admin pass-through methods; `createStaticArchiveLoader` duplicated `StaticDemoDataSource`. | Added runtime boundary parsers (`adapters/httpWiki/responseParsers.ts`) to `HttpWikiDataSource` and `adminClient.ts` (raising `INVALID_API_RESPONSE` on schema drift); removed all 10 redundant admin pass-throughs on `HttpWikiDataSource` (keeping `readonly admin: AdminDataSource`); delegated `createStaticArchiveLoader` to `createStaticArchiveDataSource`; wired `authSessionMachine` (with extracted `machines/authSession/reducers.ts`) directly into `AuthSignInFlow.tsx` as single source of truth; eliminated all 7 production `!` assertions and enabled Biome `noNonNullAssertion: "error"` for non-test files. |
| **L-2 (P2) Hardened CI architecture gate** | `scripts/check-architecture.mjs` did not yet enforce `@kinloom/server` reverse-package imports, UI adapter leaks, raw UI `/api/` fetches, cross-page CSS imports, atom-to-drawer CSS imports, or `@ts-nocheck`. | Extended `scripts/check-architecture.mjs` to enforce all 5 new invariants plus `@ts-nocheck`, and enabled Biome `style/noNonNullAssertion: "error"` across all non-test files. |

### Iteration 5B Measured Verification Snapshot

- Non-test files across `packages/*/src` and `examples/demo/src`: **`618` total (`576` TS/TSX max `548` LOC, `42` CSS max `523` LOC, `0` files `> 550` LOC)**
- Production non-null assertions (`!`) across all non-test files: **`0`** (enforced by Biome `style/noNonNullAssertion: "error"`)
- `npm run check:arch`: **`PASS` (`0` violations across `576` non-test TS/TSX files)**
- `npm run lint`: Biome **`0` errors, `0` warnings** across `786` files + `check:counts` **`0` violations** across `713` files
- `npm run build`: **`6/6` workspaces** built cleanly in place (`packages/*/dist` preserved)
- `npm run typecheck`: **`7/7` tsconfigs** (`0` errors)
- `npm test`: **`126/126` test files, `831/831` tests passed** (preserving 100% of `#18` behavioral suites plus new Iteration 5B regression tests)
- `npm run check:contrast`: **`15/15` passed**
- `npm run check:leaks`: **`0` leaks**
- `npm run audit:impeccable`: **`PASS` (`0` primary findings across static source, 16 desktop routes, and 16 mobile routes)**
- `npm run test:e2e`: **`40/40` Playwright E2E tests passed**

Ready for **Iteration 6 independent zero-context fresh-eyes `10/10` architectural review**.

## Fresh-Eyes Independent Review #3 (`f417edf`) & Iteration 6 Remediation (All 10 Surgical Items)

Evaluated on `2026-11-27` (UTC via Python `datetime.now(timezone.utc)`) on top of commit `f417edf`. Fresh-Eyes Review #3 scored **Decoupling `9/10`, Cohesion `10/10`, Data flow `7/10`, Layering `9/10`, Modularity `9/10`, Extensibility `9/10`**, leaving 10 surgical items across Data flow (`DF1`–`DF4`), Decoupling (`D1`–`D2`), Layering (`L1`), Modularity (`M1`), and Extensibility (`E1`–`E2`). Iteration 6 remediated all 10 items cleanly in place while preserving `packages/*/dist` and every verified invariant.

### Findings Remediated in Iteration 6

| Review Finding | Root Cause Before Iteration 6 | Measured Fix in Iteration 6 |
| --- | --- | --- |
| **DF1: Shadow auth state & unreachable machine states** | `ArchiveDataContext.tsx` tracked `liveSession`, `liveCapabilities`, and `liveAuthProviders` in shadow `useState`; `AuthSignInFlow.tsx` spawned an isolated `useMachine(authSessionMachine)` and shadow `urlError` state; `AuthSessionActorContext` had 0 production callers; `authSessionMachine.ts` kept unreachable client states (`signingInGoogle`, `verifyingMagicLink`). | Mounted one shared `authSessionMachine` actor at `ArchiveDataProvider` via `AuthSessionActorContext`, derived `session`, `capabilities`, and `authProviders` from `deriveSessionFromAuthSnapshot`, routed `refreshSession`, `SIGN_OUT` (from `ExplorerTopBar.tsx` via `signingOut`), and magic-link/`SET_URL_ERROR` events (from `AuthSignInFlow.tsx`) through that single actor, eliminated all shadow auth `useState` hooks, and removed unreachable client-side redirect states so 100% of machine states represent real production transitions. |
| **DF2: Unvalidated HTTP/Static archive, checklist & revision parsers** | `HttpWikiDataSource.loadArchive()` cast `raw as ArchiveBundle` after only checking `meta`; `loadMediaChecklist()` cast `raw.items as MediaChecklistItem[]`; `parseRevisionLike()` silently defaulted invalid enums to `'person'`/`'update'`/`'human'` and missing strings to `''`. | Exported `MediaChecklistItemSchema` from `packages/core/src/schemas/entities.ts` (`@kinloom/core`); validated `loadArchive()` with `ArchiveBundleSchema.parse(raw)` and `loadMediaChecklist()` items with `MediaChecklistItemSchema` in both `HttpWikiDataSource` and `StaticDemoDataSource`; made `parseRevisionLike()` strictly validate all enums and required fields (throwing `INVALID_API_RESPONSE` on drift) with unit tests in `httpWikiDataSource.test.ts` and `adaptersBehavioral.test.ts`. |
| **DF3: Unchecked cached R2 bundle decode in `commitPipeline.ts`** | `refreshBundleCache()` decoded cached R2 JSON with raw `JSON.parse(...) as ArchiveBundle`, turning truncated or schema-invalid cached R2 JSON into HTTP 500 after D1 commit succeeded. | Wrapped cached R2 bundle JSON decoding and `ArchiveBundleSchema.safeParse(...)` validation in `try/catch` (with stream cancellation on unused streams) so any corrupt or invalid cached bundle falls through cleanly to `loadActiveSnapshot()` + `rebuildAndStore()`; verified in `packages/server/src/services/wikiWrite/commitPipeline.test.ts`. |
| **DF4: Unvalidated `JSON.parse` in `JsonFallbackEditFields`** | `JsonFallbackEditFields` cast `JSON.parse(e.target.value) as EntityPayload` and called `replaceDraft(...)` even for primitives or arrays (`123`, `"abc"`, `[]`). | Validated parsed JSON with `EntityPayloadSchema.safeParse(...)` before calling `replaceDraft`, preserving local raw textarea input and displaying an accessible `role="alert"` validation error without mutating `draft` on non-object JSON; verified in `packages/ui/src/plugins/PluginsAndMedia.test.tsx`. |
| **D1: Hardcoded `api/client-error` telemetry transport** | `packages/ui/src/browser/clientTelemetry.ts` hardcoded `${normalized}api/client-error` and posted unconditionally via `sendBeacon`/`fetch`, causing 404 POSTs on static sites. | Removed hardcoded `api/client-error` construction and default network requests; added injectable `ClientTelemetryOptions` (`endpoint?: string`, `transport?: (payload: string) => void`) to `installGlobalErrorHandlers` and `reportClientError` (defaulting to zero network traffic unless explicitly opted in by host config); verified in unit tests and Playwright E2E. |
| **D2: Hardcoded `/api/auth/google/start` fallback in `AuthSignInFlow.tsx`** | `buildGoogleUrl()` fell back to a hardcoded `/api/auth/google/start?...` URL when `dataSource.getGoogleSignInUrl` was absent. | Deleted the hardcoded fallback in `AuthSignInFlow.tsx` (and aligned lead copy in `PrivateArchiveGate.tsx`) so Google sign-in links render only when `dataSource.getGoogleSignInUrl` is provided and returns a URL; verified in `AuthUnhappyPaths.test.tsx`. |
| **L1: Shared pronunciation layer & hardened `check-architecture.mjs`** | `pronunciation-checks.ts` imported `pronounce.ts`; `SHARED_OPS_OWNERS` skipped outbound peer-ops checks and kept stale `'livemediacollisions'`; Tarjan SCC ignored dynamic `import(...)` edges; `no-raw-ui-api-fetch` only caught literal `fetch('/api/...')`. | Extracted shared pronunciation lexicon loader, deduplicate rules, and audit engine to `packages/cli/src/commands/ops/shared/pronunciation/`; hardened `scripts/check-architecture.mjs` to forbid `commands/ops/shared/**` and `SHARED_OPS_OWNERS` (except `index.ts`) from importing peer ops commands, removed stale `'livemediacollisions'`, added dynamic `import(...)` edges to Tarjan SCC cycle checks, and tightened `no-raw-ui-api-fetch` to catch both `fetch` and `sendBeacon` against `api/` literal/template/builder URLs outside `packages/ui/src/adapters/**`. |
| **M1: Dead zero-inbound CLI ops pass-through files** | `packages/cli/src/commands/ops/live-media-collisions.ts` and `packages/cli/src/commands/ops/shared/integrateEngine/privacy.ts` had 0 inbound callers repo-wide. | Deleted both dead pass-through files cleanly. |
| **E1: Unvalidated UI plugin conflicts in `KinloomPluginProvider`** | `KinloomPluginProvider` merged plugin routes and form overrides silently with last-writer-wins semantics and allowed colliding with built-in routes. | Added pure `validateAndCompileUiPlugins(plugins)` (`packages/ui/src/plugins/validatePlugins.ts`, wired into `KinloomPluginProvider` and exported from `@kinloom/ui`) throwing `RangeError` on empty/duplicate plugin IDs, duplicate or reserved built-in UI routes (including parameterized collisions like `/person/:id` vs `/person/:slug`), and duplicate `entityEditForms` or `entityCreateForms` overrides; verified in `PluginsAndMedia.test.tsx`. |
| **E2: Unchecked built-in server route collisions in `validateAndCompilePluginRoutes`** | `validateAndCompilePluginRoutes` validated plugin-vs-plugin overlaps but did not reject plugin prefixes colliding with built-in server routes. | Declared `RESERVED_SERVER_ROUTE_PREFIXES` (`/api/bundle`, `/api/entities`, `/api/revisions`, `/api/batches`, `/api/export`, `/api/auth`, `/api/media`, `/api/talk`, `/api/admin`, `/api/pronunciations`, `/api/pronunciation`, `/privacy`, `/og`, `/invite`, `/media`, `/sources`) in `packages/server/src/http/router.ts` and threw `RangeError` on any bidirectional prefix overlap; verified in `packages/server/src/http/pluginRouter.test.ts`. |

### Iteration 6 Measured Verification Snapshot

- Non-test files across `packages/*/src` and `examples/demo/src`: **`620` total (`577` TS/TSX max `548` LOC, `43` CSS max `523` LOC, `0` files `> 550` LOC)**
- Production non-null assertions (`!`) and escape hatches (`any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `as unknown as`, `eslint-disable`): **`0`**
- `npm run build`: **`6/6` workspaces** built cleanly in place (`packages/*/dist` preserved)
- `npm run check:arch`: **`PASS` (`0` violations across `577` non-test TS/TSX files: `0` runtime cycles, `0` type cycles, `0` dynamic-import cycles, `0` peer-ops/shared-ops violations, `0` raw UI `/api/` fetch or sendBeacon calls)**
- `npm run lint`: Biome **`0` errors, `0` warnings** across `787` files + `check:counts` **`0` violations** across `714` files
- `npm run typecheck`: **`7/7` tsconfigs** (`0` errors)
- `npm test`: **`126/126` test files, `836/836` tests passed** (preserving 100% of `#18` behavioral suites plus new Iteration 6 regression tests)
- `npm run check:contrast`: **`15/15` passed**
- `npm run check:leaks`: **`0` leaks**
- `npm run audit:impeccable`: **`PASS` (`0` primary findings across static source, 16 desktop routes, and 16 mobile routes)**
- `npm run test:e2e`: **`40/40` Playwright E2E tests passed**
- Live CLI smoke check: `node packages/cli/dist/cli.js --help` exits `0`

Ready for **Fresh-Eyes Independent Review #4 (`10/10` across all six axes)**.

## Fresh-Eyes Independent Review #4 (`d0eed2c`) & Iteration 7 Remediation (All 6 Surgical Items)

Evaluated on `2026-11-27` (UTC via Python `datetime.now(timezone.utc)`) on top of commit `d0eed2c`. Fresh-Eyes Review #4 scored **Decoupling `10/10`, Cohesion `10/10`, Layering `10/10`, Modularity `10/10`**, and identified 6 surgical items across **Extensibility (`8/10`)** (`E1`–`E3`) and **Data flow (`8/10`)** (`D1`–`D3`). Iteration 7 remediated all 6 items cleanly in place while preserving `packages/*/dist` and every verified invariant.

### Findings Remediated in Iteration 7

| Review Finding | Root Cause Before Iteration 7 | Measured Fix in Iteration 7 |
| --- | --- | --- |
| **E1: Non-failing CLI plugin conflicts & built-in check collisions** | `resolvePluginCommands` in `packages/cli/src/plugins.ts` emitted warnings and ignored duplicate plugin IDs, built-in command shadowing, duplicate commands, and duplicate checks, and did not reserve built-in check ID `'pronunciation'` or reject blank IDs/names. | Exported `RESERVED_AUDIT_CHECK_IDS`, `RESERVED_VERIFY_CHECK_IDS` (containing `'pronunciation'`), and `CliPluginValidationError` (`extends RangeError`, `exitCode = EXIT_USAGE`) from `packages/cli/src/plugins.ts` and `packages/cli/src/index.ts`. Made `resolvePluginCommands` fail fast on empty/whitespace IDs or names, duplicate plugin IDs, built-in CLI command shadowing, duplicate plugin commands, reserved `'pronunciation'` check IDs, and duplicate audit/verify check IDs. Mapped `CliPluginValidationError` to `EXIT_USAGE` inside `runCli` (`packages/cli/src/cli.ts`), cleaned discovery-warning plumbing in `pluginAndGuideCommands.ts`, `audit.ts`, and `verify.ts`, and updated `packages/cli/src/plugins.test.ts`. |
| **E2: Unreserved `'/data'` server route prefix** | `RESERVED_SERVER_ROUTE_PREFIXES` in `packages/server/src/http/router.ts` omitted `'/data'`, allowing a server plugin to shadow the viewer-protected `/data/` static asset path. | Added `'/data'` to `RESERVED_SERVER_ROUTE_PREFIXES` and added startup collision tests for `'/data'` and `'/data/readings.json'` in `packages/server/src/http/pluginRouter.test.ts`. |
| **E3: Deferred Worker server-plugin validation** | `createCloudflareWorker` in `packages/worker/src/index.ts` deferred plugin route validation to `createKinloomServer` inside `fetch()`, delaying invalid plugin failures until first HTTP traffic. | Exported `CompiledPluginRoute`, `RESERVED_SERVER_ROUTE_PREFIXES`, and `validateAndCompilePluginRoutes` from `@kinloom/server`, accepted optional pre-compiled `compiledPluginRoutes` on `KinloomServerConfig`, invoked `validateAndCompilePluginRoutes(plugins)` synchronously at the top of `createCloudflareWorker(options)` and reused the compiled routes per request, and added synchronous startup validation tests in `packages/worker/src/workerBehavioral.test.ts`. |
| **D1: Duplicate EDTF parser in CLI `treeHygiene/dates.ts`** | `packages/cli/src/commands/ops/treeHygiene/dates.ts` maintained a separate `parseDatePart` and regex EDTF parser parallel to canonical `packages/core/src/edtf.ts`. | Deleted `parseDatePart` and all duplicate EDTF regexes in `treeHygiene/dates.ts`, implementing `parseEdtfRange` directly on top of `@kinloom/core`'s `parseEdtfInterval` (with `edtfYear` fallback for single loose prose dates), and added `packages/cli/src/commands/ops/treeHygiene/dates.test.ts` covering `'..'` open endpoints, `192X` decades, and `[~?%]` qualifiers. |
| **D2: Unvalidated external JSON/draft casts (`ohmStyle.ts`, `geminiPronunciationGenerator.ts`, `pronunciationDraft.ts`)** | `loadArchivalOhmStyle` cast `await res.json() as StyleSpecification`; `GeminiPronunciationAudioGenerator` cast `await response.json() as GeminiGenerateContentResponse`; `readDraftPronunciation` and `cleanPronunciation` cast `raw.variants` and `raw.match_full_name_contains` with `as Pronunciation[...]`. | Added structural MapLibre v8 guard (`isMapLibreStyleDocument`) in `packages/ui/src/browser/ohmStyle.ts`, replaced the Gemini response cast with a Zod schema (`GeminiGenerateContentResponseSchema.safeParse`) in `packages/worker/src/adapters/geminiPronunciationGenerator.ts`, and validated `variants` with `PronunciationVariantSchema.safeParse` plus explicit `match_full_name_contains` narrowing in `packages/ui/src/components/wiki/pronunciation/pronunciationDraft.ts`. Added malformed-input regression tests across `uiHelpers.test.ts`, `geminiPronunciationGenerator.test.ts`, and `edgeStatesAndHelpersBehavioral.test.ts`. |
| **D3: Hardcoded `101` living-cutoff math in GEDCOM slice & CLI context privacy** | `packages/core/src/gedcom/slice.ts` and `sliceNormalization.ts` hardcoded `101` and `referenceYear - 101`; `packages/cli/src/commands/ops/context/privacy.ts` duplicated `?? 101` and `earliest > refYear - cutoffYears` / `birthYear <= refYear - cutoffYears` math. | Defaulted `slice.ts` to `DEFAULT_LIVING_CUTOFF_YEARS` from `../privacy/policy.js`, replaced `referenceYear - 101` with `referenceYear - livingCutoffYears` in `sliceNormalization.ts`, delegated both living-cutoff checks in `packages/cli/src/commands/ops/context/privacy.ts` to `isPersonLivingPublic` + `DEFAULT_LIVING_CUTOFF_YEARS` from `@kinloom/core`, and added custom `livingCutoffYears` tests in `packages/core/src/gedcom/gedcom.test.ts` and `packages/cli/src/commands/ops/context/privacy.test.ts`. |

### Iteration 7 Measured Verification Snapshot

- Non-test files across `packages/*/src` and `examples/demo/src`: **`622` total (`580` TS/TSX max `548` LOC, `42` CSS max `523` LOC, `0` files `> 550` LOC)**
- Production non-null assertions (`!`) and escape hatches (`any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `as unknown as`, `eslint-disable`): **`0`**
- `npm run build`: **`6/6` workspaces** built cleanly in place (`packages/*/dist` preserved)
- `npm run check:arch`: **`PASS` (`0` violations across `577` non-test TS/TSX files: `0` runtime cycles, `0` type cycles, `0` dynamic-import cycles, `0` reverse-layer/adapter/cross-page-CSS/atom-drawer-CSS imports, `0` raw UI `/api/` fetch or sendBeacon calls, `0` pure-UI leaks, `0` escape hatches, `0` eager record-client imports, `0` ambient Date in privacy)**
- `npm run lint`: Biome **`0` errors, `0` warnings** across `789` files + `check:counts` **`0` violations** across `716` files
- `npm run typecheck`: **`7/7` tsconfigs** (`0` errors)
- `npm test`: **`128/128` test files, `844/844` tests passed** (preserving 100% of `#18` behavioral suites plus new Iteration 7 regression tests for `E1`–`E3` and `D1`–`D3`)
- `npm run check:contrast`: **`15/15` passed**
- `npm run check:leaks`: **`0` leaks**
- `npm run audit:impeccable`: **`PASS` (`0` primary findings across static source, 16 desktop routes, and 16 mobile routes)**
- Live CLI smoke check: `node packages/cli/dist/cli.js --help` exits `0`

Ready for **Fresh-Eyes Independent Review #5 (`10/10` across all six axes)**.

## Fresh-Eyes Independent Review #5 (`badc299`) & Iteration 8 Remediation (All 4 CLI Items + Allowlist Cleanup)

Evaluated on `2026-11-27` (UTC via Python `datetime.now(timezone.utc)`) on top of commit `badc299`. Fresh-Eyes Review #5 scored **`9 / 10 / 9 / 10 / 10 / 9`** with zero findings in `@kinloom/core`, `@kinloom/server`, `@kinloom/worker`, `@kinloom/ui`, `@kinloom/tokens`, or `examples/demo`, leaving 4 surgical items in `@kinloom/cli` plus 1 stale allowlist entry in `scripts/check-architecture.mjs`. Iteration 8 remediated all 5 items cleanly in place while keeping `packages/*/dist` intact and preserving every verified invariant.

### Findings Remediated in Iteration 8

| Review Finding | Root Cause Before Iteration 8 | Measured Fix in Iteration 8 |
| --- | --- | --- |
| **Gap 1 (Decoupling & Data flow): Duplicate HTTP client & casts in `sync/remoteClient.ts`** | `sync/remoteClient.ts` bypassed `KinloomApiClient` with raw `ctx.fetchImpl`, duplicated `RemoteSnapshotEnvelopeSchema`, parsed `/api/batches` with raw `JSON.parse`, and cast `meta.counts as ArchiveBundle['meta']['counts']`. | Added optional `cacheControl`, `headers`, and `signal` options to `KinloomApiClient.getBundle` (`packages/cli/src/client.ts`); routed `fetchRemoteSnapshot`, `submitPatchChunks`, `purgeCompiledBundleAndRecompile`, and the `/api/bundle` live probe in `packages/cli/src/commands/ops/sync/remoteClient.ts` through `KinloomApiClient` while keeping raw `ctx.fetchImpl` solely for streaming `/{r2Key}` first-byte media probes; deleted `RemoteSnapshotEnvelopeSchema`, raw batch `JSON.parse`, and the `meta.counts` cast; made `RemoteSnapshotResponse` arrays `ReadonlyArray` in `sync/types.ts`; added malformed `/api/batches` and `/api/bundle` rejection tests in `ops.test.ts` and `cacheControl`/header tests in `client.test.ts`. |
| **Gap 2 (Data flow): Unvalidated disk JSON cast in `pronounce/lookupCache.ts`** | `readLookupCache` cast `JSON.parse(...) as CachedLookupPayload` after checking only `typeof cachedRaw.term === 'string'`, risking a `TypeError` in `formatLookupText` on partial or corrupt cache files. | Defined strict `CachedLookupPayloadSchema` (covering every required and optional field of `CachedLookupPayload`, verified via `satisfies z.ZodType<CachedLookupPayload>`) in `packages/cli/src/commands/ops/pronounce/lookupCache.ts`, parsed disk JSON via `CachedLookupPayloadSchema.safeParse(raw)` returning `null` on mismatch, and added partial/corrupt cache recovery tests in `packages/cli/src/commands/ops/pronounce.test.ts`. |
| **Gap 3 (Data flow): Unchecked `JSON.parse(...) as T` helpers in CLI record runtime** | `CachedJsonCallOptions.validateCached` and `readSchemaCacheEntry`'s validator were optional with a `return result as T` fallback; unused `readJsonCache` and `httpGetJson<T = unknown>` cast `JSON.parse(...) as T`. | Made `validateCached` required on `CachedJsonCallOptions<T>` and `readSchemaCacheEntry<T>` and deleted the `as T` fallback and unused `readJsonCache` in `packages/cli/src/commands/records/runtime/cache.ts`; changed `httpGetJson` in `packages/cli/src/commands/records/runtime/http.ts` to return `Promise<{ readonly data: unknown; readonly response: HttpResponseResult }>` without a generic cast and updated all 4 client callers (`hathi.ts`, `wikitree/transport.ts`, `kyArchives/transport.ts`, `texasArchives/transport.ts`); updated and expanded runtime tests in `cache.test.ts` and `http.test.ts`. |
| **Gap 4 (Extensibility): Incomplete reserved built-in check IDs in `plugins.ts`** | `RESERVED_AUDIT_CHECK_IDS` and `RESERVED_VERIFY_CHECK_IDS` only reserved `'pronunciation'`, permitting plugins to collide with other built-in audit and verify check IDs. | Expanded `RESERVED_AUDIT_CHECK_IDS` (`'chronology'`, `'privacy'`, `'citations'`, `'scans'`, `'dryRun'`, `'dry-run'`, `'hygiene'`, `'pronunciation'`) and `RESERVED_VERIFY_CHECK_IDS` (`'citations'`, `'places'`, `'ssn'`, `'compile'`, `'media'`, `'livingNames'`, `'living-names'`, `'hygiene'`, `'pronunciation'`) in `packages/cli/src/plugins.ts` so `resolvePluginCommands` throws `CliPluginValidationError` on every built-in collision, and verified every ID in `packages/cli/src/plugins.test.ts`. |
| **Minor Hygiene: Stale `'livingnamematcher'` allowlist entry** | `SHARED_OPS_OWNERS` in `scripts/check-architecture.mjs` retained `'livingnamematcher'` after `living-name-matcher.ts` was deleted in Iteration 5A. | Removed `'livingnamematcher'` from `SHARED_OPS_OWNERS` in `scripts/check-architecture.mjs`. |

### Iteration 8 Measured Verification Snapshot

- Non-test files across `packages/*/src` and `examples/demo/src`: **`620` total (`577` TS/TSX max `548` LOC, `43` CSS max `523` LOC, `0` files `> 550` LOC)**
- Production non-null assertions (`!`) and escape hatches (`any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `as unknown as`, `eslint-disable`): **`0`**
- `npm run build`: **`6/6` workspaces** built cleanly in place (`packages/*/dist` preserved)
- `npm run check:arch`: **`PASS` (`0` violations across `577` non-test TS/TSX files: `0` runtime cycles, `0` type cycles, `0` dynamic-import cycles, `0` reverse-layer/adapter/cross-page-CSS/atom-drawer-CSS imports, `0` raw UI `/api/` fetch or sendBeacon calls, `0` pure-UI leaks, `0` escape hatches, `0` eager record-client imports, `0` ambient Date in privacy)**
- `npm run lint`: Biome **`0` errors, `0` warnings** across `789` files + `check:counts` **`0` violations** across `716` files
- `npm run typecheck`: **`7/7` tsconfigs** (`0` errors)
- `npm test`: **`128/128` test files, `847/847` tests passed**
- `npm run check:contrast`: **`15/15` passed**
- `npm run check:leaks`: **`0` leaks**
- Live CLI smoke checks: `kinloom --help` and `kinloom status --help` exit `0`

Ready for **Fresh-Eyes Independent Review #6 (`10/10` across all six axes)**.
