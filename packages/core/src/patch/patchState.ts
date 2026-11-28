import { getCurrentReferenceYear, parseIsoReferenceYear } from '../clock.js';
import { compareArchiveEvents } from '../compile/enrichment.js';
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
  revision_id?: number | undefined;
  entity_type: EntityType;
  entity_id: string;
  action: RevisionAction;
  before_json?: EntityPayload | null | undefined;
  after_json: EntityPayload | null;
  has_primary_source?: boolean | undefined;
}

export interface PatchCompiledBundleOptions {
  generatedAt?: string | undefined;
  referenceYear?: number | undefined;
  legacyContainerSourceIds?: ReadonlySet<string> | undefined;
}

export interface BundleIndexMemo {
  peopleIdxById: Map<string, number> | null;
  livingIds: Set<string> | null;
  eventsIdxById: Map<string, number> | null;
  placesById: Map<string, Place> | null;
  publicLivingPatternComputed: boolean;
  publicLivingPattern: RegExp | null;
}

const bundleIndexCache = new WeakMap<ArchiveBundle, BundleIndexMemo>();

function getOrCreateBundleMemo(bundle: ArchiveBundle): BundleIndexMemo {
  let memo = bundleIndexCache.get(bundle);
  if (!memo) {
    memo = {
      peopleIdxById: null,
      livingIds: null,
      eventsIdxById: null,
      placesById: null,
      publicLivingPatternComputed: false,
      publicLivingPattern: null,
    };
    bundleIndexCache.set(bundle, memo);
  }
  return memo;
}

export function attachBundleIndexMemo(bundle: ArchiveBundle, memo: BundleIndexMemo): void {
  bundleIndexCache.set(bundle, memo);
}

export interface PatchWorkingState {
  readonly previousBundle: ArchiveBundle;
  readonly siteConfig: KinloomSiteConfig;
  readonly mode: BuildMode;
  readonly privacy: PrivacyConfig;
  readonly stripLivingPortraits: boolean;
  readonly includeLivingSpans: boolean;
  readonly legacyContainerSourceIds?: ReadonlySet<string> | undefined;

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
  readonly hasUncitedChanges: () => boolean;
  markUncitedChanged(): void;

  readonly affectedEventCountPersonIds: Set<string>;
  readonly affectedSpanPersonIds: Set<string>;
  readonly affectedMediaPersonIds: Set<string>;
  readonly affectedMediaEventIds: Set<string>;
  readonly explicitPortraitPersonIds: Set<string>;
  readonly deletedPortraitUrlByPerson: Map<string, Set<string>>;
  readonly deletedHeroPhotoByEvent: Map<string, Set<string>>;
  readonly placesBeforeMutation: Map<string, Place>;
  placesMutated: boolean;
  mediaMutated: boolean;
  readonly mutatedPlaceIds: Set<string>;
  readonly newlyLivingPersonIds: Set<string>;
  readonly newlyLivingNamesById: Map<string, { full_name: string; alt_names: string[] }>;
  readonly deletedPersonIds: Set<string>;
  readonly renamedPersonIds: Set<string>;

  ensurePeopleIndex(forMutation?: boolean): { idxById: Map<string, number>; living: Set<string> };
  ensureEventsIndex(forMutation?: boolean): Map<string, number>;
  invalidateEventsIndex(): void;
  ensurePlacesById(forMutation?: boolean): Map<string, Place>;
  markLivingPatternDirty(): void;
  getLivingPattern(): RegExp | null;
  getLivingRedactedCount(): number;
  buildDerivedMemo(): BundleIndexMemo;
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

  const baseMemo = getOrCreateBundleMemo(previousBundle);
  let peopleIdxById: Map<string, number> | null = baseMemo.peopleIdxById;
  let livingIds: Set<string> | null = baseMemo.livingIds;
  let peopleIndexCloned = false;

  let eventsIdxById: Map<string, number> | null = baseMemo.eventsIdxById;
  let eventsIndexCloned = false;

  let placesById: Map<string, Place> | null = baseMemo.placesById;
  let placesIndexCloned = false;

  let livingPatternDirty = !baseMemo.publicLivingPatternComputed;
  let cachedLivingPattern: RegExp | null = baseMemo.publicLivingPattern;

  let uncitedSet: Set<string> | null = null;
  let uncitedChanged = false;
  const ensureUncitedSet = (): Set<string> => {
    if (!uncitedSet) {
      uncitedSet = new Set<string>(previousBundle.meta.uncited_entity_keys ?? []);
    }
    return uncitedSet;
  };

  // Lazy Set proxy that avoids cloning uncited_entity_keys unless actually touched or changed.
  const lazyUncitedKeys = new Proxy(new Set<string>(), {
    get(_target, prop) {
      const s = ensureUncitedSet();
      const val = Reflect.get(s, prop, s);
      return typeof val === 'function' ? val.bind(s) : val;
    },
  });

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
    uncitedKeys: lazyUncitedKeys,
    hasUncitedChanges: () => uncitedChanged,
    markUncitedChanged() {
      uncitedChanged = true;
    },

