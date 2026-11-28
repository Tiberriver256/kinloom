/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchiveBundle, KinloomSiteConfig, Place } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { GlobalSearchModal } from '../components/GlobalSearchModal.js';
import { LocalSurveyMap } from '../components/LocalSurveyMap.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import {
  bearingToCardinal,
  boxesOverlap,
  boxIntersectsCircleStroke,
  boxIntersectsSegment,
  computeBearingDegrees,
  computeCenterLabelPlacement,
  computeEdgeBadgeLayouts,
  computeSurveyLabelLayout,
  projectAdaptiveSurveyPlaces,
  type SurveyBox,
} from '../lib/surveyMapLayout.js';
import { PlacePage } from './PlacePage.js';
import { PlacesIndexPage } from './PlacesIndexPage.js';
import { computeOccupancyDecadeTicks } from './place/placeViewModel.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = resolve(HERE, '..');

function makePlace(overrides: Partial<Place> & { id: string; slug: string; name: string }): Place {
  return {
    full_name: `${overrides.name}, Sangamon County, Illinois`,
    place_type: 'town',
    parent_id: null,
    lat: 39.78,
    lng: -89.65,
    ...overrides,
  };
}

const cleanups: Array<() => void> = [];

function mountEl(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe('surveyMapLayout adaptive scale, edge badges, and collision-free labels (#61)', () => {
  it('auto-scales when all neighbors exceed nominal 42 mi radius and emits zero off-canvas markers', () => {
    const center = makePlace({ id: 'pl_center', slug: 'center', name: 'Center', lat: 39.78, lng: -89.65 });
    // ~75 miles north (1.09 deg lat) and ~320 miles northeast (outside auto-scale cap)
    const distantNorth = makePlace({
      id: 'pl_north75',
      slug: 'north-75',
      name: 'Peoria',
      lat: 40.87,
      lng: -89.65,
    });
    const farEast = makePlace({
      id: 'pl_far',
      slug: 'far-east',
      name: 'Cleveland',
      lat: 41.49,
      lng: -81.69,
    });

    const projection = projectAdaptiveSurveyPlaces({
      center,
      allPlaces: [center, distantNorth, farEast],
      width: 720,
      height: 200,
      maxRadiusMiles: 42,
      highlightRadiusMiles: 15,
    });

    expect(projection.didAutoScale).toBe(true);
    expect(projection.effectiveMaxRadiusMiles).toBeGreaterThan(42);
    expect(projection.effectiveMaxRadiusMiles).toBeLessThanOrEqual(250);
    expect(projection.inBoundsMarkers.map((m) => m.place.id)).toEqual(['pl_north75']);

    for (const marker of projection.inBoundsMarkers) {
      expect(marker.x).toBeGreaterThanOrEqual(14);
      expect(marker.x).toBeLessThanOrEqual(720 - 14);
      expect(marker.y).toBeGreaterThanOrEqual(14);
      expect(marker.y).toBeLessThanOrEqual(200 - 14);
    }
  });

  it('partitions due-north out-of-bounds neighbors into clamped compass-edge indicators instead of off-canvas rays', () => {
    const center = makePlace({ id: 'pl_center', slug: 'center', name: 'Center', lat: 39.78, lng: -89.65 });
    const nearbyEast = makePlace({
      id: 'pl_near',
      slug: 'near',
      name: 'Riverton',
      lat: 39.84,
      lng: -89.54,
    });
    // 90 miles due north: would overflow y < 0 at 42mi nominal height, must become an edge indicator
    const ninetyNorth = makePlace({
      id: 'pl_north90',
      slug: 'north-90',
      name: 'LaSalle',
      lat: 41.08,
      lng: -89.65,
    });
    const isolatedFar = makePlace({
      id: 'pl_far_only',
      slug: 'far-only',
      name: 'Boston',
      lat: 42.36,
      lng: -71.06,
    });

    const projection = projectAdaptiveSurveyPlaces({
      center,
      allPlaces: [center, nearbyEast, ninetyNorth],
      width: 720,
      height: 200,
      maxRadiusMiles: 42,
      highlightRadiusMiles: 15,
    });

    expect(projection.didAutoScale).toBe(false);
    expect(projection.inBoundsMarkers.map((m) => m.place.id)).toEqual(['pl_near']);
    expect(projection.edgeIndicators.map((e) => e.place.id)).toEqual(['pl_north90']);
    expect(projection.edgeIndicators[0]?.cardinal).toBe('N');
    expect(projection.edgeIndicators[0]?.arrow).toBe('↑');
    expect(projection.edgeIndicators[0]?.edgeY).toBeGreaterThanOrEqual(18);
    expect(projection.edgeIndicators[0]?.edgeY).toBeLessThanOrEqual(200 - 18);

    // When all neighbors exceed 250mi auto-scale cap, isolated center still shows edge indicators
    const isolatedProj = projectAdaptiveSurveyPlaces({
      center,
      allPlaces: [center, isolatedFar],
      width: 720,
      height: 200,
      maxRadiusMiles: 42,
      highlightRadiusMiles: 15,
    });
    expect(isolatedProj.inBoundsMarkers).toHaveLength(0);
    expect(isolatedProj.edgeIndicators.map((e) => e.place.id)).toEqual(['pl_far_only']);
    expect(isolatedProj.edgeIndicators[0]?.cardinal).toBe('E');
  });

  it('places dense county cluster labels without overlapping any label, dot, center badge, or compass rose', () => {
    const center = makePlace({
      id: 'pl_center',
      slug: 'center',
      name: 'Springfield',
      lat: 39.78,
      lng: -89.65,
    });
    const cluster: Place[] = [
      center,
      makePlace({ id: 'pl_1', slug: 'p1', name: 'Chatham', lat: 39.68, lng: -89.7 }),
      makePlace({ id: 'pl_2', slug: 'p2', name: 'Riverton', lat: 39.84, lng: -89.54 }),
      makePlace({ id: 'pl_3', slug: 'p3', name: 'Sherman', lat: 39.89, lng: -89.6 }),
      makePlace({ id: 'pl_4', slug: 'p4', name: 'Rochester', lat: 39.75, lng: -89.53 }),
      makePlace({ id: 'pl_5', slug: 'p5', name: 'Pleasant Plains', lat: 39.87, lng: -89.92 }),
      makePlace({ id: 'pl_6', slug: 'p6', name: 'Auburn', lat: 39.59, lng: -89.74 }),
      makePlace({ id: 'pl_7', slug: 'p7', name: 'Williamsville', lat: 39.96, lng: -89.54 }),
    ];

    const width = 720;
    const height = 200;
    const cx = width / 2;
    const cy = height / 2;
    const radiusPx = Math.min((height - 20) * 0.44, (15 / 42) * ((height - 20) / 2));
    const compassBox: SurveyBox = { x1: width - 34, x2: width - 2, y1: 2, y2: 34 };

    const proj = projectAdaptiveSurveyPlaces({
      center,
      allPlaces: cluster,
      width,
      height,
      maxRadiusMiles: 42,
      highlightRadiusMiles: 15,
    });
    const edgeLayouts = computeEdgeBadgeLayouts({
      edgeIndicators: proj.edgeIndicators,
      width,
      height,
      fontSize: 10.5,
      compassBox,
    });
    const edgeBoxes = edgeLayouts.map((b) => b.box);
    const centerPlacement = computeCenterLabelPlacement({
      centerName: center.name,
      markers: proj.inBoundsMarkers,
      edgeBadgeBoxes: edgeBoxes,
      compassBox,
      cx,
      cy,
      width,
      height,
      compact: false,
      isNarrow: false,
      scopeMode: 'radius15',
      radiusPx,
    });
    const labels = computeSurveyLabelLayout({
      markers: proj.inBoundsMarkers,
      centerPlacement,
      edgeBadgeBoxes: edgeBoxes,
      compassBox,
      cx,
      cy,
      width,
      height,
      compact: false,
      isNarrow: false,
      scopeMode: 'radius15',
      radiusPx,
    });

    const placedList = [...labels.values()];
    expect(placedList.length).toBeGreaterThanOrEqual(4);

    // Pairwise zero overlap between all placed labels
    for (let i = 0; i < placedList.length; i += 1) {
      const a = placedList[i];
      expect(a.box.x1).toBeGreaterThanOrEqual(8);
      expect(a.box.x2).toBeLessThanOrEqual(width - 8);
      expect(a.box.y1).toBeGreaterThanOrEqual(8);
      expect(a.box.y2).toBeLessThanOrEqual(height - 6);
      expect(boxesOverlap(a.box, compassBox)).toBe(false);
      expect(boxesOverlap(a.box, centerPlacement.box)).toBe(false);

      for (const m of proj.inBoundsMarkers) {
        const dotBox: SurveyBox = { x1: m.x - 7, x2: m.x + 7, y1: m.y - 7, y2: m.y + 7 };
        expect(boxesOverlap(a.box, dotBox)).toBe(false);
      }
      for (let j = i + 1; j < placedList.length; j += 1) {
        expect(boxesOverlap(a.box, placedList[j].box)).toBe(false);
      }
    }
  });

  it('verifies geometry primitives for circle stroke, segment intersection, and cardinal bearings', () => {
    expect(boxIntersectsCircleStroke({ x1: 95, x2: 105, y1: 45, y2: 55 }, 100, 100, 50, 3)).toBe(true);
    expect(boxIntersectsCircleStroke({ x1: 90, x2: 110, y1: 90, y2: 110 }, 100, 100, 50, 3)).toBe(false);
    expect(boxIntersectsCircleStroke({ x1: 200, x2: 220, y1: 200, y2: 220 }, 100, 100, 50, 3)).toBe(false);

    expect(boxIntersectsSegment({ x1: 40, x2: 60, y1: 40, y2: 60 }, 0, 0, 100, 100)).toBe(true);
    expect(boxIntersectsSegment({ x1: 40, x2: 60, y1: 40, y2: 60 }, 0, 10, 100, 10)).toBe(false);

    const northDeg = computeBearingDegrees(40, -89, 41, -89);
    expect(bearingToCardinal(northDeg)).toEqual({ cardinal: 'N', arrow: '↑' });
    const southWestDeg = computeBearingDegrees(40, -89, 39, -90);
    expect(bearingToCardinal(southWestDeg)).toEqual({ cardinal: 'SW', arrow: '↙' });
  });

  it('renders LocalSurveyMap auto-scale caption and interactive compass-edge badge', () => {
    const center = makePlace({ id: 'pl_center', slug: 'center', name: 'Center', lat: 39.78, lng: -89.65 });
    const distant = makePlace({
      id: 'pl_dist',
      slug: 'distant-town',
      name: 'Lexington',
      lat: 38.04,
      lng: -84.5,
    });
    const container = mountEl(
      <MemoryRouter initialEntries={['/place/center']}>
        <Routes>
          <Route
            path="/place/center"
            element={<LocalSurveyMap center={center} allPlaces={[center, distant]} scopeMode="radius15" />}
          />
          <Route path="/place/distant-town" element={<div data-testid="arrived">Arrived Lexington</div>} />
        </Routes>
      </MemoryRouter>
    );

    const badge = container.querySelector<SVGGElement>('.survey-edge-badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('Lexington');

    act(() => {
      badge?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(container.textContent).toContain('Arrived Lexington');
  });
});

describe('PlacesIndexPage Grid alignment and mobile era filter (#61)', () => {
  it('uses minmax(0, 1fr) auto Grid header, unspaced en-dash spans, and mobile era select for >6 eras', () => {
    const placesCss = readFileSync(resolve(UI_SRC, 'pages/PlacesIndexPage.module.css'), 'utf8');
    expect(placesCss).toContain('grid-template-columns: minmax(0, 1fr) auto;');
    expect(placesCss).toContain('flex-wrap: nowrap;');
    expect(placesCss).toContain('flex-shrink: 0;');
    expect(placesCss).toContain('white-space: nowrap;');

    const manyEras = Array.from({ length: 7 }, (_, i) => ({
      id: `era_${i}`,
      label: `Migration Era ${i + 1}`,
      color: '#7A4612',
      minLat: 30 + i * 2,
      maxLat: 31.9 + i * 2,
    }));

    const siteConfig: KinloomSiteConfig = parseKinloomConfig({
      site: { title: 'Alder Synthetic Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_TEST' },
      migrationEras: manyEras,
    });

    const places: Place[] = manyEras.map((_era, i) =>
      makePlace({
        id: `pl_${i}`,
        slug: `town-${i}`,
        name: `Town ${i + 1}`,
        full_name: `Town ${i + 1}, Long Historical County Subdivision Name, Illinois`,
        lat: 30.5 + i * 2,
        lng: -89.65,
      })
    );

    const { bundle }: { bundle: ArchiveBundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places,
      sources: [{ id: 'src_1', citation: '1880 Census', source_type: 'census', has_primary_source: true }],
      people: [
        {
          id: 'per_a',
          slug: 'clara-alder',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1850',
          death_edtf: '1920',
          portrait_url: null,
        },
      ],
      events: [
        ...places.map((pl, i) => ({
          id: `evt_a_${i}`,
          title: `Resided in ${pl.name}`,
          summary: `Recorded in ${pl.name}.`,
          event_kind: 'residence_anchor' as const,
          scope: 'family' as const,
          edtf_date: '1855',
          place_id: pl.id,
          participants: [{ person_id: 'per_a', role: 'head' }],
          sources: [{ source_id: 'src_1', confidence: 'high' as const }],
        })),
        {
          id: 'evt_b_0',
          title: 'Later stay in Town 1',
          summary: 'Recorded later.',
          event_kind: 'residence_anchor',
          scope: 'family',
          edtf_date: '1880',
          place_id: 'pl_0',
          participants: [{ person_id: 'per_a', role: 'head' }],
          sources: [{ source_id: 'src_1', confidence: 'high' }],
        },
      ],
      kinship: [],
    });

    const container = mountEl(
      <MemoryRouter initialEntries={['/places']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <PlacesIndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    // Unspaced en-dash in place-ledger-span
    expect(container.textContent).toContain('1855–1880');
    expect(container.textContent).not.toContain('1855 – 1880');

    // Competing migration-stage select is removed and Jump Strip is gated for <= 25 places (#95)
    expect(container.querySelector('select[aria-label="Filter places by migration region"]')).toBeNull();
    expect(container.querySelector('nav[aria-label="Jump to places section"]')).toBeNull();
  });
});

describe('PlacePage Front Door header, Gantt decade hairlines, empty Local History hiding, and Not Found CTA (#61)', () => {
  it('computes 10-year, 20-year, and 50-year occupancy decade ticks cleanly', () => {
    expect(computeOccupancyDecadeTicks(1855, 1905)).toEqual([1860, 1870, 1880, 1890, 1900]);
    expect(computeOccupancyDecadeTicks(1780, 1960)).toEqual([
      1780, 1800, 1820, 1840, 1860, 1880, 1900, 1920, 1940, 1960,
    ]);
    expect(computeOccupancyDecadeTicks(1650, 1950)).toEqual([1650, 1700, 1750, 1800, 1850, 1900, 1950]);
    expect(computeOccupancyDecadeTicks(1900, 1900)).toEqual([]);
  });

  it('renders breadcrumb, Front Door summary, Gantt hairlines, hides empty Local History, and opens Search on Place Not Found', () => {
    const siteConfig = parseKinloomConfig({
      site: { title: 'Alder Synthetic Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_TEST' },
    });
    const { bundle } = compileArchive({
      siteConfig,
      mode: 'public',
      places: [
        makePlace({
          id: 'pl_springfield',
          slug: 'springfield',
          name: 'Springfield',
          lat: 39.78,
          lng: -89.65,
        }),
      ],
      sources: [{ id: 'src_1', citation: '1860 Census', source_type: 'census', has_primary_source: true }],
      people: [
        {
          id: 'per_a',
          slug: 'clara-alder',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1835',
          death_edtf: '1905',
          portrait_url: null,
        },
      ],
      events: [
        {
          id: 'evt_1850',
          title: 'Early stay',
          summary: 'Lived in Springfield.',
          event_kind: 'residence_anchor',
          scope: 'family',
          edtf_date: '1850',
          place_id: 'pl_springfield',
          participants: [{ person_id: 'per_a', role: 'head' }],
          sources: [{ source_id: 'src_1', confidence: 'high' }],
        },
        {
          id: 'evt_1880',
          title: 'Later stay',
          summary: 'Still in Springfield.',
          event_kind: 'residence_anchor',
          scope: 'family',
          edtf_date: '1880',
          place_id: 'pl_springfield',
          participants: [{ person_id: 'per_a', role: 'head' }],
          sources: [{ source_id: 'src_1', confidence: 'high' }],
        },
      ],
      kinship: [],
    });

    const pageEl = mountEl(
      <MemoryRouter initialEntries={['/place/springfield']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );

    const breadcrumb = pageEl.querySelector('nav[aria-label="Breadcrumb"]');
    expect(breadcrumb).not.toBeNull();
    expect(breadcrumb?.textContent).toContain('Places');
    expect(breadcrumb?.textContent).toContain('Springfield');

    expect(pageEl.textContent).toContain('1 relative · 1850–1880');
    // Unspaced en-dash on Who Passed Through header
    expect(pageEl.textContent).not.toContain('1850 — 1880');

    // Gantt decade ticks and hairlines rendered
    const hairlines = pageEl.querySelectorAll('[class*="occupancy-decade-hairline"]');
    expect(hairlines.length).toBe(4); // 1850, 1860, 1870, 1880

    // Empty Local History section is hidden when count is 0
    expect(pageEl.textContent).not.toContain('Local History');

    // Place Not Found recovery CTA opens global search modal
    const notFoundEl = mountEl(
      <MemoryRouter initialEntries={['/place/missing-place']}>
        <ArchiveProvider siteConfig={siteConfig} initialBundle={bundle}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
          <GlobalSearchModal />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(notFoundEl.textContent).toContain('Place Not Found');
    const searchBtn = [...notFoundEl.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Search archive')
    );
    expect(searchBtn).not.toBeNull();
    act(() => {
      searchBtn?.click();
    });
    expect(notFoundEl.querySelector('dialog[aria-label="Search archive"]')).not.toBeNull();
  });
});
