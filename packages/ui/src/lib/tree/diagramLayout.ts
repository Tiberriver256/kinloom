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

function collapsePoints(raw: readonly DiagramPoint[]): DiagramPoint[] {
  const out: DiagramPoint[] = [];
  for (const pt of raw) {
    const rounded = { x: Math.round(pt.x), y: Math.round(pt.y) };
    const prev = out.at(-1);
    if (prev && prev.x === rounded.x && prev.y === rounded.y) {
      continue;
    }
    const prev2 = out.at(-2);
    if (
      prev &&
      prev2 &&
      ((prev2.x === prev.x && prev.x === rounded.x) || (prev2.y === prev.y && prev.y === rounded.y))
    ) {
      out[out.length - 1] = rounded;
      continue;
    }
    out.push(rounded);
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
  return obstacles.filter((obs) => verticalSegmentHitsRect(x, y1, y2, obs));
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
  const relevant = obstacles
    .filter((obs) => maxY > obs.top + OBSTACLE_PAD_Y && minY < obs.bottom - OBSTACLE_PAD_Y)
    .toSorted((a, b) => a.left - b.left);

  const candidates = new Set<number>();
  for (const obs of relevant) {
    candidates.add(Math.round(obs.left - 10));
    candidates.add(Math.round(obs.right + 10));
  }

  // Add midpoints of open gaps between horizontally sorted obstacles.
  for (let i = 0; i < relevant.length - 1; i += 1) {
    const gapLeft = relevant[i].right;
    const gapRight = relevant[i + 1].left;
    if (gapRight - gapLeft >= 12) {
      candidates.add(Math.round((gapLeft + gapRight) / 2));
    }
  }

  // Always include safe left/right outer corridors as guaranteed collision-free fallbacks.
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
  readonly obstacles: readonly ObstacleRect[];
  readonly maxContentX: number;
  readonly usedCorridorCounts: Map<number, number>;
}): DiagramPoint[] {
  const {
    hubX,
    hubY,
    busY,
    rowBottomOfParentsY,
    preferredSideX,
    obstacles,
    maxContentX,
    usedCorridorCounts,
  } = params;
  const blockers = findBlockingObstaclesOnVertical(hubX, hubY, busY, obstacles);
  if (blockers.length === 0) {
    return collapsePoints([
      { x: hubX, y: hubY },
      { x: hubX, y: busY },
    ]);
  }

  const blockTop = Math.min(...blockers.map((b) => b.top));
  const blockBottom = Math.max(...blockers.map((b) => b.bottom));
  const blockLeft = Math.min(...blockers.map((b) => b.left));
  const blockRight = Math.max(...blockers.map((b) => b.right));

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

  for (const candX of allCandidates) {
    if (candX < MIN_SAFE_CORRIDOR_X) {
      continue;
    }
    const vertClear =
      findBlockingObstaclesOnVertical(candX, detourTopY, detourBottomY, obstacles).length === 0;
    const topHorizClear = !obstacles.some((obs) => horizontalSegmentHitsRect(hubX, candX, detourTopY, obs));
    const botHorizClear = !obstacles.some((obs) =>
      horizontalSegmentHitsRect(candX, hubX, detourBottomY, obs)
    );
    if (vertClear && topHorizClear && botHorizClear) {
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
  readonly allObstacles: readonly ObstacleRect[];
  readonly maxContentX: number;
  readonly usedCorridorCounts: Map<number, number>;
}): DiagramPoint[] {
  const { dropX, busY, toY, childId, allObstacles, maxContentX, usedCorridorCounts } = params;
  const obstacles = allObstacles.filter((obs) => !(obs.kind === 'node' && obs.ownerId === childId));
  const blockers = findBlockingObstaclesOnVertical(dropX, busY, toY, obstacles);
  if (blockers.length === 0) {
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
  for (const candX of candidates) {
    if (candX < MIN_SAFE_CORRIDOR_X) {
      continue;
    }
    const vertClear = findBlockingObstaclesOnVertical(candX, busY, returnY, obstacles).length === 0;
    const topClear = !obstacles.some((obs) => horizontalSegmentHitsRect(dropX, candX, busY, obs));
    const botClear = !obstacles.some((obs) => horizontalSegmentHitsRect(candX, dropX, returnY, obs));
    if (vertClear && topClear && botClear) {
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

function minimizeGenerationCrossings(model: ArchivalTreeModel): Map<number, TreeFamilyUnit[]> {
  const orderedUnitsByGen = new Map<number, TreeFamilyUnit[]>();
  const personToUnit = new Map<string, TreeFamilyUnit>();
  for (const g of model.generations) {
    orderedUnitsByGen.set(g.gen, [...g.units]);
    for (const u of g.units) {
      for (const pid of u.orderedMemberIds) {
        personToUnit.set(pid, u);
      }
    }
  }

  const unitIndex = new Map<string, number>();
  const refreshIndices = (genNum: number): void => {
    for (const [idx, u] of (orderedUnitsByGen.get(genNum) ?? []).entries()) {
      unitIndex.set(u.id, idx);
    }
  };
  for (const g of model.generations) {
    refreshIndices(g.gen);
  }

  const genNums = model.generations.map((g) => g.gen);
  for (let sweep = 0; sweep < 4; sweep += 1) {
    for (let i = 1; i < genNums.length; i += 1) {
      const g = genNums[i];
      const units = orderedUnitsByGen.get(g) ?? [];
      const baryMap = new Map<string, number>();
      for (const u of units) {
        const indices: number[] = [];
        for (const pid of u.orderedMemberIds) {
          for (const parentId of model.parentMap.get(pid) ?? []) {
            const pu = personToUnit.get(parentId);
            if (pu) {
              indices.push(unitIndex.get(pu.id) ?? 0);
            }
          }
        }
        baryMap.set(
          u.id,
          indices.length > 0
            ? indices.reduce((acc, v) => acc + v, 0) / indices.length
            : (unitIndex.get(u.id) ?? 0)
        );
      }
      units.sort((a, b) => (baryMap.get(a.id) ?? 0) - (baryMap.get(b.id) ?? 0));
      refreshIndices(g);
    }
    for (let i = genNums.length - 2; i >= 0; i -= 1) {
      const g = genNums[i];
      const units = orderedUnitsByGen.get(g) ?? [];
      const baryMap = new Map<string, number>();
      for (const u of units) {
        const indices: number[] = [];
        for (const pid of u.orderedMemberIds) {
          for (const childId of model.childMap.get(pid) ?? []) {
            const cu = personToUnit.get(childId);
            if (cu) {
              indices.push(unitIndex.get(cu.id) ?? 0);
            }
          }
        }
        baryMap.set(
          u.id,
          indices.length > 0
            ? indices.reduce((acc, v) => acc + v, 0) / indices.length
            : (unitIndex.get(u.id) ?? 0)
        );
      }
      units.sort((a, b) => (baryMap.get(a.id) ?? 0) - (baryMap.get(b.id) ?? 0));
      refreshIndices(g);
    }
  }

  return orderedUnitsByGen;
}

function computeUnitFootprintWidth(model: ArchivalTreeModel, unit: TreeFamilyUnit): number {
  const memberSpan =
    unit.orderedMemberIds.length * ARCHIVAL_NODE_W +
    Math.max(0, unit.orderedMemberIds.length - 1) * ARCHIVAL_SPOUSE_GAP;

  let extraSpan = memberSpan;
  for (const uid of unit.unionIds) {
    const union = model.unionsById.get(uid);
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
      extraSpan = Math.max(extraSpan, gridW);
    }
    if (union.earlyLossChildIds.length > 0) {
      const chipsPerRow = Math.min(3, union.earlyLossChildIds.length);
      const stripW = Math.max(194, chipsPerRow * ARCHIVAL_EARLY_CHIP_W + (chipsPerRow - 1) * 8 + 24);
      extraSpan = Math.max(extraSpan, stripW + detourPad);
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
      extraSpan = Math.max(extraSpan, pillW + detourPad);
    }
  }
  return extraSpan;
}

function buildOrthogonalBuses(params: {
  readonly model: ArchivalTreeModel;
  readonly hubByUnionId: ReadonlyMap<string, DiagramUnionHub>;
  readonly byId: ReadonlyMap<string, DiagramPlacedNode>;
  readonly genBands: readonly DiagramGenBand[];
  readonly allObstacles: readonly ObstacleRect[];
  readonly maxContentX: number;
}): DiagramOrthogonalBus[] {
  const { model, hubByUnionId, byId, genBands, allObstacles, maxContentX } = params;
  const buses: DiagramOrthogonalBus[] = [];
  const busTrackCounterByGen = new Map<number, number>();
  const usedCorridorCounts = new Map<number, number>();

  for (const union of model.unions) {
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

    for (const cid of union.visibleChildIds) {
      const childNode = byId.get(cid);
      if (!childNode) {
        continue;
      }
      rawDrops.push({
        childId: cid,
        x: Math.round(childNode.x + childNode.width / 2),
        toY: childNode.y,
        isDirect: childNode.isDirect,
      });
    }

    if (rawDrops.length === 0) {
      continue;
    }

    const trackIdx = busTrackCounterByGen.get(union.gen) ?? 0;
    busTrackCounterByGen.set(union.gen, trackIdx + 1);

    const minChildTopY = Math.min(...rawDrops.map((d) => d.toY));
    const genBandIdx = genBands.findIndex((b) => b.gen === union.gen);
    const genBand = genBandIdx >= 0 ? genBands[genBandIdx] : undefined;
    const nextBand = genBandIdx >= 0 ? genBands[genBandIdx + 1] : undefined;
    const channelStartY = genBand ? genBand.y + genBand.height + 16 : hub.y + 32;
    const rawBusY = channelStartY + trackIdx * 11;
    const channelCapY = nextBand ? Math.min(minChildTopY - 18, nextBand.y - 14) : minChildTopY - 18;
    const busY = Math.round(Math.min(channelCapY, Math.max(hub.y + 20, rawBusY)));

    const parentIdSet = new Set(union.partnerIds);
    const stemObstacles = allObstacles.filter(
      (obs) => !(obs.kind === 'node' && parentIdSet.has(obs.ownerId))
    );
    const meanChildX = rawDrops.reduce((sum, d) => sum + d.x, 0) / rawDrops.length;
    const rowBottomOfParentsY = genBand ? genBand.y + ARCHIVAL_NODE_H : hub.y + ARCHIVAL_NODE_H / 2;

    const stemPoints = routeStemAroundObstacles({
      hubX: hub.x,
      hubY: hub.y + 8,
      busY,
      rowBottomOfParentsY,
      preferredSideX: meanChildX,
      obstacles: stemObstacles,
      maxContentX,
      usedCorridorCounts,
    });

    const childDrops: DiagramOrthogonalDrop[] = rawDrops.map((drop) => ({
      ...drop,
      points: routeChildDropAroundObstacles({
        dropX: drop.x,
        busY,
        toY: drop.toY,
        childId: drop.childId,
        allObstacles,
        maxContentX,
        usedCorridorCounts,
      }),
    }));

    const xs = [hub.x, ...childDrops.map((d) => d.x)];
    buses.push({
      unionId: union.id,
      parentIds: union.partnerIds,
      childIds: childDrops.map((d) => d.childId),
      isDirect: union.isDirect && childDrops.some((d) => d.isDirect),
      hubX: hub.x,
      hubY: hub.y + 8,
      busY,
      railMinX: Math.min(...xs),
      railMaxX: Math.max(...xs),
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

  for (const n of params.nodes) {
    maxX = Math.max(maxX, n.x + n.width + 64);
    maxY = Math.max(maxY, n.y + n.height + 64);
    minX = Math.min(minX, n.x - 40);
  }
  for (const s of params.earlyLossStrips) {
    maxX = Math.max(maxX, s.x + s.width + 48);
    maxY = Math.max(maxY, s.y + s.height + 48);
  }
  for (const t of params.siblingToggles) {
    maxX = Math.max(maxX, t.x + t.width + 48);
    maxY = Math.max(maxY, t.y + t.height + 48);
  }
  for (const b of params.buses) {
    for (const pt of b.stemPoints) {
      maxX = Math.max(maxX, pt.x + 32);
    }
    for (const drop of b.childDrops) {
      for (const pt of drop.points) {
        maxX = Math.max(maxX, pt.x + 32);
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
  if (model.generations.length === 0) {
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

  const orderedUnitsByGen = minimizeGenerationCrossings(model);

  const rowWidths = new Map<number, number>();
  let maxRowWidth = 0;
  for (const g of model.generations) {
    const units = orderedUnitsByGen.get(g.gen) ?? [];
    const totalW =
      units.reduce((sum, u) => sum + computeUnitFootprintWidth(model, u), 0) +
      Math.max(0, units.length - 1) * ARCHIVAL_UNIT_GAP;
    rowWidths.set(g.gen, totalW);
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
  const genBands: DiagramGenBand[] = [];

  let cursorY = topPad;

  for (const g of model.generations) {
    const units = orderedUnitsByGen.get(g.gen) ?? [];
    const rowW = rowWidths.get(g.gen) ?? 0;
    let cursorX = leftPad + (maxRowWidth - rowW) / 2;
    const rowTopY = cursorY;
    let rowBottomY = rowTopY + ARCHIVAL_NODE_H;

    for (const unit of units) {
      const footprintW = computeUnitFootprintWidth(model, unit);
      const memberSpan =
        unit.orderedMemberIds.length * ARCHIVAL_NODE_W +
        Math.max(0, unit.orderedMemberIds.length - 1) * ARCHIVAL_SPOUSE_GAP;
      const memberStartX = cursorX + (footprintW - memberSpan) / 2;

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
      const resolveAttachmentTopY = (centerX: number, width: number, baseTopY: number): number => {
        const left = centerX - width / 2;
        const right = centerX + width / 2;
        let y = baseTopY;
        for (const prior of unitPlacedRects) {
          if (left < prior.right + 14 && right > prior.left - 14) {
            y = Math.max(y, prior.bottom + 14);
          }
        }
        return y;
      };

      let priorHangingBottomY: number | null = null;
      for (const uid of unit.unionIds) {
        const union = model.unionsById.get(uid);
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
          rowBottomY = Math.max(rowBottomY, stripY + stripH);
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
          rowBottomY = Math.max(rowBottomY, pillY + pillH);
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
            }
            maxGridY = Math.max(maxGridY, y + ARCHIVAL_NODE_H);
          }

          hangingRails.push({
            unionId: union.id,
            parentIds: union.partnerIds,
            childIds: union.hangingChildIds,
            spineX,
            topY: stemFromY,
            bottomY: ticks.length > 0 ? Math.max(...ticks.map((t) => t.y)) : gridTopY,
            ticks,
          });
          unitPlacedRects.push({
            left: spineX - gridW / 2,
            right: spineX + gridW / 2,
            bottom: maxGridY,
          });
          priorHangingBottomY = maxGridY;
          rowBottomY = Math.max(rowBottomY, maxGridY);
        }
      }

      cursorX += footprintW + ARCHIVAL_UNIT_GAP;
    }

    const activeBusCount = g.unions.filter((u) => u.visibleChildIds.length > 0).length;
    const channelHeight = Math.max(ARCHIVAL_GEN_MIN_GAP, 44 + activeBusCount * 12);

    genBands.push({
      gen: g.gen,
      y: rowTopY,
      height: rowBottomY - rowTopY,
      label: g.label,
      yearRange: g.yearRange,
    });

    cursorY = rowBottomY + channelHeight;
  }

  const allObstacles: ObstacleRect[] = [
    ...nodes.map((n) => ({
      left: n.x,
      right: n.x + n.width,
      top: n.y,
      bottom: n.y + n.height,
      ownerId: n.person.id,
      kind: 'node' as const,
    })),
    ...earlyLossStrips.map((s) => ({
      left: s.x,
      right: s.x + s.width,
      top: s.y,
      bottom: s.y + s.height,
      ownerId: s.unionId,
      kind: 'early_strip' as const,
    })),
    ...siblingToggles.map((t) => ({
      left: t.x,
      right: t.x + t.width,
      top: t.y,
      bottom: t.y + t.height,
      ownerId: t.unionId,
      kind: 'sibling_toggle' as const,
    })),
  ];

  let maxContentX = leftPad + maxRowWidth;
  for (const obs of allObstacles) {
    if (obs.right > maxContentX) {
      maxContentX = obs.right;
    }
  }

  const buses = buildOrthogonalBuses({
    model,
    hubByUnionId,
    byId,
    genBands,
    allObstacles,
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
