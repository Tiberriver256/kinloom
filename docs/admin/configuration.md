<!-- kinloom-admin-doc
id: core-configuration
title: Configuration Reference
summary: Complete reference for kinloom.config.yaml, Cloudflare Worker bindings, environment variables, Google OAuth, magic-link email delivery, and optional plugins.
external_url: https://github.com/Tiberriver256/kinloom/blob/main/docs/admin/configuration.md
-->

# Configure a Kinloom archive

This reference documents every key in `kinloom.config.yaml`, every Cloudflare Worker binding and environment variable in `KinloomWorkerEnv`, authentication provider setup, magic-link email delivery adapters, and optional built-in plugins.

<!-- kinloom-section id=kinloom-config-yaml kind=configuration keywords=config,yaml,schema,brand,privacy,wiki,map -->
## `kinloom.config.yaml` reference

Kinloom validates `kinloom.config.yaml` against `KinloomSiteConfigSchema` (`packages/core/src/schemas/config.ts`). Every key and default value is listed below.

### Top-level and `site` keys

| Key | Type | Required / Default | Description |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | Default `1` | Configuration schema version literal. |
| `site.title` | `string` | Required | Public or private archive display title (for example `"Alder Family Archive"`). |
| `site.familyName` | `string` | Required | Primary family surname or lineage label (for example `"Alder"`). |
| `site.gedcomSourceName` | `string` (`^[A-Z0-9_]+$`) | Required | Uppercase GEDCOM `SOUR` identifier stamped on GEDCOM exports (for example `"ALDER_ARCHIVE"`). |
| `site.description` | `string` | Optional | Short archive summary used in metadata and Open Graph descriptions. |
| `site.footerCredit` | `string` | Default `"Built with Kinloom"` | Attribution text rendered in the page footer when `brand.showFooterCredit` is `true`. |
| `defaultBranchId` | `string` | Optional | Branch ID selected by default in tree and directory views. |
| `featuredDocumentId` | `string` | Optional | Source or media ID highlighted on the archive home page. |
| `plugins` | `string[]` | Optional | Explicit list of CLI plugin module paths or package specifiers to load alongside `extensions/*/cli.mjs`. |
| `extensions` | `Record<string, unknown>` | Optional | Archive-specific extension configuration passed through to custom plugins. |

### `theme` and `brand` keys

| Key | Type | Required / Default | Description |
| --- | --- | --- | --- |
| `theme.accent` | 6-digit hex | Optional | Primary light-theme accent color (for example `"#7A4612"`). |
| `theme.accentDark` | 6-digit hex | Optional | Optional dark-theme accent color override. |
| `brand.siteName` | `string` | Optional | Short site name for web manifest and Open Graph tags. |
| `brand.title` | `string` | Optional | Title override for generated brandkit icons and Open Graph cards. |
| `brand.subtitle` | `string` | Optional | Subtitle line on the generated Open Graph card. |
| `brand.metadataLine` | `string` | Optional | Monospace metadata line on the generated Open Graph card. |
| `brand.accent` | 6-digit hex | Optional | Accent override for brandkit card and icon rendering. |
| `brand.surface` | `'parchment' \| 'navy'` | Default `'parchment'` | Surface palette for generated brandkit cards and icons. |
| `brand.themeColorLight` | 6-digit hex | Default `'#F5EFE2'` | Light-mode browser `theme-color` meta value. |
| `brand.themeColorDark` | 6-digit hex | Default `'#171614'` | Dark-mode browser `theme-color` meta value. |
| `brand.ogImage` | `string` | Optional | Path or URL to the default Open Graph preview image. |
| `brand.ogImageAlt` | `string` | Optional | Accessible alt text for the default Open Graph image. |
| `brand.markSvg` | `string` | Optional | Path to a custom SVG mark embedded by `kinloom brandkit`. |
| `brand.vignetteImage` | `string` | Optional | Path to an archival vignette image for split-layout Open Graph cards. |
| `brand.showFooterCredit` | `boolean` | Default `true` | Controls whether `site.footerCredit` renders in the footer. |
| `brand.dynamicOg` | `boolean` | Default `false` | Enables dynamic `/og/person/:id.svg` preview cards for confirmed-deceased people. |

### Lineage, map, and timeline keys

