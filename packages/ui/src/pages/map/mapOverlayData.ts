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

export function routeArc(from: Place, to: Place): [number, number][] {
  const startLng = from.lng;
  const startLat = from.lat;
  const endLng = to.lng;
  const endLat = to.lat;
  const span = Math.hypot(endLng - startLng, endLat - startLat);
  const bow = Math.min(7, Math.max(0.4, span * 0.14));
  const controlLng = (startLng + endLng) / 2;
  const controlLat = (startLat + endLat) / 2 + bow;
  const steps = 32;
  const coordinates: [number, number][] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    coordinates.push([
      u * u * startLng + 2 * u * t * controlLng + t * t * endLng,
      u * u * startLat + 2 * u * t * controlLat + t * t * endLat,
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

export function computeDefaultMapBounds(
  stops: readonly MigrationStop[],
  mapDefaults: MapDefaultsConfig
): [[number, number], [number, number]] {
  const computed = computeStopsBounds([...stops], mapDefaults);
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
