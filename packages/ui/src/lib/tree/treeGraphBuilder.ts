import type { Person } from '@kinloom/core';
import { addUnique, inferGenerations } from './generationInference.js';
import {
  type ArchivalTreeModel,
  type BuildArchivalTreeInput,
  COLLATERAL_COLLAPSE_THRESHOLD,
  DIRECT_SPINE_DESCENDANT_FANOUT_LIMIT,
  isDirectAncestorOrPivot,
  isDirectSpinePerson,
  isEarlyChildhoodLoss,
  isRedactedLivingPlaceholder,
  sortPeopleChronologically,
  type TreeLineageMode,
  type TreeUnion,
} from './types.js';
import {
  buildGenerationGroups,
  buildUnionDrafts,
  computeMarriageOrderByUnionId,
  type UnionDraft,
} from './unionAssembly.js';

export { inferGenerations };

function computeFocalDirectSpineIds(params: {
  readonly branchPeople: readonly Person[];
  readonly peopleById: ReadonlyMap<string, Person>;
  readonly parentMap: ReadonlyMap<string, readonly string[]>;
  readonly childMap: ReadonlyMap<string, readonly string[]>;
  readonly spouseMap: ReadonlyMap<string, readonly string[]>;
  readonly earlyLossIds: ReadonlySet<string>;
  readonly directPersonIds: ReadonlySet<string>;
}): Set<string> {
  const { branchPeople, peopleById, parentMap, childMap, spouseMap, earlyLossIds, directPersonIds } = params;
  const descendantCount = branchPeople.filter((p) => p.lineage_group === 'descendant').length;
  const hasWideDescendantFanout = descendantCount > DIRECT_SPINE_DESCENDANT_FANOUT_LIMIT;

  // Small/narrow archives keep all direct-spine records intact; wide multi-branch descendant
  // trees narrow Direct Line mode to the focal ancestor/pivot trunk and primary continuation.
  if (!hasWideDescendantFanout) {
    return new Set(directPersonIds);
  }

  const focal = new Set<string>();
  const seedAncestors: string[] = [];
  for (const p of branchPeople) {
    if (isDirectAncestorOrPivot(p)) {
      focal.add(p.id);
      seedAncestors.push(p.id);
    }
  }

  // Ensure every ancestor above any pivot/ancestor record stays on the focal spine.
  const upQueue = [...seedAncestors];
  while (upQueue.length > 0) {
    const cur = upQueue.shift();
    if (!cur) {
      continue;
    }
    for (const pid of parentMap.get(cur) ?? []) {
      if (!focal.has(pid) && directPersonIds.has(pid)) {
        focal.add(pid);
        upQueue.push(pid);
      }
    }
  }

  // Memoize surviving-descendant depth to pick the primary continuation line deterministically.
  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const subtreeDepth = (id: string): number => {
    const cached = depthMemo.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(id)) {
      return 0;
    }
    visiting.add(id);
    let best = 0;
    for (const cid of childMap.get(id) ?? []) {
      if (!earlyLossIds.has(cid) && directPersonIds.has(cid)) {
        const d = 1 + subtreeDepth(cid);
        if (d > best) {
          best = d;
        }
      }
    }
    visiting.delete(id);
    depthMemo.set(id, best);
    return best;
  };

  const rankContinuationChild = (aId: string, bId: string): number => {
    const depthDiff = subtreeDepth(bId) - subtreeDepth(aId);
    if (depthDiff !== 0) {
      return depthDiff;
    }
    const spDiff = (spouseMap.get(bId)?.length ?? 0) - (spouseMap.get(aId)?.length ?? 0);
    if (spDiff !== 0) {
      return spDiff;
    }
    const pa = peopleById.get(aId);
    const pb = peopleById.get(bId);
    const evDiff = (pb?.event_count ?? 0) - (pa?.event_count ?? 0);
    if (evDiff !== 0) {
      return evDiff;
    }
    const ya = pa?.birth_year ?? 9999;
    const yb = pb?.birth_year ?? 9999;
    if (ya !== yb) {
      return ya - yb;
    }
    return aId.localeCompare(bId);
  };

  // Walk downward from focal ancestors/pivot into surviving descendant children, keeping at most
  // one primary continuation per branching union so wide modern descendant fans collapse cleanly.
  const downQueue = [...focal].toSorted((a, b) => a.localeCompare(b));
  const processedDown = new Set<string>();
  while (downQueue.length > 0) {
    const cur = downQueue.shift();
    if (!cur || processedDown.has(cur)) {
      continue;
    }
    processedDown.add(cur);
    const directChildren = (childMap.get(cur) ?? []).filter(
      (cid) => !earlyLossIds.has(cid) && directPersonIds.has(cid) && !focal.has(cid)
    );
    if (directChildren.length === 0) {
      continue;
    }
    const sorted = [...directChildren].toSorted(rankContinuationChild);
    const primaryChild = sorted[0];
    if (primaryChild) {
      focal.add(primaryChild);
      downQueue.push(primaryChild);
    }
  }

  return focal;
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

  const earlyLossIds = new Set<string>();
  for (const p of branchPeople) {
    if (isEarlyChildhoodLoss(p, parentMap, childMap, spouseMap)) {
      earlyLossIds.add(p.id);
    }
  }

  const directPersonIds = new Set<string>();
  for (const p of branchPeople) {
    if (isDirectSpinePerson(p)) {
      directPersonIds.add(p.id);
    }
  }

  const focalSpineIds = computeFocalDirectSpineIds({
    branchPeople,
    peopleById,
    parentMap,
    childMap,
    spouseMap,
    earlyLossIds,
    directPersonIds,
  });

  const spinePartnerIds = new Set<string>(focalSpineIds);
  for (const pid of focalSpineIds) {
    for (const spId of spouseMap.get(pid) ?? []) {
      spinePartnerIds.add(spId);
    }
  }
  // Include co-parents of focal spine children when no explicit spouse edge was recorded.
  for (const cid of focalSpineIds) {
    const parents = parentMap.get(cid) ?? [];
    if (parents.some((pid) => focalSpineIds.has(pid))) {
      for (const pid of parents) {
        spinePartnerIds.add(pid);
      }
    }
  }

  const supportsDirectForBranch =
    !directModeBranchIds ||
    !branchFilter ||
    branchFilter === 'all' ||
    directModeBranchIds.includes(branchFilter);

  const effectiveMode: TreeLineageMode =
    mode === 'spine' && supportsDirectForBranch && focalSpineIds.size > 0 ? 'spine' : 'full';

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
    directPersonIds: effectiveMode === 'spine' ? focalSpineIds : directPersonIds,
  });
  const marriageOrderByUnionId = computeMarriageOrderByUnionId(unionDrafts, peopleById);

  const isUnionActiveInMode = (draft: UnionDraft): boolean => {
    if (effectiveMode === 'full') {
      return true;
    }
    const aFocal = focalSpineIds.has(draft.aId);
    const bFocal = draft.bId !== null && focalSpineIds.has(draft.bId);
    if (!aFocal && !bFocal) {
      return false;
    }
    if (draft.bId !== null) {
      return spinePartnerIds.has(draft.aId) && spinePartnerIds.has(draft.bId);
    }
    return spinePartnerIds.has(draft.aId);
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
      focalSpineIds.has(draft.aId) ||
      (draft.bId !== null && focalSpineIds.has(draft.bId)) ||
      visibleChildIds.some((cid) => focalSpineIds.has(cid));

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

  const rankPersonIdSet = new Set(rankPeople.map((p) => p.id));
  const activeUnions = unions.filter((u) => u.partnerIds.every((pid) => rankPersonIdSet.has(pid)));
  const activeUnionsById = new Map(activeUnions.map((u) => [u.id, u]));

  const { generations, unitsById } = buildGenerationGroups({
    rankPeople,
    unions: activeUnions,
    genByPersonId,
    spouseMap,
    directPersonIds: effectiveMode === 'spine' ? focalSpineIds : directPersonIds,
  });

  return {
    mode,
    effectiveMode,
    peopleById,
    visiblePeople: branchPeople,
    totalVisibleCount: branchPeople.length,
    directSpineCount: spinePartnerIds.size,
    generations,
    unions: activeUnions,
    unionsById: activeUnionsById,
    unitsById,
    genByPersonId,
    parentMap,
    childMap,
    spouseMap,
    earlyLossIds,
    directPersonIds: effectiveMode === 'spine' ? focalSpineIds : directPersonIds,
    pivotPersonId,
  };
}
