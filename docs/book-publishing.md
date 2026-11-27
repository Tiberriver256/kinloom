# Archival Landscape Hardcover Book Publishing (Opt-In Plugin)

Kinloom includes an optional, strictly **off-by-default** book publishing plugin across `@kinloom/server`, `@kinloom/ui`, and `@kinloom/cli`. It compiles a family archive into print-ready landscape hardcover interior and wraparound cover PDFs, enforces living-person privacy redaction before rendering or uploading, and integrates with print-on-demand publishers through an adapter-agnostic `BookPublisherProvider` port (shipping with a first-class **Lulu Print API** adapter and a deterministic offline **Mock** adapter).

Default unconfigured Kinloom sites expose **zero** book publishing routes, **zero** print UI buttons, and **zero** book or publisher coupling inside `@kinloom/core`.

## Opt-in registration

### 1. Server plugin (`@kinloom/server`)

Register `createBookPublishingServerPlugin()` in your server `ports.plugins` array:

```ts
import { createBookPublishingServerPlugin, createKinloomServer } from '@kinloom/server';

const server = createKinloomServer({
  siteConfig,
  sessionSecret,
  ports: {
    ...ports,
    plugins: [
      createBookPublishingServerPlugin({
        defaultProvider: 'mock', // Switch to 'lulu' in Admin Plugin Settings once credentials are saved
        defaultEnvironment: 'sandbox',
        defaultTrimPreset: 'us-letter-landscape',
        defaultBinding: 'hardcover-casewrap-glossy',
      }),
    ],
  },
});
```

Passing `{ enabled: false }` returns an inert disabled plugin with zero routes and zero `settingsSchema`.

### 2. Admin UI plugin (`@kinloom/ui`)

Register `createBookPublishingPlugin()` in `<KinloomApp plugins={[...]} />`:

```tsx
import { createBookPublishingPlugin, KinloomApp } from '@kinloom/ui';

<KinloomApp
  dataSource={dataSource}
  siteConfig={siteConfig}
  plugins={[createBookPublishingPlugin()]}
/>;
```

The UI plugin renders strictly inside `AdminSettingsShell` (`slots.adminSettings`) and only when `capabilities.canManageSite` is `true`. Public visitors, viewers, and editors see zero book publishing UI or routes.

### 3. CLI plugin (`@kinloom/cli`)

Enable `createBookPublishingCliPlugin()` via a site extension (`extensions/book-publishing/cli.mjs`) or `kinloom.config.yaml` (`plugins`):

```js
// extensions/book-publishing/cli.mjs
import { createBookPublishingCliPlugin } from '@kinloom/cli';

export default createBookPublishingCliPlugin();
```

## Local CLI PDF export & POD commands

Once registered, the `kinloom book` command provides four subcommands:

```bash
# Build print-ready landscape interior.pdf, cover.pdf, HTML previews, and prepress-report.json
kinloom book build \
  --out ./dist-book \
  --trim us-letter-landscape \
  --binding hardcover-casewrap-glossy \
  --edition public

# Estimate hardcover manufacturing, shipping, and tax costs (offline mock or Lulu sandbox/production)
kinloom book quote \
  --pages 120 \
  --qty 2 \
  --country US \
  --postal 62701 \
  --shipping ground \
  --provider mock

# Validate generated PDFs and dry-run POD submission (zero external orders)
kinloom book submit \
  --dir ./dist-book \
  --address-file ./shipping.json \
  --dry-run

# Submit to Lulu sandbox (or pass --production --confirm-production for a live paid order)
kinloom book submit \
  --dir ./dist-book \
  --address-file ./shipping.json \
  --provider lulu \
  --sandbox \
  --interior-url https://archive.example/api/plugins/book-publishing/artifacts/<token-a> \
  --cover-url https://archive.example/api/plugins/book-publishing/artifacts/<token-b>

# Poll print job status and carrier tracking links
kinloom book status --job-id <jobId> --provider lulu --sandbox
```

### Swappable PDF renderers (`PdfRendererPort`)

- **Deterministic Pure-TS PDF Engine (default):** Runs identically in Node CLI and Cloudflare Workers with zero headless browser or native binary dependencies, stamping exact PDF 1.4 `/MediaBox`, `/BleedBox`, and `/TrimBox` dictionaries.
- **Playwright Chromium (`--renderer playwright` in CLI):** Renders print CSS `@page` HTML via local `playwright-core` when installed.
- **Cloudflare Browser Rendering (`createCloudflareBrowserPdfRenderer`):** Optional Worker renderer targeting `/accounts/{accountId}/browser-rendering/pdf`.

## Lulu Print API credentials (Sandbox & Production)

Lulu Print API provides a free sandbox at `https://api.sandbox.lulu.com` and production fulfillment at `https://api.lulu.com` using OAuth2 `client_credentials` authentication and `Lulu-HMAC-SHA256` webhook signing.

### Admin Plugin Settings (recommended for hosted sites)

`createBookPublishingServerPlugin()` declares a `#44` `settingsSchema` rendered automatically in **Admin Settings**:

