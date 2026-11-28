import type {
  ArchiveBundle,
  ArchiveEvent,
  BranchConfig,
  KinloomSiteConfig,
  Narrative,
  Person,
  Place,
  ResidenceSpan,
} from '@kinloom/core';
import { fastLocaleCompare, resolveDefaultBranchId } from '@kinloom/core';
import { isRedactedLivingPlaceholder } from './tree/types.js';

export type PeopleDirectoryView = 'era' | 'az';

export type EraBandId =
  | 'before-1700'
  | '1700s'
  | '1800-1849'
  | '1850-1899'
  | '1900-1949'
  | '1950-plus'
  | 'undated';

export interface EraBandDefinition {
  readonly id: EraBandId;
  readonly heading: string;
  readonly shortLabel: string;
  readonly subtitle: string;
  readonly minYear: number | null;
  readonly maxYear: number | null;
  /** Canonical snapshot year inside [1600, 1995] for /time?year=... scent link. */
  readonly snapshotYear: number | null;
}

export const PEOPLE_DIRECTORY_ERA_BANDS: readonly EraBandDefinition[] = [
  {
    id: 'before-1700',
    heading: 'Before 1700',
    shortLabel: 'Before 1700',
    subtitle: '',
    minYear: null,
    maxYear: 1699,
    snapshotYear: 1665,
  },
  {
    id: '1700s',
    heading: '1700s',
    shortLabel: '1700s',
    subtitle: '',
    minYear: 1700,
    maxYear: 1799,
    snapshotYear: 1750,
  },
  {
    id: '1800-1849',
    heading: '1800–1849',
    shortLabel: '1800–49',
    subtitle: '',
    minYear: 1800,
    maxYear: 1849,
    snapshotYear: 1850,
  },
  {
    id: '1850-1899',
    heading: '1850–1899',
    shortLabel: '1850–99',
    subtitle: '',
    minYear: 1850,
    maxYear: 1899,
    snapshotYear: 1880,
  },
  {
    id: '1900-1949',
    heading: '1900–1949',
    shortLabel: '1900–49',
    subtitle: '',
    minYear: 1900,
    maxYear: 1949,
    snapshotYear: 1925,
  },
  {
    id: '1950-plus',
    heading: '1950 & Later',
    shortLabel: '1950+',
    subtitle: '',
    minYear: 1950,
    maxYear: null,
    snapshotYear: 1970,
  },
  {
    id: 'undated',
    heading: 'Undated',
    shortLabel: 'Undated',
    subtitle: 'Birth year not yet documented',
    minYear: null,
    maxYear: null,
    snapshotYear: null,
  },
] as const;

export const DIRECTORY_JUMP_STRIP_THRESHOLD = 25;
export const DIRECTORY_SECTION_CAP_TRIGGER = 24;
export const DIRECTORY_SECTION_INITIAL_VISIBLE = 18;
export const LIVING_AUTO_COLLAPSE_THRESHOLD = 12;
export const FRONTISPIECE_MAX_LINKS = 4;
export const PHOTO_FILTER_SATURATION_RATIO = 0.85;

export interface HistoricalDirectorySection {
  readonly kind: 'historical';
  readonly eraId: EraBandId;
  readonly id: string;
  readonly heading: string;
  readonly shortLabel: string;
  readonly subtitle: string;
  readonly snapshotYear: number | null;
  readonly people: readonly Person[];
}

export interface AlphabeticalDirectorySection {
  readonly kind: 'az';
  readonly letter: string;
  readonly id: string;
  readonly heading: string;
  readonly shortLabel: string;
  readonly snapshotYear: null;
  readonly people: readonly Person[];
}

export type DirectorySection = HistoricalDirectorySection | AlphabeticalDirectorySection;

export interface DirectoryJumpItem {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly isLiving?: boolean;
}

export interface PeopleDirectoryFilterState {
  readonly view: PeopleDirectoryView;
  readonly branch: string;
  readonly onlyWithPhotos: boolean;
  readonly query: string;
}

