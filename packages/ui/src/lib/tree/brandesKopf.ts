import {
  DUMMY_TO_DUMMY_GAP,
  DUMMY_TO_UNIT_GAP,
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
  for (const layer of graph.layers) {
    total += layer.length;
  }

  const items: LayerItem[] = [];
  const idToIdx = new Map<string, number>();
  const layers: number[][] = [];
  const posInLayer = new Int32Array(total);

  let cursor = 0;
  for (const srcLayer of graph.layers) {
    const len = srcLayer.length;
    const row: number[] = [];
    for (let r = 0; r < len; r += 1) {
      const item = mirrorHorizontal ? srcLayer[len - 1 - r] : srcLayer[r];
      if (!item) continue;
      items.push(item);
      idToIdx.set(item.id, cursor);
      row.push(cursor);
      posInLayer[cursor] = r;
      cursor += 1;
    }
    layers.push(row);
  }

  const upperNeighbors: IndexedNeighbor[][] = Array.from({ length: total }, () => []);
  const lowerNeighbors: IndexedNeighbor[][] = Array.from({ length: total }, () => []);

  for (const [e, edge] of graph.edges.entries()) {
    const srcIdx = idToIdx.get(edge.sourceId);
    const tgtIdx = idToIdx.get(edge.targetId);
    if (srcIdx === undefined || tgtIdx === undefined) {
      continue;
    }
    const srcItem = items[srcIdx];
    const tgtItem = items[tgtIdx];
    if (!srcItem || !tgtItem) {
      continue;
    }
    const srcPortX = mirrorHorizontal ? srcItem.width - edge.sourcePortOffsetX : edge.sourcePortOffsetX;
    const tgtPortX = mirrorHorizontal ? tgtItem.width - edge.targetPortOffsetX : edge.targetPortOffsetX;

    lowerNeighbors[srcIdx]?.push({
      neighborIdx: tgtIdx,
      selfPortX: srcPortX,
      neighborPortX: tgtPortX,
      isInnerSegment: edge.isInnerSegment,
      edgeIdx: e,
    });
    upperNeighbors[tgtIdx]?.push({
      neighborIdx: srcIdx,
      selfPortX: tgtPortX,
      neighborPortX: srcPortX,
      isInnerSegment: edge.isInnerSegment,
      edgeIdx: e,
    });
  }

  const byNeighborOrder = (a: IndexedNeighbor, b: IndexedNeighbor): number => {
    const posDiff = (posInLayer[a.neighborIdx] ?? 0) - (posInLayer[b.neighborIdx] ?? 0);
    if (posDiff !== 0) {
      return posDiff;
    }
    return a.neighborPortX - b.neighborPortX;
  };
  for (let i = 0; i < total; i += 1) {
    const ups = upperNeighbors[i];
    if (ups && ups.length > 1) {
      ups.sort(byNeighborOrder);
    }
    const downs = lowerNeighbors[i];
    if (downs && downs.length > 1) {
      downs.sort(byNeighborOrder);
    }
  }

  // Brandes-Kopf Algorithm 1: mark Type-1 conflicts (non-inner edge crossing an inner dummy segment).
  const conflictedEdges = new Uint8Array(graph.edges.length);
  for (let l = 1; l < numLayers - 1; l += 1) {
    const lowerRow = layers[l + 1];
    const upperLen = layers[l]?.length ?? 0;
    if (!lowerRow || lowerRow.length === 0 || upperLen === 0) {
      continue;
    }
    let k0 = 0;
    let scanStart = 0;
    for (let l1 = 0; l1 < lowerRow.length; l1 += 1) {
      const v = lowerRow[l1];
      if (v === undefined) continue;
      const ups = upperNeighbors[v] ?? [];
      let innerUpperPos = -1;
      for (const ref of ups) {
        if (ref.isInnerSegment) {
          innerUpperPos = posInLayer[ref.neighborIdx] ?? -1;
          break;
        }
      }
      if (l1 === lowerRow.length - 1 || innerUpperPos >= 0) {
        const k1 = innerUpperPos >= 0 ? innerUpperPos : upperLen - 1;
        while (scanStart <= l1) {
          const w = lowerRow[scanStart];
          const wUps = w !== undefined ? (upperNeighbors[w] ?? []) : [];
          for (const ref of wUps) {
            if (ref.isInnerSegment) {
              continue;
            }
            const uPos = posInLayer[ref.neighborIdx] ?? 0;
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
    if (!row) continue;
    let lastAlignedPos = -1;
    for (const v of row) {
      const nbrs = neighborsOf[v] ?? [];
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
        if (!ref || conflictedEdges[ref.edgeIdx] === 1) {
          continue;
        }
        const u = ref.neighborIdx;
        const uPos = posInLayer[u] ?? 0;
        if (lastAlignedPos < uPos) {
          const rootU = root[u] ?? u;
          align[u] = v;
          root[v] = rootU;
          align[v] = rootU;
          delta[v] = (delta[u] ?? 0) + (ref.neighborPortX - ref.selfPortX);
          lastAlignedPos = uPos;
        }
      }
    }
  }

  // Brandes-Kopf Algorithm 3 (ELK BKCompactor variant): acyclic block-DAG longest-path + sink-class compaction.
  const blockMembers = new Map<number, number[]>();
  for (let i = 0; i < total; i += 1) {
    const r = root[i] ?? i;
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
  for (const [b, br] of blockRoots.entries()) {
    rootToBlockIdx[br] = b;
  }

  // Build weighted block DAG edges: predBlock -> curBlock with weight reqDiff.
  const outEdges: { readonly to: number; readonly weight: number }[][] = Array.from(
    { length: blockCount },
    () => []
  );
  const inDegree = new Int32Array(blockCount);

  for (const row of layers) {
    for (let r = 1; r < row.length; r += 1) {
      const pred = row[r - 1];
      const cur = row[r];
      if (pred === undefined || cur === undefined) continue;
      const pb = rootToBlockIdx[root[pred] ?? pred] ?? -1;
      const cb = rootToBlockIdx[root[cur] ?? cur] ?? -1;
      if (pb === cb || pb < 0 || cb < 0) {
        continue;
      }
      const predItem = items[pred];
      const curItem = items[cur];
      if (!predItem || !curItem) continue;
      const sep = minItemSeparation(predItem, curItem);
      const weight = (delta[pred] ?? 0) + predItem.width + sep - (delta[cur] ?? 0);
      outEdges[pb]?.push({ to: cb, weight });
      inDegree[cb] = (inDegree[cb] ?? 0) + 1;
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
    const b = queue[qHead] ?? 0;
    qHead += 1;
    topo[topoLen] = b;
    topoLen += 1;
    const edges = outEdges[b] ?? [];
    for (const edge of edges) {
      const nxt = edge.to;
      const nextDeg = (inDegree[nxt] ?? 0) - 1;
      inDegree[nxt] = nextDeg;
      if (nextDeg === 0) {
        queue[qTail] = nxt;
        qTail += 1;
      }
    }
  }

  // Pass 1: leftmost valid coordinates + tight-driver sink class labeling.
  const bx = new Float64Array(blockCount);
  const sink = new Int32Array(blockCount);
  for (let b = 0; b < blockCount; b += 1) {
    const members = blockMemberLists[b] ?? [];
    let minDelta = 0;
    for (const memberIdx of members) {
      const d = delta[memberIdx] ?? 0;
      if (d < minDelta) {
        minDelta = d;
      }
    }
    bx[b] = -minDelta;
    sink[b] = b;
  }

  for (let t = 0; t < topoLen; t += 1) {
    const b = topo[t] ?? 0;
    const edges = outEdges[b] ?? [];
    const bxB = bx[b] ?? 0;
    const sinkB = sink[b] ?? b;
    for (const e of edges) {
      const candidate = bxB + e.weight;
      if (candidate > (bx[e.to] ?? 0)) {
        bx[e.to] = candidate;
        sink[e.to] = sinkB;
      }
    }
  }

  // Pass 2: compact sink classes rightward in reverse topological order without violating any edge.
  const classBlocks = new Map<number, number[]>();
  for (let t = topoLen - 1; t >= 0; t -= 1) {
    const b = topo[t] ?? 0;
    const s = sink[b] ?? b;
    const list = classBlocks.get(s);
    if (list) {
      list.push(b);
    } else {
      classBlocks.set(s, [b]);
    }
  }

  for (const [cls, blocksInCls] of classBlocks.entries()) {
    let minSlack = Number.POSITIVE_INFINITY;
    for (const b of blocksInCls) {
      const edges = outEdges[b] ?? [];
      const bxB = bx[b] ?? 0;
      for (const e of edges) {
        if (sink[e.to] === cls) {
          continue;
        }
        const slack = (bx[e.to] ?? 0) - (bxB + e.weight);
        if (slack < minSlack) {
          minSlack = slack;
        }
      }
    }
    if (Number.isFinite(minSlack) && minSlack > 0) {
      for (const b of blocksInCls) {
        bx[b] = (bx[b] ?? 0) + minSlack;
      }
    }
  }

  const coords = new Float64Array(total);
  for (let i = 0; i < total; i += 1) {
    const bIdx = rootToBlockIdx[root[i] ?? i] ?? 0;
    coords[i] = (bx[bIdx] ?? 0) + (delta[i] ?? 0);
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
  for (const layer of graph.layers) {
    totalItems += layer.length;
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
    if (!leftRow || !rightRow) continue;
    const len = leftRow.length;
    for (let r = 0; r < len; r += 1) {
      const leftIdx = leftRow[r];
      const rightIdx = rightRow[len - 1 - r];
      if (leftIdx === undefined || rightIdx === undefined) continue;
      const width = leftItems[leftIdx]?.width ?? 0;
      rawUR[leftIdx] = -(mirroredUR[rightIdx] ?? 0) - width;
      rawDR[leftIdx] = -(mirroredDR[rightIdx] ?? 0) - width;
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

  for (const [p, pass] of passes.entries()) {
    const coords = pass.coords;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < totalItems; i += 1) {
      const x0 = coords[i] ?? 0;
      const x1 = x0 + (leftItems[i]?.width ?? 0);
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
  for (const [p, pass] of passes.entries()) {
    shifts[p] = pass.alignSide === 'left' ? refMin - (passMin[p] ?? 0) : refMax - (passMax[p] ?? 0);
  }

  const finalX = new Float64Array(totalItems);
  const s0 = shifts[0] ?? 0;
  const s1 = shifts[1] ?? 0;
  const s2 = shifts[2] ?? 0;
  const s3 = shifts[3] ?? 0;
  for (let i = 0; i < totalItems; i += 1) {
    let b0 = (rawUL[i] ?? 0) + s0;
    let b1 = (rawUR[i] ?? 0) + s1;
    let b2 = (rawDL[i] ?? 0) + s2;
    let b3 = (rawDR[i] ?? 0) + s3;
    // 4-element sorting network (branchless, zero allocations).
    if (b0 > b1) {
      const t = b0;
      b0 = b1;
      b1 = t;
    }
    if (b2 > b3) {
      const t = b2;
      b2 = b3;
      b3 = t;
    }
    if (b0 > b2) {
      const t = b0;
      b0 = b2;
      b2 = t;
    }
    if (b1 > b3) {
      const t = b1;
      b1 = b3;
      b3 = t;
    }
    if (b1 > b2) {
      const t = b1;
      b1 = b2;
      b2 = t;
    }
    finalX[i] = Math.round((b1 + b2) / 2);
  }

  // Enforce integer non-overlap after rounding.
  let globalMinX = Number.POSITIVE_INFINITY;
  let globalMaxRight = Number.NEGATIVE_INFINITY;
  for (const row of leftSetup.prepared.layers) {
    for (let r = 0; r < row.length; r += 1) {
      const cur = row[r];
      if (cur === undefined) continue;
      const curItem = leftItems[cur];
      if (!curItem) continue;
      if (r > 0) {
        const prev = row[r - 1];
        const prevItem = prev !== undefined ? leftItems[prev] : undefined;
        if (prev !== undefined && prevItem) {
          const minAllowed = (finalX[prev] ?? 0) + prevItem.width + minItemSeparation(prevItem, curItem);
          if ((finalX[cur] ?? 0) < minAllowed) {
            finalX[cur] = Math.ceil(minAllowed);
          }
        }
      }
      const curX = finalX[cur] ?? 0;
      if (curX < globalMinX) {
        globalMinX = curX;
      }
      if (curX + curItem.width > globalMaxRight) {
        globalMaxRight = curX + curItem.width;
      }
    }
  }

  // Post-BK free-interval parent-over-children centering (O(V + E), strictly non-overlapping).
  const { upperNeighbors, lowerNeighbors } = leftSetup.prepared;
  for (let l = numLayers - 2; l >= 0; l -= 1) {
    const row = leftSetup.prepared.layers[l];
    if (!row) continue;
    for (let r = 0; r < row.length; r += 1) {
      const idx = row[r];
      if (idx === undefined) continue;
      const item = leftItems[idx];
      if (!item || item.kind === 'dummy') {
        continue;
      }
      const downs = lowerNeighbors[idx] ?? [];
      if (downs.length === 0) {
        continue;
      }
      let downMean = 0;
      for (const ref of downs) {
        downMean += (finalX[ref.neighborIdx] ?? 0) + ref.neighborPortX - ref.selfPortX;
      }
      const desiredX = Math.round(downMean / downs.length);
      const prevIdx = r > 0 ? row[r - 1] : undefined;
      const prevItem = prevIdx !== undefined ? leftItems[prevIdx] : undefined;
      const nextIdx = r < row.length - 1 ? row[r + 1] : undefined;
      const nextItem = nextIdx !== undefined ? leftItems[nextIdx] : undefined;
      const minBound =
        prevIdx !== undefined && prevItem
          ? (finalX[prevIdx] ?? 0) + prevItem.width + minItemSeparation(prevItem, item)
          : globalMinX;
      const maxBound =
        nextIdx !== undefined && nextItem
          ? (finalX[nextIdx] ?? 0) - minItemSeparation(item, nextItem) - item.width
          : globalMaxRight - item.width;
      if (minBound <= maxBound) {
        finalX[idx] = Math.round(Math.max(minBound, Math.min(maxBound, desiredX)));
      }
    }
  }

  // Pull childless leaf units cleanly beneath their parent port within free horizontal space.
  for (let l = 1; l < numLayers; l += 1) {
    const row = leftSetup.prepared.layers[l];
    if (!row) continue;
    for (let r = 0; r < row.length; r += 1) {
      const idx = row[r];
      if (idx === undefined) continue;
      const item = leftItems[idx];
      if (!item || item.kind === 'dummy' || (lowerNeighbors[idx]?.length ?? 0) > 0) {
        continue;
      }
      const ups = upperNeighbors[idx] ?? [];
      if (ups.length === 0) {
        continue;
      }
      let upMean = 0;
      for (const ref of ups) {
        upMean += (finalX[ref.neighborIdx] ?? 0) + ref.neighborPortX - ref.selfPortX;
      }
      const desiredX = Math.round(upMean / ups.length);
      const prevIdx = r > 0 ? row[r - 1] : undefined;
      const prevItem = prevIdx !== undefined ? leftItems[prevIdx] : undefined;
      const nextIdx = r < row.length - 1 ? row[r + 1] : undefined;
      const nextItem = nextIdx !== undefined ? leftItems[nextIdx] : undefined;
      const minBound =
        prevIdx !== undefined && prevItem
          ? (finalX[prevIdx] ?? 0) + prevItem.width + minItemSeparation(prevItem, item)
          : globalMinX;
      const maxBound =
        nextIdx !== undefined && nextItem
          ? (finalX[nextIdx] ?? 0) - minItemSeparation(item, nextItem) - item.width
          : globalMaxRight - item.width;
      if (minBound <= maxBound) {
        finalX[idx] = Math.round(Math.max(minBound, Math.min(maxBound, desiredX)));
      }
    }
  }

  globalMinX = Number.POSITIVE_INFINITY;
  for (let i = 0; i < totalItems; i += 1) {
    const x = finalX[i] ?? 0;
    if (x < globalMinX) {
      globalMinX = x;
    }
  }

  const normalizeShift = Math.round(leftPad - globalMinX);
  for (const [i, item] of leftItems.entries()) {
    result.set(item.id, Math.round((finalX[i] ?? 0) + normalizeShift));
  }
  return result;
}
