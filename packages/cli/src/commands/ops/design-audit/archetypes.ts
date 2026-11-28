import { CliValidationError } from '../../../errors.js';
import type { DesignAuditArchetypeId, DesignAuditUiState, DesignAuditViewport } from './types.js';

export interface DesignAuditArchetypeMetrics {
  readonly aboveFoldContentMinRatio: number;
  readonly maxFirstContentYPx: number;
  readonly maxTopLevelNavLinks: number;
  readonly maxPrimaryCtasAboveFold: number;
  readonly proseMeasureChMin: number;
  readonly proseMeasureChIdeal: number;
  readonly proseMeasureChMax: number;
  readonly bodyFontPxMin: number;
  readonly bodyFontPxMax: number;
  readonly lineHeightMin: number;
  readonly lineHeightMax: number;
  readonly maxFontFamilies: number;
  readonly maxUniqueColors: number;
  readonly maxUniqueFontSizes: number;
  readonly featureCongestionWarn: number;
  readonly featureCongestionError: number;
  readonly minWhitespaceRatio: number;
  readonly touchTargetRecommendedPx: number;
  readonly maxIntroWordCount: number;
}

export interface DesignAuditArchetypeSpec {
  readonly id: DesignAuditArchetypeId;
  readonly label: string;
  readonly description: string;
  readonly viewports: readonly DesignAuditViewport[];
  readonly metrics: DesignAuditArchetypeMetrics;
}

export const DESIGN_AUDIT_STANDARDS = Object.freeze({
  version: '1.0.0',
  networkFetchPolicy: 'FORBIDDEN_DURING_AUDIT',
  standards: Object.freeze({
    wcag: 'W3C WCAG 2.2 Recommendation',
    apca: '0.0.98G-4g-base-W3 (public-beta WCAG 3 candidate)',
    dtcg: 'W3C Design Tokens Format & Resolver 2025.10',
    isoErgonomics: 'ISO 9241-110:2020',
    sarif: 'OASIS SARIF 2.1.0 (Errata 01)',
  }),
});

export const DESIGN_AUDIT_INVARIANTS = Object.freeze({
  wcagLegalTargets: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const,
  apcaStatusDisclaimer:
    'APCA (0.0.98G-4g-base-W3) is evaluated as a public-beta perceptual contrast candidate for WCAG 3, paired with WCAG 2.2 AA/AAA compliance checks.',
  apca: Object.freeze({
    bodyPreferredLc: 90,
    bodyMinimumLc: 75,
    fluentMinimumLc: 60,
    largeHeadlineMinimumLc: 45,
    spotMinimumLc: 30,
    darkModeLargeTextMaxLc: 90,
    darkModeLargeTextMinPx: 24,
  }),
  touchTarget: Object.freeze({
    wcag22LegalMinPx: 24,
    workingRecommendedMinPx: 44,
    minGapPx: 8,
  }),
  focus: Object.freeze({
    minIndicatorThicknessPx: 2,
    minIndicatorContrastRatio: 3.0,
    allowStickyOcclusion: false,
  }),
  coreWebVitals: Object.freeze({
    lcpGoodMs: 2500,
    inpGoodMs: 200,
    clsGood: 0.1,
  }),
  uiStackRequiredStates: [
    'ideal',
    'loading',
    'empty-first',
    'empty-zero',
    'partial',
    'error',
  ] as readonly DesignAuditUiState[],
});

