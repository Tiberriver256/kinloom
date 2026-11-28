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
    const spouses = spouseMap.get(p.id);
    if (!spouses) {
      continue;
    }
    for (const spId of spouses) {
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
          const spCountA = spouses.length;
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
    const pids = parentMap.get(child.id);
    if (!pids || pids.length === 0) {
      continue;
    }
    let targetKey: string | null = null;
    if (pids.length >= 2) {
      for (let i = 0; i < pids.length && !targetKey; i += 1) {
        const pi = pids[i];
        if (!pi) continue;
        for (let j = i + 1; j < pids.length && !targetKey; j += 1) {
          const pj = pids[j];
          if (!pj) continue;
          const candidate = pickUnionPairKey(pi, pj);
          if (unionDrafts.has(candidate)) {
            targetKey = candidate;
          }
        }
      }
      if (!targetKey) {
        const [p0, p1] = pids;
        if (p0 && p1) {
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
    }
    if (!targetKey) {
      let parentId = pids[0];
      for (const pid of pids) {
        if (directPersonIds.has(pid)) {
          parentId = pid;
          break;
        }
      }
      if (!parentId) continue;
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

function minChildBirthYear(cids: readonly string[], peopleById: ReadonlyMap<string, Person>): number {
  let min = 9999;
  for (const cid of cids) {
    const yr = peopleById.get(cid)?.birth_year;
    if (yr !== null && yr !== undefined && yr < min) {
      min = yr;
    }
  }
  return min;
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
    const list = coupleDraftsByAnchor.get(anchorId);
    if (list) {
      list.push(draft);
    } else {
      coupleDraftsByAnchor.set(anchorId, [draft]);
    }
  }
  const marriageOrderByUnionId = new Map<string, { order: number; total: number }>();
  for (const [anchorId, list] of coupleDraftsByAnchor.entries()) {
    if (list.length === 1) {
      const only = list[0];
      if (only) {
        marriageOrderByUnionId.set(only.id, { order: 1, total: 1 });
      }
      continue;
    }
    list.sort((u1, u2) => {
      const y1 = minChildBirthYear(u1.childIds, peopleById);
      const y2 = minChildBirthYear(u2.childIds, peopleById);
      if (y1 !== y2) {
        return y1 - y2;
      }
      const other1 = u1.aId === anchorId ? u1.bId : u1.aId;
      const other2 = u2.aId === anchorId ? u2.bId : u2.aId;
      const sp1 = other1 ? (peopleById.get(other1)?.birth_year ?? 9999) : 9999;
      const sp2 = other2 ? (peopleById.get(other2)?.birth_year ?? 9999) : 9999;
      return sp1 - sp2;
    });
    for (const [idx, item] of list.entries()) {
      marriageOrderByUnionId.set(item.id, { order: idx + 1, total: list.length });
    }
  }
  return marriageOrderByUnionId;
}

export function sortGenerationMembers(
  members: readonly Person[],
  spouseMap: ReadonlyMap<string, readonly string[]>,
  directPersonIds: ReadonlySet<string>
): Person[] {
  return members.toSorted((a, b) => {
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
}

export function buildGenerationGroups(params: {
  readonly rankPeople: readonly Person[];
  readonly unions: readonly TreeUnion[];
  readonly genByPersonId: ReadonlyMap<string, number>;
  readonly spouseMap: ReadonlyMap<string, readonly string[]>;
  readonly directPersonIds: ReadonlySet<string>;
  readonly preSortedRankByGen?: ReadonlyMap<number, readonly Person[]>;
}): {
  readonly generations: TreeGenerationGroup[];
  readonly unitsById: Map<string, TreeFamilyUnit>;
} {
  const { rankPeople, unions, genByPersonId, spouseMap, directPersonIds, preSortedRankByGen } = params;
  let rankByGen: ReadonlyMap<number, readonly Person[]>;

  if (preSortedRankByGen) {
    rankByGen = preSortedRankByGen;
  } else {
    const mutableRankByGen = new Map<number, Person[]>();
    for (const p of rankPeople) {
      const g = genByPersonId.get(p.id) ?? 0;
      const list = mutableRankByGen.get(g);
      if (list) {
        list.push(p);
      } else {
        mutableRankByGen.set(g, [p]);
      }
    }
    rankByGen = mutableRankByGen;
  }

  // Only emit generation bands that contain at least one visible rank person.
  const allGenNums = [...rankByGen.keys()].toSorted((a, b) => a - b);

  const unionsByGen = new Map<number, TreeUnion[]>();
  for (const u of unions) {
    const list = unionsByGen.get(u.gen);
    if (list) {
      list.push(u);
    } else {
      unionsByGen.set(u.gen, [u]);
    }
  }

  const unitsById = new Map<string, TreeFamilyUnit>();
  const generations: TreeGenerationGroup[] = [];

  for (const g of allGenNums) {
    const rawMembers = rankByGen.get(g) ?? [];
    const genMembers = preSortedRankByGen
      ? rawMembers
      : sortGenerationMembers(rawMembers, spouseMap, directPersonIds);
    if (genMembers.length === 0) {
      continue;
    }

    const genMemberIds = new Set<string>();
    const personIds: string[] = [];
    let minYear = Number.POSITIVE_INFINITY;
    let maxYear = Number.NEGATIVE_INFINITY;
    for (const m of genMembers) {
      genMemberIds.add(m.id);
      personIds.push(m.id);
      if (m.birth_year !== null) {
        if (m.birth_year < minYear) minYear = m.birth_year;
        if (m.birth_year > maxYear) maxYear = m.birth_year;
      }
    }

    const rawGenUnions = unionsByGen.get(g);
    const genUnions: TreeUnion[] = [];
    const coupleUnionsByPartner = new Map<string, TreeUnion[]>();
    const unionsByPrimaryPartner = new Map<string, TreeUnion[]>();

    if (rawGenUnions) {
      for (const u of rawGenUnions) {
        let allInGen = true;
        for (const pid of u.partnerIds) {
          if (!genMemberIds.has(pid)) {
            allInGen = false;
            break;
          }
        }
        if (allInGen) {
          genUnions.push(u);
        }
        const byPrimary = unionsByPrimaryPartner.get(u.primaryPartnerId);
        if (byPrimary) {
          byPrimary.push(u);
        } else {
          unionsByPrimaryPartner.set(u.primaryPartnerId, [u]);
        }
        if (u.kind === 'couple') {
          const listA = coupleUnionsByPartner.get(u.primaryPartnerId);
          if (listA) {
            listA.push(u);
          } else {
            coupleUnionsByPartner.set(u.primaryPartnerId, [u]);
          }
          if (u.secondaryPartnerId && u.secondaryPartnerId !== u.primaryPartnerId) {
            const listB = coupleUnionsByPartner.get(u.secondaryPartnerId);
            if (listB) {
              listB.push(u);
            } else {
              coupleUnionsByPartner.set(u.secondaryPartnerId, [u]);
            }
          }
        }
      }
    }

    const placedInUnit = new Set<string>();
    const genUnits: TreeFamilyUnit[] = [];

    for (const anchor of genMembers) {
      if (placedInUnit.has(anchor.id)) {
        continue;
      }
      const rawAnchorCouples = coupleUnionsByPartner.get(anchor.id);
      const anchorCoupleUnions =
        rawAnchorCouples && rawAnchorCouples.length > 1
          ? rawAnchorCouples.toSorted((u1, u2) => u1.marriageOrder - u2.marriageOrder)
          : (rawAnchorCouples ?? []);

      const availableSpouseIds: string[] = [];
      for (const u of anchorCoupleUnions) {
        const otherId = u.primaryPartnerId === anchor.id ? u.secondaryPartnerId : u.primaryPartnerId;
        if (otherId && !placedInUnit.has(otherId) && genMemberIds.has(otherId)) {
          availableSpouseIds.push(otherId);
        }
      }

      placedInUnit.add(anchor.id);
      for (const spId of availableSpouseIds) {
        placedInUnit.add(spId);
      }

      let orderedMemberIds: string[];
      const [firstSpouse, secondSpouse] = availableSpouseIds;
      if (availableSpouseIds.length === 2 && firstSpouse && secondSpouse) {
        orderedMemberIds = [firstSpouse, anchor.id, secondSpouse];
      } else if (availableSpouseIds.length === 0) {
        orderedMemberIds = [anchor.id];
      } else if (availableSpouseIds.length === 1 && firstSpouse) {
        orderedMemberIds = [anchor.id, firstSpouse];
      } else {
        orderedMemberIds = [anchor.id, ...availableSpouseIds];
      }

      let unitUnionIds: string[];
      if (orderedMemberIds.length === 1) {
        const singleCandidates = unionsByPrimaryPartner.get(anchor.id);
        if (!singleCandidates) {
          unitUnionIds = [];
        } else {
          const matched: TreeUnion[] = [];
          for (const u of singleCandidates) {
            if (u.partnerIds.length === 1 && u.partnerIds[0] === anchor.id) {
              matched.push(u);
            }
          }
          if (matched.length > 1) {
            matched.sort((u1, u2) => u1.marriageOrder - u2.marriageOrder);
          }
          unitUnionIds = matched.map((u) => u.id);
        }
      } else {
        const memberSet = new Set(orderedMemberIds);
        const matched: TreeUnion[] = [];
        const seenUnionIds = new Set<string>();
        for (const memberId of orderedMemberIds) {
          const candidates = unionsByPrimaryPartner.get(memberId);
          if (!candidates) {
            continue;
          }
          for (const u of candidates) {
            if (seenUnionIds.has(u.id)) {
              continue;
            }
            if (u.partnerIds.every((pid) => memberSet.has(pid))) {
              seenUnionIds.add(u.id);
              matched.push(u);
            }
          }
        }
        if (matched.length > 1) {
          matched.sort((u1, u2) => u1.marriageOrder - u2.marriageOrder);
        }
        unitUnionIds = matched.map((u) => u.id);
      }

      let isDirect = false;
      for (const memberId of orderedMemberIds) {
        if (directPersonIds.has(memberId)) {
          isDirect = true;
          break;
        }
      }

      const unitId = orderedMemberIds.join('+');

      const unit: TreeFamilyUnit = {
        id: unitId,
        gen: g,
        anchorId: anchor.id,
        orderedMemberIds,
        unionIds: unitUnionIds,
        isDirect,
      };
      genUnits.push(unit);
      unitsById.set(unitId, unit);
    }

    if (genUnits.length === 0) {
      continue;
    }

    const yearRange = minYear <= maxYear ? `${minYear}–${maxYear}` : `Gen ${g + 1}`;

    generations.push({
      gen: g,
      label: `G${g + 1}`,
      yearRange,
      units: genUnits,
      unions: genUnions,
      personIds,
    });
  }

  return { generations, unitsById };
}
