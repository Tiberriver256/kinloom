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

  for (let gSlot = 0; gSlot < numLayers; gSlot += 1) {
    const units = model.generations[gSlot].units;
    const layer: LayerItem[] = new Array(units.length);
    for (let uIdx = 0; uIdx < units.length; uIdx += 1) {
      const unit = units[uIdx];
      const portSlots = resolveUnitUnionPorts(model, unit);
      const portMap = new Map<string, UnionPortSlot>();
      for (let p = 0; p < portSlots.length; p += 1) {
        portMap.set(portSlots[p].unionId, portSlots[p]);
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
      layer[uIdx] = item;
      unitItemById.set(unit.id, item);

      for (let u = 0; u < unit.unionIds.length; u += 1) {
        unitByUnionId.set(unit.unionIds[u], item);
      }

      const memberCount = unit.orderedMemberIds.length;
      for (let m = 0; m < memberCount; m += 1) {
        const pid = unit.orderedMemberIds[m];
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

  for (let u = 0; u < model.unions.length; u += 1) {
    const union = model.unions[u];
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

    for (let c = 0; c < union.visibleChildIds.length; c += 1) {
      const childId = union.visibleChildIds[c];
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
        layers[s].push(dummyItem);
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
  for (let i = 0; i < leftRefs.length; i += 1) {
    const aPos = posInLayer[leftRefs[i].neighborIdx] + leftRefs[i].neighborPortNorm;
    for (let j = 0; j < rightRefs.length; j += 1) {
      const bPos = posInLayer[rightRefs[j].neighborIdx] + rightRefs[j].neighborPortNorm;
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
    for (let i = 0; i < row.length; i += 1) {
      const aDown = downRefs[row[i]];
      if (aDown.length === 0) {
        continue;
      }
      for (let j = i + 1; j < row.length; j += 1) {
        const bDown = downRefs[row[j]];
        if (bDown.length === 0) {
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
  const ups = upRefs[nodeIdx];
  for (let k = 0; k < ups.length; k += 1) {
    const ref = ups[k];
    const normNbr = upLen <= 1 ? 0.5 : (posInLayer[ref.neighborIdx] + ref.neighborPortNorm) / upDenom;
    penalty += Math.abs(normSelf - normNbr);
  }
  const downs = downRefs[nodeIdx];
  for (let k = 0; k < downs.length; k += 1) {
    const ref = downs[k];
    const normNbr = downLen <= 1 ? 0.5 : (posInLayer[ref.neighborIdx] + ref.neighborPortNorm) / downDenom;
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
  for (let l = 0; l < numLayers; l += 1) {
    totalItems += graph.layers[l].length;
  }
  if (totalItems <= 1 || graph.edges.length === 0) {
    return graph;
  }

  const allItems: LayerItem[] = new Array(totalItems);
  const idToIdx = new Map<string, number>();
  const rowIndicesByLayer: number[][] = new Array(numLayers);
  const posInLayer = new Int32Array(totalItems);
  const bary = new Float64Array(totalItems);

  let cursor = 0;
  for (let l = 0; l < numLayers; l += 1) {
    const layer = graph.layers[l];
    const row = new Array<number>(layer.length);
    for (let r = 0; r < layer.length; r += 1) {
      const item = layer[r];
      allItems[cursor] = item;
      idToIdx.set(item.id, cursor);
      row[r] = cursor;
      posInLayer[cursor] = r;
      cursor += 1;
    }
    rowIndicesByLayer[l] = row;
  }

  const upRefs: PortEdgeRef[][] = Array.from({ length: totalItems }, () => []);
  const downRefs: PortEdgeRef[][] = Array.from({ length: totalItems }, () => []);

  for (let e = 0; e < graph.edges.length; e += 1) {
    const edge = graph.edges[e];
    const srcIdx = idToIdx.get(edge.sourceId);
    const tgtIdx = idToIdx.get(edge.targetId);
    if (srcIdx === undefined || tgtIdx === undefined) {
      continue;
    }
    downRefs[srcIdx].push({
      neighborIdx: tgtIdx,
      neighborPortNorm: edge.targetPortNorm,
      selfPortNorm: edge.sourcePortNorm,
    });
    upRefs[tgtIdx].push({
      neighborIdx: srcIdx,
      neighborPortNorm: edge.sourcePortNorm,
      selfPortNorm: edge.targetPortNorm,
    });
  }

  const byBarycenter = (a: number, b: number): number => {
    const diff = bary[a] - bary[b];
    if (Math.abs(diff) > 1e-6) {
      return diff;
    }
    return posInLayer[a] - posInLayer[b];
  };

  const refineLayerBarycenter = (
    layerIdx: number,
    refs: readonly (readonly PortEdgeRef[])[],
    adjLayerLen: number
  ): boolean => {
    const row = rowIndicesByLayer[layerIdx];
    const curLen = row.length;
    if (curLen <= 1) {
      return false;
    }
    let outOfOrder = false;
    let prevVal = Number.NEGATIVE_INFINITY;
    const scale = adjLayerLen > 1 && curLen > 1 ? (adjLayerLen - 1) / (curLen - 1) : 1;

    for (let r = 0; r < curLen; r += 1) {
      const idx = row[r];
      const list = refs[idx];
      let val: number;
      if (list.length > 0) {
        let sum = 0;
        for (let k = 0; k < list.length; k += 1) {
          const ref = list[k];
          sum += posInLayer[ref.neighborIdx] + ref.neighborPortNorm - ref.selfPortNorm;
        }
        val = sum / list.length;
      } else {
        val = posInLayer[idx] * scale;
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
      for (let r = 0; r < curLen; r += 1) {
        if (posInLayer[row[r]] !== r) {
          posInLayer[row[r]] = r;
          changed = true;
        }
      }
    }
    return changed;
  };

  const greedySwitchLayer = (layerIdx: number): boolean => {
    const row = rowIndicesByLayer[layerIdx];
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
        const curCross =
          countPairCrossings(upRefs[a], upRefs[b], posInLayer) +
          countPairCrossings(downRefs[a], downRefs[b], posInLayer);
        if (curCross === 0) {
          continue;
        }
        const swapCross =
          countPairCrossings(upRefs[b], upRefs[a], posInLayer) +
          countPairCrossings(downRefs[b], downRefs[a], posInLayer);
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
    const curLen = row.length;
    if (curLen <= 2) {
      return false;
    }
    if (crossAtPosBuf.length < curLen) {
      crossAtPosBuf = new Int32Array(curLen);
    }
    const upLen = layerIdx > 0 ? rowIndicesByLayer[layerIdx - 1].length : 0;
    const downLen = layerIdx < numLayers - 1 ? rowIndicesByLayer[layerIdx + 1].length : 0;
    const snapshot = row.slice();
    let changed = false;

    for (let s = 0; s < snapshot.length; s += 1) {
      const x = snapshot[s];
      const xUp = upRefs[x];
      const xDown = downRefs[x];
      if (xUp.length === 0 && xDown.length === 0) {
        continue;
      }
      const origPos = posInLayer[x];
      row.splice(origPos, 1);

      let relCross = 0;
      let origRelCross = 0;
      crossAtPosBuf[0] = 0;
      for (let p = 0; p < curLen - 1; p += 1) {
        const y = row[p];
        const xBeforeY =
          countPairCrossings(xUp, upRefs[y], posInLayer) + countPairCrossings(xDown, downRefs[y], posInLayer);
        const yBeforeX =
          countPairCrossings(upRefs[y], xUp, posInLayer) + countPairCrossings(downRefs[y], xDown, posInLayer);
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
        const candCross = crossAtPosBuf[candPos];
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
          posInLayer[row[r]] = r;
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
      if (refineLayerBarycenter(l, upRefs, rowIndicesByLayer[l - 1].length)) {
        changed = true;
      }
      if (greedySwitchLayer(l)) {
        changed = true;
      }
    }
    maybeRecordBest();

    for (let l = numLayers - 2; l >= 0; l -= 1) {
      if (refineLayerBarycenter(l, downRefs, rowIndicesByLayer[l + 1].length)) {
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
    rowIndicesByLayer[l] = bestSnapshot[l].slice();
    for (let r = 0; r < rowIndicesByLayer[l].length; r += 1) {
      posInLayer[rowIndicesByLayer[l][r]] = r;
    }
  }

  for (let l = 0; l < numLayers; l += 1) {
    siftLayerIncremental(l);
  }
  for (let l = numLayers - 1; l >= 0; l -= 1) {
    siftLayerIncremental(l);
  }

  const orderedLayers: LayerItem[][] = new Array(numLayers);
  for (let l = 0; l < numLayers; l += 1) {
    const row = rowIndicesByLayer[l];
    const out = new Array<LayerItem>(row.length);
    for (let r = 0; r < row.length; r += 1) {
      out[r] = allItems[row[r]];
    }
    orderedLayers[l] = out;
  }

  return {
    layers: orderedLayers,
    edges: graph.edges,
    dummyChainsByEdgeKey: graph.dummyChainsByEdgeKey,
    portsByUnitId: graph.portsByUnitId,
  };
}
