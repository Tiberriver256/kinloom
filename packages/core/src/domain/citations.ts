import type {
  ArchiveBundle,
  ArchiveEvent,
  EventSourceRef,
  MediaItem,
  SourceRecord,
} from '../schemas/entities.js';
import { UNVERIFIED_TREE_SOURCE_ID } from '../gedcom/citations.js';
import { formatPublicCitation, formatPublicRepository } from './publicDisplay.js';

export type EvidenceTier = 'primary' | 'published' | 'family' | 'derivative' | 'unverified';

export interface EvidenceTierMeta {
  tier: EvidenceTier;
  label: string;
  shortLabel: string;
  description: string;
}

const PRIMARY_TYPES = new Set(['census', 'vital_record', 'military_record']);

const PUBLISHED_TYPES = new Set([
  'historical_reference',
  'county_history',
  'probate_abstract',
  'digital_archive',
  'newspaper',
  'news_article',
  'obituary',
  'church_bulletin',
  'church_website',
]);

const FAMILY_TYPES = new Set([
  'family_memoir',
  'family_papers',
  'family_chart',
  'veteran_memoir',
]);

const DERIVATIVE_TYPES = new Set([
  'archival_index',
  'compiled_record',
  'compiled_tree',
  'obituary_index',
  'memorial',
  'personal_website',
  'forum_post',
]);

export const EVIDENCE_TIER_META: Record<EvidenceTier, EvidenceTierMeta> = {
  primary: {
    tier: 'primary',
    label: 'Primary Record',
    shortLabel: 'Primary',
    description: 'Original contemporary government, military, census, or vital record.',
  },
  published: {
    tier: 'published',
    label: 'Published / Archival History',
    shortLabel: 'Published',
    description:
      'Published county history, peer-reviewed journal, probate abstract, newspaper, or institutional archive.',
  },
  family: {
    tier: 'family',
    label: 'Family Account',
    shortLabel: 'Family',
    description:
      'Firsthand memoir, family chart, or private family papers requiring corroboration for exact dates.',
  },
  derivative: {
    tier: 'derivative',
    label: 'Derivative Index',
    shortLabel: 'Index',
    description:
      'Compiled database index, memorial transcription, or online extract derived from an underlying record.',
  },
  unverified: {
    tier: 'unverified',
    label: 'Citation Needed',
    shortLabel: 'Uncited',
    description: 'Imported family-tree claim without an attached primary or archival record.',
  },
};

export function classifySourceTier(rec?: SourceRecord | null): EvidenceTier {
  if (!rec || rec.id === UNVERIFIED_TREE_SOURCE_ID || rec.source_type === 'unverified_tree_entry') {
    return 'unverified';
  }
  const st = (rec.source_type || '').toLowerCase();
  if (PRIMARY_TYPES.has(st)) {
    return 'primary';
  }
  if (PUBLISHED_TYPES.has(st)) {
    return 'published';
  }
  if (FAMILY_TYPES.has(st)) {
    return 'family';
  }
  if (DERIVATIVE_TYPES.has(st)) {
    return 'derivative';
  }
  return 'derivative';
}

export function formatSourceTypeLabel(sourceType?: string): string {
  if (!sourceType) {
    return 'Archival record';
  }
  return sourceType
    .split('_')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ''))
    .join(' ');
}

export function formatConfidenceLabel(
  confidence?: 'high' | 'medium' | 'low',
  tier?: EvidenceTier
): string {
  if (tier === 'unverified') {
    return 'Unverified claim';
  }
  if (confidence === 'high') {
    return 'Direct evidence';
  }
  if (confidence === 'medium') {
    return 'Corroborating evidence';
  }
  if (confidence === 'low') {
    return 'Unverified / indirect';
  }
  return 'Recorded';
}

export interface LibrarianCitation {
  sourceId: string;
  tier: EvidenceTier;
  tierLabel: string;
  tierDescription: string;
  title: string;
  author: string | null;
  publisher: string | null;
  repository: string | null;
  recordDetail: string | null;
  url: string | null;
  urlHost: string | null;
  evidenceBasis: string;
  bibliographicString: string;
}

function normalizeForOverlap(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, ' ').trim();
}

function isRedundant(candidate: string, existing: string): boolean {
  const c = normalizeForOverlap(candidate);
  const e = normalizeForOverlap(existing);
  if (!c) {
    return true;
  }
  return e.includes(c);
}

