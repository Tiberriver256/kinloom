import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson';
import { KINLOOM_COLOR_TOKENS } from './tokens.js';

export const OFFLINE_BASEMAP_SOURCE_IDS = {
  graticule: 'kinloom-offline-graticule',
  land: 'kinloom-offline-land',
  inlandWater: 'kinloom-offline-inland-water',
} as const;

export const OFFLINE_BASEMAP_LAYER_IDS = {
  background: 'paper',
  graticule: 'kinloom-offline-graticule-lines',
  landFill: 'kinloom-offline-land-fill',
  coastline: 'kinloom-offline-coastline',
  inlandWaterFill: 'kinloom-offline-inland-water-fill',
  inlandWaterShore: 'kinloom-offline-inland-water-shore',
} as const;

export interface OfflineBasemapPalette {
  readonly water: string;
  readonly land: string;
  readonly coastline: string;
  readonly graticule: string;
  readonly graticuleOpacity: number;
  readonly coastlineOpacity: number;
}

export const OFFLINE_BASEMAP_PALETTES: Readonly<{
  light: OfflineBasemapPalette;
  dark: OfflineBasemapPalette;
}> = {
  light: {
    water: '#D4E1E8',
    land: KINLOOM_COLOR_TOKENS.warmLinen,
    coastline: '#A69B88',
    graticule: '#9DB3C0',
    graticuleOpacity: 0.48,
    coastlineOpacity: 0.82,
  },
  dark: {
    water: '#131F2B',
    land: '#312D27',
    coastline: '#655D50',
    graticule: '#314558',
    graticuleOpacity: 0.52,
    coastlineOpacity: 0.88,
  },
};

export function getOfflineBasemapPalette(isDark: boolean): OfflineBasemapPalette {
  return isDark ? OFFLINE_BASEMAP_PALETTES.dark : OFFLINE_BASEMAP_PALETTES.light;
}

type Ring = readonly (readonly [number, number])[];

function closeRing(coords: Ring): [number, number][] {
  const out = coords.map(([lng, lat]): [number, number] => [lng, lat]);
  const first = out[0];
  const last = out.at(-1);
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    out.push([first[0], first[1]]);
  }
  return out;
}

function polygonFeature(name: string, ring: Ring): Feature<Polygon> {
  return {
    type: 'Feature',
    properties: { name },
    geometry: {
      type: 'Polygon',
      coordinates: [closeRing(ring)],
    },
  };
}

