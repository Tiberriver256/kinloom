import type {
  MediaItem,
  Narrative,
  Place,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseNarrativeEnrichmentsYaml,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '@kinloom/core';

export interface MediaDedupeCommandOptions {
  repoDir?: string;
  apply?: boolean;
  preferIds?: readonly string[];
  json?: boolean;
  /** Optional write hook for rollback testing; defaults to atomic temp-file rename. */
  writeFileImpl?: (filePath: string, content: string) => void;
}

export interface MediaDedupeCitationRewrite {
  narrativeId: string;
  sourceId: string;
  fromMediaId: string;
  toMediaId: string;
}

export interface MediaDedupeExtensionRewrite {
  file: string;
  entityId: string;
  fieldPath: string;
  fromMediaId: string;
  toMediaId: string;
}

export interface MediaDedupeGroupPlan {
  normalizedFile: string;
  canonicalId: string;
  retiredIds: string[];
  mergedPersonIds: string[];
  warnings: string[];
  mergedRecord: MediaItem;
}

export interface MediaDedupeStagedWarning {
  personId: string;
  retiredMediaIds: string[];
  canonicalByRetired: Record<string, string>;
}

export interface MediaDedupeCommandResult {
  ok: true;
  apply: boolean;
  dryRun: boolean;
  repo: string;
  duplicateGroupCount: number;
  retiredCount: number;
  groups: MediaDedupeGroupPlan[];
  citationRewrites: MediaDedupeCitationRewrite[];
  extensionRewrites: MediaDedupeExtensionRewrite[];
  warnings: string[];
  stagedPackageWarnings: MediaDedupeStagedWarning[];
  wouldWriteYamlFiles: string[];
  writtenYamlFiles: string[];
  rendered: string;
}

export type ParsedKinloomConfig = ReturnType<typeof parseKinloomConfigYaml>;
export type ParsedKinshipList = ReturnType<typeof parseKinshipYaml>;
export type ParsedNarrativeEnrichmentsList = ReturnType<typeof parseNarrativeEnrichmentsYaml>;

export interface LoadedDedupeArchivePaths {
  peoplePath: string;
  placesPath: string;
  eventsPath: string;
  sourcesPath: string;
  kinshipPath: string;
  mediaPath: string;
  narrativesPath: string;
  enrichmentsPath: string;
}

export interface LoadedDedupeArchive {
  config: ParsedKinloomConfig;
  paths: LoadedDedupeArchivePaths;
  people: RawPerson[];
  places: Place[];
  events: RawEvent[];
  sources: SourceRecord[];
  kinship: ParsedKinshipList;
  media: MediaItem[];
  narratives: Narrative[];
  enrichments: ParsedNarrativeEnrichmentsList;
}

export interface PendingYamlWrite {
  fullPath: string;
  content: string;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function uniqueNonEmptyStrings(values: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