export interface PeopleDirectoryModel {
  readonly publicPeople: readonly Person[];
  readonly populatedBranches: readonly BranchConfig[];
  readonly branchCounts: Readonly<Record<string, number>>;
  readonly withPhotosCount: number;
  readonly isPhotoFilterSaturated: boolean;
  readonly activeFilterCount: number;
  readonly filteredPeople: readonly Person[];
  readonly sections: readonly DirectorySection[];
  readonly livingPeople: readonly Person[];
  readonly showJumpStrip: boolean;
  readonly autoCollapseLiving: boolean;
  readonly jumpItems: readonly DirectoryJumpItem[];
  readonly storyHooks: ReadonlyMap<string, string>;
}

export interface ArchiveFrontispieceLink {
  readonly label: string;
  readonly to: string;
}

export interface ArchiveFrontispieceConfig {
  readonly kicker?: string;
  readonly headline?: string;
  readonly intro: string;
  readonly image?: string;
  readonly imageAlt?: string;
  readonly imageCaption?: string;
  readonly featuredLinks?: readonly ArchiveFrontispieceLink[];
}

export interface ResolvedArchiveFrontispiece {
  readonly kicker: string | null;
  readonly headline: string;
  readonly intro: string;
  readonly metadataLine: string | null;
  readonly image: string | null;
  readonly imageAlt: string;
  readonly imageCaption: string | null;
  readonly featuredLinks: readonly ArchiveFrontispieceLink[];
  readonly isEditorialFrontispiece: boolean;
}

const DEFAULT_ARCHIVE_DESCRIPTION =
  'Primary sources, historical places, and documented lineage woven into one archive.';

export function isRedactedLivingPerson(person: Person): boolean {
  return isRedactedLivingPlaceholder(person);
}

export function hasPersonPhotoOrMedia(person: Person): boolean {
  return (person.media_count || 0) > 0 || Boolean(person.portrait_url);
}

export function countActiveDirectoryFilters(
  filter: Pick<PeopleDirectoryFilterState, 'query' | 'branch' | 'onlyWithPhotos'>
): number {
  return (
    (filter.query.trim().length > 0 ? 1 : 0) +
    (filter.branch !== 'all' ? 1 : 0) +
    (filter.onlyWithPhotos ? 1 : 0)
  );
}

export function isPhotoFilterSaturated(withPhotosCount: number, totalCount: number): boolean {
  return totalCount > 0 && withPhotosCount / totalCount >= PHOTO_FILTER_SATURATION_RATIO;
}

const STORY_EVENT_CATEGORY_RANK: Readonly<Record<string, number>> = {
  migration: 0,
  homestead: 0,
  career: 0,
  occupation: 0,
  military: 0,
  public_office: 0,
  service: 0,
  life_milestone: 2,
  vital: 2,
  birth: 2,
  death: 2,
  burial: 2,
};

const STORY_PARTICIPANT_ROLES = new Set(['principal', 'spouse', 'subject']);

function rankStoryEventCategory(category: string | null | undefined): number {
  const normalized = category?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return 2;
  }
  return STORY_EVENT_CATEGORY_RANK[normalized] ?? 1;
}

const ABBREVIATION_BEFORE_PERIOD_RE =
  /(?:\b(?:Jr|Sr|Dr|Mr|Mrs|Ms|St|Capt|Maj|Gen|Rev|Col|Lt|Hon|Gov|Sen|Pres|No|Vol|p|pp)|[A-Z]\.[A-Z])$/i;

function cleanStoryHookText(raw: string, options?: { readonly firstSentenceOnly?: boolean }): string {
  const stripped = raw
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) {
    return '';
  }
  if (!options?.firstSentenceOnly) {
    return stripped;
  }
  let searchFrom = 20;
  while (searchFrom < stripped.length) {
    const idx = stripped.indexOf('. ', searchFrom);
    if (idx === -1) {
      break;
    }
    const prefix = stripped.slice(0, idx);
    if (!ABBREVIATION_BEFORE_PERIOD_RE.test(prefix)) {
      return stripped.slice(0, idx + 1);
    }
    searchFrom = idx + 2;
  }
  return stripped;
}

function stripLeadingPersonName(hook: string, fullName: string): string {
  const name = fullName.trim();
  if (!name || !hook.startsWith(`${name} `)) {
    return hook;
  }
  const rest = hook.slice(name.length + 1).trim();
  if (rest.length < 12 || !/^[a-z]/.test(rest)) {
    return hook;
  }
  return `${rest[0]?.toUpperCase() ?? ''}${rest.slice(1)}`;
}

