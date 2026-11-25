<p align="center">
  <img src="brand/logo-mark.svg" width="56" height="56" alt="Kinloom mark" />
</p>

<h1 align="center">Kinloom</h1>

<p align="center">
  <strong>Weave primary sources, places, and family memory into one living archive.</strong><br/>
  Your family's Wikipedia, grounded in primary records.
</p>

Kinloom is an open-source MIT framework for collaborative, private family history wikis deployed on Cloudflare Workers, D1, and R2, paired with standalone archival research CLIs.

## Packages

- `packages/tokens`: WCAG 2.2 AA and AAA verified Paper and Ink DTCG design tokens (`@kinloom/tokens`).
- `packages/core`: Unified TypeScript domain model, EDTF parser, residence-span derivation, living-person privacy filter, GEDCOM 7 import and export, YAML serializer, and revision engine (`@kinloom/core`).
- `packages/ui`: Configurable React 19 archive explorer, inline wiki editors, Revision History, visual diffs, one-click Undo, Recent Changes, Media Uploader, and Talk panel (`@kinloom/ui`).
- `packages/worker`: Cloudflare Worker runtime for Google Sign-In, email magic links, read-only invite links with auto-enrollment, D1 revision persistence, R2 media storage, and AI research agent batch APIs (`@kinloom/worker`).
- `packages/cli`: Terminal CLI (`kinloom init`, `kinloom seed`, `kinloom slice-gedcom`, `kinloom submit-batch`, `kinloom export-yaml`) (`@kinloom/cli`).
- `skills/`: Standalone `uv`-based genealogy archive CLI skills for humans and AI research agents.
- `brand/`: Official Kinloom logomarks, wordmarks, favicons, and `BRAND.md`.
- `examples/demo`: Public-domain historical family dataset for local development and end-to-end tests.

## License

MIT. See [LICENSE](LICENSE).
