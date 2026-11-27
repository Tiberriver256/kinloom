import type { KinshipEdge, Person } from '@kinloom/core';

export function addUnique(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [value]);
    return;
  }
  if (!existing.includes(value)) {
    existing.push(value);
  }
}

const DEFAULT_GENERATION_SPAN_YEARS = 28;

function sortedUnique(items: readonly string[] | undefined): string[] {
  if (!items || items.length === 0) {
    return [];
  }
  return [...new Set(items)].toSorted((a, b) => a.localeCompare(b));
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function buildSpouseClusters(
  componentIds: readonly string[],
  spouseMap: ReadonlyMap<string, readonly string[]>
): string[][] {
  const compSet = new Set(componentIds);
  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (const id of componentIds) {
    if (visited.has(id)) {
      continue;
    }
    const cluster: string[] = [];
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) {
        continue;
      }
      cluster.push(cur);
      for (const spId of sortedUnique(spouseMap.get(cur))) {
        if (compSet.has(spId) && !visited.has(spId)) {
          visited.add(spId);
          queue.push(spId);
        }
      }
    }
    clusters.push(cluster);
  }

  return clusters;
}

function pickComponentSeed(
  componentIds: readonly string[],
  peopleById: ReadonlyMap<string, Person>,
  parentMap: ReadonlyMap<string, readonly string[]>
): string {
  const pivot = componentIds.find((id) => peopleById.get(id)?.lineage_group === 'pivot_ancestor');
  if (pivot) {
    return pivot;
  }
  const roots = componentIds.filter((id) => (parentMap.get(id)?.length ?? 0) === 0);
  const pool = roots.length > 0 ? roots : componentIds;
  let best = pool[0];
  let bestYear = peopleById.get(best)?.birth_year ?? Number.POSITIVE_INFINITY;
  for (const id of pool) {
    const year = peopleById.get(id)?.birth_year ?? Number.POSITIVE_INFINITY;
    if (year < bestYear) {
      best = id;
      bestYear = year;
    }
  }
  return best;
}

