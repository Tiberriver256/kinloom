import { fastLocaleCompare, type KinshipEdge, type Person } from '@kinloom/core';
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
  sortGenerationMembers,
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
  let descendantCount = 0;
  for (const p of branchPeople) {
    if (p.lineage_group === 'descendant') {
      descendantCount += 1;
    }
  }
  const hasWideDescendantFanout = descendantCount > DIRECT_SPINE_DESCENDANT_FANOUT_LIMIT;

  if (!hasWideDescendantFanout) {
    return new Set(directPersonIds);
  }

  const focal = new Set<string>();
  const upQueue: string[] = [];
  for (const p of branchPeople) {
    if (isDirectAncestorOrPivot(p)) {
      focal.add(p.id);
      upQueue.push(p.id);
    }
  }

  let upHead = 0;
  while (upHead < upQueue.length) {
    const cur = upQueue[upHead];
    upHead += 1;
    if (cur === undefined) {
      continue;
    }
    const parents = parentMap.get(cur);
    if (!parents) {
      continue;
    }
    for (const pid of parents) {
      if (!focal.has(pid) && directPersonIds.has(pid)) {
        focal.add(pid);
        upQueue.push(pid);
      }
    }
  }

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
    const children = childMap.get(id);
    if (children) {
      for (const cid of children) {
        if (!earlyLossIds.has(cid) && directPersonIds.has(cid)) {
          const d = 1 + subtreeDepth(cid);
          if (d > best) {
            best = d;
          }
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
    return fastLocaleCompare(aId, bId);
  };

  const downQueue = [...focal].toSorted(fastLocaleCompare);
  const processedDown = new Set<string>();
  let downHead = 0;
  while (downHead < downQueue.length) {
    const cur = downQueue[downHead];
    downHead += 1;
    if (!cur || processedDown.has(cur)) {
      continue;
    }
    processedDown.add(cur);
    const children = childMap.get(cur);
    if (!children) {
      continue;
    }
    const directChildren: string[] = [];
    for (const cid of children) {
      if (!earlyLossIds.has(cid) && directPersonIds.has(cid) && !focal.has(cid)) {
        directChildren.push(cid);
      }
    }
    if (directChildren.length === 0) {
      continue;
    }
    directChildren.sort(rankContinuationChild);
    const primaryChild = directChildren[0];
    if (primaryChild) {
      focal.add(primaryChild);
      downQueue.push(primaryChild);
    }
  }

  return focal;
}

function computeAnchoredAncestorSpineIds(
  anchorId: string,
  peopleById: ReadonlyMap<string, Person>,
  parentMap: ReadonlyMap<string, readonly string[]>
): Set<string> {
  const focal = new Set<string>([anchorId]);
  const queue: string[] = [anchorId];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    if (cur === undefined) {
      continue;
    }
    const parents = parentMap.get(cur);
    if (!parents) {
      continue;
    }
    for (const parentId of parents) {
      if (peopleById.has(parentId) && !focal.has(parentId)) {
        focal.add(parentId);
        queue.push(parentId);
      }
    }
  }
  return focal;
}

interface PreparedModeUnion {
  readonly draft: UnionDraft;
  readonly order: number;
  readonly totalMarriagesForPrimary: number;
  readonly partnerIds: string[];
  readonly baseDirect: boolean;
  readonly allChildIds: string[];
  readonly earlyLossChildIds: string[];
  readonly alwaysVisibleChildIds: string[];
  readonly collapsibleIds: string[];
}

interface PreparedModeData {
  readonly preparedUnions: readonly PreparedModeUnion[];
  readonly sortedGenBuckets: readonly { readonly gen: number; readonly members: readonly Person[] }[];
}

interface PrecomputedBranchTopology {
  readonly branchPeople: Person[];
  readonly peopleById: Map<string, Person>;
  readonly parentMap: Map<string, string[]>;
  readonly childMap: Map<string, string[]>;
  readonly spouseMap: Map<string, string[]>;
  readonly genByPersonId: Map<string, number>;
  readonly directPersonIds: Set<string>;
  readonly focalSpineIds: Set<string>;
  readonly spinePartnerIds: Set<string>;
  readonly earlyLossIds: Set<string>;
  readonly pivotPersonId: string | null;
  readonly resolvedAnchorId: string | null;
  readonly rawGenBuckets: ReadonlyMap<number, readonly Person[]>;
  readonly sortedGenNums: readonly number[];
  fullModeData: PreparedModeData | null;
  spineModeData: PreparedModeData | null;
}

