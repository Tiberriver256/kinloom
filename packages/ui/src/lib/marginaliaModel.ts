import type {
  AlternateDate,
  AlternatePlace,
  ArchiveEvent,
  EventSourceRef,
  ExtractedNarrativeCitations,
  FactConflict,
  MediaItem,
  SourceRecord,
} from '@kinloom/core';
import {
  buildLibrarianCitation,
  extractNarrativeCitations,
  formatPublicCitation,
  resolveCitationMedia,
} from '@kinloom/core';

export type MarginaliaMarkdownBlock =
  | { readonly kind: 'heading'; readonly level: 3 | 4; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'blockquote'; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] };

export interface FolioMarginaliaCitation {
  readonly kind: 'citation';
  readonly key: string;
  readonly footnoteNumber: number | null;
  readonly sourceId: string;
  readonly title: string;
  readonly callNumberOrDetail: string | null;
  readonly repository: string | null;
  readonly tierLabel: string;
  readonly isReadable: boolean;
  readonly scanUrl: string | null;
  readonly scanTitle: string | null;
  readonly confidence?: 'high' | 'medium' | 'low';
  readonly claimedDate?: string | null;
}

export interface FolioMarginaliaDiscrepancy {
  readonly kind: 'discrepancy';
  readonly key: string;
  readonly indexNumber: number;
  readonly category: 'date' | 'place' | 'fact';
  readonly claim: string;
  readonly note: string;
  readonly sourceId: string;
  readonly sourceLabel: string | null;
}

export type FolioMarginaliaItem = FolioMarginaliaCitation | FolioMarginaliaDiscrepancy;

export interface PartitionedMarkdownMarginalia {
  readonly byBlockIndex: readonly (readonly FolioMarginaliaCitation[])[];
  readonly trailingCitations: readonly FolioMarginaliaCitation[];
}

function getMarkdownBlockText(block: MarginaliaMarkdownBlock): string {
  if (block.kind === 'list') {
    return block.items.join('\n');
  }
  return block.text;
}

/**
 * Assign each Markdown block the citations whose FIRST appearance occurs in that block,
 * returning per-block marginalia lists plus any trailing uncited `source_ids`.
 */
export function partitionMarkdownBlockMarginalia(params: {
  readonly blocks: readonly MarginaliaMarkdownBlock[];
  readonly extractedCitations: ExtractedNarrativeCitations;
  readonly narrativeSourceIds: readonly string[];
  readonly sourcesById: ReadonlyMap<string, SourceRecord>;
  readonly readableSourceIds: ReadonlySet<string>;
  readonly mediaItems?: readonly MediaItem[];
  readonly events?: readonly ArchiveEvent[];
  readonly subjectPersonId?: string;
  readonly resolveScanUrl?: (media: MediaItem) => string | null;
}): PartitionedMarkdownMarginalia {
  const {
    blocks,
    extractedCitations,
    narrativeSourceIds,
    sourcesById,
    readableSourceIds,
    mediaItems,
    events,
    subjectPersonId,
    resolveScanUrl,
  } = params;

  const seenSourceIds = new Set<string>();
  const byBlockIndex: FolioMarginaliaCitation[][] = [];

  const buildNarrativeCitation = (
    sourceId: string,
    explicitMediaId: string | null,
    footnoteNumber: number | null
  ): FolioMarginaliaCitation | null => {
    const rec = sourcesById.get(sourceId);
    if (!rec) {
      return null;
    }
    const cit = buildLibrarianCitation(rec);
    const media =
      mediaItems && mediaItems.length > 0
        ? resolveCitationMedia(sourceId, explicitMediaId, mediaItems, subjectPersonId, events)
        : null;
    const scanUrl = media ? (resolveScanUrl ? resolveScanUrl(media) : media.thumb_file || media.file) : null;
    const scanTitle = media ? media.caption || cit.title : null;

    return {
      kind: 'citation',
      key: `cit:${sourceId}`,
      footnoteNumber,
      sourceId,
      title: cit.title,
      callNumberOrDetail: cit.recordDetail,
      repository: cit.repository,
      tierLabel: cit.tierLabel,
      isReadable: readableSourceIds.has(sourceId),
      scanUrl: scanUrl || null,
      scanTitle,
    };
  };

  for (const block of blocks) {
    const blockCitations: FolioMarginaliaCitation[] = [];
    const blockExtracted = extractNarrativeCitations(getMarkdownBlockText(block), {
      knownSourceIds: sourcesById,
    });

    for (const occ of blockExtracted.occurrences) {
      if (seenSourceIds.has(occ.sourceId)) {
        continue;
      }
      seenSourceIds.add(occ.sourceId);
      const footnoteNumber = extractedCitations.numberBySourceId.get(occ.sourceId) ?? null;
      const item = buildNarrativeCitation(occ.sourceId, occ.mediaId, footnoteNumber);
      if (item) {
        blockCitations.push(item);
      }
    }

    byBlockIndex.push(blockCitations);
  }

  const trailingCitations: FolioMarginaliaCitation[] = [];
  for (const srcId of narrativeSourceIds) {
    if (seenSourceIds.has(srcId)) {
      continue;
    }
    seenSourceIds.add(srcId);
    const footnoteNumber = extractedCitations.numberBySourceId.get(srcId) ?? null;
    const item = buildNarrativeCitation(srcId, null, footnoteNumber);
    if (item) {
      trailingCitations.push(item);
    }
  }

  return {
    byBlockIndex,
    trailingCitations,
  };
}

