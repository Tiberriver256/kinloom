import type { MediaItem, Narrative, Place, RawEvent, RawPerson, SourceRecord } from '@kinloom/core';

export const QUERY_TARGETS = [
  'people',
  'places',
  'events',
  'narratives',
  'sources',
  'media',
  'schema',
] as const;

export type QueryTarget = (typeof QUERY_TARGETS)[number];
export type EntityQueryTarget = Exclude<QueryTarget, 'schema'>;
export type KinshipTraversalDirection = 'descendants' | 'ancestors';

export interface QueryCommandOptions {
  target: QueryTarget;
  repoDir?: string | undefined;
  deceased?: boolean | undefined;
  living?: boolean | undefined;
  includeLiving?: boolean | undefined;
  descendantsOf?: string | undefined;
  ancestorsOf?: string | undefined;
  depth?: number | undefined;
  match?: string | undefined;
  kind?: string | undefined;
  missing?: string | undefined;
  person?: string | undefined;
  fields?: readonly string[] | undefined;
  json?: boolean | undefined;
}

export interface KinshipSpouseRef {
  id: string;
  full_name: string;
  birth_edtf: string;
  death_edtf: string;
  is_living: boolean;
}

export interface KinshipTraversalEntry {
  generation: number;
  person: RawPerson;
  via_id: string | null;
  spouses: KinshipSpouseRef[];
}

export interface KinshipGenerationGroup {
  generation: number;
  label: string;
  count: number;
  entries: KinshipTraversalEntry[];
}

export interface KinshipTraversalSummary {
  direction: KinshipTraversalDirection;
  rootId: string;
  maxDepth: number;
  truncatedByDepth: boolean;
  excludedLivingCount: number;
  totalPeople: number;
  generations: KinshipGenerationGroup[];
}

export interface SchemaKeyFrequency {
  key: string;
  count: number;
  pct: number;
}

export interface SchemaFileInspection {
  file: string;
  recordCount: number;
  keys: SchemaKeyFrequency[];
}

export interface QuerySchemaReport {
  ok: true;
  target: 'schema';
  repo: string;
  totalFiles: number;
  totalRecords: number;
  files: SchemaFileInspection[];
}

export interface QueryPrivacyMeta {
  includeLiving: boolean;
  excludedLivingCount: number;
}

export interface QueryAppliedFilters {
  deceased: boolean;
  living: boolean;
  match: string | null;
  kind: string | null;
  missing: string | null;
  person: string | null;
  fields: string[] | null;
}

export type QueryEntityRecord =
  | RawPerson
  | Place
  | RawEvent
  | Narrative
  | SourceRecord
  | MediaItem
  | Record<string, unknown>;

export interface QueryEntitiesReport {
  ok: true;
  target: EntityQueryTarget;
  repo: string;
  privacy: QueryPrivacyMeta;
  filters: QueryAppliedFilters;
  traversal?: KinshipTraversalSummary | undefined;
  count: number;
  items: QueryEntityRecord[];
}

export type QueryReport = QueryEntitiesReport | QuerySchemaReport;

export type QueryCommandResult = QueryReport & {
  rendered: string;
};