    affectedEventCountPersonIds: new Set<string>(),
    affectedSpanPersonIds: new Set<string>(),
    affectedMediaPersonIds: new Set<string>(),
    affectedMediaEventIds: new Set<string>(),
    explicitPortraitPersonIds: new Set<string>(),
    deletedPortraitUrlByPerson: new Map<string, Set<string>>(),
    deletedHeroPhotoByEvent: new Map<string, Set<string>>(),
    placesBeforeMutation: new Map<string, Place>(),
    placesMutated: false,
    mediaMutated: false,
    mutatedPlaceIds: new Set<string>(),
    newlyLivingPersonIds: new Set<string>(),
    newlyLivingNamesById: new Map<string, { full_name: string; alt_names: string[] }>(),
    deletedPersonIds: new Set<string>(),
    renamedPersonIds: new Set<string>(),

    ensurePeopleIndex(forMutation = false) {
      if (peopleIdxById === null || livingIds === null) {
        const idxMap = new Map<string, number>();
        const livSet = new Set<string>();
        people.forEach((p, i) => {
          idxMap.set(p.id, i);
          if (p.is_living) {
            livSet.add(p.id);
          }
        });
        peopleIdxById = idxMap;
        livingIds = livSet;
        if (people.length === previousBundle.people.length) {
          baseMemo.peopleIdxById = peopleIdxById;
          baseMemo.livingIds = livingIds;
          peopleIndexCloned = false;
        } else {
          peopleIndexCloned = true;
        }
      }
      if (forMutation && !peopleIndexCloned) {
        peopleIdxById = new Map(peopleIdxById);
        livingIds = new Set(livingIds);
        peopleIndexCloned = true;
      }
      return { idxById: peopleIdxById, living: livingIds };
    },

    ensureEventsIndex(forMutation = false) {
      if (eventsIdxById === null) {
        const idxMap = new Map<string, number>();
        events.forEach((ev, i) => {
          idxMap.set(ev.id, i);
        });
        eventsIdxById = idxMap;
        if (events.length === previousBundle.events.length) {
          baseMemo.eventsIdxById = eventsIdxById;
          eventsIndexCloned = false;
        } else {
          eventsIndexCloned = true;
        }
      }
      if (forMutation && !eventsIndexCloned) {
        eventsIdxById = new Map(eventsIdxById);
        eventsIndexCloned = true;
      }
      return eventsIdxById;
    },

    invalidateEventsIndex() {
      eventsIdxById = null;
      eventsIndexCloned = false;
    },

    ensurePlacesById(forMutation = false) {
      if (placesById === null) {
        const map = new Map<string, Place>();
        for (const pl of places) {
          map.set(pl.id, pl);
        }
        placesById = map;
        if (!this.placesMutated) {
          baseMemo.placesById = placesById;
          placesIndexCloned = false;
        } else {
          placesIndexCloned = true;
        }
      }
      if (forMutation && !placesIndexCloned) {
        placesById = new Map(placesById);
        placesIndexCloned = true;
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
        if (!peopleIndexCloned) {
          baseMemo.publicLivingPattern = cachedLivingPattern;
          baseMemo.publicLivingPatternComputed = true;
        }
      }
      return cachedLivingPattern;
    },

    getLivingRedactedCount() {
      return livingIds !== null ? livingIds.size : previousBundle.meta.counts.living_redacted;
    },

    buildDerivedMemo(): BundleIndexMemo {
      return {
        peopleIdxById,
        livingIds,
        eventsIdxById,
        placesById,
        publicLivingPatternComputed: !livingPatternDirty && mode === 'public',
        publicLivingPattern: !livingPatternDirty && mode === 'public' ? cachedLivingPattern : null,
      };
    },
  };
}

export function binarySearchEventInsertIndex(events: readonly ArchiveEvent[], target: ArchiveEvent): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midEv = events[mid];
    if (midEv && compareArchiveEvents(midEv, target) <= 0) {
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
  deleted: boolean,
  state?: Pick<PatchWorkingState, 'previousBundle' | 'markUncitedChanged'>
): void {
  if (entityType === 'kinship_edge') {
    return;
  }
  const shouldBeUncited = !deleted && hasPrimarySource === false;
  // Fast short-circuit when the previous bundle had zero uncited entities and this mutation is cited!
  if (!shouldBeUncited && state && !state.previousBundle.meta.uncited_entity_keys) {
    return;
  }
  const key = `${entityType}:${entityId}`;
  if (!shouldBeUncited) {
    if (uncitedKeys.delete(key)) {
      state?.markUncitedChanged();
    }
  } else if (!uncitedKeys.has(key)) {
    uncitedKeys.add(key);
    state?.markUncitedChanged();
  }
}

export function resolveEffectivePrimarySource(
  entity: { has_primary_source?: boolean | undefined },
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
