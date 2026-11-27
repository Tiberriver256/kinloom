# UI Review Screenshots (`kinloom screenshots`)

`kinloom screenshots` captures full-page screens, interactive component states, and plugin views from any running Kinloom archive URL. It writes PNG files, a machine-readable `manifest.json`, and a self-contained `index.html` contact sheet that works offline in any browser.

## Prerequisites

Install the optional Playwright runtime alongside `@kinloom/cli` (or in your workspace):

```bash
npm install -D playwright-core
npx playwright-core install chromium
```

If a system Chromium binary is already installed, `kinloom screenshots` detects it automatically. You can override the binary path with `KINLOOM_CHROMIUM_PATH`.

## Basic usage

Capture all pages, interactive components, and plugin screens across mobile, tablet, and desktop viewports in both light and dark color schemes:

```bash
kinloom screenshots --url https://demo.kinloom.example --out-dir ./ui-review
```

Capture only desktop light-mode pages against a local preview server:

```bash
kinloom screenshots \
  --url http://127.0.0.1:4173 \
  --out-dir ./local-review \
  --viewports desktop:1440x900 \
  --themes light \
  --include pages
```

## CLI options

| Option | Default | Purpose |
| --- | --- | --- |
| `--url <baseUrl>` | Required | Target Kinloom server URL (`http://` or `https://`). Embedded URL credentials are rejected. |
| `--out-dir <dir>` | `./kinloom-screenshots` | Output directory for PNGs, `manifest.json`, and `index.html`. |
| `--viewports <list>` | `mobile:390x844,tablet:768x1024,desktop:1440x900` | Comma-separated presets (`mobile`, `tablet`, `desktop`) or `<name>:<width>x<height>` values. |
| `--themes <list>` | `light,dark` | Comma-separated color schemes (`light`, `dark`). |
| `--include <list>` | `pages,components,plugins` | Comma-separated capture categories (`pages`, `components`, `plugins`). |
| `--routes <csv>` | None | Extra page routes to capture under `pages/`. Repeatable or comma-separated. |
| `--plugin-routes <csv>` | None | Explicit plugin routes to capture under `plugins/`. Repeatable or comma-separated. |
| `--sample-people <N>` | `1` | Representative deceased person dossiers selected from `/api/bundle` or `/data/bundle.json`. |
| `--sample-places <N>` | `1` | Representative place dossiers selected from `/api/bundle` or `/data/bundle.json`. |
| `--auth-cookie <cookie>` | None | Optional `Cookie` header for authenticated preview sessions. Never saved to disk. |
| `--auth-header <name: value>` | None | Optional HTTP header for authenticated previews (repeatable). Never saved to disk. |
| `--full-page` / `--no-full-page` | `--full-page` | Capture full scrollable height or viewport-only height for page screenshots. |
| `--wait-ms <ms>` | `350` | Settle delay after page load and font readiness. |
| `--timeout-ms <ms>` | `20000` | Per-capture timeout in milliseconds. |
| `--concurrency <N>` | `2` | Parallel `(viewport × theme)` browser contexts (max `8`). |
| `--json` | `false` | Emit structured JSON output to stdout. |

## What gets discovered automatically

1. **Bundle discovery.** The command fetches `/api/bundle` first and falls back to `/data/bundle.json`. It excludes living people (`is_living: true` or redacted `Living` placeholders) and ranks deceased candidates by narrative audio, biography, pronunciation badge, portrait media, and event count so sampled person dossiers exercise rich UI states.
2. **Core pages.** Captures `/`, `/tree`, `/map`, `/places`, `/time`, `/kinship`, `/evidence`, `/changes`, `/admin`, sampled `/person/:slug` and `/place/:slug` dossiers, plus any extra core routes present in navigation (such as `/privacy` or `/narratives`).
3. **Interactive components and states.** Exercises top-bar navigation, mobile menu drawer, global search modal (empty and populated results), theme toggle, pronunciation badge and variants, source reader drawer, media lightbox, family tree toolbar and focus card, map legend and stop card, sign-in modal or invite banner, narrative audio bar, and footer. Components absent on a target deployment are recorded as `skipped` with a reason instead of failing the run.
4. **Plugin screens and slot widgets.** Inspects live navigation links to find non-core plugin routes (for example `/stories/demo-reel`) and visible plugin slot elements (`[data-plugin-id]`, `[data-slot]`, `[data-kinloom-plugin-slot]`), then captures each across configured viewports and themes.

## Output layout

```text
<out-dir>/
├── index.html
├── manifest.json
├── pages/<page-slug>/<viewport>-<theme>.png
├── components/<component-slug>/<state>/<viewport>-<theme>.png
└── plugins/<plugin-slug>/<viewport>-<theme>.png
```

Open `<out-dir>/index.html` directly in a browser to filter by category (`Pages`, `Components`, `Plugins`), viewport, theme, errors-only status, or search text, and click any thumbnail for a keyboard-navigable zoom lightbox.

## Security and privacy guarantees

- `--auth-cookie` and `--auth-header` values are injected only into live HTTP discovery requests and in-memory Playwright browser contexts. They are never written to `manifest.json`, `index.html`, or CLI stdout.
- Sensitive query parameters (`token`, `secret`, `auth`, `key`, `code`, `session`, `cookie`) and userinfo credentials are redacted from recorded `failedRequests` URLs.
- All dynamic text rendered in `index.html` is HTML-escaped, and the contact sheet loads zero external scripts, fonts, or stylesheets.
