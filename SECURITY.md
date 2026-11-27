# Security policy

## Supported versions

Kinloom publishes security fixes on the current `0.x` release line from `main`. Older `0.x` releases do not receive backports.

| Version | Supported |
| --- | --- |
| Latest `0.x` (`main`) | Yes |
| Earlier `0.x` releases | No |

## Report a vulnerability

Report security issues privately through GitHub Security Advisories:

https://github.com/Tiberriver256/kinloom/security/advisories/new

Do not open a public GitHub issue, pull request, or discussion for an unpatched vulnerability.

Include these details in your report:

- The affected package or endpoint (for example `@kinloom/core`, `@kinloom/server`, `@kinloom/worker`, `@kinloom/cli`, or `@kinloom/ui`).
- Clear steps to reproduce the issue, including a minimal synthetic fixture.
- The impact on confidentiality, integrity, availability, or living-person privacy.

Do not include real names, birth dates, or private documents of living people in a bug report.

## Response timeline

- **Acknowledgment.** Within 3 business days.
- **Initial triage and severity assessment.** Within 7 calendar days.
- **Fix and coordinated disclosure.** We build and verify a fix in a private advisory branch, publish a patched version to npm, and publish the advisory after the fix ships.

## Kinloom security and privacy model

Kinloom separates public historical family archives from living-person records and authenticated operator actions. Security reports targeting any of these boundaries are in scope.

### Living-person privacy fence

- `resolveEffectiveLiving` in `packages/core/src/privacy/policy.ts` classifies each person as living or deceased from explicit `living` flags, recorded death dates, and the default 101-year living cutoff (`DEFAULT_LIVING_CUTOFF_YEARS`).
- Public archive compilation (`applyPrivacyFilter`, `redactSinglePerson`, `redactSingleEvent`, `redactSingleNarrative`, and `filterMediaForPrivacy` in `packages/core/src/privacy/redaction.ts`) redacts living people, omits living-linked residence spans and portraits, and scrubs living-person names (`scrubLivingNames`) from narratives.
- Runtime API reads, Open Graph cards (`/og/person/:id.svg`), and server telemetry (`redactObservabilityText` in `packages/server/src/plugins/workersObservability.ts`) enforce the same redaction boundary so living-person identifiers, emails, tokens, and cookies do not leak into public responses or logs.

### Authentication, RBAC, and CSRF protection

- `resolveCallerPrincipal` in `packages/server/src/http/authMiddleware.ts` authenticates callers through SHA-256 hashed agent bearer tokens, HMAC-signed session cookies, or live invite records checked on every request so revoked or expired invites lose access immediately.
- Route handlers enforce role-based access control across anonymous readers, invited viewers, authenticated editors, and administrators.
- State-changing requests (`POST`, `PUT`, `PATCH`, and `DELETE`) authenticated with cookies require matching request origins and emit typed `csrf.rejected` security events on failure.

### HTTP security headers and Content Security Policy

- `applySecurityHeaders` and `buildContentSecurityPolicy` in `packages/server/src/http/securityHeaders.ts` attach `Content-Security-Policy` (`default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Strict-Transport-Security` on HTTPS origins.
- User-uploaded media responses use a strict sandbox policy (`default-src 'none'; sandbox`) to block active content execution.

## Operator responsibilities

Self-hosted archive operators are responsible for:

- Keeping Cloudflare Worker secrets (`SESSION_SECRET`, OAuth client secrets, and agent tokens) out of source control.
- Keeping private family YAML data, GEDCOM exports, and scanned documents outside public repositories.
- Running `npm run check:leaks` before publishing changes to any public archive repository.
