# Testing and publishing Kinloom plugins

**Diataxis mode:** How-to and reference.

Every Kinloom plugin should pass behavioral tests against both fast in-memory ports and real SQLite/D1 semantics before publication. This guide covers server, worker, UI, and CLI testing, npm package structure, Vite dependency deduplication, release versioning, and the pre-publish privacy checklist.

## 1. Test server plugins against InMemory and Miniflare D1/R2

### Fast in-memory server harness

Use `createInMemoryServerPorts` and `createKinloomServer` from `@kinloom/server` to exercise real HTTP routing, cookie signing, RBAC, CSRF origin validation, and declarative plugin settings without network sockets.

```ts kinloom-check
import { parseKinloomConfigYaml } from '@kinloom/core';
import {
	createInMemoryServerPorts,
	createKinloomServer,
	type KinloomServerPlugin,
} from '@kinloom/server';

const SAMPLE_CONFIG_YAML = `
schemaVersion: 1
site:
  title: Alder Family Archive
  familyName: Alder Family
  gedcomSourceName: ALDER_ARCHIVE
defaultBranchId: alder
branches:
  - id: alder
    label: Alder Line
    rootPersonId: p_alder_01
`;

export async function verifyPluginAccessControl(plugin: KinloomServerPlugin): Promise<void> {
	const siteConfig = parseKinloomConfigYaml(SAMPLE_CONFIG_YAML);
	const ports = createInMemoryServerPorts(siteConfig);
	ports.plugins = [plugin];

	const privateServer = createKinloomServer({
		siteConfig,
		ports,
		mode: 'private',
		sessionSecret: 'synthetic-test-session-secret-32-chars',
		bootstrapAdminEmail: 'steward@archive.example.test',
	});

	// 1. Anonymous caller on a private archive receives 401 for archive_read routes.
	const anonRes = await privateServer.fetch(
		new Request('https://archive.example.test/api/plugins/field-notes', { method: 'GET' })
	);
	if (anonRes.status !== 401) {
		throw new Error(`Expected 401 for anonymous private read, got ${anonRes.status}`);
	}

	// 2. Cross-origin state-changing requests fail CSRF origin validation.
	const csrfRes = await privateServer.fetch(
		new Request('https://archive.example.test/api/plugins/field-notes', {
			method: 'POST',
			headers: {
				origin: 'https://untrusted.example.org',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ person_id: 'p_alder_01', summary: 'Note' }),
		})
	);
	if (csrfRes.status !== 403) {
		throw new Error(`Expected 403 CSRF_ORIGIN_MISMATCH, got ${csrfRes.status}`);
	}
}
```

### Mandatory server plugin test matrix

Cover these five behavioral categories in every server plugin suite:

1. **RBAC and visibility modes.** Test `401 UNAUTHORIZED` for anonymous callers, `403 FORBIDDEN` or `403 ADMIN_REQUIRED` for insufficient roles, and both `mode: 'private'` and `mode: 'public'` behavior for `'archive_read'` routes.
2. **CSRF protection.** Send `POST`, `PUT`, `PATCH`, and `DELETE` requests with missing or mismatched `Origin` headers using cookie auth and assert `403 CSRF_ORIGIN_MISMATCH`.
3. **Secret non-echo (`settingsSchema`).** Save a secret via `PUT /api/admin/plugin-settings/:pluginId` with `{ secrets: { my_key: { action: 'set', value: 'secret-value' } } }`. Assert that `GET /api/admin/plugin-settings`, `PUT` responses, and `/api/admin/system` return `{ configured: true, updated_at: '...' }` and never contain `'secret-value'`. Also verify partial `values` updates keep existing secrets intact and preserve `preserveKeys`.
4. **SQL namespace isolation.** Verify that `validatePluginMigrations` throws `RangeError` for core table references (`users`, `entities`, `plugin_settings`, `plugin_migrations`) or unprefixed table names, and that runtime calls through `PluginDatabasePort` throw `KinloomHttpError(500, 'PLUGIN_SQL_SCOPE_VIOLATION', ...)` when touching any table outside `plugin_<namespace>_*`.
5. **Backend parity with Miniflare D1 and R2.** If your plugin implements a storage adapter or SQL repository, write a shared contract suite (following `runBackendAdapterContractTests` in `packages/server/src/testing/adapterContractSuite.ts` and `runRecipesRepositoryContractSuite` in `packages/server/src/plugins/recipes/recipesRepositoryContractSuite.ts`) and run it against both an in-memory repository and a real Miniflare D1 database via `D1PluginDatabaseFactory` and `runD1PluginMigrations`. Include `EXPLAIN QUERY PLAN` assertions on hot queries to catch accidental full-table scans.

