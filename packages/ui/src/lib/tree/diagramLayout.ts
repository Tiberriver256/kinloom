import {
  ARCHIVAL_EARLY_CHIP_H,
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
  type DiagramPlacedNode,
  type DiagramSiblingToggle,
  type DiagramUnionHub,
  formatUnionOtherChildrenLabel,
  type TreeFamilyUnit,
} from './types.js';

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
    if (union.hangingChildIds.length > 0) {
      const cols = union.hangingChildIds.length === 1 ? 1 : 2;
      const gridW = cols * ARCHIVAL_NODE_W + (cols === 2 ? ARCHIVAL_HANGING_COL_GAP : 0);
      extraSpan = Math.max(extraSpan, gridW);
    }
    if (union.earlyLossChildIds.length > 0) {
      const stripW = Math.min(340, Math.max(176, union.earlyLossChildIds.length * 104 + 28));
      extraSpan = Math.max(extraSpan, stripW);
    }
  }
  return extraSpan;
}

function buildOrthogonalBuses(
  model: ArchivalTreeModel,
  hubByUnionId: ReadonlyMap<string, DiagramUnionHub>,
  byId: ReadonlyMap<string, DiagramPlacedNode>,
  genBands: readonly DiagramGenBand[]
): DiagramOrthogonalBus[] {
  const buses: DiagramOrthogonalBus[] = [];
  const busTrackCounterByGen = new Map<number, number>();

  for (const union of model.unions) {
    if (union.visibleChildIds.length === 0) {
      continue;
    }
    const hub = hubByUnionId.get(union.id);
    if (!hub) {
      continue;
    }

    const childDrops: {
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
      childDrops.push({
        childId: cid,
        x: Math.round(childNode.x + childNode.width / 2),
        toY: childNode.y,
        isDirect: childNode.isDirect,
      });
    }

    if (childDrops.length === 0) {
      continue;
    }

    const trackIdx = busTrackCounterByGen.get(union.gen) ?? 0;
    busTrackCounterByGen.set(union.gen, trackIdx + 1);

    const minChildTopY = Math.min(...childDrops.map((d) => d.toY));
    const genBand = genBands.find((b) => b.gen === union.gen);
    const channelStartY = genBand ? genBand.y + genBand.height + 16 : hub.y + 32;
    const rawBusY = channelStartY + trackIdx * 11;
    const busY = Math.round(Math.min(minChildTopY - 18, Math.max(hub.y + 20, rawBusY)));

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

        if (union.earlyLossChildIds.length > 0) {
          const chipW = 100;
          const chipGap = 8;
          const padX = 12;
          const chipsPerRow = Math.min(3, union.earlyLossChildIds.length);
          const chipRows = Math.ceil(union.earlyLossChildIds.length / chipsPerRow);
          const stripW = Math.max(182, chipsPerRow * chipW + (chipsPerRow - 1) * chipGap + padX * 2);
          const stripH = 22 + chipRows * (ARCHIVAL_EARLY_CHIP_H + 6) + 4;
          const stripX = Math.round(hub.x - stripW / 2);
          const stripY = Math.round(attachmentY);

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
            stemFromY: hub.y + 8,
            chips,
          });
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
          const pillW = Math.max(156, Math.round(toggleLabels.compactLabel.length * 6.4 + 26));
          const pillH = 28;
          const pillX = Math.round(hub.x - pillW / 2);
          const pillY = Math.round(attachmentY);
          siblingToggles.push({
            unionId: union.id,
            parentIds: union.partnerIds,
            x: pillX,
            y: pillY,
            width: pillW,
            height: pillH,
            stemFromX: hub.x,
            stemFromY: hub.y + 8,
            hiddenCount: union.collapsedSiblingIds.length,
            totalCollateralCount: totalCollateral,
            visibleChildCount: union.visibleChildIds.length,
            mode: model.effectiveMode,
            isExpanded: union.isExpanded,
            isDirect: union.isDirect,
          });
          attachmentY = pillY + pillH + 12;
          rowBottomY = Math.max(rowBottomY, pillY + pillH);
        }

        if (union.hangingChildIds.length > 0) {
          const cols = union.hangingChildIds.length === 1 ? 1 : 2;
          const spineX = hub.x;
          const gridTopY = Math.round(attachmentY);
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
            topY: gridTopY - 12,
            bottomY: ticks.length > 0 ? Math.max(...ticks.map((t) => t.y)) : gridTopY,
            ticks,
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

  const buses = buildOrthogonalBuses(model, hubByUnionId, byId, genBands);
  const bounds = computeDiagramBounds({
    leftPad,
    maxRowWidth,
    cursorY,
    nodes,
    earlyLossStrips,
    siblingToggles,
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
