import { z } from 'zod';

export const BOOK_PUBLISHING_PLUGIN_ID = 'kinloom-book-publishing';
export const BOOK_PUBLISHING_ROUTE_PREFIX = '/api/plugins/book-publishing';
export const BOOK_PUBLISHING_STATUS_ROUTE = `${BOOK_PUBLISHING_ROUTE_PREFIX}/status`;
export const BOOK_PUBLISHING_COMPILE_ROUTE = `${BOOK_PUBLISHING_ROUTE_PREFIX}/compile`;
export const BOOK_PUBLISHING_ESTIMATE_ROUTE = `${BOOK_PUBLISHING_ROUTE_PREFIX}/estimate`;
export const BOOK_PUBLISHING_JOBS_ROUTE = `${BOOK_PUBLISHING_ROUTE_PREFIX}/jobs`;
export const BOOK_PUBLISHING_ARTIFACTS_ROUTE = `${BOOK_PUBLISHING_ROUTE_PREFIX}/artifacts`;
export const BOOK_PUBLISHING_WEBHOOK_LULU_ROUTE = `${BOOK_PUBLISHING_ROUTE_PREFIX}/webhooks/lulu`;

export const BOOK_TRIM_PRESET_IDS = [
  'us-letter-landscape',
  'a4-landscape',
  'photo-10x8-landscape',
  'small-9x7-landscape',
] as const;

export const BookTrimPresetIdSchema = z.enum(BOOK_TRIM_PRESET_IDS);
export type BookTrimPresetId = z.infer<typeof BookTrimPresetIdSchema>;

export const BOOK_BINDING_STYLES = ['hardcover-casewrap-glossy', 'hardcover-casewrap-matte'] as const;
export const BookBindingStyleSchema = z.enum(BOOK_BINDING_STYLES);
export type BookBindingStyle = z.infer<typeof BookBindingStyleSchema>;

export const BOOK_PAPER_STOCKS = ['80lb-coated-white-color', '60lb-uncoated-white-color'] as const;
export const BookPaperStockSchema = z.enum(BOOK_PAPER_STOCKS);
export type BookPaperStock = z.infer<typeof BookPaperStockSchema>;

export const BOOK_SHIPPING_LEVELS = ['mail', 'ground', 'expedited', 'express'] as const;
export const BookShippingLevelSchema = z.enum(BOOK_SHIPPING_LEVELS);
export type BookShippingLevel = z.infer<typeof BookShippingLevelSchema>;

export const BOOK_EDITIONS = ['public', 'private'] as const;
export const BookEditionSchema = z.enum(BOOK_EDITIONS);
export type BookEdition = z.infer<typeof BookEditionSchema>;

export const BOOK_PUBLISHER_PROVIDER_IDS = ['mock', 'lulu'] as const;
export const BookPublisherProviderIdSchema = z.enum(BOOK_PUBLISHER_PROVIDER_IDS);
export type BookPublisherProviderId = z.infer<typeof BookPublisherProviderIdSchema>;

export const BOOK_PUBLISHER_ENVIRONMENTS = ['sandbox', 'production'] as const;
export const BookPublisherEnvironmentSchema = z.enum(BOOK_PUBLISHER_ENVIRONMENTS);
export type BookPublisherEnvironment = z.infer<typeof BookPublisherEnvironmentSchema>;

export const BookPhysicalSpecSchema = z.object({
  trimPreset: BookTrimPresetIdSchema,
  binding: BookBindingStyleSchema,
  paperStock: BookPaperStockSchema,
  interiorPageCount: z.number().int().min(24).max(800),
});
export type BookPhysicalSpec = z.infer<typeof BookPhysicalSpecSchema>;

export interface BookTrimPresetSpec {
  readonly id: BookTrimPresetId;
  readonly label: string;
  readonly trimWidthIn: number;
  readonly trimHeightIn: number;
  readonly trimWidthMm: number;
  readonly trimHeightMm: number;
  readonly luluTrimToken: string;
}

