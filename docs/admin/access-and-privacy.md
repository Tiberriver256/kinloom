<!-- kinloom-admin-doc
id: core-access-privacy
title: Access Control and Privacy
summary: Roles and principals matrix, inviting family members, enrolling editors, living-person privacy fence operations, and security hardening.
external_url: https://github.com/Tiberriver256/kinloom/blob/main/docs/admin/access-and-privacy.md
-->

# Manage access control and living-person privacy

Kinloom separates public historical family archives from living-person records and authenticated operator actions. This guide explains who can do what, how to manage family invites and editor accounts, how the living-person privacy fence behaves in private and public modes, and how to harden your deployment.

<!-- kinloom-section id=roles-and-principals kind=permissions keywords=roles,rbac,anonymous,invite_viewer,editor,admin,agent,tokens -->
## Roles and principals

Every HTTP request resolves to one `CallerPrincipal` (`packages/server/src/http/authMiddleware.ts`).

| Principal / Role | Auth mechanism | Read archive (`/api/bundle`, `/media/*`, `/sources/*`) | Edit entities, upload media, post Talk, revert revisions, steward reviews | Batch writes (`POST /api/batches`) | Raw exports (`/api/export/yaml`, `/api/export/snapshot`) | Admin routes (`/api/admin/*`) |
| --- | --- | --- | --- | --- | --- | --- |
| `anonymous` | None | Only when `ARCHIVE_MODE=public` | No (`401`) | No (`401`) | No (`401`) | No (`401`) |
| `invite_viewer` | Signed cookie from active `/api/auth/invite/<token>` link | Yes (re-checked on every request) | No (`403`) | No (`403`) | No (`403`) | No (`403`) |
| `user` (`editor`) | Signed cookie via Google OAuth or magic link | Yes | Yes | No (`403`) | No (`403`) | No (`403`) |
| `user` (`admin`) | Signed cookie via Google OAuth or magic link | Yes | Yes | Yes | Yes | Yes |
| `agent` (`read_backup`) | `Authorization: Bearer klm_...` (SHA-256 hashed in D1) | Yes | No (`403`) | No (`403`) | Yes | No (`403`) |
| `agent` (`write_batch`) | `Authorization: Bearer klm_...` (SHA-256 hashed in D1) | Yes (plus `GET /api/entities/*`, `GET /api/revisions`) | Media upload only (`POST /api/media/upload`) | Yes | No (`403`) | No (`403`) |

Agent bearer tokens never grant access to `/api/admin/*` routes and cannot post Talk comments. Use `read_backup` tokens for automated backups and reconciliation jobs, and mint `write_batch` tokens only for trusted seeding or batch-import pipelines.

<!-- kinloom-section id=invites-and-members kind=permissions keywords=invites,editors,members,tokens,bootstrap_admin_email,lockout -->
## Invite family members and enroll editors

Manage invites, member accounts, and agent tokens from `/admin` (backed by `/api/admin/invites`, `/api/admin/users`, and `/api/admin/agent-tokens`).

### Create and revoke family invite links

1. Open `/admin` and go to the **Family Invite Links** section.
2. Enter a clear label (for example `"Alder Reunion Spring 2026"`) and an expiration window in days (`1` to `3650`, default `30`).
3. Share the generated `/api/auth/invite/inv_...` (or `/invite/inv_...`) link with relatives.
4. Opening the link sets a read-only `invite_viewer` session cookie. Kinloom checks the invite record in D1 on every request, so revoking an invite removes read access immediately without waiting for cookie expiration.

### Enroll editors and promote admins

You can enroll editors in two ways:

- **Direct enrollment in `/admin`:** Add the person's email address, display name, and role (`editor` or `admin`) under **Members**. They can then sign in via Google OAuth or magic link.
- **Self-enrollment via an active family invite:** A relative who opened an active invite link and then signs in with Google OAuth or a magic link is enrolled automatically as an `editor` (`added_by: "invite:<token>"`). Invited sign-ins never auto-enroll as `admin`.

### Rotate and revoke agent tokens

1. Mint a new token in `/admin` under **Agent & Backup Tokens** with the narrowest scope needed (`read_backup` or `write_batch`).
2. Copy the `klm_...` plaintext secret immediately, because Kinloom stores only its SHA-256 hash in `agent_tokens` and never displays the secret again.
3. Update your CI secret (for example `KINLOOM_BACKUP_TOKEN`) and revoke the old token in `/admin`. Revocation takes effect on the next request.

### Last-admin lockout protection

Kinloom prevents accidental owner lockout in two ways:

- `AdminService` refuses to delete or demote the final `admin` user and returns HTTP `409 LAST_ADMIN_PROTECTED`.
- `BOOTSTRAP_ADMIN_EMAIL` always resolves to an `admin` account on sign-in, even if the `users` table is empty after a database restore.

<!-- kinloom-section id=living-person-privacy kind=permissions keywords=privacy,living,archive_mode,livingCutoffYears,living_media_forbidden,audit -->
## Operate the living-person privacy fence

