import { describe, expect, it } from 'vitest';
import { BundleReadService } from '../services/bundleReadService.js';
import { WikiWriteService } from '../services/wikiWriteService.js';
import {
  createSyntheticHistoricalPerson,
  createSyntheticSiteConfig,
  runBackendAdapterContractTests,
} from '../testing/adapterContractSuite.js';
import { GoogleOAuthProvider } from './googleOAuthProvider.js';
import { createInMemoryServerPorts } from './inMemory.js';
import { FixedClock, SystemClock } from './systemClock.js';

runBackendAdapterContractTests('InMemory Reference Adapters', (siteConfig) => {
  const ports = createInMemoryServerPorts(siteConfig);
  return {
    siteConfig,
    ports,
  };
});

describe('Portable built-in adapters', () => {
  it('GoogleOAuthProvider builds PKCE authorization URL and exchanges code via standard fetch', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const provider = new GoogleOAuthProvider({
      clientId: 'client-123',
      clientSecret: 'secret-456',
      fetchFn: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        requests.push({ url, method: init?.method ?? 'GET' });
        if (url.includes('/token')) {
          return new Response(JSON.stringify({ access_token: 'temp-access-token' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            email: 'Clara.Alder@Example.Test',
            email_verified: true,
            name: 'Clara Alder',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    const authUrl = new URL(
      provider.buildAuthorizationUrl({
        state: 'state_abc',
        codeChallenge: 'challenge_xyz',
        redirectUri: 'https://archive.example.test/api/auth/google/callback',
      })
    );
    expect(authUrl.origin).toBe('https://accounts.google.com');
    expect(authUrl.searchParams.get('code_challenge')).toBe('challenge_xyz');
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('state')).toBe('state_abc');

    const profile = await provider.exchangeCode({
      code: 'auth_code_1',
      codeVerifier: 'verifier_123',
      redirectUri: 'https://archive.example.test/api/auth/google/callback',
    });
    expect(profile).toEqual({
      email: 'clara.alder@example.test',
      displayName: 'Clara Alder',
      emailVerified: true,
    });
    expect(requests.map((r) => r.method)).toEqual(['POST', 'GET']);
  });

  it('uses incremental patchCompiledBundle on warm cache and falls back to rebuild on cache miss', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const writer = new WikiWriteService({
      repository: ports.repository,
      bundleCache: ports.bundleCache,
      clock: ports.clock,
      siteConfig,
    });

    const author = {
      author_id: 'admin@example.test',
      author_name: 'Archive Admin',
      author_type: 'human' as const,
    };

    // Cold write #1 triggers rebuildAndStore because cache is empty
    const p1 = createSyntheticHistoricalPerson({ id: 'per_inc_1', slug: 'inc-one' });
    await writer.createEntity({
      entityType: 'person',
      entityId: p1.id,
      data: p1,
      summary: 'Seed first person',
      hasPrimarySource: true,
      author,
    });
    expect(ports.bundleCache.rebuildCount).toBe(1);
    expect(ports.bundleCache.incrementalPatchCount).toBe(0);

    // Warm write #2 uses applyMutationsAndStore (incremental patch!)
    const p2 = createSyntheticHistoricalPerson({
      id: 'per_inc_2',
      slug: 'inc-two',
      full_name: 'Hannah Alder',
      given_name: 'Hannah',
    });
    await writer.createEntity({
      entityType: 'person',
      entityId: p2.id,
      data: p2,
      summary: 'Add second person incrementally',
      hasPrimarySource: true,
      author,
    });
    expect(ports.bundleCache.rebuildCount).toBe(1);
    expect(ports.bundleCache.incrementalPatchCount).toBe(1);

    // Invalidating cache forces automatic fallback to rebuildAndStore on write #3
    ports.bundleCache.invalidate();
    const p3 = createSyntheticHistoricalPerson({
      id: 'per_inc_3',
      slug: 'inc-three',
      full_name: 'Owen Alder',
      given_name: 'Owen',
    });
    await writer.createEntity({
      entityType: 'person',
      entityId: p3.id,
      data: p3,
      summary: 'Add third person after cache miss',
      hasPrimarySource: true,
      author,
    });
    expect(ports.bundleCache.rebuildCount).toBe(2);
    expect(ports.bundleCache.incrementalPatchCount).toBe(1);
  });

  it('SystemClock and FixedClock return valid timestamps', () => {
    const sys = new SystemClock();
    expect(sys.currentYear()).toBeGreaterThanOrEqual(2024);
    expect(Number.isNaN(Date.parse(sys.nowIso()))).toBe(false);

    const fixed = new FixedClock('2026-03-15T10:00:00.000Z');
    expect(fixed.currentYear()).toBe(2026);
    fixed.advanceMs(30_000);
    expect(fixed.nowIso()).toBe('2026-03-15T10:00:30.000Z');
    fixed.setIso('2027-01-01T00:00:00.000Z');
    expect(fixed.currentYear()).toBe(2027);
  });

  it('InMemoryMediaStore skips duplicate put when MediaService deduplicates identical SHA-256 content', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const writer = new WikiWriteService({
      repository: ports.repository,
      bundleCache: ports.bundleCache,
      clock: ports.clock,
      siteConfig,
    });
    const { MediaService } = await import('../services/mediaService.js');
    const mediaService = new MediaService({
      repository: ports.repository,
      mediaStore: ports.mediaStore,
      wikiWriteService: writer,
      siteConfig,
    });

    const author = {
      author_id: 'admin@example.test',
      author_name: 'Archive Admin',
      author_type: 'human' as const,
    };
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const first = await mediaService.uploadMedia({
      bytes,
      contentType: 'image/jpeg',
      metadata: { id: 'med_dedup_1', kind: 'family_photo', caption: 'First scan' },
      summary: 'Upload first scan',
      author,
    });
    const second = await mediaService.uploadMedia({
      bytes,
      contentType: 'image/jpeg',
      metadata: { id: 'med_dedup_2', kind: 'family_photo', caption: 'Second reference' },
      summary: 'Upload identical scan',
      author,
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(first.url).toBe(second.url);
    expect(ports.mediaStore.putCount).toBe(1);
  });

  it('guards InMemoryIncrementalBundleCache against lower-revision overwrites and heals stale cache hits in BundleReadService', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const writer = new WikiWriteService({
      repository: ports.repository,
      bundleCache: ports.bundleCache,
      clock: ports.clock,
      siteConfig,
    });
    const reader = new BundleReadService({
      repository: ports.repository,
      bundleCache: ports.bundleCache,
      clock: ports.clock,
      siteConfig,
    });
    const author = {
      author_id: 'admin@example.test',
      author_name: 'Archive Admin',
      author_type: 'human' as const,
    };

    const p1 = createSyntheticHistoricalPerson({ id: 'per_stale_1', slug: 'stale-one' });
    await writer.createEntity({
      entityType: 'person',
      entityId: p1.id,
      data: p1,
      summary: 'Create person 1',
      hasPrimarySource: true,
      author,
    });
    const snapshotRev1 = await ports.repository.loadActiveSnapshot();
    const rev1Etag = await ports.bundleCache.getCached(null);
    expect(rev1Etag.status).toBe('hit');
    const staleEtag = rev1Etag.status === 'hit' ? rev1Etag.object.etag : '';

    // Write rev 2 directly to repository without updating bundleCache -> cache is now stale at rev 1
    const p2 = createSyntheticHistoricalPerson({
      id: 'per_stale_2',
      slug: 'stale-two',
      full_name: 'Hannah Alder',
      given_name: 'Hannah',
    });
    const commit2 = await ports.repository.commitAtomicMutations({
      batch_id: null,
      author,
      nowIso: ports.clock.nowIso(),
      operations: [
        {
          entity_type: 'person',
          entity_id: p2.id,
          slug: p2.slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Commit person 2 directly',
          has_primary_source: true,
          before_json: null,
          after_json: p2 as unknown as Record<string, unknown>,
        },
      ],
    });
    expect(commit2.kind).toBe('committed');

    // Even with If-None-Match matching the stale rev 1 ETag, BundleReadService must detect head=2 and rebuild
    const healed = await reader.getBundle({ ifNoneMatch: staleEtag });
    expect(healed.status).toBe('hit');
    if (healed.status === 'hit') {
      expect(healed.object.revision_id).toBe(2);
      expect(healed.object.etag).toBe('"r2"');
    }

    // Attempting to store an older snapshot (rev 1) over rev 2 must NOT downgrade the cache
    const outOfOrder = await ports.bundleCache.rebuildAndStore(snapshotRev1);
    expect(outOfOrder.revision_id).toBe(2);
    const afterOutOfOrder = await ports.bundleCache.getCached(null);
    expect(afterOutOfOrder.status).toBe('hit');
    if (afterOutOfOrder.status === 'hit') {
      expect(afterOutOfOrder.object.revision_id).toBe(2);
    }
  });
});