function assignComponentGenerations(params: {
  readonly componentIds: readonly string[];
  readonly peopleById: ReadonlyMap<string, Person>;
  readonly parentMap: ReadonlyMap<string, readonly string[]>;
  readonly childMap: ReadonlyMap<string, readonly string[]>;
  readonly spouseMap: ReadonlyMap<string, readonly string[]>;
}): Map<string, number> {
  const { componentIds, peopleById, parentMap, childMap, spouseMap } = params;
  const compSet = new Set(componentIds);
  const localGen = new Map<string, number>();

  // 1. Bidirectional relative-depth BFS so shallower ancestor subtrees align
  //    coherently with the generation they marry or co-parent into.
  const seed = pickComponentSeed(componentIds, peopleById, parentMap);
  localGen.set(seed, 0);
  const queue: string[] = [seed];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur) {
      continue;
    }
    const curGen = localGen.get(cur) ?? 0;

    for (const childId of sortedUnique(childMap.get(cur))) {
      if (compSet.has(childId) && !localGen.has(childId)) {
        localGen.set(childId, curGen + 1);
        queue.push(childId);
      }
    }
    for (const parentId of sortedUnique(parentMap.get(cur))) {
      if (compSet.has(parentId) && !localGen.has(parentId)) {
        localGen.set(parentId, curGen - 1);
        queue.push(parentId);
      }
    }
    for (const spId of sortedUnique(spouseMap.get(cur))) {
      if (compSet.has(spId) && !localGen.has(spId)) {
        localGen.set(spId, curGen);
        queue.push(spId);
      }
    }
  }

  const normalizeMinToZero = (): void => {
    let minVal = Number.POSITIVE_INFINITY;
    for (const val of localGen.values()) {
      if (val < minVal) {
        minVal = val;
      }
    }
    if (Number.isFinite(minVal) && minVal !== 0) {
      for (const id of componentIds) {
        localGen.set(id, (localGen.get(id) ?? 0) - minVal);
      }
    }
  };

  normalizeMinToZero();

  // 2. Forward hard-constraint repair for pedigree collapse or cross-generation marriages:
  //    every child sits strictly below every parent, and spouses share a generation.
  const maxForwardIter = Math.min(64, componentIds.length * 2 + 8);
  for (let iter = 0; iter < maxForwardIter; iter += 1) {
    let changed = false;
    for (const id of componentIds) {
      const parents = parentMap.get(id) ?? [];
      if (parents.length > 0) {
        const target = Math.max(...parents.map((pid) => localGen.get(pid) ?? 0)) + 1;
        if ((localGen.get(id) ?? 0) < target) {
          localGen.set(id, target);
          changed = true;
        }
      }
    }
    for (const id of componentIds) {
      for (const spId of spouseMap.get(id) ?? []) {
        if (!compSet.has(spId)) {
          continue;
        }
        const ga = localGen.get(id) ?? 0;
        const gb = localGen.get(spId) ?? 0;
        if (ga !== gb) {
          const synced = Math.max(ga, gb);
          localGen.set(id, synced);
          localGen.set(spId, synced);
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }

  // 3. Bottom-up spouse-cluster pull-down to close any residual slack left by conflict repair.
  const spouseClusters = buildSpouseClusters(componentIds, spouseMap);
  const maxPullIter = Math.min(32, componentIds.length + 4);
  for (let iter = 0; iter < maxPullIter; iter += 1) {
    let changed = false;
    for (const cluster of spouseClusters) {
      let minChildGen = Number.POSITIVE_INFINITY;
      for (const id of cluster) {
        for (const cid of childMap.get(id) ?? []) {
          if (!compSet.has(cid)) {
            continue;
          }
          const cg = localGen.get(cid);
          if (cg !== undefined && cg < minChildGen) {
            minChildGen = cg;
          }
        }
      }
      if (!Number.isFinite(minChildGen)) {
        continue;
      }
      const curGen = Math.max(...cluster.map((id) => localGen.get(id) ?? 0));
      const targetGen = minChildGen - 1;
      if (targetGen > curGen) {
        for (const id of cluster) {
          localGen.set(id, targetGen);
        }
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }

  normalizeMinToZero();
  return localGen;
}

function estimateRefYearForGen(targetGen: number, refMedians: ReadonlyMap<number, number>): number | null {
  const direct = refMedians.get(targetGen);
  if (direct !== undefined) {
    return direct;
  }
  let nearestGen: number | null = null;
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const g of refMedians.keys()) {
    const dist = Math.abs(g - targetGen);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestGen = g;
    }
  }
  if (nearestGen === null) {
    return null;
  }
  const base = refMedians.get(nearestGen);
  if (base === undefined) {
    return null;
  }
  return base + (targetGen - nearestGen) * DEFAULT_GENERATION_SPAN_YEARS;
}

export function inferGenerations(
  people: readonly Person[],
  kinship: readonly KinshipEdge[],
  parentMap: ReadonlyMap<string, readonly string[]>,
  childMap: ReadonlyMap<string, readonly string[]>,
  spouseMap: ReadonlyMap<string, readonly string[]>
): Map<string, number> {
  const gen = new Map<string, number>();
  if (people.length === 0) {
    return gen;
  }

  const peopleById = new Map<string, Person>(people.map((p) => [p.id, p]));
  const sortedIds = [...peopleById.keys()].toSorted((a, b) => a.localeCompare(b));
  const visIds = new Set(sortedIds);

  const isConnectedId = (id: string): boolean =>
    (parentMap.get(id)?.length ?? 0) > 0 ||
    (childMap.get(id)?.length ?? 0) > 0 ||
    (spouseMap.get(id)?.length ?? 0) > 0;

  // Partition connected people into undirected kinship components.
  const visited = new Set<string>();
  const connectedComponents: string[][] = [];
  const isolatedIds: string[] = [];

  for (const id of sortedIds) {
    if (!isConnectedId(id)) {
      isolatedIds.push(id);
      continue;
    }
    if (visited.has(id)) {
      continue;
    }
    const comp: string[] = [];
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) {
        continue;
      }
      comp.push(cur);
      const neighbors = [
        ...sortedUnique(parentMap.get(cur)),
        ...sortedUnique(childMap.get(cur)),
        ...sortedUnique(spouseMap.get(cur)),
      ];
      for (const nextId of neighbors) {
        if (visIds.has(nextId) && !visited.has(nextId)) {
          visited.add(nextId);
          queue.push(nextId);
        }
      }
    }
    comp.sort((a, b) => a.localeCompare(b));
    connectedComponents.push(comp);
  }

  // Largest component anchors the chronological reference frame.
  connectedComponents.sort((a, b) => {
    if (b.length !== a.length) {
      return b.length - a.length;
    }
    return a[0].localeCompare(b[0]);
  });

  const connectedYearsByGen = new Map<number, number[]>();
  const recordComponentYears = (comp: readonly string[]): void => {
    for (const id of comp) {
      const birthYear = peopleById.get(id)?.birth_year;
      if (birthYear !== null && birthYear !== undefined) {
        const g = gen.get(id) ?? 0;
        const list = connectedYearsByGen.get(g) ?? [];
        list.push(birthYear);
        connectedYearsByGen.set(g, list);
      }
    }
  };

  for (const [compIdx, comp] of connectedComponents.entries()) {
    const localGen = assignComponentGenerations({
      componentIds: comp,
      peopleById,
      parentMap,
      childMap,
      spouseMap,
    });

    let delta = 0;
    if (compIdx > 0 && connectedYearsByGen.size > 0) {
      const dated = comp
        .map((id) => {
          const birthYear = peopleById.get(id)?.birth_year;
          return birthYear !== null && birthYear !== undefined
            ? { g: localGen.get(id) ?? 0, birthYear }
            : null;
        })
        .filter((item): item is { g: number; birthYear: number } => item !== null);

      if (dated.length > 0) {
        const refMedians = new Map<number, number>();
        let minRefGen = Number.POSITIVE_INFINITY;
        let maxRefGen = Number.NEGATIVE_INFINITY;
        for (const [g, yrs] of connectedYearsByGen.entries()) {
          refMedians.set(g, medianOf(yrs));
          if (g < minRefGen) minRefGen = g;
          if (g > maxRefGen) maxRefGen = g;
        }
        const maxLocalGen = Math.max(...localGen.values());
        const minDelta = minRefGen - maxLocalGen - 2;
        const maxDelta = maxRefGen + 2;
        let bestDelta = 0;
        let bestErr = Number.POSITIVE_INFINITY;
        for (let cand = minDelta; cand <= maxDelta; cand += 1) {
          let err = 0;
          for (const item of dated) {
            const expected = estimateRefYearForGen(item.g + cand, refMedians);
            if (expected !== null) {
              err += Math.abs(item.birthYear - expected);
            }
          }
          if (err < bestErr || (err === bestErr && Math.abs(cand) < Math.abs(bestDelta))) {
            bestErr = err;
            bestDelta = cand;
          }
        }
        delta = bestDelta;
      }
    }

    for (const id of comp) {
      gen.set(id, (localGen.get(id) ?? 0) + delta);
    }
    recordComponentYears(comp);
  }

  // Normalize connected components so minimum generation is 0 before aligning isolated records.
  if (gen.size > 0) {
    const minConnected = Math.min(...gen.values());
    if (minConnected !== 0) {
      for (const [id, g] of gen.entries()) {
        gen.set(id, g - minConnected);
      }
      connectedYearsByGen.clear();
      for (const comp of connectedComponents) {
        recordComponentYears(comp);
      }
    }
  }

  const fullParentMap = new Map<string, string[]>();
  const fullSpouseMap = new Map<string, string[]>();
  for (const edge of kinship) {
    if (edge.relation === 'parent') {
      addUnique(fullParentMap, edge.to, edge.from);
    } else if (edge.relation === 'child') {
      addUnique(fullParentMap, edge.from, edge.to);
    } else if (edge.relation === 'spouse') {
      addUnique(fullSpouseMap, edge.from, edge.to);
      addUnique(fullSpouseMap, edge.to, edge.from);
    }
  }

  for (const id of isolatedIds) {
    const p = peopleById.get(id);
    if (!p) {
      continue;
    }
    let inferred: number | null = null;
    for (const hiddenSpId of sortedUnique(fullSpouseMap.get(id))) {
      const spParents = (fullParentMap.get(hiddenSpId) ?? []).filter((pid) => visIds.has(pid));
      if (spParents.length > 0) {
        inferred = Math.max(...spParents.map((pid) => gen.get(pid) ?? 0)) + 1;
        break;
      }
    }
    if (inferred === null && p.birth_year !== null && connectedYearsByGen.size > 0) {
      let bestGen = 0;
      let bestDiff = Number.POSITIVE_INFINITY;
      for (const [g, yrs] of connectedYearsByGen.entries()) {
        const diff = Math.abs(p.birth_year - medianOf(yrs));
        if (diff < bestDiff) {
          bestDiff = diff;
          bestGen = g;
        }
      }
      inferred = bestGen;
    }
    gen.set(id, inferred ?? 0);
  }

  const uniqueGens = [...new Set(sortedIds.map((id) => gen.get(id) ?? 0))].toSorted((a, b) => a - b);
  const remap = new Map<number, number>();
  for (const [idx, rawGen] of uniqueGens.entries()) {
    remap.set(rawGen, idx);
  }
  for (const id of sortedIds) {
    gen.set(id, remap.get(gen.get(id) ?? 0) ?? 0);
  }
  return gen;
}
