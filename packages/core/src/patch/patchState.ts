import { getCurrentReferenceYear, parseIsoReferenceYear } from '../clock.js';
import { compareArchiveEvents } from '../compileArchive.js';
import { collectLivingNames, compileLivingNamePattern } from '../privacy.js';
import type { KinloomSiteConfig, PrivacyConfig } from '../schemas/config.js';
import type {
  ArchiveBundle,
  ArchiveEvent,
  BuildMode,
  KinshipEdge,
  MediaItem,
  Narrative,
  Person,
  Place,
  ResidenceSpan,
  SourceRecord,
} from '../schemas/entities.js';
import type { EntityPayload, EntityType, RevisionAction } from '../schemas/revisions.js';

export interface BundlePatchMutation {
  revision_id?: number;
  entity_type: EntityType;
  entity_id: string;
  action: RevisionAction;
  before_json?: EntityPayload | null;
  after_json: EntityPayload | null;
  has_primary_source?: boolean;
}

export interface PatchCompiledBundleOptions {
  generatedAt?: string;
  referenceYear?: number;
  legacyContainerSourceIds?: ReadonlySet<string>;
}

export interface PatchWorkingState {
  readonly previousBundle: ArchiveBundle;
  readonly siteConfig: KinloomSiteConfig;
  readonly mode: BuildMode;
  readonly privacy: PrivacyConfig;
  readonly stripLivingPortraits: boolean;
  readonly includeLivingSpans: boolean;
  readonly legacyContainerSourceIds?: ReadonlySet<string>;

  readonly people: Person[];
  readonly events: ArchiveEvent[];
  readonly places: Place[];
  readonly sources: SourceRecord[];
  readonly kinship: KinshipEdge[];
  readonly media: MediaItem[];
  narratives: Narrative[] | undefined;
  placeAncestors: Record<string, string[]>;
  residenceSpans: ResidenceSpan[];
  readonly uncitedKeys: Set<string>;

  readonly affectedEventCountPersonIds: Set<string>;
  readonly affectedSpanPersonIds: Set<string>;
  readonly affectedMediaPersonIds: Set<string>;
  readonly affectedMediaEventIds: Set<string>;
  readonly explicitPortraitPersonIds: Set<string>;
  readonly deletedPortraitUrlByPerson: Map<string, Set<string>>;
  readonly deletedHeroPhotoByEvent: Map<string, Set<string>>;
  readonly placesBeforeMutation: Map<string, Place>;
  placesMutated: boolean;
  readonly mutatedPlaceIds: Set<string>;
  readonly newlyLivingPersonIds: Set<string>;
  readonly newlyLivingNamesById: Map<string, { full_name: string; alt_names: string[] }>;
  readonly deletedPersonIds: Set<string>;
  readonly renamedPersonIds: Set<string>;

  ensurePeopleIndex(): { idxById: Map<string, number>; living: Set<string> };
  ensureEventsIndex(): Map<string, number>;
  invalidateEventsIndex(): void;
  ensurePlacesById(): Map<string, Place>;
  markLivingPatternDirty(): void;
  getLivingPattern(): RegExp | null;
  getLivingRedactedCount(): number;
}

