# Kinloom Performance Benchmark Suite

`benchmarks/run-benchmarks.mjs` runs a deterministic, reproducible performance benchmark suite across Kinloom's core compilation, incremental patching, Cloudflare D1 + R2 (Miniflare), CLI operations, and UI family-tree/bundle hot paths using a seeded synthetic archive (`seed = 20260019`: 600 people across 6 branches and 10 generations, 2,400 events including 1,200 residence anchors, 240 hierarchical places, 300 sources, 1,100+ kinship edges, 300 media items, 150 Markdown narratives, and a shared pronunciation lexicon).

## Running Locally

Build all workspaces first so `packages/*/dist` and `examples/demo/dist` reflect current code:

```bash
npm run build
npm run bench
```

Save a JSON snapshot or compare against an existing baseline:

```bash
npm run bench -- --json-out benchmarks/latest.json --compare benchmarks/baseline.json
```

## Workloads Measured

1. `core.yaml_load_validate` (`@kinloom/core`) — Full YAML load and Zod schema validation across `kinloom.config.yaml` and all 7 `data/*.yaml` entity collections.
2. `core.yaml_serialize` (`@kinloom/core`) — Deterministic canonical YAML serialization across all 7 entity collections.
3. `core.compile_archive_dual` (`@kinloom/core`) — Full `compileArchive()` in both `private` and `public` modes (EDTF parsing/sorting, place ancestor chains, Haversine 15-mile residence span derivation, media enrichment, living-person redaction, and public living-name review checks).
4. `core.patch_compiled_bundle` (`@kinloom/core`) — Incremental `patchCompiledBundle()` across a 25-mutation mixed batch in `private` and `public` modes.
5. `server_worker.d1_r2_batch_sync` (`@kinloom/server` + `@kinloom/worker`) — End-to-end 40-entity `WikiWriteService.submitBatch` + `D1ArchiveRepository` atomic batch commit + `R2IncrementalPatchBundleCache` incremental bundle sync + `BundleReadService` read under real Miniflare `workerd`.
6. `cli.audit` (`@kinloom/cli`) — `kinloom audit --json` over the materialized 600-person / 2,400-event archive repository.
7. `cli.verify` (`@kinloom/cli`) — `kinloom verify --json` (narrative citations, place coordinates, SSN scan, dual-mode compile + bundle validation + privacy check, media disk verification, public living-name scan, tree hygiene, and pronunciation check).
8. `cli.status` (`@kinloom/cli`) — `kinloom status` (`sparsest` full deceased queue + `chronological --end-of-line`).
9. `cli.pronounce_audit` (`@kinloom/cli`) — `kinloom pronounce audit` across 600 people, 240 places, and shared lexicon.
10. `ui.tree_model_and_layout` (`@kinloom/ui`) — `buildArchivalTreeModel()` + `computeArchivalDiagramLayout()` + `computeLineageSpotlight()` on the 600-person, 10-generation, 6-branch kinship DAG.
11. `ui.tree_search_inp_20_queries` (`@kinloom/ui`) — `searchTreePeople()` across 20 interactive keystroke queries measuring Tree search responsiveness.
12. Demo production bundle metrics (`examples/demo/dist`) — Initial entry + `modulepreload` JS payload, total JS assets, and largest chunk size.
