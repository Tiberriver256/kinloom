import { resolveUnitUnionPorts, type UnionPortSlot } from './layeredPorts.js';
import {
  ARCHIVAL_NODE_W,
  ARCHIVAL_SPOUSE_GAP,
  type ArchivalTreeModel,
  type TreeFamilyUnit,
} from './types.js';

export const DUMMY_CHANNEL_WIDTH = 24;
export const DUMMY_TO_UNIT_GAP = 22;
export const DUMMY_TO_DUMMY_GAP = 16;

export interface UnitFootprintSize {
  readonly width: number;
  readonly memberOffsetX: number;
}

export interface LayerUnitItem {
  readonly kind: 'unit';
  readonly id: string;
  readonly layerIndex: number;
  readonly unit: TreeFamilyUnit;
  readonly width: number;
  readonly memberOffsetX: number;
}

export interface LayerDummyItem {
  readonly kind: 'dummy';
  readonly id: string;
  readonly layerIndex: number;
  readonly width: number;
  readonly unionId: string;
  readonly childId: string;
  readonly sourceUnitId: string;
  readonly targetUnitId: string;
}

export type LayerItem = LayerUnitItem | LayerDummyItem;

export interface LayeredEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly sourceLayer: number;
  readonly targetLayer: number;
  readonly sourcePortOffsetX: number;
  readonly targetPortOffsetX: number;
  readonly sourcePortNorm: number;
  readonly targetPortNorm: number;
  readonly isInnerSegment: boolean;
  readonly isDirect: boolean;
}

export interface DummyChainEntry {
  readonly layerIndex: number;
  readonly dummyId: string;
}

export interface LayeredGraph {
  readonly layers: readonly (readonly LayerItem[])[];
  readonly edges: readonly LayeredEdge[];
  readonly dummyChainsByEdgeKey: ReadonlyMap<string, readonly DummyChainEntry[]>;
  readonly portsByUnitId: ReadonlyMap<string, ReadonlyMap<string, UnionPortSlot>>;
}

export function makeLayeredEdgeKey(unionId: string, childId: string): string {
  return `${unionId}\0${childId}`;
}

interface PersonUnitLocation {
  readonly unitId: string;
  readonly layerIndex: number;
  readonly centerOffsetX: number;
  readonly normalizedOffset: number;
}

/**
 * Builds the layered graph of family units and inserts virtual channel dummy nodes into every
 * intermediate generation band whenever a parent-child edge spans more than one generation.
 */
