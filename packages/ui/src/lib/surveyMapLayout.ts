import type { GeoBounds, NearbyPlaceMarker, Place } from '@kinloom/core';
import { haversineMiles, projectLatLng } from '@kinloom/core';

export type SurveyCardinal = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

export interface SurveyBox {
  readonly x1: number;
  readonly x2: number;
  readonly y1: number;
  readonly y2: number;
}

export interface SurveyEdgeIndicator {
  readonly place: Place;
  readonly distanceMiles: number;
  readonly bearingDeg: number;
  readonly edgeX: number;
  readonly edgeY: number;
  readonly cardinal: SurveyCardinal;
  readonly arrow: string;
}

export interface SurveyProjectionResult {
  readonly effectiveMaxRadiusMiles: number;
  readonly didAutoScale: boolean;
  readonly inBoundsMarkers: readonly NearbyPlaceMarker[];
  readonly edgeIndicators: readonly SurveyEdgeIndicator[];
}

export interface SurveyCenterPlacement {
  readonly x: number;
  readonly titleY: number;
  readonly anchor: 'start' | 'end' | 'middle';
  readonly box: SurveyBox;
}

export interface SurveyPlacedLabel {
  readonly placeId: string;
  readonly text: string;
  readonly lx: number;
  readonly ly: number;
  readonly anchor: 'start' | 'end';
  readonly extraCount: number;
  readonly box: SurveyBox;
  readonly leader?: {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
  };
}

export interface SurveyEdgeBadgeLayout {
  readonly indicator: SurveyEdgeIndicator;
  readonly text: string;
  readonly rectX: number;
  readonly rectY: number;
  readonly rectW: number;
  readonly rectH: number;
  readonly textX: number;
  readonly textY: number;
  readonly box: SurveyBox;
}

const CARDINAL_DIRS: readonly { readonly cardinal: SurveyCardinal; readonly arrow: string }[] = [
  { cardinal: 'N', arrow: '↑' },
  { cardinal: 'NE', arrow: '↗' },
  { cardinal: 'E', arrow: '→' },
  { cardinal: 'SE', arrow: '↘' },
  { cardinal: 'S', arrow: '↓' },
  { cardinal: 'SW', arrow: '↙' },
  { cardinal: 'W', arrow: '←' },
  { cardinal: 'NW', arrow: '↖' },
];

const MAX_AUTO_SCALE_MILES = 250;

export function estimateMonoTextWidth(text: string, fontSize: number): number {
  return Math.ceil(text.length * fontSize * 0.62) + 12;
}

export function boxesOverlap(a: SurveyBox, b: SurveyBox): boolean {
  return !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
}

export function boxIntersectsCircleStroke(
  box: SurveyBox,
  cx: number,
  cy: number,
  radius: number,
  band: number
): boolean {
  if (radius <= 0) {
    return false;
  }
  const closestX = Math.max(box.x1, Math.min(cx, box.x2));
  const closestY = Math.max(box.y1, Math.min(cy, box.y2));
  const minDist = Math.hypot(closestX - cx, closestY - cy);

  const farX = Math.max(Math.abs(box.x1 - cx), Math.abs(box.x2 - cx));
  const farY = Math.max(Math.abs(box.y1 - cy), Math.abs(box.y2 - cy));
  const maxDist = Math.hypot(farX, farY);

  return minDist <= radius + band && maxDist >= Math.max(0, radius - band);
}

export function boxIntersectsSegment(
  box: SurveyBox,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): boolean {
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;

  const edges: readonly [number, number][] = [
    [-dx, x1 - box.x1],
    [dx, box.x2 - x1],
    [-dy, y1 - box.y1],
    [dy, box.y2 - y1],
  ];

  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) {
        return false;
      }
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) {
        return false;
      }
      if (r > t0) {
        t0 = r;
      }
    } else {
      if (r < t0) {
        return false;
      }
      if (r < t1) {
        t1 = r;
      }
    }
  }
  return t0 <= t1;
}