function compareStoryNarratives(a: Narrative, b: Narrative): number {
  const aBio = a.kind === 'biography' ? 0 : 1;
  const bBio = b.kind === 'biography' ? 0 : 1;
  if (aBio !== bBio) {
    return aBio - bBio;
  }
  return fastLocaleCompare(a.id, b.id);
}

function compareStoryEvents(a: ArchiveEvent, b: ArchiveEvent): number {
  const rankDiff = rankStoryEventCategory(a.category) - rankStoryEventCategory(b.category);
  if (rankDiff !== 0) {
    return rankDiff;
  }
  const aYear = a.year ?? Number.POSITIVE_INFINITY;
  const bYear = b.year ?? Number.POSITIVE_INFINITY;
  if (aYear !== bYear) {
    return aYear - bYear;
  }
  return fastLocaleCompare(a.id, b.id);
}

function compareResidenceSpans(a: ResidenceSpan, b: ResidenceSpan): number {
  const aStart = a.start_year ?? a.time_min;
  const bStart = b.start_year ?? b.time_min;
  if (aStart !== bStart) {
    return aStart - bStart;
  }
  return fastLocaleCompare(a.id, b.id);
}

function buildResidenceJourneyHook(
  spans: readonly ResidenceSpan[],
  placesById: ReadonlyMap<string, Place>
): string | null {
  const ordered = spans.toSorted(compareResidenceSpans);
  const distinctPlaces: string[] = [];
  for (const span of ordered) {
    const placeName = placesById.get(span.place_id)?.name.trim();
    if (placeName && !distinctPlaces.includes(placeName)) {
      distinctPlaces.push(placeName);
    }
  }
  if (distinctPlaces.length < 2) {
    return null;
  }
  return distinctPlaces.slice(0, 3).join(' → ');
}

function selectPersonStoryHookFromSlices(params: {
  readonly person: Person;
  readonly narratives: readonly Narrative[];
  readonly events: readonly ArchiveEvent[];
  readonly residenceSpans: readonly ResidenceSpan[];
  readonly placesById: ReadonlyMap<string, Place>;
}): string | null {
  const { person, narratives, events, residenceSpans, placesById } = params;
  // Never derive narrative, event, or residence hooks for living people.
  if (person.is_living || isRedactedLivingPerson(person)) {
    return null;
  }

  for (const narrative of narratives.toSorted(compareStoryNarratives)) {
    const cleaned = cleanStoryHookText(narrative.summary ?? '', { firstSentenceOnly: true });
    if (cleaned) {
      return stripLeadingPersonName(cleaned, person.full_name);
    }
  }

  for (const event of events.toSorted(compareStoryEvents)) {
    const cleaned = cleanStoryHookText(event.title);
    if (cleaned) {
      return stripLeadingPersonName(cleaned, person.full_name);
    }
  }

  return buildResidenceJourneyHook(residenceSpans, placesById);
}

export function buildPersonStoryHookMap(
  bundle: ArchiveBundle | null,
  placesById: ReadonlyMap<string, Place>
): ReadonlyMap<string, string> {
  const hooks = new Map<string, string>();
  if (!bundle) {
    return hooks;
  }

  const eligibleIds = new Set<string>();
  for (const person of bundle.people) {
    if (!person.is_living && !isRedactedLivingPerson(person)) {
      eligibleIds.add(person.id);
    }
  }

  const narrativesByPerson = new Map<string, Narrative[]>();
  for (const narrative of bundle.narratives ?? []) {
    const subjectId = narrative.subject_person_id;
    if (!subjectId || !eligibleIds.has(subjectId) || !narrative.summary?.trim()) {
      continue;
    }
    const list = narrativesByPerson.get(subjectId);
    if (list) {
      list.push(narrative);
    } else {
      narrativesByPerson.set(subjectId, [narrative]);
    }
  }

  const eventsByPerson = new Map<string, ArchiveEvent[]>();
  for (const event of bundle.events) {
    if (event.scope !== 'personal' && event.scope !== 'family') {
      continue;
    }
    if (!event.title.trim()) {
      continue;
    }
    for (const participant of event.participants) {
      if (!eligibleIds.has(participant.person_id) || !STORY_PARTICIPANT_ROLES.has(participant.role)) {
        continue;
      }
      const list = eventsByPerson.get(participant.person_id);
      if (list) {
        list.push(event);
      } else {
        eventsByPerson.set(participant.person_id, [event]);
      }
    }
  }

  const spansByPerson = new Map<string, ResidenceSpan[]>();
  for (const span of bundle.residence_spans) {
    if (!eligibleIds.has(span.person_id)) {
      continue;
    }
    const list = spansByPerson.get(span.person_id);
    if (list) {
      list.push(span);
    } else {
      spansByPerson.set(span.person_id, [span]);
    }
  }

  for (const person of bundle.people) {
    if (!eligibleIds.has(person.id)) {
      continue;
    }
    const hook = selectPersonStoryHookFromSlices({
      person,
      narratives: narrativesByPerson.get(person.id) ?? [],
      events: eventsByPerson.get(person.id) ?? [],
      residenceSpans: spansByPerson.get(person.id) ?? [],
      placesById,
    });
    if (hook) {
      hooks.set(person.id, hook);
    }
  }

  return hooks;
}