Kinloom enforces living-person privacy at write time, compile time, API read time, and Open Graph rendering time through `resolveEffectiveLiving` (`packages/core/src/privacy/policy.ts`).

### How living status is classified

A person is treated as living if any of these conditions hold:

1. `is_living` is explicitly `true`.
2. `death_edtf` is blank and `birth_edtf` yields a year greater than `referenceYear - livingCutoffYears` (default `livingCutoffYears` is `101`).
3. Neither death nor burial is recorded and the earliest event year is within the cutoff window.

Recording a `death_edtf` value (and setting `is_living: false`) marks a person as confirmed deceased.

### `ARCHIVE_MODE=private` compared with `ARCHIVE_MODE=public`

| Behavior | `ARCHIVE_MODE=private` (default) | `ARCHIVE_MODE=public` |
| --- | --- | --- |
| Reader access | Requires active invite link, member session, or agent token | Open to anonymous visitors |
| Living person names on Person Profiles and People Directory | Displays named living relatives with `b. YYYY` (when `privateModeShowsBirthYear: true`) or `Living` | Redacted to `full_name: "Living"`, `surname: ""`, `alt_names: []`, and cleared dates |
| Living person exact birthdates (month and day) | Stripped to year only (or cleared if `privateModeShowsBirthYear: false`) | Cleared completely |
| Living-linked events | Location cleared, date reduced to year only, summary redacted | Living-only events dropped; mixed events redacted and scrubbed |
| Living portraits and residence spans | Stripped when `stripLivingPortraits: true` and `stripLivingResidenceSpans: true` (defaults) | Always stripped |
| Narratives mentioning living people | Preserved for signed-in family members | `subject_person_id` and living `person_ids` stripped; living names scrubbed to `Living` |

### Why media uploads fail with `422 LIVING_MEDIA_FORBIDDEN`

`MediaService.uploadMedia` runs `assertMediaAllowedForPrivacy` **before** writing bytes to R2 and runs the check a second time before committing the entity revision. If the uploaded media links to any effective-living person directly (`person_id` or `person_ids`) or indirectly through an event (`event_id` participants), the server rejects the request with HTTP `422 LIVING_MEDIA_FORBIDDEN` and writes zero objects to R2.

### Audit privacy before publishing

Run these checks locally before syncing or switching an archive to public mode:

```bash
npx kinloom verify
npx kinloom pronounce audit --strict
```

`kinloom verify` compiles your archive in both `private` and `public` modes, verifies zero review flags, scans `data/*.yaml` for Social Security Number patterns, and scans public-exported narratives, events, media captions, and source citations for living-person names. `kinloom pronounce audit` fails loudly if any living person has a pronunciation entry.

<!-- kinloom-section id=security-hardening kind=permissions keywords=security,csp,csrf,session_secret,magic-bytes,waf -->
## Harden your deployment

### Rotate `SESSION_SECRET`

Generate a fresh 32-byte secret and update the Worker secret whenever you suspect cookie exposure or as part of scheduled key rotation:

```bash
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
```

Rotating `SESSION_SECRET` immediately invalidates every active browser session cookie (`__Host-kinloom_session`) and in-flight OAuth cookie (`__Host-kinloom_oauth`). Signed-in users simply sign in again; agent bearer tokens in D1 are unaffected because they authenticate by SHA-256 hash.

### Default HTTP security headers and Content Security Policy

`applySecurityHeaders` (`packages/server/src/http/securityHeaders.ts`) attaches strict headers to every response:

- **Application CSP:** `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com` (no `'unsafe-inline'` scripts).
- **Sandboxed media CSP:** Every `/media/*` and `/sources/*` response sets `Content-Security-Policy: default-src 'none'; sandbox` so uploaded PDFs or images cannot run scripts in the archive origin.
- **Transport and framing headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Strict-Transport-Security: max-age=31536000; includeSubDomains` on HTTPS origins.

### CSRF origin checks and upload validation

- **CSRF protection:** Every cookie-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` request must include an `Origin` header matching the Worker's exact origin. Mismatches fail with HTTP `403 CSRF_ORIGIN_MISMATCH`.
- **Magic-byte upload checks:** `MediaService` inspects actual file header bytes for JPEG, PNG, WebP, GIF, and PDF uploads and rejects spoofed `Content-Type` headers with HTTP `415 UNSUPPORTED_MEDIA_TYPE`.

### Edge WAF rules and security telemetry

Enable Cloudflare WAF rate limiting on `/api/auth/*` and `/api/media/upload`, and enable redacted security telemetry events (`csrf.rejected`, `auth.magic_link.rate_limited`, `auth.agent_token.rejected`, `media.upload.rejected`) using [Cloudflare Workers observability](../observability.md).

If you discover a security or privacy vulnerability in Kinloom itself, report it privately according to [SECURITY.md](../../SECURITY.md).
