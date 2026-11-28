import type { EmbeddedGuide } from '../types.js';

export const VERIFY_LIVE_GUIDE: EmbeddedGuide = {
  id: 'verify-live',
  command: 'verify-live',
  category: 'ops',
  summary:
    'Verify live Cloudflare deployments with ephemeral D1 auth, privacy invariants, and browser/PWA checks',
  body: `# Live Deployment Verification (\`kinloom verify-live\`)

Run post-deploy verification against a live Kinloom archive without writing manual \`wrangler d1\` SQL.

## Standard Post-Deploy Check

\`\`\`bash
kinloom verify-live --repo . --expect-plugins kinloom-workers-observability,kinloom-pronunciation --browser --check-pwa
\`\`\`

## What \`verify-live\` Checks

1. **Anonymous Privacy Gate:** Confirms unauthenticated \`GET /api/bundle\` returns \`HTTP 401\`.
2. **Authenticated Synthetic Probe & Plugins:** Runs \`probe --plugins\` (HTML TTFB, security headers, cold/warm \`/api/bundle\` 304, R2 media 206 Range, and every plugin listed in \`--expect-plugins\`).
3. **Live Bundle Living Privacy Rule Audit:** Verifies \`0\` Living person portraits, \`0\` exact \`YYYY-MM-DD\` Living birth dates, \`0\` Living residence spans, and \`0\` Living media or narratives.
4. **Headless Browser Smoke (\`--browser\`):** Redeems an ephemeral viewer invite, loads \`/\`, confirms a visible \`<h1>\`, \`0\` \`pageerror\` events, and \`0\` failed \`/assets/*\` or \`/api/*\` requests.
5. **PWA & Brandkit Assets (\`--check-pwa\`):** Verifies \`/site.webmanifest\`, \`/sw.js\`, \`/favicon-light.svg\`, and \`/favicon-dark.svg\`.
6. **Guaranteed Ephemeral D1 Cleanup:** Revokes every minted \`tmp_cli_*\` token and \`tmp_inv_*\` invite in \`finally\` and on \`SIGINT\`/\`SIGTERM\`, asserting \`backupCount === 1\` (for \`github-actions-nightly-backup\`) and \`remainingTmpCount === 0\`.

## Privacy

Follow the **Living Privacy Rule**: never commit private URLs, invite tokens, or temporary bearer secrets into logs or repository files. \`verify-live\` automatically omits raw secrets from JSON and text reports.`,
};
