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
