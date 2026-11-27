import type { ParsedEdtfInterval } from '@kinloom/core';
import type { ExecutedPluginCheckResult, KinloomCliPlugin } from '../../../plugins.js';
import type { LoadedLocalArchiveRepo } from '../../dataFiles.js';
import type { IntegrateCommandResult } from '../shared/integrateEngine/types.js';
import type { TreeHygieneWarning } from '../tree-hygiene.js';

export interface AuditCommandOptions {
  repoDir?: string;
  personId: string;
  packageDir?: string;
  json?: boolean;
  plugins?: readonly KinloomCliPlugin[];
  preloadedRepo?: LoadedLocalArchiveRepo;
}

export type ParsedAuditEdtf = ParsedEdtfInterval;

export interface LifespanSummary {
  exact: boolean;
  years: number | null;
  days: number | null;
  totalDays: number | null;
  label: string | null;
}

export interface ChronologyCheckResult {
  ok: boolean;
  birth_edtf: string | null;
  death_edtf: string | null;
  lifespan: LifespanSummary;
  checkedEvents: number;
  errors: string[];
  warnings: string[];
}

export interface PrivacyAndStyleCheckResult {
  ok: boolean;
  livingPeopleChecked: number;
  livingNameHits: Array<{ location: string; match: string }>;
  ssnHits: Array<{ location: string; match: string }>;
  phoneHits: Array<{ location: string; match: string }>;
  emDashCount: number;
  emDashHits: Array<{ location: string; count: number }>;
  errors: string[];
  warnings: string[];
}

export interface PrivacyScanDateContext {
  targetPerson?: LooseRecord | null;
  allPeople?: readonly LooseRecord[];
  liveEvents?: readonly LooseRecord[];
}

export interface UncitedSentenceItem {
  narrative_id: string;
  paragraph: number;
  text: string;
}

export interface CitationsCheckResult {
  ok: boolean;
  totalSentences: number;
  citedSentences: number;
  uncitedCount: number;
  uncitedSentences: UncitedSentenceItem[];
}

export interface InspectedImageHeader {
  valid: boolean;
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'unknown';
  width: number | null;
  height: number | null;
  error: string | null;
}

export interface AuditedScanFile {
  media_id: string | null;
  file: string;
  disk_path: string;
  source: 'package_scans' | 'repo_media' | 'unreferenced_scan';
  format: InspectedImageHeader['format'];
  width: number | null;
  height: number | null;
  bytes: number;
  kb: number;
  valid: boolean;
}

export interface ScansCheckResult {
  ok: boolean;
  checkedCount: number;
  unreferencedScans: string[];
  files: AuditedScanFile[];
  errors: string[];
  warnings: string[];
}

export interface DryRunCheckResult {
  ok: boolean;
  durationMs: number;
  inlineCitationCount: number;
  reviewFlags: number;
  livingLeaks: number | null;
  counts: IntegrateCommandResult['counts'] | null;
  error: string | null;
}

export interface AuditCommandResult {
  ok: boolean;
  strictOk: boolean;
  repo: string;
  person_id: string;
  package_dir: string;
  duration_ms: number;
  zeroCoordinatePlaces: string[];
  hygieneWarnings: TreeHygieneWarning[];
  checks: {
    chronology: ChronologyCheckResult;
    privacy: PrivacyAndStyleCheckResult;
    citations: CitationsCheckResult;
    scans: ScansCheckResult;
    dryRun: DryRunCheckResult;
    pronunciation: ExecutedPluginCheckResult;
  };
  pluginChecks: ExecutedPluginCheckResult[];
  errors: string[];
  warnings: string[];
  rendered: string;
}

export interface LooseRecord {
  [key: string]: unknown;
}

export function isPlainRecord(value: unknown): value is LooseRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

export function stringListField(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
