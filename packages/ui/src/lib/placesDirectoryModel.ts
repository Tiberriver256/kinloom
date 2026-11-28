import type { MigrationEraConfig, Place, PlaceDirectoryEntry } from '@kinloom/core';
import { fastLocaleCompare } from '@kinloom/core';

export type PlacesDirectoryView = 'region' | 'era' | 'az';

export type PlaceEraBandId = 'before-1700' | '1700s' | '1800-1849' | '1850-1899' | '1900-plus' | 'undated';

export interface PlaceEraBandDefinition {
  readonly id: PlaceEraBandId;
  readonly heading: string;
  readonly shortLabel: string;
  readonly minYear: number | null;
  readonly maxYear: number | null;
  readonly snapshotYear: number | null;
}

export const PLACES_DIRECTORY_ERA_BANDS: readonly PlaceEraBandDefinition[] = [
  {
    id: 'before-1700',
    heading: 'Before 1700',
    shortLabel: 'Before 1700',
    minYear: null,
    maxYear: 1699,
    snapshotYear: 1665,
  },
  {
    id: '1700s',
    heading: '1700s',
    shortLabel: '1700s',
    minYear: 1700,
    maxYear: 1799,
    snapshotYear: 1750,
  },
  {
    id: '1800-1849',
    heading: '1800–1849',
    shortLabel: '1800–49',
    minYear: 1800,
    maxYear: 1849,
    snapshotYear: 1825,
  },
  {
    id: '1850-1899',
    heading: '1850–1899',
    shortLabel: '1850–99',
    minYear: 1850,
    maxYear: 1899,
    snapshotYear: 1875,
  },
  {
    id: '1900-plus',
    heading: '1900s & Later',
    shortLabel: '1900s+',
    minYear: 1900,
    maxYear: null,
    snapshotYear: 1925,
  },
  {
    id: 'undated',
    heading: 'Undated',
    shortLabel: 'Undated',
    minYear: null,
    maxYear: null,
    snapshotYear: null,
  },
] as const;

export const PLACES_JUMP_STRIP_THRESHOLD = 25;
export const PLACES_SECTION_CAP_TRIGGER = 24;
export const PLACES_SECTION_INITIAL_VISIBLE = 18;

export interface PlacesSectionScentLink {
  readonly to: string;
  readonly label: string;
}

export interface PlacesDirectorySection {
  readonly id: string;
  readonly heading: string;
  readonly shortLabel: string;
  readonly subtitle?: string;
  readonly entries: readonly PlaceDirectoryEntry[];
  readonly scentLink: PlacesSectionScentLink | null;
}

export interface PlacesSectionSlice {
  readonly visible: readonly PlaceDirectoryEntry[];
  readonly hiddenCount: number;
  readonly isCapped: boolean;
}

export interface ParsedPlaceRegion {
  readonly key: string;
  readonly heading: string;
  readonly shortLabel: string;
}

const KNOWN_COUNTRIES = new Set([
  'united states',
  'usa',
  'u.s.a.',
  'us',
  'united kingdom',
  'uk',
  'england',
  'scotland',
  'wales',
  'ireland',
  'northern ireland',
  'canada',
  'netherlands',
  'the netherlands',
  'germany',
  'france',
  'sweden',
  'norway',
  'denmark',
  'finland',
  'iceland',
  'belgium',
  'austria',
  'switzerland',
  'italy',
  'poland',
  'australia',
  'new zealand',
  'mexico',
]);

const PLACE_TYPE_ORDER: Readonly<Record<string, number>> = {
  country: 0,
  state: 1,
  county: 2,
  town: 3,
  homestead: 4,
};

function slugifySectionKey(raw: string): string {
  const cleaned = raw
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .replaceAll(/[øØ]/g, 'o')
    .replaceAll(/[æÆ]/g, 'ae')
    .replaceAll(/[åÅ]/g, 'a')
    .replaceAll(/[ðÐ]/g, 'd')
    .replaceAll(/[þÞ]/g, 'th')
    .replaceAll(/ß/g, 'ss')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return cleaned || 'other';
}

