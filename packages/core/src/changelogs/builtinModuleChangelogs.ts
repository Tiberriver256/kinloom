import type { ChangelogEntry, ModuleChangelog } from '../schemas/changelogs.js';
import { KINLOOM_CORE_VERSION } from '../version.js';

export interface BuiltinModuleChangelogRecord {
  readonly id:
    | '@kinloom/core'
    | '@kinloom/server'
    | '@kinloom/worker'
    | '@kinloom/ui'
    | '@kinloom/cli'
    | '@kinloom/tokens';
  readonly name: string;
  readonly entries: readonly ChangelogEntry[];
}

export const BUILTIN_MODULE_CHANGELOGS: readonly BuiltinModuleChangelogRecord[] = [
  {
    id: '@kinloom/core',
    name: 'Kinloom Core',
    entries: [
      {
        version: '0.67.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.67.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.67.0.',
          },
        ],
      },
      {
        version: '0.66.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.1.',
          },
        ],
      },
      {
        version: '0.66.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.0.',
          },
        ],
      },
      {
        version: '0.65.2',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.2 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.2.',
          },
        ],
      },
      {
        version: '0.65.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.1.',
          },
        ],
      },
      {
        version: '0.65.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.0.',
          },
        ],
      },
      {
        version: '0.64.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.64.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.64.0.',
          },
        ],
      },
      {
        version: '0.61.0',
        date: '2026-11-28',
        summary:
          'Structured module/plugin changelog schemas, plugin settings contracts, and archival search.',
        changes: [
          {
            category: 'added',
            text: 'Typed ChangelogEntry and AdminChangelogsResponse schemas for module and plugin release histories.',
          },
          {
            category: 'changed',
            text: 'Expanded plugin settings validation contracts and archive read-role helpers.',
          },
        ],
      },
      {
        version: '0.57.0',
        date: '2026-11-27',
        summary: 'Cross-object navigation contracts and dynamic Direct Line focal anchor support.',
        changes: [
          {
            category: 'added',
            text: 'Archive search indexing across people, places, events, and primary source transcriptions.',
          },
        ],
      },
    ],
  },
  {
    id: '@kinloom/server',
    name: 'Kinloom Server',
    entries: [
      {
        version: '0.67.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.67.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.67.0.',
          },
        ],
      },
      {
        version: '0.66.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.1.',
          },
        ],
      },
      {
        version: '0.66.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.0.',
          },
        ],
      },
      {
        version: '0.65.2',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.2 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.2.',
          },
        ],
      },
      {
        version: '0.65.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.1.',
          },
        ],
      },
      {
        version: '0.65.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.0.',
          },
        ],
      },
      {
        version: '0.64.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.64.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.64.0.',
          },
        ],
      },
      {
        version: '0.61.0',
        date: '2026-11-28',
        summary: 'Admin changelogs endpoint, plugin lifecycle sync, and RBAC hardening.',
        changes: [
          {
            category: 'added',
            text: 'Admin-only GET /api/admin/changelogs endpoint returning module and registered server plugin release histories.',
          },
          {
            category: 'fixed',
            text: 'Synchronized plugin runtime settings and SPA page-visit beacons across public and private archives.',
          },
          {
            category: 'security',
            text: 'Enforced CSRF origin and admin role guards across all admin changelog and settings endpoints.',
          },
        ],
      },
      {
        version: '0.55.0',
        date: '2026-11-27',
        summary: 'System diagnostics, redacted bug-report bundles, and declarative plugin settings.',
        changes: [
          {
            category: 'added',
            text: 'GET /api/admin/system diagnostics report and write-only secret masking for plugin settings.',
          },
        ],
      },
    ],
  },
  {
    id: '@kinloom/worker',
    name: 'Kinloom Cloudflare Worker',
    entries: [
      {
        version: '0.67.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.67.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.67.0.',
          },
        ],
      },
      {
        version: '0.66.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.1.',
          },
        ],
      },
      {
        version: '0.66.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.0.',
          },
        ],
      },
      {
        version: '0.65.2',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.2 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.2.',
          },
        ],
      },
      {
        version: '0.65.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.1.',
          },
        ],
      },
      {
        version: '0.65.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.0.',
          },
        ],
      },
      {
        version: '0.64.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.64.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.64.0.',
          },
        ],
      },
      {
        version: '0.61.0',
        date: '2026-11-28',
        summary: 'Cloudflare Workers D1/R2 adapter updates and built-in plugin re-exports.',
        changes: [
          {
            category: 'added',
            text: 'Wired D1 plugin migrations and live SPA beacon support for Cloudflare Workers deployments.',
          },
          {
            category: 'fixed',
            text: 'Aligned archive read permissions on public and private Cloudflare Worker routes.',
          },
        ],
      },
      {
        version: '0.54.0',
        date: '2026-11-26',
        summary: 'Streaming R2 media range requests and D1 optimistic concurrency.',
        changes: [
          {
            category: 'added',
            text: 'HTTP 206 partial-content streaming for archival audio/video stored in Cloudflare R2.',
          },
        ],
      },
    ],
  },
  {
    id: '@kinloom/ui',
    name: 'Kinloom UI',
    entries: [
      {
        version: '0.67.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.67.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.67.0.',
          },
        ],
      },
      {
        version: '0.66.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.1.',
          },
        ],
      },
      {
        version: '0.66.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.0.',
          },
        ],
      },
      {
        version: '0.65.2',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.2 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.2.',
          },
        ],
      },
      {
        version: '0.65.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.1.',
          },
        ],
      },
      {
        version: '0.65.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.0.',
          },
        ],
      },
      {
        version: '0.64.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.64.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.64.0.',
          },
        ],
      },
      {
        version: '0.61.0',
        date: '2026-11-28',
        summary:
          'Archival Command Bar, Places Directory IA redesign, Kinship Loom constellation, and Admin Changelogs.',
        changes: [
          {
            category: 'added',
            text: 'In-app Admin Changelogs & What’s New viewer with module/plugin and category filters.',
          },
          {
            category: 'added',
            text: 'Macro Kinship Loom birth-year river constellation tier (< 45% zoom) with Trace My Thread spotlight.',
          },
          {
            category: 'added',
            text: 'Redesigned Places Directory (/places) with By Region | By Era | A–Z views, sticky Jump Strip, growth guard, and URL sync.',
          },
          {
            category: 'changed',
            text: 'Upgraded Global Search into an Archival Command Bar (/ and Cmd/Ctrl+K) with zero-query Quick Actions and desktop two-pane preview slip.',
          },
        ],
      },
      {
        version: '0.57.0',
        date: '2026-11-27',
        summary: 'Objects vs. Lenses topbar IA, Reading Room rename, and AAA Dark Mode.',
        changes: [
          {
            category: 'changed',
            text: 'Grouped topbar Object Directories separately from Lenses and connected cross-object front doors.',
          },
        ],
      },
    ],
  },
  {
    id: '@kinloom/cli',
    name: 'Kinloom CLI',
    entries: [
      {
        version: '0.67.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.67.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.67.0.',
          },
        ],
      },
      {
        version: '0.66.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.1.',
          },
        ],
      },
      {
        version: '0.66.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.0.',
          },
        ],
      },
      {
        version: '0.65.2',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.2 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.2.',
          },
        ],
      },
      {
        version: '0.65.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.1.',
          },
        ],
      },
      {
        version: '0.65.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.0.',
          },
        ],
      },
      {
        version: '0.64.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.64.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.64.0.',
          },
        ],
      },
      {
        version: '0.61.0',
        date: '2026-11-28',
        summary: 'CLI build/compile tooling and release version synchronization.',
        changes: [
          {
            category: 'changed',
            text: 'Synchronized CLI user-agent and release tooling with structured workspace changelogs.',
          },
        ],
      },
      {
        version: '0.54.0',
        date: '2026-11-26',
        summary: 'Archival screenshot capture CLI and GEDCOM 7 pipeline.',
        changes: [
          {
            category: 'added',
            text: 'kinloom screenshots command capturing real Chromium PNGs with secret redaction.',
          },
        ],
      },
    ],
  },
  {
    id: '@kinloom/tokens',
    name: 'Kinloom Design Tokens',
    entries: [
      {
        version: '0.67.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.67.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.67.0.',
          },
        ],
      },
      {
        version: '0.66.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.1.',
          },
        ],
      },
      {
        version: '0.66.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.66.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.66.0.',
          },
        ],
      },
      {
        version: '0.65.2',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.2 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.2.',
          },
        ],
      },
      {
        version: '0.65.1',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.1 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.1.',
          },
        ],
      },
      {
        version: '0.65.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.65.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.65.0.',
          },
        ],
      },
      {
        version: '0.64.0',
        date: '2026-11-28',
        summary: 'Kinloom v0.64.0 release.',
        changes: [
          {
            category: 'changed',
            text: 'Updated module for Kinloom v0.64.0.',
          },
        ],
      },
      {
        version: '0.61.0',
        date: '2026-11-28',
        summary: 'Paper & Ink and Archival Dark Mode AAA-verified design tokens.',
        changes: [
          {
            category: 'added',
            text: 'WCAG AAA-verified light and dark archival color palettes with automated contrast gates.',
          },
        ],
      },
    ],
  },
];

export function getBuiltinModuleChangelogs(options?: {
  readonly coreVersion?: string;
  readonly serverVersion?: string;
  readonly workerVersion?: string | null;
  readonly uiVersion?: string;
  readonly cliVersion?: string;
  readonly tokensVersion?: string;
}): ModuleChangelog[] {
  const coreVer = options?.coreVersion ?? KINLOOM_CORE_VERSION;
  const versionsById: Record<BuiltinModuleChangelogRecord['id'], string> = {
    '@kinloom/core': coreVer,
    '@kinloom/server': options?.serverVersion ?? coreVer,
    '@kinloom/worker': options?.workerVersion ?? coreVer,
    '@kinloom/ui': options?.uiVersion ?? coreVer,
    '@kinloom/cli': options?.cliVersion ?? coreVer,
    '@kinloom/tokens': options?.tokensVersion ?? coreVer,
  };

  return BUILTIN_MODULE_CHANGELOGS.map((mod) => ({
    id: mod.id,
    name: mod.name,
    kind: 'module',
    current_version: versionsById[mod.id],
    entries: [...mod.entries],
  }));
}
