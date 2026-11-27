import {
  type ArchiveBundle,
  type ArchiveEvent,
  applyPrivacyFilter,
  collectLivingNames,
  compileLivingNamePattern,
  filterMediaForPrivacy,
  filterNarrativesForPrivacy,
  type KinloomSiteConfig,
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  type Person,
  type Place,
  type ResidenceSpan,
  resolveEffectiveLiving,
  type SourceRecord,
  scrubLivingNames,
} from '@kinloom/core';
import type { BookEdition } from './types.js';

export class BookPrivacyError extends Error {
  readonly code: 'BOOK_PRIVATE_EDITION_OPT_IN_REQUIRED' | 'BOOK_PRIVACY_REVIEW_REQUIRED';
  readonly reviewFlags: readonly string[];

  constructor(
    code: 'BOOK_PRIVATE_EDITION_OPT_IN_REQUIRED' | 'BOOK_PRIVACY_REVIEW_REQUIRED',
    message: string,
    reviewFlags: readonly string[] = []
  ) {
    super(message);
    this.name = 'BookPrivacyError';
    this.code = code;
    this.reviewFlags = reviewFlags;
  }
}

export interface BookPrivacyGateInput {
  readonly bundle: ArchiveBundle;
  readonly siteConfig: KinloomSiteConfig;
  readonly edition: BookEdition;
  readonly includeLiving?: boolean;
  readonly allowLivingPortraits?: boolean;
  readonly acknowledgeReviewFlags?: boolean;
  readonly referenceYear: number;
  readonly dedication?: string;
}

export interface RedactedBookArchive {
  readonly edition: BookEdition;
  readonly colophonNotice: string;
  readonly people: readonly Person[];
  readonly events: readonly ArchiveEvent[];
  readonly residenceSpans: readonly ResidenceSpan[];
  readonly places: readonly Place[];
  readonly kinship: readonly KinshipEdge[];
  readonly sources: readonly SourceRecord[];
  readonly media: readonly MediaItem[];
  readonly narratives: readonly Narrative[];
  readonly dedication: string;
  readonly excludedLivingPeopleCount: number;
  readonly excludedLivingMediaCount: number;
  readonly reviewFlags: readonly string[];
  readonly reviewFlagsAcknowledged: boolean;
}

/**
 * Mandatory living-person privacy redaction gate for all book builds, HTML/PDF exports,
 * and POD publisher submissions. Delegates living detection, name scrubbing, event redaction,
 * media stripping, and narrative filtering directly to @kinloom/core.
 */
