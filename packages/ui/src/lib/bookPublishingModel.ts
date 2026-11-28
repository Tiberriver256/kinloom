export const BOOK_PUBLISHING_SERVER_PLUGIN_ID = 'kinloom-book-publishing';

export const UI_BOOK_TRIM_PRESETS = [
  { id: 'us-letter-landscape', label: 'US Letter Landscape (11 × 8.5 in)' },
  { id: 'a4-landscape', label: 'A4 Landscape (11.69 × 8.27 in)' },
  { id: 'photo-10x8-landscape', label: 'Photo Landscape (10 × 8 in)' },
  { id: 'small-9x7-landscape', label: 'Small Landscape (9 × 7 in)' },
] as const;

export type UiBookTrimPresetId = (typeof UI_BOOK_TRIM_PRESETS)[number]['id'];

export const UI_BOOK_BINDINGS = [
  { id: 'hardcover-casewrap-glossy', label: 'Casewrap Glossy Hardcover' },
  { id: 'hardcover-casewrap-matte', label: 'Casewrap Matte Hardcover' },
] as const;

export type UiBookBindingStyle = (typeof UI_BOOK_BINDINGS)[number]['id'];

export const UI_BOOK_PAPER_STOCKS = [
  { id: '80lb-coated-white-color', label: '80# Coated White Color (444 PPI)' },
  { id: '60lb-uncoated-white-color', label: '60# Uncoated White Color (380 PPI)' },
] as const;

export type UiBookPaperStock = (typeof UI_BOOK_PAPER_STOCKS)[number]['id'];

export const UI_BOOK_SHIPPING_LEVELS = [
  { id: 'mail', label: 'Mail' },
  { id: 'ground', label: 'Ground' },
  { id: 'expedited', label: 'Expedited' },
  { id: 'express', label: 'Express' },
] as const;

export type UiBookShippingLevel = (typeof UI_BOOK_SHIPPING_LEVELS)[number]['id'];
export type UiBookEdition = 'public' | 'private';

export interface UiBookShippingAddress {
  readonly name: string;
  readonly street1: string;
  readonly street2?: string;
  readonly city: string;
  readonly stateCode?: string;
  readonly countryCode: string;
  readonly postalCode: string;
  readonly phoneNumber: string;
}

export interface UiBookPrintJob {
  readonly providerId: string;
  readonly jobId: string;
  readonly externalId: string;
  readonly title: string;
  readonly status: string;
  readonly statusDetail?: string;
  readonly trackingUrls: readonly string[];
  readonly sandbox: boolean;
  readonly quantity: number;
  readonly updatedAt: string;
}

export interface UiBookStatusResponse {
  readonly plugin_id: string;
  readonly active_publisher: string;
  readonly publisher_provider: string;
  readonly environment: 'sandbox' | 'production';
  readonly pdf_renderer: string;
  readonly lulu_credentials_configured: boolean;
  readonly defaults: {
    readonly trim_preset: UiBookTrimPresetId;
    readonly binding: UiBookBindingStyle;
    readonly paper_stock: UiBookPaperStock;
    readonly shipping_level: UiBookShippingLevel;
    readonly contact_email: string;
  };
  readonly branches: readonly { readonly id: string; readonly label: string }[];
  readonly readiness: {
    readonly included_people: number;
    readonly excluded_living_people: number;
    readonly included_media: number;
    readonly excluded_living_media: number;
    readonly estimated_pages: number;
    readonly spine_width_in: number;
    readonly allow_spine_text: boolean;
    readonly provider_sku: string;
    readonly review_flags_detected: number;
  } | null;
  readonly jobs: readonly UiBookPrintJob[];
}

export interface UiBookCompileInput {
  readonly title?: string;
  readonly subtitle?: string;
  readonly dedication?: string;
  readonly trimPreset: UiBookTrimPresetId;
  readonly binding: UiBookBindingStyle;
  readonly paperStock: UiBookPaperStock;
  readonly edition: UiBookEdition;
  readonly includeLiving?: boolean;
  readonly acknowledgeReviewFlags?: boolean;
  readonly branchId?: string;
}