export function computeBearingDegrees(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad;
  const phi2 = lat2 * toRad;
  const dLambda = (lng2 - lng1) * toRad;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return ((deg % 360) + 360) % 360;
}

export function bearingToCardinal(bearingDeg: number): {
  readonly cardinal: SurveyCardinal;
  readonly arrow: string;
} {
  const idx = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return CARDINAL_DIRS[idx];
}

function intersectRayWithFrame(
  cx: number,
  cy: number,
  tx: number,
  ty: number,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number
): { readonly x: number; readonly y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  let bestT = Infinity;

  if (dx > 1e-6) {
    const t = (maxX - cx) / dx;
    const y = cy + t * dy;
    if (t > 0 && y >= minY - 0.5 && y <= maxY + 0.5 && t < bestT) {
      bestT = t;
    }
  } else if (dx < -1e-6) {
    const t = (minX - cx) / dx;
    const y = cy + t * dy;
    if (t > 0 && y >= minY - 0.5 && y <= maxY + 0.5 && t < bestT) {
      bestT = t;
    }
  }

  if (dy > 1e-6) {
    const t = (maxY - cy) / dy;
    const x = cx + t * dx;
    if (t > 0 && x >= minX - 0.5 && x <= maxX + 0.5 && t < bestT) {
      bestT = t;
    }
  } else if (dy < -1e-6) {
    const t = (minY - cy) / dy;
    const x = cx + t * dx;
    if (t > 0 && x >= minX - 0.5 && x <= maxX + 0.5 && t < bestT) {
      bestT = t;
    }
  }

  if (!Number.isFinite(bestT)) {
    return {
      x: Math.max(minX, Math.min(maxX, tx)),
      y: Math.max(minY, Math.min(maxY, ty)),
    };
  }

  return {
    x: Math.max(minX, Math.min(maxX, cx + bestT * dx)),
    y: Math.max(minY, Math.min(maxY, cy + bestT * dy)),
  };
}

function buildSurveyBounds(center: Place, radiusMiles: number, width: number, height: number): GeoBounds {
  const degLat = radiusMiles / 69;
  const cosLat = Math.max(0.25, Math.cos((center.lat * Math.PI) / 180));
  const degLng = radiusMiles / (69 * cosLat);
  const aspect = width / Math.max(1, height);
  return {
    minLat: center.lat - degLat,
    maxLat: center.lat + degLat,
    minLng: center.lng - degLng * aspect,
    maxLng: center.lng + degLng * aspect,
  };
}

