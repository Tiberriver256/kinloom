import type { KinloomServerPlugin } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import { createSyntheticSiteConfig } from '../testing/adapterContractSuite.js';
import { createKinloomServer } from './router.js';

const ORIGIN = 'https://alder.example.test';
const SECRET = 'kinloom-plugin-router-secret-2026-abcdef123456';

function jsonPluginHandler(payload: Record<string, unknown>) {
  return async (): Promise<Response> =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

describe('createKinloomServer plugin routing and startup validation', () => {
  it('enforces segment-boundary matching so /api/foo never intercepts /api/foobar and normalizes trailing slashes', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);

    const fooPlugin: KinloomServerPlugin = {
      id: 'foo-plugin',
      name: 'Foo Plugin',
      routes: [
        {
          method: 'GET',
          pathPrefix: '/api/foo/',
          minRole: 'public',
          handle: jsonPluginHandler({ plugin: 'foo' }),
        },
      ],
    };

    const server = createKinloomServer({
      siteConfig,
      ports: { ...ports, plugins: [fooPlugin] },
      sessionSecret: SECRET,
    });

    const exactRes = await server.fetch(new Request(`${ORIGIN}/api/foo`));
    expect(exactRes.status).toBe(200);
    expect(await exactRes.json()).toEqual({ plugin: 'foo' });

    const nestedRes = await server.fetch(new Request(`${ORIGIN}/api/foo/bar`));
    expect(nestedRes.status).toBe(200);
    expect(await nestedRes.json()).toEqual({ plugin: 'foo' });

    const siblingStemRes = await server.fetch(new Request(`${ORIGIN}/api/foobar`));
    expect(siblingStemRes.status).toBe(404);
  });

  it('allows distinct sibling prefixes sharing a stem (/api/foo and /api/foobar) and different methods on nested prefixes', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);

    const pluginA: KinloomServerPlugin = {
      id: 'plugin-foo',
      name: 'Plugin Foo',
      routes: [
        {
          method: 'GET',
          pathPrefix: '/api/foo',
          minRole: 'public',
          handle: jsonPluginHandler({ route: 'foo-get' }),
        },
      ],
    };

    const pluginB: KinloomServerPlugin = {
      id: 'plugin-foobar',
      name: 'Plugin Foobar',
      routes: [
        {
          method: 'GET',
          pathPrefix: '/api/foobar',
          minRole: 'public',
          handle: jsonPluginHandler({ route: 'foobar-get' }),
        },
        {
          method: 'POST',
          pathPrefix: '/api/foo/action',
          minRole: 'public',
          handle: jsonPluginHandler({ route: 'foo-action-post' }),
        },
      ],
    };

    const server = createKinloomServer({
      siteConfig,
      ports: { ...ports, plugins: [pluginA, pluginB] },
      sessionSecret: SECRET,
    });

    expect(await (await server.fetch(new Request(`${ORIGIN}/api/foo`))).json()).toEqual({
      route: 'foo-get',
    });
    expect(await (await server.fetch(new Request(`${ORIGIN}/api/foobar`))).json()).toEqual({
      route: 'foobar-get',
    });
    expect(
      await (
        await server.fetch(
          new Request(`${ORIGIN}/api/foo/action`, { method: 'POST', headers: { origin: ORIGIN } })
        )
      ).json()
    ).toEqual({
      route: 'foo-action-post',
    });
  });

  it('throws at startup on duplicate plugin IDs', () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);

    expect(() =>
      createKinloomServer({
        siteConfig,
        ports: {
          ...ports,
          plugins: [
            { id: 'dup-plugin', name: 'First' },
            { id: ' dup-plugin ', name: 'Second' },
          ],
        },
        sessionSecret: SECRET,
      })
    ).toThrow(/Duplicate server plugin id 'dup-plugin'/);
  });

  it('throws at startup on duplicate route prefixes or prefix shadowing for the same method or wildcard', () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);

    // Exact duplicate after trailing-slash normalization
    expect(() =>
      createKinloomServer({
        siteConfig,
        ports: {
          ...ports,
          plugins: [
            {
              id: 'plugin-1',
              name: 'One',
              routes: [
                {
                  method: 'GET',
                  pathPrefix: '/api/custom/',
                  minRole: 'public',
                  handle: jsonPluginHandler({}),
                },
              ],
            },
            {
              id: 'plugin-2',
              name: 'Two',
              routes: [
                {
                  method: 'get',
                  pathPrefix: '/api/custom',
                  minRole: 'public',
                  handle: jsonPluginHandler({}),
                },
              ],
            },
          ],
        },
        sessionSecret: SECRET,
      })
    ).toThrow(/Conflicting server plugin route/);

    // Prefix shadowing for same HTTP method
    expect(() =>
      createKinloomServer({
        siteConfig,
        ports: {
          ...ports,
          plugins: [
            {
              id: 'plugin-parent',
              name: 'Parent',
              routes: [
                {
                  method: 'GET',
                  pathPrefix: '/api/plugins/stories',
                  minRole: 'public',
                  handle: jsonPluginHandler({}),
                },
              ],
            },
            {
              id: 'plugin-child',
              name: 'Child',
              routes: [
                {
                  method: 'GET',
                  pathPrefix: '/api/plugins/stories/latest',
                  minRole: 'public',
                  handle: jsonPluginHandler({}),
                },
              ],
            },
          ],
        },
        sessionSecret: SECRET,
      })
    ).toThrow(/Conflicting server plugin route/);

    // Wildcard shadowing a specific HTTP method
    expect(() =>
      createKinloomServer({
        siteConfig,
        ports: {
          ...ports,
          plugins: [
            {
              id: 'plugin-wild',
              name: 'Wildcard',
              routes: [
                {
                  method: '*',
                  pathPrefix: '/api/plugins/hooks',
                  minRole: 'public',
                  handle: jsonPluginHandler({}),
                },
              ],
            },
            {
              id: 'plugin-post',
              name: 'Post',
              routes: [
                {
                  method: 'POST',
                  pathPrefix: '/api/plugins/hooks/notify',
                  minRole: 'public',
                  handle: jsonPluginHandler({}),
                },
              ],
            },
          ],
        },
        sessionSecret: SECRET,
      })
    ).toThrow(/Conflicting server plugin route/);
  });

  it('rejects plugin routes that collide with reserved built-in server route prefixes while allowing custom prefixes', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);

    for (const badPrefix of ['/api/bundle', '/api/entities/custom', '/privacy', '/api', '/']) {
      expect(() =>
        createKinloomServer({
          siteConfig,
          ports: {
            ...ports,
            plugins: [
              {
                id: `bad-${badPrefix.replaceAll('/', '_')}`,
                name: 'Reserved Collision Plugin',
                routes: [
                  {
                    method: 'GET',
                    pathPrefix: badPrefix,
                    minRole: 'public',
                    handle: jsonPluginHandler({}),
                  },
                ],
              },
            ],
          },
          sessionSecret: SECRET,
        })
      ).toThrow(RangeError);
    }

    const okServer = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [
          {
            id: 'custom-plugin',
            name: 'Custom Plugin',
            routes: [
              {
                method: 'GET',
                pathPrefix: '/api/custom-plugin',
                minRole: 'public',
                handle: jsonPluginHandler({ ok: true }),
              },
            ],
          },
        ],
      },
      sessionSecret: SECRET,
    });
    const res = await okServer.fetch(new Request(`${ORIGIN}/api/custom-plugin`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
