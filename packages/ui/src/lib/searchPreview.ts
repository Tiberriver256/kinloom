import type {
  ArchiveBundle,
  ArchiveEvent,
  ArchiveSearchResult,
  Person,
  Place,
  SearchResultKind,
} from '@kinloom/core';
import { KINLOOM_VOCABULARY } from './vocabulary.js';

export interface CommandBarQuickAction {
  readonly id: 'tree' | 'map' | 'kinship' | 'evidence';
  readonly label: string;
  readonly route: string;
  readonly description: string;
}

export const COMMAND_BAR_QUICK_ACTIONS: readonly CommandBarQuickAction[] = [
  {
    id: 'tree',
    label: `Open ${KINLOOM_VOCABULARY.nav.tree}`,
    route: '/tree',
    description: 'Explore family lines & pedigree',
  },
  {
    id: 'map',
    label: `Open ${KINLOOM_VOCABULARY.nav.map}`,
    route: '/map',
    description: 'Trace places & migration routes',
  },
  {
    id: 'kinship',
    label: `Open ${KINLOOM_VOCABULARY.nav.kinship}`,
    route: '/kinship',
    description: 'Find how two people connect',
  },
  {
    id: 'evidence',
    label: `Open ${KINLOOM_VOCABULARY.nav.evidence}`,
    route: '/evidence',
    description: 'Browse primary records & citations',
  },
];

export type PreviewShortcutKey = 'Enter' | 'T' | 'M' | 'K';

export interface SearchShortcutAction {
  readonly key: PreviewShortcutKey;
  readonly label: string;
  readonly route?: string | undefined;
  readonly sourceReaderTarget?: ArchiveSearchResult['sourceReaderTarget'] | undefined;
}

