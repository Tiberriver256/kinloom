import type { ArchiveBundle, KinshipEdge, Person, Place } from '@kinloom/core';
import { findKinshipPath } from '@kinloom/core';
import {
  type ArchivalTreeModel,
  formatCardLifespan,
  isDirectSpinePerson,
  isRedactedLivingPlaceholder,
  type LineageSpotlight,
  sortPeopleChronologically,
  type TreeFocusPlan,
  type TreeLineageMode,
  type TreeSearchCandidate,
  type TreeUnion,
} from './types.js';

const normalizedBundleCache = new WeakMap<ArchiveBundle, ArchiveBundle>();

function getNormalizedKinshipBundle(bundle: ArchiveBundle): ArchiveBundle {
  let cached = normalizedBundleCache.get(bundle);
  if (!cached) {
    const normalizedKinship: KinshipEdge[] = [...bundle.kinship];
    for (const edge of bundle.kinship) {
      if (edge.relation === 'parent') {
        normalizedKinship.push({ from: edge.to, to: edge.from, relation: 'child' });
      } else if (edge.relation === 'child') {
        normalizedKinship.push({ from: edge.to, to: edge.from, relation: 'parent' });
      } else if (edge.relation === 'spouse') {
        normalizedKinship.push({ from: edge.to, to: edge.from, relation: 'spouse' });
      }
    }
    cached = { ...bundle, kinship: normalizedKinship };
    normalizedBundleCache.set(bundle, cached);
  }
  return cached;
}

export function computeLineageSpotlight(params: {
  readonly selectedPersonId: string;
  readonly model: ArchivalTreeModel;
  readonly bundle?: ArchiveBundle | null;
  readonly placesById?: ReadonlyMap<string, Place>;
}): LineageSpotlight | null {
  const { selectedPersonId, model, bundle, placesById } = params;
  const selected = model.peopleById.get(selectedPersonId);
  if (!selected) {
    return null;
  }

  const ancestorIds = new Set<string>();
  const walkUp = (id: string): void => {
    for (const pid of model.parentMap.get(id) ?? []) {
      if (!ancestorIds.has(pid)) {
        ancestorIds.add(pid);
        walkUp(pid);
      }
    }
  };
  walkUp(selectedPersonId);

  const descendantIds = new Set<string>();
  const walkDown = (id: string): void => {
    for (const cid of model.childMap.get(id) ?? []) {
      if (!descendantIds.has(cid)) {
        descendantIds.add(cid);
        walkDown(cid);
      }
    }
  };
  walkDown(selectedPersonId);

  const immediateParentIds = new Set<string>(model.parentMap.get(selectedPersonId) ?? []);
  const immediateSpouseIds = new Set<string>(model.spouseMap.get(selectedPersonId) ?? []);
  const immediateChildIds = new Set<string>(model.childMap.get(selectedPersonId) ?? []);

  const highlightedPersonIds = new Set<string>([
    selectedPersonId,
    ...ancestorIds,
    ...descendantIds,
    ...immediateSpouseIds,
    ...immediateChildIds,
  ]);

  // Include co-parents of immediate children so the nuclear family stays intact.
  for (const cid of immediateChildIds) {
    for (const pid of model.parentMap.get(cid) ?? []) {
      highlightedPersonIds.add(pid);
    }
  }

  const highlightedUnionIds = new Set<string>();
  for (const union of model.unions) {
    const partnerSelected = union.partnerIds.includes(selectedPersonId);
    const connectsHighlightedParentToChild =
      union.partnerIds.some((pid) => highlightedPersonIds.has(pid)) &&
      union.allChildIds.some((cid) => highlightedPersonIds.has(cid));
    if (partnerSelected || connectsHighlightedParentToChild) {
      highlightedUnionIds.add(union.id);
    }
  }

  const breadcrumb: Person[] = [];
  const seenTrail = new Set<string>();
  let cursor: Person | undefined = selected;
  while (cursor && !seenTrail.has(cursor.id)) {
    seenTrail.add(cursor.id);
    breadcrumb.unshift(cursor);
    const parentIds = model.parentMap.get(cursor.id) ?? [];
    if (parentIds.length === 0) {
      break;
    }
    const preferredParentId = parentIds.find((pid) => model.directPersonIds.has(pid)) ?? parentIds[0];
    cursor = model.peopleById.get(preferredParentId);
  }

  let relationshipToPivot: string | null = null;
  let pivotName: string | null = null;
  if (bundle && placesById && model.pivotPersonId && model.pivotPersonId !== selectedPersonId) {
    const pivot = model.peopleById.get(model.pivotPersonId);
    if (pivot) {
      const path = findKinshipPath({
        fromId: selectedPersonId,
        toId: model.pivotPersonId,
        bundle: getNormalizedKinshipBundle(bundle),
        placesById,
      });
      if (path.connected) {
        relationshipToPivot = path.relationshipLabel;
        pivotName = pivot.full_name;
      }
    }
  }

  return {
    selectedPersonId,
    highlightedPersonIds,
    ancestorIds,
    descendantIds,
    immediateSpouseIds,
    immediateChildIds,
    immediateParentIds,
    highlightedUnionIds,
    breadcrumb,
    relationshipToPivot,
    pivotName,
  };
}

