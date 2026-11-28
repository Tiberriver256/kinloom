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
    for (const dx of upper.dropXs) {
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
    const only = buses[0];
    return only ? [{ id: only.id, trackIndex: 0 }] : [];
  }

  const outEdges: { readonly to: number; readonly weight: number }[][] = Array.from({ length: n }, () => []);
  const inDegree = new Int32Array(n);
  const inWeight = new Int32Array(n);
  const outWeight = new Int32Array(n);
  const spans = new Float64Array(n);

  for (let i = 0; i < n; i += 1) {
    const bus = buses[i];
    if (bus) {
      spans[i] = bus.railMaxX - bus.railMinX;
    }
  }

  for (let i = 0; i < n; i += 1) {
    const busI = buses[i];
    if (!busI) continue;
    for (let j = i + 1; j < n; j += 1) {
      const busJ = buses[j];
      if (!busJ) continue;
      const cIJ = countBusOrderCrossings(busI, busJ);
      const cJI = countBusOrderCrossings(busJ, busI);
      if (cIJ < cJI) {
        const w = cJI - cIJ;
        outEdges[i]?.push({ to: j, weight: w });
        inDegree[j] = (inDegree[j] ?? 0) + 1;
        inWeight[j] = (inWeight[j] ?? 0) + w;
        outWeight[i] = (outWeight[i] ?? 0) + w;
      } else if (cJI < cIJ) {
        const w = cIJ - cJI;
        outEdges[j]?.push({ to: i, weight: w });
        inDegree[i] = (inDegree[i] ?? 0) + 1;
        inWeight[i] = (inWeight[i] ?? 0) + w;
        outWeight[j] = (outWeight[j] ?? 0) + w;
      }
    }
  }

  const placed = new Uint8Array(n);
  const orderedIndices: number[] = [];

  const compareTieBreak = (a: number, b: number): number => {
    const spanA = spans[a] ?? 0;
    const spanB = spans[b] ?? 0;
    if (spanA !== spanB) {
      return spanB - spanA;
    }
    const busA = buses[a];
    const busB = buses[b];
    if (!busA || !busB) {
      return a - b;
    }
    if (busA.hubX !== busB.hubX) {
      return busA.hubX - busB.hubX;
    }
    return busA.id.localeCompare(busB.id);
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
        const inW = inWeight[i] ?? 0;
        const chosenInW = inWeight[chosen] ?? 0;
        if (inW !== chosenInW) {
          if (inW < chosenInW) {
            chosen = i;
          }
          continue;
        }
        const netI = (outWeight[i] ?? 0) - inW;
        const netC = (outWeight[chosen] ?? 0) - chosenInW;
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
    orderedIndices.push(chosen);
    const edges = outEdges[chosen] ?? [];
    for (const e of edges) {
      if (placed[e.to] === 0) {
        inDegree[e.to] = (inDegree[e.to] ?? 0) - 1;
        inWeight[e.to] = (inWeight[e.to] ?? 0) - e.weight;
      }
    }
  }

  // Local adjacent-swap polish ensures no pair inversions remain after cycle breaking.
  for (let pass = 0; pass < n; pass += 1) {
    let swapped = false;
    for (let i = 0; i < n - 1; i += 1) {
      const a = orderedIndices[i];
      const b = orderedIndices[i + 1];
      if (a === undefined || b === undefined) continue;
      const busA = buses[a];
      const busB = buses[b];
      if (!busA || !busB) continue;
      if (countBusOrderCrossings(busB, busA) < countBusOrderCrossings(busA, busB)) {
        orderedIndices[i] = b;
        orderedIndices[i + 1] = a;
        swapped = true;
      }
    }
    if (!swapped) {
      break;
    }
  }

  const assignments: BusTrackAssignment[] = [];
  for (let i = 0; i < orderedIndices.length; i += 1) {
    const idx = orderedIndices[i];
    const bus = idx !== undefined ? buses[idx] : undefined;
    if (bus) {
      assignments.push({
        id: bus.id,
        trackIndex: i,
      });
    }
  }
  return assignments;
}
