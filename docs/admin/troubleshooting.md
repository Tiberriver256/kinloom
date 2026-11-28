<!-- kinloom-admin-doc
id: core-troubleshooting
title: Troubleshooting and Diagnostics
summary: Using /admin System Diagnostics, fixing D1 migration drift, R2 bundle cache issues, OAuth/email/CSRF/conflict/privacy errors, and filing redacted bug reports.
external_url: https://github.com/Tiberriver256/kinloom/blob/main/docs/admin/troubleshooting.md
-->

# Troubleshoot a Kinloom archive

Use this guide to diagnose runtime problems with `/admin` System Diagnostics, resolve common HTTP and CLI errors, and file safe, redacted bug reports.

<!-- kinloom-section id=system-diagnostics kind=troubleshooting keywords=diagnostics,admin,health-checks,recent-errors,versions -->
## Read `/admin` System Diagnostics

Sign in as an administrator and open `/admin`. The **Core Application Settings & Diagnostics** panel calls `GET /api/admin/system` and shows a redacted snapshot of the live deployment:

- **Versions:** `core_version`, `server_version`, `worker_version`, `ui_version`, optional `build_commit_sha` and `build_timestamp`, and `schema_migration_level` (detected from `d1_migrations` or live D1 tables).
- **Runtime adapters:** Active `repository`, `bundle_cache`, `media_store`, `email_sender`, `auth_provider_id`, `pronunciation_generator`, and `pronunciation_lexicon_store`.
- **Configuration flags:** Active `mode` (`private` or `public`), enabled auth methods, observability flags, wiki limits (`max_upload_bytes`), and privacy settings (`living_cutoff_years`).
- **Archive status and health checks:** Current `head_revision_id`, `bundle_cache_status` (`hit`, `miss`, or `error`), deceased and living counts (counts only, never names), and live latency probes for `repository`, `bundle_cache`, and `media_store`.
- **Installed plugins:** Merged list of server and UI plugins with version, runtime status (`active`, `disabled`, or `degraded`), route counts, and hooks.
- **Recent errors:** In-isolate ring buffer of recent HTTP errors recording only timestamp, normalized route template, HTTP status, and canonical uppercase error code (never stack traces, tokens, or emails).

Use the **Refresh** button after applying a migration or deploying a fix to confirm all health checks return `pass`.

<!-- kinloom-section id=common-failure-modes kind=troubleshooting keywords=errors,migrations,r2,oauth,email,csrf,conflict,living-media -->
## Fix common failure modes

### D1 migration drift or missing table errors

**Symptom:** API routes fail with HTTP `500 INTERNAL_ERROR` after an upgrade, plugin settings return database errors, or `/admin` Diagnostics shows an older `schema_migration_level` than your installed `@kinloom/worker` version.

**Fix:**

1. Inspect pending core and plugin migrations:

```bash
npx kinloom migrate --remote --dry-run
```

2. Apply pending migrations idempotently:

```bash
npx kinloom migrate --remote
```

If a database-backed plugin (such as Family Recipes) reports missing `plugin_<namespace>_*` tables, include `--plugin-migrations ./migrations/plugins`. Refresh `/admin` Diagnostics and verify `schema_migration_level` updated.

### Stale or missing R2 compiled bundle

**Symptom:** Recent edits do not appear on page reload, `bundle_cache_status` reports `miss` or `error`, or `kinloom reconcile` exits with code `1` reporting drift between cached `GET /api/bundle` and D1.

**Fix:**

1. Confirm whether drift exists:

```bash
KINLOOM_TOKEN="$KINLOOM_BACKUP_TOKEN" npx kinloom reconcile \
	--site https://archive.example.test \
	--config kinloom.config.yaml
```

2. Trigger a fresh full compilation from D1 by deleting the cached object (`compiled/archive.json`) in your R2 bucket and requesting `GET /api/bundle` (or running `npx kinloom sync --verify-live`):

```bash
npx wrangler r2 object delete alder-archive-media/compiled/archive.json --remote
```

3. Re-run `npx kinloom reconcile` and confirm `Reconcile OK`.

### Google OAuth redirect mismatch or `400 INVALID_OAUTH_STATE`

**Symptom:** Google displays `redirect_uri_mismatch`, or `/api/auth/google/callback` fails with HTTP `400 INVALID_OAUTH_STATE` (`invalid_state`) or `503 AUTH_PROVIDER_UNCONFIGURED`.

**Fix:**

- For `503 AUTH_PROVIDER_UNCONFIGURED`, confirm both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set via `npx wrangler secret put` and redeploy.
- For `redirect_uri_mismatch`, confirm Google Cloud Console lists the exact callback URL `https://archive.example.test/api/auth/google/callback` (matching protocol, hostname, and no trailing slash).
- For `400 INVALID_OAUTH_STATE`, check three causes:
  1. The user started sign-in on one hostname (for example `*.workers.dev`) and returned on a different custom domain, so the `__Host-kinloom_oauth` cookie was not sent.
  2. More than 10 minutes elapsed between starting sign-in and completing the callback (OAuth cookie TTL expired). Retry sign-in from the archive homepage.
  3. `SESSION_SECRET` was rotated while the login flow was in flight.

