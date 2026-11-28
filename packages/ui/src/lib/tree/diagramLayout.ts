import { assignBrandesKopfX } from './brandesKopf.js';
import {
  assignBusTracksWithConstraintGraph,
  BUS_LANE_SPACING,
  type BusConstraintInput,
} from './busConstraintRouting.js';
import {
  buildLayeredGraphWithDummyChannels,
  DUMMY_CHANNEL_WIDTH,
  type DummyChainEntry,
  makeLayeredEdgeKey,
  minimizeLayeredCrossings,
  type UnitFootprintSize,
} from './layeredChannels.js';
import type { UnionPortSlot } from './layeredPorts.js';
import {
  ARCHIVAL_EARLY_CHIP_H,
  ARCHIVAL_EARLY_CHIP_W,
  ARCHIVAL_EARLY_STRIP_GAP,
  ARCHIVAL_GEN_MIN_GAP,
  ARCHIVAL_HANGING_COL_GAP,
  ARCHIVAL_HANGING_ROW_GAP,
  ARCHIVAL_NODE_H,
  ARCHIVAL_NODE_W,
  ARCHIVAL_SPOUSE_GAP,
  type ArchivalDiagramLayout,
  type ArchivalTreeModel,
  type DiagramBounds,
  type DiagramEarlyLossChip,
  type DiagramEarlyLossStrip,
  type DiagramGenBand,
  type DiagramHangingGridRail,
  type DiagramOrthogonalBus,
  type DiagramOrthogonalDrop,
  type DiagramPlacedNode,
  type DiagramPoint,
  type DiagramSiblingToggle,
  type DiagramUnionHub,
  formatUnionOtherChildrenLabel,
  type TreeFamilyUnit,
} from './types.js';

interface ObstacleRect {
  readonly idx: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly ownerId: string;
  readonly kind: 'node' | 'early_strip' | 'sibling_toggle';
}

const OBSTACLE_PAD_X = 4;
const OBSTACLE_PAD_Y = 1;
const MIN_SAFE_CORRIDOR_X = 136;
const Y_STRIPE_SHIFT = 7; // 128px vertical buckets
const CHANNEL_TOP_MARGIN = 16;
const CHANNEL_BOTTOM_MARGIN = 16;
const LATERAL_STEM_GAP = 14;
const EARLY_STRIP_MIN_WIDTH = 194;
const EARLY_STRIP_PAD_X = 12;
const EARLY_CHIP_GAP = 8;
const EARLY_CHIP_MULTI_MIN_W = 128;

interface EarlyLossStripMetrics {
  readonly chipsPerRow: number;
  readonly chipRows: number;
  readonly chipWidth: number;
  readonly stripWidth: number;
  readonly stripHeight: number;
}

interface RawBusDrop {
  readonly childId: string;
  readonly railAttachX: number;
  readonly childCenterX: number;
  readonly toY: number;
  readonly isDirect: boolean;
  readonly dummyChain: readonly DummyChainEntry[] | undefined;
}

interface BusDraft {
  readonly union: ArchivalTreeModel['unions'][number];
  readonly hub: DiagramUnionHub;
  readonly rawDrops: readonly RawBusDrop[];
  readonly minChildTopY: number;
  readonly meanChildX: number;
  readonly railMinX: number;
  readonly railMaxX: number;
  readonly anyDirectDrop: boolean;
}

function computeEarlyLossStripMetrics(count: number): EarlyLossStripMetrics {
  const chipsPerRow = Math.min(3, count);
  const chipRows = Math.ceil(count / chipsPerRow);
  const minChipW =
    chipsPerRow === 1 ? ARCHIVAL_EARLY_CHIP_W : Math.max(ARCHIVAL_EARLY_CHIP_W, EARLY_CHIP_MULTI_MIN_W);
  const rawStripW =
    chipsPerRow * minChipW + Math.max(0, chipsPerRow - 1) * EARLY_CHIP_GAP + EARLY_STRIP_PAD_X * 2;
  const stripWidth = Math.max(EARLY_STRIP_MIN_WIDTH, rawStripW);
  const innerWidth = stripWidth - EARLY_STRIP_PAD_X * 2 - Math.max(0, chipsPerRow - 1) * EARLY_CHIP_GAP;
  const chipWidth = Math.floor(innerWidth / chipsPerRow);
  const stripHeight = 22 + chipRows * (ARCHIVAL_EARLY_CHIP_H + 6) + 4;
  return { chipsPerRow, chipRows, chipWidth, stripWidth, stripHeight };
}

function resolveLateralAttachmentSide(unit: TreeFamilyUnit, marriageOrder: number): 'left' | 'right' {
  if (unit.unionIds.length > 1 && marriageOrder === 1) {
    return 'left';
  }
  return 'right';
}

interface ObstacleSpatialIndex {
  readonly all: readonly ObstacleRect[];
  readonly stripes: ObstacleRect[][];
  readonly seenStamp: Int32Array;
  stamp: number;
}

function buildObstacleSpatialIndex(all: readonly ObstacleRect[], maxCoordY: number): ObstacleSpatialIndex {
  const numStripes = Math.max(1, ((maxCoordY + 256) >> Y_STRIPE_SHIFT) + 2);
  const stripes: ObstacleRect[][] = new Array(numStripes);
  for (let i = 0; i < numStripes; i += 1) {
    stripes[i] = [];
  }
  for (const obs of all) {
    const s0 = Math.max(0, (obs.top - OBSTACLE_PAD_Y) >> Y_STRIPE_SHIFT);
    const s1 = Math.min(numStripes - 1, Math.max(0, (obs.bottom + OBSTACLE_PAD_Y) >> Y_STRIPE_SHIFT));
    for (let s = s0; s <= s1; s += 1) {
      stripes[s]?.push(obs);
    }
  }
  return {
    all,
    stripes,
    seenStamp: new Int32Array(all.length),
    stamp: 0,
  };
}

function hasAnyVerticalBlocker(
  index: ObstacleSpatialIndex,
  x: number,
  y1: number,
  y2: number,
  skipNodeId1: string | null,
  skipNodeId2: string | null
): boolean {
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const stripes = index.stripes;
  const lastStripe = stripes.length - 1;
  const s0 = Math.max(0, Math.min(lastStripe, minY >> Y_STRIPE_SHIFT));
  const s1 = Math.max(0, Math.min(lastStripe, maxY >> Y_STRIPE_SHIFT));

  for (let s = s0; s <= s1; s += 1) {
    const bucket = stripes[s];
    if (!bucket) continue;
    for (const rect of bucket) {
      if (
        x >= rect.left - OBSTACLE_PAD_X &&
        x <= rect.right + OBSTACLE_PAD_X &&
        maxY > rect.top + OBSTACLE_PAD_Y &&
        minY < rect.bottom - OBSTACLE_PAD_Y
      ) {
        if (rect.kind === 'node' && (rect.ownerId === skipNodeId1 || rect.ownerId === skipNodeId2)) {
          continue;
        }
        return true;
      }
    }
  }
  return false;
}