const topologyCache = new WeakMap<
  readonly Person[],
  WeakMap<readonly KinshipEdge[], Map<string, PrecomputedBranchTopology>>
>();

function getPrecomputedBranchTopology(
  people: readonly Person[],
  kinship: readonly KinshipEdge[],
  branchFilter: string | null | undefined,
  defaultBranchId: string,
  anchorPersonId: string | null | undefined
): PrecomputedBranchTopology {
  const normalizedAnchor = anchorPersonId?.trim() || '';
  const cacheKey = `${branchFilter ?? ''}\0${defaultBranchId}\0${normalizedAnchor}`;
  let byKinship = topologyCache.get(people);
  if (byKinship) {
    const existing = byKinship.get(kinship)?.get(cacheKey);
    if (existing) {
      return existing;
    }
  }

  const branchPeople: Person[] = [];
  const branchIds = new Set<string>();
  const peopleById = new Map<string, Person>();
  for (const p of people) {
    if (isRedactedLivingPlaceholder(p)) {
      continue;
    }
    if (branchFilter && branchFilter !== 'all' && (p.branch || defaultBranchId) !== branchFilter) {
      continue;
    }
    branchPeople.push(p);
    branchIds.add(p.id);
    peopleById.set(p.id, p);
  }

  const resolvedAnchorId =
    normalizedAnchor.length > 0 && peopleById.has(normalizedAnchor) ? normalizedAnchor : null;

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
  const directPersonIds = new Set<string>();
  let pivotPersonId: string | null = resolvedAnchorId;
  let fallbackAncestorId: string | null = null;
  const rawGenMap = new Map<number, Person[]>();

  for (const p of branchPeople) {
    if (isDirectSpinePerson(p)) {
      directPersonIds.add(p.id);
    }
    if (p.id !== resolvedAnchorId && isEarlyChildhoodLoss(p, parentMap, childMap, spouseMap)) {
      earlyLossIds.add(p.id);
    } else {
      const g = genByPersonId.get(p.id) ?? 0;
      const gList = rawGenMap.get(g);
      if (gList) {
        gList.push(p);
      } else {
        rawGenMap.set(g, [p]);
      }
    }
    if (pivotPersonId === null && p.lineage_group === 'pivot_ancestor') {
      pivotPersonId = p.id;
    } else if (fallbackAncestorId === null && p.lineage_group === 'ancestor') {
      fallbackAncestorId = p.id;
    }
  }
  if (pivotPersonId === null) {
    pivotPersonId = fallbackAncestorId ?? branchPeople[0]?.id ?? null;
  }

  const focalSpineIds =
    resolvedAnchorId !== null
      ? computeAnchoredAncestorSpineIds(resolvedAnchorId, peopleById, parentMap)
      : computeFocalDirectSpineIds({
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
    const spouses = spouseMap.get(pid);
    if (spouses) {
      for (const spouseId of spouses) {
        spinePartnerIds.add(spouseId);
      }
    }
  }
  for (const cid of focalSpineIds) {
    const parents = parentMap.get(cid);
    if (!parents) {
      continue;
    }
    let hasFocalParent = false;
    for (const parentId of parents) {
      if (focalSpineIds.has(parentId)) {
        hasFocalParent = true;
        break;
      }
    }
    if (hasFocalParent) {
      for (const parentId of parents) {
        spinePartnerIds.add(parentId);
      }
    }
  }

  const sortedGenNums = [...rawGenMap.keys()].toSorted((a, b) => a - b);

  const topology: PrecomputedBranchTopology = {
    branchPeople,
    peopleById,
    parentMap,
    childMap,
    spouseMap,
    genByPersonId,
    directPersonIds,
    focalSpineIds,
    spinePartnerIds,
    earlyLossIds,
    pivotPersonId,
    resolvedAnchorId,
    rawGenBuckets: rawGenMap,
    sortedGenNums,
    fullModeData: null,
    spineModeData: null,
  };

  if (!byKinship) {
    byKinship = new WeakMap();
    topologyCache.set(people, byKinship);
  }
  let byFilter = byKinship.get(kinship);
  if (!byFilter) {
    byFilter = new Map();
    byKinship.set(kinship, byFilter);
  }
  byFilter.set(cacheKey, topology);
  return topology;
}

function getPreparedModeData(
  topo: PrecomputedBranchTopology,
  effectiveMode: TreeLineageMode
): PreparedModeData {
  if (effectiveMode === 'spine' && topo.spineModeData) {
    return topo.spineModeData;
  }
  if (effectiveMode === 'full' && topo.fullModeData) {
    return topo.fullModeData;
  }

  const modeDirectIds =
    topo.resolvedAnchorId !== null || effectiveMode === 'spine' ? topo.focalSpineIds : topo.directPersonIds;
  const unionDrafts = buildUnionDrafts({
    branchPeople: topo.branchPeople,
    genByPersonId: topo.genByPersonId,
    parentMap: topo.parentMap,
    spouseMap: topo.spouseMap,
    directPersonIds: modeDirectIds,
  });
  const marriageOrderByUnionId = computeMarriageOrderByUnionId(unionDrafts, topo.peopleById);

  const preparedUnions: PreparedModeUnion[] = [];
  for (const draft of unionDrafts.values()) {
    if (effectiveMode === 'spine') {
      const aFocal = topo.focalSpineIds.has(draft.aId);
      const bFocal = draft.bId !== null && topo.focalSpineIds.has(draft.bId);
      if (!aFocal && !bFocal) {
        continue;
      }
      const active =
        draft.bId !== null
          ? topo.spinePartnerIds.has(draft.aId) && topo.spinePartnerIds.has(draft.bId)
          : topo.spinePartnerIds.has(draft.aId);
      if (!active) {
        continue;
      }
    }

    const sortedChildren: Person[] = [];
    for (const childId of draft.childIds) {
      const c = topo.peopleById.get(childId);
      if (c !== undefined) {
        sortedChildren.push(c);
      }
    }
    if (sortedChildren.length > 1) {
      sortedChildren.sort(sortPeopleChronologically);
    }

    const allChildIds: string[] = [];
    const earlyLossChildIds: string[] = [];
    const survivingChildren: Person[] = [];
    for (const child of sortedChildren) {
      allChildIds.push(child.id);
      if (topo.earlyLossIds.has(child.id)) {
        earlyLossChildIds.push(child.id);
      } else {
        survivingChildren.push(child);
      }
    }

    let alwaysVisibleChildIds: string[];
    let collapsibleIds: string[];

    if (effectiveMode === 'spine') {
      alwaysVisibleChildIds = [];
      collapsibleIds = [];
      for (const child of survivingChildren) {
        const cid = child.id;
        if (topo.spinePartnerIds.has(cid)) {
          alwaysVisibleChildIds.push(cid);
        } else {
          collapsibleIds.push(cid);
        }
      }
    } else {
      const anchorOrBranching: string[] = [];
      const collateralLeaves: string[] = [];
      for (const child of survivingChildren) {
        const cid = child.id;
        const hasDescendants = (topo.childMap.get(cid)?.length ?? 0) > 0;
        const hasSpouse = (topo.spouseMap.get(cid)?.length ?? 0) > 0;
        const isDirect = modeDirectIds.has(cid);
        if (isDirect || hasDescendants || hasSpouse) {
          anchorOrBranching.push(cid);
        } else {
          collateralLeaves.push(cid);
        }
      }
      if (collateralLeaves.length >= COLLATERAL_COLLAPSE_THRESHOLD) {
        alwaysVisibleChildIds = anchorOrBranching;
        collapsibleIds = collateralLeaves;
      } else {
        alwaysVisibleChildIds = [...anchorOrBranching, ...collateralLeaves];
        collapsibleIds = [];
      }
    }

    const orderMeta = marriageOrderByUnionId.get(draft.id) ?? { order: 1, total: 1 };
    preparedUnions.push({
      draft,
      order: orderMeta.order,
      totalMarriagesForPrimary: orderMeta.total,
      partnerIds: draft.bId ? [draft.aId, draft.bId] : [draft.aId],
      baseDirect:
        topo.focalSpineIds.has(draft.aId) || (draft.bId !== null && topo.focalSpineIds.has(draft.bId)),
      allChildIds,
      earlyLossChildIds,
      alwaysVisibleChildIds,
      collapsibleIds,
    });
  }

  const sortedGenBuckets = topo.sortedGenNums.map((gen) => {
    const rawMembers = topo.rawGenBuckets.get(gen) ?? [];
    const modeFiltered =
      effectiveMode === 'spine' ? rawMembers.filter((p) => topo.spinePartnerIds.has(p.id)) : rawMembers;
    return {
      gen,
      members: sortGenerationMembers(modeFiltered, topo.spouseMap, modeDirectIds),
    };
  });

  const data: PreparedModeData = { preparedUnions, sortedGenBuckets };
  if (effectiveMode === 'spine') {
    topo.spineModeData = data;
  } else {
    topo.fullModeData = data;
  }
  return data;
}

export function buildArchivalTreeModel({
  people,
  kinship,
  branchFilter,
  defaultBranchId = 'primary',
  directModeBranchIds,
  mode,
  expandedUnionIds = new Set<string>(),
  anchorPersonId = null,
}: BuildArchivalTreeInput): ArchivalTreeModel {
  const topo = getPrecomputedBranchTopology(people, kinship, branchFilter, defaultBranchId, anchorPersonId);

  const supportsDirectForBranch =
    topo.resolvedAnchorId !== null ||
    !directModeBranchIds ||
    !branchFilter ||
    branchFilter === 'all' ||
    directModeBranchIds.includes(branchFilter);

  const effectiveMode: TreeLineageMode =
    mode === 'spine' && supportsDirectForBranch && topo.focalSpineIds.size > 0 ? 'spine' : 'full';

  const modeData = getPreparedModeData(topo, effectiveMode);
  const modeDirectIds =
    topo.resolvedAnchorId !== null || effectiveMode === 'spine' ? topo.focalSpineIds : topo.directPersonIds;
  const hasExpandedUnions = expandedUnionIds.size > 0;

  const unions: TreeUnion[] = [];
  const excludedFromRank = new Set<string>();

  for (const prep of modeData.preparedUnions) {
    const isExpanded = hasExpandedUnions && expandedUnionIds.has(prep.draft.id);
    const visibleChildIds = prep.alwaysVisibleChildIds;
    let hangingChildIds: string[] = [];
    let collapsedSiblingIds: string[] = [];

    if (prep.collapsibleIds.length > 0) {
      if (isExpanded) {
        hangingChildIds = prep.collapsibleIds;
      } else {
        collapsedSiblingIds = prep.collapsibleIds;
      }
      for (const cid of prep.collapsibleIds) {
        excludedFromRank.add(cid);
      }
    }

    let isDirectUnion = prep.baseDirect;
    if (!isDirectUnion) {
      for (const cid of visibleChildIds) {
        if (topo.focalSpineIds.has(cid)) {
          isDirectUnion = true;
          break;
        }
      }
    }

    unions.push({
      id: prep.draft.id,
      kind: prep.draft.kind,
      primaryPartnerId: prep.draft.aId,
      secondaryPartnerId: prep.draft.bId,
      partnerIds: prep.partnerIds,
      marriageOrder: prep.order,
      totalMarriagesForPrimary: prep.totalMarriagesForPrimary,
      gen: prep.draft.gen,
      isDirect: isDirectUnion,
      allChildIds: prep.allChildIds,
      visibleChildIds,
      hangingChildIds,
      collapsedSiblingIds,
      earlyLossChildIds: prep.earlyLossChildIds,
      isExpanded,
    });
  }

  const preSortedRankByGen = new Map<number, Person[]>();
  const rankPeople: Person[] = [];
  const rankPersonIdSet = new Set<string>();

  for (const bucket of modeData.sortedGenBuckets) {
    const filtered: Person[] = [];
    for (const p of bucket.members) {
      if (excludedFromRank.has(p.id)) {
        continue;
      }
      filtered.push(p);
      rankPeople.push(p);
      rankPersonIdSet.add(p.id);
    }
    if (filtered.length > 0) {
      preSortedRankByGen.set(bucket.gen, filtered);
    }
  }

  const activeUnions: TreeUnion[] = [];
  const activeUnionsById = new Map<string, TreeUnion>();
  for (const u of unions) {
    let allActive = true;
    for (const pid of u.partnerIds) {
      if (!rankPersonIdSet.has(pid)) {
        allActive = false;
        break;
      }
    }
    if (allActive) {
      activeUnions.push(u);
      activeUnionsById.set(u.id, u);
    }
  }

  const { generations, unitsById } = buildGenerationGroups({
    rankPeople,
    unions: activeUnions,
    genByPersonId: topo.genByPersonId,
    spouseMap: topo.spouseMap,
    directPersonIds: modeDirectIds,
    preSortedRankByGen,
  });

  return {
    mode,
    effectiveMode,
    peopleById: topo.peopleById,
    visiblePeople: topo.branchPeople,
    totalVisibleCount: topo.branchPeople.length,
    directSpineCount: topo.spinePartnerIds.size,
    generations,
    unions: activeUnions,
    unionsById: activeUnionsById,
    unitsById,
    genByPersonId: topo.genByPersonId,
    parentMap: topo.parentMap,
    childMap: topo.childMap,
    spouseMap: topo.spouseMap,
    earlyLossIds: topo.earlyLossIds,
    directPersonIds: modeDirectIds,
    pivotPersonId: topo.pivotPersonId,
    anchorPersonId: topo.resolvedAnchorId,
  };
}