export function projectAdaptiveSurveyPlaces(params: {
  readonly center: Place;
  readonly allPlaces: readonly Place[];
  readonly width: number;
  readonly height: number;
  readonly maxRadiusMiles: number;
  readonly highlightRadiusMiles?: number;
  readonly limit?: number;
  readonly maxEdgeIndicators?: number;
  readonly excludeIds?: ReadonlySet<string>;
}): SurveyProjectionResult {
  const {
    center,
    allPlaces,
    width,
    height,
    maxRadiusMiles,
    highlightRadiusMiles = 15,
    limit = 12,
    maxEdgeIndicators = 4,
    excludeIds,
  } = params;

  const seenNames = new Set<string>([center.name.toLowerCase()]);
  const candidates: { readonly place: Place; readonly distanceMiles: number }[] = [];

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
    if (d < 0.8) {
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

  const margin = 14;
  const projectAll = (radiusMiles: number) => {
    const bounds = buildSurveyBounds(center, radiusMiles, width, height);
    return candidates.map(({ place, distanceMiles }) => {
      const pt = projectLatLng(place.lat, place.lng, bounds, width, height, 10);
      const inBounds = pt.x >= margin && pt.x <= width - margin && pt.y >= margin && pt.y <= height - margin;
      return { place, distanceMiles, x: pt.x, y: pt.y, inBounds };
    });
  };

  let effectiveMaxRadiusMiles = maxRadiusMiles;
  let didAutoScale = false;
  let projected = projectAll(effectiveMaxRadiusMiles);

  const hasAnyInBounds = projected.some((p) => p.inBounds);
  const nearestDistance = candidates[0]?.distanceMiles;
  if (!hasAnyInBounds && nearestDistance !== undefined && nearestDistance <= MAX_AUTO_SCALE_MILES) {
    effectiveMaxRadiusMiles = Math.min(
      MAX_AUTO_SCALE_MILES,
      Math.max(maxRadiusMiles, Math.ceil(nearestDistance * 1.35))
    );
    didAutoScale = effectiveMaxRadiusMiles > maxRadiusMiles;
    projected = projectAll(effectiveMaxRadiusMiles);
  }

  const inBoundsMarkers: NearbyPlaceMarker[] = [];
  const outOfBounds: typeof projected = [];

  for (const item of projected) {
    if (item.inBounds) {
      if (inBoundsMarkers.length < limit) {
        inBoundsMarkers.push({
          place: item.place,
          distanceMiles: item.distanceMiles,
          x: item.x,
          y: item.y,
          inRadius: item.distanceMiles <= highlightRadiusMiles,
        });
      }
    } else {
      outOfBounds.push(item);
    }
  }

  const cx = width / 2;
  const cy = height / 2;
  const maxEdgeDistance = effectiveMaxRadiusMiles * (width / Math.max(1, height)) * 1.15;
  const eligibleOutOfBounds =
    inBoundsMarkers.length === 0
      ? outOfBounds
      : outOfBounds.filter((item) => item.distanceMiles <= maxEdgeDistance);

  const edgeIndicators: SurveyEdgeIndicator[] = eligibleOutOfBounds
    .slice(0, maxEdgeIndicators)
    .map((item) => {
      const bearingDeg = computeBearingDegrees(center.lat, center.lng, item.place.lat, item.place.lng);
      const { cardinal, arrow } = bearingToCardinal(bearingDeg);
      const edgePt = intersectRayWithFrame(cx, cy, item.x, item.y, 22, width - 22, 18, height - 18);
      return {
        place: item.place,
        distanceMiles: item.distanceMiles,
        bearingDeg: Math.round(bearingDeg),
        edgeX: Number(edgePt.x.toFixed(1)),
        edgeY: Number(edgePt.y.toFixed(1)),
        cardinal,
        arrow,
      };
    });

  return {
    effectiveMaxRadiusMiles,
    didAutoScale,
    inBoundsMarkers,
    edgeIndicators,
  };
}

export function computeEdgeBadgeLayouts(params: {
  readonly edgeIndicators: readonly SurveyEdgeIndicator[];
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
  readonly compassBox: SurveyBox;
}): readonly SurveyEdgeBadgeLayout[] {
  const { edgeIndicators, width, height, fontSize, compassBox } = params;
  const placed: SurveyBox[] = [compassBox];
  const layouts: SurveyEdgeBadgeLayout[] = [];
  const badgeH = Math.ceil(fontSize + 8);
  const padX = 6;
  const framePad = 6;

  for (const ind of edgeIndicators) {
    const shortName =
      ind.place.name.length > 16 ? `${ind.place.name.slice(0, 15).trimEnd()}…` : ind.place.name;
    const text = `${ind.arrow} ${shortName} · ${Math.round(ind.distanceMiles)} mi`;
    const rectW = Math.min(width - framePad * 2, estimateMonoTextWidth(text, fontSize));

    const idealX = Math.max(framePad, Math.min(width - framePad - rectW, ind.edgeX - rectW / 2));
    const idealY = Math.max(framePad, Math.min(height - framePad - badgeH, ind.edgeY - badgeH / 2));

    const offsets: readonly [number, number][] = [
      [0, 0],
      [0, badgeH + 4],
      [0, -(badgeH + 4)],
      [-(rectW + 6), 0],
      [rectW + 6, 0],
      [0, (badgeH + 4) * 2],
      [0, -(badgeH + 4) * 2],
    ];

    let chosen: { readonly x: number; readonly y: number } | null = null;
    for (const [ox, oy] of offsets) {
      const rx = Math.max(framePad, Math.min(width - framePad - rectW, idealX + ox));
      const ry = Math.max(framePad, Math.min(height - framePad - badgeH, idealY + oy));
      const box: SurveyBox = { x1: rx - 2, x2: rx + rectW + 2, y1: ry - 2, y2: ry + badgeH + 2 };
      if (!placed.some((p) => boxesOverlap(box, p))) {
        placed.push(box);
        chosen = { x: rx, y: ry };
        break;
      }
    }

    if (chosen) {
      layouts.push({
        indicator: ind,
        text,
        rectX: chosen.x,
        rectY: chosen.y,
        rectW,
        rectH: badgeH,
        textX: chosen.x + padX,
        textY: chosen.y + badgeH - 5,
        box: {
          x1: chosen.x - 2,
          x2: chosen.x + rectW + 2,
          y1: chosen.y - 2,
          y2: chosen.y + badgeH + 2,
        },
      });
    }
  }

  return layouts;
}

export function computeCenterLabelPlacement(params: {
  readonly centerName: string;
  readonly markers: readonly NearbyPlaceMarker[];
  readonly edgeBadgeBoxes: readonly SurveyBox[];
  readonly compassBox: SurveyBox;
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  readonly compact: boolean;
  readonly isNarrow: boolean;
  readonly scopeMode: 'exact' | 'radius15' | 'county';
  readonly radiusPx: number;
}): SurveyCenterPlacement {
  const {
    centerName,
    markers,
    edgeBadgeBoxes,
    compassBox,
    cx,
    cy,
    width,
    height,
    compact,
    isNarrow,
    scopeMode,
    radiusPx,
  } = params;

  const fontSize = compact ? 12.5 : isNarrow ? 13.5 : 12;
  const textW = estimateMonoTextWidth(centerName, fontSize);
  const halfW = textW / 2;
  const pad = compact ? 8 : 11;
  const topOffset = compact ? 14 : Math.max(18, Math.round(radiusPx) + 12);
  const bottomOffset = compact ? 18 : Math.max(24, Math.round(radiusPx) + 18);

  const candidates: readonly SurveyCenterPlacement[] = [
    {
      x: cx + pad,
      titleY: cy + 4,
      anchor: 'start',
      box: { x1: cx + pad - 2, x2: cx + pad + textW, y1: cy - 12, y2: cy + 10 },
    },
    {
      x: cx - pad,
      titleY: cy + 4,
      anchor: 'end',
      box: { x1: cx - pad - textW, x2: cx - pad + 2, y1: cy - 12, y2: cy + 10 },
    },
    {
      x: cx,
      titleY: cy - topOffset,
      anchor: 'middle',
      box: { x1: cx - halfW, x2: cx + halfW, y1: cy - topOffset - 13, y2: cy - topOffset + 4 },
    },
    {
      x: cx,
      titleY: cy + bottomOffset,
      anchor: 'middle',
      box: { x1: cx - halfW, x2: cx + halfW, y1: cy + bottomOffset - 13, y2: cy + bottomOffset + 4 },
    },
  ];

  for (const c of candidates) {
    const inViewport = c.box.x1 >= 6 && c.box.x2 <= width - 6 && c.box.y1 >= 6 && c.box.y2 <= height - 4;
    if (!inViewport) {
      continue;
    }
    const clearOfRing = compact || !isNarrow || scopeMode !== 'radius15' || c.anchor === 'middle';
    if (!clearOfRing) {
      continue;
    }
    const blockedByMarker = markers.some(
      (m) => m.x >= c.box.x1 - 7 && m.x <= c.box.x2 + 7 && m.y >= c.box.y1 - 7 && m.y <= c.box.y2 + 7
    );
    const blockedByUi = boxesOverlap(c.box, compassBox) || edgeBadgeBoxes.some((b) => boxesOverlap(c.box, b));
    if (!blockedByMarker && !blockedByUi) {
      return c;
    }
  }

  return candidates[2].box.y1 >= 6 ? candidates[2] : candidates[0];
}

function makeLabelBox(
  lx: number,
  ly: number,
  anchor: 'start' | 'end',
  textW: number,
  fontSize: number
): SurveyBox {
  const ascent = Math.ceil(fontSize * 0.95);
  const descent = Math.ceil(fontSize * 0.3);
  return {
    x1: anchor === 'start' ? lx - 2 : lx - textW - 2,
    x2: anchor === 'start' ? lx + textW + 2 : lx + 2,
    y1: ly - ascent,
    y2: ly + descent,
  };
}

export function computeSurveyLabelLayout(params: {
  readonly markers: readonly NearbyPlaceMarker[];
  readonly centerPlacement: SurveyCenterPlacement;
  readonly edgeBadgeBoxes: readonly SurveyBox[];
  readonly compassBox: SurveyBox;
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  readonly compact: boolean;
  readonly isNarrow: boolean;
  readonly scopeMode: 'exact' | 'radius15' | 'county';
  readonly radiusPx: number;
}): ReadonlyMap<string, SurveyPlacedLabel> {
  const {
    markers,
    centerPlacement,
    edgeBadgeBoxes,
    compassBox,
    cx,
    cy,
    width,
    height,
    compact,
    isNarrow,
    scopeMode,
    radiusPx,
  } = params;

  const result = new Map<string, SurveyPlacedLabel>();
  if (compact || markers.length === 0) {
    return result;
  }

  const obstacles: SurveyBox[] = [
    {
      x1: centerPlacement.box.x1 - 6,
      x2: centerPlacement.box.x2 + 6,
      y1: centerPlacement.box.y1 - 4,
      y2: centerPlacement.box.y2 + 4,
    },
    compassBox,
    { x1: cx - 10, x2: cx + 10, y1: cy - 10, y2: cy + 10 },
    ...edgeBadgeBoxes,
  ];

  for (const m of markers) {
    obstacles.push({ x1: m.x - 7, x2: m.x + 7, y1: m.y - 7, y2: m.y + 7 });
  }

  const clusterCounts = new Map<string, number>();
  const skippedIds = new Set<string>();
  for (let i = 0; i < markers.length; i += 1) {
    if (skippedIds.has(markers[i].place.id)) {
      continue;
    }
    let extras = 0;
    for (let j = i + 1; j < markers.length; j += 1) {
      if (Math.hypot(markers[i].x - markers[j].x, markers[i].y - markers[j].y) < 7) {
        skippedIds.add(markers[j].place.id);
        extras += 1;
      }
    }
    clusterCounts.set(markers[i].place.id, extras);
  }

  const prioritized = [...markers]
    .filter((m) => !skippedIds.has(m.place.id))
    .sort((a, b) => {
      if (a.inRadius !== b.inRadius) {
        return a.inRadius ? -1 : 1;
      }
      return a.distanceMiles - b.distanceMiles;
    });

  const fontSize = isNarrow ? 12.5 : 11.5;

  const immediateDirs: readonly {
    readonly dx: number;
    readonly dy: number;
    readonly anchor: 'start' | 'end';
  }[] = [
    { dx: 10, dy: 4, anchor: 'start' },
    { dx: -10, dy: 4, anchor: 'end' },
    { dx: 8, dy: -8, anchor: 'start' },
    { dx: -8, dy: -8, anchor: 'end' },
    { dx: 8, dy: 14, anchor: 'start' },
    { dx: -8, dy: 14, anchor: 'end' },
    { dx: 0, dy: -12, anchor: 'start' },
    { dx: 0, dy: 18, anchor: 'start' },
  ];

  const leaderDirs: readonly {
    readonly dx: number;
    readonly dy: number;
    readonly anchor: 'start' | 'end';
  }[] = [
    { dx: 26, dy: 4, anchor: 'start' },
    { dx: -26, dy: 4, anchor: 'end' },
    { dx: 20, dy: -18, anchor: 'start' },
    { dx: -20, dy: -18, anchor: 'end' },
    { dx: 20, dy: 22, anchor: 'start' },
    { dx: -20, dy: 22, anchor: 'end' },
    { dx: 6, dy: -26, anchor: 'start' },
    { dx: -6, dy: 28, anchor: 'end' },
  ];

  for (const m of prioritized) {
    const extras = clusterCounts.get(m.place.id) ?? 0;
    const text = `${m.place.name} (${m.distanceMiles} mi${extras > 0 ? ` +${extras}` : ''})`;
    const textW = estimateMonoTextWidth(text, fontSize);
    const preferRight = m.x >= cx;

    const orderedImmediate = preferRight
      ? immediateDirs
      : [
          immediateDirs[1],
          immediateDirs[0],
          immediateDirs[3],
          immediateDirs[2],
          immediateDirs[5],
          immediateDirs[4],
          immediateDirs[6],
          immediateDirs[7],
        ];
    const orderedLeader = preferRight
      ? leaderDirs
      : [
          leaderDirs[1],
          leaderDirs[0],
          leaderDirs[3],
          leaderDirs[2],
          leaderDirs[5],
          leaderDirs[4],
          leaderDirs[6],
          leaderDirs[7],
        ];

    const allCandidates: {
      readonly lx: number;
      readonly ly: number;
      readonly anchor: 'start' | 'end';
      readonly usesLeader: boolean;
    }[] = [
      ...orderedImmediate.map((d) => ({
        lx: m.x + d.dx,
        ly: m.y + d.dy,
        anchor: d.anchor,
        usesLeader: false,
      })),
      ...orderedLeader.map((d) => ({
        lx: m.x + d.dx,
        ly: m.y + d.dy,
        anchor: d.anchor,
        usesLeader: true,
      })),
    ];

    let bestCandidate: {
      readonly score: number;
      readonly placement: SurveyPlacedLabel;
    } | null = null;

    for (const c of allCandidates) {
      const box = makeLabelBox(c.lx, c.ly, c.anchor, textW, fontSize);
      if (box.x1 < 8 || box.x2 > width - 8 || box.y1 < 8 || box.y2 > height - 6) {
        continue;
      }
      if (obstacles.some((obs) => boxesOverlap(box, obs))) {
        continue;
      }

      let score = c.usesLeader ? 15 : 0;
      if (scopeMode === 'radius15' && boxIntersectsCircleStroke(box, cx, cy, radiusPx, 3.5)) {
        score += 100;
      }
      for (const other of markers) {
        if (other.place.id === m.place.id) {
          continue;
        }
        if (boxIntersectsSegment(box, cx, cy, other.x, other.y)) {
          score += 40;
        }
      }

      if (bestCandidate === null || score < bestCandidate.score) {
        const leader = c.usesLeader
          ? {
              x1: m.x,
              y1: m.y,
              x2: c.anchor === 'start' ? box.x1 - 1 : box.x2 + 1,
              y2: (box.y1 + box.y2) / 2,
            }
          : undefined;
        bestCandidate = {
          score,
          placement: {
            placeId: m.place.id,
            text,
            lx: c.lx,
            ly: c.ly,
            anchor: c.anchor,
            extraCount: extras,
            box,
            leader,
          },
        };
        if (score === 0) {
          break;
        }
      }
    }

    if (bestCandidate) {
      obstacles.push(bestCandidate.placement.box);
      result.set(m.place.id, bestCandidate.placement);
    }
  }

  return result;
}