export interface PdfBoxPt {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export interface BookInteriorGeometry {
  readonly trimPreset: BookTrimPresetId;
  readonly trimWidthIn: number;
  readonly trimHeightIn: number;
  readonly trimWidthMm: number;
  readonly trimHeightMm: number;
  readonly bleedIn: number;
  readonly bleedWidthIn: number;
  readonly bleedHeightIn: number;
  readonly bleedWidthPt: number;
  readonly bleedHeightPt: number;
  readonly safetyMarginIn: number;
  readonly insideGutterIn: number;
  readonly mediaBoxPt: PdfBoxPt;
  readonly bleedBoxPt: PdfBoxPt;
  readonly trimBoxPt: PdfBoxPt;
}

export interface CoverDimensionsResult {
  readonly totalWidthIn: number;
  readonly totalHeightIn: number;
  readonly totalWidthPt: number;
  readonly totalHeightPt: number;
  readonly spineWidthIn: number;
  readonly wrapAllowanceIn: number;
  readonly allowSpineText: boolean;
  readonly maxSpineTextHeightIn: number;
  readonly barcodeClearanceIn: {
    readonly xIn: number;
    readonly yIn: number;
    readonly widthIn: number;
    readonly heightIn: number;
  };
  readonly source: 'provider_api' | 'offline_estimate';
  readonly providerSku: string;
}

export interface BookImageDimensions {
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface BookImageDpiAudit {
  readonly mediaId: string;
  readonly file: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly placedWidthIn: number;
  readonly placedHeightIn: number;
  readonly effectiveDpi: number;
  readonly status: 'pass' | 'warn' | 'low';
  readonly recommendedWidthIn: number;
  readonly recommendedHeightIn: number;
}

export interface BookCompileOptions {
  readonly title?: string;
  readonly subtitle?: string;
  readonly dedication?: string;
  readonly trimPreset?: BookTrimPresetId;
  readonly binding?: BookBindingStyle;
  readonly paperStock?: BookPaperStock;
  readonly edition?: BookEdition;
  readonly includeLiving?: boolean;
  readonly allowLivingPortraits?: boolean;
  readonly acknowledgeReviewFlags?: boolean;
  readonly branchId?: string;
  readonly rootPersonId?: string;
  readonly proofMarks?: boolean;
  readonly referenceYear?: number;
  readonly generatedAtIso?: string;
  readonly imageDimensionsByFile?: Readonly<Record<string, BookImageDimensions>>;
}

export const BookShippingAddressSchema = z.object({
  name: z.string().trim().min(1).max(120),
  street1: z.string().trim().min(1).max(160),
  street2: z.string().trim().max(160).optional(),
  city: z.string().trim().min(1).max(100),
  stateCode: z.string().trim().max(20).optional(),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{2}$/, 'Country code must be a 2-letter ISO-3166-1 alpha-2 code.')
    .transform((v) => v.toUpperCase()),
  postalCode: z.string().trim().min(1).max(24),
  phoneNumber: z.string().trim().min(5).max(32),
});
export type BookShippingAddress = z.infer<typeof BookShippingAddressSchema>;

export interface BookQuoteRequest {
  readonly spec: BookPhysicalSpec;
  readonly quantity: number;
  readonly shippingAddress: BookShippingAddress;
  readonly shippingLevel: BookShippingLevel;
}

export interface BookQuoteResult {
  readonly providerId: string;
  readonly providerSku: string;
  readonly currency: string;
  readonly manufacturingCostCents: number;
  readonly shippingCostCents: number;
  readonly fulfillmentFeeCents: number;
  readonly taxCents: number;
  readonly totalCostCents: number;
  readonly sandbox: boolean;
}

export interface BookValidationResult {
  readonly ok: boolean;
  readonly status: 'validated' | 'normalized' | 'validating' | 'error';
  readonly validationId: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

export interface BookPrintJobRequest {
  readonly externalId: string;
  readonly title: string;
  readonly contactEmail: string;
  readonly spec: BookPhysicalSpec;
  readonly quantity: number;
  readonly interiorPdfUrl: string;
  readonly coverPdfUrl: string;
  readonly shippingAddress: BookShippingAddress;
  readonly shippingLevel: BookShippingLevel;
}

export const BOOK_PRINT_JOB_STATUSES = [
  'created',
  'validating',
  'ready_for_production',
  'in_production',
  'shipped',
  'rejected',
  'canceled',
] as const;

export const BookPrintJobStatusSchema = z.enum(BOOK_PRINT_JOB_STATUSES);
export type BookPrintJobStatus = z.infer<typeof BookPrintJobStatusSchema>;

export interface BookPrintJobRecord {
  readonly providerId: string;
  readonly jobId: string;
  readonly externalId: string;
  readonly title: string;
  readonly status: BookPrintJobStatus;
  readonly statusDetail?: string;
  readonly trackingUrls: readonly string[];
  readonly sandbox: boolean;
  readonly quantity: number;
  readonly spec: BookPhysicalSpec;
  readonly updatedAt: string;
}

export interface BookPublisherProvider {
  readonly id: string;
  readonly displayName: string;
  readonly sandbox: boolean;
  resolveProviderSku(spec: BookPhysicalSpec): string;
  getCoverDimensions(spec: BookPhysicalSpec): Promise<CoverDimensionsResult>;
  estimateCost(request: BookQuoteRequest): Promise<BookQuoteResult>;
  validateInteriorAndCover(params: {
    readonly spec: BookPhysicalSpec;
    readonly interiorPdfUrl: string;
    readonly coverPdfUrl: string;
  }): Promise<{
    readonly interior: BookValidationResult;
    readonly cover: BookValidationResult;
  }>;
  createPrintJob(request: BookPrintJobRequest): Promise<BookPrintJobRecord>;
  getPrintJobStatus(jobId: string): Promise<BookPrintJobRecord>;
  verifyWebhookSignature?(rawBody: Uint8Array, headers: Headers): Promise<boolean>;
}

export type BookPageKind =
  | 'half-title'
  | 'title'
  | 'dedication'
  | 'toc'
  | 'preface'
  | 'overview'
  | 'pedigree'
  | 'chapter-opener'
  | 'biography'
  | 'photo-plate'
  | 'gazetteer'
  | 'migration-map'
  | 'endnotes'
  | 'index'
  | 'colophon'
  | 'notes-ledger'
  | 'blank-verso';

export interface BookCompiledPage {
  readonly pageNumber: number;
  readonly kind: BookPageKind;
  readonly sectionTitle: string;
  readonly heading: string;
  readonly subtitle?: string;
  readonly lines: readonly string[];
  readonly footnotes: readonly string[];
}

export interface BookChapterSummary {
  readonly id: string;
  readonly title: string;
  readonly startPage: number;
  readonly personCount: number;
  readonly mediaCount: number;
}

export interface BookIndexEntry {
  readonly term: string;
  readonly category: 'person' | 'place';
  readonly pages: readonly number[];
}

export interface BookBuildWarning {
  readonly code: 'low_resolution_image' | 'medium_resolution_image' | 'privacy_review_acknowledged';
  readonly message: string;
  readonly entityId?: string;
}

export interface BookBuildReport {
  readonly title: string;
  readonly subtitle: string;
  readonly familyName: string;
  readonly edition: BookEdition;
  readonly colophonNotice: string;
  readonly generatedAt: string;
  readonly scope: {
    readonly branchId: string | null;
    readonly rootPersonId: string | null;
  };
  readonly counts: {
    readonly includedPeople: number;
    readonly excludedLivingPeople: number;
    readonly includedEvents: number;
    readonly includedPlaces: number;
    readonly includedSources: number;
    readonly includedMedia: number;
    readonly excludedLivingMedia: number;
    readonly includedNarratives: number;
    readonly rawContentPages: number;
    readonly paddingPages: number;
    readonly finalPageCount: number;
  };
  readonly spec: BookPhysicalSpec;
  readonly interiorGeometry: BookInteriorGeometry;
  readonly coverDimensions: CoverDimensionsResult;
  readonly chapters: readonly BookChapterSummary[];
  readonly imageAudits: readonly BookImageDpiAudit[];
  readonly warnings: readonly BookBuildWarning[];
  readonly privacy: {
    readonly edition: BookEdition;
    readonly livingPeopleExcluded: number;
    readonly livingMediaExcluded: number;
    readonly reviewFlagsDetected: number;
    readonly reviewFlagsAcknowledged: boolean;
  };
}

export interface CompiledBookDocument {
  readonly report: BookBuildReport;
  readonly pages: readonly BookCompiledPage[];
  readonly indexEntries: readonly BookIndexEntry[];
  readonly interiorHtml: string;
  readonly coverHtml: string;
}

export interface PdfRendererPort {
  readonly adapterKind: string;
  renderInterior(doc: CompiledBookDocument): Promise<Uint8Array>;
  renderCover(doc: CompiledBookDocument, coverDimensions?: CoverDimensionsResult): Promise<Uint8Array>;
}