function queryBandObstacles(
  index: ObstacleSpatialIndex,
  minY: number,
  maxY: number,
  skipNodeId1: string | null,
  skipNodeId2: string | null
): ObstacleRect[] {
  const stripes = index.stripes;
  const lastStripe = stripes.length - 1;
  const s0 = Math.max(0, Math.min(lastStripe, (minY - OBSTACLE_PAD_Y - 2) >> Y_STRIPE_SHIFT));
  const s1 = Math.max(0, Math.min(lastStripe, (maxY + OBSTACLE_PAD_Y + 2) >> Y_STRIPE_SHIFT));
  index.stamp += 1;
  const stamp = index.stamp;
  const seen = index.seenStamp;
  const out: ObstacleRect[] = [];

  for (let s = s0; s <= s1; s += 1) {
    const bucket = stripes[s];
    if (!bucket) continue;
    for (const obs of bucket) {
      if (seen[obs.idx] === stamp) {
        continue;
      }
      seen[obs.idx] = stamp;
      if (obs.kind === 'node' && (obs.ownerId === skipNodeId1 || obs.ownerId === skipNodeId2)) {
        continue;
      }
      if (obs.bottom >= minY - OBSTACLE_PAD_Y && obs.top <= maxY + OBSTACLE_PAD_Y) {
        out.push(obs);
      }
    }
  }
  return out;
}

function collapsePoints(raw: readonly DiagramPoint[]): DiagramPoint[] {
  const out: DiagramPoint[] = [];
  for (const pt of raw) {
    const rx = Math.round(pt.x);
    const ry = Math.round(pt.y);
    const len = out.length;
    if (len > 0) {
      const prev = out[len - 1];
      if (prev && prev.x === rx && prev.y === ry) {
        continue;
      }
      if (len > 1 && prev) {
        const prev2 = out[len - 2];
        if (prev2 && ((prev2.x === prev.x && prev.x === rx) || (prev2.y === prev.y && prev.y === ry))) {
          out[len - 1] = { x: rx, y: ry };
          continue;
        }
      }
    }
    out.push({ x: rx, y: ry });
  }
  return out;
}

function verticalSegmentHitsRect(x: number, y1: number, y2: number, rect: ObstacleRect): boolean {
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  return (
    x >= rect.left - OBSTACLE_PAD_X &&
    x <= rect.right + OBSTACLE_PAD_X &&
    maxY > rect.top + OBSTACLE_PAD_Y &&
    minY < rect.bottom - OBSTACLE_PAD_Y
  );
}

function horizontalSegmentHitsRect(x1: number, x2: number, y: number, rect: ObstacleRect): boolean {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  return (
    y >= rect.top - OBSTACLE_PAD_Y &&
    y <= rect.bottom + OBSTACLE_PAD_Y &&
    maxX > rect.left - OBSTACLE_PAD_X &&
    minX < rect.right + OBSTACLE_PAD_X
  );
}

function findBlockingObstaclesOnVertical(
  x: number,
  y1: number,
  y2: number,
  obstacles: readonly ObstacleRect[]
): ObstacleRect[] {
  const blockers: ObstacleRect[] = [];
  for (const obs of obstacles) {
    if (verticalSegmentHitsRect(x, y1, y2, obs)) {
      blockers.push(obs);
    }
  }
  return blockers;
}

function hasBlockingObstacleOnVertical(
  x: number,
  y1: number,
  y2: number,
  obstacles: readonly ObstacleRect[]
): boolean {
  for (const obs of obstacles) {
    if (verticalSegmentHitsRect(x, y1, y2, obs)) {
      return true;
    }
  }
  return false;
}

function hasHorizontalCollision(
  x1: number,
  x2: number,
  y: number,
  obstacles: readonly ObstacleRect[]
): boolean {
  for (const obs of obstacles) {
    if (horizontalSegmentHitsRect(x1, x2, y, obs)) {
      return true;
    }
  }
  return false;
}

function polylineHitsAnyObstacle(
  points: readonly DiagramPoint[],
  obstacles: readonly ObstacleRect[]
): boolean {
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    if (a.x === b.x) {
      if (hasBlockingObstacleOnVertical(a.x, a.y, b.y, obstacles)) {
        return true;
      }
    } else if (a.y === b.y) {
      if (hasHorizontalCollision(a.x, b.x, a.y, obstacles)) {
        return true;
      }
    }
  }
  return false;
}

function collectCorridorCandidates(params: {
  readonly preferredX: number;
  readonly y1: number;
  readonly y2: number;
  readonly obstacles: readonly ObstacleRect[];
  readonly maxContentX: number;
  readonly usedCorridorCounts: ReadonlyMap<number, number>;
}): number[] {
  const { preferredX, y1, y2, obstacles, maxContentX, usedCorridorCounts } = params;
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const relevant: ObstacleRect[] = [];
  for (const obs of obstacles) {
    if (maxY > obs.top + OBSTACLE_PAD_Y && minY < obs.bottom - OBSTACLE_PAD_Y) {
      relevant.push(obs);
    }
  }
  relevant.sort((a, b) => a.left - b.left);

  const candidates = new Set<number>();
  for (const obs of relevant) {
    candidates.add(Math.round(obs.left - 10));
    candidates.add(Math.round(obs.right + 10));
  }

  for (let i = 0; i < relevant.length - 1; i += 1) {
    const cur = relevant[i];
    const nxt = relevant[i + 1];
    if (!cur || !nxt) continue;
    const gapLeft = cur.right;
    const gapRight = nxt.left;
    if (gapRight - gapLeft >= 12) {
      candidates.add(Math.round((gapLeft + gapRight) / 2));
    }
  }

  candidates.add(MIN_SAFE_CORRIDOR_X);
  const outerRightBase = Math.round(maxContentX + 16);
  for (let slot = 0; slot < 12; slot += 1) {
    candidates.add(outerRightBase + slot * 10);
  }

  return [...candidates].toSorted((a, b) => {
    const usePenaltyA = (usedCorridorCounts.get(a) ?? 0) * 14;
    const usePenaltyB = (usedCorridorCounts.get(b) ?? 0) * 14;
    const costA = Math.abs(a - preferredX) + usePenaltyA;
    const costB = Math.abs(b - preferredX) + usePenaltyB;
    if (costA !== costB) {
      return costA - costB;
    }
    return a - b;
  });
}