| Key | Type | Required / Default | Description |
| --- | --- | --- | --- |
| `branches[]` | `BranchConfig[]` | Default `[]` | Lineage branch definitions (`id`, `label`, optional `description`, `surnames[]`, `lineageGroups[]`, `supportsDirectMode` default `true`). |
| `lineageSections[]` | `LineageSectionConfig[]` | Default `[]` | Grouped sections on the People Directory (`id`, `title`, optional `subtitle`, `lineageGroups[]`, optional `branchId`). |
| `featuredKinshipPairs[]` | `FeaturedKinshipPair[]` | Default `[]` | Preset relationship lookups on the Kinship page (`fromId`, `toId`, `label`, optional `note`). |
| `migrationEras[]` | `MigrationEraConfig[]` | Default `[]` | Named geographic and chronological eras on the Migration Map (`id`, `label`, optional `description`, `color`, `minLat`, `maxLat`, `minLng`, `maxLng`, `startYear`, `endYear`). |
| `mapDefaults.centerLat` | `number` (`-90..90`) | Default `38.5` | Initial map center latitude. |
| `mapDefaults.centerLng` | `number` (`-180..180`) | Default `-96.0` | Initial map center longitude. |
| `mapDefaults.zoom` | `number` (`1..18`) | Default `4` | Initial map zoom level. |
| `mapDefaults.minSpanDeg` | `number` (`> 0`) | Default `1.2` | Minimum bounding-box span in degrees when fitting map pins. |
| `anchorYears[]` | `{ year: number, label: string }[]` | Optional | Historical anchor markers shown on the Time explorer. |
| `pronunciations` | `Record<string, Pronunciation>` | Optional | Shared name and place pronunciation lexicon entries. |

### `privacy` and `wiki` keys

| Key | Type | Required / Default | Description |
| --- | --- | --- | --- |
| `privacy.livingCutoffYears` | `integer` (`1..150`) | Default `101` | Cutoff age in years used to treat undated-death records as deceased (`birthYear <= referenceYear - livingCutoffYears`). |
| `privacy.referenceYear` | `integer` (`1900..2200`) | Optional | Optional fixed reference year for deterministic privacy compilation (defaults to current UTC year at runtime). |
| `privacy.privateModeShowsBirthYear` | `boolean` | Default `true` | Shows birth year only (never month or day) for living relatives on private archives. |
| `privacy.stripLivingPortraits` | `boolean` | Default `true` | Strips portraits and media counts from living person records. |
| `privacy.stripLivingResidenceSpans` | `boolean` | Default `true` | Omits residence spans linked to living people. |
| `privacy.markGedcomLivingConfidential` | `boolean` | Default `true` | Marks living people confidential when exporting GEDCOM. |
| `wiki.allowTalk` | `boolean` | Default `true` | Enables entity Talk discussion threads for signed-in editors. |
| `wiki.allowWatchlists` | `boolean` | Default `false` | Enables watchlist support when implemented by the archive UI. |
| `wiki.maxUploadBytes` | `integer` (`> 0`) | Default `15728640` (15 MiB) | Maximum upload size in bytes for standard image uploads. |

<!-- kinloom-section id=worker-bindings-and-env kind=configuration keywords=wrangler,bindings,env,secrets,d1,r2,assets,archive_mode -->
## Cloudflare Worker bindings and environment variables

`createCloudflareWorker` reads bindings, plain text vars, and Wrangler secrets from `KinloomWorkerEnv` (`packages/worker/src/types.ts`).

### Worker bindings (`wrangler.jsonc`)

| Binding | Type | Required | Purpose |
| --- | --- | --- | --- |
| `DB` | D1 Database | Yes | Stores entities, kinship edges, append-only revisions, users, invites, magic links, agent tokens, talk comments, plugin settings, and plugin tables. |
| `MEDIA_BUCKET` | R2 Bucket | Yes | Stores content-addressed uploaded media (`media/<sha256>.<ext>`), source scans, and the compiled `compiled/archive.json` bundle cache. |
| `ASSETS` | Static Assets (`Fetcher`) | Recommended | Serves the built Vite SPA (`dist/`) with `run_worker_first: true` so the Worker enforces authentication and security headers on `/api/*`, `/media/*`, `/sources/*`, and `/data/*`. |
| `SEND_EMAIL` | Cloudflare Email Service (`SendEmailBinding`) | Optional | Sends one-time magic-link sign-in emails through the built-in `CloudflareEmailSender`. |

### Secrets and environment variables

Store secrets with `npx wrangler secret put <NAME>`. Store non-secret variables under `"vars"` in `wrangler.jsonc`.

