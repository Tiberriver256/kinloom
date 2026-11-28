import {
  DUMMY_TO_DUMMY_GAP,
  DUMMY_TO_UNIT_GAP,
  type LayeredEdge,
  type LayeredGraph,
  type LayerItem,
} from './layeredChannels.js';
import { ARCHIVAL_UNIT_GAP } from './types.js';

export function minItemSeparation(left: LayerItem, right: LayerItem): number {
  if (left.kind === 'dummy' && right.kind === 'dummy') {
    return DUMMY_TO_DUMMY_GAP;
  }
  if (left.kind === 'dummy' || right.kind === 'dummy') {
    return DUMMY_TO_UNIT_GAP;
  }
  return ARCHIVAL_UNIT_GAP;
}

interface IndexedNeighbor {
  readonly neighborIdx: number;
  readonly selfPortX: number;
  readonly neighborPortX: number;
  readonly isInnerSegment: boolean;
  readonly edgeIdx: number;
}

interface PreparedPassGraph {
  readonly layers: readonly (readonly number[])[];
  readonly items: readonly LayerItem[];
  readonly posInLayer: Int32Array;
  readonly upperNeighbors: readonly (readonly IndexedNeighbor[])[];
  readonly lowerNeighbors: readonly (readonly IndexedNeighbor[])[];
  readonly conflictedEdges: Uint8Array;
}

function buildPreparedPassGraph(
  graph: LayeredGraph,
  mirrorHorizontal: boolean
): {
  readonly prepared: PreparedPassGraph;
  readonly idToIdx: ReadonlyMap<string, number>;
} {
  const numLayers = graph.layers.length;
  let total = 0;
  for (let l = 0; l < numLayers; l += 1) {
    total += graph.layers[l].length;
  }

  const items: LayerItem[] = new Array(total);
  const idToIdx = new Map<string, number>();
  const layers: number[][] = new Array(numLayers);
  const posInLayer = new Int32Array(total);

  let cursor = 0;
  for (let l = 0; l < numLayers; l += 1) {
    const srcLayer = graph.layers[l];
    const len = srcLayer.length;
    const row = new Array<number>(len);
    for (let r = 0; r < len; r += 1) {
      const item = mirrorHorizontal ? srcLayer[len - 1 - r] : srcLayer[r];
      items[cursor] = item;
      idToIdx.set(item.id, cursor);
      row[r] = cursor;
      posInLayer[cursor] = r;
      cursor += 1;
    }
    layers[l] = row;
  }

  const upperNeighbors: IndexedNeighbor[][] = Array.from({ length: total }, () => []);
  const lowerNeighbors: IndexedNeighbor[][] = Array.from({ length: total }, () => []);

  for (let e = 0; e < graph.edges.length; e += 1) {
    const edge: LayeredEdge = graph.edges[e];
    const srcIdx = idToIdx.get(edge.sourceId);
    const tgtIdx = idToIdx.get(edge.targetId);
    if (srcIdx === undefined || tgtIdx === undefined) {
      continue;
    }
    const srcItem = items[srcIdx];
    const tgtItem = items[tgtIdx];
    const srcPortX = mirrorHorizontal ? srcItem.width - edge.sourcePortOffsetX : edge.sourcePortOffsetX;
    const tgtPortX = mirrorHorizontal ? tgtItem.width - edge.targetPortOffsetX : edge.targetPortOffsetX;

    lowerNeighbors[srcIdx].push({
      neighborIdx: tgtIdx,
      selfPortX: srcPortX,
      neighborPortX: tgtPortX,
      isInnerSegment: edge.isInnerSegment,
      edgeIdx: e,
    });
    upperNeighbors[tgtIdx].push({
      neighborIdx: srcIdx,
      selfPortX: tgtPortX,
      neighborPortX: srcPortX,
      isInnerSegment: edge.isInnerSegment,
      edgeIdx: e,
    });
  }

  const byNeighborOrder = (a: IndexedNeighbor, b: IndexedNeighbor): number => {
    const posDiff = posInLayer[a.neighborIdx] - posInLayer[b.neighborIdx];
    if (posDiff !== 0) {
      return posDiff;
    }
    return a.neighborPortX - b.neighborPortX;
  };
  for (let i = 0; i < total; i += 1) {
    if (upperNeighbors[i].length > 1) {
      upperNeighbors[i].sort(byNeighborOrder);
    }
    if (lowerNeighbors[i].length > 1) {
      lowerNeighbors[i].sort(byNeighborOrder);
    }
  }

  // Brandes-Kopf Algorithm 1: mark Type-1 conflicts (non-inner edge crossing an inner dummy segment).
  const conflictedEdges = new Uint8Array(graph.edges.length);
  for (let l = 1; l < numLayers - 1; l += 1) {
    const lowerRow = layers[l + 1];
    const upperLen = layers[l].length;
    if (lowerRow.length === 0 || upperLen === 0) {
      continue;
    }
    let k0 = 0;
    let scanStart = 0;
    for (let l1 = 0; l1 < lowerRow.length; l1 += 1) {
      const v = lowerRow[l1];
      const ups = upperNeighbors[v];
      let innerUpperPos = -1;
      for (let i = 0; i < ups.length; i += 1) {
        if (ups[i].isInnerSegment) {
          innerUpperPos = posInLayer[ups[i].neighborIdx];
          break;
        }
      }
      if (l1 === lowerRow.length - 1 || innerUpperPos >= 0) {
        const k1 = innerUpperPos >= 0 ? innerUpperPos : upperLen - 1;
        while (scanStart <= l1) {
          const w = lowerRow[scanStart];
          const wUps = upperNeighbors[w];
          for (let i = 0; i < wUps.length; i += 1) {
            const ref = wUps[i];
            if (ref.isInnerSegment) {
              continue;
            }
            const uPos = posInLayer[ref.neighborIdx];
            if (uPos < k0 || uPos > k1) {
              conflictedEdges[ref.edgeIdx] = 1;
            }
          }
          scanStart += 1;
        }
        k0 = k1;
      }
    }
  }

  return {
    prepared: {
      layers,
      items,
      posInLayer,
      upperNeighbors,
      lowerNeighbors,
      conflictedEdges,
    },
    idToIdx,
  };
}

