# Kinloom documentation hub

Use this index to find architecture explanations, plugin authoring guides, operational references, and historical engineering records across the Kinloom repository.

## Developers and plugin authors

| Guide | Mode | Topics covered |
| --- | --- | --- |
| [Kinloom architecture](developers/architecture.md) | Explanation and reference | Six-package monorepo DAG, hexagonal ports and adapters, incremental bundle patching, XState v5 UI actors, `<ArchivalImage>` and `<PersonPortrait>`, `ArchivalLayout` and CSS layout primitives, AAA light/dark tokens, living-person privacy boundary, and `scripts/check-architecture.mjs` invariants. |
| [Kinloom plugin authoring guide](developers/plugin-authoring.md) | Tutorial and reference | End-to-end plugin tutorial across `@kinloom/server`, `@kinloom/worker`, `@kinloom/ui`, and `@kinloom/cli`, including `PluginRouteMinRole` (`archive_read`), `settingsSchema` and `preserveKeys`, scoped SQL migrations (`plugin_migrations`), all 13 UI slots, and CLI checks. |
| [Testing and publishing Kinloom plugins](developers/testing-and-publishing-plugins.md) | How-to and reference | `InMemory` and Miniflare D1/R2 parity suites (`runBackendAdapterContractTests`), RBAC/CSRF/secret non-echo/SQL isolation tests, UI and CLI tests, `>= 90%` V8 coverage, npm subpath packaging, Vite `resolve.dedupe`, and the pre-publish privacy checklist. |
| [Declarative plugin settings schema](plugin-settings.md) | Reference | Field types, write-only secrets (`secret: true` and `type: 'secret'`), D1 migration `0004_plugin_settings.sql`, and the `/api/admin/plugin-settings` HTTP API. |
| [Kinloom ubiquitous language](ubiquitous-language.md) | Reference | Canonical reader, family tree, evidence, and wiki vocabulary required across UI, CLI, and documentation. |
| [Kinloom design system](../DESIGN.md) | Reference | Paper & Ink color palette, `Newsreader` and `IBM Plex Mono` typography scale, spacing, and WCAG 2.2 AAA rules. |
| [Contributing to Kinloom](../CONTRIBUTING.md) | How-to | Local Node 24+ setup, privacy rules, `npm run check` gates, and Conventional Commits pull request workflow. |

## Operational and optional plugin guides

| Guide | Mode | Topics covered |
| --- | --- | --- |
| [Observability, telemetry, and page visit stats](observability.md) | Reference and how-to | Cloudflare Workers Observability, security telemetry, WAF rate-limiting rules, `kinloom probe`, CWV budgets, Cloudflare Web Analytics, and Page Visit Stats. |
| [Open Finance and donations plugin](open-finance.md) | Reference and how-to | Opt-in transparent operating cost ledger and allowlisted zero-custody external donation links. |
| [Archival hardcover book publishing plugin](book-publishing.md) | Reference and how-to | Opt-in landscape hardcover PDF compilation, living-person privacy gating, and Lulu Print API or mock fulfillment. |
| [Colab GPU TTS backend](colab-gpu-tts.md) | How-to | Running an OpenAI-compatible Colab GPU text-to-speech server for CLI narrative audio workflows. |
| [UI review screenshots](ui-screenshots.md) | Reference and how-to | Capturing full-page, component, and plugin screenshots across viewports and light/dark themes with `kinloom screenshots`. |

## Community and governance

- [Repository overview and quickstart](../README.md)
- [Security and privacy disclosure policy](../SECURITY.md)
- [Support and discussions](../SUPPORT.md)
- [Code of conduct](../CODE_OF_CONDUCT.md)

## Historical engineering and UX audits

These archived engineering plans and audit reports document past refactors and UI reviews. Refer to the developer guides above for current steady-state contracts.

- [Architecture scorecard (Issue #17 monolith decomposition)](architecture-scorecard.md)
- [TypeScript CLI migration plan (Python-to-TypeScript record)](ts-cli-migration-plan.md)
- [UX audit wave 50](ux-audit-wave-50.md)
- [UX impeccable audit wave 51](ux-impeccable-audit-wave-51.md)
- [UX tooling critique wave 52](ux-tooling-critique-wave-52.md)
- [UX editor tooling audit wave 53](ux-editor-tooling-audit-wave-53.md)