| Variable | Kind | Required / Default | Purpose |
| --- | --- | --- | --- |
| `SESSION_SECRET` | Secret | Required (min 16 chars; use 32+ random bytes) | Signs HMAC session cookies and OAuth state cookies. |
| `BOOTSTRAP_ADMIN_EMAIL` | Secret or Var | Optional (recommended) | Email address granted the `admin` role automatically on sign-in. |
| `ARCHIVE_MODE` | Var | Default `'private'` (`'private'` or `'public'`) | Controls whether anonymous visitors can read the redacted archive (`public`) or must authenticate (`private`). |
| `GOOGLE_CLIENT_ID` | Secret or Var | Optional | Google OAuth 2.0 Web Client ID. Enables Google sign-in when paired with `GOOGLE_CLIENT_SECRET`. |
| `GOOGLE_CLIENT_SECRET` | Secret | Optional | Google OAuth 2.0 Web Client Secret. |
| `EMAIL_FROM` | Var | Optional (`DEFAULT_EMAIL_FROM` fallback) | Verified sender email address used by `CloudflareEmailSender` (for example `noreply@archive.example.test`). Set this to an address on your own verified sending domain. |
| `GEMINI_API_KEY` | Secret | Optional | Enables on-demand pronunciation audio synthesis via `GeminiPronunciationAudioGenerator`. |
| `GEMINI_TTS_MODEL` | Var | Default `'gemini-3.8-flash-tts'` | Gemini TTS model ID for `GeminiPronunciationAudioGenerator`. |
| `CF_WEB_ANALYTICS_TOKEN` | Var | Optional | Token used when configuring Cloudflare Web Analytics via `createWorkersObservabilityPlugin`. |
| `KINLOOM_BUILD_SHA` | Var | Optional | Git commit SHA surfaced in `/admin` System Diagnostics (`GET /api/admin/system`). |
| `KINLOOM_BUILD_TIMESTAMP` | Var | Optional | ISO-8601 build timestamp surfaced in `/admin` System Diagnostics. |
| `KINLOOM_COMPATIBILITY_DATE` | Var | Optional | Workers `compatibility_date` surfaced in `/admin` System Diagnostics. |

<!-- kinloom-section id=google-oauth-setup kind=configuration keywords=oauth,google,pkce,callback,auth -->
## Configure Google OAuth 2.0 (PKCE)

Kinloom implements OAuth 2.0 Authorization Code flow with PKCE (`S256`) and a short-lived signed state cookie (`__Host-kinloom_oauth`, 10-minute TTL).

1. In Google Cloud Console, open **APIs & Services** and select **Credentials**.
2. Create an **OAuth client ID** of type **Web application**.
3. Under **Authorized JavaScript origins**, add your archive origin:

```text
https://archive.example.test
```

4. Under **Authorized redirect URIs**, add the exact callback path:

```text
https://archive.example.test/api/auth/google/callback
```

5. Store the client credentials as Wrangler secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

6. Redeploy with `npx wrangler deploy`, then verify `GET /api/auth/me` reports `authProviders.google: true` and test signing in with `BOOTSTRAP_ADMIN_EMAIL`.

Only Google accounts with `email_verified: true` can sign in. Accounts that are neither `BOOTSTRAP_ADMIN_EMAIL`, already enrolled in `users`, nor holding an active family invite cookie receive HTTP `403 INVITE_REQUIRED`.

<!-- kinloom-section id=magic-link-email kind=configuration keywords=email,magic-link,send_email,cloudflare-email,resend -->
## Configure magic-link email delivery

Magic links expire after 15 minutes, are single-use, and are rate-limited to 10 requests per hour per email address. Kinloom returns a constant HTTP `202` response for unenrolled email addresses to prevent email enumeration.

You can deliver magic links with the built-in Cloudflare Email Service binding or with a custom HTTP `EmailSender` adapter such as Resend.

### Option 1: Built-in Cloudflare Email Service (`SEND_EMAIL`)

`@kinloom/worker` wires `CloudflareEmailSender` automatically when you declare a `send_email` binding named `SEND_EMAIL` in `wrangler.jsonc`.

1. Enable Email Routing / Email Sending on your domain in Cloudflare and verify your sending domain.
2. Add `send_email` and `EMAIL_FROM` to `wrangler.jsonc`:

```jsonc
{
	"send_email": [
		{
			"name": "SEND_EMAIL"
		}
	],
	"vars": {
		"ARCHIVE_MODE": "private",
		"EMAIL_FROM": "noreply@archive.example.test"
	}
}
```

3. Redeploy with `npx wrangler deploy`.

**Workers Free plan restriction (`E_RECIPIENT_PLAN_RESTRICTED`):** On the Cloudflare Workers Free plan, Cloudflare Email Service delivers mail only to verified destination addresses on your account and rejects other recipients with `E_RECIPIENT_PLAN_RESTRICTED` (surfaced by Kinloom as HTTP `502 EMAIL_RECIPIENT_NOT_ALLOWED`). Upgrade to a Cloudflare Workers Paid plan to send to arbitrary family email addresses, or use a custom HTTP `EmailSender` adapter below.