export interface UiBookCompileResponse {
  readonly renderer: string;
  readonly report: {
    readonly title: string;
    readonly subtitle: string;
    readonly edition: UiBookEdition;
    readonly colophonNotice: string;
    readonly counts: {
      readonly includedPeople: number;
      readonly excludedLivingPeople: number;
      readonly includedMedia: number;
      readonly excludedLivingMedia: number;
      readonly rawContentPages: number;
      readonly paddingPages: number;
      readonly finalPageCount: number;
    };
    readonly coverDimensions: {
      readonly totalWidthIn: number;
      readonly totalHeightIn: number;
      readonly spineWidthIn: number;
      readonly allowSpineText: boolean;
      readonly providerSku: string;
    };
    readonly warnings: readonly { readonly code: string; readonly message: string }[];
  };
  readonly artifacts: {
    readonly interior_pdf_url: string;
    readonly cover_pdf_url: string;
    readonly interior_bytes: number;
    readonly cover_bytes: number;
    readonly expires_at: string;
  };
}

export interface UiBookEstimateInput {
  readonly trimPreset: UiBookTrimPresetId;
  readonly binding: UiBookBindingStyle;
  readonly paperStock: UiBookPaperStock;
  readonly interiorPageCount: number;
  readonly quantity: number;
  readonly shippingLevel: UiBookShippingLevel;
  readonly shippingAddress: UiBookShippingAddress;
}

export interface UiBookEstimateResponse {
  readonly quote: {
    readonly providerId: string;
    readonly providerSku: string;
    readonly currency: string;
    readonly manufacturingCostCents: number;
    readonly shippingCostCents: number;
    readonly fulfillmentFeeCents: number;
    readonly taxCents: number;
    readonly totalCostCents: number;
    readonly sandbox: boolean;
  };
  readonly cover_dimensions: {
    readonly totalWidthIn: number;
    readonly totalHeightIn: number;
    readonly spineWidthIn: number;
    readonly allowSpineText: boolean;
    readonly providerSku: string;
  };
}

export interface UiBookSubmitJobInput extends UiBookCompileInput {
  readonly quantity: number;
  readonly shippingLevel: UiBookShippingLevel;
  readonly shippingAddress: UiBookShippingAddress;
  readonly contactEmail?: string;
  readonly confirmProduction?: boolean;
}

export interface UiBookSubmitJobResponse {
  readonly job: UiBookPrintJob;
}

export function formatBookCurrencyCents(cents: number, currency = 'USD'): string {
  const safe = Number.isFinite(cents) ? cents : 0;
  const amount = (safe / 100).toFixed(2);
  if (currency === 'USD') {
    return `$${amount}`;
  }
  return `${amount} ${currency}`;
}

export function formatBookByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.round(bytes || 0))} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatBookJobStatusLabel(status: string): string {
  switch (status) {
    case 'created':
      return 'Created';
    case 'validating':
      return 'Validating PDFs';
    case 'ready_for_production':
      return 'Ready for Print';
    case 'in_production':
      return 'In Production';
    case 'shipped':
      return 'Shipped';
    case 'rejected':
      return 'Rejected';
    case 'canceled':
      return 'Canceled';
    default:
      return status;
  }
}

