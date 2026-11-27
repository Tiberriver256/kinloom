import type { Person } from '@kinloom/core';
import { addUnique, inferGenerations } from './generationInference.js';
import {
  type ArchivalTreeModel,
  type BuildArchivalTreeInput,
  COLLATERAL_COLLAPSE_THRESHOLD,
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