function runVerticalAlignmentAndCompaction(
  prepared: PreparedPassGraph,
  verticalDir: 'up' | 'down'
): Float64Array {
  const { layers, items, posInLayer, upperNeighbors, lowerNeighbors, conflictedEdges } = prepared;
  const total = items.length;
  const numLayers = layers.length;

  const root = new Int32Array(total);
  const align = new Int32Array(total);
  const delta = new Float64Array(total);
  for (let i = 0; i < total; i += 1) {
    root[i] = i;
    align[i] = i;
  }

  // Brandes-Kopf Algorithm 2: monotonic port-aware vertical alignment.
  const neighborsOf = verticalDir === 'up' ? upperNeighbors : lowerNeighbors;
  const startLayer = verticalDir === 'up' ? 1 : numLayers - 2;
  const endLayer = verticalDir === 'up' ? numLayers : -1;
  const layerStep = verticalDir === 'up' ? 1 : -1;

  for (let l = startLayer; l !== endLayer; l += layerStep) {
    const row = layers[l];
    let lastAlignedPos = -1;
    for (let r = 0; r < row.length; r += 1) {
      const v = row[r];
      const nbrs = neighborsOf[v];
      const deg = nbrs.length;
      if (deg === 0) {
        continue;
      }
      const m1 = Math.floor((deg - 1) / 2);
      const m2 = Math.ceil((deg - 1) / 2);
      for (let m = m1; m <= m2; m += 1) {
        if (align[v] !== v) {
          break;
        }
        const ref = nbrs[m];
        if (conflictedEdges[ref.edgeIdx] === 1) {
          continue;
        }
        const u = ref.neighborIdx;
        const uPos = posInLayer[u];
        if (lastAlignedPos < uPos) {
          align[u] = v;
          root[v] = root[u];
          align[v] = root[v];
          delta[v] = delta[u] + (ref.neighborPortX - ref.selfPortX);
          lastAlignedPos = uPos;
        }
      }
    }
  }

  // Brandes-Kopf Algorithm 3 (ELK BKCompactor variant): acyclic block-DAG longest-path + sink-class compaction.
  const blockMembers = new Map<number, number[]>();
  for (let i = 0; i < total; i += 1) {
    const r = root[i];
    const list = blockMembers.get(r);
    if (list) {
      list.push(i);
    } else {
      blockMembers.set(r, [i]);
    }
  }

  const blockRoots: number[] = [];
  const blockMemberLists: number[][] = [];
  for (const [blockRoot, members] of blockMembers.entries()) {
    blockRoots.push(blockRoot);
    blockMemberLists.push(members);
  }
  const blockCount = blockRoots.length;
  const rootToBlockIdx = new Int32Array(total).fill(-1);
  for (let b = 0; b < blockCount; b += 1) {
    rootToBlockIdx[blockRoots[b]] = b;
  }

  // Build weighted block DAG edges: predBlock -> curBlock with weight reqDiff.
  const outEdges: { readonly to: number; readonly weight: number }[][] = Array.from(
    { length: blockCount },
    () => []
  );
  const inDegree = new Int32Array(blockCount);

  for (let l = 0; l < numLayers; l += 1) {
    const row = layers[l];
    for (let r = 1; r < row.length; r += 1) {
      const pred = row[r - 1];
      const cur = row[r];
      const pb = rootToBlockIdx[root[pred]];
      const cb = rootToBlockIdx[root[cur]];
      if (pb === cb) {
        continue;
      }
      const sep = minItemSeparation(items[pred], items[cur]);
      const weight = delta[pred] + items[pred].width + sep - delta[cur];
      outEdges[pb].push({ to: cb, weight });
      inDegree[cb] += 1;
    }
  }

  // Kahn's topological sort (guaranteed acyclic by monotonic vertical alignment).
  const topo = new Int32Array(blockCount);
  const queue = new Int32Array(blockCount);
  let qHead = 0;
  let qTail = 0;
  for (let b = 0; b < blockCount; b += 1) {
    if (inDegree[b] === 0) {
      queue[qTail] = b;
      qTail += 1;
    }
  }
  let topoLen = 0;
  while (qHead < qTail) {
    const b = queue[qHead];
    qHead += 1;
    topo[topoLen] = b;
    topoLen += 1;
    const edges = outEdges[b];
    for (let i = 0; i < edges.length; i += 1) {
      const nxt = edges[i].to;
      inDegree[nxt] -= 1;
      if (inDegree[nxt] === 0) {
        queue[qTail] = nxt;
        qTail += 1;
      }
    }
  }

  // Pass 1: leftmost valid coordinates + tight-driver sink class labeling.
  const bx = new Float64Array(blockCount);
  const sink = new Int32Array(blockCount);
  for (let b = 0; b < blockCount; b += 1) {
    const members = blockMemberLists[b];
    let minDelta = 0;
    for (let i = 0; i < members.length; i += 1) {
      const d = delta[members[i]];
      if (d < minDelta) {
        minDelta = d;
      }
    }
    bx[b] = -minDelta;
    sink[b] = b;
  }

  for (let t = 0; t < topoLen; t += 1) {
    const b = topo[t];
    const edges = outEdges[b];
    for (let i = 0; i < edges.length; i += 1) {
      const e = edges[i];
      const candidate = bx[b] + e.weight;
      if (candidate > bx[e.to]) {
        bx[e.to] = candidate;
        sink[e.to] = sink[b];
      }
    }
  }

  // Pass 2: compact sink classes rightward in reverse topological order without violating any edge.
  const classBlocks = new Map<number, number[]>();
  for (let t = topoLen - 1; t >= 0; t -= 1) {
    const b = topo[t];
    const s = sink[b];
    const list = classBlocks.get(s);
    if (list) {
      list.push(b);
    } else {
      classBlocks.set(s, [b]);
    }
  }

  for (const [cls, blocksInCls] of classBlocks.entries()) {
    let minSlack = Number.POSITIVE_INFINITY;
    for (let i = 0; i < blocksInCls.length; i += 1) {
      const b = blocksInCls[i];
      const edges = outEdges[b];
      for (let j = 0; j < edges.length; j += 1) {
        const e = edges[j];
        if (sink[e.to] === cls) {
          continue;
        }
        const slack = bx[e.to] - (bx[b] + e.weight);
        if (slack < minSlack) {
          minSlack = slack;
        }
      }
    }
    if (Number.isFinite(minSlack) && minSlack > 0) {
      for (let i = 0; i < blocksInCls.length; i += 1) {
        bx[blocksInCls[i]] += minSlack;
      }
    }
  }

  const coords = new Float64Array(total);
  for (let i = 0; i < total; i += 1) {
    const bIdx = rootToBlockIdx[root[i]];
    coords[i] = bx[bIdx] + delta[i];
  }
  return coords;
}