function routeStemAroundObstacles(params: {
  readonly hubX: number;
  readonly hubY: number;
  readonly busY: number;
  readonly rowBottomOfParentsY: number;
  readonly preferredSideX: number;
  readonly spatialIndex: ObstacleSpatialIndex;
  readonly skipParent1: string | null;
  readonly skipParent2: string | null;
  readonly maxContentX: number;
  readonly usedCorridorCounts: Map<number, number>;
}): DiagramPoint[] {
  const {
    hubX,
    hubY,
    busY,
    rowBottomOfParentsY,
    preferredSideX,
    spatialIndex,
    skipParent1,
    skipParent2,
    maxContentX,
    usedCorridorCounts,
  } = params;

  if (!hasAnyVerticalBlocker(spatialIndex, hubX, hubY, busY, skipParent1, skipParent2)) {
    const rx = Math.round(hubX);
    const ry1 = Math.round(hubY);
    const ry2 = Math.round(busY);
    return ry1 === ry2
      ? [{ x: rx, y: ry1 }]
      : [
          { x: rx, y: ry1 },
          { x: rx, y: ry2 },
        ];
  }

  const minBandY = Math.min(hubY, busY);
  const maxBandY = Math.max(hubY, busY) + 16;
  const obstacles = queryBandObstacles(spatialIndex, minBandY, maxBandY, skipParent1, skipParent2);
  const blockers = findBlockingObstaclesOnVertical(hubX, hubY, busY, obstacles);
  const firstBlocker = blockers[0];
  if (!firstBlocker) {
    return collapsePoints([
      { x: hubX, y: hubY },
      { x: hubX, y: busY },
    ]);
  }

  let blockTop = firstBlocker.top;
  let blockBottom = firstBlocker.bottom;
  let blockLeft = firstBlocker.left;
  let blockRight = firstBlocker.right;
  for (let i = 1; i < blockers.length; i += 1) {
    const b = blockers[i];
    if (!b) continue;
    if (b.top < blockTop) blockTop = b.top;
    if (b.bottom > blockBottom) blockBottom = b.bottom;
    if (b.left < blockLeft) blockLeft = b.left;
    if (b.right > blockRight) blockRight = b.right;
  }

  const detourTopY = Math.round(Math.max(hubY + 4, Math.min(rowBottomOfParentsY + 8, blockTop - 8)));
  const detourBottomY = Math.round(Math.min(busY, blockBottom + 8));

  const primaryCandidates = [
    Math.round(blockRight + 10),
    Math.round(blockLeft - 10),
    Math.round(blockRight + 18),
    Math.round(blockLeft - 18),
  ].toSorted((a, b) => Math.abs(a - preferredSideX) - Math.abs(b - preferredSideX));

  const fallbackCandidates = collectCorridorCandidates({
    preferredX: preferredSideX,
    y1: detourTopY,
    y2: detourBottomY,
    obstacles,
    maxContentX,
    usedCorridorCounts,
  });

  const allCandidates = [...new Set([...primaryCandidates, ...fallbackCandidates])];
  let chosenX = Math.round(maxContentX + 24);

  for (const candX of allCandidates) {
    if (candX < MIN_SAFE_CORRIDOR_X) {
      continue;
    }
    if (
      !hasBlockingObstacleOnVertical(candX, detourTopY, detourBottomY, obstacles) &&
      !hasHorizontalCollision(hubX, candX, detourTopY, obstacles) &&
      !hasHorizontalCollision(candX, hubX, detourBottomY, obstacles)
    ) {
      chosenX = candX;
      break;
    }
  }

  usedCorridorCounts.set(chosenX, (usedCorridorCounts.get(chosenX) ?? 0) + 1);
  return collapsePoints([
    { x: hubX, y: hubY },
    { x: hubX, y: detourTopY },
    { x: chosenX, y: detourTopY },
    { x: chosenX, y: detourBottomY },
    { x: hubX, y: detourBottomY },
    { x: hubX, y: busY },
  ]);
}

function routeMultiGenDropThroughCorridors(params: {
  readonly busY: number;
  readonly childCenterX: number;
  readonly toY: number;
  readonly childId: string;
  readonly dummyChain: readonly DummyChainEntry[];
  readonly itemXById: ReadonlyMap<string, number>;
  readonly genBands: readonly DiagramGenBand[];
  readonly spatialIndex: ObstacleSpatialIndex;
}): DiagramPoint[] | null {
  const { busY, childCenterX, toY, childId, dummyChain, itemXById, genBands, spatialIndex } = params;
  const corridorXs: number[] = [];
  for (const entry of dummyChain) {
    const dummyLeft = itemXById.get(entry.dummyId);
    if (dummyLeft === undefined) {
      return null;
    }
    corridorXs.push(Math.round(dummyLeft + DUMMY_CHANNEL_WIDTH / 2));
  }
  const firstCorridorX = corridorXs[0];
  if (firstCorridorX === undefined) {
    return null;
  }

  const obstacles = queryBandObstacles(spatialIndex, Math.min(busY, toY), Math.max(busY, toY), childId, null);

  const buildPathWithEntryY = (entryY: number): DiagramPoint[] => {
    const pts: DiagramPoint[] = [{ x: firstCorridorX, y: busY }];
    for (let i = 0; i < corridorXs.length - 1; i += 1) {
      const cx = corridorXs[i];
      const nx = corridorXs[i + 1];
      if (cx !== undefined && nx !== undefined && cx !== nx) {
        const entryA = dummyChain[i];
        const entryB = dummyChain[i + 1];
        const bandA = entryA ? genBands[entryA.layerIndex] : undefined;
        const bandB = entryB ? genBands[entryB.layerIndex] : undefined;
        const midChannelY =
          bandA && bandB
            ? Math.round((bandA.y + bandA.height + bandB.y) / 2)
            : Math.round((busY + entryY) / 2);
        pts.push({ x: cx, y: midChannelY }, { x: nx, y: midChannelY });
      }
    }
    const lastX = corridorXs[corridorXs.length - 1] ?? firstCorridorX;
    if (lastX !== childCenterX) {
      pts.push({ x: lastX, y: entryY }, { x: childCenterX, y: entryY });
    }
    pts.push({ x: childCenterX, y: toY });
    return collapsePoints(pts);
  };

  const entryCandidates = [
    Math.round(Math.max(busY, toY - 10)),
    Math.round(Math.max(busY, toY - 6)),
    Math.round(Math.max(busY, toY - 14)),
    Math.round(Math.max(busY, toY - 4)),
  ];

  for (const entryY of entryCandidates) {
    const candidate = buildPathWithEntryY(entryY);
    if (!polylineHitsAnyObstacle(candidate, obstacles)) {
      return candidate;
    }
  }
  return null;
}