## 2. Test UI and CLI plugins

### UI behavioral and registration tests

- **Fail-fast startup validation.** Call `validateAndCompileUiPlugins` directly in unit tests to assert `RangeError` on empty/duplicate IDs, reserved route collisions (`RESERVED_UI_ROUTE_PATHS`), duplicate dynamic routes, and duplicate `entityEditForms` or `entityCreateForms` registrations.
- **Full shell integration.** Render `<KinloomApp dataSource={dataSource} initialEntries={['/field-notes']} plugins={[createFieldNotesUiPlugin()]} />` with Vitest and Testing Library. Inject a mock `PluginApiClient` or `fetchImpl` so tests run hermetically without hitting the network.
- **Settings bus sync.** Assert that saving settings in `PluginSettingsSection` notifies subscribed plugin components via `subscribePluginSettings` and updates rendered UI state.
- **Living-person redaction.** Confirm that `personRelated` slots and ancestor pickers (`searchDeceasedPeople`, `getDeceasedPersonById`) never expose records with `is_living: true`.

### CLI plugin tests

- **Validation and collision guards.** Pass your `KinloomCliPlugin` to `resolvePluginCommands([plugin])` (`@kinloom/cli`) and assert that command names, `auditChecks`, and `verifyChecks` never collide with built-in commands or `RESERVED_AUDIT_CHECK_IDS` / `RESERVED_VERIFY_CHECK_IDS`.
- **Check execution.** Call `runRegisteredCheck(plugin.id, check, syntheticContext)` with synthetic YAML records and verify `ok`, `strictOk`, `errors`, and `warnings` against literal expected values.
- **Auto-discovery.** Verify that `discoverSiteCliPlugins(tempDir)` loads your plugin cleanly from `extensions/<name>/cli.mjs` and from `kinloom.config.yaml` `plugins: []`.

### Coverage, Playwright E2E, and visual review

- **90% V8 coverage convention.** Match Kinloom's coverage bar (`>= 90%` lines, statements, functions, and branches under `@vitest/coverage-v8`). Run `npm run test:coverage` in the monorepo.
- **Playwright cross-theme and viewport checks.** Verify custom routes and slots at mobile (`390x844`) and desktop (`1440x900`) viewports in both `light` and `dark` color schemes (`data-theme='dark'` and `prefers-color-scheme: dark`).
- **Automated screenshot review.** Capture full-page and slot screenshots across viewports and themes with `kinloom screenshots`:

```bash
kinloom screenshots \
  --url http://127.0.0.1:4173 \
  --out-dir ./plugin-ui-review \
  --plugin-routes /field-notes \
  --themes light,dark
```

See [docs/ui-screenshots.md](../ui-screenshots.md) for all capture flags and authentication options.

## 3. Package and publish third-party npm plugins

Publish third-party plugins as pure ESM packages with explicit subpath exports so server runtimes never pull in React and browser bundles never pull in Node-only CLI code.

### Recommended `package.json` template