export function runBookPrivacyGate(input: BookPrivacyGateInput): RedactedBookArchive {
  const { bundle, siteConfig, edition, referenceYear } = input;

  if (edition === 'private' && input.includeLiving !== true) {
    throw new BookPrivacyError(
      'BOOK_PRIVATE_EDITION_OPT_IN_REQUIRED',
      'Private family book editions require explicit includeLiving confirmation.'
    );
  }

  const effectiveLivingIds = new Set<string>();
  const effectiveLivingPeople: Pick<Person, 'is_living' | 'full_name' | 'alt_names'>[] = [];
  for (const person of bundle.people) {
    const isLiving = resolveEffectiveLiving(person, siteConfig.privacy, referenceYear);
    if (isLiving) {
      effectiveLivingIds.add(person.id);
      effectiveLivingPeople.push({
        is_living: true,
        full_name: person.full_name,
        alt_names: person.alt_names,
      });
    }
  }

  const livingNames = collectLivingNames(effectiveLivingPeople);
  const livingPattern = compileLivingNamePattern(livingNames);

  const filtered = applyPrivacyFilter(bundle.people, bundle.events, bundle.residence_spans, edition, {
    privacy: siteConfig.privacy,
    referenceYear,
    cloneInputs: true,
  });

  if (edition === 'public' && filtered.reviewFlags.length > 0 && input.acknowledgeReviewFlags !== true) {
    throw new BookPrivacyError(
      'BOOK_PRIVACY_REVIEW_REQUIRED',
      `Public book privacy gate flagged ${filtered.reviewFlags.length} potential living-person mention(s). Review and resolve them or explicitly acknowledge review flags.`,
      filtered.reviewFlags
    );
  }

  const peopleById = new Map<string, Person>();
  for (const person of filtered.people) {
    peopleById.set(person.id, person);
  }
  const eventsById = new Map<string, ArchiveEvent>();
  for (const ev of filtered.events) {
    eventsById.set(ev.id, ev);
  }

  const rawMedia = bundle.media ?? [];
  const stripLivingPortraits =
    edition === 'public'
      ? true
      : input.allowLivingPortraits === true
        ? false
        : (siteConfig.privacy.stripLivingPortraits ?? true);

  const filteredMedia = filterMediaForPrivacy(rawMedia, peopleById, eventsById, {
    cloneInputs: true,
    stripLivingPortraits,
  }).map((item) => {
    if (edition !== 'public' || !livingPattern) {
      return item;
    }
    return {
      ...item,
      caption: scrubLivingNames(item.caption, livingPattern),
      ...(item.provenance ? { provenance: scrubLivingNames(item.provenance, livingPattern) } : {}),
    };
  });

  const rawNarratives = bundle.narratives ?? [];
  const filteredNarratives = filterNarrativesForPrivacy(
    rawNarratives,
    effectiveLivingIds,
    livingPattern,
    edition,
    {
      cloneInputs: true,
    }
  ).map((narrative) => {
    if (edition !== 'public' || !livingPattern) {
      return narrative;
    }
    return {
      ...narrative,
      title: scrubLivingNames(narrative.title, livingPattern),
      ...(narrative.summary ? { summary: scrubLivingNames(narrative.summary, livingPattern) } : {}),
      body_md: scrubLivingNames(narrative.body_md, livingPattern),
    };
  });

  // In public edition, omit every living person's dossier and kinship edge completely so zero living
  // records, placeholders, or portraits appear in book chapters, pedigree charts, or back-of-book index.
  const includedPeople =
    edition === 'public'
      ? filtered.people.filter((person) => !effectiveLivingIds.has(person.id) && !person.is_living)
      : filtered.people;

  const includedPersonIds = new Set(includedPeople.map((p) => p.id));

  const includedEvents =
    edition === 'public'
      ? filtered.events
          .filter((ev) => !ev.participants.some((pt) => effectiveLivingIds.has(pt.person_id)))
          .map((ev) => {
            if (!livingPattern) {
              return ev;
            }
            return {
              ...ev,
              title: scrubLivingNames(ev.title, livingPattern),
              summary: scrubLivingNames(ev.summary, livingPattern),
            };
          })
      : filtered.events;

  const includedKinship = bundle.kinship.filter(
    (edge) => includedPersonIds.has(edge.from) && includedPersonIds.has(edge.to)
  );

  const includedPlaces = bundle.places.map((place) => {
    const copy = structuredClone(place);
    if (edition === 'public' && livingPattern) {
      if (copy.summary) {
        copy.summary = scrubLivingNames(copy.summary, livingPattern);
      }
      if (copy.photo_caption) {
        copy.photo_caption = scrubLivingNames(copy.photo_caption, livingPattern);
      }
    }
    return copy;
  });

  const includedSources = bundle.sources.map((source) => {
    const copy = structuredClone(source);
    if (edition === 'public' && livingPattern) {
      copy.citation = scrubLivingNames(copy.citation, livingPattern);
    }
    return copy;
  });

  const cleanDedication =
    edition === 'public' && livingPattern
      ? scrubLivingNames(input.dedication?.trim() ?? '', livingPattern)
      : (input.dedication?.trim() ?? '');

  const excludedLivingPeopleCount = edition === 'public' ? effectiveLivingIds.size : 0;
  const excludedLivingMediaCount = Math.max(0, rawMedia.length - filteredMedia.length);

  return {
    edition,
    colophonNotice:
      edition === 'private'
        ? 'Private Family Edition. Not for Public Distribution.'
        : 'Public Archival Edition. Living relatives and private living media redacted.',
    people: includedPeople,
    events: includedEvents,
    residenceSpans: filtered.residenceSpans,
    places: includedPlaces,
    kinship: includedKinship,
    sources: includedSources,
    media: filteredMedia,
    narratives: filteredNarratives,
    dedication: cleanDedication,
    excludedLivingPeopleCount,
    excludedLivingMediaCount,
    reviewFlags: filtered.reviewFlags,
    reviewFlagsAcknowledged: Boolean(input.acknowledgeReviewFlags && filtered.reviewFlags.length > 0),
  };
}
