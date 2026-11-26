import type { ArchiveBundle, KinshipEdge, Person, Place } from '@kinloom/core';
import { findKinshipPath } from '@kinloom/core';

export type TreeLineageMode = 'spine' | 'full';
export type TreeViewSurface = 'roll' | 'diagram';
export type SemanticZoomLevel = 'overview' | 'compact' | 'detail';
export type TreeUnionKind = 'couple' | 'single_parent';

export const ARCHIVAL_NODE_W = 172;
export const ARCHIVAL_NODE_H = 52;
export const ARCHIVAL_SPOUSE_GAP = 34;
export const ARCHIVAL_UNIT_GAP = 34;
export const ARCHIVAL_GEN_MIN_GAP = 72;
export const ARCHIVAL_HANGING_COL_GAP = 28;
export const ARCHIVAL_HANGING_ROW_GAP = 14;
export const ARCHIVAL_EARLY_CHIP_H = 30;
export const ARCHIVAL_EARLY_STRIP_GAP = 10;
export const COLLATERAL_COLLAPSE_THRESHOLD = 4;
export const EARLY_LOSS_MAX_AGE = 5;
export const MOBILE_TREE_BREAKPOINT_PX = 768;

export interface TreeUnion {
  readonly id: string;
  readonly kind: TreeUnionKind;
  readonly primaryPartnerId: string;
  readonly secondaryPartnerId: string | null;
  readonly partnerIds: readonly string[];
  readonly marriageOrder: number;
  readonly totalMarriagesForPrimary: number;
  readonly gen: number;
  readonly isDirect: boolean;
  readonly allChildIds: readonly string[];
  readonly visibleChildIds: readonly string[];
  readonly hangingChildIds: readonly string[];
  readonly collapsedSiblingIds: readonly string[];
  readonly earlyLossChildIds: readonly string[];
  readonly isExpanded: boolean;
}

export interface TreeFamilyUnit {
  readonly id: string;
  readonly gen: number;
  readonly anchorId: string;
  /** Partners placed left-to-right; for two marriages the anchor sits in the center. */
  readonly orderedMemberIds: readonly string[];
  readonly unionIds: readonly string[];
  readonly isDirect: boolean;
}

export interface TreeGenerationGroup {
  readonly gen: number;
  readonly label: string;
  readonly yearRange: string;
  readonly units: readonly TreeFamilyUnit[];
  readonly unions: readonly TreeUnion[];
  readonly personIds: readonly string[];
}

export interface ArchivalTreeModel {
  readonly mode: TreeLineageMode;
  readonly effectiveMode: TreeLineageMode;
  readonly peopleById: ReadonlyMap<string, Person>;
  readonly visiblePeople: readonly Person[];
  readonly totalVisibleCount: number;
  readonly directSpineCount: number;
  readonly generations: readonly TreeGenerationGroup[];
  readonly unions: readonly TreeUnion[];
  readonly unionsById: ReadonlyMap<string, TreeUnion>;
  readonly unitsById: ReadonlyMap<string, TreeFamilyUnit>;
  readonly genByPersonId: ReadonlyMap<string, number>;
  readonly parentMap: ReadonlyMap<string, readonly string[]>;
  readonly childMap: ReadonlyMap<string, readonly string[]>;
  readonly spouseMap: ReadonlyMap<string, readonly string[]>;
  readonly earlyLossIds: ReadonlySet<string>;
  readonly directPersonIds: ReadonlySet<string>;
  readonly pivotPersonId: string | null;
}

export interface DiagramPlacedNode {
  readonly person: Person;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly gen: number;
  readonly isDirect: boolean;
  readonly placement: 'rank' | 'hanging';
  readonly unionId: string | null;
}

export interface DiagramUnionHub {
  readonly union: TreeUnion;
  readonly x: number;
  readonly y: number;
  readonly leftPartnerId: string | null;
  readonly rightPartnerId: string | null;
  readonly connectorY: number;
  readonly leftX: number;
  readonly rightX: number;
}