```json
{
  "name": "kinloom-plugin-field-notes",
  "version": "1.0.0",
  "type": "module",
  "license": "MIT",
  "sideEffects": ["**/*.css"],
  "files": ["dist", "migrations"],
  "exports": {
    "./server": {
      "types": "./dist/server/index.d.ts",
      "import": "./dist/server/index.js"
    },
    "./ui": {
      "types": "./dist/ui/index.d.ts",
      "import": "./dist/ui/index.js"
    },
    "./cli": {
      "types": "./dist/cli/index.d.ts",
      "import": "./dist/cli/index.js"
    }
  },
  "peerDependencies": {
    "@kinloom/cli": "^0.62.0",
    "@kinloom/core": "^0.62.0",
    "@kinloom/server": "^0.62.0",
    "@kinloom/tokens": "^0.62.0",
    "@kinloom/ui": "^0.62.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0"
  },
  "peerDependenciesMeta": {
    "@kinloom/cli": { "optional": true },
    "@kinloom/server": { "optional": true },
    "@kinloom/tokens": { "optional": true },
    "@kinloom/ui": { "optional": true },
    "react": { "optional": true },
    "react-dom": { "optional": true },
    "react-router-dom": { "optional": true }
  }
}
```

### Vite `resolve.dedupe` rule

Never bundle `react`, `react-dom`, `react-router-dom`, or `@kinloom/core` inside your plugin build output. Duplicate React or Router instances break `KinloomPluginContext` and hooks at runtime. In host Vite applications (matching `examples/demo/vite.config.ts`), configure deduplication explicitly:

```ts
export default {
	resolve: {
		dedupe: ['react', 'react-dom', 'react-router-dom'],
	},
};
```

### Semantic versioning and Kinloom's release workflow

Core `@kinloom/*` packages release in lockstep using Conventional Commits via `scripts/release-version.mjs`:

- `BREAKING CHANGE` or `type!:` bumps the major version.
- `feat:` bumps the minor version.
- `fix:`, `perf:`, and `revert:` bump the patch version.
- `docs:`, `chore:`, `test:`, `ci:`, and `refactor:` do not trigger a release.

When maintaining an in-repo plugin or bumping Kinloom itself, `scripts/release-version.mjs` synchronizes package versions, internal workspace dependency ranges, and runtime version constants (`KINLOOM_CORE_VERSION`, `KINLOOM_SERVER_VERSION`, `KINLOOM_WORKER_VERSION`, `KINLOOM_UI_VERSION`, and CLI `User-Agent`). For external plugins, pin `peerDependencies` to compatible `@kinloom/*` minor ranges and test against new Kinloom releases in CI.

## 4. Pre-publish security and privacy checklist

Run every check below before publishing a plugin package or opening a pull request:

- [ ] **Default-off behavior:** Calling the archive with your plugin disabled registers zero routes, renders zero UI panels, and executes zero SQL statements.
- [ ] **Living-person privacy fence:** Public and viewer endpoints never return living-person portraits, exact birth dates, street addresses, or enrolled member email addresses. Reject writes that attach public artifacts or portraits to living people (`getLivingPersonIds()`).
- [ ] **Write-only secrets:** Credentials live in `settingsSchema` secret fields or Wrangler secrets, never in source code, `kinloom.config.yaml`, `GET` responses, or error logs.
- [ ] **XSS and CSP safety:** Render untrusted prose through `ArchivalMarkdown` or plain React text nodes. Never use `dangerouslySetInnerHTML`, and declare explicit `documentContributions.csp` additions only for verified `https://` origins.
- [ ] **Privacy disclosure:** If your plugin stores visitor telemetry or sends browser requests to an external origin, register a `ServerPrivacyDisclosure` under `documentContributions.privacyDisclosures` so `/privacy` stays accurate.
- [ ] **SQL isolation:** All plugin tables start with `plugin_<namespace>_` and all indexes start with `idx_plugin_<namespace>_`. Zero references to core tables or `sqlite_*`.
- [ ] **Contrast and accessibility:** All custom components use `@kinloom/tokens` CSS variables, maintain `>= 44px` mobile tap targets, provide `:focus-visible` outlines, and remain legible in both light and dark themes.
- [ ] **Leak and doc gates:** Fixtures use synthetic names and domains (`archive.example.test`, `steward@archive.example.test`) or verified public-domain records. `npm run check:leaks` and `npm run check:docs` pass with zero findings.
