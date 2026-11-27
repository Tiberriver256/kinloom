# Cloudflare Workers observability

Kinloom ships an optional observability plugin for Cloudflare Workers and portable `@kinloom/server` deployments.
Observability stays disabled by default in `createKinloomServer`, `createCloudflareWorker`, and `kinloom init`.
When you do not register the plugin, the router skips lifecycle tracking and emits zero `X-Request-Id` headers, zero `Server-Timing` headers, and zero structured telemetry logs.

## Enable Workers Observability

Follow two steps to collect structured request telemetry in your archive deployment.

### 1. Enable log collection in Wrangler

In `wrangler.jsonc`, uncomment or add the `observability` block:

```jsonc
{
	"observability": {
		"enabled": true,
		"head_sampling_rate": 1
	}
}
```

If your archive uses `wrangler.toml`, add the equivalent section:

```toml
[observability]
enabled = true
head_sampling_rate = 1
```

### 2. Register `createWorkersObservabilityPlugin`

Import `createWorkersObservabilityPlugin` from `@kinloom/worker` (or `@kinloom/server`) and pass it to `plugins` in your archive Worker entrypoint or `extensions/` module:

```ts
import {
	createCloudflareWorker,
	createWorkersObservabilityPlugin,
} from '@kinloom/worker';
import { siteConfig } from './siteConfig.js';

export default createCloudflareWorker({
	siteConfig,
	plugins: [
		createWorkersObservabilityPlugin(),
	],
});
```

To keep the plugin registered in code while turning telemetry off for a local or staging environment, pass `enabled: false`:

```ts
createWorkersObservabilityPlugin({ enabled: false });
```

When `enabled` is `false`, the factory returns an inert plugin with no request lifecycle hooks.

## Plugin options reference

`createWorkersObservabilityPlugin(options)` accepts these optional fields:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Registers no lifecycle hooks when `false`. |
| `emitServerTiming` | `boolean` | `true` | Adds RFC `Server-Timing` headers to API, bundle, and media responses. |
| `includeRequestIdHeader` | `boolean` | `true` | Adds the `X-Request-Id` header to HTTP responses. |
| `sink` | `(record: WorkersObservabilityLogRecord) => void \| Promise<void>` | `console.log` / `console.error` JSON lines | Receives one structured record per request. |
| `clock` | `Clock` | System UTC clock | Supplies the ISO-8601 `timestamp` field. |
| `now` | `() => number` | `performance.now()` | Supplies deterministic millisecond timestamps for tests. |
| `generateRequestId` | `() => string` | `crypto.randomUUID()` | Generates a request ID when incoming headers are absent or rejected. |
| `securityTelemetry` | `boolean \| SecurityTelemetryOptions` | `false` | Enables redacted `security_event` logs and optional alert callbacks when explicitly set to `true` or `{ enabled: true, ... }`. |
| `webAnalytics` | `WebAnalyticsOptions` | `undefined` (off) | Enables cookie-free Cloudflare Web Analytics beacon injection, scoped CSP origins, and truthful `/privacy` disclosure when `{ enabled: true, token }` is set. |

## Response headers

### `X-Request-Id`

The plugin selects the request ID in this order:

1. An incoming `x-request-id` header if it contains only safe identifier characters (`[A-Za-z0-9._:-]`, length 1 to 128) and does not begin with a token prefix (`kin_`, `tok_`, `sess_`, `bearer`, `jwt_`, `eyJ`).
2. An incoming Cloudflare `cf-ray` header if it matches `[A-Za-z0-9-]{4,64}`.
3. A newly generated ID from `generateRequestId()` (`crypto.randomUUID()` by default).

### `Server-Timing`

On API (`/api/*`), bundle (`/api/bundle`, `/data/*`), and media (`/media/*`, `/sources/*`) routes, the plugin emits a W3C `Server-Timing` header with recorded durations in milliseconds:

```text
Server-Timing: d1;dur=2.45, r2;dur=6.1, bundle;dur=9.2, total;dur=11.8
```

Spans appear in canonical order (`d1`, `r2`, `bundle`, `total`) and omit spans that did not run on that request.

## Structured JSON log schema