function normalizeSearchFold(value: string): string {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) >= 0x80) {
      return value
        .normalize('NFKD')
        .replace(/[\u0300-\u036F]/g, '')
        .toLowerCase()
        .trim();
    }
  }
  return value.toLowerCase().trim();
}

export function isTreeSearchEligible(
  person: Pick<Person, 'is_living' | 'full_name'>,
  buildMode: 'public' | 'private' = 'public'
): boolean {
  const foldedName = person.full_name.trim().toLowerCase();
  if (!foldedName || foldedName === 'living') {
    return false;
  }
  if (isRedactedLivingPlaceholder(person)) {
    return false;
  }
  if (person.is_living && buildMode !== 'private') {
    return false;
  }
  return true;
}

interface ModelSurfaceIndex {
  readonly visibleIds: ReadonlySet<string>;
  readonly collapsedUnionByPersonId: ReadonlyMap<string, TreeUnion>;
}

const modelSurfaceIndexCache = new WeakMap<ArchivalTreeModel, ModelSurfaceIndex>();

function getModelSurfaceIndex(model: ArchivalTreeModel): ModelSurfaceIndex {
  let cached = modelSurfaceIndexCache.get(model);
  if (!cached) {
    const visibleIds = new Set<string>();
    const collapsedUnionByPersonId = new Map<string, TreeUnion>();
    for (const g of model.generations) {
      for (let i = 0; i < g.personIds.length; i += 1) {
        const pid = g.personIds[i];
        if (!model.earlyLossIds.has(pid)) {
          visibleIds.add(pid);
        }
      }
    }
    for (const u of model.unions) {
      for (let i = 0; i < u.hangingChildIds.length; i += 1) {
        const pid = u.hangingChildIds[i];
        if (!model.earlyLossIds.has(pid)) {
          visibleIds.add(pid);
        }
      }
      for (let i = 0; i < u.earlyLossChildIds.length; i += 1) {
        const pid = u.earlyLossChildIds[i];
        if (model.earlyLossIds.has(pid)) {
          visibleIds.add(pid);
        }
      }
      for (let i = 0; i < u.collapsedSiblingIds.length; i += 1) {
        const pid = u.collapsedSiblingIds[i];
        if (!collapsedUnionByPersonId.has(pid)) {
          collapsedUnionByPersonId.set(pid, u);
        }
      }
    }
    cached = { visibleIds, collapsedUnionByPersonId };
    modelSurfaceIndexCache.set(model, cached);
  }
  return cached;
}

export function isPersonVisibleOnCurrentSurface(personId: string, model: ArchivalTreeModel): boolean {
  if (!model.peopleById.has(personId)) {
    return false;
  }
  return getModelSurfaceIndex(model).visibleIds.has(personId);
}

export function findCollapsedUnionForPerson(personId: string, model: ArchivalTreeModel): TreeUnion | null {
  return getModelSurfaceIndex(model).collapsedUnionByPersonId.get(personId) ?? null;
}

export function resolveTreeFocusPlan(params: {
  readonly person: Person;
  readonly model: ArchivalTreeModel;
  readonly currentBranchFilter: string;
  readonly defaultBranchId: string;
  readonly currentMode: TreeLineageMode;
}): TreeFocusPlan {
  const { person, model, currentBranchFilter, defaultBranchId, currentMode } = params;
  const personBranch = person.branch || defaultBranchId;
  const needsBranchReset = currentBranchFilter !== 'all' && personBranch !== currentBranchFilter;
  const nextBranchFilter = needsBranchReset ? 'all' : currentBranchFilter;

  const collapsedUnion = findCollapsedUnionForPerson(person.id, model);
  if (!needsBranchReset && collapsedUnion) {
    return {
      nextBranchFilter,
      nextMode: currentMode,
      expandUnionIds: [collapsedUnion.id],
    };
  }

  const alreadyVisible = !needsBranchReset && isPersonVisibleOnCurrentSurface(person.id, model);
  if (alreadyVisible) {
    return {
      nextBranchFilter,
      nextMode: currentMode,
      expandUnionIds: [],
    };
  }

  const needsFullMode = currentMode === 'spine' && (!isDirectSpinePerson(person) || !alreadyVisible);
  return {
    nextBranchFilter,
    nextMode: needsFullMode ? 'full' : currentMode,
    expandUnionIds: collapsedUnion ? [collapsedUnion.id] : [],
  };
}

interface CachedPersonSearchEntry {
  readonly eligiblePublic: boolean;
  readonly eligiblePrivate: boolean;
  readonly foldedFull: string;
  readonly foldedGiven: string;
  readonly foldedSurname: string;
  readonly foldedAlts: readonly string[];
  readonly haystack: string;
  readonly lifespanLabel: string;
}

const personSearchIndexCache = new WeakMap<Person, CachedPersonSearchEntry>();

