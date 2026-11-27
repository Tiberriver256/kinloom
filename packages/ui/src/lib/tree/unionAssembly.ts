import type { Person } from '@kinloom/core';
import {
  sortPeopleChronologically,
  type TreeFamilyUnit,
  type TreeGenerationGroup,
  type TreeUnion,
  type TreeUnionKind,
} from './types.js';

export interface UnionDraft {
  readonly id: string;
  readonly kind: TreeUnionKind;
  readonly aId: string;
  readonly bId: string | null;
  readonly gen: number;
  readonly childIds: string[];
}

export function pickUnionPairKey(aId: string, bId: string | null): string {
  if (bId === null) {
    return `single:${aId}`;
  }
  return aId < bId ? `couple:${aId}+${bId}` : `couple:${bId}+${aId}`;
}

export function buildUnionDrafts(params: {
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

export function computeMarriageOrderByUnionId(
  unionDrafts: ReadonlyMap<string, UnionDraft>,
  peopleById: ReadonlyMap<string, Person>
): Map<string, { order: number; total: number }> {
  const coupleCountByPerson = new Map<string, number>();
  for (const draft of unionDrafts.values()) {
    if (draft.kind !== 'couple') {
      continue;
    }
    coupleCountByPerson.set(draft.aId, (coupleCountByPerson.get(draft.aId) ?? 0) + 1);
    if (draft.bId) {
      coupleCountByPerson.set(draft.bId, (coupleCountByPerson.get(draft.bId) ?? 0) + 1);
    }
  }

  const coupleDraftsByAnchor = new Map<string, UnionDraft[]>();
  for (const draft of unionDrafts.values()) {
    if (draft.kind !== 'couple') {
      continue;
    }
    const countA = coupleCountByPerson.get(draft.aId) ?? 0;
    const countB = draft.bId ? (coupleCountByPerson.get(draft.bId) ?? 0) : 0;
    const anchorId = draft.bId && countB > countA ? draft.bId : draft.aId;
    const list = coupleDraftsByAnchor.get(anchorId) ?? [];
    list.push(draft);
    coupleDraftsByAnchor.set(anchorId, list);
  }
  const marriageOrderByUnionId = new Map<string, { order: number; total: number }>();
  for (const [anchorId, list] of coupleDraftsByAnchor.entries()) {
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
      const other1 = u1.aId === anchorId ? u1.bId : u1.aId;
      const other2 = u2.aId === anchorId ? u2.bId : u2.aId;
      const sp1 = other1 ? (peopleById.get(other1)?.birth_year ?? 9999) : 9999;
      const sp2 = other2 ? (peopleById.get(other2)?.birth_year ?? 9999) : 9999;
      return sp1 - sp2;
    });
    for (const [idx, draft] of list.entries()) {
      marriageOrderByUnionId.set(draft.id, { order: idx + 1, total: list.length });
    }
  }
  return marriageOrderByUnionId;
}

export function buildGenerationGroups(params: {
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

  // Only emit generation bands that contain at least one visible rank person.
  const allGenNums = [...rankByGen.keys()].toSorted((a, b) => a - b);

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
    if (genMembers.length === 0) {
      continue;
    }

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

    if (genUnits.length === 0) {
      continue;
    }

    const genMemberIds = new Set(genMembers.map((m) => m.id));
    const genUnions = unions.filter((u) => u.gen === g && u.partnerIds.every((pid) => genMemberIds.has(pid)));
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