export function validateUiShippingAddress(address: UiBookShippingAddress): string | null {
  if (!address.name.trim()) {
    return 'Recipient name is required.';
  }
  if (!address.street1.trim()) {
    return 'Street address is required.';
  }
  if (!address.city.trim()) {
    return 'City is required.';
  }
  if (!/^[A-Za-z]{2}$/.test(address.countryCode.trim())) {
    return 'Country must be a 2-letter ISO code (for example, US).';
  }
  if (!address.postalCode.trim()) {
    return 'Postal code is required.';
  }
  if (address.phoneNumber.trim().length < 5) {
    return 'Phone number is required for carrier delivery.';
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseTrimPreset(value: unknown): UiBookTrimPresetId {
  for (const preset of UI_BOOK_TRIM_PRESETS) {
    if (preset.id === value) {
      return preset.id;
    }
  }
  return 'us-letter-landscape';
}

function parseBinding(value: unknown): UiBookBindingStyle {
  for (const item of UI_BOOK_BINDINGS) {
    if (item.id === value) {
      return item.id;
    }
  }
  return 'hardcover-casewrap-glossy';
}

function parsePaperStock(value: unknown): UiBookPaperStock {
  for (const item of UI_BOOK_PAPER_STOCKS) {
    if (item.id === value) {
      return item.id;
    }
  }
  return '80lb-coated-white-color';
}

function parseShippingLevel(value: unknown): UiBookShippingLevel {
  for (const item of UI_BOOK_SHIPPING_LEVELS) {
    if (item.id === value) {
      return item.id;
    }
  }
  return 'ground';
}

function parsePrintJob(raw: unknown): UiBookPrintJob {
  if (!isRecord(raw) || typeof raw['jobId'] !== 'string') {
    throw new Error('Malformed print job record.');
  }
  const trackingRaw = Array.isArray(raw['trackingUrls']) ? raw['trackingUrls'] : [];
  return {
    providerId: asString(raw['providerId'], 'mock'),
    jobId: raw['jobId'],
    externalId: asString(raw['externalId']),
    title: asString(raw['title'], 'Archival Hardcover Book'),
    status: asString(raw['status'], 'created'),
    ...(typeof raw['statusDetail'] === 'string' ? { statusDetail: raw['statusDetail'] } : {}),
    trackingUrls: trackingRaw.filter((u): u is string => typeof u === 'string'),
    sandbox: asBoolean(raw['sandbox'], true),
    quantity: asNumber(raw['quantity'], 1),
    updatedAt: asString(raw['updatedAt']),
  };
}

export function parseUiBookStatusResponse(raw: unknown): UiBookStatusResponse {
  if (!isRecord(raw) || typeof raw['plugin_id'] !== 'string' || typeof raw['active_publisher'] !== 'string') {
    throw new Error('Malformed book publishing status response.');
  }
  const defaultsRaw = isRecord(raw['defaults']) ? raw['defaults'] : {};
  const branchesRaw = Array.isArray(raw['branches']) ? raw['branches'] : [];
  const jobsRaw = Array.isArray(raw['jobs']) ? raw['jobs'] : [];
  const readinessRaw = isRecord(raw['readiness']) ? raw['readiness'] : null;

  return {
    plugin_id: raw['plugin_id'],
    active_publisher: raw['active_publisher'],
    publisher_provider: asString(raw['publisher_provider'], 'mock'),
    environment: raw['environment'] === 'production' ? 'production' : 'sandbox',
    pdf_renderer: asString(raw['pdf_renderer'], 'deterministic-pdf'),
    lulu_credentials_configured: asBoolean(raw['lulu_credentials_configured'], false),
    defaults: {
      trim_preset: parseTrimPreset(defaultsRaw['trim_preset']),
      binding: parseBinding(defaultsRaw['binding']),
      paper_stock: parsePaperStock(defaultsRaw['paper_stock']),
      shipping_level: parseShippingLevel(defaultsRaw['shipping_level']),
      contact_email: asString(defaultsRaw['contact_email']),
    },
    branches: branchesRaw
      .filter((b): b is Record<string, unknown> => isRecord(b) && typeof b['id'] === 'string')
      .map((b) => ({ id: asString(b['id']), label: asString(b['label'], asString(b['id'])) })),
    readiness: readinessRaw
      ? {
          included_people: asNumber(readinessRaw['included_people']),
          excluded_living_people: asNumber(readinessRaw['excluded_living_people']),
          included_media: asNumber(readinessRaw['included_media']),
          excluded_living_media: asNumber(readinessRaw['excluded_living_media']),
          estimated_pages: asNumber(readinessRaw['estimated_pages'], 24),
          spine_width_in: asNumber(readinessRaw['spine_width_in'], 0.25),
          allow_spine_text: asBoolean(readinessRaw['allow_spine_text']),
          provider_sku: asString(readinessRaw['provider_sku']),
          review_flags_detected: asNumber(readinessRaw['review_flags_detected']),
        }
      : null,
    jobs: jobsRaw.map((j) => parsePrintJob(j)),
  };
}

export function parseUiBookCompileResponse(raw: unknown): UiBookCompileResponse {
  if (!isRecord(raw) || !isRecord(raw['report']) || !isRecord(raw['artifacts'])) {
    throw new Error('Malformed book compile response.');
  }
  const report = raw['report'];
  const counts = isRecord(report['counts']) ? report['counts'] : {};
  const cover = isRecord(report['coverDimensions']) ? report['coverDimensions'] : {};
  const warningsRaw = Array.isArray(report['warnings']) ? report['warnings'] : [];
  const artifacts = raw['artifacts'];

  return {
    renderer: asString(raw['renderer'], 'deterministic-pdf'),
    report: {
      title: asString(report['title']),
      subtitle: asString(report['subtitle']),
      edition: report['edition'] === 'private' ? 'private' : 'public',
      colophonNotice: asString(report['colophonNotice']),
      counts: {
        includedPeople: asNumber(counts['includedPeople']),
        excludedLivingPeople: asNumber(counts['excludedLivingPeople']),
        includedMedia: asNumber(counts['includedMedia']),
        excludedLivingMedia: asNumber(counts['excludedLivingMedia']),
        rawContentPages: asNumber(counts['rawContentPages']),
        paddingPages: asNumber(counts['paddingPages']),
        finalPageCount: asNumber(counts['finalPageCount'], 24),
      },
      coverDimensions: {
        totalWidthIn: asNumber(cover['totalWidthIn']),
        totalHeightIn: asNumber(cover['totalHeightIn']),
        spineWidthIn: asNumber(cover['spineWidthIn']),
        allowSpineText: asBoolean(cover['allowSpineText']),
        providerSku: asString(cover['providerSku']),
      },
      warnings: warningsRaw
        .filter((w): w is Record<string, unknown> => isRecord(w))
        .map((w) => ({ code: asString(w['code']), message: asString(w['message']) })),
    },
    artifacts: {
      interior_pdf_url: asString(artifacts['interior_pdf_url']),
      cover_pdf_url: asString(artifacts['cover_pdf_url']),
      interior_bytes: asNumber(artifacts['interior_bytes']),
      cover_bytes: asNumber(artifacts['cover_bytes']),
      expires_at: asString(artifacts['expires_at']),
    },
  };
}

export function parseUiBookEstimateResponse(raw: unknown): UiBookEstimateResponse {
  if (!isRecord(raw) || !isRecord(raw['quote']) || !isRecord(raw['cover_dimensions'])) {
    throw new Error('Malformed book cost estimate response.');
  }
  const quote = raw['quote'];
  const cover = raw['cover_dimensions'];
  return {
    quote: {
      providerId: asString(quote['providerId']),
      providerSku: asString(quote['providerSku']),
      currency: asString(quote['currency'], 'USD'),
      manufacturingCostCents: asNumber(quote['manufacturingCostCents']),
      shippingCostCents: asNumber(quote['shippingCostCents']),
      fulfillmentFeeCents: asNumber(quote['fulfillmentFeeCents']),
      taxCents: asNumber(quote['taxCents']),
      totalCostCents: asNumber(quote['totalCostCents']),
      sandbox: asBoolean(quote['sandbox'], true),
    },
    cover_dimensions: {
      totalWidthIn: asNumber(cover['totalWidthIn']),
      totalHeightIn: asNumber(cover['totalHeightIn']),
      spineWidthIn: asNumber(cover['spineWidthIn']),
      allowSpineText: asBoolean(cover['allowSpineText']),
      providerSku: asString(cover['providerSku']),
    },
  };
}

export function parseUiBookSubmitJobResponse(raw: unknown): UiBookSubmitJobResponse {
  if (!isRecord(raw) || !isRecord(raw['job'])) {
    throw new Error('Malformed book print job response.');
  }
  return { job: parsePrintJob(raw['job']) };
}
