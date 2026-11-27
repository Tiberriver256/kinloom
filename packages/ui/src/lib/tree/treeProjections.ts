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
      const path = findKinshipPath({
        fromId: selectedPersonId,
        toId: model.pivotPersonId,
        bundle: { ...bundle, kinship: normalizedKinship },
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
  return value
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .trim();
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

export function isPersonVisibleOnCurrentSurface(personId: string, model: ArchivalTreeModel): boolean {
  if (!model.peopleById.has(personId)) {
    return false;
  }
  if (model.earlyLossIds.has(personId)) {
    return model.unions.some((u) => u.earlyLossChildIds.includes(personId));
  }
  for (const g of model.generations) {
    if (g.personIds.includes(personId)) {
      return true;
    }
  }
  for (const u of model.unions) {
    if (u.hangingChildIds.includes(personId)) {
      return true;
    }
  }
  return false;
}

export function findCollapsedUnionForPerson(personId: string, model: ArchivalTreeModel): TreeUnion | null {
  return model.unions.find((u) => u.collapsedSiblingIds.includes(personId)) ?? null;
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

  const collapsedIds = new Set<string>();
  for (const union of model.unions) {
    for (const cid of union.collapsedSiblingIds) {
      collapsedIds.add(cid);
    }
  }

  const scored: { candidate: TreeSearchCandidate; score: number }[] = [];

  for (const person of people) {
    if (!isTreeSearchEligible(person, buildMode)) {
      continue;
    }

    const personBranch = person.branch || defaultBranchId;
    const isOutsideCurrentBranch = branchFilter !== 'all' && personBranch !== branchFilter;
    const isCollapsed = collapsedIds.has(person.id);
    const inCurrentModel = model.peopleById.has(person.id);
    const isOutsideCurrentMode =
      !isOutsideCurrentBranch &&
      inCurrentModel &&
      !isCollapsed &&
      !isPersonVisibleOnCurrentSurface(person.id, model);

    const foldedFull = normalizeSearchFold(person.full_name);
    const foldedGiven = normalizeSearchFold(person.given_name);
    const foldedSurname = normalizeSearchFold(person.surname);
    const foldedAlts = person.alt_names.map(normalizeSearchFold);
    const yearStr = [
      person.birth_year !== null ? String(person.birth_year) : '',
      person.death_year !== null ? String(person.death_year) : '',
    ]
      .filter(Boolean)
      .join(' ');
    const haystack = [foldedFull, ...foldedAlts, yearStr].filter(Boolean).join(' ');

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
      if (!queryTokens.every((token) => haystack.includes(token))) {
        continue;
      }
      if (foldedFull === normalizedQuery) {
        score += 200;
      } else if (foldedFull.startsWith(normalizedQuery)) {
        score += 150;
      } else if (foldedGiven.startsWith(normalizedQuery) || foldedSurname.startsWith(normalizedQuery)) {
        score += 125;
      } else if (foldedFull.includes(normalizedQuery)) {
        score += 100;
      } else if (foldedAlts.some((alt) => alt.includes(normalizedQuery))) {
        score += 80;
      } else {
        score += 60;
      }
      if (model.directPersonIds.has(person.id)) {
        score += 10;
      }
    }

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
        lifespanLabel: formatCardLifespan(person),
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