// Coarse archival landmass outlines (public-domain generalized geographic coordinates).
const LAND_POLYGONS: readonly { readonly name: string; readonly ring: Ring }[] = [
  {
    name: 'North America',
    ring: [
      [-168, 66],
      [-162, 70],
      [-141, 70],
      [-127, 70],
      [-110, 68],
      [-95, 69],
      [-83, 66],
      [-94, 60],
      [-92, 56],
      [-80, 52],
      [-78, 57],
      [-74, 62],
      [-64, 60],
      [-56, 52],
      [-61, 47],
      [-66, 45],
      [-60, 45.8],
      [-64, 43.5],
      [-67, 45],
      [-70, 43.5],
      [-70.5, 41.8],
      [-71.5, 41.3],
      [-74, 40.5],
      [-75.5, 38.5],
      [-76, 36.8],
      [-75.5, 35.2],
      [-78.5, 33.8],
      [-81, 31],
      [-80.2, 25.5],
      [-81.8, 25.2],
      [-82.8, 28],
      [-84, 30],
      [-88.5, 30.2],
      [-90, 29],
      [-94, 29.5],
      [-97.2, 26],
      [-97.8, 22],
      [-95.5, 18.5],
      [-90.5, 19.8],
      [-87, 21.3],
      [-88.2, 16],
      [-83.5, 15],
      [-83.5, 10],
      [-79.5, 9],
      [-78, 8],
      [-82.5, 8.5],
      [-85.5, 10.5],
      [-92, 14.5],
      [-100, 16.8],
      [-105.5, 20.5],
      [-109, 25.5],
      [-112.5, 31],
      [-114.5, 31.5],
      [-110, 23],
      [-111.5, 24.5],
      [-117, 32.5],
      [-120.5, 34.5],
      [-122.5, 37.8],
      [-124.4, 40.5],
      [-124.5, 45],
      [-124.6, 48.4],
      [-127.5, 50.8],
      [-131, 55],
      [-136, 58.5],
      [-145, 60.5],
      [-152, 59],
      [-161, 55.5],
      [-166, 60],
      [-165, 64.5],
    ],
  },
  {
    name: 'Newfoundland',
    ring: [
      [-59.3, 47.6],
      [-55.5, 51.5],
      [-52.7, 47.5],
      [-55.8, 46.9],
    ],
  },
  {
    name: 'Cuba',
    ring: [
      [-84.9, 21.9],
      [-81.5, 23.1],
      [-77.5, 21.5],
      [-74.2, 20.2],
      [-77.2, 19.9],
      [-82, 22.1],
    ],
  },
  {
    name: 'Hispaniola',
    ring: [
      [-74.4, 18.4],
      [-71.8, 19.9],
      [-68.4, 18.6],
      [-71.5, 17.8],
    ],
  },
  {
    name: 'Greenland',
    ring: [
      [-52, 60],
      [-43, 60],
      [-36, 65],
      [-24, 70],
      [-18, 77],
      [-25, 82],
      [-45, 83],
      [-68, 79],
      [-58, 73],
      [-54, 67],
    ],
  },
  {
    name: 'Iceland',
    ring: [
      [-24, 65.5],
      [-18, 66.3],
      [-13.5, 65.2],
      [-16, 63.5],
      [-22.5, 64],
    ],
  },
  {
    name: 'Great Britain',
    ring: [
      [-5.6, 50.1],
      [-5, 51.6],
      [-4.8, 53.3],
      [-3.3, 54.6],
      [-5.4, 55.5],
      [-6, 57.5],
      [-4.8, 58.6],
      [-3, 58.6],
      [-2, 57.6],
      [-2.5, 56],
      [-1.4, 55],
      [0.2, 53.6],
      [1.7, 52.6],
      [1.3, 51.3],
      [-0.5, 50.8],
      [-3.5, 50.2],
    ],
  },
  {
    name: 'Ireland',
    ring: [
      [-10.2, 51.8],
      [-9.9, 53.5],
      [-8.4, 55.1],
      [-6, 55.2],
      [-5.5, 54.4],
      [-6.1, 53.3],
      [-6.4, 52.2],
      [-8.5, 51.6],
    ],
  },
  {
    name: 'Eurasia',
    ring: [
      [-9.3, 38.7],
      [-9.2, 43],
      [-1.8, 43.4],
      [-4.6, 48.4],
      [-1.5, 49.6],
      [2, 51],
      [5, 53.2],
      [8.5, 54],
      [8.5, 57],
      [10.8, 57.7],
      [12.5, 55.6],
      [10.2, 54.3],
      [14.5, 54],
      [19, 54.7],
      [21, 56.5],
      [24.5, 59.5],
      [28.5, 60.2],
      [21.5, 60.5],
      [21.5, 63.5],
      [25, 65.8],
      [21, 63.5],
      [18.5, 59.5],
      [16, 56.2],
      [12.8, 55.4],
      [11.5, 58.8],
      [5.2, 60.4],
      [8.5, 63.5],
      [15, 68.5],
      [26, 71],
      [32, 69.5],
      [40, 67],
      [44, 66],
      [54, 68.5],
      [68, 70],
      [74, 73],
      [92, 74],
      [106, 77],
      [124, 73],
      [148, 71],
      [176, 66.5],
      [162, 59.5],
      [157, 51],
      [160, 56],
      [143, 59],
      [140, 53],
      [135, 44],
      [129, 40],
      [129.2, 35.1],
      [126.2, 35.5],
      [125, 39.5],
      [121.5, 39],
      [118, 39],
      [122.5, 37],
      [120, 34],
      [122, 31],
      [120, 26],
      [114, 22.3],
      [108, 21],
      [109, 12],
      [104.8, 9],
      [100.5, 13.5],
      [103.8, 1.3],
      [98.5, 8],
      [97, 16.5],
      [92, 21.5],
      [88, 22],
      [80, 13],
      [77.5, 8.1],
      [73, 19],
      [68.5, 23.5],
      [62, 25],
      [56.3, 26.5],
      [49, 29.8],
      [51, 25],
      [59.5, 22.5],
      [53, 16.5],
      [44, 12.8],
      [39.5, 21],
      [34.5, 28],
      [32.5, 30.5],
      [35, 31.5],
      [36, 36.5],
      [27, 37],
      [26.5, 40.5],
      [29, 41.2],
      [35, 42],
      [41.5, 41.5],
      [38, 45],
      [33, 45.2],
      [30, 46.2],
      [28, 42],
      [26, 40.8],
      [23.5, 38],
      [22.5, 36.5],
      [20, 40],
      [14, 45.5],
      [12.5, 44.5],
      [16, 41],
      [18.2, 40],
      [15.8, 38],
      [13, 41.5],
      [9, 44.4],
      [5, 43.3],
      [3, 42.3],
      [-0.5, 38],
      [-5.4, 36],
      [-8.9, 37],
    ],
  },
  {
    name: 'Japan',
    ring: [
      [130.5, 31.5],
      [135.5, 34],
      [140.8, 35.8],
      [141.5, 41.2],
      [145.5, 43.5],
      [141, 45],
      [139.5, 38.5],
      [131, 34],
    ],
  },
  {
    name: 'Africa',
    ring: [
      [-6, 35.8],
      [3, 36.8],
      [10.8, 37],
      [11.5, 33],
      [20, 32.5],
      [25, 31.5],
      [32.5, 31.2],
      [34.5, 27],
      [38.5, 20],
      [43.3, 12.5],
      [51.2, 11.8],
      [45, 2],
      [40.5, -5],
      [40.5, -14.5],
      [35, -24],
      [28, -33],
      [18.4, -34.4],
      [15, -26],
      [12, -16],
      [12.2, -6],
      [9.2, 1],
      [9.5, 4.2],
      [3.5, 6.4],
      [-4, 5.2],
      [-8, 4.6],
      [-13.5, 9],
      [-17.4, 14.7],
      [-16, 21],
      [-13, 28],
      [-9.5, 31.5],
    ],
  },
  {
    name: 'Madagascar',
    ring: [
      [44, -25],
      [47, -25],
      [50, -15],
      [49.3, -12],
      [44.5, -19.5],
    ],
  },
  {
    name: 'South America',
    ring: [
      [-78, 8.5],
      [-75.5, 10.8],
      [-71.5, 11.5],
      [-62, 10.5],
      [-52, 4.5],
      [-48, -0.5],
      [-35, -6],
      [-38.5, -13],
      [-41, -22.5],
      [-48.5, -27],
      [-53.5, -34],
      [-58, -38.5],
      [-65, -42.5],
      [-67.5, -54.8],
      [-72.5, -53],
      [-75, -46],
      [-72, -35],
      [-70.5, -18.5],
      [-77, -12],
      [-81.2, -4.8],
      [-79.8, 1.5],
    ],
  },
  {
    name: 'Australia',
    ring: [
      [114, -22],
      [122, -18],
      [131, -12],
      [136.5, -12.5],
      [137, -15.5],
      [142.5, -10.8],
      [146, -18],
      [153.5, -28],
      [150, -37.5],
      [141, -38.5],
      [135.5, -34.5],
      [128, -32],
      [115.2, -34.2],
      [113.5, -26],
    ],
  },
  {
    name: 'New Zealand',
    ring: [
      [166.5, -46],
      [171, -43.5],
      [174.5, -41],
      [178.5, -37.5],
      [173, -34.5],
      [174, -39.5],
      [169, -45.5],
    ],
  },
];

