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
