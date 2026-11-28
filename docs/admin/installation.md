<!-- kinloom-admin-doc
id: core-setup
title: Installation and Deployment
summary: Prerequisites, scaffolding with kinloom init, Cloudflare Workers/D1/R2 setup, migrations, secrets, seeding, and local development.
external_url: https://github.com/Tiberriver256/kinloom/blob/main/docs/admin/installation.md
-->

# Install and deploy a Kinloom archive

This guide walks you through scaffolding a self-hosted Kinloom family archive, provisioning Cloudflare Workers, D1, and R2, applying database migrations, seeding initial records, and running the archive locally.

For reference tables of every configuration key, Worker binding, and secret, see [Configuration reference](./configuration.md).

<!-- kinloom-section id=prerequisites kind=setup keywords=node,npm,wrangler,cloudflare,tesseract,poppler -->
## Check prerequisites

Install these tools before you scaffold your archive:

- **Node.js 24 or later** and **npm** on your local machine. Verify with `node -v`.
- **A Cloudflare account** with Workers, D1, and R2 enabled.
- **Wrangler CLI** authenticated against your Cloudflare account. Run `npx wrangler login` and confirm your active account with `npx wrangler whoami`.
- **Git** to track your private archive repository and YAML backups.
- **Optional OCR and media utilities** if you plan to run local document OCR or audio workflows: `tesseract-ocr`, `poppler-utils` (`pdftoppm` and `pdfinfo`), and `ffmpeg`.

Keep your private family archive in a **private Git repository** separate from the public `kinloom` monorepo. Never commit family YAML files, GEDCOM exports, or personal scans to a public repository.

<!-- kinloom-section id=scaffold-archive kind=setup keywords=init,scaffold,wrangler,config,workflows -->
## Scaffold a new archive repository

Create a new archive directory with `kinloom init`. Pass `--family` for the primary family surname or lineage name and `--title` for the archive display title. You can also pass `--accent` with a 6-digit hex color (default `#7A4612`).

```bash
npx @kinloom/cli init my-family-archive \
	--family "Alder" \
	--title "Alder Family Archive" \
	--accent "#7A4612"
cd my-family-archive
```

The command creates a thin archive repository with these files:

- `kinloom.config.yaml` stores site metadata, theme accent colors, branches, lineage sections, map defaults, and privacy rules.
- `wrangler.jsonc` configures the Cloudflare Worker entrypoint (`src/worker.ts`), static SPA `ASSETS` binding (`run_worker_first: true`), `DB` (D1) binding, `MEDIA_BUCKET` (R2) binding, and `ARCHIVE_MODE: "private"`.
- `data/*.yaml` creates empty starter YAML collections (`people.yaml`, `events.yaml`, `places.yaml`, `sources.yaml`, `kinship.yaml`, `media.yaml`, and `narratives.yaml`).
- `public/` generates starter all-device brandkit assets (favicons, app icons, manifest, and Open Graph card) via `kinloom brandkit`.
- `.github/workflows/backup.yml` and `.github/workflows/reconcile.yml` configure nightly YAML snapshots and weekly bundle reconciliation in GitHub Actions.
- `extensions/README.md` documents where to add optional archive-specific UI, server, or CLI plugins.
- `biome.json` and `.gitignore` configure formatting and prevent `.env`, `.wrangler/`, `dist/`, and `raw-gedcom/` from being committed.

Install the Kinloom runtime packages and development dependencies in your repository (`@kinloom/core`, `@kinloom/server`, `@kinloom/worker`, `@kinloom/ui`, `@kinloom/tokens`, `@kinloom/cli`, `wrangler`, `vite`, and `react`). Keep every `@kinloom/*` package pinned to the same version.

<!-- kinloom-section id=cloudflare-provisioning kind=setup keywords=d1,r2,workers,wrangler,bindings -->
## Provision Cloudflare D1 and R2

Create the D1 SQLite database and R2 media bucket for your archive, then wire their identifiers into `wrangler.jsonc`.

1. Create the D1 database:

```bash
npx wrangler d1 create alder-archive-db
```

2. Copy the returned `database_id` into the `d1_databases` array in `wrangler.jsonc`. Keep the `binding` set to `"DB"` and `migrations_dir` set to `"node_modules/@kinloom/worker/migrations"`:

```jsonc
{
	"d1_databases": [
		{
			"binding": "DB",
			"database_name": "alder-archive-db",
			"database_id": "REPLACE_WITH_D1_DATABASE_ID",
			"migrations_dir": "node_modules/@kinloom/worker/migrations"
		}
	]
}
```

3. Create the R2 bucket for uploaded scans, portraits, audio clips, and the compiled `compiled/archive.json` bundle cache:

```bash
npx wrangler r2 bucket create alder-archive-media
```

4. Confirm that `wrangler.jsonc` binds the bucket as `"MEDIA_BUCKET"`:

```jsonc
{
	"r2_buckets": [
		{
			"binding": "MEDIA_BUCKET",
			"bucket_name": "alder-archive-media"
		}
	]
}
```

5. Create your Worker entrypoint (`src/worker.ts`) using `createCloudflareWorker`:

```ts
import { createCloudflareWorker } from '@kinloom/worker';
import { siteConfig } from './siteConfig.js';

export default createCloudflareWorker({
	siteConfig,
});
```

<!-- kinloom-section id=apply-migrations kind=setup keywords=migrate,d1,sql,plugin-migrations,dry-run -->
## Apply D1 database migrations

Use `kinloom migrate` to inspect your D1 schema and apply only pending SQL migrations idempotently. The command checks `sqlite_master`, `PRAGMA table_info`, and `plugin_migrations`, so re-running it never fails on tables or columns that already exist.

