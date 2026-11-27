import type {
  KinshipEdge,
  Place,
  PlaceType,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '../schemas/entities.js';

export interface KnownPlaceCoords {
  lat: number;
  lng: number;
  place_type?: PlaceType;
}

export interface SliceGedcomOptions {
  /** Exact GEDCOM xref of the pivot/root individual (e.g. '@I10@'). */
  rootXref?: string;
  /** Case-insensitive full-name match used when rootXref is omitted. */
  rootName?: string;
  /**
   * Surnames that continue expanding upward along the direct ancestral line.
   * Married-in spouses whose surname is not in this list stay paired without
   * pulling in their upstream spouse-parent subtrees (unless expandSpouseAncestors is true).
   */
  ancestorSurnames?: readonly string[];
  /** Include complete sibling sets of direct ancestors (default true). */
  includeAncestorSiblings?: boolean;
  /** Include spouses of descendants (default true). */
  includeDescendantSpouses?: boolean;
  /** Expand parents of married-in spouses (default false). */
  expandSpouseAncestors?: boolean;
  /** Stop descending past these xrefs (the person is kept, their children are skipped). */
  stopDescendantXrefs?: readonly string[];
  /** Optional cap on ancestor generations walked above root. */
  maxAncestorDepth?: number;
  /** Optional cap on descendant generations walked below root. */
  maxDescendantDepth?: number;
  /** Branch identifier stamped onto output people (default 'primary'). */
  branchId?: string;
  /** Normalize maiden/birth surnames as primary and move married names to alt_names (default true). */
  normalizeMaidenNames?: boolean;
  /** Reference year for 100-year living-person detection (default 2026). */
  referenceYear?: number;
  /** Living cutoff age in years (default 101). */
  livingCutoffYears?: number;
  /** Optional known place coordinates lookup (lowercased full place name -> lat/lng). */
  knownPlaces?: Readonly<Record<string, KnownPlaceCoords>>;
}

export interface SliceGedcomResult {
  rootXref: string;
  people: RawPerson[];
  events: RawEvent[];
  places: Place[];
  sources: SourceRecord[];
  kinship: KinshipEdge[];
  anomalies: string[];
  stats: {
    totalGedcomIndividuals: number;
    ancestors: number;
    ancestorSiblings: number;
    descendants: number;
    descendantSpouses: number;
    totalPeople: number;
    totalEvents: number;
    totalPlaces: number;
    totalSources: number;
    totalKinshipEdges: number;
  };
}

export interface NormalizedPersonName {
  fullName: string;
  givenName: string;
  surname: string;
  altNames: string[];
}

export interface GedcomLineageSelection {
  rootXref: string;
  ancestors: string[];
  ancestorSiblings: string[];
  descendants: string[];
  descendantSpouses: string[];
  orderedXrefs: string[];
  allFamilyIds: string[];
  bucketByXref: Map<string, string>;
}