Each completed request emits one JSON object to `sink`:

```json
{
	"event": "http_request",
	"timestamp": "2026-06-15T12:00:00.000Z",
	"level": "info",
	"request_id": "8f1a2b3c4d5e6f7a-ORD",
	"method": "GET",
	"route": "/api/bundle",
	"status": 200,
	"duration_ms": 11.8,
	"cache_status": "hit",
	"bundle_revision": 42,
	"error_code": null,
	"spans_ms": {
		"d1": 2.45,
		"r2": 6.1,
		"bundle": 9.2,
		"total": 11.8
	}
}
```

Log levels follow HTTP status codes: `info` for statuses below `400`, `warn` for `400` through `499`, and `error` for `500` and above.
The default sink writes `error` records through `console.error` and all other records through `console.log`.

## Privacy and fault isolation

The plugin protects living relatives and archive credentials in four ways:

- **Normalized route templates:** Paths with dynamic parameters log as templates such as `/api/entities/:type/:id`, `/api/admin/users/:email`, `/og/person/:id.svg`, `/invite/:token`, `/media/:key`, and `/people/:slug`. Unmatched routes collapse to `/api/*` or `/*`.
- **No query strings, bodies, or auth headers:** Query parameters (such as magic-link `token` or OAuth `code` and `state`), `Authorization` headers, `Cookie` headers, session IDs, and request bodies never enter log records.
- **Canonical error codes only:** Logs record only validated uppercase error codes (such as `UNAUTHORIZED` or `OPTIMISTIC_CONFLICT`) and never raw exception messages or stack traces.
- **Fault-isolated lifecycle hooks:** If a plugin hook or custom `sink` throws synchronously or rejects asynchronously, `@kinloom/server` catches the error, reports it through `onPluginError` if configured, and returns the original HTTP response to the caller.

## Security and abuse telemetry (off by default)

Security telemetry stays off by default even when you register `createWorkersObservabilityPlugin()`.
When `securityTelemetry` is omitted, set to `false`, or set to `{ enabled: false }`, the plugin omits the `onSecurityEvent` hook and the router skips security event emission completely.

### Enable security telemetry

Pass `securityTelemetry: true` to log structured `security_event` JSON lines through `console.warn` (and `console.error` on 5xx auth provider failures):

```ts
import {
	createCloudflareWorker,
	createWorkersObservabilityPlugin,
} from '@kinloom/worker';
import { siteConfig } from './siteConfig.js';

export default createCloudflareWorker({
	siteConfig,
	plugins: [
		createWorkersObservabilityPlugin({
			securityTelemetry: true,
		}),
	],
});
```

To forward alerts to a webhook or custom handler, pass an options object with `enabled: true` and `alertSink`:

```ts
createWorkersObservabilityPlugin({
	securityTelemetry: {
		enabled: true,
		alertOn: [
			'auth.magic_link.rate_limited',
			'auth.agent_token.rejected',
			'csrf.rejected',
		],
		alertSink: async (record) => {
			await fetch('https://alerts.example.test/kinloom', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(record),
			});
		},
	},
});
```

`createCloudflareWorker` passes `ctx.waitUntil` into `server.fetch`, so async `alertSink` callbacks run without delaying HTTP responses.
If `sink` or `alertSink` throws synchronously or rejects asynchronously, `@kinloom/server` catches the failure, reports it to `onPluginError` if configured, and returns the original HTTP denial response to the caller.

### Security telemetry options reference

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | Required (`false` when omitted) | Must be `true` to register the `onSecurityEvent` hook. |
| `sink` | `(record: SecurityTelemetryLogRecord) => void \| Promise<void>` | `console.warn` / `console.error` JSON lines | Receives one redacted `security_event` record per security denial. |
| `alertSink` | `(record: SecurityTelemetryLogRecord) => void \| Promise<void>` | `undefined` | Optional fault-isolated alert or webhook callback. |
| `onAlert` | `(record: SecurityTelemetryLogRecord) => void \| Promise<void>` | `undefined` | Alias for `alertSink`. |
| `alertOn` | `readonly ServerSecurityEventType[]` | All 8 event types | Restricts `alertSink` delivery to matching `event_type` values. |

