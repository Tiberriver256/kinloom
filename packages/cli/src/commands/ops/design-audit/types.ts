export type DesignAuditArchetypeId = 'editorial' | 'saas' | 'ecommerce' | 'mobile-app';

export type DesignAuditMode = 'audit-only' | 'remediate' | 'static-degraded';

export type DesignAuditTheme = 'light' | 'dark' | 'more-contrast';

export type DesignAuditUiState =
  | 'ideal'
  | 'loading'
  | 'empty-first'
  | 'empty-cleared'
  | 'empty-zero'
  | 'partial'
  | 'error'
  | 'focus'
  | 'text-spacing'
  | 'reduced-motion'
  | 'static';

export type DesignAuditPillar = 'I' | 'II' | 'III' | 'IV';

export type DesignAuditSeverity = 'error' | 'warning' | 'note';

export type DesignAuditProvenance =
  | 'deterministic'
  | 'vlm-reference-anchored'
  | 'vlm-uncalibrated'
  | 'code-translated';

export interface DesignAuditViewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export interface DesignAuditRouteConfig {
  readonly path: string;
  readonly archetype: DesignAuditArchetypeId;
  readonly uiStates?: readonly DesignAuditUiState[];
  readonly apiInterceptPattern?: string;
  readonly partialPayload?: Record<string, unknown>;
}

export interface DesignAuditPlan {
  readonly runId: string;
  readonly baseUrl: string;
  readonly mode: DesignAuditMode;
  readonly repoRoot?: string;
  readonly fixedIsoTime?: string;
  readonly themes?: readonly DesignAuditTheme[];
  readonly tokenPaths?: readonly string[];
  readonly cssPaths?: readonly string[];
  readonly routes: readonly DesignAuditRouteConfig[];
}

export interface DesignAuditPhysicalLocation {
  readonly uri?: string;
  readonly startLine?: number;
  readonly selector?: string;
}

export interface DesignAuditEvidence {
  readonly screenshotUri: string;
  readonly boundingBoxPx?: readonly [number, number, number, number];
  readonly pairwiseVerdict?: 'reference_wins' | 'candidate_wins' | 'tie' | 'swapped_conflict' | 'n/a';
}

export interface DesignAuditFinding {
  readonly ruleId: string;
  readonly metricId: string;
  readonly pillar: DesignAuditPillar;
  readonly provenance: DesignAuditProvenance;
  readonly severity: DesignAuditSeverity;
  readonly confidence: number;
  readonly route: string;
  readonly viewport: string;
  readonly theme: DesignAuditTheme | 'all';
  readonly uiState: DesignAuditUiState;
  readonly message: string;
  readonly measuredValue?: number | string | undefined;
  readonly thresholdValue?: number | string | undefined;
  readonly physicalLocation?: DesignAuditPhysicalLocation | undefined;
  readonly evidence: DesignAuditEvidence;
  readonly masterCitations: readonly string[];
  readonly remediationHint?: string | undefined;
}

export interface DesignAuditInteractiveSample {
  readonly tag: string;
  readonly role: string;
  readonly text: string;
  readonly rect: readonly [number, number, number, number];
  readonly visible: boolean;
  readonly touchAction: string;
  readonly pointerEvents: string;
}

export interface DesignAuditTextSample {
  readonly tag: string;
  readonly text: string;
  readonly fontSizePx: number;
  readonly fontWeight: number;
  readonly fontStyle: string;
  readonly lineHeight: string;
  readonly textDecorationLine: string;
  readonly textTransform: string;
  readonly fontFamily: string;
  readonly color: string;
  readonly backgroundColor: string;
  readonly rect: readonly [number, number, number, number];
}

export interface DesignAuditFocusIssue {
  readonly type: 'focus-occluded' | 'focus-missing-indicator';
  readonly target: string;
  readonly rect: readonly [number, number, number, number];
  readonly occluder?: string;
}

export interface DesignAuditClippedTextSample {
  readonly tag: string;
  readonly text: string;
  readonly rect: readonly [number, number, number, number];
}

