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
  ARCHIVAL_UNIT_GAP,
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
  for (let i = 0; i < all.length; i += 1) {
    const obs = all[i];
    const s0 = Math.max(0, (obs.top - OBSTACLE_PAD_Y) >> Y_STRIPE_SHIFT);
    const s1 = Math.min(numStripes - 1, Math.max(0, (obs.bottom + OBSTACLE_PAD_Y) >> Y_STRIPE_SHIFT));
    for (let s = s0; s <= s1; s += 1) {
      stripes[s].push(obs);
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
    for (let i = 0; i < bucket.length; i += 1) {
      const rect = bucket[i];
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
    for (let i = 0; i < bucket.length; i += 1) {
      const obs = bucket[i];
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
  for (let i = 0; i < raw.length; i += 1) {
    const pt = raw[i];
    const rx = Math.round(pt.x);
    const ry = Math.round(pt.y);
    const len = out.length;
    if (len > 0) {
      const prev = out[len - 1];
      if (prev.x === rx && prev.y === ry) {
        continue;
      }
      if (len > 1) {
        const prev2 = out[len - 2];
        if ((prev2.x === prev.x && prev.x === rx) || (prev2.y === prev.y && prev.y === ry)) {
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
  for (let i = 0; i < obstacles.length; i += 1) {
    const obs = obstacles[i];
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
  for (let i = 0; i < obstacles.length; i += 1) {
    if (verticalSegmentHitsRect(x, y1, y2, obstacles[i])) {
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
  for (let i = 0; i < obstacles.length; i += 1) {
    if (horizontalSegmentHitsRect(x1, x2, y, obstacles[i])) {
      return true;
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
  for (let i = 0; i < obstacles.length; i += 1) {
    const obs = obstacles[i];
    if (maxY > obs.top + OBSTACLE_PAD_Y && minY < obs.bottom - OBSTACLE_PAD_Y) {
      relevant.push(obs);
    }
  }
  relevant.sort((a, b) => a.left - b.left);

  const candidates = new Set<number>();
  for (let i = 0; i < relevant.length; i += 1) {
    const obs = relevant[i];
    candidates.add(Math.round(obs.left - 10));
    candidates.add(Math.round(obs.right + 10));
  }

  for (let i = 0; i < relevant.length - 1; i += 1) {
    const gapLeft = relevant[i].right;
    const gapRight = relevant[i + 1].left;
    if (gapRight - gapLeft >= 12) {
      candidates.add(Math.round((gapLeft + gapRight) / 2));
    }
  }

  candidates.add(MIN_SAFE_CORRIDOR_X);
  const outerRightBase = Math.round(maxContentX + 16);
  for (let slot = 0; slot < 8; slot += 1) {
    candidates.add(outerRightBase + slot * 8);
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
  if (blockers.length === 0) {
    return collapsePoints([
      { x: hubX, y: hubY },
      { x: hubX, y: busY },
    ]);
  }

  let blockTop = blockers[0].top;
  let blockBottom = blockers[0].bottom;
  let blockLeft = blockers[0].left;
  let blockRight = blockers[0].right;
  for (let i = 1; i < blockers.length; i += 1) {
    const b = blockers[i];
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
  let chosenX = primaryCandidates[0] ?? Math.round(blockRight + 10);

  for (let i = 0; i < allCandidates.length; i += 1) {
    const candX = allCandidates[i];
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

function routeChildDropAroundObstacles(params: {
  readonly dropX: number;
  readonly busY: number;
  readonly toY: number;
  readonly childId: string;
  readonly spatialIndex: ObstacleSpatialIndex;
  readonly maxContentX: number;
  readonly usedCorridorCounts: Map<number, number>;
}): DiagramPoint[] {
  const { dropX, busY, toY, childId, spatialIndex, maxContentX, usedCorridorCounts } = params;

  if (!hasAnyVerticalBlocker(spatialIndex, dropX, busY, toY, childId, null)) {
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
  if (!hasBlockingObstacleOnVertical(dropX, busY, toY, obstacles)) {
    return collapsePoints([
      { x: dropX, y: busY },
      { x: dropX, y: toY },
    ]);
  }

  const returnY = Math.round(Math.max(busY, toY - 10));
  const candidates = collectCorridorCandidates({
    preferredX: dropX,
    y1: busY,
    y2: returnY,
    obstacles,
    maxContentX,
    usedCorridorCounts,
  });

  let chosenX = candidates[0] ?? Math.round(maxContentX + 16);
  for (let i = 0; i < candidates.length; i += 1) {
    const candX = candidates[i];
    if (candX < MIN_SAFE_CORRIDOR_X) {
      continue;
    }
    if (
      !hasBlockingObstacleOnVertical(candX, busY, returnY, obstacles) &&
      !hasHorizontalCollision(dropX, candX, busY, obstacles) &&
      !hasHorizontalCollision(candX, dropX, returnY, obstacles)
    ) {
      chosenX = candX;
      break;
    }
  }

  usedCorridorCounts.set(chosenX, (usedCorridorCounts.get(chosenX) ?? 0) + 1);
  return collapsePoints([
    { x: dropX, y: busY },
    { x: chosenX, y: busY },
    { x: chosenX, y: returnY },
    { x: dropX, y: returnY },
    { x: dropX, y: toY },
  ]);
}

let scratchPosInGen: Int32Array = new Int32Array(1024);
let scratchBary: Float64Array = new Float64Array(1024);
let scratchPOffsets: Int32Array = new Int32Array(1025);
let scratchCOffsets: Int32Array = new Int32Array(1025);
let scratchPNeighbors: Int32Array = new Int32Array(4096);
let scratchCNeighbors: Int32Array = new Int32Array(4096);

function ensureUnitScratch(totalUnits: number): void {
  if (scratchPosInGen.length < totalUnits) {
    const cap = Math.max(totalUnits, scratchPosInGen.length * 2);
    scratchPosInGen = new Int32Array(cap);
    scratchBary = new Float64Array(cap);
    scratchPOffsets = new Int32Array(cap + 1);
    scratchCOffsets = new Int32Array(cap + 1);
  }
}

function ensureNeighborScratch(pCount: number, cCount: number): void {
  if (scratchPNeighbors.length < pCount) {
    const next = new Int32Array(Math.max(pCount, scratchPNeighbors.length * 2));
    next.set(scratchPNeighbors);
    scratchPNeighbors = next;
  }
  if (scratchCNeighbors.length < cCount) {
    const next = new Int32Array(Math.max(cCount, scratchCNeighbors.length * 2));
    next.set(scratchCNeighbors);
    scratchCNeighbors = next;
  }
}

function minimizeGenerationCrossingsSlots(model: ArchivalTreeModel): TreeFamilyUnit[][] {
  const numGens = model.generations.length;
  let totalUnits = 0;
  for (let gSlot = 0; gSlot < numGens; gSlot += 1) {
    totalUnits += model.generations[gSlot].units.length;
  }
  ensureUnitScratch(totalUnits);

  const allUnits = new Array<TreeFamilyUnit>(totalUnits);
  const rowIndicesByGenSlot: number[][] = new Array(numGens);
  const personToUnitIdx = new Map<string, number>();
  const posInGen = scratchPosInGen;
  const bary = scratchBary;

  let uCursor = 0;
  for (let gSlot = 0; gSlot < numGens; gSlot += 1) {
    const units = model.generations[gSlot].units;
    const rowIndices = new Array<number>(units.length);
    for (let idx = 0; idx < units.length; idx += 1) {
      const u = units[idx];
      const uGlobal = uCursor;
      uCursor += 1;
      allUnits[uGlobal] = u;
      rowIndices[idx] = uGlobal;
      posInGen[uGlobal] = idx;
      for (let m = 0; m < u.orderedMemberIds.length; m += 1) {
        personToUnitIdx.set(u.orderedMemberIds[m], uGlobal);
      }
    }
    rowIndicesByGenSlot[gSlot] = rowIndices;
  }

  const pOffsets = scratchPOffsets;
  const cOffsets = scratchCOffsets;
  pOffsets[0] = 0;
  cOffsets[0] = 0;
  let pLen = 0;
  let cLen = 0;

  for (let uIdx = 0; uIdx < totalUnits; uIdx += 1) {
    const members = allUnits[uIdx].orderedMemberIds;
    for (let m = 0; m < members.length; m += 1) {
      const pid = members[m];
      const parents = model.parentMap.get(pid);
      if (parents) {
        ensureNeighborScratch(pLen + parents.length, cLen);
        for (let p = 0; p < parents.length; p += 1) {
          const pu = personToUnitIdx.get(parents[p]);
          if (pu !== undefined) {
            scratchPNeighbors[pLen] = pu;
            pLen += 1;
          }
        }
      }
      const children = model.childMap.get(pid);
      if (children) {
        ensureNeighborScratch(pLen, cLen + children.length);
        for (let c = 0; c < children.length; c += 1) {
          const cu = personToUnitIdx.get(children[c]);
          if (cu !== undefined) {
            scratchCNeighbors[cLen] = cu;
            cLen += 1;
          }
        }
      }
    }
    pOffsets[uIdx + 1] = pLen;
    cOffsets[uIdx + 1] = cLen;
  }

  const pNeighbors = scratchPNeighbors;
  const cNeighbors = scratchCNeighbors;
  const byBarycenter = (a: number, b: number): number => bary[a] - bary[b];

  for (let sweep = 0; sweep < 4; sweep += 1) {
    let changed = false;

    for (let gSlot = 1; gSlot < numGens; gSlot += 1) {
      const row = rowIndicesByGenSlot[gSlot];
      if (row.length <= 1) {
        continue;
      }
      let outOfOrder = false;
      let prevBary = Number.NEGATIVE_INFINITY;
      for (let r = 0; r < row.length; r += 1) {
        const uIdx = row[r];
        const start = pOffsets[uIdx];
        const end = pOffsets[uIdx + 1];
        let val: number;
        if (end > start) {
          let sum = 0;
          for (let k = start; k < end; k += 1) {
            sum += posInGen[pNeighbors[k]];
          }
          val = sum / (end - start);
        } else {
          val = posInGen[uIdx];
        }
        bary[uIdx] = val;
        if (val < prevBary) {
          outOfOrder = true;
        } else {
          prevBary = val;
        }
      }
      if (outOfOrder) {
        row.sort(byBarycenter);
        changed = true;
        for (let r = 0; r < row.length; r += 1) {
          posInGen[row[r]] = r;
        }
      }
    }

    for (let gSlot = numGens - 2; gSlot >= 0; gSlot -= 1) {
      const row = rowIndicesByGenSlot[gSlot];
      if (row.length <= 1) {
        continue;
      }
      let outOfOrder = false;
      let prevBary = Number.NEGATIVE_INFINITY;
      for (let r = 0; r < row.length; r += 1) {
        const uIdx = row[r];
        const start = cOffsets[uIdx];
        const end = cOffsets[uIdx + 1];
        let val: number;
        if (end > start) {
          let sum = 0;
          for (let k = start; k < end; k += 1) {
            sum += posInGen[cNeighbors[k]];
          }
          val = sum / (end - start);
        } else {
          val = posInGen[uIdx];
        }
        bary[uIdx] = val;
        if (val < prevBary) {
          outOfOrder = true;
        } else {
          prevBary = val;
        }
      }
      if (outOfOrder) {
        row.sort(byBarycenter);
        changed = true;
        for (let r = 0; r < row.length; r += 1) {
          posInGen[row[r]] = r;
        }
      }
    }

    if (!changed) {
      break;
    }
  }

  const orderedSlots: TreeFamilyUnit[][] = new Array(numGens);
  for (let gSlot = 0; gSlot < numGens; gSlot += 1) {
    const row = rowIndicesByGenSlot[gSlot];
    const units = new Array<TreeFamilyUnit>(row.length);
    for (let r = 0; r < row.length; r += 1) {
      units[r] = allUnits[row[r]];
    }
    orderedSlots[gSlot] = units;
  }
  return orderedSlots;
}

function computeUnitFootprintWidth(model: ArchivalTreeModel, unit: TreeFamilyUnit): number {
  const memberSpan =
    unit.orderedMemberIds.length * ARCHIVAL_NODE_W +
    Math.max(0, unit.orderedMemberIds.length - 1) * ARCHIVAL_SPOUSE_GAP;

  let extraSpan = memberSpan;
  for (let i = 0; i < unit.unionIds.length; i += 1) {
    const union = model.unionsById.get(unit.unionIds[i]);
    if (!union) {
      continue;
    }
    const hasStemDetourNeed =
      union.visibleChildIds.length > 0 &&
      (union.earlyLossChildIds.length > 0 ||
        union.collapsedSiblingIds.length > 0 ||
        union.hangingChildIds.length > 0);
    const detourPad = hasStemDetourNeed ? 28 : 0;

    if (union.hangingChildIds.length > 0) {
      const cols = union.hangingChildIds.length === 1 ? 1 : 2;
      const gridW = cols * ARCHIVAL_NODE_W + (cols === 2 ? ARCHIVAL_HANGING_COL_GAP : 0) + detourPad;
      if (gridW > extraSpan) {
        extraSpan = gridW;
      }
    }
    if (union.earlyLossChildIds.length > 0) {
      const chipsPerRow = Math.min(3, union.earlyLossChildIds.length);
      const stripW =
        Math.max(194, chipsPerRow * ARCHIVAL_EARLY_CHIP_W + (chipsPerRow - 1) * 8 + 24) + detourPad;
      if (stripW > extraSpan) {
        extraSpan = stripW;
      }
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
      const pillW = Math.max(168, Math.round(toggleLabels.compactLabel.length * 7.2 + 28)) + detourPad;
      if (pillW > extraSpan) {
        extraSpan = pillW;
      }
    }
  }
  return extraSpan;
}

function buildOrthogonalBuses(params: {
  readonly model: ArchivalTreeModel;
  readonly hubByUnionId: ReadonlyMap<string, DiagramUnionHub>;
  readonly byId: ReadonlyMap<string, DiagramPlacedNode>;
  readonly genBands: readonly DiagramGenBand[];
  readonly genBandIdxByGen: ReadonlyMap<number, number>;
  readonly spatialIndex: ObstacleSpatialIndex;
  readonly maxContentX: number;
}): DiagramOrthogonalBus[] {
  const { model, hubByUnionId, byId, genBands, genBandIdxByGen, spatialIndex, maxContentX } = params;
  const buses: DiagramOrthogonalBus[] = [];
  const busTrackCounterByGen = new Map<number, number>();
  const usedCorridorCounts = new Map<number, number>();

  for (let u = 0; u < model.unions.length; u += 1) {
    const union = model.unions[u];
    if (union.visibleChildIds.length === 0) {
      continue;
    }
    const hub = hubByUnionId.get(union.id);
    if (!hub) {
      continue;
    }

    const rawDrops: {
      childId: string;
      x: number;
      toY: number;
      isDirect: boolean;
    }[] = [];
    let minChildTopY = Number.POSITIVE_INFINITY;
    let sumChildX = 0;
    let railMinX = hub.x;
    let railMaxX = hub.x;
    let anyDirectDrop = false;

    for (let i = 0; i < union.visibleChildIds.length; i += 1) {
      const cid = union.visibleChildIds[i];
      const childNode = byId.get(cid);
      if (!childNode) {
        continue;
      }
      const dropX = Math.round(childNode.x + childNode.width / 2);
      rawDrops.push({
        childId: cid,
        x: dropX,
        toY: childNode.y,
        isDirect: childNode.isDirect,
      });
      sumChildX += dropX;
      if (childNode.y < minChildTopY) minChildTopY = childNode.y;
      if (dropX < railMinX) railMinX = dropX;
      if (dropX > railMaxX) railMaxX = dropX;
      if (childNode.isDirect) anyDirectDrop = true;
    }

    if (rawDrops.length === 0) {
      continue;
    }

    const trackIdx = busTrackCounterByGen.get(union.gen) ?? 0;
    busTrackCounterByGen.set(union.gen, trackIdx + 1);

    const genBandIdx = genBandIdxByGen.get(union.gen) ?? -1;
    const genBand = genBandIdx >= 0 ? genBands[genBandIdx] : undefined;
    const nextBand = genBandIdx >= 0 ? genBands[genBandIdx + 1] : undefined;
    const channelStartY = genBand ? genBand.y + genBand.height + 16 : hub.y + 32;
    const rawBusY = channelStartY + trackIdx * 11;
    const channelCapY = nextBand ? Math.min(minChildTopY - 18, nextBand.y - 14) : minChildTopY - 18;
    const busY = Math.round(Math.min(channelCapY, Math.max(hub.y + 20, rawBusY)));

    const meanChildX = sumChildX / rawDrops.length;
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

    const childDrops: DiagramOrthogonalDrop[] = new Array(rawDrops.length);
    const childIds: string[] = new Array(rawDrops.length);
    for (let i = 0; i < rawDrops.length; i += 1) {
      const drop = rawDrops[i];
      childIds[i] = drop.childId;
      childDrops[i] = {
        childId: drop.childId,
        x: drop.x,
        toY: drop.toY,
        isDirect: drop.isDirect,
        points: routeChildDropAroundObstacles({
          dropX: drop.x,
          busY,
          toY: drop.toY,
          childId: drop.childId,
          spatialIndex,
          maxContentX,
          usedCorridorCounts,
        }),
      };
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

  return buses;
}

function computeDiagramBounds(params: {
  readonly leftPad: number;
  readonly maxRowWidth: number;
  readonly cursorY: number;
  readonly nodes: readonly DiagramPlacedNode[];
  readonly earlyLossStrips: readonly DiagramEarlyLossStrip[];
  readonly siblingToggles: readonly DiagramSiblingToggle[];
  readonly buses: readonly DiagramOrthogonalBus[];
}): DiagramBounds {
  let minX = 0;
  let maxX = params.leftPad * 2 + params.maxRowWidth;
  let maxY = params.cursorY + 32;

  for (let i = 0; i < params.nodes.length; i += 1) {
    const n = params.nodes[i];
    if (n.x + n.width + 64 > maxX) maxX = n.x + n.width + 64;
    if (n.y + n.height + 64 > maxY) maxY = n.y + n.height + 64;
    if (n.x - 40 < minX) minX = n.x - 40;
  }
  for (let i = 0; i < params.earlyLossStrips.length; i += 1) {
    const s = params.earlyLossStrips[i];
    if (s.x + s.width + 48 > maxX) maxX = s.x + s.width + 48;
    if (s.y + s.height + 48 > maxY) maxY = s.y + s.height + 48;
  }
  for (let i = 0; i < params.siblingToggles.length; i += 1) {
    const t = params.siblingToggles[i];
    if (t.x + t.width + 48 > maxX) maxX = t.x + t.width + 48;
    if (t.y + t.height + 48 > maxY) maxY = t.y + t.height + 48;
  }
  for (let i = 0; i < params.buses.length; i += 1) {
    const b = params.buses[i];
    for (let p = 0; p < b.stemPoints.length; p += 1) {
      const px = b.stemPoints[p].x + 32;
      if (px > maxX) maxX = px;
    }
    for (let d = 0; d < b.childDrops.length; d += 1) {
      const pts = b.childDrops[d].points;
      for (let p = 0; p < pts.length; p += 1) {
        const px = pts[p].x + 32;
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

  const orderedUnitsBySlot = minimizeGenerationCrossingsSlots(model);
  const unitWidthsBySlot: Float64Array[] = new Array(numGens);
  const rowWidths = new Float64Array(numGens);

  let maxRowWidth = 0;
  for (let gIdx = 0; gIdx < numGens; gIdx += 1) {
    const units = orderedUnitsBySlot[gIdx];
    const widths = new Float64Array(units.length);
    let unitSum = 0;
    for (let i = 0; i < units.length; i += 1) {
      const w = computeUnitFootprintWidth(model, units[i]);
      widths[i] = w;
      unitSum += w;
    }
    unitWidthsBySlot[gIdx] = widths;
    const totalW = unitSum + Math.max(0, units.length - 1) * ARCHIVAL_UNIT_GAP;
    rowWidths[gIdx] = totalW;
    if (totalW > maxRowWidth) {
      maxRowWidth = totalW;
    }
  }

  const leftPad = 148;
  const topPad = 48;

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

  for (let gIdx = 0; gIdx < numGens; gIdx += 1) {
    const g = model.generations[gIdx];
    const units = orderedUnitsBySlot[gIdx];
    const unitWidths = unitWidthsBySlot[gIdx];
    const rowW = rowWidths[gIdx];
    let cursorX = leftPad + (maxRowWidth - rowW) / 2;
    const rowTopY = cursorY;
    let rowBottomY = rowTopY + ARCHIVAL_NODE_H;

    for (let uIdx = 0; uIdx < units.length; uIdx += 1) {
      const unit = units[uIdx];
      const footprintW = unitWidths[uIdx];
      const memberSpan =
        unit.orderedMemberIds.length * ARCHIVAL_NODE_W +
        Math.max(0, unit.orderedMemberIds.length - 1) * ARCHIVAL_SPOUSE_GAP;
      const memberStartX = cursorX + (footprintW - memberSpan) / 2;

      for (let idx = 0; idx < unit.orderedMemberIds.length; idx += 1) {
        const pid = unit.orderedMemberIds[idx];
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
      const resolveAttachmentTopY = (centerX: number, width: number, baseTopY: number): number => {
        const left = centerX - width / 2;
        const right = centerX + width / 2;
        let y = baseTopY;
        for (let r = 0; r < unitPlacedRects.length; r += 1) {
          const prior = unitPlacedRects[r];
          if (left < prior.right + 14 && right > prior.left - 14 && prior.bottom + 14 > y) {
            y = prior.bottom + 14;
          }
        }
        return y;
      };

      let priorHangingBottomY: number | null = null;
      for (let u = 0; u < unit.unionIds.length; u += 1) {
        const union = model.unionsById.get(unit.unionIds[u]);
        if (!union) {
          continue;
        }
        const primaryNode = byId.get(union.primaryPartnerId);
        const secondaryNode = union.secondaryPartnerId ? byId.get(union.secondaryPartnerId) : undefined;
        if (!primaryNode) {
          continue;
        }

        let hub: DiagramUnionHub;
        if (secondaryNode) {
          const leftNode = primaryNode.x <= secondaryNode.x ? primaryNode : secondaryNode;
          const rightNode = primaryNode.x <= secondaryNode.x ? secondaryNode : primaryNode;
          const leftX = leftNode.x + leftNode.width;
          const rightX = rightNode.x;
          const midX = Math.round((leftX + rightX) / 2);
          const midY = Math.round(rowTopY + ARCHIVAL_NODE_H / 2);
          hub = {
            union,
            x: midX,
            y: midY,
            leftPartnerId: leftNode.person.id,
            rightPartnerId: rightNode.person.id,
            connectorY: midY,
            leftX,
            rightX,
          };
        } else {
          const midX = Math.round(primaryNode.x + primaryNode.width / 2);
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

        let attachmentY = rowTopY + ARCHIVAL_NODE_H + 16;
        if (priorHangingBottomY !== null && union.hangingChildIds.length > 0) {
          attachmentY = Math.max(attachmentY, priorHangingBottomY + 18);
        }
        let stemFromY = hub.y + 8;

        if (union.earlyLossChildIds.length > 0) {
          const chipW = ARCHIVAL_EARLY_CHIP_W;
          const chipGap = 8;
          const padX = 12;
          const chipsPerRow = Math.min(3, union.earlyLossChildIds.length);
          const chipRows = Math.ceil(union.earlyLossChildIds.length / chipsPerRow);
          const stripW = Math.max(194, chipsPerRow * chipW + (chipsPerRow - 1) * chipGap + padX * 2);
          const stripH = 22 + chipRows * (ARCHIVAL_EARLY_CHIP_H + 6) + 4;
          const stripY = Math.round(resolveAttachmentTopY(hub.x, stripW, attachmentY));
          const stripX = Math.round(hub.x - stripW / 2);

          const chips: DiagramEarlyLossChip[] = [];
          for (let cIdx = 0; cIdx < union.earlyLossChildIds.length; cIdx += 1) {
            const cid = union.earlyLossChildIds[cIdx];
            const child = model.peopleById.get(cid);
            if (!child) {
              continue;
            }
            const col = cIdx % chipsPerRow;
            const row = Math.floor(cIdx / chipsPerRow);
            chips.push({
              person: child,
              unionId: union.id,
              x: stripX + padX + col * (chipW + chipGap),
              y: stripY + 20 + row * (ARCHIVAL_EARLY_CHIP_H + 6),
              width: chipW,
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
            stemFromY,
            chips,
          });
          unitPlacedRects.push({ left: stripX, right: stripX + stripW, bottom: stripY + stripH });
          stemFromY = stripY + stripH;
          attachmentY = stripY + stripH + ARCHIVAL_EARLY_STRIP_GAP;
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
          const pillY = Math.round(resolveAttachmentTopY(hub.x, pillW, attachmentY));
          const pillX = Math.round(hub.x - pillW / 2);
          siblingToggles.push({
            unionId: union.id,
            parentIds: union.partnerIds,
            x: pillX,
            y: pillY,
            width: pillW,
            height: pillH,
            stemFromX: hub.x,
            stemFromY,
            hiddenCount: union.collapsedSiblingIds.length,
            totalCollateralCount: totalCollateral,
            visibleChildCount: union.visibleChildIds.length,
            mode: model.effectiveMode,
            isExpanded: union.isExpanded,
            isDirect: union.isDirect,
          });
          unitPlacedRects.push({ left: pillX, right: pillX + pillW, bottom: pillY + pillH });
          stemFromY = pillY + pillH;
          attachmentY = pillY + pillH + 12;
          if (pillY + pillH > rowBottomY) rowBottomY = pillY + pillH;
        }

        if (union.hangingChildIds.length > 0) {
          const cols = union.hangingChildIds.length === 1 ? 1 : 2;
          const spineX = hub.x;
          const gridW = cols * ARCHIVAL_NODE_W + (cols === 2 ? ARCHIVAL_HANGING_COL_GAP : 0);
          const gridTopY = Math.round(resolveAttachmentTopY(spineX, gridW, attachmentY));
          const ticks: {
            childId: string;
            y: number;
            side: 'left' | 'right';
            toX: number;
          }[] = [];
          let maxGridY = gridTopY;
          let maxTickY = gridTopY;

          for (let hIdx = 0; hIdx < union.hangingChildIds.length; hIdx += 1) {
            const cid = union.hangingChildIds[hIdx];
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
            topY: stemFromY,
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

      cursorX += footprintW + ARCHIVAL_UNIT_GAP;
    }

    let activeBusCount = 0;
    for (let i = 0; i < g.unions.length; i += 1) {
      if (g.unions[i].visibleChildIds.length > 0) {
        activeBusCount += 1;
      }
    }
    const channelHeight = Math.max(ARCHIVAL_GEN_MIN_GAP, 44 + activeBusCount * 12);

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
  let maxContentX = leftPad + maxRowWidth;
  let maxObstacleY = cursorY;
  let oCursor = 0;

  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
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
  for (let i = 0; i < earlyLossStrips.length; i += 1) {
    const s = earlyLossStrips[i];
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
  for (let i = 0; i < siblingToggles.length; i += 1) {
    const t = siblingToggles[i];
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
  });
  const bounds = computeDiagramBounds({
    leftPad,
    maxRowWidth,
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
