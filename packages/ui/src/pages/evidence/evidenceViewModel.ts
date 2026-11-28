import type { ArchivalMediaKind, ArchiveBundle, ArchiveEvent, MediaItem, SourceRecord } from '@kinloom/core';
import { UNVERIFIED_TREE_SOURCE_ID } from '@kinloom/core';
import { formatArchivalEdtfDate } from '../../lib/edtfArchivalFormat.js';

export type EvidenceTab = 'conflicts' | 'citations' | 'media';
export type MediaKindFilter = 'all' | ArchivalMediaKind;

export const EVIDENCE_BATCH_SIZE = 24;

export const EVIDENCE_TABS: readonly EvidenceTab[] = ['conflicts', 'citations', 'media'];

export const MEDIA_KIND_FILTER_ORDER: readonly ArchivalMediaKind[] = [
  'record_scan',
  'portrait',
  'family_photo',
  'headstone',
  'document_scan',
  'milestone',
  'video_story',
  'audio_oral_history',
];

export type DiscrepancyClaimKind = 'date' | 'place' | 'fact';

export interface DiscrepancyClaim {
  readonly key: string;
  readonly kind: DiscrepancyClaimKind;
  readonly badge: string;
  readonly value: string;
  readonly note: string;
  readonly sourceId: string;
}

export interface EvidenceCitationMetrics {
  readonly detailedCitationCount: number;
  readonly linkedRecordScanCount: number;
  readonly sourceUsageCounts: ReadonlyMap<string, number>;
}

export function parseInitialEvidenceTab(param: string | null): EvidenceTab {
  if (param === 'citations' || param === 'media' || param === 'conflicts') {
    return param;
  }
  return 'conflicts';
}

export function collectConflictEvents(bundle: ArchiveBundle | null): ArchiveEvent[] {
  if (!bundle) {
    return [];
  }
  return bundle.events.filter(
    (e) =>
      (e.alternate_dates?.length || 0) + (e.alternate_places?.length || 0) + (e.fact_conflicts?.length || 0) >
      0
  );
}

export function collectEventDiscrepancyClaims(ev: ArchiveEvent): DiscrepancyClaim[] {
  return [
    ...(ev.alternate_dates || []).map((alt) => {
      const formatted = formatArchivalEdtfDate(alt.edtf_date);
      return {
        key: `date|${alt.edtf_date}|${alt.source_id}|${alt.note}`,
        kind: 'date' as const,
        badge: formatted,
        value: formatted,
        note: alt.note,
        sourceId: alt.source_id,
      };
    }),
    ...(ev.alternate_places || []).map((alt) => ({
      key: `place|${alt.place_name}|${alt.source_id}|${alt.note}`,
      kind: 'place' as const,
      badge: `Place: ${alt.place_name}`,
      value: alt.place_name,
      note: alt.note,
      sourceId: alt.source_id,
    })),
    ...(ev.fact_conflicts || []).map((alt) => ({
      key: `fact|${alt.claim}|${alt.source_id}|${alt.note}`,
      kind: 'fact' as const,
      badge: alt.claim,
      value: alt.claim,
      note: alt.note,
      sourceId: alt.source_id,
    })),
  ];
}

export function collectUnverifiedEvents(bundle: ArchiveBundle | null): ArchiveEvent[] {
  if (!bundle) {
    return [];
  }
  return bundle.events.filter(
    (e) =>
      (e.scope === 'personal' || e.scope === 'family') &&
      e.sources.length > 0 &&
      e.sources.every((s) => s.source_id === UNVERIFIED_TREE_SOURCE_ID)
  );
}

export function computeEvidenceCitationMetrics(bundle: ArchiveBundle | null): EvidenceCitationMetrics {
  const sourceUsageCounts = new Map<string, number>();
  let detailedCitationCount = 0;
  let linkedRecordScanCount = 0;
  if (!bundle) {
    return { detailedCitationCount, linkedRecordScanCount, sourceUsageCounts };
  }
  for (const ev of bundle.events) {
    for (const sr of ev.sources) {
      if (sr.citation_detail) {
        detailedCitationCount += 1;
      }
      if (sr.scan_url) {
        linkedRecordScanCount += 1;
      }
      sourceUsageCounts.set(sr.source_id, (sourceUsageCounts.get(sr.source_id) || 0) + 1);
    }
  }
  return { detailedCitationCount, linkedRecordScanCount, sourceUsageCounts };
}

export function filterAndSortSources(
  bundle: ArchiveBundle | null,
  sourceQuery: string,
  sourceUsageCounts: ReadonlyMap<string, number>
): SourceRecord[] {
  if (!bundle) {
    return [];
  }
  const q = sourceQuery.trim().toLowerCase();
  return bundle.sources
    .filter((s) => {
      if (!q) {
        return true;
      }
      return (
        s.id.toLowerCase().includes(q) ||
        s.citation.toLowerCase().includes(q) ||
        (s.author || '').toLowerCase().includes(q) ||
        (s.repository || '').toLowerCase().includes(q) ||
        s.source_type.toLowerCase().includes(q)
      );
    })
    .toSorted((a, b) => (sourceUsageCounts.get(b.id) || 0) - (sourceUsageCounts.get(a.id) || 0));
}

export function countMediaByKind(allMedia: readonly MediaItem[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const m of allMedia) {
    counts[m.kind] = (counts[m.kind] || 0) + 1;
  }
  return counts;
}

export function filterMediaItems(
  allMedia: readonly MediaItem[],
  mediaKindFilter: MediaKindFilter,
  mediaQuery: string
): MediaItem[] {
  const q = mediaQuery.trim().toLowerCase();
  return allMedia.filter((m) => {
    if (mediaKindFilter !== 'all' && m.kind !== mediaKindFilter) {
      return false;
    }
    if (q) {
      const hay = `${m.caption} ${m.person_name || ''} ${m.provenance || ''} ${m.kind}`.toLowerCase();
      if (!hay.includes(q)) {
        return false;
      }
    }
    return true;
  });
}
