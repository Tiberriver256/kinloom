import { type AdminDocEntry, AdminDocEntrySchema } from '../schemas/adminDocs.js';

const BUILTIN_ADMIN_DOCS_DATA: readonly AdminDocEntry[] = [
  {
    id: 'core-server-setup',
    title: 'Server Setup & Configuration',
    summary:
      'Core deployment settings, visibility modes, session secrets, and Cloudflare Workers / D1 / R2 bindings.',
    kind: 'core',
    source_id: '@kinloom/server',
    source_name: 'Kinloom Core',
    sections: [
      {
        id: 'visibility-modes',
        heading: 'Archive Visibility Modes (Private vs. Public)',
        markdown: [
          'Kinloom runs in either **private** (default) or **public** mode:',
          '',
          '- **Private mode** requires an authenticated session or active read-only invite link for every archive route and API call.',
          '- **Public mode** allows anonymous visitors to browse deceased ancestors, places, narratives, and cited sources while keeping the living-person privacy fence strictly enforced.',
          '- Administrative routes (`/api/admin/*`) and write operations always require an authenticated `admin` or `editor` principal regardless of visibility mode.',
        ].join('\n'),
      },
      {
        id: 'runtime-secrets',
        heading: 'Required Runtime Secrets & Bindings',
        markdown: [
          'Verify the following environment bindings before deploying to production:',
          '',
          '- **`SESSION_SECRET`**: At least 16 random bytes (32+ recommended) used to sign HTTP-only session cookies.',
          '- **`BOOTSTRAP_ADMIN_EMAIL`**: Grants initial `admin` access on first sign-in when the users table is empty.',
          '- **D1 Database & R2 Bucket**: D1 stores canonical entities, revisions, users, invites, and plugin tables; R2 stores deduplicated media binaries and the compiled archive bundle cache.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'core-auth-invites-rbac',
    title: 'Authentication, Invites & Access Control',
    summary:
      'Role-based permissions for admins and editors, read-only family invite links, and scoped agent tokens.',
    kind: 'core',
    source_id: '@kinloom/server',
    source_name: 'Kinloom Core',
    sections: [
      {
        id: 'roles-overview',
        heading: 'User Roles & Capabilities',
        markdown: [
          'Enrolled accounts hold one of two editorial roles:',
          '',
          '- **Admin**: Full access to Site Administration (members, invites, agent tokens, diagnostics, plugin settings, changelogs, and documentation) plus all editorial actions.',
          '- **Editor**: Can create and edit people, places, narratives, sources, and media, post Talk comments, and review or revert revisions.',
          '- **Invite Viewer**: Read-only access granted via a revocable invite link created in Site Administration.',
        ].join('\n'),
      },
      {
        id: 'invites-and-tokens',
        heading: 'Invite Links & Agent Tokens',
        markdown: [
          'Use **Invite Links** to share a private archive with family members without creating permanent accounts. You can set an expiration window and revoke any link immediately.',
          '',
          'Use **Agent Tokens** for automated tools and backups:',
          '',
          '- **`write_batch`**: Permits batch research ingestion and wiki mutations with full revision history.',
          '- **`read_backup`**: Permits read-only archive and GEDCOM 7 exports without editorial write access.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'core-privacy-fence',
    title: 'Living-Person Privacy Fence',
    summary:
      'How Kinloom protects living relatives across public archives, bundle compilation, media, and exports.',
    kind: 'core',
    source_id: '@kinloom/core',
    source_name: 'Kinloom Core',
    sections: [
      {
        id: 'how-the-fence-works',
        heading: 'Automatic Living-Person Redaction',
        markdown: [
          'Every compiled archive bundle passes through the **living-person privacy filter** before reaching public or unauthenticated viewers:',
          '',
          '- People marked `is_living: true` (or inferred living from recent birth years without a death date) are stripped from public indexes, search, trees, maps, and Open Graph metadata.',
          '- Links and media referencing living people are scrubbed from public narratives and place pages.',
          '- Authenticated editors and admins continue to see full records while working inside the archive.',
        ].join('\n'),
      },
      {
        id: 'privacy-verification',
        heading: 'Verifying Privacy Before Publishing',
        markdown: [
          'Before switching an archive from `private` to `public` mode:',
          '',
          '1. Review living-status flags on recently born individuals in the People directory.',
          '2. Confirm that any sensitive notes are placed in Talk discussions rather than public biographies.',
          '3. Run the automated leak check (`npm run check:leaks`) in CI whenever updating public templates or plugins.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'core-storage-sync-backups',
    title: 'D1/R2 Storage, Bundle Cache & Backups',
    summary:
      'Understanding the D1 revision ledger, R2 bundle caching, media deduplication, and backup exports.',
    kind: 'core',
    source_id: '@kinloom/server',
    source_name: 'Kinloom Core',
    sections: [
      {
        id: 'bundle-cache-lifecycle',
        heading: 'Compiled Bundle Cache & ETag Invalidation',
        markdown: [
          'Kinloom maintains an append-only revision log in **D1** and compiles a fast read-optimized snapshot in **R2**:',
          '',
          '- Every committed entity mutation advances the head revision ID and incrementally patches or rebuilds the cached bundle.',
          '- Clients send `If-None-Match` ETags so unchanged archives return `304 Not Modified` with minimal bandwidth.',
          '- Uploaded media files are content-addressed by **SHA-256**, preventing duplicate storage across entities.',
        ].join('\n'),
      },
      {
        id: 'backup-workflow',
        heading: 'Backups & Portable Exports',
        markdown: [
          'Maintain regular offline backups of both your genealogical data and uploaded media:',
          '',
          '- Issue a dedicated **`read_backup`** agent token in Site Administration for scheduled export scripts.',
          '- Export standard **GEDCOM 7** files from the archive for long-term archival interoperability.',
          '- Snapshot D1 and R2 buckets via your Cloudflare account before major schema or plugin upgrades.',
        ].join('\n'),
      },
    ],
  },
  {
    id: 'core-troubleshooting',
    title: 'Troubleshooting & Diagnostics',
    summary: 'Diagnosing runtime errors, verifying plugin health, and rolling back unwanted archive edits.',
    kind: 'core',
    source_id: '@kinloom/server',
    source_name: 'Kinloom Core',
    sections: [
      {
        id: 'diagnostics-checklist',
        heading: 'Using System Diagnostics & Changelogs',
        markdown: [
          'Start every incident check inside **Site Administration**:',
          '',
          '- **System Diagnostics**: Confirms archive mode, active storage adapters, installed server & UI plugins, and the in-memory recent error ring buffer.',
          '- **Plugins & Integrations**: Verifies declarative plugin settings and whether required secrets are configured (secret values are never echoed back to the browser).',
          '- **Changelogs & What’s New**: Confirms the exact running versions of `@kinloom/core`, `@kinloom/server`, and every registered plugin.',
        ].join('\n'),
      },
      {
        id: 'revisions-and-reverts',
        heading: 'Auditing & Reverting Archive Changes',
        markdown: [
          'Open **Recent Changes** (`/changes`) to inspect every edit and batch import:',
          '',
          '- Stamp reviewed changes with a **Steward Review** note to track verification progress.',
          '- Use single-revision or full-batch **Revert** to roll back accidental edits cleanly without losing audit history.',
        ].join('\n'),
      },
    ],
  },
];

const VALIDATED_BUILTIN_ADMIN_DOCS: readonly AdminDocEntry[] = BUILTIN_ADMIN_DOCS_DATA.map((entry) =>
  AdminDocEntrySchema.parse(entry)
);

export function getBuiltinAdminDocs(): readonly AdminDocEntry[] {
  return VALIDATED_BUILTIN_ADMIN_DOCS;
}
