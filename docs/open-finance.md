# Open Finance & Multi-Platform Donations Plugin

Kinloom includes an optional, off-by-default Open Finance plugin (`createOpenFinancePlugin`) in `@kinloom/server` (re-exported by `@kinloom/worker`) and `@kinloom/ui`.

Archive administrators can publish a transparent operating cost ledger (domain registration, Cloudflare Workers/R2/D1, backup storage, AI/research tooling, archival subscriptions, and optional one-time expenses) alongside strictly allowlisted external donation links.

## Default-Off & Zero-Custody Guarantees

- **Strictly off by default.** Unconfigured Kinloom archives render zero funding banners, zero external donation links, zero `/support` routes, and expose zero finance HTTP endpoints.
- **Zero coupling in `@kinloom/core`.** All open-finance schemas, URL allowlists, integer-cents cost math, HTTP routes, and UI components live strictly inside the optional plugin modules in `@kinloom/server` and `@kinloom/ui`.
- **Zero payment custody and zero third-party scripts.** The plugin never collects payment cards, never proxies payments, and never injects external scripts. Every donation CTA renders as a CSP-safe external `https://` anchor with `target="_blank" rel="noopener noreferrer"`.
- **Exact integer-cents math.** Every line item stores `amount_cents` as a non-negative integer so monthly, annual, and one-time rollups never suffer floating-point drift.

## Supported Donation Platform Allowlist

Every configured URL or handle is validated at startup, on admin writes, and again at the UI render boundary. Non-HTTPS schemes (`javascript:`, `data:`, `http:`), embedded credentials (`user:pass@`), custom ports, query parameters, hash fragments, path traversal, and non-allowlisted hosts are rejected with clear validation errors.

| Platform ID | Platform | Allowed Host(s) | Canonical URL Pattern |
| --- | --- | --- | --- |
| `github_sponsors` | GitHub Sponsors | `github.com` | `https://github.com/sponsors/<handle>` |
| `buy_me_a_coffee` | Buy Me a Coffee | `buymeacoffee.com`, `www.buymeacoffee.com` | `https://buymeacoffee.com/<handle>` |
| `ko_fi` | Ko-fi | `ko-fi.com`, `www.ko-fi.com` | `https://ko-fi.com/<handle>` |
| `open_collective` | Open Collective | `opencollective.com`, `www.opencollective.com` | `https://opencollective.com/<slug>` |
| `stripe` | Stripe Payment Link | `buy.stripe.com` | `https://buy.stripe.com/<id>` |
| `paypal_me` | PayPal.me | `paypal.me`, `www.paypal.me` | `https://paypal.me/<handle>` |

## Setup

### 1. Register the Server Plugin (Live Wiki / Cloudflare Worker)

Import `createOpenFinancePlugin` from `@kinloom/worker` (or `@kinloom/server`) and register it in `plugins`:

```ts
import {
  createCloudflareWorker,
  createOpenFinancePlugin,
} from '@kinloom/worker';
import { siteConfig } from './siteConfig.js';

export default createCloudflareWorker({
  siteConfig,
  plugins: [
    createOpenFinancePlugin({
      config: {
        page_title: 'Alder Family Archive — Open Finance',
        nav_label: 'Support',
        supporter_message:
          'We publish our exact hosting and research costs so family members can see what keeps the archive online.',
        currency: 'USD',
        visibility: {
          show_support_page: true,
          show_in_nav: true,
          show_in_footer: true,
        },
        primary_platform: 'github_sponsors',
        platforms: [
          {
            platform: 'github_sponsors',
            handle: 'alder-archive',
            label: 'Sponsor on GitHub',
          },
          {
            platform: 'buy_me_a_coffee',
            handle: 'alderarchive',
            label: 'Buy Me a Coffee',
          },
        ],
        cost_items: [
          {
            id: 'domain',
            label: 'Domain Registration (.org)',
            category: 'domain',
            cadence: 'annual',
            amount_cents: 1200,
            vendor: 'Cloudflare Registrar',
          },
          {
            id: 'hosting',
            label: 'Cloudflare Workers + R2 + D1',
            category: 'hosting',
            cadence: 'monthly',
            amount_cents: 500,
            vendor: 'Cloudflare',
          },
        ],
        funding_goal: {
          enabled: true,
          period: 'annual',
          target_cents: 7200,
          received_cents: 3600,
          label: '2026 Archive Hosting Fund',
          as_of_date: '2026-11-01',
        },
      },
    }),
  ],
});
```

Pass `{ enabled: false }` to keep the plugin registered in code while returning a completely inert instance with zero routes and zero settings schema.

### 2. Register the UI Plugin (`@kinloom/ui`)

Pass `createOpenFinancePlugin()` in the `plugins` prop of `<KinloomApp />`:

```tsx
import { createOpenFinancePlugin, KinloomApp } from '@kinloom/ui';

export function App() {
  return (
    <KinloomApp
      siteConfig={siteConfig}
      dataSource={dataSource}
      plugins={[
        createOpenFinancePlugin({
          routePath: '/support', // optional: defaults to '/support' (can also use '/finance')
        }),
      ]}
    />
  );
}
```

For static archives without a backend (such as GitHub Pages), pass `liveSync: false` together with a declarative `config`:

```tsx
createOpenFinancePlugin({
  liveSync: false,
  config: {
    platforms: [{ platform: 'github_sponsors', handle: 'alder-archive' }],
    cost_items: [
      { id: 'domain', label: 'Domain (.org)', category: 'domain', cadence: 'annual', amount_cents: 1200 },
    ],
  },
});
```

## Admin Editing & HTTP Endpoints

When registered on `@kinloom/server`, the plugin exposes three routes and composes cleanly into `AdminSettingsShell` (both via its rich interactive `OpenFinanceAdminPanel` and `#44` declarative `settingsSchema`):

- `GET /api/open-finance/summary` (`minRole: 'public'` by default, configurable to `'viewer'`): Returns the sanitized public ledger, exact monthly/annual/one-time totals, optional funding goal progress, visibility toggles, and ordered allowlisted platform CTAs.
- `GET /api/admin/open-finance/config` (`minRole: 'admin'`): Returns the editable open-finance configuration and metadata for the Admin Settings editor.
- `PUT /api/admin/open-finance/config` (`minRole: 'admin'` + CSRF origin check): Strictly validates all platform URLs, integer-cent amounts, and funding goal bounds, then persists the configuration in the existing `PluginSettingsStore` (`plugin_settings` table in D1; no additional migration required).

Admins can also edit platform URLs, visibility toggles, currency, and messaging through `#44`'s declarative `PluginSettingsSection` (`PUT /api/admin/plugin-settings/kinloom-open-finance`), which shares the same persisted store and URL allowlist validator.
