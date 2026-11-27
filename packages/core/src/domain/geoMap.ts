import { haversineMiles } from '../edtf.js';
import type { MapDefaultsConfig, MigrationEraConfig } from '../schemas/config.js';
import { DEFAULT_MIGRATION_ERAS } from '../schemas/config.js';
import type { ArchiveBundle, ArchiveEvent, Person, Place } from '../schemas/entities.js';

export interface GeoBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface ProjectedPoint {
  x: number;
  y: number;
}

export interface MigrationStop {
  id: string;
  year: number;
  displayDate: string;
  title: string;
  place: Place;
  personNames: string[];
  personSlugs: string[];
  eventId: string;
  lineageStage: string;
}

export interface MigrationSegment {
  from: MigrationStop;
  to: MigrationStop;
  distanceMiles: number;
}

export type LineageRouteMode = 'per-person' | 'chronological';

export interface NearbyPlaceMarker {
  place: Place;
  distanceMiles: number;
  x: number;
  y: number;
  inRadius: boolean;
}

export function projectLatLng(
  lat: number,
  lng: number,
  bounds: GeoBounds,
  width: number,
  height: number,
  pad = 24
): ProjectedPoint {
  const usableW = Math.max(1, width - pad * 2);
  const usableH = Math.max(1, height - pad * 2);
  const lngSpan = Math.max(0.01, bounds.maxLng - bounds.minLng);
  const latSpan = Math.max(0.01, bounds.maxLat - bounds.minLat);

  const nx = (lng - bounds.minLng) / lngSpan;
  const ny = (bounds.maxLat - lat) / latSpan;

  return {
    x: pad + nx * usableW,
    y: pad + ny * usableH,
  };
}

function eraMatchesPlace(era: MigrationEraConfig, place: Place, year?: number | null): boolean {
  if (era.minLat !== undefined && place.lat < era.minLat) {
    return false;
  }
  if (era.maxLat !== undefined && place.lat > era.maxLat) {
    return false;
  }
  if (era.minLng !== undefined && place.lng < era.minLng) {
    return false;
  }
  if (era.maxLng !== undefined && place.lng > era.maxLng) {
    return false;
  }
  if (year !== undefined && year !== null) {
    if (era.startYear !== undefined && year < era.startYear) {
      return false;
    }
    if (era.endYear !== undefined && year > era.endYear) {
      return false;
    }
  }
  return true;
}

/**
 * Classify a geographic place into a configured migration era from `KinloomSiteConfig.migrationEras`.
 */
export function classifyMigrationStage(
  place: Place,
  migrationEras?: readonly MigrationEraConfig[],
  year?: number | null
): string {
  const eras = migrationEras && migrationEras.length > 0 ? migrationEras : DEFAULT_MIGRATION_ERAS;
  for (const era of eras) {
    if (eraMatchesPlace(era, place, year)) {
      return era.id;
    }
  }
  return eras.at(-1)?.id ?? 'other';
}

function mergeStopParticipants(
  last: MigrationStop,
  ev: ArchiveEvent,
  peopleById: ReadonlyMap<string, Person>
): void {
  for (const pt of ev.participants) {
    const p = peopleById.get(pt.person_id);
    if (!p || p.full_name === 'Living' || last.personSlugs.includes(p.slug)) {
      continue;
    }
    last.personNames.push(p.full_name);
    last.personSlugs.push(p.slug);
  }
}

export interface BuildMigrationStopsOptions {
  personIdFilter?: string | null;
  migrationEras?: readonly MigrationEraConfig[];
}