export function resolvePersonStoryHook(params: {
  readonly person: Person;
  readonly bundle: ArchiveBundle | null;
  readonly placesById: ReadonlyMap<string, Place>;
}): string | null {
  const { person, bundle, placesById } = params;
  if (!bundle || person.is_living || isRedactedLivingPerson(person)) {
    return null;
  }
  const narratives = (bundle.narratives ?? []).filter(
    (n) => n.subject_person_id === person.id && Boolean(n.summary?.trim())
  );
  const events = bundle.events.filter(
    (e) =>
      (e.scope === 'personal' || e.scope === 'family') &&
      Boolean(e.title.trim()) &&
      e.participants.some((pt) => pt.person_id === person.id && STORY_PARTICIPANT_ROLES.has(pt.role))
  );
  const residenceSpans = bundle.residence_spans.filter((s) => s.person_id === person.id);
  return selectPersonStoryHookFromSlices({ person, narratives, events, residenceSpans, placesById });
}

export function buildDirectoryJumpTargetId(sectionId: string): string {
  return `dir-sec-${sectionId}`;
}

export function resolveEraBandId(birthYear: number | null): EraBandId {
  if (birthYear === null) {
    return 'undated';
  }
  if (birthYear < 1700) {
    return 'before-1700';
  }
  if (birthYear <= 1799) {
    return '1700s';
  }
  if (birthYear <= 1849) {
    return '1800-1849';
  }
  if (birthYear <= 1899) {
    return '1850-1899';
  }
  if (birthYear <= 1949) {
    return '1900-1949';
  }
  return '1950-plus';
}

export function compareByBirthThenName(a: Person, b: Person): number {
  if (a.birth_year === null && b.birth_year === null) {
    return fastLocaleCompare(a.full_name, b.full_name);
  }
  if (a.birth_year === null) {
    return 1;
  }
  if (b.birth_year === null) {
    return -1;
  }
  return a.birth_year - b.birth_year || fastLocaleCompare(a.full_name, b.full_name);
}

export function extractSurnameSortKey(person: Person): string {
  const explicitSurname = person.surname.trim();
  if (explicitSurname.length > 0) {
    return explicitSurname;
  }
  const tokens = person.full_name.trim().split(/\s+/).filter(Boolean);
  return tokens.at(-1) ?? '';
}

export function extractAlphabetBucket(person: Person): string {
  const key = extractSurnameSortKey(person);
  if (!key) {
    return '#';
  }
  const normalized = key
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase();
  const initial = normalized[0] ?? '';
  return /^[A-Z]$/.test(initial) ? initial : '#';
}

export function compareBySurnameThenGiven(a: Person, b: Person): number {
  const surnameDiff = fastLocaleCompare(extractSurnameSortKey(a), extractSurnameSortKey(b));
  if (surnameDiff !== 0) {
    return surnameDiff;
  }
  const givenDiff = fastLocaleCompare(a.given_name.trim(), b.given_name.trim());
  if (givenDiff !== 0) {
    return givenDiff;
  }
  return compareByBirthThenName(a, b);
}

export function computeDirectoryBranchCounts(
  publicPeople: readonly Person[],
  defaultBranchId: string
): Record<string, number> {
  const counts: Record<string, number> = { all: publicPeople.length };
  for (const person of publicPeople) {
    const branchId = person.branch || defaultBranchId;
    counts[branchId] = (counts[branchId] || 0) + 1;
  }
  return counts;
}