export function buildLayeredGraphWithDummyChannels(
  model: ArchivalTreeModel,
  computeFootprint: (
    model: ArchivalTreeModel,
    unit: TreeFamilyUnit,
    ports: ReadonlyMap<string, UnionPortSlot>
  ) => UnitFootprintSize
): LayeredGraph {
  const numLayers = model.generations.length;
  const layers: LayerItem[][] = new Array(numLayers);
  const portsByUnitId = new Map<string, ReadonlyMap<string, UnionPortSlot>>();
  const unitItemById = new Map<string, LayerUnitItem>();
  const unitByUnionId = new Map<string, LayerUnitItem>();
  const personLocation = new Map<string, PersonUnitLocation>();
  const cardStride = ARCHIVAL_NODE_W + ARCHIVAL_SPOUSE_GAP;

  for (const [gSlot, gen] of model.generations.entries()) {
    const units = gen.units;
    const layer: LayerItem[] = [];
    for (const unit of units) {
      const portSlots = resolveUnitUnionPorts(model, unit);
      const portMap = new Map<string, UnionPortSlot>();
      for (const slot of portSlots) {
        portMap.set(slot.unionId, slot);
      }
      portsByUnitId.set(unit.id, portMap);

      const footprint = computeFootprint(model, unit, portMap);
      const item: LayerUnitItem = {
        kind: 'unit',
        id: unit.id,
        layerIndex: gSlot,
        unit,
        width: footprint.width,
        memberOffsetX: footprint.memberOffsetX,
      };
      layer.push(item);
      unitItemById.set(unit.id, item);

      for (const unionId of unit.unionIds) {
        unitByUnionId.set(unionId, item);
      }

      const memberCount = unit.orderedMemberIds.length;
      for (const [m, pid] of unit.orderedMemberIds.entries()) {
        const centerOffsetX = Math.round(footprint.memberOffsetX + m * cardStride + ARCHIVAL_NODE_W / 2);
        const normalizedOffset = memberCount <= 1 ? 0 : (m / (memberCount - 1) - 0.5) * 0.6;
        personLocation.set(pid, {
          unitId: unit.id,
          layerIndex: gSlot,
          centerOffsetX,
          normalizedOffset,
        });
      }
    }
    layers[gSlot] = layer;
  }

  const edges: LayeredEdge[] = [];
  const dummyChainsByEdgeKey = new Map<string, DummyChainEntry[]>();
  const dummyCenterX = Math.round(DUMMY_CHANNEL_WIDTH / 2);

  for (const union of model.unions) {
    if (union.visibleChildIds.length === 0) {
      continue;
    }
    const sourceUnit = unitByUnionId.get(union.id);
    if (!sourceUnit) {
      continue;
    }
    const portSlot = portsByUnitId.get(sourceUnit.id)?.get(union.id);
    if (!portSlot) {
      continue;
    }
    const sourcePortOffsetX = sourceUnit.memberOffsetX + portSlot.relativeX;
    const sourcePortNorm = portSlot.normalizedOffset;

    for (const childId of union.visibleChildIds) {
      const targetLoc = personLocation.get(childId);
      if (!targetLoc || targetLoc.layerIndex <= sourceUnit.layerIndex) {
        continue;
      }
      const isDirect = union.isDirect && model.directPersonIds.has(childId);
      const span = targetLoc.layerIndex - sourceUnit.layerIndex;

      if (span === 1) {
        edges.push({
          sourceId: sourceUnit.id,
          targetId: targetLoc.unitId,
          sourceLayer: sourceUnit.layerIndex,
          targetLayer: targetLoc.layerIndex,
          sourcePortOffsetX,
          targetPortOffsetX: targetLoc.centerOffsetX,
          sourcePortNorm,
          targetPortNorm: targetLoc.normalizedOffset,
          isInnerSegment: false,
          isDirect,
        });
        continue;
      }

      // Multi-generation span: insert a virtual corridor dummy node in every intermediate layer.
      const chain: DummyChainEntry[] = [];
      let prevId = sourceUnit.id;
      let prevLayer = sourceUnit.layerIndex;
      let prevPortOffsetX = sourcePortOffsetX;
      let prevPortNorm = sourcePortNorm;
      let prevIsDummy = false;

      for (let s = sourceUnit.layerIndex + 1; s < targetLoc.layerIndex; s += 1) {
        const dummyId = `dummy:${union.id}:${childId}:${s}`;
        const dummyItem: LayerDummyItem = {
          kind: 'dummy',
          id: dummyId,
          layerIndex: s,
          width: DUMMY_CHANNEL_WIDTH,
          unionId: union.id,
          childId,
          sourceUnitId: sourceUnit.id,
          targetUnitId: targetLoc.unitId,
        };
        layers[s]?.push(dummyItem);
        chain.push({ layerIndex: s, dummyId });

        edges.push({
          sourceId: prevId,
          targetId: dummyId,
          sourceLayer: prevLayer,
          targetLayer: s,
          sourcePortOffsetX: prevPortOffsetX,
          targetPortOffsetX: dummyCenterX,
          sourcePortNorm: prevPortNorm,
          targetPortNorm: 0,
          isInnerSegment: prevIsDummy,
          isDirect,
        });

        prevId = dummyId;
        prevLayer = s;
        prevPortOffsetX = dummyCenterX;
        prevPortNorm = 0;
        prevIsDummy = true;
      }

      edges.push({
        sourceId: prevId,
        targetId: targetLoc.unitId,
        sourceLayer: prevLayer,
        targetLayer: targetLoc.layerIndex,
        sourcePortOffsetX: prevPortOffsetX,
        targetPortOffsetX: targetLoc.centerOffsetX,
        sourcePortNorm: 0,
        targetPortNorm: targetLoc.normalizedOffset,
        isInnerSegment: false,
        isDirect,
      });

      dummyChainsByEdgeKey.set(makeLayeredEdgeKey(union.id, childId), chain);
    }
  }

  return {
    layers,
    edges,
    dummyChainsByEdgeKey,
    portsByUnitId,
  };
}

interface PortEdgeRef {
  readonly neighborIdx: number;
  readonly neighborPortNorm: number;
  readonly selfPortNorm: number;
}

