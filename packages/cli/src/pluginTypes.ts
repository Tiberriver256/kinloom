import type {
  KinloomSiteConfig,
  KinshipEdge,
  MediaItem,
  Narrative,
  Place,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '@kinloom/core';
import type { CliExitCode } from './errors.js';
import type { CliIo } from './io.js';

export interface KinloomCliPluginContext {
  readonly cwd: string;
  readonly io: CliIo;
  readonly fetchImpl?: typeof fetch;
  readonly siteConfig?: KinloomSiteConfig | null;
}

export interface KinloomCliCommand {
  readonly name: string;
  readonly summary: string;
  readonly help: string;
  run(args: readonly string[], ctx: KinloomCliPluginContext): Promise<CliExitCode> | CliExitCode;
}

export interface KinloomCheckResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly strictWarnings?: readonly string[];
  readonly strictFailures?: readonly string[];
  readonly details?: Record<string, unknown>;
}

export interface KinloomAuditCheckContext {
  readonly repoDir: string;
  readonly personId: string;
  readonly packageDir: string;
  readonly patch: Readonly<Record<string, unknown>>;
  readonly dossierText: string;
  readonly siteConfig: KinloomSiteConfig | null;
  readonly targetPerson: Readonly<Record<string, unknown>> | null;
  readonly livePeople: readonly Readonly<Record<string, unknown>>[];
  readonly mergedPeople: readonly Readonly<Record<string, unknown>>[];
}

export interface KinloomVerifyCheckContext {
  readonly repoDir: string;
  readonly dataDir: string;
  readonly siteConfig: KinloomSiteConfig;
  readonly people: readonly RawPerson[];
  readonly events: readonly RawEvent[];
  readonly places: readonly Place[];
  readonly sources: readonly SourceRecord[];
  readonly kinship: readonly KinshipEdge[];
  readonly media: readonly MediaItem[];
  readonly narratives: readonly Narrative[];
  readonly strictHygiene: boolean;
  readonly strictPronunciation: boolean;
}

export interface KinloomAuditCheck {
  readonly id: string;
  readonly name: string;
  run(ctx: KinloomAuditCheckContext): Promise<KinloomCheckResult> | KinloomCheckResult;
}

export interface KinloomVerifyCheck {
  readonly id: string;
  readonly name: string;
  run(ctx: KinloomVerifyCheckContext): Promise<KinloomCheckResult> | KinloomCheckResult;
}

export interface KinloomCliPlugin {
  readonly id: string;
  readonly name: string;
  readonly commands?: readonly KinloomCliCommand[];
  readonly auditChecks?: readonly KinloomAuditCheck[];
  readonly verifyChecks?: readonly KinloomVerifyCheck[];
}

export interface RegisteredAuditCheck {
  readonly pluginId: string;
  readonly check: KinloomAuditCheck;
}

export interface RegisteredVerifyCheck {
  readonly pluginId: string;
  readonly check: KinloomVerifyCheck;
}

export interface ExecutedPluginCheckResult {
  readonly pluginId: string;
  readonly id: string;
  readonly name: string;
  readonly ok: boolean;
  readonly strictOk: boolean;
  readonly durationMs: number;
  readonly errors: string[];
  readonly warnings: string[];
  readonly strictFailures: string[];
  readonly details?: Record<string, unknown>;
}

export interface DiscoverSiteCliPluginsResult {
  plugins: KinloomCliPlugin[];
  siteConfig: KinloomSiteConfig | null;
  warnings: string[];
}

export interface ResolvedPluginCommands {
  plugins: KinloomCliPlugin[];
  commands: Map<string, KinloomCliCommand>;
  auditChecks: RegisteredAuditCheck[];
  verifyChecks: RegisteredVerifyCheck[];
  warnings: string[];
}
