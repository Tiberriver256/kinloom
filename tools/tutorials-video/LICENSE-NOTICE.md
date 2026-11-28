# Licensing Notice: `tools/tutorials-video/`

## Architectural & License Boundary

All published Kinloom packages (`@kinloom/core`, `@kinloom/tokens`, `@kinloom/server`, `@kinloom/worker`, `@kinloom/ui`, and `@kinloom/cli`) are licensed under the **MIT License** and contain **zero** imports or dependencies on Remotion or on this directory.

This directory (`tools/tutorials-video/`) is a **private, unpublished** maintainer tooling workspace (`"private": true`, excluded from root npm workspaces and npm publish workflows) that optionally uses **Remotion** (`remotion`, `@remotion/bundler`, `@remotion/renderer`, `@remotion/captions`) to render tutorial MP4/WebM clips and poster slides from declarative scripts.

## Remotion Source-Available License

Remotion is distributed under the **Remotion Source-Available License**, not an OSI-approved MIT license:

- Free for individuals, non-profits, and organizations with up to 3 employees.
- Commercial organizations with 4 or more employees require a Remotion Company License before running Remotion rendering.

Maintainers who do not wish to install or run Remotion do not need this directory:

- `@kinloom/ui` renders tutorial steps natively using standard HTML5 `<video>`, `<track kind="captions">`, and pure React Paper & Ink fallback cards with zero external runtime dependencies.
- `npm run tutorials:verify` validates all declarative scripts, chapter/step parity, WebVTT cue timing, and privacy hygiene using zero Remotion binaries and zero paid API calls.
