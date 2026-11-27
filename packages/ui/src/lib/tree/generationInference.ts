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

export function inferGenerations(
  people: readonly Person[],
  kinship: readonly KinshipEdge[],
  parentMap: ReadonlyMap<string, readonly string[]>,
  childMap: ReadonlyMap<string, readonly string[]>,
  spouseMap: ReadonlyMap<string, readonly string[]>
): Map<string, number> {
  const gen = new Map<string, number>();
  const visIds = new Set(people.map((p) => p.id));

  for (const p of people) {
    if ((parentMap.get(p.id)?.length ?? 0) === 0) {
      gen.set(p.id, 0);
    }
  }

  for (let iter = 0; iter < 28; iter += 1) {
    let changed = false;
    for (const p of people) {
      const parents = parentMap.get(p.id) ?? [];
      if (parents.length > 0) {
        const target = Math.max(...parents.map((pid) => gen.get(pid) ?? 0)) + 1;
        if ((gen.get(p.id) ?? -1) < target) {
          gen.set(p.id, target);
          changed = true;
        }
      }
    }
    for (const p of people) {
      for (const spId of spouseMap.get(p.id) ?? []) {
        const ga = gen.get(p.id) ?? 0;
        const gb = gen.get(spId) ?? 0;
        if (ga !== gb) {
          const synced = Math.max(ga, gb);
          gen.set(p.id, synced);
          gen.set(spId, synced);
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }

  for (let iter = 0; iter < 6; iter += 1) {
    for (const p of people) {
      const children = childMap.get(p.id) ?? [];
      if (children.length > 0 && (parentMap.get(p.id)?.length ?? 0) === 0) {
        const minChild = Math.min(...children.map((cid) => gen.get(cid) ?? 1));
        const target = Math.max(0, minChild - 1);
        if ((gen.get(p.id) ?? 0) < target) {
          gen.set(p.id, target);
        }
      }
    }
    for (const p of people) {
      for (const spId of spouseMap.get(p.id) ?? []) {
        const ga = gen.get(p.id) ?? 0;
        const gb = gen.get(spId) ?? 0;
        if (ga !== gb) {
          const synced = Math.max(ga, gb);
          gen.set(p.id, synced);
          gen.set(spId, synced);
        }
      }
    }
  }

  const fullParentMap = new Map<string, string[]>();
  const fullSpouseMap = new Map<string, string[]>();
  for (const edge of kinship) {
    if (edge.relation === 'parent') {
      addUnique(fullParentMap, edge.to, edge.from);
    } else if (edge.relation === 'spouse') {
      addUnique(fullSpouseMap, edge.from, edge.to);
      addUnique(fullSpouseMap, edge.to, edge.from);
    }
  }

  const connectedYearsByGen = new Map<number, number[]>();
  for (const p of people) {
    const isConnected =
      (parentMap.get(p.id)?.length ?? 0) > 0 ||
      (childMap.get(p.id)?.length ?? 0) > 0 ||
      (spouseMap.get(p.id)?.length ?? 0) > 0;
    if (isConnected && p.birth_year !== null) {
      const g = gen.get(p.id) ?? 0;
      const list = connectedYearsByGen.get(g) ?? [];
      list.push(p.birth_year);
      connectedYearsByGen.set(g, list);
    }
  }

  for (const p of people) {
    const isConnected =
      (parentMap.get(p.id)?.length ?? 0) > 0 ||
      (childMap.get(p.id)?.length ?? 0) > 0 ||
      (spouseMap.get(p.id)?.length ?? 0) > 0;
    if (isConnected) {
      continue;
    }
    let inferred: number | null = null;
    for (const hiddenSpId of fullSpouseMap.get(p.id) ?? []) {
      const spParents = (fullParentMap.get(hiddenSpId) ?? []).filter((pid) => visIds.has(pid));
      if (spParents.length > 0) {
        inferred = Math.max(...spParents.map((pid) => gen.get(pid) ?? 0)) + 1;
        break;
      }
    }
    if (inferred === null && p.birth_year !== null && connectedYearsByGen.size > 0) {
      let bestGen = 0;
      let bestDiff = Infinity;
      for (const [g, yrs] of connectedYearsByGen.entries()) {
        const sorted = [...yrs].toSorted((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const diff = Math.abs(p.birth_year - median);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestGen = g;
        }
      }
      inferred = bestGen;
    }
    if (inferred !== null) {
      gen.set(p.id, inferred);
    }
  }

  const uniqueGens = [...new Set(people.map((p) => gen.get(p.id) ?? 0))].toSorted((a, b) => a - b);
  const remap = new Map<number, number>();
  for (const [idx, rawGen] of uniqueGens.entries()) {
    remap.set(rawGen, idx);
  }
  for (const p of people) {
    gen.set(p.id, remap.get(gen.get(p.id) ?? 0) ?? 0);
  }
  return gen;
}