function routeChildDropAroundObstacles(params: {
  readonly dropX: number;
  readonly targetX: number;
  readonly busY: number;
  readonly toY: number;
  readonly childId: string;
  readonly spatialIndex: ObstacleSpatialIndex;
  readonly maxContentX: number;
  readonly usedCorridorCounts: Map<number, number>;
}): DiagramPoint[] {
  const { dropX, targetX, busY, toY, childId, spatialIndex, maxContentX, usedCorridorCounts } = params;

  if (dropX === targetX && !hasAnyVerticalBlocker(spatialIndex, dropX, busY, toY, childId, null)) {
    const rx = Math.round(dropX);
    const ry1 = Math.round(busY);
    const ry2 = Math.round(toY);
    return ry1 === ry2
      ? [{ x: rx, y: ry1 }]
      : [
          { x: rx, y: ry1 },
          { x: rx, y: ry2 },
        ];
  }

  const obstacles = queryBandObstacles(spatialIndex, Math.min(busY, toY), Math.max(busY, toY), childId, null);
  if (dropX === targetX && !hasBlockingObstacleOnVertical(dropX, busY, toY, obstacles)) {
    return collapsePoints([
      { x: dropX, y: busY },
      { x: dropX, y: toY },
    ]);
  }

  const primaryReturnY = Math.round(Math.max(busY, toY - 10));
  const returnYCandidates = [
    primaryReturnY,
    Math.round(Math.max(busY, toY - 6)),
    Math.round(Math.max(busY, toY - 14)),
    Math.round(Math.max(busY, toY - 4)),
  ];

  const candidates = collectCorridorCandidates({
    preferredX: targetX,
    y1: busY,
    y2: primaryReturnY,
    obstacles,
    maxContentX,
    usedCorridorCounts,
  });

  for (const returnY of returnYCandidates) {
    for (const candX of candidates) {
      if (candX < MIN_SAFE_CORRIDOR_X) {
        continue;
      }
      if (
        !hasBlockingObstacleOnVertical(candX, busY, returnY, obstacles) &&
        !hasHorizontalCollision(dropX, candX, busY, obstacles) &&
        !hasHorizontalCollision(candX, targetX, returnY, obstacles)
      ) {
        usedCorridorCounts.set(candX, (usedCorridorCounts.get(candX) ?? 0) + 1);
        return collapsePoints([
          { x: dropX, y: busY },
          { x: candX, y: busY },
          { x: candX, y: returnY },
          { x: targetX, y: returnY },
          { x: targetX, y: toY },
        ]);
      }
    }
  }

  // Guaranteed clear outer corridor past the rightmost obstacle in the band.
  let maxObsRight = maxContentX;
  for (const obs of obstacles) {
    if (obs.right > maxObsRight) {
      maxObsRight = obs.right;
    }
  }
  const outerX = Math.round(maxObsRight + 16 + (usedCorridorCounts.size % 6) * 8);
  const safeReturnY = primaryReturnY;
  usedCorridorCounts.set(outerX, (usedCorridorCounts.get(outerX) ?? 0) + 1);
  return collapsePoints([
    { x: dropX, y: busY },
    { x: outerX, y: busY },
    { x: outerX, y: safeReturnY },
    { x: targetX, y: safeReturnY },
    { x: targetX, y: toY },
  ]);
}

function computeUnitFootprint(
  model: ArchivalTreeModel,
  unit: TreeFamilyUnit,
  ports: ReadonlyMap<string, UnionPortSlot>
): UnitFootprintSize {
  const memberSpan =
    unit.orderedMemberIds.length * ARCHIVAL_NODE_W +
    Math.max(0, unit.orderedMemberIds.length - 1) * ARCHIVAL_SPOUSE_GAP;

  let minRelX = 0;
  let maxRelX = memberSpan;

  for (const unionId of unit.unionIds) {
    const union = model.unionsById.get(unionId);
    if (!union) {
      continue;
    }
    const portSlot = ports.get(union.id);
    if (!portSlot) {
      continue;
    }
    const hubRelX = portSlot.relativeX;
    const hasBusStem = union.visibleChildIds.length > 0;
    const lateralSide = resolveLateralAttachmentSide(unit, union.marriageOrder);
    const earlySide = lateralSide;

    if (union.earlyLossChildIds.length > 0) {
      const { stripWidth } = computeEarlyLossStripMetrics(union.earlyLossChildIds.length);
      const stripLeft = hasBusStem
        ? earlySide === 'right'
          ? hubRelX + LATERAL_STEM_GAP
          : hubRelX - LATERAL_STEM_GAP - stripWidth
        : Math.round(hubRelX - stripWidth / 2);
      const stripRight = stripLeft + stripWidth;
      if (stripLeft < minRelX) minRelX = stripLeft;
      if (stripRight > maxRelX) maxRelX = stripRight;
    }

    const totalCollateral = union.collapsedSiblingIds.length + union.hangingChildIds.length;
    if (totalCollateral > 0) {
      const toggleLabels = formatUnionOtherChildrenLabel({
        hiddenCount: union.collapsedSiblingIds.length,
        totalCollateralCount: totalCollateral,
        visibleChildCount: union.visibleChildIds.length,
        isExpanded: union.isExpanded,
        mode: model.effectiveMode,
      });
      const pillW = Math.max(168, Math.round(toggleLabels.compactLabel.length * 7.2 + 28));
      const placeToggleLaterally = hasBusStem && union.hangingChildIds.length === 0;
      const toggleSide =
        unit.unionIds.length === 1 && union.earlyLossChildIds.length > 0
          ? earlySide === 'right'
            ? 'left'
            : 'right'
          : lateralSide;
      const detourPad = hasBusStem && !placeToggleLaterally ? 14 : 0;
      const pillLeft = placeToggleLaterally
        ? toggleSide === 'right'
          ? hubRelX + LATERAL_STEM_GAP
          : hubRelX - LATERAL_STEM_GAP - pillW
        : Math.round(hubRelX - pillW / 2) - detourPad;
      const pillRight = placeToggleLaterally ? pillLeft + pillW : pillLeft + pillW + detourPad * 2;
      if (pillLeft < minRelX) minRelX = pillLeft;
      if (pillRight > maxRelX) maxRelX = pillRight;
    }

    if (union.hangingChildIds.length > 0) {
      const cols = union.hangingChildIds.length === 1 ? 1 : 2;
      const gridW = cols * ARCHIVAL_NODE_W + (cols === 2 ? ARCHIVAL_HANGING_COL_GAP : 0);
      const detourPad = hasBusStem ? 14 : 0;
      const gridLeft = Math.round(hubRelX - gridW / 2) - detourPad;
      const gridRight = Math.round(hubRelX + gridW / 2) + detourPad;
      if (gridLeft < minRelX) minRelX = gridLeft;
      if (gridRight > maxRelX) maxRelX = gridRight;
    }
  }

  return {
    width: maxRelX - minRelX,
    memberOffsetX: -minRelX,
  };
}

