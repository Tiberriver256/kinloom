import type {
  ArchiveBundle,
  KinloomSiteConfig,
  KinshipEdge,
  LivingNameHit,
  MediaItem,
  Narrative,
  Place,
  parseNarrativeEnrichmentsYaml,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '@kinloom/core';
import type { ExecutedPluginCheckResult, KinloomCliPlugin } from '../../../plugins.js';
import type { TreeHygieneSummary } from '../tree-hygiene.js';

export interface VerifyCommandOptions {
  repoDir?: string;
  json?: boolean;
  strictHygiene?: boolean;
  strictPronunciation?: boolean;
  strictExternalMedia?: boolean;
  strictTrackedMedia?: boolean;
  strictBrandkit?: boolean;
  plugins?: readonly KinloomCliPlugin[];
}

export interface VerifyCitationsResult {
  ok: boolean;
  narrativesChecked: number;
  errors: string[];
}

export interface VerifyInvalidPlace {
  id: string;
  reason: string;
}

export interface VerifyPlacesResult {
  ok: boolean;
  placesChecked: number;
  invalidPlaces: VerifyInvalidPlace[];
}

export interface VerifySsnHit {
  file: string;
  line: number;
  match: string;
}

export interface VerifySsnResult {
  ok: boolean;
  filesScanned: number;
  hits: VerifySsnHit[];
}

export interface VerifyCompileResult {
  ok: boolean;
  privateCounts: ArchiveBundle['meta']['counts'];
  publicCounts: ArchiveBundle['meta']['counts'];
  privateReviewFlags: string[];
  publicReviewFlags: string[];
  privateLivingLeaks: string[];
  publicLivingLeaks: string[];
  duplicateResidenceSpans: string[];
}

export interface VerifyMissingMediaFile {
  id: string;
  file: string;
  expectedPath: string;
  reason: string;
}

export interface VerifyDuplicateMediaFile {
  file: string;
  mediaIds: string[];
}

export interface VerifyMediaResult {
  ok: boolean;
  mediaLayout: 'archive-media' | 'media';
  checkedCount: number;
  missingFiles: VerifyMissingMediaFile[];
  duplicateFiles: VerifyDuplicateMediaFile[];
}

export interface VerifyLivingNamesResult {
  ok: boolean;
  hits: LivingNameHit[];
}

export interface VerifyExternalMediaHit {
  file: string;
  entityId: string;
  field: string;
  url: string;
  host: string;
}

export interface VerifyExternalMediaResult {
  ok: boolean;
  checkedCount: number;
  hits: VerifyExternalMediaHit[];
}

export type VerifyTrackedBinaryExtension = '.mp3' | '.wav' | '.mp4';

export interface VerifyTrackedMediaFile {
  path: string;
  extension: VerifyTrackedBinaryExtension;
}

export interface VerifyTrackedMediaResult {
  ok: boolean;
  isGitRepo: boolean;
  trackedCount: number;
  files: VerifyTrackedMediaFile[];
}

export interface VerifyBrandkitManifestResult {
  ok: boolean;
  manifestPath: string;
  manifestExists: boolean;
  configuredTitle: string;
  expectedAccent: string;
  manifestName: string | null;
  manifestShortName: string | null;
  faviconLightAccent: string | null;
  swAccent: string | null;
  warnings: string[];
}

export interface VerifyCommandResult {
  ok: boolean;
  repo: string;
  duration_ms: number;
  strictHygiene: boolean;
  strictPronunciation: boolean;
  strictExternalMedia: boolean;
  strictTrackedMedia: boolean;
  strictBrandkit: boolean;
  checks: {
    citations: VerifyCitationsResult;
    places: VerifyPlacesResult;
    ssn: VerifySsnResult;
    compile: VerifyCompileResult;
    media: VerifyMediaResult;
    livingNames: VerifyLivingNamesResult;
    pronunciation: ExecutedPluginCheckResult;
    externalMedia: VerifyExternalMediaResult;
    trackedMedia: VerifyTrackedMediaResult;
    brandkitManifest: VerifyBrandkitManifestResult;
  };
  pluginChecks: ExecutedPluginCheckResult[];
  hygiene: TreeHygieneSummary;
  warnings: string[];
  errors: string[];
  rendered: string;
}

export interface LoadedVerifyArchive {
  repoDir: string;
  dataDir: string;
  siteConfig: KinloomSiteConfig;
  people: RawPerson[];
  events: RawEvent[];
  places: Place[];
  sources: SourceRecord[];
  kinship: KinshipEdge[];
  media: MediaItem[];
  narratives: Narrative[];
  enrichments: ReturnType<typeof parseNarrativeEnrichmentsYaml>;
  yamlTexts: Array<{ name: string; content: string }>;
}