export interface DiagramOrthogonalBus {
  readonly unionId: string;
  readonly parentIds: readonly string[];
  readonly childIds: readonly string[];
  readonly isDirect: boolean;
  readonly hubX: number;
  readonly hubY: number;
  readonly busY: number;
  readonly railMinX: number;
  readonly railMaxX: number;
  readonly childDrops: readonly {
    readonly childId: string;
    readonly x: number;
    readonly toY: number;
    readonly isDirect: boolean;
  }[];
}

export interface DiagramHangingGridRail {
  readonly unionId: string;
  readonly parentIds: readonly string[];
  readonly childIds: readonly string[];
  readonly spineX: number;
  readonly topY: number;
  readonly bottomY: number;
  readonly ticks: readonly {
    readonly childId: string;
    readonly y: number;
    readonly side: 'left' | 'right';
    readonly toX: number;
  }[];
}

export interface DiagramSiblingToggle {
  readonly unionId: string;
  readonly parentIds: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly stemFromX: number;
  readonly stemFromY: number;
  readonly hiddenCount: number;
  readonly totalCollateralCount: number;
  readonly isExpanded: boolean;
  readonly isDirect: boolean;
}

export interface DiagramEarlyLossChip {
  readonly person: Person;
  readonly unionId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DiagramEarlyLossStrip {
  readonly unionId: string;
  readonly parentIds: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly stemFromX: number;
  readonly stemFromY: number;
  readonly chips: readonly DiagramEarlyLossChip[];
}

export interface DiagramGenBand {
  readonly gen: number;
  readonly y: number;
  readonly height: number;
  readonly label: string;
  readonly yearRange: string;
}

export interface DiagramBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface ArchivalDiagramLayout {
  readonly nodes: readonly DiagramPlacedNode[];
  readonly byId: ReadonlyMap<string, DiagramPlacedNode>;
  readonly hubs: readonly DiagramUnionHub[];
  readonly buses: readonly DiagramOrthogonalBus[];
  readonly hangingRails: readonly DiagramHangingGridRail[];
  readonly siblingToggles: readonly DiagramSiblingToggle[];
  readonly earlyLossStrips: readonly DiagramEarlyLossStrip[];
  readonly genBands: readonly DiagramGenBand[];
  readonly bounds: DiagramBounds;
}

export interface LineageSpotlight {
  readonly selectedPersonId: string;
  readonly highlightedPersonIds: ReadonlySet<string>;
  readonly ancestorIds: ReadonlySet<string>;
  readonly descendantIds: ReadonlySet<string>;
  readonly immediateSpouseIds: ReadonlySet<string>;
  readonly immediateChildIds: ReadonlySet<string>;
  readonly immediateParentIds: ReadonlySet<string>;
  readonly highlightedUnionIds: ReadonlySet<string>;
  readonly breadcrumb: readonly Person[];
  readonly relationshipToPivot: string | null;
  readonly pivotName: string | null;
}

export interface TreeSearchCandidate {
  readonly person: Person;
  readonly lifespanLabel: string;
  readonly branchId: string;
  readonly branchLabel: string | null;
  readonly genLabel: string | null;
  readonly isCollapsed: boolean;
  readonly isOutsideCurrentMode: boolean;
  readonly isOutsideCurrentBranch: boolean;
}

export interface TreeFocusPlan {
  readonly nextBranchFilter: string;
  readonly nextMode: TreeLineageMode;
  readonly expandUnionIds: readonly string[];
}

export interface BuildArchivalTreeInput {
  readonly people: readonly Person[];
  readonly kinship: readonly KinshipEdge[];
  readonly branchFilter?: string | null;
  readonly defaultBranchId?: string;
  readonly directModeBranchIds?: readonly string[];
  readonly mode: TreeLineageMode;
  readonly expandedUnionIds?: ReadonlySet<string>;
}

const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI'] as const;

export function toRomanNumeral(order: number): string {
  if (order >= 1 && order <= ROMAN_NUMERALS.length) {
    return ROMAN_NUMERALS[order - 1];
  }
  return String(order);
}

export function isRedactedLivingPlaceholder(person: Pick<Person, 'is_living' | 'full_name'>): boolean {
  return person.is_living && person.full_name.trim() === 'Living';
}

export function isDirectSpinePerson(person: Pick<Person, 'lineage_group'>): boolean {
  return (
    person.lineage_group === 'ancestor' ||
    person.lineage_group === 'pivot_ancestor' ||
    person.lineage_group === 'descendant'
  );
}

export function resolveSemanticZoomLevel(zoom: number): SemanticZoomLevel {
  if (zoom < 0.48) {
    return 'overview';
  }
  if (zoom < 0.72) {
    return 'compact';
  }
  return 'detail';
}

export function resolveInitialTreePreferences(viewportWidth: number): {
  readonly surface: TreeViewSurface;
  readonly mode: TreeLineageMode;
} {
  if (viewportWidth < MOBILE_TREE_BREAKPOINT_PX) {
    return { surface: 'roll', mode: 'spine' };
  }
  return { surface: 'diagram', mode: 'full' };
}

export function formatCardLifespan(person: Pick<Person, 'birth_year' | 'death_year' | 'is_living'>): string {
  if (person.is_living) {
    return person.birth_year !== null ? `b. ${person.birth_year} · Living` : 'Living';
  }
  if (person.birth_year === null && person.death_year === null) {
    return 'Dates unrecorded';
  }
  const birth = person.birth_year !== null ? String(person.birth_year) : '?';
  const death = person.death_year !== null ? String(person.death_year) : '?';
  return `${birth}–${death}`;
}

export function formatEarlyLossAgeLabel(person: Pick<Person, 'birth_year' | 'death_year'>): string {
  if (person.birth_year === null || person.death_year === null) {
    return '';
  }
  const years = person.death_year - person.birth_year;
  if (years <= 0) {
    return String(person.birth_year);
  }
  return `${person.birth_year}–${person.death_year}`;
}

export function isEarlyChildhoodLoss(
  person: Person,
  parentMap: ReadonlyMap<string, readonly string[]>,
  childMap: ReadonlyMap<string, readonly string[]>,
  spouseMap: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (person.is_living || person.full_name.trim() === 'Living') {
    return false;
  }
  if (person.lineage_group === 'pivot_ancestor') {
    return false;
  }
  if (person.birth_year === null || person.death_year === null) {
    return false;
  }
  const lifespan = person.death_year - person.birth_year;
  if (lifespan < 0 || lifespan > EARLY_LOSS_MAX_AGE) {
    return false;
  }
  if ((parentMap.get(person.id)?.length ?? 0) === 0) {
    return false;
  }
  if ((childMap.get(person.id)?.length ?? 0) > 0) {
    return false;
  }
  if ((spouseMap.get(person.id)?.length ?? 0) > 0) {
    return false;
  }
  return true;
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

function sortPeopleChronologically(a: Person, b: Person): number {
  const ya = a.birth_year ?? 9999;
  const yb = b.birth_year ?? 9999;
  if (ya !== yb) {
    return ya - yb;
  }
  return a.full_name.localeCompare(b.full_name);
}

function pickUnionPairKey(aId: string, bId: string | null): string {
  if (bId === null) {
    return `single:${aId}`;
  }
  return aId < bId ? `couple:${aId}+${bId}` : `couple:${bId}+${aId}`;
}

function inferGenerations(
  people: readonly Person[],
  kinship: readonly KinshipEdge[],
  parentMap: ReadonlyMap<string, readonly string[]>,
  childMap: ReadonlyMap<string, readonly string[]>,
  spouseMap: ReadonlyMap<string, readonly string[]>,
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

  // Place isolated individuals (e.g., marrying-in spouses whose link is hidden by privacy) by birth cohort
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

  // Normalize generation indices so they start cleanly at 0 with no negative gaps
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

  // Also include spouses of direct-spine people as spine partners
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

  // Pick pivot ancestor (or first direct descendant/ancestor) for relationship callouts
  const pivotPersonId =
    branchPeople.find((p) => p.lineage_group === 'pivot_ancestor')?.id ??
    branchPeople.find((p) => p.lineage_group === 'ancestor')?.id ??
    branchPeople[0]?.id ??
    null;

  // Build canonical parent-union map across ALL branch children first
  const unionDrafts = new Map<
    string,
    {
      id: string;
      kind: TreeUnionKind;
      aId: string;
      bId: string | null;
      gen: number;
      childIds: string[];
    }
  >();

  // 1. Register every documented same-generation spouse pair as a couple union
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

  // 2. Attach every child to their parent couple union or single-parent union
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

  // Sort marriage order per primary anchor chronologically by earliest child or spouse birth year
  const coupleDraftsByPrimary = new Map<string, (typeof unionDrafts extends Map<string, infer V> ? V : never)[]>();
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

  // Determine which unions and people are active in the chosen mode
  const isUnionActiveInMode = (draft: { aId: string; bId: string | null; childIds: string[] }): boolean => {
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

  // Determine active people placed on main generation ranks (excluding early-loss chips, collapsed siblings, and hanging grid children)
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

  // Group rank people into multi-marriage Family Units per generation
  const rankByGen = new Map<number, Person[]>();
  for (const p of rankPeople) {
    const g = genByPersonId.get(p.id) ?? 0;
    const list = rankByGen.get(g) ?? [];
    list.push(p);
    rankByGen.set(g, list);
  }

  const allGenNums = [
    ...new Set([
      ...rankByGen.keys(),
      ...unions.map((u) => u.gen),
    ]),
  ].toSorted((a, b) => a - b);

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
      // Find all same-generation couple unions belonging to this anchor
      const anchorCoupleUnions = unions
        .filter(
          (u) =>
            u.kind === 'couple' &&
            u.gen === g &&
            (u.primaryPartnerId === anchor.id || u.secondaryPartnerId === anchor.id),
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
        // Place anchor in center so Marriage I drops left and Marriage II drops right with zero crossings
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

export function computeArchivalDiagramLayout(model: ArchivalTreeModel): ArchivalDiagramLayout {
  if (model.generations.length === 0) {
    return {
      nodes: [],
      byId: new Map(),
      hubs: [],
      buses: [],
      hangingRails: [],
      siblingToggles: [],
      earlyLossStrips: [],
      genBands: [],
      bounds: { minX: 0, maxX: 960, minY: 0, maxY: 600 },
    };
  }

  // Mutable working order of units per generation for barycenter crossing minimization
  const orderedUnitsByGen = new Map<number, TreeFamilyUnit[]>();
  const personToUnit = new Map<string, TreeFamilyUnit>();
  for (const g of model.generations) {
    orderedUnitsByGen.set(g.gen, [...g.units]);
    for (const u of g.units) {
      for (const pid of u.orderedMemberIds) {
        personToUnit.set(pid, u);
      }
    }
  }

  const unitIndex = new Map<string, number>();
  const refreshIndices = (genNum: number): void => {
    for (const [idx, u] of (orderedUnitsByGen.get(genNum) ?? []).entries()) {
      unitIndex.set(u.id, idx);
    }
  };
  for (const g of model.generations) {
    refreshIndices(g.gen);
  }

  const genNums = model.generations.map((g) => g.gen);
  for (let sweep = 0; sweep < 4; sweep += 1) {
    for (let i = 1; i < genNums.length; i += 1) {
      const g = genNums[i];
      const units = orderedUnitsByGen.get(g) ?? [];
      const baryMap = new Map<string, number>();
      for (const u of units) {
        const indices: number[] = [];
        for (const pid of u.orderedMemberIds) {
          for (const parentId of model.parentMap.get(pid) ?? []) {
            const pu = personToUnit.get(parentId);
            if (pu) {
              indices.push(unitIndex.get(pu.id) ?? 0);
            }
          }
        }
        baryMap.set(
          u.id,
          indices.length > 0
            ? indices.reduce((acc, v) => acc + v, 0) / indices.length
            : (unitIndex.get(u.id) ?? 0),
        );
      }
      units.sort((a, b) => (baryMap.get(a.id) ?? 0) - (baryMap.get(b.id) ?? 0));
      refreshIndices(g);
    }
    for (let i = genNums.length - 2; i >= 0; i -= 1) {
      const g = genNums[i];
      const units = orderedUnitsByGen.get(g) ?? [];
      const baryMap = new Map<string, number>();
      for (const u of units) {
        const indices: number[] = [];
        for (const pid of u.orderedMemberIds) {
          for (const childId of model.childMap.get(pid) ?? []) {
            const cu = personToUnit.get(childId);
            if (cu) {
              indices.push(unitIndex.get(cu.id) ?? 0);
            }
          }
        }
        baryMap.set(
          u.id,
          indices.length > 0
            ? indices.reduce((acc, v) => acc + v, 0) / indices.length
            : (unitIndex.get(u.id) ?? 0),
        );
      }
      units.sort((a, b) => (baryMap.get(a.id) ?? 0) - (baryMap.get(b.id) ?? 0));
      refreshIndices(g);
    }
  }

  // Compute each unit's footprint width (accounting for expanded 2-column hanging grids so siblings never collide)
  const unitFootprintWidth = (unit: TreeFamilyUnit): number => {
    const memberSpan =
      unit.orderedMemberIds.length * ARCHIVAL_NODE_W +
      Math.max(0, unit.orderedMemberIds.length - 1) * ARCHIVAL_SPOUSE_GAP;

    let extraSpan = memberSpan;
    for (const uid of unit.unionIds) {
      const union = model.unionsById.get(uid);
      if (!union) {
        continue;
      }
      if (union.hangingChildIds.length > 0) {
        const cols = union.hangingChildIds.length === 1 ? 1 : 2;
        const gridW =
          cols * ARCHIVAL_NODE_W + (cols === 2 ? ARCHIVAL_HANGING_COL_GAP : 0);
        extraSpan = Math.max(extraSpan, gridW);
      }
      if (union.earlyLossChildIds.length > 0) {
        const stripW = Math.min(340, Math.max(176, union.earlyLossChildIds.length * 104 + 28));
        extraSpan = Math.max(extraSpan, stripW);
      }
    }
    return extraSpan;
  };

  // Compute each generation's required vertical height (rank row + early-loss strips + hanging grids + bus tracks)
  const rowWidths = new Map<number, number>();
  let maxRowWidth = 0;
  for (const g of model.generations) {
    const units = orderedUnitsByGen.get(g.gen) ?? [];
    const totalW =
      units.reduce((sum, u) => sum + unitFootprintWidth(u), 0) +
      Math.max(0, units.length - 1) * ARCHIVAL_UNIT_GAP;
    rowWidths.set(g.gen, totalW);
    if (totalW > maxRowWidth) {
      maxRowWidth = totalW;
    }
  }

  const leftPad = 148;
  const topPad = 48;

  const nodes: DiagramPlacedNode[] = [];
  const byId = new Map<string, DiagramPlacedNode>();
  const hubs: DiagramUnionHub[] = [];
  const hubByUnionId = new Map<string, DiagramUnionHub>();
  const buses: DiagramOrthogonalBus[] = [];
  const hangingRails: DiagramHangingGridRail[] = [];
  const siblingToggles: DiagramSiblingToggle[] = [];
  const earlyLossStrips: DiagramEarlyLossStrip[] = [];
  const genBands: DiagramGenBand[] = [];

  let cursorY = topPad;

  for (const g of model.generations) {
    const units = orderedUnitsByGen.get(g.gen) ?? [];
    const rowW = rowWidths.get(g.gen) ?? 0;
    let cursorX = leftPad + (maxRowWidth - rowW) / 2;
    const rowTopY = cursorY;
    let rowBottomY = rowTopY + ARCHIVAL_NODE_H;

    for (const unit of units) {
      const footprintW = unitFootprintWidth(unit);
      const memberSpan =
        unit.orderedMemberIds.length * ARCHIVAL_NODE_W +
        Math.max(0, unit.orderedMemberIds.length - 1) * ARCHIVAL_SPOUSE_GAP;
      const memberStartX = cursorX + (footprintW - memberSpan) / 2;

      for (const [idx, pid] of unit.orderedMemberIds.entries()) {
        const person = model.peopleById.get(pid);
        if (!person) {
          continue;
        }
        const placed: DiagramPlacedNode = {
          person,
          x: Math.round(memberStartX + idx * (ARCHIVAL_NODE_W + ARCHIVAL_SPOUSE_GAP)),
          y: Math.round(rowTopY),
          width: ARCHIVAL_NODE_W,
          height: ARCHIVAL_NODE_H,
          gen: g.gen,
          isDirect: model.directPersonIds.has(pid),
          placement: 'rank',
          unionId: null,
        };
        nodes.push(placed);
        byId.set(pid, placed);
      }

      // Place discrete marriage/union hubs for this family unit
      let priorHangingBottomY: number | null = null;
      for (const uid of unit.unionIds) {
        const union = model.unionsById.get(uid);
        if (!union) {
          continue;
        }
        const primaryNode = byId.get(union.primaryPartnerId);
        const secondaryNode = union.secondaryPartnerId
          ? byId.get(union.secondaryPartnerId)
          : undefined;
        if (!primaryNode) {
          continue;
        }

        let hub: DiagramUnionHub;
        if (secondaryNode) {
          const leftNode = primaryNode.x <= secondaryNode.x ? primaryNode : secondaryNode;
          const rightNode = primaryNode.x <= secondaryNode.x ? secondaryNode : primaryNode;
          const leftX = leftNode.x + leftNode.width;
          const rightX = rightNode.x;
          const midX = Math.round((leftX + rightX) / 2);
          const midY = Math.round(rowTopY + ARCHIVAL_NODE_H / 2);
          hub = {
            union,
            x: midX,
            y: midY,
            leftPartnerId: leftNode.person.id,
            rightPartnerId: rightNode.person.id,
            connectorY: midY,
            leftX,
            rightX,
          };
        } else {
          const midX = Math.round(primaryNode.x + primaryNode.width / 2);
          const midY = Math.round(rowTopY + ARCHIVAL_NODE_H + 10);
          hub = {
            union,
            x: midX,
            y: midY,
            leftPartnerId: primaryNode.person.id,
            rightPartnerId: null,
            connectorY: midY,
            leftX: midX,
            rightX: midX,
          };
        }

        hubs.push(hub);
        hubByUnionId.set(union.id, hub);

        let attachmentY = rowTopY + ARCHIVAL_NODE_H + 16;
        if (priorHangingBottomY !== null && union.hangingChildIds.length > 0) {
          attachmentY = Math.max(attachmentY, priorHangingBottomY + 18);
        }

        // Place concise "Died young" strip below union hub
        if (union.earlyLossChildIds.length > 0) {
          const chipW = 100;
          const chipGap = 8;
          const padX = 12;
          const chipsPerRow = Math.min(3, union.earlyLossChildIds.length);
          const chipRows = Math.ceil(union.earlyLossChildIds.length / chipsPerRow);
          const stripW = Math.max(182, chipsPerRow * chipW + (chipsPerRow - 1) * chipGap + padX * 2);
          const stripH = 22 + chipRows * (ARCHIVAL_EARLY_CHIP_H + 6) + 4;
          const stripX = Math.round(hub.x - stripW / 2);
          const stripY = Math.round(attachmentY);

          const chips: DiagramEarlyLossChip[] = [];
          for (const [cIdx, cid] of union.earlyLossChildIds.entries()) {
            const child = model.peopleById.get(cid);
            if (!child) {
              continue;
            }
            const col = cIdx % chipsPerRow;
            const row = Math.floor(cIdx / chipsPerRow);
            chips.push({
              person: child,
              unionId: union.id,
              x: stripX + padX + col * (chipW + chipGap),
              y: stripY + 20 + row * (ARCHIVAL_EARLY_CHIP_H + 6),
              width: chipW,
              height: ARCHIVAL_EARLY_CHIP_H,
            });
          }

          earlyLossStrips.push({
            unionId: union.id,
            parentIds: union.partnerIds,
            x: stripX,
            y: stripY,
            width: stripW,
            height: stripH,
            stemFromX: hub.x,
            stemFromY: hub.y + 8,
            chips,
          });
          attachmentY = stripY + stripH + ARCHIVAL_EARLY_STRIP_GAP;
          rowBottomY = Math.max(rowBottomY, stripY + stripH);
        }

        // Place collapsible sibling disclosure pill (+N siblings) when collateral siblings exist
        const totalCollateral = union.collapsedSiblingIds.length + union.hangingChildIds.length;
        if (totalCollateral > 0) {
          const pillW = 148;
          const pillH = 28;
          const pillX = Math.round(hub.x - pillW / 2);
          const pillY = Math.round(attachmentY);
          siblingToggles.push({
            unionId: union.id,
            parentIds: union.partnerIds,
            x: pillX,
            y: pillY,
            width: pillW,
            height: pillH,
            stemFromX: hub.x,
            stemFromY: hub.y + 8,
            hiddenCount: union.collapsedSiblingIds.length,
            totalCollateralCount: totalCollateral,
            isExpanded: union.isExpanded,
            isDirect: union.isDirect,
          });
          attachmentY = pillY + pillH + 12;
          rowBottomY = Math.max(rowBottomY, pillY + pillH);
        }

        // Place expanded 2-column hanging grid directly beneath the toggle
        if (union.hangingChildIds.length > 0) {
          const cols = union.hangingChildIds.length === 1 ? 1 : 2;
          const spineX = hub.x;
          const gridTopY = Math.round(attachmentY);
          const ticks: {
            childId: string;
            y: number;
            side: 'left' | 'right';
            toX: number;
          }[] = [];
          let maxGridY = gridTopY;

          for (const [hIdx, cid] of union.hangingChildIds.entries()) {
            const child = model.peopleById.get(cid);
            if (!child) {
              continue;
            }
            const col = cols === 1 ? 0 : hIdx % 2;
            const row = cols === 1 ? hIdx : Math.floor(hIdx / 2);
            const y = gridTopY + row * (ARCHIVAL_NODE_H + ARCHIVAL_HANGING_ROW_GAP);
            const x =
              cols === 1
                ? Math.round(spineX - ARCHIVAL_NODE_W / 2)
                : col === 0
                  ? Math.round(spineX - ARCHIVAL_HANGING_COL_GAP / 2 - ARCHIVAL_NODE_W)
                  : Math.round(spineX + ARCHIVAL_HANGING_COL_GAP / 2);

            const placed: DiagramPlacedNode = {
              person: child,
              x,
              y,
              width: ARCHIVAL_NODE_W,
              height: ARCHIVAL_NODE_H,
              gen: g.gen + 1,
              isDirect: false,
              placement: 'hanging',
              unionId: union.id,
            };
            nodes.push(placed);
            byId.set(cid, placed);

            const tickY = Math.round(y + ARCHIVAL_NODE_H / 2);
            if (cols === 2) {
              ticks.push({
                childId: cid,
                y: tickY,
                side: col === 0 ? 'left' : 'right',
                toX: col === 0 ? x + ARCHIVAL_NODE_W : x,
              });
            }
            maxGridY = Math.max(maxGridY, y + ARCHIVAL_NODE_H);
          }

          hangingRails.push({
            unionId: union.id,
            parentIds: union.partnerIds,
            childIds: union.hangingChildIds,
            spineX,
            topY: gridTopY - 12,
            bottomY:
              ticks.length > 0
                ? Math.max(...ticks.map((t) => t.y))
                : gridTopY,
            ticks,
          });
          priorHangingBottomY = maxGridY;
          rowBottomY = Math.max(rowBottomY, maxGridY);
        }
      }

      cursorX += footprintW + ARCHIVAL_UNIT_GAP;
    }

    // Count how many unions in this generation emit inter-generation buses so we reserve clean staggered bus tracks
    const activeBusCount = g.unions.filter((u) => u.visibleChildIds.length > 0).length;
    const channelHeight = Math.max(ARCHIVAL_GEN_MIN_GAP, 44 + activeBusCount * 12);

    genBands.push({
      gen: g.gen,
      y: rowTopY,
      height: rowBottomY - rowTopY,
      label: g.label,
      yearRange: g.yearRange,
    });

    cursorY = rowBottomY + channelHeight;
  }

  // Build 90° orthogonal bus routes from each union hub to its placed rank children
  const busTrackCounterByGen = new Map<number, number>();
  for (const union of model.unions) {
    if (union.visibleChildIds.length === 0) {
      continue;
    }
    const hub = hubByUnionId.get(union.id);
    if (!hub) {
      continue;
    }

    const childDrops: {
      childId: string;
      x: number;
      toY: number;
      isDirect: boolean;
    }[] = [];

    for (const cid of union.visibleChildIds) {
      const childNode = byId.get(cid);
      if (!childNode) {
        continue;
      }
      childDrops.push({
        childId: cid,
        x: Math.round(childNode.x + childNode.width / 2),
        toY: childNode.y,
        isDirect: childNode.isDirect,
      });
    }

    if (childDrops.length === 0) {
      continue;
    }

    const trackIdx = busTrackCounterByGen.get(union.gen) ?? 0;
    busTrackCounterByGen.set(union.gen, trackIdx + 1);

    const minChildTopY = Math.min(...childDrops.map((d) => d.toY));
    const genBand = genBands.find((b) => b.gen === union.gen);
    const channelStartY = genBand ? genBand.y + genBand.height + 16 : hub.y + 32;
    const rawBusY = channelStartY + trackIdx * 11;
    const busY = Math.round(Math.min(minChildTopY - 18, Math.max(hub.y + 20, rawBusY)));

    const xs = [hub.x, ...childDrops.map((d) => d.x)];
    buses.push({
      unionId: union.id,
      parentIds: union.partnerIds,
      childIds: childDrops.map((d) => d.childId),
      isDirect: union.isDirect && childDrops.some((d) => d.isDirect),
      hubX: hub.x,
      hubY: hub.y + 8,
      busY,
      railMinX: Math.min(...xs),
      railMaxX: Math.max(...xs),
      childDrops,
    });
  }

  // Calculate tight bounds enclosing all nodes, strips, and toggles
  let minX = 0;
  let maxX = leftPad * 2 + maxRowWidth;
  let maxY = cursorY + 32;

  for (const n of nodes) {
    maxX = Math.max(maxX, n.x + n.width + 64);
    maxY = Math.max(maxY, n.y + n.height + 64);
    minX = Math.min(minX, n.x - 40);
  }
  for (const s of earlyLossStrips) {
    maxX = Math.max(maxX, s.x + s.width + 48);
    maxY = Math.max(maxY, s.y + s.height + 48);
  }
  for (const t of siblingToggles) {
    maxX = Math.max(maxX, t.x + t.width + 48);
    maxY = Math.max(maxY, t.y + t.height + 48);
  }

  return {
    nodes,
    byId,
    hubs,
    buses,
    hangingRails,
    siblingToggles,
    earlyLossStrips,
    genBands,
    bounds: {
      minX: Math.min(0, Math.round(minX)),
      maxX: Math.max(640, Math.round(maxX)),
      minY: 0,
      maxY: Math.max(420, Math.round(maxY)),
    },
  };
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

  // Include co-parents of immediate children so the nuclear family stays intact
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

  // Build clickable direct-ancestor breadcrumb from oldest ancestor down to selected person
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
    const preferredParentId =
      parentIds.find((pid) => model.directPersonIds.has(pid)) ?? parentIds[0];
    cursor = model.peopleById.get(preferredParentId);
  }

  let relationshipToPivot: string | null = null;
  let pivotName: string | null = null;
  if (
    bundle &&
    placesById &&
    model.pivotPersonId &&
    model.pivotPersonId !== selectedPersonId
  ) {
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
  buildMode: 'public' | 'private' = 'public',
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

export function isPersonVisibleOnCurrentSurface(
  personId: string,
  model: ArchivalTreeModel,
): boolean {
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

export function findCollapsedUnionForPerson(
  personId: string,
  model: ArchivalTreeModel,
): TreeUnion | null {
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
  const needsBranchReset =
    currentBranchFilter !== 'all' && personBranch !== currentBranchFilter;
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

  const needsFullMode = currentMode === 'spine' && !isDirectSpinePerson(person);
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
    const isOutsideCurrentBranch =
      branchFilter !== 'all' && personBranch !== branchFilter;
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
      } else if (
        foldedGiven.startsWith(normalizedQuery) ||
        foldedSurname.startsWith(normalizedQuery)
      ) {
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
