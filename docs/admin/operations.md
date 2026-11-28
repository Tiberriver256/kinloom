<!-- kinloom-admin-doc
id: core-operations
title: Operations, Backups, and Upgrades
summary: Syncing local YAML and media, verifying and reconciling bundles, automated nightly backups, disaster recovery restore runbook, and upgrading Kinloom safely.
external_url: https://github.com/Tiberriver256/kinloom/blob/main/docs/admin/operations.md
-->

# Operate, back up, and upgrade a Kinloom archive

Use these procedures for day-to-day archive synchronization, validation, automated backups, full disaster recovery, and lockstep `@kinloom/*` upgrades.

<!-- kinloom-section id=sync-yaml-and-media kind=guide keywords=sync,dry-run,media,r2,verify-live,allow-deletes -->
## Sync local YAML and media to production

`kinloom sync` diffs your local `data/*.yaml` files and media directory against the live Cloudflare D1 and R2 archive. It mints short-lived temporary `read_backup` and `write_batch` tokens in D1 through Wrangler, submits chunked patches to `POST /api/batches`, uploads media to R2, refreshes the compiled bundle, and revokes the temporary tokens automatically in a `finally` block.

1. Preview planned entity changes and media uploads without mutating remote D1 or R2:

```bash
npx kinloom sync --dry-run --sync-missing-media
```

2. Apply the sync, upload missing R2 media files referenced in `data/media.yaml`, and verify live `/api/bundle` and uploaded `/media/*` responses before revoking temporary tokens:

```bash
npx kinloom sync --sync-missing-media --verify-live --summary "Sync archival updates"
```

3. Use targeted flags when syncing large archives or specific media files:

- `--types person,event,source` restricts the sync to selected entity types (in dependency order).
- `--upload-media media/scan-01.jpg media/scan-02.jpg` uploads specific local files to R2 in parallel.
- `--chunk-size 25` sets maximum patches per `POST /api/batches` call (default `25`).
- `--concurrency 6` sets parallel R2 upload workers (default `6`).
- `--site-url https://archive.example.test` overrides the URL derived from `wrangler.jsonc` `routes[0].pattern`.
- `--include-living` includes living person records in diffing and patching.

### Why deletes require explicit opt-in

By default, `kinloom sync` never soft-deletes remote entities that are absent locally. This protects live web-edited records from accidental deletion when your local checkout is behind production.

- Pass `--delete narrative:nar_old` to soft-delete specific remote entities explicitly.
- Pass `--allow-deletes` only after reviewing `--dry-run` output and confirming that remote-only records should be removed.

<!-- kinloom-section id=validation-and-reconciliation kind=guide keywords=verify,audit,reconcile,bundle,hygiene -->
## Validate local YAML and reconcile the live bundle

Run local verification before every sync and run reconciliation periodically against production.

### Full-archive verification (`kinloom verify`)

```bash
npx kinloom verify
```

`kinloom verify` checks all 9 archive invariants:

1. Narrative inline citation integrity (zero dangling source or media IDs).
2. Valid place coordinates (`-90..90`, `-180..180`, finite, no `(0, 0)` placeholders).
3. Zero Social Security Number patterns across `data/*.yaml`.
4. Dual-mode (`private` and `public`) compilation with zero review flags, zero living leaks, and zero duplicate residence spans.
5. Every file in `data/media.yaml` exists under `archive-media/` or `media/` with no duplicate normalized paths.
6. Public living-name scan across redacted narratives, events, media captions, and source citations.
7. Tree hygiene diagnostics (excess parents, chronology anomalies, duplicate vital events, placeholder events).
8. Pronunciation audit (fails on living leaks; warns on coverage gaps).
9. Any registered site CLI plugin `verifyChecks`.

Add `--strict` (or `--strict-hygiene` / `--strict-pronunciation`) to fail with exit code `1` on hygiene or pronunciation warnings.

### Staged research package audit (`kinloom audit`)

Before integrating staged research packages under `research/people/<id>/patch.json`, run:

```bash
npx kinloom audit --all-staged --pending-only --strict
```

`kinloom audit` runs chronology checks, living-person privacy/SSN scans, uncited prose checks, scan file magic-header checks, dry-run integration, pronunciation checks, cross-package overlap checks, and site plugin `auditChecks`.

### Live bundle reconciliation (`kinloom reconcile`)

Prove that the cached R2 `compiled/archive.json` bundle served by `GET /api/bundle` matches a fresh full `compileArchive` build from D1:

```bash
KINLOOM_TOKEN="$KINLOOM_BACKUP_TOKEN" npx kinloom reconcile \
	--site https://archive.example.test \
	--config kinloom.config.yaml
```

Exit code `0` confirms the cached bundle and D1 snapshot match at the current head revision. Exit code `1` prints up to 20 exact field-level diffs so you can investigate or trigger a recompile.

<!-- kinloom-section id=automated-backups kind=guide keywords=backup,export-yaml,github-actions,d1-export,r2,rclone -->
## Configure automated backups

Protect your archive with three layers of backups: deterministic YAML in Git, D1 SQL snapshots, and R2 media copies.

### 1. Nightly YAML snapshots (GitHub Actions)

`kinloom init` scaffolds `.github/workflows/backup.yml` (runs daily at `06:00 UTC`) and `.github/workflows/reconcile.yml` (runs weekly on Sundays at `07:00 UTC`).