1. Preview pending migrations against your remote D1 database without writing changes:

```bash
npx kinloom migrate --remote --dry-run
```

2. Apply all pending core migrations (`0001_initial.sql` through `0007_steward_reviews.sql`):

```bash
npx kinloom migrate --remote
```

Core migrations create these tables:

- `0001_initial.sql` creates `entities`, `kinship_edges`, `revisions`, `users`, `invites`, `magic_links`, `agent_tokens`, `talk_comments`, and 9 secondary indexes.
- `0002_pronunciations.sql` and `0003_pronunciation_provenance.sql` create and extend `pronunciation_lexicon`.
- `0004_plugin_settings.sql` creates `plugin_settings` and isolated write-only `plugin_setting_secrets`.
- `0005_page_visit_stats.sql` creates `page_visit_daily` and `observability_cache_daily`.
- `0006_plugin_migrations.sql` creates the `plugin_migrations` ledger table for database-backed plugins.
- `0007_steward_reviews.sql` creates `steward_reviews` for revision and batch sign-off stamps.

3. If you enable database-backed plugins (such as Family Recipes), place their namespaced SQL files under `migrations/plugins/<namespace>/<NNNN>_<name>.sql` or pass `--plugin-migrations <dir>`:

```bash
npx kinloom migrate --remote --plugin-migrations ./migrations/plugins
```

For local Wrangler development, pass `--local` instead of `--remote`:

```bash
npx kinloom migrate --local
```

<!-- kinloom-section id=secrets-and-seed kind=setup keywords=secrets,session_secret,bootstrap_admin_email,seed,slice-gedcom -->
## Configure secrets, deploy, and seed data

Set the required Worker secrets before your first deploy. Never put secrets in `wrangler.jsonc` or `kinloom.config.yaml`.

1. Generate a 32-byte random `SESSION_SECRET` (at least 16 characters is enforced at startup) and store it in Cloudflare Workers:

```bash
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
```

2. Set `BOOTSTRAP_ADMIN_EMAIL` to the archive owner email address. When this email signs in via Google OAuth or magic link, Kinloom enrolls it automatically with the `admin` role:

```bash
printf '%s' 'steward@archive.example.test' | npx wrangler secret put BOOTSTRAP_ADMIN_EMAIL
```

3. Configure at least one sign-in method (Google OAuth, Cloudflare Email Service `SEND_EMAIL`, or a custom `EmailSender`) as described in [Configuration reference](./configuration.md).

4. Build the SPA into `dist/` and deploy the Worker:

```bash
npm run build
npx wrangler deploy
```

5. Sign in to your deployed archive as the bootstrap admin, open `/admin`, and mint an agent token with the `write_batch` scope. Export it in your shell as `KINLOOM_TOKEN`:

```bash
export KINLOOM_TOKEN="klm_replace_with_minted_write_batch_token"
```

6. If you are importing an existing GEDCOM export, slice it into deterministic `data/*.yaml` files first (store raw `.ged` files inside `raw-gedcom/`, which `.gitignore` excludes):

```bash
npx kinloom slice-gedcom \
	--input ./raw-gedcom/family.ged \
	--out ./data \
	--root "@I1@" \
	--branch alder
```

7. Validate and seed your YAML files into the live archive. Preview locally with `--dry-run`, then submit the idempotent seed batch:

```bash
npx kinloom seed \
	--data ./data \
	--config kinloom.config.yaml \
	--site https://archive.example.test \
	--dry-run

npx kinloom seed \
	--data ./data \
	--config kinloom.config.yaml \
	--site https://archive.example.test \
	--token "$KINLOOM_TOKEN"
```

After seeding, run `npx kinloom sync --sync-missing-media --verify-live` if you have local scans under `archive-media/` or `media/` to upload into R2.

<!-- kinloom-section id=custom-domain-and-local-dev kind=setup keywords=domain,routes,vite,dedupe,wrangler-dev -->
## Attach a custom domain and run locally

### Custom domain in `wrangler.jsonc`

Add a Cloudflare Workers Custom Domain route in `wrangler.jsonc` so your archive serves on your own HTTPS origin and so `kinloom sync` can auto-detect the live URL:

```jsonc
{
	"routes": [
		{
			"pattern": "archive.example.test",
			"custom_domain": true
		}
	]
}
```

Redeploy with `npx wrangler deploy` after adding the route. If you use Google OAuth, register `https://archive.example.test/api/auth/google/callback` as an Authorized Redirect URI.

### Vite single-React deduplication

In `vite.config.ts`, configure `resolve.dedupe` so `@kinloom/ui` and your site bundle share one React and React Router instance:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
	plugins: [react()],
	resolve: {
		dedupe: ['react', 'react-dom', 'react-router-dom'],
	},
});
```

### Local development workflow

Run the full Worker, local D1, and local R2 stack on your machine without touching production data:

1. Create a git-ignored `.dev.vars` file in your archive root for local secrets:

```dotenv
SESSION_SECRET=local-dev-secret-at-least-32-characters-long
BOOTSTRAP_ADMIN_EMAIL=steward@archive.example.test
ARCHIVE_MODE=private
```

2. Apply migrations to the local Wrangler D1 database:

```bash
npx kinloom migrate --local
```

3. Build the SPA and start Wrangler locally:

```bash
npm run build
npx wrangler dev
```

On plain `http://localhost`, Kinloom automatically uses the `kinloom_session` and `kinloom_oauth` cookies instead of `__Host-` prefixed HTTPS cookies so local sign-in flows work without TLS termination.
