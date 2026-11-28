import { UNVERIFIED_TREE_SOURCE_ID } from '../gedcom/citations.js';
import type { ArchiveEvent, Person, SourceRecord } from '../schemas/entities.js';
import { classifySourceTier } from './citations.js';

export type ArchivalCompletenessTier = 'oral_seed' | 'partially_cited' | 'well_documented';

export interface PersonCompletenessSummary {
  readonly tier: ArchivalCompletenessTier;
  readonly label: 'Oral Seed' | 'Partially Cited' | 'Well-Documented';
  readonly pipCount: 1 | 2 | 3;
  readonly citedEventCount: number;
  readonly uncitedEventCount: number;
  readonly biographyCount: number;
  readonly mediaCount: number;
  readonly inviteCopy: string | null;
}

function isPersonalOrFamilyEvent(event: ArchiveEvent): boolean {
  return event.scope === 'personal' || event.scope === 'family';
}

function isEventPrimaryOrPublishedCited(
  event: ArchiveEvent,
  sourcesById: ReadonlyMap<string, SourceRecord>
): boolean {
  return event.sources.some((ref) => {
    const tier = classifySourceTier(sourcesById.get(ref.source_id));
    return tier === 'primary' || tier === 'published';
  });
}

function isEventUncited(event: ArchiveEvent, sourcesById: ReadonlyMap<string, SourceRecord>): boolean {
  if (event.sources.length === 0) {
    return true;
  }
  return event.sources.every((ref) => {
    if (ref.source_id === UNVERIFIED_TREE_SOURCE_ID) {
      return true;
    }
    return classifySourceTier(sourcesById.get(ref.source_id)) === 'unverified';
  });
}

/**
 * Compute archival documentation maturity purely from compiled bundle records.
 * Returns null for redacted living placeholders so private stubs never display completeness cues.
 */
export function computePersonCompleteness(params: {
  readonly person: Person;
  readonly personEvents: readonly ArchiveEvent[];
  readonly biographyCount: number;
  readonly mediaCount: number;
  readonly sourcesById: ReadonlyMap<string, SourceRecord>;
}): PersonCompletenessSummary | null {
  const { person, personEvents, biographyCount, mediaCount, sourcesById } = params;

  if (person.is_living && person.full_name.trim() === 'Living') {
    return null;
  }

  let citedEventCount = 0;
  let uncitedEventCount = 0;

  for (const event of personEvents) {
    if (!isPersonalOrFamilyEvent(event)) {
      continue;
    }
    if (isEventPrimaryOrPublishedCited(event, sourcesById)) {
      citedEventCount += 1;
    } else if (isEventUncited(event, sourcesById)) {
      uncitedEventCount += 1;
    }
  }

  if (citedEventCount === 0 && biographyCount === 0) {
    return {
      tier: 'oral_seed',
      label: 'Oral Seed',
      pipCount: 1,
      citedEventCount,
      uncitedEventCount,
      biographyCount,
      mediaCount,
      inviteCopy:
        'This profile is an oral seed. If you have a photo, letter, or date for this relative, add a note or citation.',
    };
  }

  if (
    (citedEventCount >= 3 && uncitedEventCount === 0) ||
    (citedEventCount >= 2 && biographyCount >= 1 && uncitedEventCount === 0)
  ) {
    return {
      tier: 'well_documented',
      label: 'Well-Documented',
      pipCount: 3,
      citedEventCount,
      uncitedEventCount,
      biographyCount,
      mediaCount,
      inviteCopy: null,
    };
  }

  const inviteCopy =
    uncitedEventCount > 0
      ? `${uncitedEventCount} ${uncitedEventCount === 1 ? 'entry still needs' : 'entries still need'} a primary source citation.`
      : 'A primary record is attached, and additional photos or stories can deepen this profile.';

  return {
    tier: 'partially_cited',
    label: 'Partially Cited',
    pipCount: 2,
    citedEventCount,
    uncitedEventCount,
    biographyCount,
    mediaCount,
    inviteCopy,
  };
}