export function createPatchWorkingState(
  previousBundle: ArchiveBundle,
  siteConfig: KinloomSiteConfig,
  mode: BuildMode,
  options?: PatchCompiledBundleOptions
): PatchWorkingState {
  const effectiveReferenceYear =
    options?.referenceYear ??
    siteConfig.privacy.referenceYear ??
    parseIsoReferenceYear(options?.generatedAt ?? previousBundle.meta.generated_at) ??
    getCurrentReferenceYear();
  const privacy: PrivacyConfig = {
    ...siteConfig.privacy,
    referenceYear: effectiveReferenceYear,
  };
  const people = [...previousBundle.people];
  const events = [...previousBundle.events];
  const places = [...previousBundle.places];
  const sources = [...previousBundle.sources];
  const kinship = [...previousBundle.kinship];
  const media = previousBundle.media ? [...previousBundle.media] : [];

  // Lazily initialized indexes so lightweight mutations skip unrelated scans.
  let peopleIdxById: Map<string, number> | null = null;
  let livingIds: Set<string> | null = null;
  let eventsIdxById: Map<string, number> | null = null;
  let placesById: Map<string, Place> | null = null;
  let livingPatternDirty = true;
  let cachedLivingPattern: RegExp | null = null;

  return {
    previousBundle,
    siteConfig,
    mode,
    privacy,
    stripLivingPortraits: mode === 'public' || privacy.stripLivingPortraits,
    includeLivingSpans: mode === 'private' && !privacy.stripLivingResidenceSpans,
    legacyContainerSourceIds: options?.legacyContainerSourceIds,

    people,
    events,
    places,
    sources,
    kinship,
    media,
    narratives: previousBundle.narratives ? [...previousBundle.narratives] : undefined,
    placeAncestors: previousBundle.place_ancestors,
    residenceSpans: previousBundle.residence_spans,
    uncitedKeys: new Set<string>(previousBundle.meta.uncited_entity_keys ?? []),

    affectedEventCountPersonIds: new Set<string>(),
    affectedSpanPersonIds: new Set<string>(),
    affectedMediaPersonIds: new Set<string>(),
    affectedMediaEventIds: new Set<string>(),
    explicitPortraitPersonIds: new Set<string>(),
    deletedPortraitUrlByPerson: new Map<string, Set<string>>(),
    deletedHeroPhotoByEvent: new Map<string, Set<string>>(),
    placesBeforeMutation: new Map<string, Place>(),
    placesMutated: false,
    mutatedPlaceIds: new Set<string>(),
    newlyLivingPersonIds: new Set<string>(),
    newlyLivingNamesById: new Map<string, { full_name: string; alt_names: string[] }>(),
    deletedPersonIds: new Set<string>(),
    renamedPersonIds: new Set<string>(),

    ensurePeopleIndex() {
      if (peopleIdxById === null || livingIds === null) {
        peopleIdxById = new Map<string, number>();
        livingIds = new Set<string>();
        for (let i = 0; i < people.length; i += 1) {
          const p = people[i];
          peopleIdxById.set(p.id, i);
          if (p.is_living) {
            livingIds.add(p.id);
          }
        }
      }
      return { idxById: peopleIdxById, living: livingIds };
    },

    ensureEventsIndex() {
      if (eventsIdxById === null) {
        eventsIdxById = new Map<string, number>();
        for (let i = 0; i < events.length; i += 1) {
          eventsIdxById.set(events[i].id, i);
        }
      }
      return eventsIdxById;
    },

    invalidateEventsIndex() {
      eventsIdxById = null;
    },

    ensurePlacesById() {
      if (placesById === null) {
        placesById = new Map<string, Place>();
        for (const pl of places) {
          placesById.set(pl.id, pl);
        }
      }
      return placesById;
    },

    markLivingPatternDirty() {
      livingPatternDirty = true;
    },

    getLivingPattern() {
      if (mode !== 'public') {
        return null;
      }
      if (livingPatternDirty) {
        cachedLivingPattern = compileLivingNamePattern(collectLivingNames(people));
        livingPatternDirty = false;
      }
      return cachedLivingPattern;
    },

    getLivingRedactedCount() {
      return livingIds !== null ? livingIds.size : previousBundle.meta.counts.living_redacted;
    },
  };
}

export function binarySearchEventInsertIndex(events: readonly ArchiveEvent[], target: ArchiveEvent): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareArchiveEvents(events[mid], target) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function arraysEqualStrings(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function updateUncitedKey(
  uncitedKeys: Set<string>,
  entityType: EntityType,
  entityId: string,
  hasPrimarySource: boolean | undefined,
  deleted: boolean
): void {
  if (entityType === 'kinship_edge') {
    return;
  }
  const key = `${entityType}:${entityId}`;
  if (deleted || hasPrimarySource !== false) {
    uncitedKeys.delete(key);
  } else {
    uncitedKeys.add(key);
  }
}

export function resolveEffectivePrimarySource(
  entity: { has_primary_source?: boolean },
  mutationHasPrimarySource: boolean | undefined
): boolean | undefined {
  const effective =
    entity.has_primary_source !== undefined
      ? entity.has_primary_source
      : mutationHasPrimarySource === false
        ? false
        : undefined;
  if (effective === false && entity.has_primary_source === undefined) {
    entity.has_primary_source = false;
  }
  return effective;
}