function countPairCrossings(
  leftRefs: readonly PortEdgeRef[],
  rightRefs: readonly PortEdgeRef[],
  posInLayer: Int32Array
): number {
  let crossings = 0;
  for (const leftRef of leftRefs) {
    const aPos = (posInLayer[leftRef.neighborIdx] ?? 0) + leftRef.neighborPortNorm;
    for (const rightRef of rightRefs) {
      const bPos = (posInLayer[rightRef.neighborIdx] ?? 0) + rightRef.neighborPortNorm;
      if (aPos > bPos + 1e-6) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

function countAllGraphCrossings(
  rowIndicesByLayer: readonly (readonly number[])[],
  downRefs: readonly (readonly PortEdgeRef[])[],
  posInLayer: Int32Array
): number {
  let total = 0;
  for (let l = 0; l < rowIndicesByLayer.length - 1; l += 1) {
    const row = rowIndicesByLayer[l];
    if (!row) continue;
    for (let i = 0; i < row.length; i += 1) {
      const ri = row[i];
      if (ri === undefined) continue;
      const aDown = downRefs[ri];
      if (!aDown || aDown.length === 0) {
        continue;
      }
      for (let j = i + 1; j < row.length; j += 1) {
        const rj = row[j];
        if (rj === undefined) continue;
        const bDown = downRefs[rj];
        if (!bDown || bDown.length === 0) {
          continue;
        }
        total += countPairCrossings(aDown, bDown, posInLayer);
      }
    }
  }
  return total;
}

function computeNodeSpanAtPos(
  nodeIdx: number,
  candPos: number,
  curLen: number,
  upRefs: readonly (readonly PortEdgeRef[])[],
  downRefs: readonly (readonly PortEdgeRef[])[],
  posInLayer: Int32Array,
  upLen: number,
  downLen: number
): number {
  const normSelf = curLen <= 1 ? 0.5 : candPos / (curLen - 1);
  const upDenom = Math.max(1, upLen - 1);
  const downDenom = Math.max(1, downLen - 1);
  let penalty = 0;
  const ups = upRefs[nodeIdx] ?? [];
  for (const ref of ups) {
    const normNbr = upLen <= 1 ? 0.5 : ((posInLayer[ref.neighborIdx] ?? 0) + ref.neighborPortNorm) / upDenom;
    penalty += Math.abs(normSelf - normNbr);
  }
  const downs = downRefs[nodeIdx] ?? [];
  for (const ref of downs) {
    const normNbr =
      downLen <= 1 ? 0.5 : ((posInLayer[ref.neighborIdx] ?? 0) + ref.neighborPortNorm) / downDenom;
    penalty += Math.abs(normSelf - normNbr);
  }
  return penalty;
}

/**
 * Port-aware bidirectional barycenter + O(k^2) incremental 2-sided sifting crossing minimization
 * over the unified unit + multi-generation dummy layered graph, retaining the global best order.
 */
export function minimizeLayeredCrossings(graph: LayeredGraph): LayeredGraph {
  const numLayers = graph.layers.length;
  let totalItems = 0;
  for (const layer of graph.layers) {
    totalItems += layer.length;
  }
  if (totalItems <= 1 || graph.edges.length === 0) {
    return graph;
  }

  const allItems: LayerItem[] = [];
  const idToIdx = new Map<string, number>();
  const rowIndicesByLayer: number[][] = [];
  const posInLayer = new Int32Array(totalItems);
  const bary = new Float64Array(totalItems);

  let cursor = 0;
  for (const layer of graph.layers) {
    const row: number[] = [];
    for (const [r, item] of layer.entries()) {
      allItems.push(item);
      idToIdx.set(item.id, cursor);
      row.push(cursor);
      posInLayer[cursor] = r;
      cursor += 1;
    }
    rowIndicesByLayer.push(row);
  }

  const upRefs: PortEdgeRef[][] = Array.from({ length: totalItems }, () => []);
  const downRefs: PortEdgeRef[][] = Array.from({ length: totalItems }, () => []);

  for (const edge of graph.edges) {
    const srcIdx = idToIdx.get(edge.sourceId);
    const tgtIdx = idToIdx.get(edge.targetId);
    if (srcIdx === undefined || tgtIdx === undefined) {
      continue;
    }
    downRefs[srcIdx]?.push({
      neighborIdx: tgtIdx,
      neighborPortNorm: edge.targetPortNorm,
      selfPortNorm: edge.sourcePortNorm,
    });
    upRefs[tgtIdx]?.push({
      neighborIdx: srcIdx,
      neighborPortNorm: edge.sourcePortNorm,
      selfPortNorm: edge.targetPortNorm,
    });
  }

  const byBarycenter = (a: number, b: number): number => {
    const diff = (bary[a] ?? 0) - (bary[b] ?? 0);
    if (Math.abs(diff) > 1e-6) {
      return diff;
    }
    return (posInLayer[a] ?? 0) - (posInLayer[b] ?? 0);
  };

  const refineLayerBarycenter = (
    layerIdx: number,
    refs: readonly (readonly PortEdgeRef[])[],
    adjLayerLen: number
  ): boolean => {
    const row = rowIndicesByLayer[layerIdx];
    if (!row) return false;
    const curLen = row.length;
    if (curLen <= 1) {
      return false;
    }
    let outOfOrder = false;
    let prevVal = Number.NEGATIVE_INFINITY;
    const scale = adjLayerLen > 1 && curLen > 1 ? (adjLayerLen - 1) / (curLen - 1) : 1;

    for (const idx of row) {
      const list = refs[idx] ?? [];
      let val: number;
      if (list.length > 0) {
        let sum = 0;
        for (const ref of list) {
          sum += (posInLayer[ref.neighborIdx] ?? 0) + ref.neighborPortNorm - ref.selfPortNorm;
        }
        val = sum / list.length;
      } else {
        val = (posInLayer[idx] ?? 0) * scale;
      }
      bary[idx] = val;
      if (val < prevVal - 1e-6) {
        outOfOrder = true;
      } else if (val > prevVal) {
        prevVal = val;
      }
    }

    let changed = false;
    if (outOfOrder) {
      row.sort(byBarycenter);
      for (const [r, idx] of row.entries()) {
        if (posInLayer[idx] !== r) {
          posInLayer[idx] = r;
          changed = true;
        }
      }
    }
    return changed;
  };

  const greedySwitchLayer = (layerIdx: number): boolean => {
    const row = rowIndicesByLayer[layerIdx];
    if (!row) return false;
    const curLen = row.length;
    if (curLen <= 1) {
      return false;
    }
    let changed = false;
    let swapped = true;
    while (swapped) {
      swapped = false;
      for (let r = 0; r < curLen - 1; r += 1) {
        const a = row[r];
        const b = row[r + 1];
        if (a === undefined || b === undefined) continue;
        const aUp = upRefs[a] ?? [];
        const bUp = upRefs[b] ?? [];
        const aDown = downRefs[a] ?? [];
        const bDown = downRefs[b] ?? [];
        const curCross =
          countPairCrossings(aUp, bUp, posInLayer) + countPairCrossings(aDown, bDown, posInLayer);
        if (curCross === 0) {
          continue;
        }
        const swapCross =
          countPairCrossings(bUp, aUp, posInLayer) + countPairCrossings(bDown, aDown, posInLayer);
        if (swapCross < curCross) {
          row[r] = b;
          row[r + 1] = a;
          posInLayer[b] = r;
          posInLayer[a] = r + 1;
          swapped = true;
          changed = true;
        }
      }
    }
    return changed;
  };

  // O(k^2) incremental 2-sided sifting: sweeps each item across all slots tracking delta crossings in O(1) per swap.
  let crossAtPosBuf = new Int32Array(64);
  const siftLayerIncremental = (layerIdx: number): boolean => {
    const row = rowIndicesByLayer[layerIdx];
    if (!row) return false;
    const curLen = row.length;
    if (curLen <= 2) {
      return false;
    }
    if (crossAtPosBuf.length < curLen) {
      crossAtPosBuf = new Int32Array(curLen);
    }
    const upLen = layerIdx > 0 ? (rowIndicesByLayer[layerIdx - 1]?.length ?? 0) : 0;
    const downLen = layerIdx < numLayers - 1 ? (rowIndicesByLayer[layerIdx + 1]?.length ?? 0) : 0;
    const snapshot = row.slice();
    let changed = false;

    for (const x of snapshot) {
      const xUp = upRefs[x] ?? [];
      const xDown = downRefs[x] ?? [];
      if (xUp.length === 0 && xDown.length === 0) {
        continue;
      }
      const origPos = posInLayer[x] ?? 0;
      row.splice(origPos, 1);

      let relCross = 0;
      let origRelCross = 0;
      crossAtPosBuf[0] = 0;
      for (let p = 0; p < curLen - 1; p += 1) {
        const y = row[p];
        if (y === undefined) continue;
        const yUp = upRefs[y] ?? [];
        const yDown = downRefs[y] ?? [];
        const xBeforeY =
          countPairCrossings(xUp, yUp, posInLayer) + countPairCrossings(xDown, yDown, posInLayer);
        const yBeforeX =
          countPairCrossings(yUp, xUp, posInLayer) + countPairCrossings(yDown, xDown, posInLayer);
        relCross += yBeforeX - xBeforeY;
        crossAtPosBuf[p + 1] = relCross;
        if (p + 1 === origPos) {
          origRelCross = relCross;
        }
      }

      let bestPos = origPos;
      let bestCross = origRelCross;
      let bestSpan = computeNodeSpanAtPos(x, origPos, curLen, upRefs, downRefs, posInLayer, upLen, downLen);

      for (let candPos = 0; candPos < curLen; candPos += 1) {
        if (candPos === origPos) {
          continue;
        }
        const candCross = crossAtPosBuf[candPos] ?? 0;
        if (candCross < bestCross) {
          bestCross = candCross;
          bestSpan = computeNodeSpanAtPos(x, candPos, curLen, upRefs, downRefs, posInLayer, upLen, downLen);
          bestPos = candPos;
        } else if (candCross === bestCross) {
          const candSpan = computeNodeSpanAtPos(
            x,
            candPos,
            curLen,
            upRefs,
            downRefs,
            posInLayer,
            upLen,
            downLen
          );
          if (candSpan < bestSpan - 1e-4) {
            bestSpan = candSpan;
            bestPos = candPos;
          }
        }
      }

      row.splice(bestPos, 0, x);
      if (bestPos !== origPos) {
        const lo = Math.min(origPos, bestPos);
        const hi = Math.max(origPos, bestPos);
        for (let r = lo; r <= hi; r += 1) {
          const rowItem = row[r];
          if (rowItem !== undefined) {
            posInLayer[rowItem] = r;
          }
        }
        changed = true;
      }
    }
    return changed;
  };

  let bestCrossings = countAllGraphCrossings(rowIndicesByLayer, downRefs, posInLayer);
  let bestSnapshot: number[][] = rowIndicesByLayer.map((row) => row.slice());

  const maybeRecordBest = (): void => {
    const cur = countAllGraphCrossings(rowIndicesByLayer, downRefs, posInLayer);
    if (cur <= bestCrossings) {
      bestCrossings = cur;
      bestSnapshot = rowIndicesByLayer.map((row) => row.slice());
    }
  };

  for (let sweep = 0; sweep < 4; sweep += 1) {
    let changed = false;
    for (let l = 1; l < numLayers; l += 1) {
      if (refineLayerBarycenter(l, upRefs, rowIndicesByLayer[l - 1]?.length ?? 0)) {
        changed = true;
      }
      if (greedySwitchLayer(l)) {
        changed = true;
      }
    }
    maybeRecordBest();

    for (let l = numLayers - 2; l >= 0; l -= 1) {
      if (refineLayerBarycenter(l, downRefs, rowIndicesByLayer[l + 1]?.length ?? 0)) {
        changed = true;
      }
      if (greedySwitchLayer(l)) {
        changed = true;
      }
    }
    maybeRecordBest();

    if (!changed) {
      break;
    }
  }

  // Restore best barycenter ordering, then run one fast O(k^2) top-down + bottom-up sifting pass.
  for (let l = 0; l < numLayers; l += 1) {
    const restored = bestSnapshot[l]?.slice() ?? [];
    rowIndicesByLayer[l] = restored;
    for (const [r, idx] of restored.entries()) {
      posInLayer[idx] = r;
    }
  }

  for (let l = 0; l < numLayers; l += 1) {
    siftLayerIncremental(l);
  }
  for (let l = numLayers - 1; l >= 0; l -= 1) {
    siftLayerIncremental(l);
  }

  const orderedLayers: LayerItem[][] = rowIndicesByLayer.map((row) => {
    const out: LayerItem[] = [];
    for (const idx of row) {
      const item = allItems[idx];
      if (item) {
        out.push(item);
      }
    }
    return out;
  });

  return {
    layers: orderedLayers,
    edges: graph.edges,
    dummyChainsByEdgeKey: graph.dummyChainsByEdgeKey,
    portsByUnitId: graph.portsByUnitId,
  };
}
