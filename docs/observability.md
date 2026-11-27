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
