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

## Iteration 2 Roadmap (Path to 10/10 Repo-Wide)

1. **UI Page & Drawer Monoliths (`packages/ui/src/pages/` & `packages/ui/src/components/wiki/`)**
   - `PersonPage.tsx` (`1,541` LOC): Extract vital header, family grid, life timeline, story/narrative cards, and media gallery sections into focused view components + pure view-model hooks.
   - `EntityEditDrawer.tsx` (`1,530` LOC) & `CreateEntityModal.tsx` (`943` LOC): Split entity-type-specific field editors (`person`, `place`, `event`, `source`, `media`, `narrative`) behind a typed registry seam instead of monolithic branching forms.
   - `MapPage.tsx` (`1,430` LOC), `TreePage.tsx` (`1,326` LOC), and `EvidencePage.tsx` (`1,006` LOC): Separate map/tree controller hooks, toolbar/drawer state, and panel renderers.
   - Split oversized CSS Modules (`TreeAndMapPage.module.css` `2,119` LOC, `WikiSurfaces.module.css` `1,693` LOC, `PersonPage.module.css` `1,068` LOC) by component boundary.
2. **CLI Monoliths (`packages/cli/src/` — sequenced after Issue #22 merges)**
   - Decompose `cli.ts` (`1,687` LOC) into command-group registration modules.
   - Decompose large ops commands (`integrate.ts` `2,294` LOC, `audit.ts` `2,156` LOC, `pronounce.ts` `1,809` LOC, `sync.ts` `1,804` LOC, `context.ts` `1,522` LOC) into pure planning/validation seams vs. I/O executors.
   - Extract shared archival record-client HTTP/parsing/citation helpers across `packages/cli/src/commands/records/clients/*.ts` (`nara.ts` `3,983` LOC, `archive-org.ts` `3,398` LOC, `prep-scan.ts` `2,988` LOC, `ocr.ts` `2,615` LOC).
3. **Core Secondary Monoliths (`packages/core/src/`)**
   - Evaluate `patchArchive.ts` (`1,098` LOC) and `gedcom/slice.ts` (`1,028` LOC) for entity-handler table extraction if they continue growing.