function buildOrthogonalBuses(params: {
  readonly model: ArchivalTreeModel;
  readonly hubByUnionId: ReadonlyMap<string, DiagramUnionHub>;
  readonly byId: ReadonlyMap<string, DiagramPlacedNode>;
  readonly genBands: readonly DiagramGenBand[];
  readonly genBandIdxByGen: ReadonlyMap<number, number>;
  readonly spatialIndex: ObstacleSpatialIndex;
  readonly maxContentX: number;
  readonly dummyChainsByEdgeKey: ReadonlyMap<string, readonly DummyChainEntry[]>;
  readonly itemXById: ReadonlyMap<string, number>;
}): DiagramOrthogonalBus[] {
  const {
    model,
    hubByUnionId,
    byId,
    genBands,
    genBandIdxByGen,
    spatialIndex,
    maxContentX,
    dummyChainsByEdgeKey,
    itemXById,
  } = params;
  const draftsByGen = new Map<number, BusDraft[]>();
  const orderedGens: number[] = [];

  for (const union of model.unions) {
    if (union.visibleChildIds.length === 0) {
      continue;
    }
    const hub = hubByUnionId.get(union.id);
    if (!hub) {
      continue;
    }

    const rawDrops: RawBusDrop[] = [];
    let minChildTopY = Number.POSITIVE_INFINITY;
    let sumChildX = 0;
    let railMinX = hub.x;
    let railMaxX = hub.x;
    let anyDirectDrop = false;

    for (const cid of union.visibleChildIds) {
      const childNode = byId.get(cid);
      if (!childNode) {
        continue;
      }
      const childCenterX = Math.round(childNode.x + childNode.width / 2);
      const dummyChain = dummyChainsByEdgeKey.get(makeLayeredEdgeKey(union.id, cid));
      let railAttachX = childCenterX;
      const firstDummy = dummyChain?.[0];
      if (firstDummy) {
        const firstDummyLeft = itemXById.get(firstDummy.dummyId);
        if (firstDummyLeft !== undefined) {
          railAttachX = Math.round(firstDummyLeft + DUMMY_CHANNEL_WIDTH / 2);
        }
      }

      rawDrops.push({
        childId: cid,
        railAttachX,
        childCenterX,
        toY: childNode.y,
        isDirect: childNode.isDirect,
        dummyChain,
      });
      sumChildX += childCenterX;
      if (childNode.y < minChildTopY) minChildTopY = childNode.y;
      if (railAttachX < railMinX) railMinX = railAttachX;
      if (railAttachX > railMaxX) railMaxX = railAttachX;
      if (childNode.isDirect) anyDirectDrop = true;
    }

    if (rawDrops.length === 0) {
      continue;
    }

    let bucket = draftsByGen.get(union.gen);
    if (!bucket) {
      bucket = [];
      draftsByGen.set(union.gen, bucket);
      orderedGens.push(union.gen);
    }
    bucket.push({
      union,
      hub,
      rawDrops,
      minChildTopY,
      meanChildX: sumChildX / rawDrops.length,
      railMinX,
      railMaxX,
      anyDirectDrop,
    });
  }

  const buses: DiagramOrthogonalBus[] = [];
  const usedCorridorCounts = new Map<number, number>();

  for (const gen of orderedGens) {
    const drafts = draftsByGen.get(gen);
    if (!drafts || drafts.length === 0) {
      continue;
    }

    const draftById = new Map<string, BusDraft>();
    const constraintInputs: BusConstraintInput[] = drafts.map((d) => {
      draftById.set(d.union.id, d);
      return {
        id: d.union.id,
        hubX: d.hub.x,
        dropXs: d.rawDrops.map((drop) => drop.railAttachX),
        railMinX: d.railMinX,
        railMaxX: d.railMaxX,
      };
    });

    const trackAssignments = assignBusTracksWithConstraintGraph(constraintInputs);
    const genBandIdx = genBandIdxByGen.get(gen) ?? -1;
    const genBand = genBandIdx >= 0 ? genBands[genBandIdx] : undefined;
    const nextBand = genBandIdx >= 0 ? genBands[genBandIdx + 1] : undefined;

    for (const assignment of trackAssignments) {
      const draft = draftById.get(assignment.id);
      if (!draft) {
        continue;
      }
      const { union, hub, rawDrops, minChildTopY, meanChildX, railMinX, railMaxX, anyDirectDrop } = draft;

      const channelStartY = genBand ? genBand.y + genBand.height + CHANNEL_TOP_MARGIN : hub.y + 32;
      const rawBusY = channelStartY + assignment.trackIndex * BUS_LANE_SPACING;
      const channelCapY = nextBand
        ? Math.min(minChildTopY - CHANNEL_BOTTOM_MARGIN, nextBand.y - CHANNEL_BOTTOM_MARGIN)
        : minChildTopY - CHANNEL_BOTTOM_MARGIN;
      const busY = Math.round(Math.min(channelCapY, Math.max(hub.y + 20, rawBusY)));

      const rowBottomOfParentsY = genBand ? genBand.y + ARCHIVAL_NODE_H : hub.y + ARCHIVAL_NODE_H / 2;

      const stemPoints = routeStemAroundObstacles({
        hubX: hub.x,
        hubY: hub.y + 8,
        busY,
        rowBottomOfParentsY,
        preferredSideX: meanChildX,
        spatialIndex,
        skipParent1: union.primaryPartnerId,
        skipParent2: union.secondaryPartnerId,
        maxContentX,
        usedCorridorCounts,
      });

      const childDrops: DiagramOrthogonalDrop[] = [];
      const childIds: string[] = [];
      for (const drop of rawDrops) {
        childIds.push(drop.childId);
        let points: DiagramPoint[] | null = null;
        if (drop.dummyChain && drop.dummyChain.length > 0) {
          points = routeMultiGenDropThroughCorridors({
            busY,
            childCenterX: drop.childCenterX,
            toY: drop.toY,
            childId: drop.childId,
            dummyChain: drop.dummyChain,
            itemXById,
            genBands,
            spatialIndex,
          });
        }
        if (!points) {
          points = routeChildDropAroundObstacles({
            dropX: drop.railAttachX,
            targetX: drop.childCenterX,
            busY,
            toY: drop.toY,
            childId: drop.childId,
            spatialIndex,
            maxContentX,
            usedCorridorCounts,
          });
        }
        childDrops.push({
          childId: drop.childId,
          x: drop.railAttachX,
          toY: drop.toY,
          isDirect: drop.isDirect,
          points,
        });
      }

      buses.push({
        unionId: union.id,
        parentIds: union.partnerIds,
        childIds,
        isDirect: union.isDirect && anyDirectDrop,
        hubX: hub.x,
        hubY: hub.y + 8,
        busY,
        railMinX,
        railMaxX,
        stemPoints,
        childDrops,
      });
    }
  }

  return buses;
}