function matchesSearchQuery(
  person: Person,
  normalizedQuery: string,
  placesById: ReadonlyMap<string, Place>
): boolean {
  if (!normalizedQuery) {
    return true;
  }
  if (person.full_name.toLowerCase().includes(normalizedQuery)) {
    return true;
  }
  if (person.surname.toLowerCase().includes(normalizedQuery)) {
    return true;
  }
  if (person.alt_names.some((alt) => alt.toLowerCase().includes(normalizedQuery))) {
    return true;
  }
  const placeName = person.primary_place_id ? (placesById.get(person.primary_place_id)?.full_name ?? '') : '';
  return placeName.toLowerCase().includes(normalizedQuery);
}

export function buildPeopleDirectoryModel(params: {
  readonly bundle: ArchiveBundle | null;
  readonly siteConfig: KinloomSiteConfig;
  readonly placesById: ReadonlyMap<string, Place>;
  readonly filter: PeopleDirectoryFilterState;
}): PeopleDirectoryModel {
  const { bundle, siteConfig, placesById, filter } = params;
  const publicPeople = bundle ? bundle.people.filter((p) => !isRedactedLivingPerson(p)) : [];
  const defaultBranchId = resolveDefaultBranchId(siteConfig);
  const branchCounts = computeDirectoryBranchCounts(publicPeople, defaultBranchId);
  const populatedBranches = siteConfig.branches.filter((b) => (branchCounts[b.id] || 0) > 0);

  const activeBranch =
    filter.branch !== 'all' && populatedBranches.some((b) => b.id === filter.branch) ? filter.branch : 'all';

  const branchScopedPeople =
    activeBranch === 'all'
      ? publicPeople
      : publicPeople.filter((p) => (p.branch || defaultBranchId) === activeBranch);

  const withPhotosCount = branchScopedPeople.filter(hasPersonPhotoOrMedia).length;
  const photoFilterSaturated = isPhotoFilterSaturated(withPhotosCount, branchScopedPeople.length);
  const activeFilterCount = countActiveDirectoryFilters({
    query: filter.query,
    branch: activeBranch,
    onlyWithPhotos: filter.onlyWithPhotos,
  });
  const storyHooks = buildPersonStoryHookMap(bundle, placesById);
  const normalizedQuery = filter.query.trim().toLowerCase();

  const filteredPeople = branchScopedPeople.filter((person) => {
    if (filter.onlyWithPhotos && !hasPersonPhotoOrMedia(person)) {
      return false;
    }
    return matchesSearchQuery(person, normalizedQuery, placesById);
  });

  if (filter.view === 'az') {
    const byLetter = new Map<string, Person[]>();
    for (const person of filteredPeople) {
      const bucket = extractAlphabetBucket(person);
      const list = byLetter.get(bucket);
      if (list) {
        list.push(person);
      } else {
        byLetter.set(bucket, [person]);
      }
    }

    const sortedLetters = [...byLetter.keys()].toSorted((a, b) => {
      if (a === '#') {
        return 1;
      }
      if (b === '#') {
        return -1;
      }
      return a.localeCompare(b);
    });

    const sections: AlphabeticalDirectorySection[] = sortedLetters.map((letter) => {
      const people = (byLetter.get(letter) ?? []).toSorted(compareBySurnameThenGiven);
      const sectionKey = letter === '#' ? 'other' : letter.toLowerCase();
      return {
        kind: 'az',
        letter,
        id: `az-${sectionKey}`,
        heading: letter,
        shortLabel: letter,
        snapshotYear: null,
        people,
      };
    });

    const jumpItems: DirectoryJumpItem[] = sections.map((sec) => ({
      id: buildDirectoryJumpTargetId(sec.id),
      label: sec.shortLabel,
      count: sec.people.length,
    }));

    return {
      publicPeople,
      populatedBranches,
      branchCounts,
      withPhotosCount,
      isPhotoFilterSaturated: photoFilterSaturated,
      activeFilterCount,
      filteredPeople,
      sections,
      livingPeople: [],
      showJumpStrip: filteredPeople.length > DIRECTORY_JUMP_STRIP_THRESHOLD,
      autoCollapseLiving: false,
      jumpItems,
      storyHooks,
    };
  }

  const buckets = new Map<EraBandId, Person[]>();
  const livingRaw: Person[] = [];

  for (const person of filteredPeople) {
    if (person.is_living) {
      livingRaw.push(person);
      continue;
    }
    const eraId = resolveEraBandId(person.birth_year);
    const list = buckets.get(eraId);
    if (list) {
      list.push(person);
    } else {
      buckets.set(eraId, [person]);
    }
  }

  const sections: HistoricalDirectorySection[] = [];
  for (const band of PEOPLE_DIRECTORY_ERA_BANDS) {
    const matched = buckets.get(band.id);
    if (!matched || matched.length === 0) {
      continue;
    }
    sections.push({
      kind: 'historical',
      eraId: band.id,
      id: band.id,
      heading: band.heading,
      shortLabel: band.shortLabel,
      subtitle: band.subtitle,
      snapshotYear: band.snapshotYear,
      people: matched.toSorted(compareByBirthThenName),
    });
  }

  const livingPeople = livingRaw.toSorted(compareBySurnameThenGiven);
  const autoCollapseLiving =
    livingPeople.length > LIVING_AUTO_COLLAPSE_THRESHOLD && normalizedQuery.length === 0;

  const jumpItems: DirectoryJumpItem[] = sections.map((sec) => ({
    id: buildDirectoryJumpTargetId(sec.id),
    label: sec.shortLabel,
    count: sec.people.length,
  }));

  if (livingPeople.length > 0) {
    jumpItems.push({
      id: buildDirectoryJumpTargetId('living'),
      label: 'Living',
      count: livingPeople.length,
      isLiving: true,
    });
  }

  return {
    publicPeople,
    populatedBranches,
    branchCounts,
    withPhotosCount,
    isPhotoFilterSaturated: photoFilterSaturated,
    activeFilterCount,
    filteredPeople,
    sections,
    livingPeople,
    showJumpStrip: filteredPeople.length > DIRECTORY_JUMP_STRIP_THRESHOLD,
    autoCollapseLiving,
    jumpItems,
    storyHooks,
  };
}

