import type {
  ArchiveBundle,
  ArchiveEvent,
  EntityPayload,
  MediaItem,
  Person,
  ResidenceSpan,
} from '@kinloom/core';
import { getMediaPersonIds } from '@kinloom/core';
import { isRedactedLivingPlaceholder } from '../../lib/tree/types.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';

export type PersonLightboxState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'gallery'; readonly index: number }
  | { readonly kind: 'single'; readonly media: MediaItem };

export interface ImmediateFamilyEntry {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly years: string;
  readonly isLiving?: boolean;
}

export interface ImmediateFamilySummary {
  readonly parents: readonly ImmediateFamilyEntry[];
  readonly spouses: readonly ImmediateFamilyEntry[];
  readonly children: readonly ImmediateFamilyEntry[];
  readonly livingParentCount?: number;
  readonly livingSpouseCount: number;
  readonly livingChildCount: number;
}

export function extractBirthYearForLiving(person: Pick<Person, 'birth_year' | 'birth_edtf'>): number | null {
  if (typeof person.birth_year === 'number' && Number.isFinite(person.birth_year)) {
    return person.birth_year;
  }
  const match = /^(\d{4})/.exec((person.birth_edtf ?? '').trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

export interface TimelineScrubberTick {
  readonly decade: number;
  readonly eventId: string;
}

export interface SectionJumpItem {
  readonly id: string;
  readonly label: string;
}

const PERSON_MEDIA_KIND_ORDER: Readonly<Record<string, number>> = {
  portrait: 0,
  family_photo: 1,
  record_scan: 2,
  headstone: 3,
  document_scan: 4,
  milestone: 5,
  video_story: 6,
  audio_oral_history: 7,
};

export function collectPersonMedia(bundle: ArchiveBundle, personId: string): MediaItem[] {
  const items = (bundle.media || []).filter((m) => getMediaPersonIds(m).includes(personId));
  return [...items].toSorted(
    (a, b) => (PERSON_MEDIA_KIND_ORDER[a.kind] ?? 9) - (PERSON_MEDIA_KIND_ORDER[b.kind] ?? 9)
  );
}

export function collectPersonResidenceSpans(bundle: ArchiveBundle, personId: string): ResidenceSpan[] {
  return bundle.residence_spans
    .filter((span) => span.person_id === personId)
    .toSorted((a, b) => a.time_min - b.time_min);
}

export function buildImmediateFamily(
  bundle: ArchiveBundle,
  personId: string,
  peopleById: ReadonlyMap<string, Person>
): ImmediateFamilySummary {
  const parentIds = new Set<string>();
  const spouseIds = new Set<string>();
  const childIds = new Set<string>();

  for (const k of bundle.kinship) {
    if (k.relation === 'parent' && k.to === personId) {
      parentIds.add(k.from);
    } else if (k.relation === 'child' && k.from === personId) {
      parentIds.add(k.to);
    } else if (k.relation === 'parent' && k.from === personId) {
      childIds.add(k.to);
    } else if (k.relation === 'child' && k.to === personId) {
      childIds.add(k.from);
    } else if (k.relation === 'spouse' && k.from === personId) {
      spouseIds.add(k.to);
    } else if (k.relation === 'spouse' && k.to === personId) {
      spouseIds.add(k.from);
    }
  }

  const toEntries = (ids: ReadonlySet<string>): { visible: ImmediateFamilyEntry[]; livingCount: number } => {
    const visible: {
      id: string;
      slug: string;
      name: string;
      years: string;
      isLiving: boolean;
      sortYear: number;
    }[] = [];
    let livingCount = 0;
    for (const id of ids) {
      const rel = peopleById.get(id);
      if (!rel) {
        continue;
      }
      if (isRedactedLivingPlaceholder(rel)) {
        livingCount += 1;
        continue;
      }
      const livingBirthYear = rel.is_living ? extractBirthYearForLiving(rel) : null;
      const years = rel.is_living
        ? livingBirthYear !== null
          ? `b. ${livingBirthYear}`
          : 'Living'
        : `${rel.birth_year || '?'}–${rel.death_year || '?'}`;
      visible.push({
        id: rel.id,
        slug: rel.slug,
        name: rel.full_name,
        years,
        isLiving: Boolean(rel.is_living),
        sortYear: (rel.is_living ? livingBirthYear : rel.birth_year) ?? 9999,
      });
    }
    visible.sort((a, b) => a.sortYear - b.sortYear || a.name.localeCompare(b.name));
    return {
      visible: visible.map(({ id, slug, name, years, isLiving }) => ({ id, slug, name, years, isLiving })),
      livingCount,
    };
  };

  const parents = toEntries(parentIds);
  const spouses = toEntries(spouseIds);
  const children = toEntries(childIds);
  return {
    parents: parents.visible,
    spouses: spouses.visible,
    children: children.visible,
    livingParentCount: parents.livingCount,
    livingSpouseCount: spouses.livingCount,
    livingChildCount: children.livingCount,
  };
}

export function buildTimelineScrubberTicks(events: readonly ArchiveEvent[]): TimelineScrubberTick[] {
  const seen = new Set<number>();
  const ticks: TimelineScrubberTick[] = [];
  for (const ev of events) {
    if (ev.year === null) {
      continue;
    }
    const dec = Math.floor(ev.year / 10) * 10;
    if (!seen.has(dec)) {
      seen.add(dec);
      ticks.push({ decade: dec, eventId: ev.id });
    }
  }
  return ticks;
}

export function countUniqueEventPlaces(events: readonly ArchiveEvent[]): number {
  return new Set(events.map((ev) => ev.place_id).filter((id): id is string => Boolean(id))).size;
}

export function buildPersonSectionJumpItems(counts: {
  readonly biographyCount: number;
  readonly familyStoryCount: number;
  readonly mediaCount: number;
  readonly eventCount: number;
}): SectionJumpItem[] {
  const items: SectionJumpItem[] = [];
  if (counts.biographyCount > 0) {
    items.push({ id: 'person-biography', label: KINLOOM_VOCABULARY.person.biographyHeading });
  }
  if (counts.familyStoryCount > 0) {
    items.push({
      id: 'person-family-stories',
      label: `${KINLOOM_VOCABULARY.person.familyStoriesHeading} (${counts.familyStoryCount})`,
    });
  }
  if (counts.mediaCount > 0) {
    items.push({
      id: 'person-media',
      label: `${KINLOOM_VOCABULARY.person.photosAndDocumentsHeading} (${counts.mediaCount})`,
    });
  }
  if (counts.eventCount > 0) {
    items.push({ id: 'person-timeline', label: `Life Timeline (${counts.eventCount})` });
  }
  return items;
}

export function buildPersonEditInitialData(person: Person): EntityPayload {
  return {
    id: person.id,
    slug: person.slug,
    full_name: person.full_name,
    given_name: person.given_name,
    surname: person.surname,
    alt_names: person.alt_names,
    sex: person.sex,
    is_living: person.is_living,
    lineage_group: person.lineage_group,
    branch: person.branch,
    birth_edtf: person.birth_edtf,
    death_edtf: person.death_edtf,
    portrait_url: person.portrait_url,
    pronunciation: person.pronunciation ?? null,
    has_primary_source: person.has_primary_source,
  };
}

export function resolvePortraitLightboxState(
  person: Person,
  personMedia: readonly MediaItem[]
): PersonLightboxState | null {
  if (!person.portrait_url) {
    return null;
  }
  const idx = personMedia.findIndex((m) => m.file === person.portrait_url);
  if (idx !== -1) {
    return { kind: 'gallery', index: idx };
  }
  if (personMedia.length > 0) {
    return { kind: 'gallery', index: 0 };
  }
  return {
    kind: 'single',
    media: {
      id: `portrait-${person.id}`,
      kind: 'portrait',
      file: person.portrait_url,
      caption: `Archival portrait of ${person.full_name}`,
      person_id: person.id,
      person_name: person.full_name,
      person_slug: person.slug,
    },
  };
}
