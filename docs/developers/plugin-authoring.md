# Kinloom plugin authoring guide

**Diataxis mode:** Tutorial and reference.

Kinloom plugins extend an archive across four surfaces without forking core packages: `@kinloom/server` (HTTP routes, settings, scoped SQL tables, and lifecycle hooks), `@kinloom/worker` (Cloudflare Workers wiring), `@kinloom/ui` (React routes, named slots, media renderers, and entity form overrides), and `@kinloom/cli` (custom subcommands and audit/verify checks).

All plugins stay **off by default**. An unconfigured Kinloom archive exposes zero plugin routes, renders zero plugin UI chrome, and creates zero plugin tables.

## How one plugin composes across four surfaces

Throughout this guide we build one synthetic plugin, **Archival Field Notes** (`archival-field-notes`), for the fictional **Alder Family Archive** (`archive.example.test`). Researchers can save short source-backed field notes on deceased ancestors, browse them at `/field-notes`, configure limits in **Admin Settings**, and check archive hygiene from the CLI.

```text
kinloom.config.yaml / extensions/field-notes/cli.mjs
        │
        ├── @kinloom/cli     KinloomCliPlugin       (kinloom field-notes, auditChecks, verifyChecks)
        ├── @kinloom/ui      KinloomUiPlugin        (/field-notes route, indexWidgets & personRelated slots)
        └── @kinloom/worker  createCloudflareWorker
                │
                └── @kinloom/server  KinloomServerPlugin
                      ├── /api/plugins/field-notes  (CSRF + RBAC + archive_read)
                      ├── settingsSchema            (Admin UI form + write-only secrets)
                      └── databaseNamespace         (plugin_field_notes_* tables via PluginDatabasePort)
```

Every TypeScript block tagged `ts kinloom-check` or `tsx kinloom-check` in this guide is compiled against the workspace `@kinloom/*` packages by `node scripts/check-docs.mjs --typecheck-snippets`.

## 1. Server plugins (`@kinloom/server` and `@kinloom/core`)

A server plugin implements `KinloomServerPlugin` (base fields in `@kinloom/core`, extended with HTTP lifecycle and document hooks in `@kinloom/server`).

### Complete server plugin example