### Option 2: Custom Resend (or HTTP) `EmailSender` adapter

Implement `@kinloom/core`'s `EmailSender` interface and pass it into `createCloudflareWorker({ siteConfig, emailSender })`. Store `RESEND_API_KEY` with `npx wrangler secret put RESEND_API_KEY`.

```ts
import type { EmailSender } from '@kinloom/core';
import { createCloudflareWorker, type KinloomWorkerEnv } from '@kinloom/worker';
import { siteConfig } from './siteConfig.js';

interface ArchiveEnv extends KinloomWorkerEnv {
	RESEND_API_KEY?: string;
}

function createResendEmailSender(apiKey: string, fromEmail: string): EmailSender {
	return {
		adapterKind: 'resend',
		async sendMagicLink({ toEmail, siteTitle, magicLinkUrl, expiresMinutes }) {
			const response = await fetch('https://api.resend.com/emails', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${apiKey}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					from: `${siteTitle} <${fromEmail}>`,
					to: [toEmail],
					subject: `Sign in to ${siteTitle}`,
					text: `Open this one-time link to sign in (expires in ${expiresMinutes} minutes):\n\n${magicLinkUrl}`,
				}),
			});
			if (!response.ok) {
				throw new Error(`Resend API error: HTTP ${response.status}`);
			}
		},
	};
}

export default {
	fetch(request: Request, env: ArchiveEnv, ctx?: ExecutionContext): Promise<Response> {
		const emailSender = env.RESEND_API_KEY
			? createResendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM ?? 'noreply@archive.example.test')
			: undefined;
		return createCloudflareWorker({ siteConfig, emailSender }).fetch(request, env, ctx);
	},
};
```

<!-- kinloom-section id=optional-plugins-and-settings kind=configuration keywords=plugins,observability,plugin-settings,open-finance,book-publishing,recipes,audio,pronunciation -->
## Enable optional built-in plugins and runtime settings

Every optional Kinloom plugin is disabled by default so unconfigured archives expose zero extra routes, scripts, or UI controls. Register plugins in `createCloudflareWorker({ siteConfig, plugins: [...] })` and `<KinloomApp plugins={[...]} />`, then manage their runtime settings and write-only API keys inside `/admin` under **Plugins & Integrations**.

- **Workers Observability, Security Telemetry, Web Analytics, and Page Visit Stats:** Enable `createWorkersObservabilityPlugin()` and `createPageVisitStatsPlugin()` (`0005_page_visit_stats.sql`) for privacy-safe JSON request logs, `Server-Timing`, WAF guidance, and aggregate visit counts. See [Cloudflare Workers observability](../observability.md).
- **Declarative Plugin Settings (`settingsSchema`):** Non-secret plugin settings persist in `plugin_settings`, and write-only secrets persist in `plugin_setting_secrets` (`0004_plugin_settings.sql`) and are never echoed back in plain text. See [Declarative plugin settings schema](../plugin-settings.md).
- **Open Finance and Donations:** Publish a transparent hosting cost ledger and strictly allowlisted external donation links with `createOpenFinancePlugin()`. See [Open Finance plugin](../open-finance.md).
- **Hardcover Book Publishing:** Compile landscape hardcover interior and cover PDFs and request print-on-demand quotes with `createBookPublishingServerPlugin()`, `createBookPublishingPlugin()`, and `createBookPublishingCliPlugin()`. See [Book publishing plugin](../book-publishing.md).
- **Family Recipes:** Enable `createRecipesServerPlugin()` and `createRecipesUiPlugin()` to add `/recipes` and ancestor-linked recipe cards. Apply `0006_plugin_migrations.sql` and run `kinloom migrate --remote --plugin-migrations` for the `recipes` namespace (`plugin_recipes_*` tables).
- **Pronunciation Guide:** Register `createPronunciationPlugin()` to configure Gemini, OpenAI-compatible GPU speech, or Chirp 3 HD TTS backends in `/admin`. Run `kinloom pronounce audit` and `kinloom pronounce synth` from `@kinloom/cli`. For self-hosted GPU TTS, see [Colab GPU TTS](../colab-gpu-tts.md).
- **Narrative Audio:** Register `createNarrativeAudioPlugin()` in `@kinloom/ui` to attach inline audio narration players to deceased-person biographies and family stories generated with `kinloom narrative-audio`.