export function buildMigrationStops(
  bundle: ArchiveBundle,
  placesById: ReadonlyMap<string, Place>,
  peopleById: ReadonlyMap<string, Person>,
  options?: string | null | BuildMigrationStopsOptions
): MigrationStop[] {
  const personIdFilter = typeof options === 'string' || options === null ? options : options?.personIdFilter;
  const migrationEras = typeof options === 'object' && options !== null ? options.migrationEras : undefined;

  const relevantEvents: ArchiveEvent[] = bundle.events
    .filter((ev) => {
      if (ev.scope !== 'personal' && ev.scope !== 'family') {
        return false;
      }
      if (!ev.place_id || ev.year === null) {
        return false;
      }
      const place = placesById.get(ev.place_id);
      if (!place || place.place_type === 'country') {
        return false;
      }
      if (personIdFilter) {
        return ev.participants.some((pt) => pt.person_id === personIdFilter);
      }
      return ev.participants.some((pt) => {
        const p = peopleById.get(pt.person_id);
        return p !== undefined && p.full_name !== 'Living';
      });
    })
    .toSorted((a, b) => (a.time_min ?? (a.year ?? 0) * 10_000) - (b.time_min ?? (b.year ?? 0) * 10_000));

  const stops: MigrationStop[] = [];
  for (const ev of relevantEvents) {
    const placeId = ev.place_id;
    if (!placeId) {
      continue;
    }
    const place = placesById.get(placeId);
    if (!place) {
      continue;
    }
    const last = stops.at(-1);
    if (last) {
      const dist = haversineMiles(last.place.lat, last.place.lng, place.lat, place.lng);
      if (dist < 12 && (!personIdFilter || Math.abs((ev.year ?? 0) - last.year) <= 5)) {
        mergeStopParticipants(last, ev, peopleById);
        continue;
      }
    }

    const participants = ev.participants
      .map((pt) => peopleById.get(pt.person_id))
      .filter((p): p is Person => p !== undefined && p.full_name !== 'Living');

    stops.push({
      id: `${ev.id}-${place.id}`,
      year: ev.year ?? 0,
      displayDate: ev.display_date,
      title: ev.title,
      place,
      personNames: participants.map((p) => p.full_name),
      personSlugs: participants.map((p) => p.slug),
      eventId: ev.id,
      lineageStage: classifyMigrationStage(place, migrationEras, ev.year),
    });
  }

  return stops;
}

export function buildMigrationSegments(stops: readonly MigrationStop[], minMiles = 15): MigrationSegment[] {
  const segments: MigrationSegment[] = [];
  for (let i = 1; i < stops.length; i += 1) {
    const from = stops[i - 1];
    const to = stops[i];
    const distanceMiles = Math.round(
      haversineMiles(from.place.lat, from.place.lng, to.place.lat, to.place.lng)
    );
    if (distanceMiles >= minMiles) {
      segments.push({ from, to, distanceMiles });
    }
  }
  return segments;
}

export function buildPerPersonMigrationSegments(
  stops: readonly MigrationStop[],
  minMiles = 15
): MigrationSegment[] {
  const segments: MigrationSegment[] = [];
  const lastStopByPerson = new Map<string, MigrationStop>();
  const seenLegs = new Set<string>();

  for (const stop of stops) {
    for (const slug of stop.personSlugs) {
      const prev = lastStopByPerson.get(slug);
      lastStopByPerson.set(slug, stop);
      if (!prev || prev.id === stop.id) {
        continue;
      }
      const distanceMiles = Math.round(
        haversineMiles(prev.place.lat, prev.place.lng, stop.place.lat, stop.place.lng)
      );
      if (distanceMiles < minMiles) {
        continue;
      }
      const legKey = `${prev.id}|${stop.id}`;
      if (seenLegs.has(legKey)) {
        continue;
      }
      seenLegs.add(legKey);
      segments.push({ from: prev, to: stop, distanceMiles });
    }
  }

  return segments;
}