export function computeVisibleSectionPeople(params: {
  readonly people: readonly Person[];
  readonly isExpanded: boolean;
  readonly hasActiveQuery: boolean;
}): {
  readonly visible: readonly Person[];
  readonly hiddenCount: number;
} {
  const { people, isExpanded, hasActiveQuery } = params;
  if (people.length > DIRECTORY_SECTION_CAP_TRIGGER && !isExpanded && !hasActiveQuery) {
    return {
      visible: people.slice(0, DIRECTORY_SECTION_INITIAL_VISIBLE),
      hiddenCount: people.length - DIRECTORY_SECTION_INITIAL_VISIBLE,
    };
  }
  return {
    visible: people,
    hiddenCount: 0,
  };
}

export function formatLivingLifespan(person: Person): string {
  return person.birth_year !== null ? `b. ${person.birth_year} · Living` : 'Living';
}

export function formatPersonDirectoryLifespan(person: Person): string {
  if (person.is_living) {
    return formatLivingLifespan(person);
  }
  if (person.birth_year === null && person.death_year === null) {
    return 'Dates unknown';
  }
  return `${person.birth_year ?? '?'} – ${person.death_year ?? '?'}`;
}

export function parseDirectoryUrlParams(
  searchParams: URLSearchParams,
  populatedBranches: readonly BranchConfig[]
): {
  readonly view: PeopleDirectoryView;
  readonly branch: string;
} {
  const view: PeopleDirectoryView = searchParams.get('view') === 'az' ? 'az' : 'era';
  const rawBranch = searchParams.get('branch') ?? 'all';
  const branch = rawBranch !== 'all' && populatedBranches.some((b) => b.id === rawBranch) ? rawBranch : 'all';
  return { view, branch };
}