### Magic-link `503 EMAIL_SENDER_UNCONFIGURED` or `502 EMAIL_RECIPIENT_NOT_ALLOWED`

**Symptom:** Requesting a magic link returns HTTP `503 EMAIL_SENDER_UNCONFIGURED`, HTTP `502 EMAIL_RECIPIENT_NOT_ALLOWED`, or HTTP `502 EMAIL_DELIVERY_FAILED`.

**Fix:**

- **`503 EMAIL_SENDER_UNCONFIGURED`:** Add the `send_email` binding named `SEND_EMAIL` to `wrangler.jsonc` or pass a custom `emailSender` into `createCloudflareWorker`. See [Configuration reference](./configuration.md).
- **`502 EMAIL_RECIPIENT_NOT_ALLOWED`:** Cloudflare Email Service returned `E_RECIPIENT_PLAN_RESTRICTED`, `E_RECIPIENT_NOT_ALLOWED`, or `E_RECIPIENT_SUPPRESSED`. On the Cloudflare Workers Free plan, only verified destination addresses can receive mail. Upgrade to a Workers Paid plan or wire a custom HTTP `EmailSender` adapter (such as Resend).
- **`502 EMAIL_DELIVERY_FAILED`:** Verify `EMAIL_FROM` belongs to a verified sending domain and check Cloudflare Workers Logs for the redacted delivery error code.
- **`429 RATE_LIMITED`:** Wait for the 1-hour window (10 magic-link requests per email per hour) to clear.
- **`400 TOKEN_INVALID_OR_EXPIRED`:** Magic links expire after 15 minutes and work only once. Request a new link and open it directly in your browser (some corporate email link scanners pre-fetch one-time URLs).

### `403 CSRF_ORIGIN_MISMATCH`

**Symptom:** Authenticated `POST`, `PUT`, `PATCH`, or `DELETE` requests fail with HTTP `403 CSRF_ORIGIN_MISMATCH`.

**Fix:**

- Confirm users browse the archive over the exact canonical HTTPS custom domain configured in Cloudflare, and confirm no reverse proxy rewrites the `Host` header or strips the browser `Origin` header.
- For CLI scripts, backups, and CI pipelines, authenticate with `Authorization: Bearer klm_...` instead of browser session cookies. Bearer-authenticated API requests do not depend on browser `Origin` headers.

### `409 OPTIMISTIC_CONFLICT` (CLI exit code `3`)

**Symptom:** Saving an entity in the web UI returns HTTP `409 OPTIMISTIC_CONFLICT`, or `kinloom submit-batch` / `kinloom sync` exits with code `3`.

**Fix:**

- Another editor or batch modified the same entity after you loaded `expected_parent_revision_id`.
- In the web UI, review the field-level diff in the conflict dialog, choose which values to keep, and save again against the current revision.
- From the CLI, re-run `npx kinloom export-yaml` or `npx kinloom sync --dry-run` so your local diff is computed against the latest remote head revision before resubmitting.

### `422 LIVING_MEDIA_FORBIDDEN`

**Symptom:** Uploading a scan or portrait through `/api/media/upload` or `kinloom upload-media` fails with HTTP `422 LIVING_MEDIA_FORBIDDEN` and lists `blocked_person_ids`.

**Fix:**

- Kinloom forbids linking media files to any effective-living person (directly via `person_id` / `person_ids` or indirectly via participants of `event_id`).
- If the subject is actually deceased, update that person's record with a verified `death_edtf` date and `is_living: false` first, then retry the upload.
- If the subject is living, do not upload portraits or linked scans for that person.

<!-- kinloom-section id=safe-bug-reports kind=troubleshooting keywords=bug-report,github,redacted,security,disclosure -->
## File a redacted bug report safely

Use the built-in redaction helpers in `/admin` whenever you report a bug on GitHub:

1. Open `/admin` and scroll to **Core Application Settings & Diagnostics**.
2. Click **Copy Diagnostics for GitHub Issue** to copy the redacted Markdown report, or click **Open GitHub Bug Report** to pre-fill a new GitHub issue directly.
3. Add clear reproduction steps using synthetic names and dates (such as the public-domain Lincoln and Todd demo in `examples/demo/`).

Before submitting any public GitHub issue, verify that your report contains:

- Zero real living-person names, birth dates, addresses, or private family emails.
- Zero `SESSION_SECRET`, `GOOGLE_CLIENT_SECRET`, `GEMINI_API_KEY`, or `klm_*` agent bearer tokens.
- Zero browser `Cookie` headers (`__Host-kinloom_session` or `__Host-kinloom_oauth`).

If the bug exposes living-person data, bypasses authentication or CSRF checks, or weakens CSP or media sandboxing, **do not** open a public issue. Follow the private GitHub Security Advisory process in [SECURITY.md](../../SECURITY.md).