export interface SearchPreviewSlip {
  readonly kind: SearchResultKind;
  readonly eyebrow: string;
  readonly title: string;
  readonly lifespan?: string | undefined;
  readonly primaryPlace?: string | undefined;
  readonly portraitName?: string | undefined;
  readonly portraitUrl?: string | null | undefined;
  readonly summaryLines: readonly string[];
  readonly excerpt?: string | undefined;
  readonly actions: readonly SearchShortcutAction[];
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatPersonLifespan(person: Person): string {
  const birth = person.birth_year ?? '?';
  const death = person.death_year ?? (person.is_living ? 'Living' : '?');
  return `${birth}–${death}`;
}

export function buildSearchPreviewSlip(params: {
  readonly item: ArchiveSearchResult | undefined;
  readonly bundle: ArchiveBundle | null;
  readonly peopleById: ReadonlyMap<string, Person>;
  readonly placesById: ReadonlyMap<string, Place>;
  readonly eventsById: ReadonlyMap<string, ArchiveEvent>;
}): SearchPreviewSlip | null {
  const { item, bundle, peopleById, placesById, eventsById } = params;
  if (!item) {
    return null;
  }

  if (item.kind === 'person') {
    const personId = item.id.startsWith('person:') ? item.id.slice('person:'.length) : item.id;
    const person = peopleById.get(personId);
    if (!person) {
      return {
        kind: 'person',
        eyebrow: 'Person',
        title: item.title,
        lifespan: item.subtitle,
        portraitName: item.title,
        portraitUrl: null,
        summaryLines: [],
        actions: item.route ? [{ key: 'Enter', label: 'Profile', route: item.route }] : [],
      };
    }

    const primaryPlace = person.primary_place_id
      ? placesById.get(person.primary_place_id)?.full_name
      : undefined;

    const personEvents = bundle
      ? bundle.events.filter((ev) => ev.participants.some((pt) => pt.person_id === person.id))
      : [];
    const citedSourceIds = new Set<string>();
    for (const ev of personEvents) {
      for (const src of ev.sources) {
        citedSourceIds.add(src.source_id);
      }
    }

    const mediaItems = (bundle?.media ?? []).filter(
      (m) => m.person_id === person.id || m.person_ids?.includes(person.id)
    );
    const eventCount = Math.max(person.event_count, personEvents.length);

    const summaryLines: string[] = [
      `${pluralize(eventCount, 'event')} · ${pluralize(citedSourceIds.size, 'cited source')}`,
      mediaItems.length > 0
        ? pluralize(mediaItems.length, 'archival media item')
        : person.portrait_url
          ? 'Archival portrait on file'
          : 'No archival media linked yet',
    ];

    return {
      kind: 'person',
      eyebrow: 'Person',
      title: person.full_name,
      lifespan: formatPersonLifespan(person),
      primaryPlace,
      portraitName: person.full_name,
      portraitUrl: person.thumb_url ?? person.portrait_url,
      summaryLines,
      actions: [
        { key: 'Enter', label: 'Profile', route: `/person/${person.slug}` },
        { key: 'T', label: 'Tree', route: `/tree?focus=${person.slug}` },
        { key: 'M', label: 'Map', route: `/map?person=${person.slug}` },
        { key: 'K', label: 'Kinship', route: `/kinship?from=${person.slug}` },
      ],
    };
  }

  if (item.kind === 'place') {
    const placeId = item.id.startsWith('place:') ? item.id.slice('place:'.length) : item.id;
    const place = placesById.get(placeId);
    if (!place) {
      return {
        kind: 'place',
        eyebrow: 'Place',
        title: item.title,
        lifespan: item.subtitle,
        summaryLines: [],
        actions: item.route ? [{ key: 'Enter', label: 'Place', route: item.route }] : [],
      };
    }

    const placeEventCount = bundle ? bundle.events.filter((ev) => ev.place_id === place.id).length : 0;
    const residentCount = bundle ? bundle.people.filter((p) => p.primary_place_id === place.id).length : 0;
    const coords = `${place.lat.toFixed(2)}°N, ${Math.abs(place.lng).toFixed(2)}°${place.lng >= 0 ? 'E' : 'W'}`;

    return {
      kind: 'place',
      eyebrow: place.place_type.toUpperCase(),
      title: place.full_name,
      lifespan: coords,
      summaryLines: [
        `${pluralize(placeEventCount, 'recorded event')} · ${pluralize(residentCount, 'primary resident')}`,
      ],
      actions: [
        { key: 'Enter', label: 'Place', route: `/place/${place.slug}` },
        { key: 'M', label: 'Map', route: `/map?place=${place.slug}` },
      ],
    };
  }

  if (item.kind === 'event') {
    const eventId = item.id.startsWith('event:') ? item.id.slice('event:'.length) : item.id;
    const ev = eventsById.get(eventId);
    if (!ev) {
      return {
        kind: 'event',
        eyebrow: 'Event',
        title: item.title,
        lifespan: item.subtitle,
        excerpt: item.snippet,
        summaryLines: [],
        actions: item.route ? [{ key: 'Enter', label: 'Open event', route: item.route }] : [],
      };
    }

    const placeName = ev.place_id ? placesById.get(ev.place_id)?.full_name : undefined;
    const firstPerson = ev.participants
      .map((pt) => peopleById.get(pt.person_id))
      .find((p) => p && (!p.is_living || p.full_name !== 'Living'));

    const actions: SearchShortcutAction[] = [];
    if (item.route) {
      actions.push({ key: 'Enter', label: 'Open event', route: item.route });
    }
    if (firstPerson) {
      actions.push(
        { key: 'T', label: 'Tree', route: `/tree?focus=${firstPerson.slug}` },
        { key: 'M', label: 'Map', route: `/map?person=${firstPerson.slug}` },
        { key: 'K', label: 'Kinship', route: `/kinship?from=${firstPerson.slug}` }
      );
    }

    return {
      kind: 'event',
      eyebrow: 'Event',
      title: ev.title,
      lifespan: ev.display_date,
      primaryPlace: placeName,
      summaryLines: [
        `${pluralize(ev.sources.length, 'citation')} · ${pluralize(ev.participants.length, 'participant')}`,
      ],
      excerpt: ev.summary || item.snippet,
      actions,
    };
  }

  return {
    kind: 'reading',
    eyebrow: 'Primary Source',
    title: item.title,
    lifespan: item.subtitle,
    summaryLines: ['Opens directly in the Reading Room'],
    excerpt: item.snippet,
    actions: [
      {
        key: 'Enter',
        label: 'Reading Room',
        sourceReaderTarget: item.sourceReaderTarget,
        route: item.route,
      },
    ],
  };
}

export function findPreviewShortcutAction(
  slip: SearchPreviewSlip | null,
  rawKey: string
): SearchShortcutAction | undefined {
  if (!slip) {
    return undefined;
  }
  const normalized = rawKey.toUpperCase();
  if (normalized !== 'T' && normalized !== 'M' && normalized !== 'K') {
    return undefined;
  }
  return slip.actions.find((action) => action.key === normalized);
}