### Security event schema and types

Each security denial emits one structured JSON object with bounded-cardinality fields and the same `request_id` as the corresponding `http_request` record:

```json
{
	"event": "security_event",
	"event_type": "media.upload.rejected",
	"timestamp": "2026-06-15T12:00:00.000Z",
	"level": "warn",
	"request_id": "8f1a2b3c4d5e6f7a-ORD",
	"method": "POST",
	"route": "/api/media/upload",
	"status": 415,
	"reason": "magic_bytes_mismatch",
	"content_type": "image/png",
	"size_bytes": 64
}
```

The closed `ServerSecurityEventType` union covers eight denial paths:

| `event_type` | Trigger | Safe extra fields |
| --- | --- | --- |
| `auth.magic_link.rate_limited` | Magic-link request hits the per-window limit (`429`). | None |
| `auth.magic_link.invalid_or_expired` | Magic-link verification fails (`invalid`, `used`, `expired`, or `invite_required`). | None |
| `auth.oauth.failed` | Google OAuth start or callback fails (`cancelled`, `provider_error`, `invalid_state`, `provider_unconfigured`, `email_unverified`, `invite_required`, `exchange_failed`). | `provider` |
| `auth.invite.invalid` | Invite link redemption or active invite session check fails (`missing`, `not_found`, `expired`, `revoked`). | None |
| `auth.agent_token.rejected` | Bearer token is empty, invalid, revoked, or lacks the required route scope. | None |
| `auth.write.forbidden` | Unauthenticated caller, read-only invite viewer, non-admin editor, or non-owner attempts a write or admin operation. | `required_role`, `actor_kind` |
| `media.upload.rejected` | Upload fails magic-byte verification, MIME allowlist, empty-file check, or size limit. | `content_type`, `size_bytes`, `max_bytes` |
| `csrf.rejected` | State-changing request fails Origin verification (`missing_origin` or `origin_mismatch`). | `auth_method` |

Security event records never include plaintext emails, bearer tokens, magic-link tokens, invite tokens, session cookies, living-person names, raw IP addresses, or raw `Origin` headers.

## Cloudflare WAF, Security Analytics, and Notifications

Cloudflare WAF rules, Security Analytics filters, and Notifications are opt-in at your Cloudflare zone and account level.
Configure them only on archives where you want edge rate limiting and automated alerting.

### Opt-in Cloudflare WAF rate-limiting rules

In the Cloudflare dashboard, open **Security > WAF > Rate limiting rules** for your archive zone and add rules targeting Kinloom's sensitive endpoints:

1. **Magic-link requests:** Match `(http.request.method eq "POST" and http.request.uri.path eq "/api/auth/magic-link/request")`. Limit to `5` requests per `10` minutes per IP with action **Block** (HTTP `429`).
2. **Auth verification and invite probing:** Match `(http.request.uri.path eq "/api/auth/magic-link/verify" or starts_with(http.request.uri.path, "/invite/") or starts_with(http.request.uri.path, "/api/auth/invite/"))`. Limit to `20` requests per `10` minutes per IP with action **Managed Challenge** or **Block**.
3. **OAuth callback bursts:** Match `(http.request.uri.path eq "/api/auth/google/start" or http.request.uri.path eq "/api/auth/google/callback")`. Limit to `20` requests per `10` minutes per IP.
4. **Media uploads:** Match `(http.request.method eq "POST" and http.request.uri.path eq "/api/media/upload")`. Limit to `30` requests per `10` minutes per IP to cap abusive multipart payloads before they reach R2.

### Cloudflare Workers Logs and Security Analytics filters

In **Workers & Pages > your Worker > Logs** (or **Security > Analytics** for WAF events), filter on the structured JSON fields emitted by the plugin:

- All security denials: `event = "security_event"`
- Auth abuse burst: `event = "security_event" AND event_type IN ("auth.magic_link.rate_limited", "auth.magic_link.invalid_or_expired", "auth.oauth.failed", "auth.invite.invalid")`
- Token or CSRF probing: `event = "security_event" AND event_type IN ("auth.agent_token.rejected", "csrf.rejected", "auth.write.forbidden")`
- Upload spoofing or oversized uploads: `event = "security_event" AND event_type = "media.upload.rejected"`
- Server 5xx errors: `event = "http_request" AND status >= 500`