```ts kinloom-check
import type {
	KinloomServerPluginContext,
	PluginSettingsSchema,
	PluginSqlMigration,
} from '@kinloom/core';
import type { KinloomServerPlugin } from '@kinloom/server';
import { z } from 'zod';

export const FIELD_NOTES_PLUGIN_ID = 'archival-field-notes';
export const FIELD_NOTES_DATABASE_NAMESPACE = 'field_notes';
export const FIELD_NOTES_API_PREFIX = '/api/plugins/field-notes';

export const FIELD_NOTES_MIGRATIONS: readonly PluginSqlMigration[] = [
	{
		version: 1,
		id: '0001_field_notes_initial',
		description: 'Create namespaced archival field notes table and person index.',
		sql: `
			CREATE TABLE IF NOT EXISTS plugin_field_notes_entries (
				id TEXT PRIMARY KEY,
				person_id TEXT NOT NULL,
				summary TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_plugin_field_notes_person
				ON plugin_field_notes_entries (person_id, created_at DESC);
		`,
	},
];

export const FIELD_NOTES_SETTINGS_SCHEMA: PluginSettingsSchema = {
	title: 'Archival Field Notes',
	description: 'Configure researcher field notes and optional outbound webhook delivery.',
	preserveKeys: ['last_exported_at'],
	sections: [
		{
			id: 'runtime',
			title: 'Runtime Status',
			fields: [
				{
					key: 'storage_adapter',
					label: 'Database Adapter',
					type: 'readonly',
					defaultValue: 'unconfigured',
				},
			],
		},
		{
			id: 'general',
			title: 'General',
			fields: [
				{
					key: 'max_summary_chars',
					label: 'Maximum Summary Length',
					type: 'number',
					defaultValue: 280,
					integer: true,
					min: 40,
					max: 1000,
				},
				{
					key: 'webhook_token',
					label: 'Webhook Signing Token',
					type: 'string',
					secret: true,
					minLength: 16,
					helpText: 'Write-only token. Kinloom never echoes secret values back to the browser.',
				},
			],
		},
	],
};

const FieldNoteRowSchema = z.object({
	id: z.string(),
	person_id: z.string(),
	summary: z.string(),
	created_at: z.string(),
});

const CreateFieldNoteBodySchema = z.object({
	person_id: z.string().min(1),
	summary: z.string().trim().min(1).max(1000),
});

export interface FieldNotesServerPluginOptions {
	readonly enabled?: boolean;
}

export function createFieldNotesServerPlugin(
	options: FieldNotesServerPluginOptions = {}
): KinloomServerPlugin {
	const enabled = options.enabled === true;
	let maxSummaryChars = 280;

	return {
		id: FIELD_NOTES_PLUGIN_ID,
		name: 'Archival Field Notes',
		version: '1.0.0',
		status: enabled ? 'active' : 'disabled',
		databaseNamespace: FIELD_NOTES_DATABASE_NAMESPACE,
		migrations: FIELD_NOTES_MIGRATIONS,
		settingsSchema: FIELD_NOTES_SETTINGS_SCHEMA,
		documentContributions: enabled
			? {
					privacyDisclosures: [
						{
							id: 'field-notes-storage',
							summary:
								'Archival Field Notes stores researcher notes for deceased ancestors inside this archive database.',
						},
					],
				}
			: undefined,
		getStatus: () => ({
			status: enabled ? 'active' : 'disabled',
			detail: enabled ? `max_summary_chars=${maxSummaryChars}` : 'Plugin disabled by configuration.',
		}),
		getReadonlySettings: ({ ports }) => ({
			storage_adapter: ports.pluginDatabaseFactory?.adapterKind ?? 'none',
		}),
		onSettingsUpdated: ({ values }) => {
			if (typeof values.max_summary_chars === 'number') {
				maxSummaryChars = values.max_summary_chars;
			}
		},
		onRevisionCommitted: async ({ headRevisionId }) => {
			void headRevisionId;
		},
		routes: enabled
			? [
					{
						method: 'GET',
						pathPrefix: FIELD_NOTES_API_PREFIX,
						minRole: 'archive_read',
						async handle(ctx: KinloomServerPluginContext): Promise<Response> {
							if (!ctx.pluginDb) {
								return Response.json(
									{ error: { code: 'PLUGIN_DB_UNAVAILABLE', message: 'Plugin DB is not configured.' } },
									{ status: 503 }
								);
							}
							const personId = ctx.url.searchParams.get('personId');
							const rows = personId
								? await ctx.pluginDb.query(
										'SELECT id, person_id, summary, created_at FROM plugin_field_notes_entries WHERE person_id = ? ORDER BY created_at DESC LIMIT 50',
										[personId],
										(raw) => FieldNoteRowSchema.parse(raw)
									)
								: await ctx.pluginDb.query(
										'SELECT id, person_id, summary, created_at FROM plugin_field_notes_entries ORDER BY created_at DESC LIMIT 50',
										[],
										(raw) => FieldNoteRowSchema.parse(raw)
									);
							return Response.json({ mode: ctx.mode ?? 'private', items: rows });
						},
					},
					{
						method: 'POST',
						pathPrefix: FIELD_NOTES_API_PREFIX,
						minRole: 'editor',
						async handle(ctx: KinloomServerPluginContext): Promise<Response> {
							if (!ctx.pluginDb) {
								return Response.json(
									{ error: { code: 'PLUGIN_DB_UNAVAILABLE', message: 'Plugin DB is not configured.' } },
									{ status: 503 }
								);
							}
							const body = CreateFieldNoteBodySchema.parse(await ctx.request.json());
							if (body.summary.length > maxSummaryChars) {
								return Response.json(
									{ error: { code: 'VALIDATION_ERROR', message: `Summary exceeds ${maxSummaryChars} characters.` } },
									{ status: 422 }
								);
							}
							const livingIds = await ctx.ports.repository.getLivingPersonIds();
							if (livingIds.has(body.person_id)) {
								return Response.json(
									{ error: { code: 'LIVING_PERSON_FORBIDDEN', message: 'Field notes apply only to deceased people.' } },
									{ status: 422 }
								);
							}
							const id = crypto.randomUUID();
							const createdAt = ctx.ports.clock.nowIso();
							await ctx.pluginDb.run(
								'INSERT INTO plugin_field_notes_entries (id, person_id, summary, created_at) VALUES (?, ?, ?, ?)',
								[id, body.person_id, body.summary, createdAt]
							);
							return Response.json(
								{ id, person_id: body.person_id, summary: body.summary, created_at: createdAt },
								{ status: 201 }
							);
						},
					},
				]
			: [],
	};
}
```

### Route roles, CSRF, and reserved server prefixes

`createKinloomServer` runs `validateAndCompilePluginRoutes(plugins)` at startup and throws a `RangeError` if any plugin ID is empty or duplicated, if two routes overlap on method and prefix, or if any route collides with `RESERVED_SERVER_ROUTE_PREFIXES` (`packages/server/src/http/router.ts`):

- `/api/bundle`, `/api/entities`, `/api/revisions`, `/api/batches`, `/api/export`
- `/api/auth`, `/api/media`, `/api/talk`
- `/api/admin/invites`, `/api/admin/agent-tokens`, `/api/admin/users`, `/api/admin/system`, `/api/admin/plugin-settings`
- `/api/pronunciations`, `/api/pronunciation`
- `/privacy`, `/og`, `/invite`, `/media`, `/sources`, `/data`

Use `/api/plugins/<plugin-slug>` for plugin HTTP endpoints. Before invoking `route.handle(ctx)`, the router enforces:

1. **CSRF origin checks (`enforceCsrfOrigin`).** All `POST`, `PUT`, `PATCH`, and `DELETE` requests authenticated via cookies must carry a same-origin `Origin` header, or the server rejects them with HTTP `403 CSRF_ORIGIN_MISMATCH`.
2. **Role enforcement (`PluginRouteMinRole`).** Every route declares one of five roles:
   - `'public'`: Accessible to everyone, including anonymous visitors on private archives.
   - `'archive_read'`: Resolves to `'public'` when `ctx.mode === 'public'` and `'viewer'` when `ctx.mode === 'private'`. Use `'archive_read'` for read-only plugin pages that should match the archive's overall visibility.
   - `'viewer'`: Requires an active invite link, enrolled user, or `read_backup` / `write_batch` agent token.
   - `'editor'`: Requires an enrolled user (`editor` or `admin`) or a `write_batch` agent token.
   - `'admin'`: Requires an `admin` user (non-admins receive `403 ADMIN_REQUIRED`).
3. **Context injection.** `ctx` supplies `request`, `url`, `principal`, `siteConfig`, `ports`, `mode` (`'private' | 'public'`), scoped `pluginDb` (when `databaseNamespace` and `ports.pluginDatabaseFactory` are both present), and `emitSecurityEvent` when security telemetry plugins are active.

### Declarative plugin settings and `preserveKeys`

When a server plugin sets `settingsSchema`, Kinloom automatically exposes it on `GET /api/admin/plugin-settings` and `PUT /api/admin/plugin-settings/:pluginId`, validates updates with Zod, persists non-secret values to `plugin_settings` and secrets to `plugin_setting_secrets` (`0004_plugin_settings.sql`), and renders the form in **Admin Settings**.

- **Write-only secrets.** Mark credentials with `{ type: 'string', secret: true }` or `{ type: 'secret' }`. Secret fields cannot declare `defaultValue` and are never echoed back on read.
- **Lossless auxiliary keys (`preserveKeys`).** If your plugin also stores structured non-secret JSON keys in `plugin_settings.values_json` through a dedicated admin route, list those keys in `settingsSchema.preserveKeys` so declarative saves from **Admin Settings** carry them forward untouched. Validation fails fast if any `preserveKeys` entry collides with a secret field.
- **Live UI sync (`PluginSettingsBus`).** When an admin saves settings inside `PluginSettingsSection` or a custom plugin panel, `KinloomPluginProvider` broadcasts a `PluginSettingsSyncEvent` via `notifyPluginSettingsUpdated`. UI components subscribe with `subscribePluginSettings(pluginId, listener)` to refresh immediately without reloading the page.

See [docs/plugin-settings.md](../plugin-settings.md) for the complete field-type table and HTTP API contract.

### Plugin SQL migrations and isolated storage

Plugins that need relational tables declare `databaseNamespace` and ordered `migrations: readonly PluginSqlMigration[]`.

1. **Namespace format.** `databaseNamespace` must match `/^[a-z][a-z0-9_]{1,24}$/`. Duplicate namespaces across plugins fail fast with `RangeError`.
2. **Table and index prefixes.** Every table and view in migration DDL and runtime DML must start with `plugin_<namespace>_`. Every index must start with `idx_plugin_<namespace>_`.
3. **Forbidden core tables and directives.** Both registration-time DDL validation (`validatePluginMigrationSql`) and runtime query guards (`assertScopedPluginSql`) reject `ATTACH`, `DETACH`, `PRAGMA`, `VACUUM`, `REINDEX`, `CREATE TRIGGER`, schema-qualified targets (`main.*`), any `sqlite_*` system catalog, and all 16 core tables in `FORBIDDEN_PLUGIN_CORE_TABLES` (`entities`, `kinship_edges`, `revisions`, `users`, `invites`, `magic_links`, `agent_tokens`, `talk_comments`, `watchlists`, `pronunciation_lexicon`, `plugin_settings`, `plugin_setting_secrets`, `page_visit_daily`, `observability_cache_daily`, `d1_migrations`, `plugin_migrations`). Runtime violations throw `KinloomHttpError(500, 'PLUGIN_SQL_SCOPE_VIOLATION', ...)`.
4. **Ledger and CLI migrations.** Core migration `0006_plugin_migrations.sql` creates the `plugin_migrations` ledger keyed by `(plugin_id, version)` with SHA-256 SQL checksum verification. Apply plugin migrations programmatically with `runPluginMigrations` / `runD1PluginMigrations`, or via the CLI by placing `<NNNN>_<name>.sql` files under `migrations/plugins/<namespace>/` (optional `-- plugin_id: <id>` header comment) and running:

```bash
npx kinloom migrate --remote --plugin-migrations ./migrations/plugins
```

### Lifecycle, telemetry, document, and diagnostics hooks

| Hook or property | Purpose |
| --- | --- |
| `getStatus()` | Returns `{ status: 'active' \| 'disabled' \| 'degraded', detail?: string }` surfaced in `/api/admin/system` System Diagnostics (`AdminDiagnosticsReport`). |
| `onRevisionCommitted` | Runs after `WikiWriteService` commits revisions, receiving `{ revisions, headRevisionId }`. |
| `onRequestStart`, `onResponse`, `onError` | Observe bounded-cardinality route templates (`normalizeServerRouteTemplate`), `Server-Timing` spans, cache outcomes, and response status codes. |
| `onSecurityEvent` | Subscribes to structured security events (`SERVER_SECURITY_EVENT_TYPES`). |
| `documentContributions` | Contributes scoped `csp` (`scriptSrc`, `connectSrc`), idempotent `bodyEndHtml` snippets for 2xx HTML documents outside `/api`, `/media`, `/sources`, `/og`, and `/data`, and `privacyDisclosures` rendered on `/privacy`. |
| `onPluginError` | Configured on `createKinloomServer` or `createCloudflareWorker` to isolate and log plugin hook failures without breaking user requests. |

## 2. Cloudflare Worker wiring (`@kinloom/worker`)

Pass your server plugins to `createCloudflareWorker`. The worker entrypoint binds `D1PluginSettingsStore`, `D1PluginDatabaseFactory`, and `D1PageVisitStatsStore` automatically and executes zero plugin SQL on archives with no database plugins registered.

```ts kinloom-check
import type { KinloomSiteConfig } from '@kinloom/core';
import type { KinloomServerPlugin } from '@kinloom/server';
import { createCloudflareWorker, type ExportedHandler, type KinloomWorkerEnv } from '@kinloom/worker';

export function buildArchiveWorker(
	siteConfig: KinloomSiteConfig,
	optionalPlugins: readonly KinloomServerPlugin[] = []
): ExportedHandler<KinloomWorkerEnv> {
	return createCloudflareWorker({
		siteConfig,
		plugins: optionalPlugins,
		onPluginError: (pluginId, error) => {
			console.error(`[kinloom:plugin:${pluginId}]`, error);
		},
	});
}
```

## 3. UI plugins (`@kinloom/ui`)

A UI plugin implements `KinloomUiPlugin` from `@kinloom/ui`. Pass enabled UI plugins into `<KinloomApp plugins={[...]} />`.

### Complete UI plugin example

```tsx kinloom-check
import {
	ArchivalBanner,
	ArchivalCardGrid,
	ArchivalEmptyState,
	ArchivalPageShell,
	ArchivalSection,
	type KinloomUiPlugin,
	PersonPortrait,
	useKinloomPluginContext,
	useKinloomPlugins,
} from '@kinloom/ui';
import type React from 'react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

const FieldNotesResponseSchema = z.object({
	items: z.array(
		z.object({
			id: z.string(),
			person_id: z.string(),
			summary: z.string(),
			created_at: z.string(),
		})
	),
});

type FieldNoteItem = z.infer<typeof FieldNotesResponseSchema>['items'][number];

const FieldNotesPage: React.FC = () => {
	const { apiClient, baseUrl, getDeceasedPersonById } = useKinloomPluginContext();
	const { subscribePluginSettings } = useKinloomPlugins();
	const [items, setItems] = useState<readonly FieldNoteItem[]>([]);
	const [reloadNonce, setReloadNonce] = useState(0);

	useEffect(() => {
		return subscribePluginSettings('archival-field-notes', () => {
			setReloadNonce((n) => n + 1);
		});
	}, [subscribePluginSettings]);

	useEffect(() => {
		let cancelled = false;
		void apiClient
			.requestJson('/api/plugins/field-notes', (raw) => FieldNotesResponseSchema.parse(raw))
			.then((data) => {
				if (!cancelled) {
					setItems(data.items);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setItems([]);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [apiClient, reloadNonce]);

	return (
		<ArchivalPageShell variant="wide">
			<ArchivalBanner>
				<div>
					<h1>Archival Field Notes</h1>
					<p>Source-backed research notes attached to deceased ancestors in this archive.</p>
				</div>
			</ArchivalBanner>
			<ArchivalSection>
				{items.length === 0 ? (
					<ArchivalEmptyState
						title="No field notes yet"
						description="Add a field note from any deceased Person Profile."
					/>
				) : (
					<ArchivalCardGrid>
						{items.map((note) => {
							const person = getDeceasedPersonById(note.person_id);
							return (
								<article key={note.id} className="kl-stack">
									<div className="kl-cluster">
										<PersonPortrait
											name={person?.full_name ?? note.person_id}
											src={person?.portrait_url}
											baseUrl={baseUrl}
											size="sm"
										/>
										<strong>{person?.full_name ?? 'Archived ancestor'}</strong>
									</div>
									<p>{note.summary}</p>
								</article>
							);
						})}
					</ArchivalCardGrid>
				)}
			</ArchivalSection>
		</ArchivalPageShell>
	);
};

export function createFieldNotesUiPlugin(): KinloomUiPlugin {
	return {
		id: 'archival-field-notes',
		name: 'Archival Field Notes',
		version: '1.0.0',
		status: 'active',
		routes: [
			{
				path: '/field-notes',
				navLabel: 'Field Notes',
				navMatchPrefix: '/field-notes',
				navOrder: 50,
				navMinRole: 'public',
				component: FieldNotesPage,
			},
		],
		slots: {
			indexWidgets: ({ bundle }) => (
				<ArchivalSection aria-label="Field notes overview">
					<p>
						Field notes enabled for {bundle?.people.filter((p) => !p.is_living).length ?? 0} deceased
						people.
					</p>
				</ArchivalSection>
			),
			personRelated: ({ person }) => {
				if (!person || person.is_living) {
					return null;
				}
				return (
					<ArchivalSection aria-label="Person field notes">
						<h2>Field notes for {person.full_name}</h2>
					</ArchivalSection>
				);
			},
		},
	};
}
```

### Reserved UI routes and validation

`validateAndCompileUiPlugins` (`packages/ui/src/plugins/validatePlugins.ts`) runs inside `KinloomPluginProvider` and throws a `RangeError` on empty or duplicate plugin IDs, duplicate routes (normalizing dynamic `:param` segments), non-finite `navOrder`, duplicate `entityEditForms` or `entityCreateForms` overrides, or collisions with `RESERVED_UI_ROUTE_PATHS`:

- `/`, `/people`, `/person/:slug`, `/places`, `/place/:slug`, `/time`, `/tree`, `/map`, `/kinship`, `/evidence`, `/changes`, `/admin`

### Named UI slots reference

All 13 slots below are shipped in `KinloomUiPluginSlots` (`packages/ui/src/plugins/types.ts`). Every slot receives `KinloomUiPluginSlotContext` (`bundle`, `siteConfig`, `baseUrl`, `session`, `capabilities`, plus optional `person`, `place`, and `narrative`).

| Slot name | Host surface | Context entities provided | Notes |
| --- | --- | --- | --- |
| `indexHero` | `IndexPage` header band | `bundle`, `siteConfig` | Banner or featured callout above the archive index. |
| `indexWidgets` | `IndexPage` widget shelf | `bundle`, `siteConfig` | Renders below `indexHero` and above the people filter bar. |
| `personDetail` | `PersonPage` main column | `person` | Additional panels inside a Person Profile. |
| `personRelated` | `PersonPage` below media gallery | `person` (deceased only) | Renders strictly on deceased person profiles for linked plugin artifacts. |
| `narrativeHeader` | Narrative reader header | `narrative` | Metadata or audio controls above a family narrative. |
| `placeDetail` | `PlacePage` main column | `place` | Local history widgets or external gazetteer panels. |
| `sourceReaderFooter` | `SourceReaderDrawer` footer | `bundle`, `siteConfig` | Action bar or citation helpers at the bottom of the Source Reader. |
| `evidenceExtra` | `EvidencePage` | `bundle`, `siteConfig` | Extra audit or inventory panels alongside Sources. |
| `appShell` | Root shell sibling to routes | `bundle`, `session`, `capabilities` | Persistent across navigation (for example, audio bars or page-visit beacons). |
| `topBarNav` | `ExplorerTopBar` desktop nav | `session`, `capabilities` | Inline nav items alongside core links. |
| `topBarMobileMenu` | `ExplorerTopBar` mobile menu | `session`, `capabilities` | Matching mobile drawer menu items. |
| `footer` | `KinloomFooter` | `siteConfig` | Quiet colophon or disclosure links (for example, Open Finance `/support`). |
| `adminSettings` | `AdminSettingsShell` | `session`, `capabilities` | Admin-only custom panels alongside automatic `settingsSchema` forms. |

### Styling, light and dark contrast, media renderers, and entity forms

- **Design tokens and layout primitives.** Style plugin views with `@kinloom/tokens` CSS variables (`--surface-canvas`, `--surface-card`, `--surface-linen`, `--text-primary`, `--text-secondary`, `--accent-primary`, `--border-decorative`, `--action-focus`), `ArchivalLayout` components, `ArchivalPrimitives`, `<ArchivalImage>`, and `<PersonPortrait>`. Avoid hardcoded hex colors so your UI inherits both light Cotton Rag and dark Warm Slate AAA contrast modes automatically.
- **Custom `mediaRenderers`.** Supply `{ match: (media) => boolean, render: ({ media, src }) => React.ReactNode }` to override rendering for custom media formats or interactive viewers.
- **Custom `entityEditForms` and `entityCreateForms`.** Register an `EntityEditFormEntry` or `EntityCreateFormEntry` keyed by `EntityType` to replace or extend inline wiki edit drawers and creation modals. Only one plugin may own a given entity type per site.
- **Persistent state (`provider`).** Set `provider: React.ComponentType<{ children: React.ReactNode }>` when multiple slots and routes need shared React context across navigation.

## 4. CLI plugins (`@kinloom/cli`)

A CLI plugin implements `KinloomCliPlugin` (`packages/cli/src/pluginTypes.ts`) and can register custom subcommands, `kinloom audit` checks, and `kinloom verify` checks.

### Discovery order

`discoverSiteCliPlugins(cwd)` (`packages/cli/src/plugins.ts`) loads CLI plugins from two locations:

1. Specifiers listed in `kinloom.config.yaml` under `plugins: []` (relative file paths, directory paths containing `cli.mjs` or `cli.js`, `file:` URLs, or installed npm packages).
2. Subdirectories under `<archive>/extensions/<name>/` that export a valid plugin as `default`, `cliPlugin`, or `plugin` from `cli.mjs` (preferred) or `cli.js`.

### Complete CLI plugin example

```ts kinloom-check
import { EXIT_OK, type KinloomCliPlugin } from '@kinloom/cli';

export function createFieldNotesCliPlugin(): KinloomCliPlugin {
	return {
		id: 'archival-field-notes-cli',
		name: 'Archival Field Notes CLI',
		commands: [
			{
				name: 'field-notes',
				summary: 'Inspect local field notes configuration for this archive.',
				help: 'Usage: kinloom field-notes [--json]\n\nPrints field-notes plugin status for the current archive.',
				run: (args, ctx) => {
					const asJson = args.includes('--json');
					const title = ctx.siteConfig?.site.title ?? 'Unconfigured Archive';
					ctx.io.stdout(
						asJson ? `${JSON.stringify({ plugin: 'archival-field-notes', title })}\n` : `${title}: ready\n`
					);
					return EXIT_OK;
				},
			},
		],
		auditChecks: [
			{
				id: 'field-notes-summary',
				name: 'Field Notes Summary Check',
				run: ({ patch }) => ({
					errors: [],
					warnings: typeof patch.notes === 'string' && patch.notes.trim().length > 0
						? []
						: ['Staged patch has no researcher field note.'],
				}),
			},
		],
		verifyChecks: [
			{
				id: 'field-notes-deceased-coverage',
				name: 'Deceased Ancestor Note Check',
				run: ({ people }) => {
					const deceasedCount = people.filter((person) => !person.is_living).length;
					return {
						errors: [],
						warnings: deceasedCount === 0 ? ['Archive contains zero deceased people.'] : [],
					};
				},
			},
		],
	};
}
```

### Reserved CLI commands and check IDs

`resolvePluginCommands` throws `CliPluginValidationError` (exit code `EXIT_USAGE`) if a plugin registers a duplicate plugin ID, collides with any built-in or record command (`CORE_CLI_COMMANDS` or `isRecordCommand`), or uses a reserved check ID from `packages/cli/src/plugins.ts`:

- **`RESERVED_AUDIT_CHECK_IDS`:** `chronology`, `privacy`, `citations`, `scans`, `dryRun`, `dry-run`, `hygiene`, `pronunciation`.
- **`RESERVED_VERIFY_CHECK_IDS`:** `citations`, `places`, `ssn`, `compile`, `media`, `livingNames`, `living-names`, `hygiene`, `pronunciation`.

## Planned companion plugin seams (not yet shipped in `v0.62.0`)

The following additive plugin contracts are specified in companion roadmap issues and are **not** yet present in `packages/core`, `packages/server`, or `packages/ui` at `v0.62.0`. Do not code against them until their tracking issues land:

- **Plugin tutorial chapters (Issue #53):** Planned `tutorialChapters` contributions on `KinloomUiPlugin` with namespaced `<pluginId>:<slug>` IDs, step transcripts, and optional video, poster, and VTT caption assets.
- **Role-scoped onboarding steps (Issue #54):** Planned `onboardingSteps` contributions on `KinloomUiPlugin` and a `UserOnboardingStore` port for per-user setup checklists.
- **In-app Admin Documentation bundles (Issue #55):** Planned `docs` bundles on `KinloomServerPlugin` covering `setup`, `configuration`, `permissions`, and `troubleshooting` in the XSS-safe `ArchivalMarkdown` subset.
- **Versioned plugin changelogs (Issue #56):** Planned structured `changelog` entries on plugins surfaced in an in-app Changelogs & What's New view.

## Built-in reference plugins in this repository

Inspect these shipped, off-by-default plugins as working examples of every contract above:

- **Observability & Page Visit Stats:** `packages/server/src/plugins/workersObservability.ts`, `packages/server/src/plugins/pageVisitStats.ts`, `packages/ui/src/plugins/observabilityStatsPlugin.tsx`, `packages/cli/src/plugins/syntheticProbe.ts` ([docs/observability.md](../observability.md)).
- **Open Finance & Donations:** `packages/server/src/plugins/openFinance.ts`, `packages/ui/src/plugins/openFinancePlugin.tsx` ([docs/open-finance.md](../open-finance.md)).
- **Archival Book Publishing:** `packages/server/src/plugins/bookPublishing.ts`, `packages/ui/src/plugins/bookPublishingPlugin.tsx`, `packages/cli/src/plugins/bookPublishing.ts` ([docs/book-publishing.md](../book-publishing.md)).
- **Family Recipes (database-backed):** `packages/server/src/plugins/recipes/`, `packages/ui/src/plugins/recipesPlugin.tsx`.

Continue to [Testing and publishing Kinloom plugins](testing-and-publishing-plugins.md) to verify your plugin against InMemory and Miniflare D1/R2 parity suites and package it for npm.