function extractUrlHost(url?: string): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function buildLibrarianCitation(
  rec: SourceRecord | undefined,
  ref?: Partial<EventSourceRef>
): LibrarianCitation {
  const tier = classifySourceTier(rec);
  const meta = EVIDENCE_TIER_META[tier];
  const rawTitle = rec ? formatPublicCitation(rec.citation) : ref?.source_id || 'Unknown source';
  const title = rawTitle || ref?.source_id || 'Unknown source';

  const rawAuthor = rec?.author?.trim() || null;
  const author = rawAuthor && !isRedundant(rawAuthor, title) ? rawAuthor : null;

  const rawPublisher = rec?.publisher?.trim() || null;
  const publisher = rawPublisher && !isRedundant(rawPublisher, title) ? rawPublisher : null;

  const rawRepo = rec ? formatPublicRepository(rec.repository) : '';
  const repository =
    rawRepo && tier !== 'unverified' && !isRedundant(rawRepo, title) ? rawRepo : null;

  const recordDetail = ref?.citation_detail?.trim() || null;
  const url = rec?.url?.trim() || null;
  const urlHost = extractUrlHost(url ?? undefined);
  const evidenceBasis = formatConfidenceLabel(ref?.confidence, tier);

  const parts: string[] = [];
  if (author) {
    parts.push(author);
  }
  parts.push(title);
  if (recordDetail && !isRedundant(recordDetail, title)) {
    parts.push(recordDetail);
  }
  if (repository) {
    parts.push(repository);
  } else if (publisher) {
    parts.push(publisher);
  }
  if (url) {
    parts.push(url);
  }

  return {
    sourceId: rec?.id || ref?.source_id || '',
    tier,
    tierLabel: meta.label,
    tierDescription: meta.description,
    title,
    author,
    publisher,
    repository,
    recordDetail,
    url,
    urlHost,
    evidenceBasis,
    bibliographicString: `${parts.join(', ')}.`,
  };
}

export function summarizeEventCitations(
  refs: readonly EventSourceRef[],
  sourcesById: ReadonlyMap<string, SourceRecord>
): { label: string; onlyUnverified: boolean; primaryCount: number } {
  if (refs.length === 0) {
    return { label: 'Citation Needed', onlyUnverified: true, primaryCount: 0 };
  }
  const counts: Record<EvidenceTier, number> = {
    primary: 0,
    published: 0,
    family: 0,
    derivative: 0,
    unverified: 0,
  };
  for (const ref of refs) {
    const tier = classifySourceTier(sourcesById.get(ref.source_id));
    counts[tier] += 1;
  }
  if (counts.unverified === refs.length) {
    return { label: 'Citation Needed', onlyUnverified: true, primaryCount: 0 };
  }

  const base = `${refs.length} ${refs.length === 1 ? 'Source' : 'Sources'}`;
  const breakdown: string[] = [];
  if (counts.primary > 0) {
    breakdown.push(`${counts.primary} Primary`);
  }
  if (counts.published > 0) {
    breakdown.push(`${counts.published} Published`);
  }
  if (counts.family > 0) {
    breakdown.push(`${counts.family} Family`);
  }
  if (counts.derivative > 0) {
    breakdown.push(`${counts.derivative} ${counts.derivative === 1 ? 'Index' : 'Indexes'}`);
  }
  if (counts.unverified > 0) {
    breakdown.push(`${counts.unverified} Uncited`);
  }

  return {
    label: breakdown.length > 0 ? `${base} · ${breakdown.join(', ')}` : base,
    onlyUnverified: false,
    primaryCount: counts.primary,
  };
}

export interface SourceUsageEntry {
  event: ArchiveEvent;
  ref: EventSourceRef;
  primaryPersonSlug: string | null;
  primaryPersonName: string | null;
}

export function findSourceUsages(
  sourceId: string,
  bundle: ArchiveBundle | null
): { usages: SourceUsageEntry[]; linkedMedia: MediaItem[] } {
  if (!bundle || !sourceId) {
    return { usages: [], linkedMedia: [] };
  }
  const peopleById = new Map(bundle.people.map((p) => [p.id, p]));
  const usages: SourceUsageEntry[] = [];
  for (const ev of bundle.events) {
    const matchedRef = ev.sources.find((sr) => sr.source_id === sourceId);
    if (!matchedRef) {
      continue;
    }
    const primaryPerson = ev.participants
      .map((pt) => peopleById.get(pt.person_id))
      .find((p) => p && !p.is_living && p.full_name !== 'Living');
    usages.push({
      event: ev,
      ref: matchedRef,
      primaryPersonSlug: primaryPerson?.slug || null,
      primaryPersonName: primaryPerson?.full_name || null,
    });
  }
  usages.sort((a, b) => (a.event.year ?? 9999) - (b.event.year ?? 9999));

  const linkedMedia = (bundle.media ?? []).filter((m) => m.source_id === sourceId);
  return { usages, linkedMedia };
}