export const DESIGN_AUDIT_ARCHETYPES: Readonly<Record<DesignAuditArchetypeId, DesignAuditArchetypeSpec>> =
  Object.freeze({
    editorial: {
      id: 'editorial',
      label: 'Editorial, Archive & Documentation',
      description: 'Reading-first archives, documentation portals, blogs, and narrative publications.',
      viewports: [
        { name: 'mobile-compact', width: 360, height: 800 },
        { name: 'mobile-ios', width: 393, height: 852 },
        { name: 'laptop', width: 1280, height: 800 },
        { name: 'desktop', width: 1440, height: 900 },
      ],
      metrics: {
        aboveFoldContentMinRatio: 0.5,
        maxFirstContentYPx: 360,
        maxTopLevelNavLinks: 7,
        maxPrimaryCtasAboveFold: 1,
        proseMeasureChMin: 45,
        proseMeasureChIdeal: 66,
        proseMeasureChMax: 75,
        bodyFontPxMin: 16,
        bodyFontPxMax: 22,
        lineHeightMin: 1.35,
        lineHeightMax: 1.65,
        maxFontFamilies: 3,
        maxUniqueColors: 24,
        maxUniqueFontSizes: 10,
        featureCongestionWarn: 4.2,
        featureCongestionError: 6.0,
        minWhitespaceRatio: 0.35,
        touchTargetRecommendedPx: 44,
        maxIntroWordCount: 60,
      },
    },
    saas: {
      id: 'saas',
      label: 'SaaS Dashboard & Data Workbench',
      description: 'Operational consoles, analytics views, dense data tables, and multi-section web apps.',
      viewports: [
        { name: 'mobile-compact', width: 360, height: 800 },
        { name: 'tablet', width: 1024, height: 768 },
        { name: 'laptop', width: 1280, height: 800 },
        { name: 'desktop', width: 1440, height: 900 },
      ],
      metrics: {
        aboveFoldContentMinRatio: 0.55,
        maxFirstContentYPx: 280,
        maxTopLevelNavLinks: 9,
        maxPrimaryCtasAboveFold: 2,
        proseMeasureChMin: 40,
        proseMeasureChIdeal: 60,
        proseMeasureChMax: 85,
        bodyFontPxMin: 13,
        bodyFontPxMax: 16,
        lineHeightMin: 1.25,
        lineHeightMax: 1.55,
        maxFontFamilies: 3,
        maxUniqueColors: 36,
        maxUniqueFontSizes: 12,
        featureCongestionWarn: 5.5,
        featureCongestionError: 7.5,
        minWhitespaceRatio: 0.22,
        touchTargetRecommendedPx: 44,
        maxIntroWordCount: 35,
      },
    },
    ecommerce: {
      id: 'ecommerce',
      label: 'E-Commerce Storefront & Checkout',
      description: 'Category grids, product detail pages, carts, and checkout flows.',
      viewports: [
        { name: 'mobile-compact', width: 360, height: 800 },
        { name: 'mobile-ios', width: 393, height: 852 },
        { name: 'laptop', width: 1280, height: 800 },
        { name: 'desktop', width: 1440, height: 900 },
      ],
      metrics: {
        aboveFoldContentMinRatio: 0.55,
        maxFirstContentYPx: 320,
        maxTopLevelNavLinks: 8,
        maxPrimaryCtasAboveFold: 1,
        proseMeasureChMin: 40,
        proseMeasureChIdeal: 60,
        proseMeasureChMax: 75,
        bodyFontPxMin: 15,
        bodyFontPxMax: 18,
        lineHeightMin: 1.3,
        lineHeightMax: 1.55,
        maxFontFamilies: 3,
        maxUniqueColors: 32,
        maxUniqueFontSizes: 12,
        featureCongestionWarn: 5.2,
        featureCongestionError: 7.0,
        minWhitespaceRatio: 0.25,
        touchTargetRecommendedPx: 48,
        maxIntroWordCount: 40,
      },
    },
    'mobile-app': {
      id: 'mobile-app',
      label: 'Mobile-First Consumer App',
      description: 'Touch-first feeds, utilities, booking flows, and responsive PWAs.',
      viewports: [
        { name: 'mobile-compact', width: 360, height: 800 },
        { name: 'mobile-ios', width: 393, height: 852 },
        { name: 'mobile-large', width: 430, height: 932 },
      ],
      metrics: {
        aboveFoldContentMinRatio: 0.6,
        maxFirstContentYPx: 240,
        maxTopLevelNavLinks: 5,
        maxPrimaryCtasAboveFold: 1,
        proseMeasureChMin: 35,
        proseMeasureChIdeal: 50,
        proseMeasureChMax: 65,
        bodyFontPxMin: 15,
        bodyFontPxMax: 18,
        lineHeightMin: 1.3,
        lineHeightMax: 1.55,
        maxFontFamilies: 2,
        maxUniqueColors: 28,
        maxUniqueFontSizes: 10,
        featureCongestionWarn: 4.8,
        featureCongestionError: 6.5,
        minWhitespaceRatio: 0.28,
        touchTargetRecommendedPx: 48,
        maxIntroWordCount: 30,
      },
    },
  });

export const DESIGN_AUDIT_ARCHETYPE_IDS: readonly DesignAuditArchetypeId[] = [
  'editorial',
  'saas',
  'ecommerce',
  'mobile-app',
];

export function resolveDesignAuditArchetype(raw: string | undefined): DesignAuditArchetypeSpec {
  const key = (raw ?? 'editorial').trim().toLowerCase();
  if (key in DESIGN_AUDIT_ARCHETYPES) {
    return DESIGN_AUDIT_ARCHETYPES[key as DesignAuditArchetypeId];
  }
  throw new CliValidationError(
    `Unknown design-audit archetype '${raw ?? ''}'. Expected one of: ${DESIGN_AUDIT_ARCHETYPE_IDS.join(', ')}.`
  );
}
