# Declarative Plugin Settings Schema

Kinloom plugins can declare a typed `settingsSchema` on `KinloomServerPlugin`.
The server validates updates against the schema, persists non-secret values and secrets in isolated storage, and renders the settings form automatically inside **Admin Settings** (`AdminSettingsShell`).

## Declare `settingsSchema` on a server plugin

Add `settingsSchema`, optional `getReadonlySettings`, and optional `onSettingsUpdated` to your `KinloomServerPlugin`:

```ts
import type { PluginSettingsSchema } from '@kinloom/core';
import type { KinloomServerPlugin } from '@kinloom/server';

const myPluginSchema: PluginSettingsSchema = {
  title: 'Archival Publisher',
  description: 'Configure publication endpoints and write-only credentials.',
  sections: [
    {
      id: 'status',
      title: 'Runtime Status',
      fields: [
        {
          key: 'adapter_mode',
          label: 'Storage Adapter',
          type: 'readonly',
          defaultValue: 'unknown',
        },
      ],
    },
    {
      id: 'config',
      title: 'Endpoint Settings',
      fields: [
        {
          key: 'endpoint_url',
          label: 'Webhook URL',
          type: 'url',
          allowedProtocols: ['https:'],
          required: true,
          helpText: 'HTTPS endpoint that receives archive release notices.',
        },
        {
          key: 'max_retries',
          label: 'Maximum Retries',
          type: 'number',
          defaultValue: 3,
          integer: true,
          min: 0,
          max: 10,
        },
        {
          key: 'enabled',
          label: 'Enable Release Notifications',
          type: 'boolean',
          defaultValue: true,
        },
        {
          key: 'format',
          label: 'Payload Format',
          type: 'select',
          defaultValue: 'json',
          options: [
            { value: 'json', label: 'JSON' },
            { value: 'atom', label: 'Atom Feed' },
          ],
        },
      ],
    },
    {
      id: 'credentials',
      title: 'Credentials (Write-Only)',
      fields: [
        {
          key: 'api_key',
          label: 'Publisher API Key',
          type: 'string',
          secret: true,
          minLength: 8,
          helpText: 'Write-only API key. Never echoed back in plain text.',
        },
      ],
    },
  ],
};

export function createPublisherPlugin(): KinloomServerPlugin {
  return {
    id: 'example-publisher',
    name: 'Archival Publisher',
    version: '1.0.0',
    settingsSchema: myPluginSchema,
    getReadonlySettings: ({ ports }) => ({
      adapter_mode: ports.repository.adapterKind ?? 'custom',
    }),
    onSettingsUpdated: ({ values, configuredSecrets }) => {
      // React to saved settings without exposing secret plaintext.
      void values;
      void configuredSecrets;
    },
  };
}
```

## Supported field types

| Field `type` | Purpose | Key options |
| --- | --- | --- |
| `string` | Single-line string or write-only secret when `secret: true` | `secret?: boolean`, `defaultValue`, `required`, `minLength`, `maxLength`, `pattern`, `patternMessage`, `allowlist`, `validate` |
| `text` | Text string (also supports `secret: true`) | Same options as `string` |
| `url` | Validated absolute URL | `allowedProtocols` (defaults to `['https:', 'http:']`), `defaultValue`, `required`, `pattern`, `allowlist`, `validate` |
| `number` | Finite numeric input | `defaultValue`, `required`, `min`, `max`, `integer`, `step`, `validate` |
| `boolean` | Accessible switch toggle | `defaultValue`, `validate` |
| `select` | Labeled dropdown selection | `options: [{ value, label, description? }]`, `defaultValue`, `required`, `validate` |
| `secret` | Dedicated write-only masked credential | `required`, `minLength`, `maxLength`, `pattern`, `patternMessage`, `validate` |
| `readonly` | Non-editable runtime/backend status display | `defaultValue` (overridden dynamically by `getReadonlySettings`) |

## Write-only secret handling (`secret: true` and `type: 'secret'`)

Both `{ type: 'string', secret: true }` (or `{ type: 'text', secret: true }`) and `{ type: 'secret' }` use identical write-only security controls:

