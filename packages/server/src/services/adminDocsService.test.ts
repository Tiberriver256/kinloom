import {
  AdminDocsResponseSchema,
  getBuiltinAdminDocs,
  parseAdminDocsResponse,
  validatePluginDocumentation,
} from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { validateAndCompilePluginRoutes } from '../http/router.js';
import { createAdminRouteHandler } from '../http/routes/adminRoutes.js';
import { createBookPublishingServerPlugin } from '../plugins/bookPublishing/serverPlugin.js';
import { createOpenFinancePlugin } from '../plugins/openFinance.js';
import { createPageVisitStatsPlugin } from '../plugins/pageVisitStats.js';
import { createPronunciationPlugin } from '../plugins/pronunciationPlugin.js';
import { createRecipesServerPlugin } from '../plugins/recipes/serverPlugin.js';
import { createWorkersObservabilityPlugin } from '../plugins/workersObservability.js';
import { AdminDocsService } from './adminDocsService.js';

describe('AdminDocsService & @kinloom/core plugin documentation contract (#55)', () => {
  it('aggregates built-in core administration guides and registered server plugin documentation', () => {
    const observability = createWorkersObservabilityPlugin({ enabled: true });
    const pageVisits = createPageVisitStatsPlugin({ enabled: true });
    const service = new AdminDocsService({
      plugins: [
        observability,
        pageVisits,
        {
          id: 'synthetic-no-docs',
          name: 'Synthetic Minimal Plugin',
        },
        {
          id: 'synthetic-with-link',
          name: 'Synthetic External Docs Plugin',
          documentation: {
            id: 'docs-synthetic-external',
            title: 'Synthetic External Guide',
            summary: 'Plugin guide with external reference link.',
            sections: [
              {
                id: 'setup',
                heading: 'Setup',
                markdown: 'Configure the synthetic plugin in **Site Administration**.',
              },
            ],
            externalUrl: 'https://example.test/docs/synthetic',
          },
        },
      ],
      now: () => new Date('2026-11-28T04:20:00.000Z'),
    });

    const payload = service.getDocs();
    expect(payload.generated_at).toBe('2026-11-28T04:20:00.000Z');
    expect(payload.core_docs).toHaveLength(getBuiltinAdminDocs().length);
    expect(payload.core_docs.map((d) => d.id)).toEqual([
      'core-server-setup',
      'core-auth-invites-rbac',
      'core-privacy-fence',
      'core-storage-sync-backups',
      'core-troubleshooting',
    ]);
    expect(payload.plugin_docs).toHaveLength(3);
    expect(payload.plugin_docs.find((d) => d.source_id === 'synthetic-with-link')?.external_url).toBe(
      'https://example.test/docs/synthetic'
    );
    expect(parseAdminDocsResponse(payload)).toEqual(payload);
    expect(AdminDocsResponseSchema.safeParse({ invalid: true }).success).toBe(false);
  });

  it('verifies every built-in server plugin ships valid structured documentation in enabled and disabled modes', () => {
    const builtinPlugins = [
      createWorkersObservabilityPlugin({ enabled: false }),
      createWorkersObservabilityPlugin({ enabled: true }),
      createPageVisitStatsPlugin({ enabled: false }),
      createPageVisitStatsPlugin({ enabled: true }),
      createOpenFinancePlugin({ enabled: false }),
      createOpenFinancePlugin({ enabled: true }),
      createPronunciationPlugin(),
      createBookPublishingServerPlugin({ enabled: false }),
      createBookPublishingServerPlugin({ enabled: true }),
      createRecipesServerPlugin({ enabled: false }),
      createRecipesServerPlugin({ enabled: true }),
    ];

    for (const plugin of builtinPlugins) {
      expect(
        plugin.documentation,
        `Built-in server plugin '${plugin.name}' must ship documentation`
      ).toBeDefined();
      const validated = validatePluginDocumentation(plugin.documentation, plugin.name);
      expect(validated.sections.length).toBeGreaterThan(0);
    }
  });

  it('fails fast during plugin registration when documentation is malformed or has unsafe externalUrl', () => {
    expect(() =>
      validateAndCompilePluginRoutes([
        {
          id: 'bad-empty-sections',
          name: 'Bad Plugin',
          documentation: {
            id: 'bad-docs',
            title: 'Bad Docs',
            summary: 'Missing sections',
            sections: [],
          },
        },
      ])
    ).toThrow(RangeError);

    expect(() =>
      validateAndCompilePluginRoutes([
        {
          id: 'bad-dup-section',
          name: 'Bad Dup Section Plugin',
          documentation: {
            id: 'bad-dup-docs',
            title: 'Dup Sections',
            summary: 'Duplicate section IDs',
            sections: [
              { id: 'intro', heading: 'Intro 1', markdown: 'First.' },
              { id: 'intro', heading: 'Intro 2', markdown: 'Second.' },
            ],
          },
        },
      ])
    ).toThrow(/Duplicate documentation section id/);

    expect(() =>
      validateAndCompilePluginRoutes([
        {
          id: 'bad-url-plugin',
          name: 'Bad URL Plugin',
          documentation: {
            id: 'bad-url-docs',
            title: 'Unsafe Link',
            summary: 'Uses javascript protocol',
            sections: [{ id: 's1', heading: 'Overview', markdown: 'Hello.' }],
            externalUrl: 'javascript:alert(1)',
          },
        },
      ])
    ).toThrow(RangeError);
  });

  it('enforces admin RBAC on GET /api/admin/docs via createAdminRouteHandler', async () => {
    const service = new AdminDocsService({ plugins: [createPageVisitStatsPlugin({ enabled: true })] });
    const handler = createAdminRouteHandler({} as never, undefined, undefined, undefined, service);

    const adminRes = await handler({
      request: new Request('https://archive.test/api/admin/docs'),
      url: new URL('https://archive.test/api/admin/docs'),
      method: 'GET',
      segments: ['api', 'admin', 'docs'],
      auth: {
        authMethod: 'session',
        bearerRejected: false,
        principal: { kind: 'user', email: 'admin@alder.test', display_name: 'Admin', role: 'admin' },
      },
      telemetry: {} as never,
    } as never);
    expect(adminRes?.status).toBe(200);
    const body = parseAdminDocsResponse(await adminRes?.json());
    expect(body.core_docs.length).toBeGreaterThanOrEqual(5);
    expect(body.plugin_docs).toHaveLength(1);

    await expect(
      handler({
        request: new Request('https://archive.test/api/admin/docs'),
        url: new URL('https://archive.test/api/admin/docs'),
        method: 'GET',
        segments: ['api', 'admin', 'docs'],
        auth: {
          authMethod: 'session',
          bearerRejected: false,
          principal: { kind: 'user', email: 'editor@alder.test', display_name: 'Editor', role: 'editor' },
        },
        telemetry: {} as never,
      } as never)
    ).rejects.toMatchObject({ status: 403 });
  });
});
