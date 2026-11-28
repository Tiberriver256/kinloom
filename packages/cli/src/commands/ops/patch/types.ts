import type { ArchiveBundle } from '@kinloom/core';
import type { RemoveKinshipEntry } from '../shared/integrateEngine/types.js';

export type PatchArchiveBundleCounts = ArchiveBundle['meta']['counts'];

export interface PatchEntityCounts {
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly removed: number;
}

export interface PatchAllEntityCounts {
  readonly people: PatchEntityCounts;
  readonly places: PatchEntityCounts;
  readonly events: PatchEntityCounts;
  readonly kinship: PatchEntityCounts;
  readonly sources: PatchEntityCounts;
  readonly media: PatchEntityCounts;
  readonly narratives: PatchEntityCounts;
}

export interface NormalizedMultiEntityPatch {
  readonly people: readonly unknown[];
  readonly places: readonly unknown[];
  readonly events: readonly unknown[];
  readonly kinship: readonly unknown[];
  readonly sources: readonly unknown[];
  readonly media: readonly unknown[];
  readonly narratives: readonly unknown[];
  readonly remove_event_ids: readonly string[];
  readonly remove_source_ids: readonly string[];
  readonly remove_media_ids: readonly string[];
  readonly remove_narrative_ids: readonly string[];
  readonly remove_kinship: readonly RemoveKinshipEntry[];
}

export interface PendingPatchYamlWrite {
  readonly fileName: string;
  readonly fullPath: string;
  readonly content: string;
}

export interface PatchCommandOptions {
  /** Archive repository root containing data/*.yaml and kinloom.config.yaml (default: cwd). */
  readonly repoDir?: string | undefined;
  /** Path to JSON/YAML patch file, or '-' to read from stdin. */
  readonly patchFile?: string | undefined;
  /** Direct raw JSON/YAML patch text (primarily for programmatic/test usage). */
  readonly patchContent?: string | undefined;
  /** Optional injectable stdin reader used when reading from '-'. */
  readonly readStdin?: (() => Promise<string> | string) | undefined;
  /** Validate and compute diff without mutating any files on disk. */
  readonly dryRun?: boolean | undefined;
  /** Explicitly allow privacy-compliant living-person entries (default: false). */
  readonly allowLiving?: boolean | undefined;
  /** Emit deterministic JSON output instead of text summary. */
  readonly json?: boolean | undefined;
  /** Optional injectable atomic file writer for deterministic rollback testing. */
  readonly writeFileImpl?: ((filePath: string, content: string) => void) | undefined;
}

export interface PatchValidationSummary {
  readonly privateCounts: PatchArchiveBundleCounts;
  readonly publicCounts: PatchArchiveBundleCounts;
  readonly privateReviewFlags: number;
  readonly publicReviewFlags: number;
  readonly livingLeaks: number;
}

export interface PatchCommandResult {
  readonly ok: true;
  readonly dryRun: boolean;
  readonly allowLiving: boolean;
  readonly repo: string;
  readonly inputSource: string;
  readonly counts: PatchAllEntityCounts;
  readonly livingPeopleTouched: number;
  readonly wouldWriteYamlFiles: readonly string[];
  readonly writtenYamlFiles: readonly string[];
  readonly validation: PatchValidationSummary;
  readonly rendered: string;
}