function getPersonSearchEntry(person: Person): CachedPersonSearchEntry {
  let cached = personSearchIndexCache.get(person);
  if (!cached) {
    const eligiblePrivate = isTreeSearchEligible(person, 'private');
    const eligiblePublic = eligiblePrivate && !person.is_living;
    const foldedFull = normalizeSearchFold(person.full_name);
    const foldedGiven = normalizeSearchFold(person.given_name);
    const foldedSurname = normalizeSearchFold(person.surname);
    const foldedAlts = person.alt_names.length > 0 ? person.alt_names.map(normalizeSearchFold) : [];
    const parts: string[] = [];
    if (foldedFull) {
      parts.push(foldedFull);
    }
    for (let i = 0; i < foldedAlts.length; i += 1) {
      if (foldedAlts[i]) {
        parts.push(foldedAlts[i]);
      }
    }
    if (person.birth_year !== null) {
      parts.push(String(person.birth_year));
    }
    if (person.death_year !== null) {
      parts.push(String(person.death_year));
    }
    cached = {
      eligiblePublic,
      eligiblePrivate,
      foldedFull,
      foldedGiven,
      foldedSurname,
      foldedAlts,
      haystack: parts.join(' '),
      lifespanLabel: formatCardLifespan(person),
    };
    personSearchIndexCache.set(person, cached);
  }
  return cached;
}

export function searchTreePeople(params: {
  readonly query: string;
  readonly people: readonly Person[];
  readonly buildMode: 'public' | 'private';
  readonly model: ArchivalTreeModel;
  readonly branchFilter: string;
  readonly defaultBranchId: string;
  readonly branchLabelsById: ReadonlyMap<string, string>;
  readonly limit?: number;
}): TreeSearchCandidate[] {
  const {
    query,
    people,
    buildMode,
    model,
    branchFilter,
    defaultBranchId,
    branchLabelsById,
    limit = 10,
  } = params;

  const normalizedQuery = normalizeSearchFold(query);
  const queryTokens = normalizedQuery.length > 0 ? normalizedQuery.split(/\s+/).filter(Boolean) : [];
  const surfaceIndex = getModelSurfaceIndex(model);
  const isPrivateMode = buildMode === 'private';

  const scored: { candidate: TreeSearchCandidate; score: number }[] = [];

  for (let pIdx = 0; pIdx < people.length; pIdx += 1) {
    const person = people[pIdx];
    const entry = getPersonSearchEntry(person);
    if (!(isPrivateMode ? entry.eligiblePrivate : entry.eligiblePublic)) {
      continue;
    }

    let score = 0;
    if (queryTokens.length === 0) {
      if (person.id === model.pivotPersonId) {
        score += 120;
      } else if (person.lineage_group === 'pivot_ancestor') {
        score += 110;
      } else if (model.directPersonIds.has(person.id)) {
        score += 70;
      } else {
        score += 30;
      }
      score += Math.min(25, person.event_count);
    } else {
      let allMatched = true;
      for (let t = 0; t < queryTokens.length; t += 1) {
        if (!entry.haystack.includes(queryTokens[t])) {
          allMatched = false;
          break;
        }
      }
      if (!allMatched) {
        continue;
      }
      if (entry.foldedFull === normalizedQuery) {
        score += 200;
      } else if (entry.foldedFull.startsWith(normalizedQuery)) {
        score += 150;
      } else if (
        entry.foldedGiven.startsWith(normalizedQuery) ||
        entry.foldedSurname.startsWith(normalizedQuery)
      ) {
        score += 125;
      } else if (entry.foldedFull.includes(normalizedQuery)) {
        score += 100;
      } else {
        let matchedAlt = false;
        for (let a = 0; a < entry.foldedAlts.length; a += 1) {
          if (entry.foldedAlts[a].includes(normalizedQuery)) {
            matchedAlt = true;
            break;
          }
        }
        score += matchedAlt ? 80 : 60;
      }
      if (model.directPersonIds.has(person.id)) {
        score += 10;
      }
    }

    const personBranch = person.branch || defaultBranchId;
    const isOutsideCurrentBranch = branchFilter !== 'all' && personBranch !== branchFilter;
    const isCollapsed = surfaceIndex.collapsedUnionByPersonId.has(person.id);
    const inCurrentModel = model.peopleById.has(person.id);
    const isOutsideCurrentMode =
      !isOutsideCurrentBranch && inCurrentModel && !isCollapsed && !surfaceIndex.visibleIds.has(person.id);

    if (!isOutsideCurrentBranch) {
      score += 12;
    }
    if (!isOutsideCurrentMode) {
      score += 4;
    }

    const genIdx = model.genByPersonId.get(person.id);
    scored.push({
      score,
      candidate: {
        person,
        lifespanLabel: entry.lifespanLabel,
        branchId: personBranch,
        branchLabel: branchLabelsById.get(personBranch) ?? null,
        genLabel: genIdx !== undefined ? `G${genIdx + 1}` : null,
        isCollapsed,
        isOutsideCurrentMode,
        isOutsideCurrentBranch,
      },
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return sortPeopleChronologically(a.candidate.person, b.candidate.person);
  });

  return scored.slice(0, limit).map((item) => item.candidate);
}
