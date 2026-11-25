import { z } from 'zod';

const HexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a 6-digit hex color such as #7A4612');

export const SiteMetadataSchema = z.object({
  title: z.string().min(1),
  familyName: z.string().min(1),
  gedcomSourceName: z
    .string()
    .min(1)
    .regex(/^[A-Z0-9_]+$/, 'GEDCOM SOUR identifier must be uppercase alphanumeric with underscores'),
  description: z.string().optional(),
  footerCredit: z.string().default('Built with Kinloom'),
});

export const SiteThemeConfigSchema = z.object({
  accent: HexColorSchema.optional(),
});

export const BranchConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  surnames: z.array(z.string().min(1)).default([]),
  lineageGroups: z.array(z.string().min(1)).default([]),
  supportsDirectMode: z.boolean().default(true),
});

export const LineageSectionConfigSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  lineageGroups: z.array(z.string().min(1)).default([]),
  branchId: z.string().optional(),
});

export const FeaturedKinshipPairSchema = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  label: z.string().min(1),
  note: z.string().optional(),
});

export const MigrationEraConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  color: HexColorSchema.optional(),
  minLat: z.number().min(-90).max(90).optional(),
  maxLat: z.number().min(-90).max(90).optional(),
  minLng: z.number().min(-180).max(180).optional(),
  maxLng: z.number().min(-180).max(180).optional(),
  startYear: z.number().int().optional(),
  endYear: z.number().int().optional(),
});

export const MapDefaultsConfigSchema = z.object({
  centerLat: z.number().min(-90).max(90).default(38.5),
  centerLng: z.number().min(-180).max(180).default(-96.0),
  zoom: z.number().min(1).max(18).default(4),
  minSpanDeg: z.number().positive().default(1.2),
});

export const AnchorYearConfigSchema = z.object({
  year: z.number().int(),
  label: z.string().min(1),
});

export const PrivacyConfigSchema = z.object({
  livingCutoffYears: z.number().int().min(1).max(150).default(101),
  referenceYear: z.number().int().min(1900).max(2200).optional(),
  privateModeShowsBirthYear: z.boolean().default(true),
  stripLivingPortraits: z.boolean().default(true),
  stripLivingResidenceSpans: z.boolean().default(true),
  markGedcomLivingConfidential: z.boolean().default(true),
});

export const WikiConfigSchema = z.object({
  allowTalk: z.boolean().default(true),
  allowWatchlists: z.boolean().default(false),
  maxUploadBytes: z.number().int().positive().default(15 * 1024 * 1024),
});

export const KinloomSiteConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  site: SiteMetadataSchema,
  theme: SiteThemeConfigSchema.optional(),
  defaultBranchId: z.string().min(1).optional(),
  branches: z.array(BranchConfigSchema).default([]),
  lineageSections: z.array(LineageSectionConfigSchema).default([]),
  featuredDocumentId: z.string().min(1).optional(),
  featuredKinshipPairs: z.array(FeaturedKinshipPairSchema).default([]),
  migrationEras: z.array(MigrationEraConfigSchema).default([]),
  mapDefaults: MapDefaultsConfigSchema.prefault({}),
  anchorYears: z.array(AnchorYearConfigSchema).optional(),
  privacy: PrivacyConfigSchema.prefault({}),
  wiki: WikiConfigSchema.optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export type SiteMetadata = z.infer<typeof SiteMetadataSchema>;
export type SiteThemeConfig = z.infer<typeof SiteThemeConfigSchema>;
export type BranchConfig = z.infer<typeof BranchConfigSchema>;
export type LineageSectionConfig = z.infer<typeof LineageSectionConfigSchema>;
export type FeaturedKinshipPair = z.infer<typeof FeaturedKinshipPairSchema>;
export type MigrationEraConfig = z.infer<typeof MigrationEraConfigSchema>;
export type MapDefaultsConfig = z.infer<typeof MapDefaultsConfigSchema>;
export type AnchorYearConfig = z.infer<typeof AnchorYearConfigSchema>;
export type PrivacyConfig = z.infer<typeof PrivacyConfigSchema>;
export type WikiConfig = z.infer<typeof WikiConfigSchema>;
export type KinloomSiteConfig = z.infer<typeof KinloomSiteConfigSchema>;
export type KinloomSiteConfigInput = z.input<typeof KinloomSiteConfigSchema>;

export const DEFAULT_MIGRATION_ERAS: readonly MigrationEraConfig[] = [
  { id: 'europe', label: 'Europe', minLng: -20 },
  { id: 'eastern', label: 'Eastern Seaboard', minLng: -82, maxLng: -20 },
  { id: 'interior', label: 'Interior Frontier', minLng: -108, maxLng: -82, minLat: 36.5 },
  { id: 'southern', label: 'Southern Plains', minLng: -108, maxLng: -82, maxLat: 36.5 },
  { id: 'western', label: 'Pacific West', maxLng: -108 },
];

export const DEFAULT_ANCHOR_YEARS: readonly AnchorYearConfig[] = [
  { year: 1620, label: '1620' },
  { year: 1665, label: '1665' },
  { year: 1715, label: '1715' },
  { year: 1776, label: '1776' },
  { year: 1850, label: '1850' },
  { year: 1880, label: '1880' },
  { year: 1900, label: '1900' },
  { year: 1910, label: '1910' },
  { year: 1920, label: '1920' },
  { year: 1930, label: '1930' },
  { year: 1940, label: '1940' },
  { year: 1955, label: '1955' },
];

export function parseKinloomConfig(input: unknown): KinloomSiteConfig {
  return KinloomSiteConfigSchema.parse(input);
}

export function resolveDefaultBranchId(config?: KinloomSiteConfig | null): string {
  if (!config) {
    return 'primary';
  }
  if (config.defaultBranchId) {
    return config.defaultBranchId;
  }
  if (config.branches.length > 0) {
    return config.branches[0].id;
  }
  return 'primary';
}