// Major inland water basins rendered over land for regional genealogy orientation.
const INLAND_WATER_POLYGONS: readonly { readonly name: string; readonly ring: Ring }[] = [
  {
    name: 'Lake Superior',
    ring: [
      [-92.1, 46.8],
      [-90, 48.0],
      [-87.4, 48.8],
      [-84.9, 47.9],
      [-84.6, 46.5],
      [-87.5, 46.5],
      [-90.5, 46.7],
    ],
  },
  {
    name: 'Lake Michigan',
    ring: [
      [-87.9, 45.8],
      [-85.2, 46.0],
      [-85.8, 44.5],
      [-86.4, 42.3],
      [-87.1, 41.6],
      [-87.7, 42.0],
      [-87.9, 43.8],
    ],
  },
  {
    name: 'Lake Huron',
    ring: [
      [-84.5, 46.1],
      [-81.2, 46.0],
      [-80.0, 44.8],
      [-81.8, 44.4],
      [-82.4, 43.0],
      [-83.5, 44.2],
      [-84.2, 45.5],
    ],
  },
  {
    name: 'Lake Erie',
    ring: [
      [-83.4, 41.7],
      [-81.5, 42.6],
      [-78.9, 42.9],
      [-80.2, 42.1],
      [-82.5, 41.4],
    ],
  },
  {
    name: 'Lake Ontario',
    ring: [
      [-79.8, 43.3],
      [-77.5, 44.0],
      [-76.1, 44.1],
      [-76.4, 43.4],
      [-78.8, 43.2],
    ],
  },
  {
    name: 'Caspian Sea',
    ring: [
      [49.5, 46.8],
      [53.2, 46.0],
      [54.0, 41.0],
      [53.8, 37.2],
      [50.0, 37.0],
      [49.0, 40.5],
      [47.5, 44.5],
    ],
  },
];

function buildGraticuleCollection(): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = [];
  for (let lng = -180; lng <= 180; lng += 15) {
    const coords: [number, number][] = [];
    for (let lat = -75; lat <= 75; lat += 15) {
      coords.push([lng, lat]);
    }
    features.push({
      type: 'Feature',
      properties: { axis: 'meridian', value: lng },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
  for (let lat = -60; lat <= 75; lat += 15) {
    const coords: [number, number][] = [];
    for (let lng = -180; lng <= 180; lng += 15) {
      coords.push([lng, lat]);
    }
    features.push({
      type: 'Feature',
      properties: { axis: 'parallel', value: lat },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }
  return { type: 'FeatureCollection', features };
}

export const OFFLINE_GRATICULE_GEOJSON: FeatureCollection<LineString> = buildGraticuleCollection();

export const OFFLINE_LAND_GEOJSON: FeatureCollection<Polygon> = {
  type: 'FeatureCollection',
  features: LAND_POLYGONS.map((entry) => polygonFeature(entry.name, entry.ring)),
};

export const OFFLINE_INLAND_WATER_GEOJSON: FeatureCollection<Polygon> = {
  type: 'FeatureCollection',
  features: INLAND_WATER_POLYGONS.map((entry) => polygonFeature(entry.name, entry.ring)),
};