export function parsePlaceRegion(place: Pick<Place, 'name' | 'full_name' | 'place_type'>): ParsedPlaceRegion {
  const parts = place.full_name
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (parts.length === 0) {
    return { key: 'region-other', heading: 'Other Regions', shortLabel: 'Other' };
  }

  if (parts.length === 1) {
    const single = parts[0] ?? '';
    return {
      key: `region-${slugifySectionKey(single)}`,
      heading: single,
      shortLabel: single,
    };
  }

  const last = parts[parts.length - 1] ?? '';
  const secondLast = parts[parts.length - 2] ?? '';
  const lastLower = last.toLowerCase();

  if (KNOWN_COUNTRIES.has(lastLower)) {
    // If there are >= 3 parts (e.g. "Springfield, Sangamon County, Illinois, United States")
    // or 2 parts (e.g. "Illinois, United States"), group by "Region, Country"
    const normalizedCountry =
      lastLower === 'usa' || lastLower === 'u.s.a.' || lastLower === 'us' ? 'United States' : last;
    if (parts.length >= 2 && secondLast.toLowerCase() !== lastLower) {
      const heading = `${secondLast}, ${normalizedCountry}`;
      return {
        key: `region-${slugifySectionKey(normalizedCountry)}-${slugifySectionKey(secondLast)}`,
        heading,
        shortLabel: secondLast,
      };
    }
    return {
      key: `region-${slugifySectionKey(normalizedCountry)}`,
      heading: normalizedCountry,
      shortLabel: normalizedCountry,
    };
  }

  // No explicit country tail — last segment is typically State/Province/Region (e.g. "Springfield, Sangamon County, Illinois")
  return {
    key: `region-${slugifySectionKey(last)}`,
    heading: last,
    shortLabel: last,
  };
}

export function classifyPlaceEraBand(minYear: number | null): PlaceEraBandId {
  if (minYear === null || minYear <= 0) {
    return 'undated';
  }
  if (minYear < 1700) {
    return 'before-1700';
  }
  if (minYear < 1800) {
    return '1700s';
  }
  if (minYear < 1850) {
    return '1800-1849';
  }
  if (minYear < 1900) {
    return '1850-1899';
  }
  return '1900-plus';
}

export function getPlaceInitialLetter(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '#';
  }
  const normalized = trimmed.normalize('NFD').replaceAll(/\p{Diacritic}/gu, '');
  const first = normalized[0]?.toUpperCase() ?? '';
  return first >= 'A' && first <= 'Z' ? first : '#';
}

function compareEntriesByHierarchyAndName(a: PlaceDirectoryEntry, b: PlaceDirectoryEntry): number {
  const rankA = PLACE_TYPE_ORDER[a.place.place_type] ?? 5;
  const rankB = PLACE_TYPE_ORDER[b.place.place_type] ?? 5;
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  return fastLocaleCompare(a.place.name, b.place.name);
}

function compareEntriesByYearThenName(a: PlaceDirectoryEntry, b: PlaceDirectoryEntry): number {
  const yearA = a.minYear ?? Number.MAX_SAFE_INTEGER;
  const yearB = b.minYear ?? Number.MAX_SAFE_INTEGER;
  if (yearA !== yearB) {
    return yearA - yearB;
  }
  return fastLocaleCompare(a.place.name, b.place.name);
}

function resolveDominantStage(entries: readonly PlaceDirectoryEntry[]): string | null {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.stage && entry.stage !== 'all') {
      counts.set(entry.stage, (counts.get(entry.stage) ?? 0) + 1);
    }
  }
  let bestStage: string | null = null;
  let bestCount = 0;
  for (const [stageId, count] of counts) {
    if (count > bestCount) {
      bestStage = stageId;
      bestCount = count;
    }
  }
  return bestStage;
}

export function computeStageCounts(
  directory: readonly PlaceDirectoryEntry[],
  migrationEras: readonly MigrationEraConfig[]
): Record<string, number> {
  const counts: Record<string, number> = { all: directory.length };
  for (const era of migrationEras) {
    counts[era.id] = 0;
  }
  for (const entry of directory) {
    counts[entry.stage] = (counts[entry.stage] ?? 0) + 1;
  }
  return counts;
}

export function filterPlacesDirectory(params: {
  readonly directory: readonly PlaceDirectoryEntry[];
  readonly stage: string;
  readonly query: string;
}): PlaceDirectoryEntry[] {
  const { directory, stage, query } = params;
  const q = query.trim().toLowerCase();
  return directory.filter((entry) => {
    if (stage !== 'all' && entry.stage !== stage) {
      return false;
    }
    if (q) {
      const matchPlace = entry.place.full_name.toLowerCase().includes(q);
      const matchPerson = entry.people.some((p) => p.person.full_name.toLowerCase().includes(q));
      if (!matchPlace && !matchPerson) {
        return false;
      }
    }
    return true;
  });
}

