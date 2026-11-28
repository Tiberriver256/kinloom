import assert from 'node:assert/strict';
import type { StyleSpecification } from 'maplibre-gl';
import { describe, test } from 'vitest';
import {
  buildArchivalOhmStyle,
  buildEventQueryUrl,
  CHUNK_RELOAD_STORAGE_KEY,
  clampPan,
  clampZoom,
  computeDoubleTapZoom,
  computePinchTransform,
  computeWheelTargetZoom,
  computeZoomAroundPoint,
  formatPhotoDocumentCount,
  formatPronunciationScopePrefix,
  formatPronunciationScopeTitle,
  isChunkLoadError,
  isSearchableQuery,
  KINLOOM_VOCABULARY,
  loadArchivalOhmStyle,
  PAPER_LAND_LAYER_ID,
  pickActiveTimelineEventId,
  readerNextPage,
  readerPrevPage,
  reportClientError,
  resetCachedOhmStyle,
  resolveReaderPageIndex,
  sanitizeReport,
  sanitizeRoute,
  scrollTargetForNavigation,
  searchNavNext,
  searchNavPrev,
  searchNavReset,
  shouldAttemptChunkReload,
  shouldRunInitialEventScroll,
  stepInertia,
} from '../index.js';

describe('ohmStyle', () => {
  test('prunes non-archival layers, rewrites land layer to kinloom-paper-land, and preserves date state', () => {
    const raw: StyleSpecification = {
      version: 8,
      sources: {
        osm_land: { type: 'vector', url: 'https://example.test/land' },
        ohm: { type: 'vector', url: 'https://example.test/ohm' },
        ohm_landcover_hillshade: { type: 'raster', url: 'https://example.test/hillshade' },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#eee' } },
        { id: 'land', type: 'fill', source: 'osm_land', 'source-layer': 'land' },
        { id: 'ohm_landcover_hillshade', type: 'raster', source: 'ohm_landcover_hillshade' },
        { id: 'modern_poi', type: 'symbol', source: 'ohm', 'source-layer': 'pois', minzoom: 14 },
        {
          id: 'place_label',
          type: 'symbol',
          source: 'ohm',
          'source-layer': 'populated_places',
          layout: {
            'text-field': ['get', 'name'],
            'text-font': ['OpenHistorical Italic'],
          },
        },
      ],
    };

    const styled = buildArchivalOhmStyle(raw, '1860');
    assert.equal('ohm_landcover_hillshade' in styled.sources, false);
    const layerIds = styled.layers.map((l) => l.id);
    assert.deepEqual(layerIds, ['bg', PAPER_LAND_LAYER_ID, 'place_label']);
    assert.equal(PAPER_LAND_LAYER_ID, 'kinloom-paper-land');
    const labelLayer = styled.layers[2];
    assert.ok(labelLayer);
    assert.equal(labelLayer.type, 'symbol');
    if (labelLayer.type === 'symbol') {
      assert.deepEqual(labelLayer.layout?.['text-field'], ['coalesce', ['get', 'name_en'], ['get', 'name']]);
      assert.deepEqual(labelLayer.layout?.['text-font'], ['OpenHistorical']);
    }
  });

  test('loadArchivalOhmStyle rejects malformed style JSON and clears failed cache entries', async () => {
    resetCachedOhmStyle();
    const malformedPayloads: unknown[] = [
      null,
      [],
      { version: 7, sources: {}, layers: [] },
      { version: 8, sources: null, layers: [] },
      { version: 8, sources: {}, layers: 'not-an-array' },
      { version: 8, sources: {}, layers: [{ id: 'bg' }] },
    ];

    for (const payload of malformedPayloads) {
      const badFetch = async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      await assert.rejects(
        () => loadArchivalOhmStyle('1900', badFetch as unknown as typeof fetch),
        /Invalid MapLibre style JSON/
      );
    }

    const validFetch = async () =>
      new Response(
        JSON.stringify({
          version: 8,
          sources: { ohm: { type: 'vector', url: 'https://example.test/ohm' } },
          layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eee' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    const loaded = await loadArchivalOhmStyle('1900', validFetch as unknown as typeof fetch);
    assert.equal(loaded.version, 8);
    assert.deepEqual(
      loaded.layers.map((layer) => layer.id),
      ['bg']
    );
    resetCachedOhmStyle();
  });
});

describe('scrollMemory, searchNavigation, sourceReaderNav', () => {
  test('scrollTargetForNavigation restores saved Y only on POP', () => {
    assert.equal(scrollTargetForNavigation('POP', 420), 420);
    assert.equal(scrollTargetForNavigation('PUSH', 420), 0);
    assert.equal(scrollTargetForNavigation('REPLACE', 420), 0);
  });

  test('search navigation clamps bounds cleanly', () => {
    assert.equal(isSearchableQuery(' a '), false);
    assert.equal(isSearchableQuery('ab'), true);
    assert.equal(searchNavNext(0, 3), 1);
    assert.equal(searchNavNext(2, 3), 2);
    assert.equal(searchNavNext(0, 0), 0);
    assert.equal(searchNavPrev(0), 0);
    assert.equal(searchNavPrev(2), 1);
    assert.equal(searchNavReset(), 0);
  });

  test('source reader navigation clamps pages and resolves missing page to 0', () => {
    assert.equal(readerNextPage(0, 3), 1);
    assert.equal(readerNextPage(2, 3), 2);
    assert.equal(readerPrevPage(0), 0);
    assert.equal(resolveReaderPageIndex([{ page: 1 }, { page: 5 }], 5), 1);
    assert.equal(resolveReaderPageIndex([{ page: 1 }, { page: 5 }], 99), 0);
  });
});

describe('timelineScroll', () => {
  const cards = [
    { id: 'e1', top: 100, bottom: 250 },
    { id: 'e2', top: 270, bottom: 420 },
    { id: 'e3', top: 440, bottom: 600 },
  ];

  test('selects first card at top, spanning card in middle, last card at bottom', () => {
    assert.equal(pickActiveTimelineEventId(cards, { anchorY: 200, scrollY: 0, maxScrollY: 1000 }), 'e1');
    assert.equal(pickActiveTimelineEventId(cards, { anchorY: 320, scrollY: 300, maxScrollY: 1000 }), 'e2');
    assert.equal(pickActiveTimelineEventId(cards, { anchorY: 200, scrollY: 998, maxScrollY: 1000 }), 'e3');
  });

  test('deep-link initial scroll guard and query URL builder work predictably', () => {
    assert.equal(
      shouldRunInitialEventScroll({
        navKey: 'p:1',
        completedNavKey: null,
        targetEventId: 'e2',
        eventIds: ['e1', 'e2'],
      }),
      true
    );
    assert.equal(
      shouldRunInitialEventScroll({
        navKey: 'p:1',
        completedNavKey: 'p:1',
        targetEventId: 'e2',
        eventIds: ['e1', 'e2'],
      }),
      false
    );
    assert.equal(
      buildEventQueryUrl('https://archive.test/person/lincoln?from=home', 'e2'),
      '/person/lincoln?from=home&event=e2'
    );
    assert.equal(buildEventQueryUrl('https://archive.test/person/lincoln?event=e2', 'e2'), null);
  });
});

describe('treeGestures', () => {
  test('zoom, pinch, clampPan, double-tap, and inertia behave monotonically', () => {
    assert.equal(clampZoom(10), 2.2);
    assert.equal(clampZoom(0.01), 0.22);

    const zoomed = computeZoomAroundPoint({
      currentPan: { x: 0, y: 0 },
      currentZoom: 1,
      targetZoom: 2,
      focalPoint: { x: 100, y: 50 },
    });
    assert.equal(zoomed.zoom, 2);
    assert.deepEqual(zoomed.pan, { x: -100, y: -50 });

    const pinched = computePinchTransform({
      startDist: 100,
      currentDist: 150,
      startZoom: 1,
      startPan: { x: 0, y: 0 },
      startMidpoint: { x: 200, y: 200 },
      currentMidpoint: { x: 220, y: 200 },
    });
    assert.equal(pinched.zoom, 1.5);
    assert.equal(pinched.pan.x, -80);

    assert.ok(computeWheelTargetZoom(1, -100, false) > 1);
    assert.ok(computeDoubleTapZoom(0.5, 0.5) > 0.5);
    assert.equal(computeDoubleTapZoom(1.5, 0.5), 0.5);

    const clamped = clampPan(
      { x: 99_999, y: -99_999 },
      1,
      { minX: 0, maxX: 500, minY: 0, maxY: 400 },
      { width: 800, height: 600 }
    );
    assert.ok(clamped.x < 99_999);
    assert.ok(clamped.y > -99_999);

    const step = stepInertia({ pan: { x: 0, y: 0 }, vx: 0.5, vy: 0 }, 16);
    assert.equal(step.done, false);
    assert.ok(step.next.pan.x > 0);
    assert.ok(step.next.vx < 0.5);
  });
});

describe('clientTelemetry', () => {
  test('detects chunk errors, enforces reload cooldown, and strips sensitive tokens from routes', () => {
    assert.equal(isChunkLoadError(new Error('Failed to fetch dynamically imported module')), true);
    assert.equal(isChunkLoadError(new Error('Regular error')), false);

    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
    assert.equal(shouldAttemptChunkReload(storage, 1_000_000), true);
    assert.equal(store.get(CHUNK_RELOAD_STORAGE_KEY), '1000000');
    assert.equal(shouldAttemptChunkReload(storage, 1_010_000), false);
    assert.equal(shouldAttemptChunkReload(storage, 1_070_000), true);

    assert.equal(
      sanitizeRoute('/invite/secret-token-123?event=e1&token=leak'),
      '/invite/[redacted]?event=e1'
    );
    const report = sanitizeReport({
      kind: 'react_boundary',
      message: 'Boom',
      route: '/person/abraham-lincoln-1809?event=e1&secret=xyz',
    });
    assert.equal(report.route, '/person/abraham-lincoln-1809?event=e1');

    // Default reportClientError emits no network call; injectable transport receives sanitized payload.
    const received: string[] = [];
    reportClientError({ kind: 'window_error', message: 'Opt-in test error', route: '/tree' });
    assert.equal(received.length, 0);
    reportClientError(
      { kind: 'window_error', message: 'Opt-in test error', route: '/tree' },
      { transport: (payload) => received.push(payload) }
    );
    assert.equal(received.length, 1);
    assert.ok(received[0]?.includes('Opt-in test error'));
  });
});

describe('canonical UI vocabulary helpers', () => {
  test('exposes canonical labels and formats pronunciation scope prefixes and photo/document counts', () => {
    assert.equal(KINLOOM_VOCABULARY.tree.directLine, 'Direct Line');
    assert.equal(KINLOOM_VOCABULARY.tree.diedYoung, 'Died young');
    assert.equal(KINLOOM_VOCABULARY.nav.sources, 'Reading Room');

    assert.equal(formatPronunciationScopePrefix('full'), undefined);
    assert.equal(formatPronunciationScopePrefix('surname'), 'Surname');
    assert.equal(formatPronunciationScopePrefix('partial'), 'Partial');
    assert.equal(formatPronunciationScopeTitle('full', 'Lincoln'), undefined);
    assert.equal(formatPronunciationScopeTitle('surname', 'Lincoln'), 'Surname pronunciation only (Lincoln)');

    assert.equal(formatPhotoDocumentCount(1), '1 photo or document');
    assert.equal(formatPhotoDocumentCount(4), '4 photos & documents');
  });
});