Correlate any `security_event` with its surrounding HTTP telemetry by filtering on `request_id`.

### Cloudflare Notifications ("Get notified") policies

In the Cloudflare dashboard, open **Notifications > Add** to enable alerts for production archives:

1. **Worker 5xx error spikes:** Select **Workers** (or **HTTP Alerts > Origin Error Rate Alert**) and trigger when `5xx` error rates exceed your baseline (for example, `> 5%` over `5` minutes) for your archive Worker or hostname.
2. **D1 errors and usage limits:** Select **D1** alerts (or Worker error-rate alerts correlated with `event = "http_request" AND level = "error"` in Workers Logs) to catch database query failures or quota thresholds early.
3. **Auth failure bursts and WAF triggers:** Select **HTTP DDoS Attack Alert** and **WAF / Rate Limiting Alerts** for your zone, and optionally pair them with `securityTelemetry.alertSink` pointing to a private Slack, Discord, PagerDuty, or email webhook for immediate `auth.magic_link.rate_limited` and `auth.agent_token.rejected` alerts.

## Synthetic performance probes and Core Web Vitals budgets (off by default)

Kinloom provides an optional CLI synthetic probe plugin (`createSyntheticProbePlugin` from `@kinloom/cli`) and an opt-in Playwright Core Web Vitals budget suite (`npm run test:cwv`).
Both stay disabled by default so standard `kinloom` CLI usage, `kinloom verify`, and `npm run test:e2e` do not perform extra network probes or timing assertions unless you opt in.

### Enable the `kinloom probe` CLI plugin

Create an extension entry in `extensions/synthetic-probe/cli.mjs` inside your archive repository (or list the module path under `plugins:` in `kinloom.config.yaml`):

```js
import { createSyntheticProbePlugin } from '@kinloom/cli';

export default createSyntheticProbePlugin({
	targetUrl: 'https://archive.example.test',
	budgets: {
		maxHtmlTtfbMs: 800,
		maxBundleColdMs: 1500,
		maxBundleWarmMs: 400,
		maxMediaRangeMs: 1000,
	},
});
```

Run a synthetic check against a deployed or preview archive:

```sh
kinloom probe --url https://archive.example.test
kinloom probe --url https://archive.example.test --json
```

The command checks four areas in order and exits with code `0` on pass or `1` on a budget breach:

1. **HTML root (`/`):** Measures TTFB, total duration, response bytes, and baseline security headers (`content-security-policy`, `x-content-type-options`, `x-frame-options`, `referrer-policy`, and `strict-transport-security` on HTTPS URLs).
2. **Cold `/api/bundle`:** Measures uncached latency, payload size, `ETag`, `Cache-Control`, and parses W3C `Server-Timing` spans (`d1`, `r2`, `bundle`, `total`) when `createWorkersObservabilityPlugin` is active.
3. **Warm conditional `/api/bundle`:** Re-requests `/api/bundle` with `If-None-Match` and verifies HTTP `304 Not Modified` within the warm latency budget.
4. **R2 media byte-range (`Range: bytes=0-1023`):** Probes `--media-path` (or the first same-origin media path discovered in `/api/bundle`) and verifies HTTP `206 Partial Content`, `Content-Range`, and `Accept-Ranges: bytes`. If no media item exists, the media check reports `skipped`.

Pass `enabled: false` to keep the file registered as an inert no-op plugin.
Pass `attachVerifyCheck: true` (together with `targetUrl` or `KINLOOM_PROBE_URL`) only if you want `kinloom verify` to run the live HTTP probe as an additional `synthetic-probe` check.

### Synthetic probe options and CLI flags