/**
 * Brandes-Kopf 4-pass directional horizontal coordinate assignment (`BKNodePlacer`) in O(V + E).
 * Honors full UnitFootprint widths, virtual dummy-channel widths, and marriage port offsets
 * while strictly guaranteeing zero horizontal overlap in every generation band.
 */
export function assignBrandesKopfX(graph: LayeredGraph, leftPad: number): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  const numLayers = graph.layers.length;
  let totalItems = 0;
  for (let l = 0; l < numLayers; l += 1) {
    totalItems += graph.layers[l].length;
  }
  if (totalItems === 0) {
    return result;
  }

  const leftSetup = buildPreparedPassGraph(graph, false);
  const rightSetup = buildPreparedPassGraph(graph, true);

  const rawUL = runVerticalAlignmentAndCompaction(leftSetup.prepared, 'up');
  const rawDL = runVerticalAlignmentAndCompaction(leftSetup.prepared, 'down');
  const mirroredUR = runVerticalAlignmentAndCompaction(rightSetup.prepared, 'up');
  const mirroredDR = runVerticalAlignmentAndCompaction(rightSetup.prepared, 'down');

  // Unmirror right passes back into left-to-right item index order of leftSetup.
  const rawUR = new Float64Array(totalItems);
  const rawDR = new Float64Array(totalItems);
  const leftItems = leftSetup.prepared.items;
  for (let l = 0; l < numLayers; l += 1) {
    const leftRow = leftSetup.prepared.layers[l];
    const rightRow = rightSetup.prepared.layers[l];
    const len = leftRow.length;
    for (let r = 0; r < len; r += 1) {
      const leftIdx = leftRow[r];
      const rightIdx = rightRow[len - 1 - r];
      const width = leftItems[leftIdx].width;
      rawUR[leftIdx] = -mirroredUR[rightIdx] - width;
      rawDR[leftIdx] = -mirroredDR[rightIdx] - width;
    }
  }

  const passes: readonly { readonly coords: Float64Array; readonly alignSide: 'left' | 'right' }[] = [
    { coords: rawUL, alignSide: 'left' },
    { coords: rawUR, alignSide: 'right' },
    { coords: rawDL, alignSide: 'left' },
    { coords: rawDR, alignSide: 'right' },
  ];

  // Brandes-Kopf Algorithm 4: align all 4 passes to the narrowest layout, then take balanced median.
  let minSpanWidth = Number.POSITIVE_INFINITY;
  let refMin = 0;
  let refMax = 0;
  const passMin = new Float64Array(4);
  const passMax = new Float64Array(4);

  for (let p = 0; p < 4; p += 1) {
    const coords = passes[p].coords;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < totalItems; i += 1) {
      const x0 = coords[i];
      const x1 = x0 + leftItems[i].width;
      if (x0 < lo) lo = x0;
      if (x1 > hi) hi = x1;
    }
    passMin[p] = lo;
    passMax[p] = hi;
    const span = hi - lo;
    if (span < minSpanWidth) {
      minSpanWidth = span;
      refMin = lo;
      refMax = hi;
    }
  }

  const shifts = new Float64Array(4);
  for (let p = 0; p < 4; p += 1) {
    shifts[p] = passes[p].alignSide === 'left' ? refMin - passMin[p] : refMax - passMax[p];
  }

  const finalX = new Float64Array(totalItems);
  const buf = [0, 0, 0, 0];
  for (let i = 0; i < totalItems; i += 1) {
    buf[0] = rawUL[i] + shifts[0];
    buf[1] = rawUR[i] + shifts[1];
    buf[2] = rawDL[i] + shifts[2];
    buf[3] = rawDR[i] + shifts[3];
    // 4-element sorting network (branchless, zero allocations).
    if (buf[0] > buf[1]) {
      const t = buf[0];
      buf[0] = buf[1];
      buf[1] = t;
    }
    if (buf[2] > buf[3]) {
      const t = buf[2];
      buf[2] = buf[3];
      buf[3] = t;
    }
    if (buf[0] > buf[2]) {
      const t = buf[0];
      buf[0] = buf[2];
      buf[2] = t;
    }
    if (buf[1] > buf[3]) {
      const t = buf[1];
      buf[1] = buf[3];
      buf[3] = t;
    }
    if (buf[1] > buf[2]) {
      const t = buf[1];
      buf[1] = buf[2];
      buf[2] = t;
    }
    finalX[i] = Math.round((buf[1] + buf[2]) / 2);
  }

  // Enforce integer non-overlap after rounding.
  let globalMinX = Number.POSITIVE_INFINITY;
  let globalMaxRight = Number.NEGATIVE_INFINITY;
  for (let l = 0; l < numLayers; l += 1) {
    const row = leftSetup.prepared.layers[l];
    for (let r = 0; r < row.length; r += 1) {
      const cur = row[r];
      if (r > 0) {
        const prev = row[r - 1];
        const minAllowed =
          finalX[prev] + leftItems[prev].width + minItemSeparation(leftItems[prev], leftItems[cur]);
        if (finalX[cur] < minAllowed) {
          finalX[cur] = Math.ceil(minAllowed);
        }
      }
      if (finalX[cur] < globalMinX) {
        globalMinX = finalX[cur];
      }
      if (finalX[cur] + leftItems[cur].width > globalMaxRight) {
        globalMaxRight = finalX[cur] + leftItems[cur].width;
      }
    }
  }

  // Post-BK free-interval parent-over-children centering (O(V + E), strictly non-overlapping).
  const { upperNeighbors, lowerNeighbors } = leftSetup.prepared;
  for (let l = numLayers - 2; l >= 0; l -= 1) {
    const row = leftSetup.prepared.layers[l];
    for (let r = 0; r < row.length; r += 1) {
      const idx = row[r];
      const item = leftItems[idx];
      if (item.kind === 'dummy') {
        continue;
      }
      const downs = lowerNeighbors[idx];
      if (downs.length === 0) {
        continue;
      }
      let downMean = 0;
      for (let k = 0; k < downs.length; k += 1) {
        const ref = downs[k];
        downMean += finalX[ref.neighborIdx] + ref.neighborPortX - ref.selfPortX;
      }
      const desiredX = Math.round(downMean / downs.length);
      const minBound =
        r > 0
          ? finalX[row[r - 1]] + leftItems[row[r - 1]].width + minItemSeparation(leftItems[row[r - 1]], item)
          : globalMinX;
      const maxBound =
        r < row.length - 1
          ? finalX[row[r + 1]] - minItemSeparation(item, leftItems[row[r + 1]]) - item.width
          : globalMaxRight - item.width;
      if (minBound <= maxBound) {
        finalX[idx] = Math.round(Math.max(minBound, Math.min(maxBound, desiredX)));
      }
    }
  }

  // Pull childless leaf units cleanly beneath their parent port within free horizontal space.
  for (let l = 1; l < numLayers; l += 1) {
    const row = leftSetup.prepared.layers[l];
    for (let r = 0; r < row.length; r += 1) {
      const idx = row[r];
      const item = leftItems[idx];
      if (item.kind === 'dummy' || lowerNeighbors[idx].length > 0) {
        continue;
      }
      const ups = upperNeighbors[idx];
      if (ups.length === 0) {
        continue;
      }
      let upMean = 0;
      for (let k = 0; k < ups.length; k += 1) {
        const ref = ups[k];
        upMean += finalX[ref.neighborIdx] + ref.neighborPortX - ref.selfPortX;
      }
      const desiredX = Math.round(upMean / ups.length);
      const minBound =
        r > 0
          ? finalX[row[r - 1]] + leftItems[row[r - 1]].width + minItemSeparation(leftItems[row[r - 1]], item)
          : globalMinX;
      const maxBound =
        r < row.length - 1
          ? finalX[row[r + 1]] - minItemSeparation(item, leftItems[row[r + 1]]) - item.width
          : globalMaxRight - item.width;
      if (minBound <= maxBound) {
        finalX[idx] = Math.round(Math.max(minBound, Math.min(maxBound, desiredX)));
      }
    }
  }

  globalMinX = Number.POSITIVE_INFINITY;
  for (let i = 0; i < totalItems; i += 1) {
    if (finalX[i] < globalMinX) {
      globalMinX = finalX[i];
    }
  }

  const normalizeShift = Math.round(leftPad - globalMinX);
  for (let i = 0; i < totalItems; i += 1) {
    result.set(leftItems[i].id, Math.round(finalX[i] + normalizeShift));
  }
  return result;
}