export function buildPlacesDirectorySections(params: {
  readonly entries: readonly PlaceDirectoryEntry[];
  readonly view: PlacesDirectoryView;
}): PlacesDirectorySection[] {
  const { entries, view } = params;
  if (entries.length === 0) {
    return [];
  }

  if (view === 'region') {
    const groups = new Map<
      string,
      { region: ParsedPlaceRegion; items: PlaceDirectoryEntry[]; earliestYear: number }
    >();
    for (const entry of entries) {
      const region = parsePlaceRegion(entry.place);
      const existing = groups.get(region.key);
      const entryYear = entry.minYear ?? Number.MAX_SAFE_INTEGER;
      if (existing) {
        existing.items.push(entry);
        if (entryYear < existing.earliestYear) {
          existing.earliestYear = entryYear;
        }
      } else {
        groups.set(region.key, {
          region,
          items: [entry],
          earliestYear: entryYear,
        });
      }
    }

    return [...groups.values()]
      .toSorted(
        (a, b) => a.earliestYear - b.earliestYear || fastLocaleCompare(a.region.heading, b.region.heading)
      )
      .map((group) => {
        const sortedItems = group.items.toSorted(compareEntriesByHierarchyAndName);
        const dominantStage = resolveDominantStage(sortedItems);
        return {
          id: group.region.key,
          heading: group.region.heading,
          shortLabel: group.region.shortLabel,
          entries: sortedItems,
          scentLink: {
            to: dominantStage ? `/map?era=${encodeURIComponent(dominantStage)}` : '/map',
            label: 'View on Map →',
          },
        };
      });
  }

  if (view === 'era') {
    const buckets = new Map<PlaceEraBandId, PlaceDirectoryEntry[]>();
    for (const entry of entries) {
      const bandId = classifyPlaceEraBand(entry.minYear);
      const bucket = buckets.get(bandId);
      if (bucket) {
        bucket.push(entry);
      } else {
        buckets.set(bandId, [entry]);
      }
    }

    const sections: PlacesDirectorySection[] = [];
    for (const band of PLACES_DIRECTORY_ERA_BANDS) {
      const items = buckets.get(band.id);
      if (!items || items.length === 0) {
        continue;
      }
      const sortedItems = items.toSorted(compareEntriesByYearThenName);
      sections.push({
        id: `era-${band.id}`,
        heading: band.heading,
        shortLabel: band.shortLabel,
        entries: sortedItems,
        scentLink:
          band.snapshotYear !== null
            ? { to: `/time?year=${band.snapshotYear}`, label: 'Inspect in Time →' }
            : { to: '/map', label: 'View on Map →' },
      });
    }
    return sections;
  }

  // A–Z view
  const letterBuckets = new Map<string, PlaceDirectoryEntry[]>();
  for (const entry of entries) {
    const letter = getPlaceInitialLetter(entry.place.name);
    const bucket = letterBuckets.get(letter);
    if (bucket) {
      bucket.push(entry);
    } else {
      letterBuckets.set(letter, [entry]);
    }
  }

  return [...letterBuckets.entries()]
    .toSorted(([a], [b]) => {
      if (a === '#') {
        return 1;
      }
      if (b === '#') {
        return -1;
      }
      return a.localeCompare(b);
    })
    .map(([letter, items]) => ({
      id: `az-${letter === '#' ? 'other' : letter.toLowerCase()}`,
      heading: letter,
      shortLabel: letter,
      entries: items.toSorted((a, b) => fastLocaleCompare(a.place.name, b.place.name)),
      scentLink: null,
    }));
}

export function slicePlacesSection(
  entries: readonly PlaceDirectoryEntry[],
  expanded: boolean
): PlacesSectionSlice {
  if (!expanded && entries.length > PLACES_SECTION_CAP_TRIGGER) {
    return {
      visible: entries.slice(0, PLACES_SECTION_INITIAL_VISIBLE),
      hiddenCount: entries.length - PLACES_SECTION_INITIAL_VISIBLE,
      isCapped: true,
    };
  }
  return {
    visible: entries,
    hiddenCount: 0,
    isCapped: false,
  };
}

export interface PlacesDirectoryQueryState {
  readonly view: PlacesDirectoryView;
  readonly stage: string;
  readonly query: string;
}

export function parsePlacesDirectorySearchParams(
  searchParams: URLSearchParams,
  validStageIds: ReadonlySet<string>
): PlacesDirectoryQueryState {
  const rawView = searchParams.get('view');
  const view: PlacesDirectoryView =
    rawView === 'era' || rawView === 'az' || rawView === 'region' ? rawView : 'region';

  const rawStage = searchParams.get('stage')?.trim() ?? '';
  const stage = rawStage && validStageIds.has(rawStage) ? rawStage : 'all';

  const query = searchParams.get('q') ?? '';
  return { view, stage, query };
}

export function buildPlacesDirectorySearchParams(state: PlacesDirectoryQueryState): URLSearchParams {
  const next = new URLSearchParams();
  if (state.view !== 'region') {
    next.set('view', state.view);
  }
  if (state.stage !== 'all') {
    next.set('stage', state.stage);
  }
  const trimmed = state.query.trim();
  if (trimmed) {
    next.set('q', state.query);
  }
  return next;
}