1. **Isolated storage.** `PluginSettingsStore` separates non-secret values (`plugin_settings` table in D1) from secrets (`plugin_setting_secrets` table in D1). Metadata queries select only `field_key` and `updated_at`, never `secret_value`.
2. **Never echoed on read.** `GET /api/admin/plugin-settings` and `PUT /api/admin/plugin-settings/:pluginId` return `{ configured: boolean, updated_at: string | null }` for every secret field. Plaintext secrets never appear in API responses, `/api/admin/system`, `/api/bundle`, public HTML, or observability logs.
3. **Preserved on partial updates.** Updating unrelated non-secret fields omits secret mutations, so stored secrets remain intact until an admin explicitly submits `{ action: 'set', value }` or `{ action: 'clear' }`.
4. **No secret defaults.** Schema validation fails fast at startup if a secret field declares `defaultValue`.

## Admin HTTP API contract

Both endpoints enforce CSRF origin validation (`enforceCsrfOrigin`) and administrator RBAC (`requireMinRole(..., 'admin')`). Unauthenticated requests receive `401`, and non-admin callers receive `403 ADMIN_REQUIRED`.

### `GET /api/admin/plugin-settings`

Returns sanitized snapshots for all registered server plugins that declare `settingsSchema`:

```json
{
  "plugins": [
    {
      "plugin_id": "kinloom-pronunciation",
      "plugin_name": "Pronunciation & TTS",
      "plugin_version": "0.43.0",
      "status": "active",
      "schema": { "...": "SerializablePluginSettings" },
      "values": {
        "primary_backend": "gemini",
        "fallback_backend": "none",
        "default_voice": "Charon",
        "phoneme_mode": "ipa"
      },
      "secrets": {
        "gemini_api_key": { "configured": true, "updated_at": "2026-11-27T12:00:00.000Z" }
      },
      "readonly_values": {
        "active_generator": "gemini-tts",
        "lexicon_store": "d1",
        "configured_credentials": "gemini"
      },
      "updated_at": "2026-11-27T12:00:00.000Z",
      "updated_by": "steward@archive.example"
    }
  ]
}
```

### `PUT /api/admin/plugin-settings/:pluginId`

Accepts partial non-secret `values` and explicit write-only `secrets` mutations (`keep`, `set`, `clear`):

```json
{
  "values": {
    "default_voice": "Kore",
    "phoneme_mode": "arpabet"
  },
  "secrets": {
    "gemini_api_key": { "action": "set", "value": "AIza-example-key" },
    "openai_api_key": { "action": "clear" }
  }
}
```

- Unknown plugin IDs or malformed payloads return `400` (`UNKNOWN_PLUGIN` or `VALIDATION_ERROR`).
- Schema violations (unknown fields, read-only edits, secret keys sent inside `values`, constraint failures, or custom validator errors) return `422 VALIDATION_ERROR` with `error.details.field_errors`.

## Built-in reference plugins

- **Cloudflare Workers Observability (`createWorkersObservabilityPlugin`):** Exposes read-only runtime platform, storage/email bindings, observability status, `Server-Timing`, security telemetry, and Web Analytics state, plus runtime toggles for `Server-Timing`, `X-Request-Id`, and minimum structured log level.
- **Pronunciation & TTS (`createPronunciationPlugin`):** Exposes active TTS adapter and lexicon store status, primary and fallback TTS backends (`gemini`, `openai-speech`, `chirp3-hd`, `disabled`), OpenAI-compatible endpoint URL, default model and voice, phoneme mode (`ipa`, `arpabet`, `plain`), auto-generate toggle, and write-only masked provider API keys (`{ type: 'string', secret: true }` and `{ type: 'secret' }`).
- **Open Finance & Donations (`createOpenFinancePlugin`):** Off by default. Exposes read-only ledger status and monthly/annual cost totals, visibility toggles, display currency, strictly allowlisted external donation URLs, primary CTA selection, and cost ledger JSON. See [docs/open-finance.md](open-finance.md).
- **Archival Book Publishing (`createBookPublishingServerPlugin`):** Off by default. Exposes read-only active publisher/renderer status, provider & environment selection (`mock` or `lulu`, `sandbox` or `production`), landscape trim/binding/paper defaults, publisher contact email, and write-only masked secrets (`lulu_client_id`, `lulu_client_secret`, `lulu_webhook_secret`, optional `cloudflare_browser_api_token`). See [docs/book-publishing.md](book-publishing.md).

## Cloudflare D1 migration

Apply migration `0004_plugin_settings.sql` via `kinloom migrate` (or Wrangler D1 migrations) to create the `plugin_settings` and `plugin_setting_secrets` tables.
