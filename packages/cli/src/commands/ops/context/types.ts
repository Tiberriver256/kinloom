import type { PrivacyConfig, ResolvedPersonPronunciation } from '@kinloom/core';

export const REDACTED_RELATIVE_LABEL = '[Living relative redacted]';

export interface ContextCommandOptions {
  repoDir?: string;
  personId: string;
  ancestryDir?: string;
  includeFamily?: boolean;
  full?: boolean;
  json?: boolean;
}

export interface ContextKinshipEdge {
  from: string;
  to: string;
  relation: string;
  family_xref?: string | null;
}

export interface ContextRelativeEntry {
  id: string;
  full_name: string;
  lifespan: string;
  gedcom_xref: string | null;
}

export type ContextRelativeListItem = ContextRelativeEntry | typeof REDACTED_RELATIVE_LABEL;

export interface ContextRecordImage {
  path: string;
  recordImageId: string | null;
  bytes: number;
  sourceTitle: string | null;
}

export type ContextRelativeRelation = 'parent' | 'spouse' | 'child' | 'sibling';

export interface ContextRelativeRecordImage extends ContextRecordImage {
  relativeId: string;
  relativeName: string;
  relation: ContextRelativeRelation;
  personDbId: string;
}

export interface ContextRelativeArchiveMedia {
  id: string;
  file: string;
  caption: string;
  relation: ContextRelativeRelation;
  relativeId: string;
}

export interface ContextAncestryFact {
  type: string;
  date?: string;
  place?: string;
  value?: string;
  description?: string;
  targetPerson?: {
    name: string;
    lifeRange: string | null;
    pid: string | null;
  };
  sourceCount?: number;
}

export interface ContextAncestrySource {
  title: string;
  detail?: string;
  citationId?: string;
  databaseId?: string;
  recordId?: string;
  recordImageId?: string;
}

export type ContextAncestrySummary =
  | {
      matchMode: 'gedcom_xref' | 'fullName';
      jsonPath: string;
      redacted: true;
      note: typeof REDACTED_RELATIVE_LABEL;
    }
  | {
      matchMode: 'gedcom_xref' | 'fullName';
      jsonPath: string;
      redacted?: false;
      personDbId: string;
      fullName: string | null;
      lifeRange: string | null;
      birthDate: string | null;
      birthPlace: string | null;
      deathDate: string | null;
      deathPlace: string | null;
      factsUrl: string | null;
      redactedLivingFactsCount: number;
      facts: ContextAncestryFact[];
      sources: ContextAncestrySource[];
      recordImages: ContextRecordImage[];
    };

export interface PersonContextPayload {
  repoDir: string;
  person: Record<string, unknown>;
  relatives: {
    parents: ContextRelativeListItem[];
    spouses: ContextRelativeListItem[];
    children: ContextRelativeListItem[];
  };
  kinship: ContextKinshipEdge[];
  pronunciation: ResolvedPersonPronunciation | null;
  events: Record<string, unknown>[];
  places: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  media: Record<string, unknown>[];
  narratives: Record<string, unknown>[];
  ancestry: ContextAncestrySummary | null;
  relativeRecordImages: ContextRelativeRecordImage[];
  relativeArchiveMedia: ContextRelativeArchiveMedia[];
}

export interface ContextCommandResult {
  context: PersonContextPayload;
  rendered: string;
  bytesOut: number;
}

export interface LooseYamlRecord {
  [key: string]: unknown;
}

export interface RelativeIdGroups {
  parentIds: Set<string>;
  spouseIds: Set<string>;
  childIds: Set<string>;
  siblingIds: Set<string>;
}

export interface LivingPrivacyState {
  livingIds: Set<string>;
  livingAncestryPids: Set<string>;
  livingNamePattern: RegExp | null;
  privacy: Partial<PrivacyConfig>;
}

export interface ArchiveYamlBlocks {
  configText: string | null;
  peopleBlocks: string[];
  kinshipBlocks: string[];
  eventBlocks: string[];
  placeBlocks: string[];
  sourceBlocks: string[];
  mediaBlocks: string[];
  narrativeBlocks: string[];
}
