# Contributing to Kinloom

Thank you for helping improve Kinloom. This guide explains the repository layout, privacy boundaries, local checks, and pull request workflow.

## Non-negotiable privacy boundary

Kinloom is a public MIT repository. Never commit private family names, living-relative records, private email addresses, personal GEDCOM exports, or scanned personal family documents.

- Use strictly synthetic fixtures or verified public-domain historical examples (such as the Lincoln and Todd demo archive in `examples/demo/`).
- Run `npm run check:leaks` before every commit.

## Repository layout

Kinloom uses npm workspaces with six packages and one public-domain demo app:

- `packages/tokens`: Design tokens (`tokens.json`) compiled to CSS custom properties in `kinloom.css`.
- `packages/core`: Domain schemas, EDTF date parsing, residence spans, living-person privacy redaction, GEDCOM 7 import and export, YAML serialization, and incremental bundle patching.
- `packages/server`: Zero-Cloudflare Web-Fetch HTTP router, authentication, RBAC, CSRF protection, optimistic concurrency, revision ledger, media byte-range streaming, and `InMemory` test adapters.
- `packages/worker`: Thin Cloudflare Workers adapter binding `@kinloom/server` to D1 and R2.
- `packages/ui`: React 19 archival explorer, family tree, migration map, kinship finder, evidence browser, and inline wiki editors.
- `packages/cli`: Pure-TypeScript CLI for archive lifecycle, operations, 23 archival research and scan-prep commands, and 26 embedded guides. Do not add Python files, `uv` scripts, or a `skills/` directory under `packages/cli/`.
- `examples/demo`: Public-domain Lincoln and Todd historical archive built as a static SPA.

## Local setup

Kinloom requires Node.js 24+ and npm. To run OCR integration tests locally, also install `tesseract-ocr` and `poppler-utils`.

```bash
npm ci
npm run check
```

To run the full demo and wiki end-to-end Playwright suite:

```bash
npx playwright install chromium
npm run test:e2e
```

To check code coverage against the repository's 90% V8 thresholds:

```bash
npm run test:coverage
```

## Code quality and architecture rules

Every pull request must pass `npm run check` with zero errors and zero warnings. That command runs:

1. `npm run check:arch`: Enforces zero circular imports (runtime, type, and dynamic), strict package layering, pure UI view models, zero `any` or type-escape hatches, lazy record clients, and explicit reference years in privacy logic.
2. `npm run lint`: Runs Biome linting and formatting checks plus `npm run check:counts`.
3. `npm run build`: Builds all six workspaces and `examples/demo`. Do not delete `packages/*/dist` wholesale if you symlink `kinloom` locally.
4. `npm run typecheck`: Typechecks all workspaces, the demo app, and `e2e/`.
5. `npm test`: Runs the Vitest unit and property test suite.
6. `npm run check:contrast`: Verifies WCAG 2.2 AA and AAA foreground-to-background contrast pairs across `@kinloom/tokens`.
7. `npm run check:leaks`: Verifies zero forbidden filenames or private email leaks.

Run `npm run format` to format modified files with Biome.

## Pull request workflow

1. Search [open issues](https://github.com/Tiberriver256/kinloom/issues) and [Discussions](https://github.com/Tiberriver256/kinloom/discussions) before starting large architectural changes.
2. Fork the repository and create a focused branch from `main`.
3. Keep each pull request scoped to one clear bug fix, feature, or documentation improvement.
4. Add unit or end-to-end tests using synthetic or public-domain fixtures for every behavioral change.
5. Follow [Conventional Commits](https://www.conventionalcommits.org/) in commit messages and pull request titles (for example `feat(core): ...`, `fix(ui): ...`, `docs(oss): ...`).
6. Run `npm run check` (and `npm run test:e2e` for UI or demo changes) before opening your pull request.

## Reporting security or privacy bugs

Do not open a public issue or pull request for security or living-person privacy vulnerabilities. Follow [SECURITY.md](SECURITY.md) to submit a private GitHub Security Advisory.

## Code of conduct

All contributors and participants follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