function computeDiagramBounds(params: {
  readonly leftPad: number;
  readonly maxRightX: number;
  readonly cursorY: number;
  readonly nodes: readonly DiagramPlacedNode[];
  readonly earlyLossStrips: readonly DiagramEarlyLossStrip[];
  readonly siblingToggles: readonly DiagramSiblingToggle[];
  readonly buses: readonly DiagramOrthogonalBus[];
}): DiagramBounds {
  let minX = 0;
  let maxX = params.maxRightX + params.leftPad;
  let maxY = params.cursorY + 32;

  for (const n of params.nodes) {
    if (n.x + n.width + 64 > maxX) maxX = n.x + n.width + 64;
    if (n.y + n.height + 64 > maxY) maxY = n.y + n.height + 64;
    if (n.x - 40 < minX) minX = n.x - 40;
  }
  for (const s of params.earlyLossStrips) {
    if (s.x + s.width + 48 > maxX) maxX = s.x + s.width + 48;
    if (s.y + s.height + 48 > maxY) maxY = s.y + s.height + 48;
  }
  for (const t of params.siblingToggles) {
    if (t.x + t.width + 48 > maxX) maxX = t.x + t.width + 48;
    if (t.y + t.height + 48 > maxY) maxY = t.y + t.height + 48;
  }
  for (const b of params.buses) {
    for (const pt of b.stemPoints) {
      const px = pt.x + 32;
      if (px > maxX) maxX = px;
    }
    for (const drop of b.childDrops) {
      for (const pt of drop.points) {
        const px = pt.x + 32;
        if (px > maxX) maxX = px;
      }
    }
  }

  return {
    minX: Math.min(0, Math.round(minX)),
    maxX: Math.max(640, Math.round(maxX)),
    minY: 0,
    maxY: Math.max(420, Math.round(maxY)),
  };
}