| Option / CLI flag | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Returns an inert plugin with zero commands and zero verify checks when `false`. |
| `attachVerifyCheck` | `false` | Adds the `synthetic-probe` check to `kinloom verify` only when `true`. |
| `targetUrl` / `--url` | `KINLOOM_PROBE_URL` | Base URL of the archive to probe. |
| `mediaPath` / `--media-path` | First media item in `/api/bundle` | Explicit same-origin media path for the `206` byte-range probe. |
| `mediaRangeBytes` / `--media-range-bytes` | `1024` | Number of leading bytes requested in the `Range` header. |
| `token` / `--token` | `undefined` | Optional bearer token for private archive probes (never written to reports). |
| `budgets.maxHtmlTtfbMs` / `--max-html-ttfb-ms` | `800` | Maximum allowed root HTML TTFB in milliseconds. |
| `budgets.maxBundleColdMs` / `--max-bundle-cold-ms` | `1500` | Maximum allowed cold `/api/bundle` latency in milliseconds. |
| `budgets.maxBundleWarmMs` / `--max-bundle-warm-ms` | `400` | Maximum allowed conditional `304` `/api/bundle` latency in milliseconds. |
| `budgets.maxMediaRangeMs` / `--max-media-range-ms` | `1000` | Maximum allowed media `206` byte-range latency in milliseconds. |
| `budgets.require304` / `--no-require-304` | `true` | Fails when `/api/bundle` omits `ETag` or does not return `304`. |
| `budgets.require206` / `--no-require-206` | `true` | Fails when the media probe does not return `206` with `Content-Range` and `Accept-Ranges: bytes`. |
| `budgets.requireSecurityHeaders` / `--no-require-security-headers` | `true` | Fails when required security headers are missing on `/`. |

### Run the opt-in Core Web Vitals budget suite

Run the Playwright Core Web Vitals budget checks against the built demo archive:

```sh
npm run test:cwv
```

`npm run test:e2e` skips `e2e/cwv-budget.spec.ts` unless `KINLOOM_CWV_BUDGET=1` is set.
The CWV suite captures `first-contentful-paint` (FCP), `largest-contentful-paint` (LCP), `layout-shift` (CLS), and interaction latency across `/`, `/tree`, `/map`, and `/person/abraham-lincoln-1809`.
Override default budgets with environment variables when running in slower CI environments:

| Environment variable | Default | Metric |
| --- | --- | --- |
| `KINLOOM_CWV_MAX_LCP_MS` | `2500` | Largest Contentful Paint (ms) |
| `KINLOOM_CWV_MAX_FCP_MS` | `1800` | First Contentful Paint (ms) |
| `KINLOOM_CWV_MAX_CLS` | `0.1` | Cumulative Layout Shift |
| `KINLOOM_CWV_MAX_INTERACTION_MS` | `200` | Interaction latency (ms) |

### Cloudflare Observatory setup guide

Cloudflare Observatory runs scheduled synthetic Lighthouse and Core Web Vitals tests from Cloudflare's edge locations.
Configure it in **Speed > Observatory** for your archive zone when you want continuous production tracking.

1. **Add test URLs:** Register four representative routes for your archive hostname:
	- `https://archive.example.test/` (archive landing page and primary index)
	- `https://archive.example.test/tree` (interactive family tree view)
	- `https://archive.example.test/map` (migration map canvas and filter controls)
	- `https://archive.example.test/person/<slug>` (person profile with biography, residence spans, and media gallery)
2. **Pick a test schedule:** Schedule **Daily** tests from the region closest to your primary family audience (and optionally a second distant region to track cold edge cache behavior). Trigger a manual run after deploys that change UI bundles, fonts, or media encoding.
3. **Set alert thresholds:** Align Observatory budgets and CI `kinloom probe` checks with Google's Good Core Web Vitals targets:
	- **TTFB:** `<= 800 ms` on HTML and `<= 400 ms` on warm `304` `/api/bundle` revalidation
	- **FCP:** `<= 1800 ms`
	- **LCP:** `<= 2500 ms`
	- **CLS:** `<= 0.1`
	- **INP:** `<= 200 ms`
	- **Bundle cold latency:** `<= 1500 ms` and **R2 media `206` range latency:** `<= 1000 ms`
4. **Correlate regressions:** When Observatory flags a TTFB or LCP regression, run `kinloom probe --url https://archive.example.test --json` to inspect `Server-Timing` (`d1`, `r2`, `bundle`, `total`) alongside Workers Logs (`event = "http_request"`).

