import type { ArchiveEvent, MediaItem, Narrative, SourceRecord } from './schemas/entities.js';
import { getMediaPersonIds } from './schemas/entities.js';

const SINGLE_CITATION_TOKEN_RE = /^\[\^([A-Za-z0-9._:-]+)(?:\|([A-Za-z0-9._:-]+))?\]$/;

const SCAN_MARKDOWN_CITATIONS_RE =
  /```[\s\S]*?```|`[^`\n]+`|\[\^([A-Za-z0-9._:-]+)(?:\|([A-Za-z0-9._:-]+))?\]/g;

const NON_IMAGE_FILE_RE = /\.(mp4|webm|mov|m4v|mp3|m4a|ogg|wav|flac|pdf)(\?.*)?$/i;

export interface ParsedInlineCitationToken {
  sourceId: string;
  mediaId: string | null;
  raw: string;
}

export interface NarrativeCitationOccurrence {
  sourceId: string;
  mediaId: string | null;
  number: number;
  index: number;
  length: number;
  raw: string;
}

export interface NarrativeCitationReference {
  sourceId: string;
  number: number;
  explicitMediaIds: string[];
}

export interface ExtractedNarrativeCitations {
  references: NarrativeCitationReference[];
  numberBySourceId: ReadonlyMap<string, number>;
  occurrences: NarrativeCitationOccurrence[];
}

export interface ExtractNarrativeCitationsOptions {
  knownSourceIds?: ReadonlySet<string> | ReadonlyMap<string, unknown>;
}

export interface OrderedNarrativeSource {
  source: SourceRecord;
  footnoteNumber: number | null;
}

export type ResolvableCitationMedia = MediaItem & {
  readonly event_ids?: readonly string[];
};

/**
 * Parse a single inline citation token such as `[^src_demo_1880]` or `[^src_demo_1880|med_demo_1]`.
 */
export function parseInlineCitationToken(rawToken: string): ParsedInlineCitationToken | null {
  const match = SINGLE_CITATION_TOKEN_RE.exec(rawToken);
  if (!match) {
    return null;
  }
  return {
    sourceId: match[1],
    mediaId: match[2] ?? null,
    raw: match[0],
  };
}

/**
 * Scan Markdown in reading order and assign stable 1-based footnote numbers by first appearance
 * of each unique `sourceId`. Code fences and inline code spans are ignored.
 */
export function extractNarrativeCitations(
  markdown: string,
  options?: ExtractNarrativeCitationsOptions,
): ExtractedNarrativeCitations {
  const knownSourceIds = options?.knownSourceIds;
  const numberBySourceId = new Map<string, number>();
  const refBySourceId = new Map<string, NarrativeCitationReference>();
  const references: NarrativeCitationReference[] = [];
  const occurrences: NarrativeCitationOccurrence[] = [];

  const scanner = new RegExp(SCAN_MARKDOWN_CITATIONS_RE.source, 'g');
  let match: RegExpExecArray | null = scanner.exec(markdown);

  while (match !== null) {
    const sourceId = match[1];
    if (sourceId !== undefined) {
      if (!knownSourceIds || knownSourceIds.has(sourceId)) {
        const mediaId = match[2] ?? null;
        let num = numberBySourceId.get(sourceId);
        let ref = refBySourceId.get(sourceId);
        if (num === undefined || ref === undefined) {
          num = references.length + 1;
          numberBySourceId.set(sourceId, num);
          ref = {
            sourceId,
            number: num,
            explicitMediaIds: [],
          };
          refBySourceId.set(sourceId, ref);
          references.push(ref);
        }
        if (mediaId && !ref.explicitMediaIds.includes(mediaId)) {
          ref.explicitMediaIds.push(mediaId);
        }
        occurrences.push({
          sourceId,
          mediaId,
          number: num,
          index: match.index,
          length: match[0].length,
          raw: match[0],
        });
      }
    }
    match = scanner.exec(markdown);
  }

  return {
    references,
    numberBySourceId,
    occurrences,
  };
}

/**
 * Order a narrative's sources so inline-cited sources appear first in exact `[1], [2], [3]` reading
 * order, followed by any remaining uncited `source_ids`.
 */
export function orderNarrativeSources(
  markdown: string,
  narrativeSourceIds: readonly string[],
  sourcesById: ReadonlyMap<string, SourceRecord>,
): OrderedNarrativeSource[] {
  const extracted = extractNarrativeCitations(markdown, { knownSourceIds: sourcesById });
  const ordered: OrderedNarrativeSource[] = [];
  const seen = new Set<string>();

  for (const ref of extracted.references) {
    const source = sourcesById.get(ref.sourceId);
    if (!source) {
      continue;
    }
    seen.add(ref.sourceId);
    ordered.push({ source, footnoteNumber: ref.number });
  }

  for (const srcId of narrativeSourceIds) {
    if (seen.has(srcId)) {
      continue;
    }
    const source = sourcesById.get(srcId);
    if (!source) {
      continue;
    }
    seen.add(srcId);
    ordered.push({ source, footnoteNumber: null });
  }

  return ordered;
}

/**
 * Return whether a media item can render as a previewable image thumbnail in a citation popover.
 */
export function isPreviewableCitationImage(media: MediaItem): boolean {
  if (media.kind === 'video_story' || media.kind === 'audio_oral_history') {
    return false;
  }
  const mime = media.mime_type?.toLowerCase().trim() ?? '';
  if (mime.startsWith('video/') || mime.startsWith('audio/') || mime === 'application/pdf') {
    return false;
  }
  if (media.person_name === 'Living' || media.extensions?.living_redacted === true) {
    return false;
  }
  const candidatePath = (media.thumb_file || media.file || '').trim();
  if (!candidatePath || NON_IMAGE_FILE_RE.test(candidatePath)) {
    return false;
  }
  return true;
}

function mediaMatchesEvent(media: ResolvableCitationMedia, eventId: string): boolean {
  if (media.event_id === eventId) {
    return true;
  }
  return Boolean(media.event_ids?.includes(eventId));
}

function pickPreferredMedia(
  candidates: readonly ResolvableCitationMedia[],
  subjectPersonId?: string | null,
): MediaItem | null {
  if (candidates.length === 0) {
    return null;
  }
  if (subjectPersonId) {
    const forSubject = candidates.find((item) => getMediaPersonIds(item).includes(subjectPersonId));
    if (forSubject) {
      return forSubject;
    }
  }
  return candidates[0];
}

/**
 * Resolve the best archival image or scan to display inside an inline citation preview card.
 */
export function resolveCitationMedia(
  sourceId: string,
  explicitMediaId?: string | null,
  allMedia: readonly ResolvableCitationMedia[] = [],
  subjectPersonId?: string | null,
  allEvents: readonly Pick<ArchiveEvent, 'id' | 'participants' | 'sources'>[] = [],
): MediaItem | null {
  if (allMedia.length === 0) {
    return null;
  }

  if (explicitMediaId) {
    const explicit = allMedia.find((item) => item.id === explicitMediaId);
    if (explicit && isPreviewableCitationImage(explicit)) {
      return explicit;
    }
  }

  const directMatches = allMedia.filter(
    (item) => item.source_id === sourceId && isPreviewableCitationImage(item),
  );
  const directPick = pickPreferredMedia(directMatches, subjectPersonId);
  if (directPick) {
    return directPick;
  }

  if (allEvents.length > 0) {
    const matchingEvents = allEvents.filter((ev) =>
      ev.sources.some((ref) => ref.source_id === sourceId),
    );
    const orderedEvents = subjectPersonId
      ? [
          ...matchingEvents.filter((ev) =>
            ev.participants.some((pt) => pt.person_id === subjectPersonId),
          ),
          ...matchingEvents.filter(
            (ev) => !ev.participants.some((pt) => pt.person_id === subjectPersonId),
          ),
        ]
      : matchingEvents;

    for (const ev of orderedEvents) {
      const eventMatches = allMedia.filter(
        (item) => mediaMatchesEvent(item, ev.id) && isPreviewableCitationImage(item),
      );
      const eventPick = pickPreferredMedia(eventMatches, subjectPersonId);
      if (eventPick) {
        return eventPick;
      }
    }
  }

  return null;
}

/**
 * Validate inline `[^src_id]` and `[^src_id|med_id]` tokens in narrative Markdown against known
 * archive sources (and optionally known media IDs).
 */
export function validateNarrativeCitations(
  narratives: readonly (Pick<Narrative, 'id'> & { body_md?: string })[],
  knownSourceIds: ReadonlySet<string>,
  knownMediaIds?: ReadonlySet<string> | null,
): string[] {
  const errors: string[] = [];

  for (const narrative of narratives) {
    if (!narrative.body_md) {
      continue;
    }
    const extracted = extractNarrativeCitations(narrative.body_md);
    const reportedSources = new Set<string>();
    const reportedMedia = new Set<string>();

    for (const occ of extracted.occurrences) {
      if (!knownSourceIds.has(occ.sourceId) && !reportedSources.has(occ.sourceId)) {
        reportedSources.add(occ.sourceId);
        errors.push(
          `Narrative '${narrative.id}' cites unknown inline source_id '${occ.sourceId}'.`,
        );
      }
      if (
        occ.mediaId &&
        knownMediaIds &&
        !knownMediaIds.has(occ.mediaId) &&
        !reportedMedia.has(occ.mediaId)
      ) {
        reportedMedia.add(occ.mediaId);
        errors.push(
          `Narrative '${narrative.id}' cites unknown inline media_id '${occ.mediaId}' for source '${occ.sourceId}'.`,
        );
      }
    }
  }

  return errors;
}