export function computeArchivalDiagramLayout(model: ArchivalTreeModel): ArchivalDiagramLayout {
  const numGens = model.generations.length;
  if (numGens === 0) {
    return {
      nodes: [],
      byId: new Map(),
      hubs: [],
      buses: [],
      hangingRails: [],
      siblingToggles: [],
      earlyLossStrips: [],
      genBands: [],
      bounds: { minX: 0, maxX: 960, minY: 0, maxY: 600 },
    };
  }

  const leftPad = 148;
  const topPad = 48;

  // 1-3: Fixed marriage ports + multi-gen dummy channels + crossing minimization + Brandes-Kopf X placement.
  const rawGraph = buildLayeredGraphWithDummyChannels(model, computeUnitFootprint);
  const layeredGraph = minimizeLayeredCrossings(rawGraph);
  const itemXById = assignBrandesKopfX(layeredGraph, leftPad);

  const activeBusCountByGen = new Map<number, number>();
  for (const union of model.unions) {
    if (union.visibleChildIds.length > 0) {
      activeBusCountByGen.set(union.gen, (activeBusCountByGen.get(union.gen) ?? 0) + 1);
    }
  }

  const nodes: DiagramPlacedNode[] = [];
  const byId = new Map<string, DiagramPlacedNode>();
  const hubs: DiagramUnionHub[] = [];
  const hubByUnionId = new Map<string, DiagramUnionHub>();
  const hangingRails: DiagramHangingGridRail[] = [];
  const siblingToggles: DiagramSiblingToggle[] = [];
  const earlyLossStrips: DiagramEarlyLossStrip[] = [];
  const genBands: DiagramGenBand[] = new Array(numGens);
  const genBandIdxByGen = new Map<number, number>();

  let cursorY = topPad;
  let maxRightX = leftPad;

  for (const [gIdx, g] of model.generations.entries()) {
    const layerItems = layeredGraph.layers[gIdx] ?? [];
    const rowTopY = cursorY;
    let rowBottomY = rowTopY + ARCHIVAL_NODE_H;

    for (const layerItem of layerItems) {
      const itemLeftX = itemXById.get(layerItem.id) ?? leftPad;
      if (itemLeftX + layerItem.width > maxRightX) {
        maxRightX = itemLeftX + layerItem.width;
      }
      if (layerItem.kind === 'dummy') {
        continue;
      }

      const unit = layerItem.unit;
      const memberStartX = itemLeftX + layerItem.memberOffsetX;
      const unitPorts = layeredGraph.portsByUnitId.get(unit.id);

      for (const [idx, pid] of unit.orderedMemberIds.entries()) {
        const person = model.peopleById.get(pid);
        if (!person) {
          continue;
        }
        const placed: DiagramPlacedNode = {
          person,
          x: Math.round(memberStartX + idx * (ARCHIVAL_NODE_W + ARCHIVAL_SPOUSE_GAP)),
          y: Math.round(rowTopY),
          width: ARCHIVAL_NODE_W,
          height: ARCHIVAL_NODE_H,
          gen: g.gen,
          isDirect: model.directPersonIds.has(pid),
          placement: 'rank',
          unionId: null,
        };
        nodes.push(placed);
        byId.set(pid, placed);
      }

      const unitPlacedRects: { left: number; right: number; bottom: number }[] = [];
      const resolveAttachmentTopY = (left: number, right: number, baseTopY: number): number => {
        let y = baseTopY;
        for (const prior of unitPlacedRects) {
          if (left < prior.right + 14 && right > prior.left - 14 && prior.bottom + 14 > y) {
            y = prior.bottom + 14;
          }
        }
        return y;
      };

      let priorHangingBottomY: number | null = null;
      for (const unionId of unit.unionIds) {
        const union = model.unionsById.get(unionId);
        if (!union) {
          continue;
        }
        const primaryNode = byId.get(union.primaryPartnerId);
        if (!primaryNode) {
          continue;
        }
        const portSlot = unitPorts?.get(union.id);
        const secondaryNode = union.secondaryPartnerId ? byId.get(union.secondaryPartnerId) : undefined;

        let hub: DiagramUnionHub;
        if (portSlot?.isCouple && secondaryNode) {
          const midX = Math.round(memberStartX + portSlot.relativeX);
          const midY = Math.round(rowTopY + ARCHIVAL_NODE_H / 2);
          hub = {
            union,
            x: midX,
            y: midY,
            leftPartnerId: portSlot.leftPartnerId,
            rightPartnerId: portSlot.rightPartnerId,
            connectorY: midY,
            leftX: Math.round(memberStartX + portSlot.leftRelX),
            rightX: Math.round(memberStartX + portSlot.rightRelX),
          };
        } else {
          const midX = portSlot
            ? Math.round(memberStartX + portSlot.relativeX)
            : Math.round(primaryNode.x + primaryNode.width / 2);
          const midY = Math.round(rowTopY + ARCHIVAL_NODE_H + 10);
          hub = {
            union,
            x: midX,
            y: midY,
            leftPartnerId: primaryNode.person.id,
            rightPartnerId: null,
            connectorY: midY,
            leftX: midX,
            rightX: midX,
          };
        }

        hubs.push(hub);
        hubByUnionId.set(union.id, hub);
        if (hub.y + 10 > rowBottomY) {
          rowBottomY = hub.y + 10;
        }

        const hasBusStem = union.visibleChildIds.length > 0;
        const lateralSide = resolveLateralAttachmentSide(unit, union.marriageOrder);
        const baseAttachmentY = rowTopY + ARCHIVAL_NODE_H + 16;
        let centeredAttachmentY = baseAttachmentY;
        if (priorHangingBottomY !== null && union.hangingChildIds.length > 0) {
          centeredAttachmentY = Math.max(centeredAttachmentY, priorHangingBottomY + 18);
        }
        let centeredStemFromY = hub.y + 8;

        if (union.earlyLossChildIds.length > 0) {
          const metrics = computeEarlyLossStripMetrics(union.earlyLossChildIds.length);
          const { chipsPerRow, chipWidth, stripWidth: stripW, stripHeight: stripH } = metrics;
          const stripX = hasBusStem
            ? lateralSide === 'right'
              ? Math.round(hub.x + LATERAL_STEM_GAP)
              : Math.round(hub.x - LATERAL_STEM_GAP - stripW)
            : Math.round(hub.x - stripW / 2);
          const stripY = Math.round(resolveAttachmentTopY(stripX, stripX + stripW, baseAttachmentY));

          const chips: DiagramEarlyLossChip[] = [];
          for (const [cIdx, cid] of union.earlyLossChildIds.entries()) {
            const child = model.peopleById.get(cid);
            if (!child) {
              continue;
            }
            const col = cIdx % chipsPerRow;
            const row = Math.floor(cIdx / chipsPerRow);
            chips.push({
              person: child,
              unionId: union.id,
              x: stripX + EARLY_STRIP_PAD_X + col * (chipWidth + EARLY_CHIP_GAP),
              y: stripY + 20 + row * (ARCHIVAL_EARLY_CHIP_H + 6),
              width: chipWidth,
              height: ARCHIVAL_EARLY_CHIP_H,
            });
          }

          earlyLossStrips.push({
            unionId: union.id,
            parentIds: union.partnerIds,
            x: stripX,
            y: stripY,
            width: stripW,
            height: stripH,
            stemFromX: hub.x,
            stemFromY: hub.y + 8,
            chips,
          });
          unitPlacedRects.push({ left: stripX, right: stripX + stripW, bottom: stripY + stripH });
          if (!hasBusStem) {
            centeredStemFromY = stripY + stripH;
            centeredAttachmentY = Math.max(centeredAttachmentY, stripY + stripH + ARCHIVAL_EARLY_STRIP_GAP);
          }
          if (stripY + stripH > rowBottomY) rowBottomY = stripY + stripH;
        }

        const totalCollateral = union.collapsedSiblingIds.length + union.hangingChildIds.length;
        if (totalCollateral > 0) {
          const toggleLabels = formatUnionOtherChildrenLabel({
            hiddenCount: union.collapsedSiblingIds.length,
            totalCollateralCount: totalCollateral,
            visibleChildCount: union.visibleChildIds.length,
            isExpanded: union.isExpanded,
            mode: model.effectiveMode,
          });
          const pillW = Math.max(168, Math.round(toggleLabels.compactLabel.length * 7.2 + 28));
          const pillH = 28;
          const placeToggleLaterally = hasBusStem && union.hangingChildIds.length === 0;
          const toggleSide =
            unit.unionIds.length === 1 && union.earlyLossChildIds.length > 0
              ? lateralSide === 'right'
                ? 'left'
                : 'right'
              : lateralSide;
          const pillX = placeToggleLaterally
            ? toggleSide === 'right'
              ? Math.round(hub.x + LATERAL_STEM_GAP)
              : Math.round(hub.x - LATERAL_STEM_GAP - pillW)
            : Math.round(hub.x - pillW / 2);
          const pillBaseY = placeToggleLaterally ? baseAttachmentY : centeredAttachmentY;
          const pillY = Math.round(resolveAttachmentTopY(pillX, pillX + pillW, pillBaseY));
          siblingToggles.push({
            unionId: union.id,
            parentIds: union.partnerIds,
            x: pillX,
            y: pillY,
            width: pillW,
            height: pillH,
            stemFromX: hub.x,
            stemFromY: placeToggleLaterally ? hub.y + 8 : centeredStemFromY,
            hiddenCount: union.collapsedSiblingIds.length,
            totalCollateralCount: totalCollateral,
            visibleChildCount: union.visibleChildIds.length,
            mode: model.effectiveMode,
            isExpanded: union.isExpanded,
            isDirect: union.isDirect,
          });
          unitPlacedRects.push({ left: pillX, right: pillX + pillW, bottom: pillY + pillH });
          if (!placeToggleLaterally) {
            centeredStemFromY = pillY + pillH;
            centeredAttachmentY = pillY + pillH + 12;
          }
          if (pillY + pillH > rowBottomY) rowBottomY = pillY + pillH;
        }

        if (union.hangingChildIds.length > 0) {
          const cols = union.hangingChildIds.length === 1 ? 1 : 2;
          const spineX = hub.x;
          const gridW = cols * ARCHIVAL_NODE_W + (cols === 2 ? ARCHIVAL_HANGING_COL_GAP : 0);
          const gridTopY = Math.round(
            resolveAttachmentTopY(spineX - gridW / 2, spineX + gridW / 2, centeredAttachmentY)
          );
          const ticks: {
            childId: string;
            y: number;
            side: 'left' | 'right';
            toX: number;
          }[] = [];
          let maxGridY = gridTopY;
          let maxTickY = gridTopY;

          for (const [hIdx, cid] of union.hangingChildIds.entries()) {
            const child = model.peopleById.get(cid);
            if (!child) {
              continue;
            }
            const col = cols === 1 ? 0 : hIdx % 2;
            const row = cols === 1 ? hIdx : Math.floor(hIdx / 2);
            const y = gridTopY + row * (ARCHIVAL_NODE_H + ARCHIVAL_HANGING_ROW_GAP);
            const x =
              cols === 1
                ? Math.round(spineX - ARCHIVAL_NODE_W / 2)
                : col === 0
                  ? Math.round(spineX - ARCHIVAL_HANGING_COL_GAP / 2 - ARCHIVAL_NODE_W)
                  : Math.round(spineX + ARCHIVAL_HANGING_COL_GAP / 2);

            const placed: DiagramPlacedNode = {
              person: child,
              x,
              y,
              width: ARCHIVAL_NODE_W,
              height: ARCHIVAL_NODE_H,
              gen: g.gen + 1,
              isDirect: false,
              placement: 'hanging',
              unionId: union.id,
            };
            nodes.push(placed);
            byId.set(cid, placed);

            const tickY = Math.round(y + ARCHIVAL_NODE_H / 2);
            if (cols === 2) {
              ticks.push({
                childId: cid,
                y: tickY,
                side: col === 0 ? 'left' : 'right',
                toX: col === 0 ? x + ARCHIVAL_NODE_W : x,
              });
              if (tickY > maxTickY) maxTickY = tickY;
            }
            if (y + ARCHIVAL_NODE_H > maxGridY) maxGridY = y + ARCHIVAL_NODE_H;
          }

          hangingRails.push({
            unionId: union.id,
            parentIds: union.partnerIds,
            childIds: union.hangingChildIds,
            spineX,
            topY: centeredStemFromY,
            bottomY: ticks.length > 0 ? maxTickY : gridTopY,
            ticks,
          });
          unitPlacedRects.push({
            left: spineX - gridW / 2,
            right: spineX + gridW / 2,
            bottom: maxGridY,
          });
          priorHangingBottomY = maxGridY;
          if (maxGridY > rowBottomY) rowBottomY = maxGridY;
        }
      }
    }

    const activeBusCount = activeBusCountByGen.get(g.gen) ?? 0;
    const neededChannelHeight =
      activeBusCount > 0
        ? CHANNEL_TOP_MARGIN + Math.max(0, activeBusCount - 1) * BUS_LANE_SPACING + CHANNEL_BOTTOM_MARGIN
        : ARCHIVAL_GEN_MIN_GAP;
    const channelHeight = Math.max(ARCHIVAL_GEN_MIN_GAP, neededChannelHeight);

    const band: DiagramGenBand = {
      gen: g.gen,
      y: rowTopY,
      height: rowBottomY - rowTopY,
      label: g.label,
      yearRange: g.yearRange,
    };
    genBands[gIdx] = band;
    genBandIdxByGen.set(g.gen, gIdx);

    cursorY = rowBottomY + channelHeight;
  }

  const totalObstacles = nodes.length + earlyLossStrips.length + siblingToggles.length;
  const allObstacles = new Array<ObstacleRect>(totalObstacles);
  let maxContentX = maxRightX;
  let maxObstacleY = cursorY;
  let oCursor = 0;

  for (const n of nodes) {
    const right = n.x + n.width;
    const bottom = n.y + n.height;
    if (right > maxContentX) maxContentX = right;
    if (bottom > maxObstacleY) maxObstacleY = bottom;
    allObstacles[oCursor] = {
      idx: oCursor,
      left: n.x,
      right,
      top: n.y,
      bottom,
      ownerId: n.person.id,
      kind: 'node',
    };
    oCursor += 1;
  }
  for (const s of earlyLossStrips) {
    const right = s.x + s.width;
    const bottom = s.y + s.height;
    if (right > maxContentX) maxContentX = right;
    if (bottom > maxObstacleY) maxObstacleY = bottom;
    allObstacles[oCursor] = {
      idx: oCursor,
      left: s.x,
      right,
      top: s.y,
      bottom,
      ownerId: s.unionId,
      kind: 'early_strip',
    };
    oCursor += 1;
  }
  for (const t of siblingToggles) {
    const right = t.x + t.width;
    const bottom = t.y + t.height;
    if (right > maxContentX) maxContentX = right;
    if (bottom > maxObstacleY) maxObstacleY = bottom;
    allObstacles[oCursor] = {
      idx: oCursor,
      left: t.x,
      right,
      top: t.y,
      bottom,
      ownerId: t.unionId,
      kind: 'sibling_toggle',
    };
    oCursor += 1;
  }

  const spatialIndex = buildObstacleSpatialIndex(allObstacles, maxObstacleY);

  const buses = buildOrthogonalBuses({
    model,
    hubByUnionId,
    byId,
    genBands,
    genBandIdxByGen,
    spatialIndex,
    maxContentX,
    dummyChainsByEdgeKey: layeredGraph.dummyChainsByEdgeKey,
    itemXById,
  });
  const bounds = computeDiagramBounds({
    leftPad,
    maxRightX,
    cursorY,
    nodes,
    earlyLossStrips,
    siblingToggles,
    buses,
  });

  return {
    nodes,
    byId,
    hubs,
    buses,
    hangingRails,
    siblingToggles,
    earlyLossStrips,
    genBands,
    bounds,
  };
}