export function computeStopsBounds(
  stops: readonly MigrationStop[],
  mapDefaultsOrMinSpan?: number | Pick<MapDefaultsConfig, 'minSpanDeg' | 'centerLat' | 'centerLng'>
): [[number, number], [number, number]] | null {
  const minSpanDeg =
    typeof mapDefaultsOrMinSpan === 'number'
      ? mapDefaultsOrMinSpan
      : (mapDefaultsOrMinSpan?.minSpanDeg ?? 1.2);

  if (stops.length === 0) {
    if (
      typeof mapDefaultsOrMinSpan === 'object' &&
      mapDefaultsOrMinSpan !== null &&
      mapDefaultsOrMinSpan.centerLat !== undefined &&
      mapDefaultsOrMinSpan.centerLng !== undefined
    ) {
      return [
        [mapDefaultsOrMinSpan.centerLng - minSpanDeg, mapDefaultsOrMinSpan.centerLat - minSpanDeg],
        [mapDefaultsOrMinSpan.centerLng + minSpanDeg, mapDefaultsOrMinSpan.centerLat + minSpanDeg],
      ];
    }
    return null;
  }

  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;

  for (const stop of stops) {
    if (stop.place.lng < minLng) {
      minLng = stop.place.lng;
    }
    if (stop.place.lng > maxLng) {
      maxLng = stop.place.lng;
    }
    if (stop.place.lat < minLat) {
      minLat = stop.place.lat;
    }
    if (stop.place.lat > maxLat) {
      maxLat = stop.place.lat;
    }
  }

  if (maxLng - minLng < minSpanDeg) {
    const midLng = (minLng + maxLng) / 2;
    minLng = midLng - minSpanDeg / 2;
    maxLng = midLng + minSpanDeg / 2;
  }
  if (maxLat - minLat < minSpanDeg) {
    const midLat = (minLat + maxLat) / 2;
    minLat = midLat - minSpanDeg / 2;
    maxLat = midLat + minSpanDeg / 2;
  }

  return [
    [minLng, minLat],
    [maxLng, maxLat],
  ];
}

export function projectNearbyPlaces(params: {
  center: Place;
  allPlaces: readonly Place[];
  width: number;
  height: number;
  maxRadiusMiles: number;
  highlightRadiusMiles?: number;
  limit?: number;
  excludeIds?: ReadonlySet<string>;
}): NearbyPlaceMarker[] {
  const {
    center,
    allPlaces,
    width,
    height,
    maxRadiusMiles,
    highlightRadiusMiles = 15,
    limit = 10,
    excludeIds,
  } = params;

  const degLat = maxRadiusMiles / 69;
  const cosLat = Math.max(0.25, Math.cos((center.lat * Math.PI) / 180));
  const degLng = maxRadiusMiles / (69 * cosLat);

  const aspect = width / Math.max(1, height);
  const bounds: GeoBounds = {
    minLat: center.lat - degLat,
    maxLat: center.lat + degLat,
    minLng: center.lng - degLng * aspect,
    maxLng: center.lng + degLng * aspect,
  };

  const seenNames = new Set<string>([center.name.toLowerCase()]);
  const candidates: { place: Place; distanceMiles: number }[] = [];

  for (const other of allPlaces) {
    if (other.id === center.id) {
      continue;
    }
    if (excludeIds?.has(other.id)) {
      continue;
    }
    if (other.place_type === 'country' || other.place_type === 'state') {
      continue;
    }
    const d = haversineMiles(center.lat, center.lng, other.lat, other.lng);
    if (d < 0.8 || d > maxRadiusMiles * aspect * 0.95) {
      continue;
    }
    const key = other.name.toLowerCase();
    if (seenNames.has(key)) {
      continue;
    }
    seenNames.add(key);
    candidates.push({ place: other, distanceMiles: Number(d.toFixed(1)) });
  }

  candidates.sort((a, b) => a.distanceMiles - b.distanceMiles);

  return candidates.slice(0, limit).map(({ place, distanceMiles }) => {
    const pt = projectLatLng(place.lat, place.lng, bounds, width, height, 10);
    return {
      place,
      distanceMiles,
      x: pt.x,
      y: pt.y,
      inRadius: distanceMiles <= highlightRadiusMiles,
    };
  });
}

/**
 * Offline cartographic outlines covering the North Atlantic corridor.
 */
