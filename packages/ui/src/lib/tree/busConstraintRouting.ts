export const BUS_LANE_SPACING = 14;

export interface BusConstraintInput {
  readonly id: string;
  readonly hubX: number;
  readonly dropXs: readonly number[];
  readonly railMinX: number;
  readonly railMaxX: number;
}

export interface BusTrackAssignment {
  readonly id: string;
  readonly trackIndex: number;
}

/**
 * Counts orthogonal crossings between two horizontal sibling buses in the same inter-generation
 * band when `upper` is assigned a higher (smaller Y) track than `lower`.
 */
export function countBusOrderCrossings(upper: BusConstraintInput, lower: BusConstraintInput): number {
  let crossings = 0;
  if (upper.railMaxX > upper.railMinX && lower.hubX > upper.railMinX && lower.hubX < upper.railMaxX) {
    crossings += 1;
  }
  if (lower.railMaxX > lower.railMinX) {
    for (let i = 0; i < upper.dropXs.length; i += 1) {
      const dx = upper.dropXs[i];
      if (dx > lower.railMinX && dx < lower.railMaxX) {
        crossings += 1;
      }
    }
  }
  return crossings;
}

/**
 * Port of ELK OrthogonalRoutingGenerator's vertical constraint graph for sibling buses.
 * Models crossing preferences as directed edges (A -> B when placing A above B yields fewer
 * crossings than B above A), breaks any cycle by minimum incoming crossing weight, and assigns
 * compact non-overlapping tracks (preserving >= 14px separation between tracks).
 */
export function assignBusTracksWithConstraintGraph(
  buses: readonly BusConstraintInput[]
): readonly BusTrackAssignment[] {
  const n = buses.length;
  if (n === 0) {
    return [];
  }
  if (n === 1) {
    return [{ id: buses[0].id, trackIndex: 0 }];
  }

  const outEdges: { readonly to: number; readonly weight: number }[][] = Array.from({ length: n }, () => []);
  const inDegree = new Int32Array(n);
  const inWeight = new Int32Array(n);
  const outWeight = new Int32Array(n);
  const spans = new Float64Array(n);

  for (let i = 0; i < n; i += 1) {
    spans[i] = buses[i].railMaxX - buses[i].railMinX;
  }

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const cIJ = countBusOrderCrossings(buses[i], buses[j]);
      const cJI = countBusOrderCrossings(buses[j], buses[i]);
      if (cIJ < cJI) {
        const w = cJI - cIJ;
        outEdges[i].push({ to: j, weight: w });
        inDegree[j] += 1;
        inWeight[j] += w;
        outWeight[i] += w;
      } else if (cJI < cIJ) {
        const w = cIJ - cJI;
        outEdges[j].push({ to: i, weight: w });
        inDegree[i] += 1;
        inWeight[i] += w;
        outWeight[j] += w;
      }
    }
  }

  const placed = new Uint8Array(n);
  const orderedIndices: number[] = new Array(n);

  const compareTieBreak = (a: number, b: number): number => {
    if (spans[a] !== spans[b]) {
      return spans[b] - spans[a];
    }
    if (buses[a].hubX !== buses[b].hubX) {
      return buses[a].hubX - buses[b].hubX;
    }
    return buses[a].id.localeCompare(buses[b].id);
  };

  for (let step = 0; step < n; step += 1) {
    let bestZero = -1;
    for (let i = 0; i < n; i += 1) {
      if (placed[i] === 1 || inDegree[i] !== 0) {
        continue;
      }
      if (bestZero === -1 || compareTieBreak(i, bestZero) < 0) {
        bestZero = i;
      }
    }

    let chosen = bestZero;
    if (chosen === -1) {
      // Cycle break: pick the active bus with minimum incoming crossing weight.
      for (let i = 0; i < n; i += 1) {
        if (placed[i] === 1) {
          continue;
        }
        if (chosen === -1) {
          chosen = i;
          continue;
        }
        if (inWeight[i] !== inWeight[chosen]) {
          if (inWeight[i] < inWeight[chosen]) {
            chosen = i;
          }
          continue;
        }
        const netI = outWeight[i] - inWeight[i];
        const netC = outWeight[chosen] - inWeight[chosen];
        if (netI !== netC) {
          if (netI > netC) {
            chosen = i;
          }
          continue;
        }
        if (compareTieBreak(i, chosen) < 0) {
          chosen = i;
        }
      }
    }

    placed[chosen] = 1;
    orderedIndices[step] = chosen;
    const edges = outEdges[chosen];
    for (let k = 0; k < edges.length; k += 1) {
      const e = edges[k];
      if (placed[e.to] === 0) {
        inDegree[e.to] -= 1;
        inWeight[e.to] -= e.weight;
      }
    }
  }

  // Local adjacent-swap polish ensures no pair inversions remain after cycle breaking.
  for (let pass = 0; pass < n; pass += 1) {
    let swapped = false;
    for (let i = 0; i < n - 1; i += 1) {
      const a = orderedIndices[i];
      const b = orderedIndices[i + 1];
      if (countBusOrderCrossings(buses[b], buses[a]) < countBusOrderCrossings(buses[a], buses[b])) {
        orderedIndices[i] = b;
        orderedIndices[i + 1] = a;
        swapped = true;
      }
    }
    if (!swapped) {
      break;
    }
  }

  const assignments: BusTrackAssignment[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    assignments[i] = {
      id: buses[orderedIndices[i]].id,
      trackIndex: i,
    };
  }
  return assignments;
}