## Cloudflare Web Analytics (RUM) and Core Web Vitals (off by default)

Cloudflare Web Analytics collects aggregate page-load metrics and Core Web Vitals without cookies or cross-site tracking.
The module stays off by default in `createKinloomServer`, `createCloudflareWorker`, and `createWorkersObservabilityPlugin()`.
When `webAnalytics` is omitted or `{ enabled: false }`, the server sends zero beacon scripts, keeps `DEFAULT_CONTENT_SECURITY_POLICY` unchanged, and keeps the default zero-tracker `/privacy` page unchanged.

### Enable Cloudflare Web Analytics

1. In the Cloudflare dashboard, open **Analytics & Logs > Web Analytics**, add your archive site, and copy the 32-character hexadecimal site token.
2. Store the token in your Worker environment as `CF_WEB_ANALYTICS_TOKEN` (for example in `wrangler.jsonc` `vars` or Wrangler secrets).
3. Pass `webAnalytics: { enabled: true, token: env.CF_WEB_ANALYTICS_TOKEN }` to `createWorkersObservabilityPlugin`:

```ts
import {
	createCloudflareWorker,
	createWorkersObservabilityPlugin,
	type ExecutionContext,
	type KinloomWorkerEnv,
} from '@kinloom/worker';
import { siteConfig } from './siteConfig.js';

export default {
	fetch(request: Request, env: KinloomWorkerEnv, ctx: ExecutionContext): Promise<Response> {
		const worker = createCloudflareWorker({
			siteConfig,
			plugins: [
				createWorkersObservabilityPlugin({
					webAnalytics: env.CF_WEB_ANALYTICS_TOKEN
						? { enabled: true, token: env.CF_WEB_ANALYTICS_TOKEN }
						: { enabled: false },
				}),
			],
		});
		return worker.fetch(request, env, ctx);
	},
};
```

### Token validation, CSP scoping, and truthful `/privacy` disclosure

- **Strict token validation:** `validateCloudflareWebAnalyticsToken` requires an exact 32-character lowercase hexadecimal string (`/^[0-9a-f]{32}$/`). If `enabled` is `true` and `token` is empty, uppercase, non-hex, contains whitespace, or contains HTML characters, `createWorkersObservabilityPlugin` throws a `RangeError` at plugin creation.
- **HTML-only beacon injection:** The router injects `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"<validated-token>"}'></script>` before `</body>` (or `</head>` if `</body>` is absent) on `2xx` `text/html` document responses, strips stale `Content-Length` and `Content-Encoding` headers, and preserves `Content-Type: text/html`. API JSON (`/api/*`), OG SVG (`/og/*`), media (`/media/*`), `robots.txt`, JavaScript, and CSS responses never receive a `<script>` tag.
- **Scoped CSP additions:** On HTML responses only, the server appends `https://static.cloudflareinsights.com` to `script-src` and `https://cloudflareinsights.com` to `connect-src`. Every other CSP directive (`default-src`, `style-src`, `img-src`, `frame-ancestors`, `object-src`, and `/media/*` sandbox CSP) stays unchanged, and neither `'unsafe-inline'` nor `'unsafe-eval'` is ever added to `script-src`.
- **Truthful `/privacy` disclosure:** When Web Analytics is enabled, `/privacy` replaces the default zero-analytics bullet with a disclosure stating that the archive uses optional, cookie-free Cloudflare Web Analytics for aggregate page-load and Core Web Vitals performance telemetry with zero cookies, zero cross-site tracking, and zero advertising trackers.

### Manual plugin injection vs Cloudflare automatic beacon

Keep Cloudflare's dashboard **Automatic setup** (edge auto-injection for Pages or proxied zones) disabled when you run Kinloom.
Automatic injection adds the beacon outside Kinloom's router, which breaks Kinloom's strict default `script-src 'self'` CSP and causes the `/privacy` page to contradict the live HTML.
Using the `webAnalytics` plugin option keeps beacon injection, scoped CSP directives, and the `/privacy` disclosure synchronized and off by default.