export function buildDirectoryUrlParams(
  current: URLSearchParams,
  patch: {
    readonly view?: PeopleDirectoryView;
    readonly branch?: string;
  }
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (patch.view !== undefined) {
    next.set('view', patch.view);
  }
  if (patch.branch !== undefined) {
    if (patch.branch === 'all') {
      next.delete('branch');
    } else {
      next.set('branch', patch.branch);
    }
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSafeInternalRoute(route: string): boolean {
  return route.startsWith('/') && !route.startsWith('//');
}

function parseFrontispieceExtension(raw: unknown): ArchiveFrontispieceConfig | null {
  if (!isRecord(raw)) {
    return null;
  }
  const intro = readNonEmptyString(raw.intro);
  if (!intro) {
    return null;
  }

  const featuredLinks: ArchiveFrontispieceLink[] = [];
  if (Array.isArray(raw.featuredLinks)) {
    for (const item of raw.featuredLinks) {
      if (featuredLinks.length >= FRONTISPIECE_MAX_LINKS) {
        break;
      }
      if (!isRecord(item)) {
        continue;
      }
      const label = readNonEmptyString(item.label);
      const to = readNonEmptyString(item.to);
      if (label && to && isSafeInternalRoute(to)) {
        featuredLinks.push({ label, to });
      }
    }
  }

  return {
    kicker: readNonEmptyString(raw.kicker),
    headline: readNonEmptyString(raw.headline),
    intro,
    image: readNonEmptyString(raw.image),
    imageAlt: readNonEmptyString(raw.imageAlt),
    imageCaption: readNonEmptyString(raw.imageCaption),
    featuredLinks,
  };
}

export function buildArchiveSummaryLine(bundle: ArchiveBundle | null): string | null {
  if (!bundle) {
    return null;
  }
  const publicPeople = bundle.people.filter((p) => !isRedactedLivingPerson(p));
  if (publicPeople.length === 0) {
    return null;
  }

  const parts: string[] = [`${publicPeople.length} ${publicPeople.length === 1 ? 'person' : 'people'}`];

  if (bundle.places.length > 0) {
    parts.push(`${bundle.places.length} ${bundle.places.length === 1 ? 'place' : 'places'}`);
  }

  let minYear: number | null = null;
  let maxYear: number | null = null;
  for (const person of publicPeople) {
    if (person.birth_year !== null) {
      minYear = minYear === null ? person.birth_year : Math.min(minYear, person.birth_year);
      maxYear = maxYear === null ? person.birth_year : Math.max(maxYear, person.birth_year);
    }
    if (person.death_year !== null) {
      minYear = minYear === null ? person.death_year : Math.min(minYear, person.death_year);
      maxYear = maxYear === null ? person.death_year : Math.max(maxYear, person.death_year);
    }
  }

  if (minYear !== null && maxYear !== null) {
    parts.push(minYear === maxYear ? `${minYear}` : `${minYear}–${maxYear}`);
  }

  return parts.join(' · ');
}

export function resolveArchiveFrontispiece(
  siteConfig: KinloomSiteConfig,
  bundle: ArchiveBundle | null
): ResolvedArchiveFrontispiece {
  const custom = parseFrontispieceExtension(siteConfig.extensions?.frontispiece);
  const computedSummary = buildArchiveSummaryLine(bundle);
  const metadataLine = readNonEmptyString(siteConfig.brand?.metadataLine) ?? computedSummary;

  if (custom) {
    const headline = custom.headline ?? siteConfig.site.familyName;
    return {
      kicker: custom.kicker ?? null,
      headline,
      intro: custom.intro,
      metadataLine,
      image: custom.image ?? readNonEmptyString(siteConfig.brand?.vignetteImage) ?? null,
      imageAlt: custom.imageAlt ?? `${headline} archival frontispiece`,
      imageCaption: custom.imageCaption ?? null,
      featuredLinks: custom.featuredLinks ?? [],
      isEditorialFrontispiece: true,
    };
  }

  const brandVignette = readNonEmptyString(siteConfig.brand?.vignetteImage) ?? null;
  const brandSubtitle = readNonEmptyString(siteConfig.brand?.subtitle);
  const headline = siteConfig.site.familyName;
  const intro =
    brandSubtitle ?? readNonEmptyString(siteConfig.site.description) ?? DEFAULT_ARCHIVE_DESCRIPTION;

  return {
    kicker: null,
    headline,
    intro,
    metadataLine,
    image: brandVignette,
    imageAlt: readNonEmptyString(siteConfig.brand?.ogImageAlt) ?? `${headline} archival vignette`,
    imageCaption: null,
    featuredLinks: [],
    isEditorialFrontispiece: Boolean(brandVignette || brandSubtitle),
  };
}