- Non-secret configuration: `publisher_provider` (`mock` | `lulu`), `environment` (`sandbox` | `production`), `default_trim_preset`, `default_binding`, `default_paper_stock`, `default_shipping_level`, `contact_email`.
- Write-only masked secrets (`{ type: 'string', secret: true }`):
  - `lulu_client_id`
  - `lulu_client_secret`
  - `lulu_webhook_secret`
  - `cloudflare_browser_api_token` (optional)

All secrets are stored isolated in `plugin_setting_secrets`, masked in Admin UI, preserved on partial saves, and never echoed in `GET /api/admin/plugin-settings`, diagnostics, or HTML responses.

### Environment variables (for CLI commands)

```bash
export KINLOOM_LULU_CLIENT_ID="your-lulu-client-key"
export KINLOOM_LULU_CLIENT_SECRET="your-lulu-client-secret"
export KINLOOM_LULU_WEBHOOK_SECRET="your-lulu-webhook-secret"
```

## Prepress & hardcover geometry specifications

| Trim preset | Trim size (in) | Trim size (mm) | Full-bleed interior canvas (in) | Lulu Casewrap SKU (80# Glossy) |
| --- | --- | --- | --- | --- |
| `us-letter-landscape` | `11.00 × 8.50` | `279.40 × 215.90` | `11.25 × 8.75` (`810 × 630 pt`) | `1100X0850.FC.PRE.CW.080CW444.GXX` |
| `a4-landscape` | `11.69 × 8.27` | `297.00 × 210.00` | `11.94 × 8.52` (`859.68 × 613.44 pt`) | `1169X0827.FC.PRE.CW.080CW444.GXX` |
| `photo-10x8-landscape` | `10.00 × 8.00` | `254.00 × 203.20` | `10.25 × 8.25` (`738 × 594 pt`) | `1000X0800.FC.PRE.CW.080CW444.GXX` |
| `small-9x7-landscape` | `9.00 × 7.00` | `228.60 × 177.80` | `9.25 × 7.25` (`666 × 522 pt`) | `0900X0700.FC.PRE.CW.080CW444.GXX` |

- **Bleed & TrimBox:** `0.125 in` (`9 pt`) bleed on all four sides. Printer crop marks are omitted by default for POD compliance (`--proof-marks` is strictly for local home-printer proofing).
- **Safety margin & dynamic inside gutter:** `0.50 in` outer safety margin; inside binding gutter scales from `0.625 in` (24–150 pages) up to `1.000 in` (501–800 pages).
- **Even-page & minimum length enforcement:** Hardcover casewrap requires an even page count between `24` and `800`. Shorter books pad to 24 pages with ruled **Family Notes & Provenance Ledger** leaves; odd page counts append one blank verso leaf; books exceeding 800 pages fail fast with volume-splitting guidance (`--branch` or `--root-person`).
- **Wraparound cover & spine rules:** `0.75 in` board wrap allowance on all four outer edges; stepped Casewrap spine widths verified against `POST /cover-dimensions/`; spine typography is automatically omitted below `80` pages (`0.375 in` spine minimum); unobstructed `2.00 × 1.25 in` barcode safe rectangle reserved on the lower-right back cover.
- **300 DPI raster audit:** Embedded images below `300 DPI` emit warnings (`200–299 DPI` amber warning; `< 200 DPI` low-resolution warning with recommended shrunk frame dimensions, blocking under `--strict-prepress`).

## Privacy guarantees

Every compilation (HTML preview, local PDF, server download, and POD submission) passes through `runBookPrivacyGate()`, backed by `@kinloom/core`'s `applyPrivacyFilter`, `filterMediaForPrivacy`, and `filterNarrativesForPrivacy`:

1. **Default Public Redacted Edition (`edition: 'public'`):** Excludes every living person's dossier and kinship edges, strips living portraits and private media, scrubs living names from narratives, events, captions, place summaries, and dedication text, and fails closed (`BOOK_PRIVACY_REVIEW_REQUIRED`) when unresolved living-name review flags appear unless explicitly acknowledged.
2. **Explicit Private Family Edition (`edition: 'private'`):** Blocked unless the operator explicitly passes `--edition private --include-living` in CLI or confirms the warning checkbox in Admin UI. Stamps `"Private Family Edition. Not for Public Distribution."` on the colophon and still strips living portraits unless explicitly overridden.
3. **Expiring capability tokens for POD file delivery:** Generated interior and cover PDFs are served only via HMAC-SHA256 signed, single-artifact, time-limited tokens (`/api/plugins/book-publishing/artifacts/:token`, `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`) and automatically revoked once the publisher webhook reports `PRODUCTION_READY`, `IN_PRODUCTION`, `SHIPPED`, `REJECTED`, or `CANCELED`.
4. **Admin RBAC & CSRF:** All compile, quote, status, and print-job submission endpoints require an authenticated `admin` session with matching same-origin CSRF headers (`401` for anonymous callers, `403` for non-admin roles or CSRF mismatches). Inbound Lulu webhooks verify `Lulu-HMAC-SHA256` against raw request bytes before JSON parsing (`401` on invalid signature).
