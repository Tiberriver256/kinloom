import { fastLocaleCompare, type KinshipEdge, type RawPerson } from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import type {
  KinshipGenerationGroup,
  KinshipSpouseRef,
  KinshipTraversalDirection,
  KinshipTraversalEntry,
  KinshipTraversalSummary,
} from './types.js';

export const DEFAULT_TRAVERSAL_DEPTH = 6;

export interface KinshipAdjacency {
  childrenOf: ReadonlyMap<string, readonly string[]>;
  parentsOf: ReadonlyMap<string, readonly string[]>;
  spousesOf: ReadonlyMap<string, readonly string[]>;
}

function addAdjEdge(map: Map<string, Set<string>>, from: string, to: string): void {
  let set = map.get(from);
  if (!set) {
    set = new Set<string>();
    map.set(from, set);
  }
  set.add(to);
}

function finalizeAdjMap(map: Map<string, Set<string>>): Map<string, readonly string[]> {
  const sorted = new Map<string, readonly string[]>();
  for (const [key, values] of map) {
    sorted.set(key, [...values].toSorted(fastLocaleCompare));
  }
  return sorted;
}

export function buildKinshipAdjacency(kinship: readonly KinshipEdge[]): KinshipAdjacency {
  const childrenMap = new Map<string, Set<string>>();
  const parentsMap = new Map<string, Set<string>>();
  const spousesMap = new Map<string, Set<string>>();

  for (const edge of kinship) {
    if (edge.relation === 'parent') {
      addAdjEdge(childrenMap, edge.from, edge.to);
      addAdjEdge(parentsMap, edge.to, edge.from);
    } else if (edge.relation === 'child') {
      addAdjEdge(parentsMap, edge.from, edge.to);
      addAdjEdge(childrenMap, edge.to, edge.from);
    } else if (edge.relation === 'spouse') {
      addAdjEdge(spousesMap, edge.from, edge.to);
      addAdjEdge(spousesMap, edge.to, edge.from);
    }
  }

  return {
    childrenOf: finalizeAdjMap(childrenMap),
    parentsOf: finalizeAdjMap(parentsMap),
    spousesOf: finalizeAdjMap(spousesMap),
  };
}

export function formatGenerationLabel(direction: KinshipTraversalDirection, generation: number): string {
  if (generation === 0) {
    return 'Generation 0 (root)';
  }
  if (direction === 'descendants') {
    if (generation === 1) return 'Generation 1 (children)';
    if (generation === 2) return 'Generation 2 (grandchildren)';
    return `Generation ${generation} (${generation === 3 ? 'great-grandchildren' : `${generation - 2}x great-grandchildren`})`;
  }
  if (generation === 1) return 'Generation 1 (parents)';
  if (generation === 2) return 'Generation 2 (grandparents)';
  return `Generation ${generation} (${generation === 3 ? 'great-grandparents' : `${generation - 2}x great-grandparents`})`;
}

export function buildGenerationGroups(
  direction: KinshipTraversalDirection,
  entries: readonly KinshipTraversalEntry[]
): KinshipGenerationGroup[] {
  const byGen = new Map<number, KinshipTraversalEntry[]>();
  for (const entry of entries) {
    let bucket = byGen.get(entry.generation);
    if (!bucket) {
      bucket = [];
      byGen.set(entry.generation, bucket);
    }
    bucket.push(entry);
  }
  const generations = [...byGen.keys()].toSorted((a, b) => a - b);
  return generations.map((generation) => {
    const genEntries = (byGen.get(generation) ?? []).toSorted((a, b) =>
      fastLocaleCompare(a.person.id, b.person.id)
    );
    return {
      generation,
      label: formatGenerationLabel(direction, generation),
      count: genEntries.length,
      entries: genEntries,
    };
  });
}

export interface TraverseKinshipInput {
  direction: KinshipTraversalDirection;
  rootId: string;
  maxDepth: number;
  peopleById: ReadonlyMap<string, RawPerson>;
  kinship: readonly KinshipEdge[];
  livingIds: ReadonlySet<string>;
  includeLiving: boolean;
}

export function traverseKinship(input: TraverseKinshipInput): {
  summary: KinshipTraversalSummary;
  entries: KinshipTraversalEntry[];
} {
  const root = input.peopleById.get(input.rootId);
  if (!root) {
    throw new CliValidationError(`Person '${input.rootId}' not found in data/people.yaml.`);
  }
  if (!input.includeLiving && input.livingIds.has(root.id)) {
    throw new CliValidationError(
      `Privacy fence: person '${root.id}' is living. Pass --include-living on a local private repository to traverse living records.`
    );
  }

  const adj = buildKinshipAdjacency(input.kinship);
  const nextMap = input.direction === 'descendants' ? adj.childrenOf : adj.parentsOf;

  const visited = new Set<string>([root.id]);
  const skippedLivingIds = new Set<string>();
  const queue: Array<{ id: string; generation: number; viaId: string | null }> = [
    { id: root.id, generation: 0, viaId: null },
  ];

  const entries: KinshipTraversalEntry[] = [];
  let truncatedByDepth = false;

  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (!current) continue;
    const person = input.peopleById.get(current.id);
    if (!person) continue;

    const rawSpouses = adj.spousesOf.get(person.id) ?? [];
    const spouses: KinshipSpouseRef[] = [];
    for (const spouseId of rawSpouses) {
      const spouse = input.peopleById.get(spouseId);
      if (!spouse) continue;
      const spouseLiving = input.livingIds.has(spouse.id);
      if (!input.includeLiving && spouseLiving) {
        skippedLivingIds.add(spouse.id);
        continue;
      }
      spouses.push({
        id: spouse.id,
        full_name: spouse.full_name,
        birth_edtf: spouse.birth_edtf,
        death_edtf: spouse.death_edtf,
        is_living: spouseLiving,
      });
    }

    entries.push({
      generation: current.generation,
      person,
      via_id: current.viaId,
      spouses,
    });

    const neighbors = nextMap.get(person.id) ?? [];
    for (const neighborId of neighbors) {
      if (visited.has(neighborId)) continue;
      if (!input.peopleById.has(neighborId)) continue;
      if (!input.includeLiving && input.livingIds.has(neighborId)) {
        skippedLivingIds.add(neighborId);
        continue;
      }
      if (current.generation >= input.maxDepth) {
        truncatedByDepth = true;
        continue;
      }
      visited.add(neighborId);
      queue.push({ id: neighborId, generation: current.generation + 1, viaId: person.id });
    }
  }

  const generations = buildGenerationGroups(input.direction, entries);
  return {
    entries,
    summary: {
      direction: input.direction,
      rootId: root.id,
      maxDepth: input.maxDepth,
      truncatedByDepth,
      excludedLivingCount: skippedLivingIds.size,
      totalPeople: entries.length,
      generations,
    },
  };
}
