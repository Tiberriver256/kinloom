import { fastLocaleCompare, type KinshipEdge, type Person } from '@kinloom/core';

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
  if (items.length === 1) {
    return [items[0]];
  }
  return [...new Set(items)].toSorted(fastLocaleCompare);
}

function medianOf(values: readonly number[]): number {
  if (values.length === 1) {
    return values[0];
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function buildSpouseClusters(
  componentIds: readonly string[],
  compSet: ReadonlySet<string>,
  sortedSpouseById: ReadonlyMap<string, readonly string[]>
): string[][] {
  const visited = new Set<string>();
  const clusters: string[][] = [];

  for (let i = 0; i < componentIds.length; i += 1) {
    const id = componentIds[i];
    if (visited.has(id)) {
      continue;
    }
    const cluster: string[] = [];
    const queue = [id];
    visited.add(id);
    let qHead = 0;
    while (qHead < queue.length) {
      const cur = queue[qHead];
      qHead += 1;
      cluster.push(cur);
      const spouses = sortedSpouseById.get(cur);
      if (spouses) {
        for (let s = 0; s < spouses.length; s += 1) {
          const spId = spouses[s];
          if (compSet.has(spId) && !visited.has(spId)) {
            visited.add(spId);
            queue.push(spId);
          }
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
  for (let i = 0; i < componentIds.length; i += 1) {
    const id = componentIds[i];
    if (peopleById.get(id)?.lineage_group === 'pivot_ancestor') {
      return id;
    }
  }
  const roots: string[] = [];
  for (let i = 0; i < componentIds.length; i += 1) {
    const id = componentIds[i];
    if ((parentMap.get(id)?.length ?? 0) === 0) {
      roots.push(id);
    }
  }
  const pool = roots.length > 0 ? roots : componentIds;
  let best = pool[0];
  let bestYear = peopleById.get(best)?.birth_year ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i < pool.length; i += 1) {
    const id = pool[i];
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
  readonly sortedParentById: ReadonlyMap<string, readonly string[]>;
  readonly sortedChildById: ReadonlyMap<string, readonly string[]>;
  readonly sortedSpouseById: ReadonlyMap<string, readonly string[]>;
}): Map<string, number> {
  const {
    componentIds,
    peopleById,
    parentMap,
    childMap,
    spouseMap,
    sortedParentById,
    sortedChildById,
    sortedSpouseById,
  } = params;
  const compSet = new Set(componentIds);
  const localGen = new Map<string, number>();

  const seed = pickComponentSeed(componentIds, peopleById, parentMap);
  localGen.set(seed, 0);
  const queue: string[] = [seed];
  let qHead = 0;
  while (qHead < queue.length) {
    const cur = queue[qHead];
    qHead += 1;
    const curGen = localGen.get(cur) ?? 0;

    const children = sortedChildById.get(cur);
    if (children) {
      for (let i = 0; i < children.length; i += 1) {
        const childId = children[i];
        if (compSet.has(childId) && !localGen.has(childId)) {
          localGen.set(childId, curGen + 1);
          queue.push(childId);
        }
      }
    }
    const parents = sortedParentById.get(cur);
    if (parents) {
      for (let i = 0; i < parents.length; i += 1) {
        const parentId = parents[i];
        if (compSet.has(parentId) && !localGen.has(parentId)) {
          localGen.set(parentId, curGen - 1);
          queue.push(parentId);
        }
      }
    }
    const spouses = sortedSpouseById.get(cur);
    if (spouses) {
      for (let i = 0; i < spouses.length; i += 1) {
        const spId = spouses[i];
        if (compSet.has(spId) && !localGen.has(spId)) {
          localGen.set(spId, curGen);
          queue.push(spId);
        }
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
      for (let i = 0; i < componentIds.length; i += 1) {
        const id = componentIds[i];
        localGen.set(id, (localGen.get(id) ?? 0) - minVal);
      }
    }
  };

  normalizeMinToZero();

  const maxForwardIter = Math.min(64, componentIds.length * 2 + 8);
  for (let iter = 0; iter < maxForwardIter; iter += 1) {
    let changed = false;
    for (let i = 0; i < componentIds.length; i += 1) {
      const id = componentIds[i];
      const parents = parentMap.get(id);
      if (parents && parents.length > 0) {
        let maxParent = Number.NEGATIVE_INFINITY;
        for (let p = 0; p < parents.length; p += 1) {
          const pg = localGen.get(parents[p]) ?? 0;
          if (pg > maxParent) {
            maxParent = pg;
          }
        }
        const target = maxParent + 1;
        if ((localGen.get(id) ?? 0) < target) {
          localGen.set(id, target);
          changed = true;
        }
      }
    }
    for (let i = 0; i < componentIds.length; i += 1) {
      const id = componentIds[i];
      const spouses = spouseMap.get(id);
      if (!spouses) {
        continue;
      }
      for (let s = 0; s < spouses.length; s += 1) {
        const spId = spouses[s];
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

  const spouseClusters = buildSpouseClusters(componentIds, compSet, sortedSpouseById);
  const maxPullIter = Math.min(32, componentIds.length + 4);
  for (let iter = 0; iter < maxPullIter; iter += 1) {
    let changed = false;
    for (let cIdx = 0; cIdx < spouseClusters.length; cIdx += 1) {
      const cluster = spouseClusters[cIdx];
      let minChildGen = Number.POSITIVE_INFINITY;
      let curGen = 0;
      for (let m = 0; m < cluster.length; m += 1) {
        const id = cluster[m];
        const mg = localGen.get(id) ?? 0;
        if (m === 0 || mg > curGen) {
          curGen = mg;
        }
        const children = childMap.get(id);
        if (!children) {
          continue;
        }
        for (let k = 0; k < children.length; k += 1) {
          const cid = children[k];
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
      const targetGen = minChildGen - 1;
      if (targetGen > curGen) {
        for (let m = 0; m < cluster.length; m += 1) {
          localGen.set(cluster[m], targetGen);
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

  const peopleById = new Map<string, Person>();
  const sortedIds = new Array<string>(people.length);
  for (let i = 0; i < people.length; i += 1) {
    const p = people[i];
    peopleById.set(p.id, p);
    sortedIds[i] = p.id;
  }
  sortedIds.sort(fastLocaleCompare);
  const visIds = new Set(sortedIds);

  const sortedParentById = new Map<string, string[]>();
  const sortedChildById = new Map<string, string[]>();
  const sortedSpouseById = new Map<string, string[]>();
  for (let i = 0; i < sortedIds.length; i += 1) {
    const id = sortedIds[i];
    const pList = parentMap.get(id);
    if (pList && pList.length > 0) {
      sortedParentById.set(id, sortedUnique(pList));
    }
    const cList = childMap.get(id);
    if (cList && cList.length > 0) {
      sortedChildById.set(id, sortedUnique(cList));
    }
    const sList = spouseMap.get(id);
    if (sList && sList.length > 0) {
      sortedSpouseById.set(id, sortedUnique(sList));
    }
  }

  const visited = new Set<string>();
  const connectedComponents: string[][] = [];
  const isolatedIds: string[] = [];

  for (let i = 0; i < sortedIds.length; i += 1) {
    const id = sortedIds[i];
    const isConnected = sortedParentById.has(id) || sortedChildById.has(id) || sortedSpouseById.has(id);
    if (!isConnected) {
      isolatedIds.push(id);
      continue;
    }
    if (visited.has(id)) {
      continue;
    }
    const comp: string[] = [];
    const queue = [id];
    visited.add(id);
    let qHead = 0;
    while (qHead < queue.length) {
      const cur = queue[qHead];
      qHead += 1;
      comp.push(cur);
      const pNbr = sortedParentById.get(cur);
      if (pNbr) {
        for (let k = 0; k < pNbr.length; k += 1) {
          const nextId = pNbr[k];
          if (visIds.has(nextId) && !visited.has(nextId)) {
            visited.add(nextId);
            queue.push(nextId);
          }
        }
      }
      const cNbr = sortedChildById.get(cur);
      if (cNbr) {
        for (let k = 0; k < cNbr.length; k += 1) {
          const nextId = cNbr[k];
          if (visIds.has(nextId) && !visited.has(nextId)) {
            visited.add(nextId);
            queue.push(nextId);
          }
        }
      }
      const sNbr = sortedSpouseById.get(cur);
      if (sNbr) {
        for (let k = 0; k < sNbr.length; k += 1) {
          const nextId = sNbr[k];
          if (visIds.has(nextId) && !visited.has(nextId)) {
            visited.add(nextId);
            queue.push(nextId);
          }
        }
      }
    }
    comp.sort(fastLocaleCompare);
    connectedComponents.push(comp);
  }

  connectedComponents.sort((a, b) => {
    if (b.length !== a.length) {
      return b.length - a.length;
    }
    return fastLocaleCompare(a[0], b[0]);
  });

  const connectedYearsByGen = new Map<number, number[]>();
  const recordComponentYears = (comp: readonly string[]): void => {
    for (let i = 0; i < comp.length; i += 1) {
      const id = comp[i];
      const birthYear = peopleById.get(id)?.birth_year;
      if (birthYear !== null && birthYear !== undefined) {
        const g = gen.get(id) ?? 0;
        const list = connectedYearsByGen.get(g);
        if (list) {
          list.push(birthYear);
        } else {
          connectedYearsByGen.set(g, [birthYear]);
        }
      }
    }
  };

  for (let compIdx = 0; compIdx < connectedComponents.length; compIdx += 1) {
    const comp = connectedComponents[compIdx];
    const localGen = assignComponentGenerations({
      componentIds: comp,
      peopleById,
      parentMap,
      childMap,
      spouseMap,
      sortedParentById,
      sortedChildById,
      sortedSpouseById,
    });

    let delta = 0;
    if (compIdx > 0 && connectedYearsByGen.size > 0) {
      const dated: { g: number; birthYear: number }[] = [];
      for (let i = 0; i < comp.length; i += 1) {
        const id = comp[i];
        const birthYear = peopleById.get(id)?.birth_year;
        if (birthYear !== null && birthYear !== undefined) {
          dated.push({ g: localGen.get(id) ?? 0, birthYear });
        }
      }

      if (dated.length > 0) {
        const refMedians = new Map<number, number>();
        let minRefGen = Number.POSITIVE_INFINITY;
        let maxRefGen = Number.NEGATIVE_INFINITY;
        for (const [g, yrs] of connectedYearsByGen.entries()) {
          refMedians.set(g, medianOf(yrs));
          if (g < minRefGen) minRefGen = g;
          if (g > maxRefGen) maxRefGen = g;
        }
        let maxLocalGen = 0;
        for (const val of localGen.values()) {
          if (val > maxLocalGen) maxLocalGen = val;
        }
        const minDelta = minRefGen - maxLocalGen - 2;
        const maxDelta = maxRefGen + 2;
        let bestDelta = 0;
        let bestErr = Number.POSITIVE_INFINITY;
        for (let cand = minDelta; cand <= maxDelta; cand += 1) {
          let err = 0;
          for (let d = 0; d < dated.length; d += 1) {
            const item = dated[d];
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

    for (let i = 0; i < comp.length; i += 1) {
      const id = comp[i];
      gen.set(id, (localGen.get(id) ?? 0) + delta);
    }
    recordComponentYears(comp);
  }

  if (gen.size > 0) {
    let minConnected = Number.POSITIVE_INFINITY;
    for (const val of gen.values()) {
      if (val < minConnected) minConnected = val;
    }
    if (Number.isFinite(minConnected) && minConnected !== 0) {
      for (const [id, g] of gen.entries()) {
        gen.set(id, g - minConnected);
      }
      connectedYearsByGen.clear();
      for (let i = 0; i < connectedComponents.length; i += 1) {
        recordComponentYears(connectedComponents[i]);
      }
    }
  }

  if (isolatedIds.length > 0) {
    const fullParentMap = new Map<string, string[]>();
    const fullSpouseMap = new Map<string, string[]>();
    for (let i = 0; i < kinship.length; i += 1) {
      const edge = kinship[i];
      if (edge.relation === 'parent') {
        addUnique(fullParentMap, edge.to, edge.from);
      } else if (edge.relation === 'child') {
        addUnique(fullParentMap, edge.from, edge.to);
      } else if (edge.relation === 'spouse') {
        addUnique(fullSpouseMap, edge.from, edge.to);
        addUnique(fullSpouseMap, edge.to, edge.from);
      }
    }

    const isolatedMedians = new Map<number, number>();
    for (const [g, yrs] of connectedYearsByGen.entries()) {
      isolatedMedians.set(g, medianOf(yrs));
    }

    for (let i = 0; i < isolatedIds.length; i += 1) {
      const id = isolatedIds[i];
      const p = peopleById.get(id);
      if (!p) {
        continue;
      }
      let inferred: number | null = null;
      const hiddenSpouses = sortedUnique(fullSpouseMap.get(id));
      for (let s = 0; s < hiddenSpouses.length; s += 1) {
        const spParents = fullParentMap.get(hiddenSpouses[s]);
        if (!spParents) {
          continue;
        }
        let foundVis = false;
        let maxParentGen = 0;
        for (let k = 0; k < spParents.length; k += 1) {
          const pid = spParents[k];
          if (visIds.has(pid)) {
            const pg = gen.get(pid) ?? 0;
            if (!foundVis || pg > maxParentGen) {
              foundVis = true;
              maxParentGen = pg;
            }
          }
        }
        if (foundVis) {
          inferred = maxParentGen + 1;
          break;
        }
      }
      if (inferred === null && p.birth_year !== null && isolatedMedians.size > 0) {
        let bestGen = 0;
        let bestDiff = Number.POSITIVE_INFINITY;
        for (const [g, med] of isolatedMedians.entries()) {
          const diff = Math.abs(p.birth_year - med);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestGen = g;
          }
        }
        inferred = bestGen;
      }
      gen.set(id, inferred ?? 0);
    }
  }

  const genSet = new Set<number>();
  for (let i = 0; i < sortedIds.length; i += 1) {
    genSet.add(gen.get(sortedIds[i]) ?? 0);
  }
  const uniqueGens = [...genSet].toSorted((a, b) => a - b);
  const remap = new Map<number, number>();
  for (let idx = 0; idx < uniqueGens.length; idx += 1) {
    remap.set(uniqueGens[idx], idx);
  }
  for (let i = 0; i < sortedIds.length; i += 1) {
    const id = sortedIds[i];
    gen.set(id, remap.get(gen.get(id) ?? 0) ?? 0);
  }
  return gen;
}
