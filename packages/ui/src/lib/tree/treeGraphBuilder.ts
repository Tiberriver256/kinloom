import type { KinshipEdge, Person } from '@kinloom/core';
import {
  type ArchivalTreeModel,
  type BuildArchivalTreeInput,
  COLLATERAL_COLLAPSE_THRESHOLD,
  isDirectSpinePerson,
  isEarlyChildhoodLoss,
  isRedactedLivingPlaceholder,
  sortPeopleChronologically,
  type TreeFamilyUnit,
  type TreeGenerationGroup,
  type TreeLineageMode,
  type TreeUnion,
  type TreeUnionKind,
} from './types.js';

interface UnionDraft {
  readonly id: string;
  readonly kind: TreeUnionKind;
  readonly aId: string;
  readonly bId: string | null;
  readonly gen: number;
  readonly childIds: string[];
}

function addUnique(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, [value]);
    return;
  }
  if (!existing.includes(value)) {
    existing.push(value);
  }
}

function pickUnionPairKey(aId: string, bId: string | null): string {
  if (bId === null) {
    return `single:${aId}`;
  }
  return aId < bId ? `couple:${aId}+${bId}` : `couple:${bId}+${aId}`;
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

  // Place isolated individuals (such as marrying-in spouses whose link is hidden by privacy) by birth cohort.
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

  // Normalize generation indices so they start cleanly at 0 with no negative gaps.
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

function buildUnionDrafts(params: {
  readonly branchPeople: readonly Person[];
  readonly genByPersonId: ReadonlyMap<string, number>;
  readonly parentMap: ReadonlyMap<string, readonly string[]>;
  readonly spouseMap: ReadonlyMap<string, readonly string[]>;
  readonly directPersonIds: ReadonlySet<string>;
}): Map<string, UnionDraft> {
  const { branchPeople, genByPersonId, parentMap, spouseMap, directPersonIds } = params;
  const unionDrafts = new Map<string, UnionDraft>();

  for (const p of branchPeople) {
    const pGen = genByPersonId.get(p.id) ?? 0;
    for (const spId of spouseMap.get(p.id) ?? []) {
      if ((genByPersonId.get(spId) ?? 0) !== pGen) {
        continue;
      }
      const key = pickUnionPairKey(p.id, spId);
      if (!unionDrafts.has(key)) {
        const aDirect = directPersonIds.has(p.id);
        const bDirect = directPersonIds.has(spId);
        let primary = p.id;
        let secondary = spId;
        if (!aDirect && bDirect) {
          primary = spId;
          secondary = p.id;
        } else if (aDirect === bDirect) {
          const spCountA = spouseMap.get(p.id)?.length ?? 0;
          const spCountB = spouseMap.get(spId)?.length ?? 0;
          if (spCountB > spCountA || (spCountB === spCountA && spId < p.id)) {
            primary = spId;
            secondary = p.id;
          }
        }
        unionDrafts.set(key, {
          id: key,
          kind: 'couple',
          aId: primary,
          bId: secondary,
          gen: pGen,
          childIds: [],
        });
      }
    }
  }

  for (const child of branchPeople) {
    const pids = parentMap.get(child.id) ?? [];
    if (pids.length === 0) {
      continue;
    }
    let targetKey: string | null = null;
    if (pids.length >= 2) {
      for (let i = 0; i < pids.length && !targetKey; i += 1) {
        for (let j = i + 1; j < pids.length && !targetKey; j += 1) {
          const candidate = pickUnionPairKey(pids[i], pids[j]);
          if (unionDrafts.has(candidate)) {
            targetKey = candidate;
          }
        }
      }
      if (!targetKey) {
        const [p0, p1] = pids;
        const g0 = genByPersonId.get(p0) ?? 0;
        const g1 = genByPersonId.get(p1) ?? 0;
        if (g0 === g1) {
          const key = pickUnionPairKey(p0, p1);
          const p0Direct = directPersonIds.has(p0);
          const p1Direct = directPersonIds.has(p1);
          unionDrafts.set(key, {
            id: key,
            kind: 'couple',
            aId: !p0Direct && p1Direct ? p1 : p0,
            bId: !p0Direct && p1Direct ? p0 : p1,
            gen: g0,
            childIds: [],
          });
          targetKey = key;
        }
      }
    }
    if (!targetKey) {
      const parentId = pids.find((pid) => directPersonIds.has(pid)) ?? pids[0];
      const key = pickUnionPairKey(parentId, null);
      if (!unionDrafts.has(key)) {
        unionDrafts.set(key, {
          id: key,
          kind: 'single_parent',
          aId: parentId,
          bId: null,
          gen: genByPersonId.get(parentId) ?? 0,
          childIds: [],
        });
      }
      targetKey = key;
    }
    const draft = unionDrafts.get(targetKey);
    if (draft && !draft.childIds.includes(child.id)) {
      draft.childIds.push(child.id);
    }
  }

  return unionDrafts;
}

function computeMarriageOrderByUnionId(
  unionDrafts: ReadonlyMap<string, UnionDraft>,
  peopleById: ReadonlyMap<string, Person>
): Map<string, { order: number; total: number }> {
  const coupleDraftsByPrimary = new Map<string, UnionDraft[]>();
  for (const draft of unionDrafts.values()) {
    if (draft.kind === 'couple') {
      const list = coupleDraftsByPrimary.get(draft.aId) ?? [];
      list.push(draft);
      coupleDraftsByPrimary.set(draft.aId, list);
    }
  }
  const marriageOrderByUnionId = new Map<string, { order: number; total: number }>();
  for (const list of coupleDraftsByPrimary.values()) {
    list.sort((u1, u2) => {
      const minChildYear = (cids: readonly string[]): number => {
        const yrs = cids
          .map((cid) => peopleById.get(cid)?.birth_year)
          .filter((y): y is number => y !== null && y !== undefined);
        return yrs.length > 0 ? Math.min(...yrs) : 9999;
      };
      const y1 = minChildYear(u1.childIds);
      const y2 = minChildYear(u2.childIds);
      if (y1 !== y2) {
        return y1 - y2;
      }
      const sp1 = u1.bId ? (peopleById.get(u1.bId)?.birth_year ?? 9999) : 9999;
      const sp2 = u2.bId ? (peopleById.get(u2.bId)?.birth_year ?? 9999) : 9999;
      return sp1 - sp2;
    });
    for (const [idx, draft] of list.entries()) {
      marriageOrderByUnionId.set(draft.id, { order: idx + 1, total: list.length });
    }
  }
  return marriageOrderByUnionId;
}

function buildGenerationGroups(params: {
  readonly rankPeople: readonly Person[];
  readonly unions: readonly TreeUnion[];
  readonly genByPersonId: ReadonlyMap<string, number>;
  readonly spouseMap: ReadonlyMap<string, readonly string[]>;
  readonly directPersonIds: ReadonlySet<string>;
}): {
  readonly generations: TreeGenerationGroup[];
  readonly unitsById: Map<string, TreeFamilyUnit>;
} {
  const { rankPeople, unions, genByPersonId, spouseMap, directPersonIds } = params;
  const rankByGen = new Map<number, Person[]>();
  for (const p of rankPeople) {
    const g = genByPersonId.get(p.id) ?? 0;
    const list = rankByGen.get(g) ?? [];
    list.push(p);
    rankByGen.set(g, list);
  }

  const allGenNums = [...new Set([...rankByGen.keys(), ...unions.map((u) => u.gen)])].toSorted(
    (a, b) => a - b
  );

  const unitsById = new Map<string, TreeFamilyUnit>();
  const generations: TreeGenerationGroup[] = [];

  for (const g of allGenNums) {
    const genMembers = (rankByGen.get(g) ?? []).toSorted((a, b) => {
      const da = directPersonIds.has(a.id) ? 0 : 1;
      const db = directPersonIds.has(b.id) ? 0 : 1;
      if (da !== db) {
        return da - db;
      }
      const spCountDiff = (spouseMap.get(b.id)?.length ?? 0) - (spouseMap.get(a.id)?.length ?? 0);
      if (spCountDiff !== 0) {
        return spCountDiff;
      }
      return sortPeopleChronologically(a, b);
    });

    const placedInUnit = new Set<string>();
    const genUnits: TreeFamilyUnit[] = [];

    for (const anchor of genMembers) {
      if (placedInUnit.has(anchor.id)) {
        continue;
      }
      const anchorCoupleUnions = unions
        .filter(
          (u) =>
            u.kind === 'couple' &&
            u.gen === g &&
            (u.primaryPartnerId === anchor.id || u.secondaryPartnerId === anchor.id)
        )
        .toSorted((u1, u2) => u1.marriageOrder - u2.marriageOrder);

      const availableSpouses: { spouseId: string; union: TreeUnion }[] = [];
      for (const u of anchorCoupleUnions) {
        const otherId = u.primaryPartnerId === anchor.id ? u.secondaryPartnerId : u.primaryPartnerId;
        if (otherId && !placedInUnit.has(otherId) && genMembers.some((m) => m.id === otherId)) {
          availableSpouses.push({ spouseId: otherId, union: u });
        }
      }

      placedInUnit.add(anchor.id);
      for (const s of availableSpouses) {
        placedInUnit.add(s.spouseId);
      }

      let orderedMemberIds: string[];
      if (availableSpouses.length === 2) {
        // Place anchor in center so Marriage I drops left and Marriage II drops right with zero crossings.
        orderedMemberIds = [availableSpouses[0].spouseId, anchor.id, availableSpouses[1].spouseId];
      } else {
        orderedMemberIds = [anchor.id, ...availableSpouses.map((s) => s.spouseId)];
      }

      const memberSet = new Set(orderedMemberIds);
      const unitUnionIds = unions
        .filter((u) => u.gen === g && u.partnerIds.every((pid) => memberSet.has(pid)))
        .toSorted((u1, u2) => u1.marriageOrder - u2.marriageOrder)
        .map((u) => u.id);

      const unit: TreeFamilyUnit = {
        id: orderedMemberIds.join('+'),
        gen: g,
        anchorId: anchor.id,
        orderedMemberIds,
        unionIds: unitUnionIds,
        isDirect: orderedMemberIds.some((id) => directPersonIds.has(id)),
      };
      genUnits.push(unit);
      unitsById.set(unit.id, unit);
    }

    const genUnions = unions.filter((u) => u.gen === g);
    const yearPool: number[] = [];
    for (const m of genMembers) {
      if (m.birth_year !== null) {
        yearPool.push(m.birth_year);
      }
    }
    const yearRange =
      yearPool.length > 0 ? `${Math.min(...yearPool)}–${Math.max(...yearPool)}` : `Gen ${g + 1}`;

    generations.push({
      gen: g,
      label: `G${g + 1}`,
      yearRange,
      units: genUnits,
      unions: genUnions,
      personIds: genMembers.map((m) => m.id),
    });
  }

  return { generations, unitsById };
}

export function buildArchivalTreeModel({
  people,
  kinship,
  branchFilter,
  defaultBranchId = 'primary',
  directModeBranchIds,
  mode,
  expandedUnionIds = new Set<string>(),
}: BuildArchivalTreeInput): ArchivalTreeModel {
  const branchPeople = people.filter((p) => {
    if (isRedactedLivingPlaceholder(p)) {
      return false;
    }
    if (!branchFilter || branchFilter === 'all') {
      return true;
    }
    return (p.branch || defaultBranchId) === branchFilter;
  });

  const branchIds = new Set(branchPeople.map((p) => p.id));
  const peopleById = new Map(branchPeople.map((p) => [p.id, p]));

  const parentMap = new Map<string, string[]>();
  const childMap = new Map<string, string[]>();
  const spouseMap = new Map<string, string[]>();

  for (const edge of kinship) {
    if (!branchIds.has(edge.from) || !branchIds.has(edge.to)) {
      continue;
    }
    if (edge.relation === 'parent') {
      addUnique(childMap, edge.from, edge.to);
      addUnique(parentMap, edge.to, edge.from);
    } else if (edge.relation === 'child') {
      addUnique(childMap, edge.to, edge.from);
      addUnique(parentMap, edge.from, edge.to);
    } else if (edge.relation === 'spouse') {
      addUnique(spouseMap, edge.from, edge.to);
      addUnique(spouseMap, edge.to, edge.from);
    }
  }

  const genByPersonId = inferGenerations(branchPeople, kinship, parentMap, childMap, spouseMap);

  const directPersonIds = new Set<string>();
  for (const p of branchPeople) {
    if (isDirectSpinePerson(p)) {
      directPersonIds.add(p.id);
    }
  }

  const spinePartnerIds = new Set<string>(directPersonIds);
  for (const pid of directPersonIds) {
    for (const spId of spouseMap.get(pid) ?? []) {
      spinePartnerIds.add(spId);
    }
  }
  for (const p of branchPeople) {
    if (p.lineage_group === 'descendant_spouse') {
      spinePartnerIds.add(p.id);
    }
  }

  const supportsDirectForBranch =
    !directModeBranchIds ||
    !branchFilter ||
    branchFilter === 'all' ||
    directModeBranchIds.includes(branchFilter);

  const effectiveMode: TreeLineageMode =
    mode === 'spine' && supportsDirectForBranch && directPersonIds.size > 0 ? 'spine' : 'full';

  const earlyLossIds = new Set<string>();
  for (const p of branchPeople) {
    if (isEarlyChildhoodLoss(p, parentMap, childMap, spouseMap)) {
      earlyLossIds.add(p.id);
    }
  }

  const pivotPersonId =
    branchPeople.find((p) => p.lineage_group === 'pivot_ancestor')?.id ??
    branchPeople.find((p) => p.lineage_group === 'ancestor')?.id ??
    branchPeople[0]?.id ??
    null;

  const unionDrafts = buildUnionDrafts({
    branchPeople,
    genByPersonId,
    parentMap,
    spouseMap,
    directPersonIds,
  });
  const marriageOrderByUnionId = computeMarriageOrderByUnionId(unionDrafts, peopleById);

  const isUnionActiveInMode = (draft: UnionDraft): boolean => {
    if (effectiveMode === 'full') {
      return true;
    }
    return (
      spinePartnerIds.has(draft.aId) ||
      (draft.bId !== null && spinePartnerIds.has(draft.bId)) ||
      draft.childIds.some((cid) => spinePartnerIds.has(cid))
    );
  };

  const unions: TreeUnion[] = [];
  const unionsById = new Map<string, TreeUnion>();
  const collapsedByAnyUnion = new Set<string>();
  const hangingByAnyUnion = new Set<string>();

  for (const draft of unionDrafts.values()) {
    if (!isUnionActiveInMode(draft)) {
      continue;
    }
    const sortedChildren = [...draft.childIds]
      .map((cid) => peopleById.get(cid))
      .filter((p): p is Person => p !== undefined)
      .toSorted(sortPeopleChronologically);

    const earlyLossChildIds: string[] = [];
    const survivingChildren: Person[] = [];

    for (const child of sortedChildren) {
      if (earlyLossIds.has(child.id)) {
        earlyLossChildIds.push(child.id);
      } else {
        survivingChildren.push(child);
      }
    }

    const isExpanded = expandedUnionIds.has(draft.id);
    const visibleChildIds: string[] = [];
    const hangingChildIds: string[] = [];
    const collapsedSiblingIds: string[] = [];

    if (effectiveMode === 'spine') {
      const spineChildren: Person[] = [];
      const collateralSiblings: Person[] = [];
      for (const child of survivingChildren) {
        if (spinePartnerIds.has(child.id)) {
          spineChildren.push(child);
        } else {
          collateralSiblings.push(child);
        }
      }
      for (const sc of spineChildren) {
        visibleChildIds.push(sc.id);
      }
      if (collateralSiblings.length > 0) {
        if (isExpanded) {
          for (const sib of collateralSiblings) {
            hangingChildIds.push(sib.id);
            hangingByAnyUnion.add(sib.id);
          }
        } else {
          for (const sib of collateralSiblings) {
            collapsedSiblingIds.push(sib.id);
            collapsedByAnyUnion.add(sib.id);
          }
        }
      }
    } else {
      const anchorOrBranching: Person[] = [];
      const collateralLeaves: Person[] = [];
      for (const child of survivingChildren) {
        const hasDescendants = (childMap.get(child.id)?.length ?? 0) > 0;
        const hasSpouse = (spouseMap.get(child.id)?.length ?? 0) > 0;
        const isDirect = directPersonIds.has(child.id);
        if (isDirect || hasDescendants || hasSpouse) {
          anchorOrBranching.push(child);
        } else {
          collateralLeaves.push(child);
        }
      }

      for (const child of anchorOrBranching) {
        visibleChildIds.push(child.id);
      }

      if (collateralLeaves.length >= COLLATERAL_COLLAPSE_THRESHOLD) {
        if (isExpanded) {
          for (const leaf of collateralLeaves) {
            hangingChildIds.push(leaf.id);
            hangingByAnyUnion.add(leaf.id);
          }
        } else {
          for (const leaf of collateralLeaves) {
            collapsedSiblingIds.push(leaf.id);
            collapsedByAnyUnion.add(leaf.id);
          }
        }
      } else {
        for (const leaf of collateralLeaves) {
          visibleChildIds.push(leaf.id);
        }
      }
    }

    const orderMeta = marriageOrderByUnionId.get(draft.id) ?? { order: 1, total: 1 };
    const partnerIds = draft.bId ? [draft.aId, draft.bId] : [draft.aId];
    const isDirectUnion =
      directPersonIds.has(draft.aId) ||
      (draft.bId !== null && directPersonIds.has(draft.bId)) ||
      visibleChildIds.some((cid) => directPersonIds.has(cid));

    const union: TreeUnion = {
      id: draft.id,
      kind: draft.kind,
      primaryPartnerId: draft.aId,
      secondaryPartnerId: draft.bId,
      partnerIds,
      marriageOrder: orderMeta.order,
      totalMarriagesForPrimary: orderMeta.total,
      gen: draft.gen,
      isDirect: isDirectUnion,
      allChildIds: sortedChildren.map((c) => c.id),
      visibleChildIds,
      hangingChildIds,
      collapsedSiblingIds,
      earlyLossChildIds,
      isExpanded,
    };
    unions.push(union);
    unionsById.set(union.id, union);
  }

  const rankPeople = branchPeople.filter((p) => {
    if (earlyLossIds.has(p.id)) {
      return false;
    }
    if (collapsedByAnyUnion.has(p.id) || hangingByAnyUnion.has(p.id)) {
      return false;
    }
    if (effectiveMode === 'spine') {
      return spinePartnerIds.has(p.id);
    }
    return true;
  });

  const { generations, unitsById } = buildGenerationGroups({
    rankPeople,
    unions,
    genByPersonId,
    spouseMap,
    directPersonIds,
  });

  return {
    mode,
    effectiveMode,
    peopleById,
    visiblePeople: branchPeople,
    totalVisibleCount: branchPeople.length,
    directSpineCount: spinePartnerIds.size,
    generations,
    unions,
    unionsById,
    unitsById,
    genByPersonId,
    parentMap,
    childMap,
    spouseMap,
    earlyLossIds,
    directPersonIds,
    pivotPersonId,
  };
}
