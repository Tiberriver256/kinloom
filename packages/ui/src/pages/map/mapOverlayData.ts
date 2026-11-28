import type { MapDefaultsConfig, MigrationSegment, MigrationStop, Place } from '@kinloom/core';
import { computeStopsBounds } from '@kinloom/core';
import type { Feature, FeatureCollection } from 'geojson';
import { KINLOOM_COLOR_TOKENS } from '../../lib/tokens.js';

export const SOURCE_ID = 'kinloom-migration';
export const STOP_LAYER_ID = 'migration-stops';

export const FALLBACK_ERA_COLORS = [
  KINLOOM_COLOR_TOKENS.archivalIndigo,
  KINLOOM_COLOR_TOKENS.pineMoss,
  KINLOOM_COLOR_TOKENS.loomOchre,
  KINLOOM_COLOR_TOKENS.sealCrimson,
  KINLOOM_COLOR_TOKENS.cobaltInk,
  KINLOOM_COLOR_TOKENS.warmSepia,
] as const;

export type HistoricalMapStatus = { kind: 'pending' } | { kind: 'ready' } | { kind: 'failed' };

export function normalizeLongitude(lng: number): number {
  if (lng >= -180 && lng <= 180) {
    return lng;
  }
  const wrapped = ((((lng + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && lng > 0 ? 180 : wrapped;
}

export function unwrapSegmentLongitudes(startLng: number, endLng: number): readonly [number, number] {
  const start = normalizeLongitude(startLng);
  const end = normalizeLongitude(endLng);
  let delta = end - start;
  if (delta > 180) {
    delta -= 360;
  } else if (delta < -180) {
    delta += 360;
  }
  return [start, start + delta] as const;
}

function clampLatitude(lat: number): number {
  return Math.max(-85, Math.min(85, lat));
}

export function routeArc(from: Place, to: Place): [number, number][] {
  const [startLng, endLng] = unwrapSegmentLongitudes(from.lng, to.lng);
  const startLat = clampLatitude(from.lat);
  const endLat = clampLatitude(to.lat);
  const span = Math.hypot(endLng - startLng, endLat - startLat);
  const bow = Math.min(7, Math.max(0.4, span * 0.14));
  const controlLng = (startLng + endLng) / 2;
  const controlLat = Math.max(-82, Math.min(82, (startLat + endLat) / 2 + bow));
  const steps = 32;
  const coordinates: [number, number][] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    coordinates.push([
      u * u * startLng + 2 * u * t * controlLng + t * t * endLng,
      clampLatitude(u * u * startLat + 2 * u * t * controlLat + t * t * endLat),
    ]);
  }
  return coordinates;
}

export function wantsLabel(
  index: number,
  count: number,
  stopId: string,
  selectedStopId: string | null,
  personFilter: string
): boolean {
  if (stopId === selectedStopId) {
    return true;
  }
  if (personFilter !== 'all') {
    return true;
  }
  return index === 0 || index === count - 1;
}

export function buildFamilyOverlay(input: {
  readonly stops: readonly MigrationStop[];
  readonly visibleStops: readonly MigrationStop[];
  readonly segments: readonly MigrationSegment[];
  readonly allSegments: readonly MigrationSegment[];
  readonly stepIndex: number;
  readonly selectedStopId: string | null;
  readonly personFilter: string;
  readonly stageColors: ReadonlyMap<string, string>;
}): FeatureCollection {
  const features: Feature[] = [];
  const stepping = input.stepIndex >= 0;

  if (stepping) {
    for (const segment of input.allSegments) {
      features.push({
        type: 'Feature',
        properties: { kind: 'guide' },
        geometry: {
          type: 'LineString',
          coordinates: routeArc(segment.from.place, segment.to.place),
        },
      });
    }
    for (const stop of input.stops.slice(input.visibleStops.length)) {
      features.push({
        type: 'Feature',
        properties: { kind: 'future', id: stop.id },
        geometry: { type: 'Point', coordinates: [stop.place.lng, stop.place.lat] },
      });
    }
  }

  for (const [index, segment] of input.segments.entries()) {
    features.push({
      type: 'Feature',
      properties: {
        kind: 'route',
        dashed: segment.distanceMiles > 2000,
        latest: stepping && index === input.segments.length - 1,
      },
      geometry: {
        type: 'LineString',
        coordinates: routeArc(segment.from.place, segment.to.place),
      },
    });
  }

  for (const [index, stop] of input.visibleStops.entries()) {
    features.push({
      type: 'Feature',
      properties: {
        kind: 'stop',
        id: stop.id,
        color: input.stageColors.get(stop.lineageStage) ?? KINLOOM_COLOR_TOKENS.archivalIndigo,
        label: `${stop.year} · ${stop.place.name}`,
        selected: stop.id === input.selectedStopId,
        showLabel: wantsLabel(
          index,
          input.visibleStops.length,
          stop.id,
          input.selectedStopId,
          input.personFilter
        ),
      },
      geometry: { type: 'Point', coordinates: [stop.place.lng, stop.place.lat] },
    });
  }

  return { type: 'FeatureCollection', features };
}

export function computeAntimeridianSafeBounds(
  stops: readonly MigrationStop[],
  mapDefaults: MapDefaultsConfig
): [[number, number], [number, number]] | null {
  if (stops.length === 0) {
    return computeStopsBounds([], mapDefaults);
  }

  const minSpanDeg = mapDefaults.minSpanDeg ?? 1.2;
  const sortedLngs = stops.map((stop) => normalizeLongitude(stop.place.lng)).toSorted((a, b) => a - b);

  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const stop of stops) {
    const lat = clampLatitude(stop.place.lat);
    if (lat < minLat) {
      minLat = lat;
    }
    if (lat > maxLat) {
      maxLat = lat;
    }
  }

  const firstLng = sortedLngs[0] ?? 0;
  const lastLng = sortedLngs[sortedLngs.length - 1] ?? firstLng;
  let largestGap = firstLng + 360 - lastLng;
  let gapStartIndex = 0;
  for (let i = 1; i < sortedLngs.length; i += 1) {
    const curLng = sortedLngs[i];
    const prevLng = sortedLngs[i - 1];
    if (curLng === undefined || prevLng === undefined) continue;
    const gap = curLng - prevLng;
    if (gap > largestGap) {
      largestGap = gap;
      gapStartIndex = i;
    }
  }

  let minLng = gapStartIndex === 0 ? firstLng : (sortedLngs[gapStartIndex] ?? firstLng);
  let maxLng = gapStartIndex === 0 ? lastLng : (sortedLngs[gapStartIndex - 1] ?? lastLng) + 360;

  if ((minLng + maxLng) / 2 > 180) {
    minLng -= 360;
    maxLng -= 360;
  }

  if (maxLng - minLng < minSpanDeg) {
    const midLng = (minLng + maxLng) / 2;
    minLng = midLng - minSpanDeg / 2;
    maxLng = midLng + minSpanDeg / 2;
  }
  if (maxLat - minLat < minSpanDeg) {
    const midLat = (minLat + maxLat) / 2;
    minLat = Math.max(-82, midLat - minSpanDeg / 2);
    maxLat = Math.min(82, midLat + minSpanDeg / 2);
  }

  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

export function computeDefaultMapBounds(
  stops: readonly MigrationStop[],
  mapDefaults: MapDefaultsConfig
): [[number, number], [number, number]] {
  const computed = computeAntimeridianSafeBounds(stops, mapDefaults);
  if (computed) {
    return computed;
  }
  const { centerLng, centerLat, minSpanDeg } = mapDefaults;
  const span = Math.max(4, minSpanDeg * 4);
  return [
    [centerLng - span, centerLat - span],
    [centerLng + span, centerLat + span],
  ];
}