export const ARCHIVAL_LANDMASSES: { id: string; label: string; coords: [number, number][] }[] = [
  {
    id: 'usa-contiguous',
    label: 'United States',
    coords: [
      [48.9, -124.7],
      [46.2, -124],
      [42, -124.3],
      [38, -123],
      [34.5, -120.5],
      [32.5, -117.1],
      [31.3, -111],
      [31.8, -106.5],
      [29, -103.1],
      [29.8, -101.4],
      [25.9, -97.2],
      [27.8, -97.1],
      [29.3, -94.8],
      [29.6, -90],
      [30.2, -88],
      [29.9, -84],
      [25.2, -81],
      [25.8, -80.1],
      [30.7, -81.5],
      [32.8, -79.9],
      [35.2, -75.5],
      [37, -76],
      [39.5, -74.3],
      [40.6, -73.9],
      [41.3, -71.5],
      [42, -70],
      [43.6, -70.2],
      [44.8, -67],
      [47.3, -68.3],
      [45, -71.5],
      [45, -75],
      [43.6, -79],
      [42.3, -83],
      [45.8, -84.7],
      [46.8, -84.9],
      [48, -89.5],
      [49, -95.2],
      [49, -110],
      [49, -122.8],
      [48.9, -124.7],
    ],
  },
  {
    id: 'canada-south',
    label: 'Canada',
    coords: [
      [49, -123],
      [54, -130],
      [58, -125],
      [58, -95],
      [56, -79],
      [52, -65],
      [47, -60],
      [44.5, -63.5],
      [44.8, -67],
      [47.3, -68.3],
      [45, -71.5],
      [45, -75],
      [43.6, -79],
      [45.8, -84.7],
      [48, -89.5],
      [49, -95.2],
      [49, -123],
    ],
  },
  {
    id: 'mexico-north',
    label: 'Mexico',
    coords: [
      [32.5, -117.1],
      [27, -114],
      [23, -109.9],
      [24, -107],
      [22, -105.5],
      [22, -97.7],
      [25.9, -97.2],
      [29.8, -101.4],
      [29, -103.1],
      [31.8, -106.5],
      [31.3, -111],
      [32.5, -117.1],
    ],
  },
  {
    id: 'great-britain',
    label: 'Great Britain',
    coords: [
      [50.1, -5.6],
      [51.3, -3.5],
      [53.4, -3.1],
      [55, -4.9],
      [57.6, -5.8],
      [58.6, -3.1],
      [57.6, -1.8],
      [55.8, -2.1],
      [54.5, -0.6],
      [52.9, 1.7],
      [51.4, 1.4],
      [50.7, -1.5],
      [50.1, -5.6],
    ],
  },
  {
    id: 'ireland',
    label: 'Ireland',
    coords: [
      [51.5, -9.8],
      [53.2, -9.8],
      [55.2, -7.5],
      [54.5, -5.6],
      [52.2, -6.4],
      [51.5, -9.8],
    ],
  },
  {
    id: 'western-europe',
    label: 'Western Europe',
    coords: [
      [43.4, -1.8],
      [46, -1.2],
      [48.4, -4.7],
      [49.7, -1.8],
      [51, 2],
      [52.4, 4.6],
      [53.4, 6.8],
      [54.2, 8.8],
      [57.5, 9.8],
      [55, 12.5],
      [54, 14.5],
      [50, 14.5],
      [46, 13],
      [43.5, 7],
      [43.4, -1.8],
    ],
  },
];

export const US_REGION_LINES: [number, number][][] = [
  [
    [42, -120],
    [39, -120],
    [35, -114.6],
    [32.7, -114.6],
  ],
  [
    [36.5, -103],
    [32, -103],
    [32, -106.5],
  ],
  [
    [36.5, -103],
    [36.5, -100],
    [34.5, -100],
    [33.8, -94.5],
  ],
  [
    [33.8, -94],
    [31, -93.6],
    [29.7, -93.8],
  ],
  [
    [40.6, -95.7],
    [40.6, -91.6],
    [36.5, -89.5],
    [36.5, -94.6],
    [40.6, -95.7],
  ],
  [
    [45, -93],
    [41.5, -90.5],
    [38.6, -90.2],
    [35.1, -90.1],
    [32.3, -90.9],
    [29.6, -89.9],
  ],
  [
    [42, -80.5],
    [42, -75],
    [39.7, -75.5],
    [39.7, -80.5],
    [37, -82],
    [36.5, -76],
  ],
];