export interface DesignAuditTelemetry {
  readonly viewport: string;
  readonly docOverflowX: number;
  readonly aboveFoldMainRatio: number;
  readonly aboveFoldChromeRatio: number;
  readonly navLinkCount: number;
  readonly title: string;
  readonly h1Text: string;
  readonly h1Truncated: boolean;
  readonly h1Rect: readonly [number, number, number, number] | null;
  readonly viewportMeta: string;
  readonly interactives: readonly DesignAuditInteractiveSample[];
  readonly textSamples: readonly DesignAuditTextSample[];
  readonly focusIssues?: readonly DesignAuditFocusIssue[];
  readonly textSpacingClipped?: readonly DesignAuditClippedTextSample[];
  readonly axNodeCount?: number;
}

export interface DesignAuditCaptureRecord {
  readonly id: string;
  readonly route: string;
  readonly archetype: DesignAuditArchetypeId;
  readonly viewport: string;
  readonly theme: DesignAuditTheme;
  readonly uiState: DesignAuditUiState;
  readonly screenshotUri: string;
  readonly screenshotSha256: string;
  readonly telemetryUri?: string;
  readonly runningAnimationsUnderReducedMotion?: number;
}

export interface DesignAuditManifest {
  readonly runId: string;
  readonly sealedAtUtc: string;
  readonly baseUrl: string;
  readonly mode: DesignAuditMode;
  readonly deterministicRuntime: boolean;
  readonly coverage: 'full' | 'partial';
  readonly captureCount: number;
  readonly cssFiles: readonly string[];
  readonly captures: readonly DesignAuditCaptureRecord[];
}

export interface DesignAuditCssStats {
  readonly rules: number;
  readonly declarations: number;
  readonly uniqueColors: number;
  readonly uniqueFontSizes: number;
  readonly importants: number;
  readonly scannedCssFiles: number;
  readonly scannedTokenFiles: number;
}

export interface DesignAuditCssResult {
  readonly ok: boolean;
  readonly archetype: DesignAuditArchetypeId;
  readonly cssStats: DesignAuditCssStats | null;
  readonly findings: readonly DesignAuditFinding[];
  readonly outputPath?: string;
}

export interface SarifRule {
  readonly id: string;
  readonly name: string;
  readonly shortDescription: { readonly text: string };
  readonly properties: {
    readonly metricId: string;
    readonly pillar: DesignAuditPillar;
    readonly masterCitations: readonly string[];
  };
}

export interface SarifResult {
  readonly ruleId: string;
  readonly level: DesignAuditSeverity;
  readonly baselineState: 'new' | 'unchanged';
  readonly message: { readonly text: string };
  readonly partialFingerprints: {
    readonly primaryLocationLineHash: string;
  };
  readonly locations: readonly [
    {
      readonly physicalLocation: {
        readonly artifactLocation: { readonly uri: string };
        readonly region?: { readonly startLine: number };
      };
      readonly logicalLocations: readonly [
        {
          readonly fullyQualifiedName: string;
          readonly kind: 'route';
        },
      ];
    },
  ];
  readonly properties: {
    readonly provenance: DesignAuditProvenance;
    readonly confidence: number;
    readonly measuredValue: number | string | null;
    readonly thresholdValue: number | string | null;
    readonly evidence: DesignAuditEvidence;
    readonly masterCitations: readonly string[];
    readonly remediationHint: string;
  };
}

export interface SarifRun {
  readonly tool: {
    readonly driver: {
      readonly name: string;
      readonly version: string;
      readonly informationUri: string;
      readonly rules: readonly SarifRule[];
    };
  };
  readonly results: readonly SarifResult[];
}

export interface SarifReport {
  readonly $schema: string;
  readonly version: '2.1.0';
  readonly runs: readonly SarifRun[];
}

export interface DesignAuditSarifSummary {
  readonly ok: boolean;
  readonly sarifPath: string;
  readonly dossierPath: string;
  readonly totalFindings: number;
  readonly blockingErrors: number;
  readonly warnings: number;
  readonly notes: number;
  readonly newBlockingRegressions: number;
}
