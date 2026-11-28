import {
  AdminChangelogsResponseSchema,
  getBuiltinModuleChangelogs,
  parseAdminChangelogsResponse,
} from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createAdminRouteHandler } from '../http/routes/adminRoutes.js';
import { createPageVisitStatsPlugin } from '../plugins/pageVisitStats.js';
import { createWorkersObservabilityPlugin } from '../plugins/workersObservability.js';
import { ChangelogService } from './changelogService.js';

describe('ChangelogService & @kinloom/core changelog schemas (#56)', () => {
  it('returns structured changelogs for all 6 workspace modules and registered server plugins', () => {
    const pageVisits = createPageVisitStatsPlugin();
    const observability = createWorkersObservabilityPlugin();
    const service = new ChangelogService({
      plugins: [
        pageVisits,
        observability,
        {
          id: 'synthetic-no-changelog',
          name: 'Synthetic Minimal Plugin',
        },
      ],
      workerVersion: '0.61.0',
      now: () => new Date('2026-11-28T00:00:00.000Z'),
    });

    const payload = service.getChangelogs();
    expect(payload.generated_at).toBe('2026-11-28T00:00:00.000Z');
    expect(payload.modules.map((m) => m.id)).toEqual([
      '@kinloom/core',
      '@kinloom/server',
      '@kinloom/worker',
      '@kinloom/ui',
      '@kinloom/cli',
      '@kinloom/tokens',
    ]);
    for (const mod of payload.modules) {
      expect(mod.kind).toBe('module');
      expect(mod.entries.length).toBeGreaterThan(0);
    }

    expect(payload.plugins).toHaveLength(3);
    const visitsEntry = payload.plugins.find((p) => p.id === pageVisits.id);
    expect(visitsEntry?.entries.length).toBeGreaterThan(0);
    const minimalEntry = payload.plugins.find((p) => p.id === 'synthetic-no-changelog');
    expect(minimalEntry?.entries).toEqual([]);

    expect(parseAdminChangelogsResponse(payload)).toEqual(payload);
    expect(AdminChangelogsResponseSchema.safeParse({ invalid: true }).success).toBe(false);
  });

  it('supports default clock and getBuiltinModuleChangelogs custom versions', () => {
    const mods = getBuiltinModuleChangelogs({
      coreVersion: '1.2.3',
      serverVersion: '1.2.4',
      workerVersion: '1.2.5',
      uiVersion: '1.2.6',
      cliVersion: '1.2.7',
      tokensVersion: '1.2.8',
    });
    expect(mods.find((m) => m.id === '@kinloom/core')?.current_version).toBe('1.2.3');
    expect(mods.find((m) => m.id === '@kinloom/tokens')?.current_version).toBe('1.2.8');

    const defaultService = new ChangelogService({ plugins: [] });
    expect(defaultService.getChangelogs().modules).toHaveLength(6);
  });

  it('enforces admin RBAC on GET /api/admin/changelogs via createAdminRouteHandler', async () => {
    const service = new ChangelogService({ plugins: [createPageVisitStatsPlugin()] });
    const handler = createAdminRouteHandler({} as never, undefined, undefined, service);

    // Authenticated admin succeeds with 200
    const adminRes = await handler({
      request: new Request('https://archive.test/api/admin/changelogs'),
      url: new URL('https://archive.test/api/admin/changelogs'),
      method: 'GET',
      segments: ['api', 'admin', 'changelogs'],
      auth: {
        authMethod: 'session',
        bearerRejected: false,
        principal: { kind: 'user', email: 'admin@alder.test', displayName: 'Admin', role: 'admin' },
      },
      telemetry: {} as never,
    } as never);
    expect(adminRes?.status).toBe(200);
    const body = parseAdminChangelogsResponse(await adminRes?.json());
    expect(body.modules).toHaveLength(6);
    expect(body.plugins).toHaveLength(1);

    // Non-admin editor is rejected
    await expect(
      handler({
        request: new Request('https://archive.test/api/admin/changelogs'),
        url: new URL('https://archive.test/api/admin/changelogs'),
        method: 'GET',
        segments: ['api', 'admin', 'changelogs'],
        auth: {
          authMethod: 'session',
          bearerRejected: false,
          principal: { kind: 'user', email: 'editor@alder.test', displayName: 'Editor', role: 'editor' },
        },
        telemetry: {} as never,
      } as never)
    ).rejects.toMatchObject({ status: 403 });
  });
});
