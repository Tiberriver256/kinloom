import { fastLocaleCompare, type KinshipEdge, type Person } from '@kinloom/core';

export type TreeLineageMode = 'spine' | 'full';
export type TreeViewSurface = 'roll' | 'diagram';
export type SemanticZoomLevel = 'overview' | 'compact' | 'detail';
export type TreeUnionKind = 'couple' | 'single_parent';

export const ARCHIVAL_NODE_W = 196;
export const ARCHIVAL_NODE_H = 52;
export const ARCHIVAL_SPOUSE_GAP = 34;
export const ARCHIVAL_UNIT_GAP = 34;
export const ARCHIVAL_GEN_MIN_GAP = 72;
export const ARCHIVAL_HANGING_COL_GAP = 28;
export const ARCHIVAL_HANGING_ROW_GAP = 14;
export const ARCHIVAL_EARLY_CHIP_W = 112;
export const ARCHIVAL_EARLY_CHIP_H = 30;
export const ARCHIVAL_EARLY_STRIP_GAP = 10;
export const COLLATERAL_COLLAPSE_THRESHOLD = 4;
export const DIRECT_SPINE_DESCENDANT_FANOUT_LIMIT = 12;
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
  readonly anchorPersonId: string | null;
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

export interface DiagramPoint {
  readonly x: number;
  readonly y: number;
}

export interface DiagramOrthogonalDrop {
  readonly childId: string;
  readonly x: number;
  readonly toY: number;
  readonly isDirect: boolean;
  readonly points: readonly DiagramPoint[];
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
  readonly stemPoints: readonly DiagramPoint[];
  readonly childDrops: readonly DiagramOrthogonalDrop[];
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
  readonly visibleChildCount: number;
  readonly mode: TreeLineageMode;
  readonly isExpanded: boolean;
  readonly isDirect: boolean;
}

export interface UnionOtherChildrenLabels {
  readonly buttonLabel: string;
  readonly compactLabel: string;
  readonly ariaLabel: string;
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
  readonly branchFilter?: string | null | undefined;
  readonly defaultBranchId?: string | undefined;
  readonly directModeBranchIds?: readonly string[] | undefined;
  readonly mode: TreeLineageMode;
  readonly expandedUnionIds?: ReadonlySet<string> | undefined;
  readonly anchorPersonId?: string | null | undefined;
}

const ROMAN_NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI'] as const;

export function formatUnionOtherChildrenLabel(params: {
  readonly hiddenCount: number;
  readonly totalCollateralCount: number;
  readonly visibleChildCount: number;
  readonly isExpanded: boolean;
  readonly mode: TreeLineageMode;
}): UnionOtherChildrenLabels {
  const { hiddenCount, totalCollateralCount, visibleChildCount, isExpanded, mode } = params;
  const count = isExpanded ? totalCollateralCount : hiddenCount;
  const childWord = count === 1 ? 'child' : 'children';
  if (visibleChildCount > 0) {
    const belowDetail =
      mode === 'spine' ? `${visibleChildCount} in direct line below` : `${visibleChildCount} shown below`;
    if (isExpanded) {
      return {
        buttonLabel: `Hide ${totalCollateralCount} other ${childWord} (${belowDetail})`,
        compactLabel: `▾ Hide ${totalCollateralCount} other ${childWord}`,
        ariaLabel: `Hide ${totalCollateralCount} other ${childWord} (${belowDetail})`,
      };
    }
    return {
      buttonLabel: `+${hiddenCount} other ${childWord} (${belowDetail})`,
      compactLabel: `▸ +${hiddenCount} other ${childWord}`,
      ariaLabel: `Show ${hiddenCount} other ${childWord} (${belowDetail})`,
    };
  }
  if (isExpanded) {
    return {
      buttonLabel: `Hide ${totalCollateralCount} ${childWord}`,
      compactLabel: `▾ Hide ${totalCollateralCount} ${childWord}`,
      ariaLabel: `Hide ${totalCollateralCount} ${childWord}`,
    };
  }
  return {
    buttonLabel: `+${hiddenCount} ${childWord}`,
    compactLabel: `▸ +${hiddenCount} ${childWord}`,
    ariaLabel: `Show ${hiddenCount} ${childWord}`,
  };
}

export function toRomanNumeral(order: number): string {
  if (order >= 1 && order <= ROMAN_NUMERALS.length) {
    return ROMAN_NUMERALS[order - 1] ?? String(order);
  }
  return String(order);
}

export function isRedactedLivingPlaceholder(person: Pick<Person, 'is_living' | 'full_name'>): boolean {
  const trimmed = person.full_name.trim();
  return (person.is_living && trimmed === '') || trimmed === 'Living';
}

export function isDirectAncestorOrPivot(person: Pick<Person, 'lineage_group'>): boolean {
  return person.lineage_group === 'ancestor' || person.lineage_group === 'pivot_ancestor';
}

export function isDirectSpinePerson(person: Pick<Person, 'lineage_group'>): boolean {
  return isDirectAncestorOrPivot(person) || person.lineage_group === 'descendant';
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
  spouseMap: ReadonlyMap<string, readonly string[]>
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

export function sortPeopleChronologically(a: Person, b: Person): number {
  const ya = a.birth_year ?? 9999;
  const yb = b.birth_year ?? 9999;
  if (ya !== yb) {
    return ya - yb;
  }
  return fastLocaleCompare(a.full_name, b.full_name);
}