/**
 * Build compact Marginalia items (citations + numbered discrepancies) for an event or place card.
 */
export function buildEventMarginaliaItems(params: {
  readonly sources: readonly EventSourceRef[];
  readonly alternateDates?: readonly AlternateDate[];
  readonly alternatePlaces?: readonly AlternatePlace[];
  readonly factConflicts?: readonly FactConflict[];
  readonly sourcesById: ReadonlyMap<string, SourceRecord>;
  readonly readableSourceIds: ReadonlySet<string>;
}): readonly FolioMarginaliaItem[] {
  const {
    sources,
    alternateDates = [],
    alternatePlaces = [],
    factConflicts = [],
    sourcesById,
    readableSourceIds,
  } = params;

  const items: FolioMarginaliaItem[] = [];
  const seenCitationKeys = new Set<string>();
  let citationNum = 0;

  for (const ref of sources) {
    const dedupeKey = `${ref.source_id}|${ref.citation_detail ?? ''}|${ref.claimed_date ?? ''}|${ref.scan_url ?? ''}`;
    if (seenCitationKeys.has(dedupeKey)) {
      continue;
    }
    seenCitationKeys.add(dedupeKey);
    citationNum += 1;

    const rec = sourcesById.get(ref.source_id);
    const cit = buildLibrarianCitation(rec, ref);

    items.push({
      kind: 'citation',
      key: `ev-cit:${dedupeKey}`,
      footnoteNumber: citationNum,
      sourceId: ref.source_id,
      title: cit.title,
      callNumberOrDetail: cit.recordDetail,
      repository: cit.repository,
      tierLabel: cit.tierLabel,
      isReadable: readableSourceIds.has(ref.source_id),
      scanUrl: ref.scan_url?.trim() || null,
      scanTitle: ref.scan_title?.trim() || null,
      confidence: ref.confidence,
      claimedDate: ref.claimed_date ?? null,
    });
  }

  let discrepancyIndex = 0;

  for (const alt of alternateDates) {
    discrepancyIndex += 1;
    const rec = sourcesById.get(alt.source_id);
    items.push({
      kind: 'discrepancy',
      key: `disc:date:${alt.edtf_date}|${alt.source_id}|${alt.note}`,
      indexNumber: discrepancyIndex,
      category: 'date',
      claim: alt.edtf_date || 'Alternate date',
      note: alt.note,
      sourceId: alt.source_id,
      sourceLabel: rec ? formatPublicCitation(rec.citation) : null,
    });
  }

  for (const alt of alternatePlaces) {
    discrepancyIndex += 1;
    const rec = sourcesById.get(alt.source_id);
    items.push({
      kind: 'discrepancy',
      key: `disc:place:${alt.place_name}|${alt.source_id}|${alt.note}`,
      indexNumber: discrepancyIndex,
      category: 'place',
      claim: alt.place_name,
      note: alt.note,
      sourceId: alt.source_id,
      sourceLabel: rec ? formatPublicCitation(rec.citation) : null,
    });
  }

  for (const conflict of factConflicts) {
    discrepancyIndex += 1;
    const rec = sourcesById.get(conflict.source_id);
    items.push({
      kind: 'discrepancy',
      key: `disc:fact:${conflict.claim}|${conflict.source_id}|${conflict.note}`,
      indexNumber: discrepancyIndex,
      category: 'fact',
      claim: conflict.claim,
      note: conflict.note,
      sourceId: conflict.source_id,
      sourceLabel: rec ? formatPublicCitation(rec.citation) : null,
    });
  }

  return items;
}