1. In `/admin`, mint an agent token with the `read_backup` scope.
2. In your private GitHub repository under **Settings > Secrets and variables > Actions**:
   - Add repository secret `KINLOOM_BACKUP_TOKEN` set to the `klm_...` token.
   - Add repository variable `KINLOOM_SITE_URL` set to `https://archive.example.test`.
3. Trigger **Nightly Archive Backup** manually from the Actions tab once to verify it writes `data/*.yaml` and `data/.last-backup-revision`.

`kinloom export-yaml --state-file data/.last-backup-revision` sends `If-None-Match: "r<rev>"` so unchanged nights return HTTP `304 Not Modified` with zero noisy commits.

### 2. Periodic D1 SQL snapshots

YAML backups capture all archive entities and kinship edges, while D1 SQL exports also capture revision history, Talk comments, member roles, invites, steward review stamps, and plugin tables (such as `plugin_settings` and `plugin_recipes_*`). Export a full SQL snapshot on a regular cadence into encrypted offline storage:

```bash
npx wrangler d1 export alder-archive-db \
	--remote \
	--output "alder-archive-$(date -u +%Y%m%d).sql"
```

### 3. R2 media bucket backups

Keep an independent copy of `MEDIA_BUCKET` (excluding the rebuildable `compiled/archive.json` cache) using Cloudflare R2 cross-bucket replication or an S3-compatible sync tool such as `rclone`:

```bash
rclone sync r2:alder-archive-media/media ./backups/alder-archive-media/media
rclone sync r2:alder-archive-media/sources ./backups/alder-archive-media/sources
```

<!-- kinloom-section id=disaster-recovery kind=guide keywords=restore,recovery,disaster,seed,d1,r2,probe -->
## Execute disaster recovery and restore

Follow this tested runbook to rebuild an archive from scratch into a fresh D1 database and R2 bucket.

1. **Provision fresh Cloudflare resources:**

```bash
npx wrangler d1 create alder-archive-db-restored
npx wrangler r2 bucket create alder-archive-media-restored
```

Update `database_name`, `database_id`, and `bucket_name` in `wrangler.jsonc`.

2. **Re-apply Worker secrets:**

```bash
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
printf '%s' 'steward@archive.example.test' | npx wrangler secret put BOOTSTRAP_ADMIN_EMAIL
```

Also re-apply `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`, or custom email API secrets if your archive uses them.

3. **Apply schema migrations:**

```bash
npx kinloom migrate --remote
```

If you use database-backed plugins, include `--plugin-migrations ./migrations/plugins`.

4. **Restore database records (choose one path):**
   - **Full-fidelity restore from a D1 SQL export** (preserves revision history, Talk comments, users, steward reviews, and plugin tables):

```bash
npx wrangler d1 execute alder-archive-db-restored \
	--remote \
	--file=./alder-archive-20261127.sql
```

   - **Clean entity restore from Git YAML backups** (rebuilds entities and kinship from `data/*.yaml`): deploy the Worker first (`npm run build && npx wrangler deploy`), sign in as `BOOTSTRAP_ADMIN_EMAIL`, mint a `write_batch` token, and run:

```bash
npx kinloom seed \
	--data ./data \
	--config kinloom.config.yaml \
	--site https://archive.example.test \
	--token "$KINLOOM_TOKEN"
```

5. **Restore R2 media objects:**

If restoring from local `archive-media/` or `media/`, run:

```bash
npx kinloom sync --sync-missing-media --verify-live
```

If restoring from an R2 backup mirror, copy `media/` and `sources/` back into `alder-archive-media-restored` with `rclone sync`.

6. **Deploy and verify end-to-end health:**

```bash
npm run build
npx wrangler deploy
KINLOOM_TOKEN="$KINLOOM_BACKUP_TOKEN" npx kinloom reconcile \
	--site https://archive.example.test \
	--config kinloom.config.yaml
```

If you enabled the `kinloom probe` observability CLI plugin (see [Cloudflare Workers observability](../observability.md)), run `kinloom probe --url https://archive.example.test` and inspect `/admin` **Core Application Settings & Diagnostics** to verify `repository`, `bundle_cache`, and `media_store` all report `pass`.

<!-- kinloom-section id=upgrade-kinloom kind=guide keywords=upgrade,changelog,versions,migrate,deploy,diagnostics -->
## Upgrade `@kinloom/*` packages safely

All `@kinloom/*` workspace packages release in lockstep. Follow this sequence for every upgrade:

1. **Review release notes first:** Open `/admin` and inspect **Changelogs & What's New** (`GET /api/admin/changelogs`), or check GitHub releases, for any `breaking` or `security` entries affecting your enabled plugins.
2. **Bump all `@kinloom/*` packages together:** Update `@kinloom/core`, `@kinloom/server`, `@kinloom/worker`, `@kinloom/ui`, `@kinloom/tokens`, and `@kinloom/cli` to the exact same target version in `package.json`, then run `npm install`.
3. **Preview D1 migrations before deploying:**

```bash
npx kinloom migrate --remote --dry-run
```

4. **Apply pending D1 migrations:**

```bash
npx kinloom migrate --remote
```

Include `--plugin-migrations` if your archive manages plugin SQL migrations.

5. **Rebuild and deploy:**

```bash
npm run build
npx wrangler deploy
```

6. **Verify live diagnostics:** Open `/admin` and confirm under **Core Application Settings & Diagnostics** that `core_version`, `server_version`, `worker_version`, and UI version match your target release, `schema_migration_level` shows the latest migration, all health checks report `pass`, and `recent_errors` shows zero new failures. Run `npx kinloom reconcile` to confirm bundle parity.
