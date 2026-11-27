import type {
  BookImageDpiAudit,
  BookInteriorGeometry,
  BookPaperStock,
  BookPhysicalSpec,
  BookTrimPresetId,
  BookTrimPresetSpec,
  CoverDimensionsResult,
} from './types.js';

export const POINTS_PER_INCH = 72;
export const MM_PER_INCH = 25.4;
export const INTERIOR_BLEED_IN = 0.125;
export const SAFETY_MARGIN_IN = 0.5;
export const HARDCOVER_WRAP_ALLOWANCE_IN = 0.75;
export const MIN_HARDCOVER_PAGES = 24;
export const MAX_HARDCOVER_PAGES = 800;
export const SPINE_TEXT_MIN_PAGES = 80;
export const SPINE_TEXT_MIN_WIDTH_IN = 0.375;
export const SPINE_TEXT_CLEARANCE_IN = 0.1875;
export const BARCODE_WIDTH_IN = 2.0;
export const BARCODE_HEIGHT_IN = 1.25;
export const BARCODE_INSET_IN = 0.5;

export const BOOK_TRIM_PRESETS: Readonly<Record<BookTrimPresetId, BookTrimPresetSpec>> = {
  'us-letter-landscape': {
    id: 'us-letter-landscape',
    label: 'US Letter Landscape (11 × 8.5 in)',
    trimWidthIn: 11.0,
    trimHeightIn: 8.5,
    trimWidthMm: 279.4,
    trimHeightMm: 215.9,
    luluTrimToken: '1100X0850',
  },
  'a4-landscape': {
    id: 'a4-landscape',
    label: 'A4 Landscape (11.69 × 8.27 in)',
    trimWidthIn: 11.69,
    trimHeightIn: 8.27,
    trimWidthMm: 297.0,
    trimHeightMm: 210.0,
    luluTrimToken: '1169X0827',
  },
  'photo-10x8-landscape': {
    id: 'photo-10x8-landscape',
    label: 'Photo Landscape (10 × 8 in)',
    trimWidthIn: 10.0,
    trimHeightIn: 8.0,
    trimWidthMm: 254.0,
    trimHeightMm: 203.2,
    luluTrimToken: '1000X0800',
  },
  'small-9x7-landscape': {
    id: 'small-9x7-landscape',
    label: 'Small Landscape (9 × 7 in)',
    trimWidthIn: 9.0,
    trimHeightIn: 7.0,
    trimWidthMm: 228.6,
    trimHeightMm: 177.8,
    luluTrimToken: '0900X0700',
  },
};

export const PAPER_STOCK_PPI: Readonly<Record<BookPaperStock, number>> = {
  '80lb-coated-white-color': 444,
  '60lb-uncoated-white-color': 380,
};

export function roundToThousandth(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function inchesToPoints(inches: number): number {
  return roundToThousandth(inches * POINTS_PER_INCH);
}

export function inchesToMm(inches: number): number {
  return roundToThousandth(inches * MM_PER_INCH);
}

export function ceilToSixteenthInch(inches: number): number {
  return Math.ceil(inches * 16) / 16;
}

export interface NormalizedPageCountResult {
  readonly rawPages: number;
  readonly finalPages: number;
  readonly paddingPages: number;
  readonly ledgerPages: number;
  readonly versoPad: boolean;
}

/**
 * Enforces hardcover even-page and 24..800 page count invariants.
 * Pads short books to 24 pages with Family Notes & Provenance Ledger leaves,
 * pads odd page counts by 1 verso leaf, and fails fast above 800 pages.
 */
export function normalizeBookPageCount(rawPages: number): NormalizedPageCountResult {
  if (!Number.isInteger(rawPages) || rawPages < 1) {
    throw new RangeError(`Book interior page count must be a positive integer; received ${rawPages}.`);
  }
  if (rawPages > MAX_HARDCOVER_PAGES) {
    throw new RangeError(
      `Book interior has ${rawPages} pages, exceeding the ${MAX_HARDCOVER_PAGES}-page hardcover casewrap maximum. Split the volume using --branch or --root-person.`
    );
  }

  let target = rawPages;
  if (target < MIN_HARDCOVER_PAGES) {
    target = MIN_HARDCOVER_PAGES;
  }
  if (target % 2 !== 0) {
    target += 1;
  }
  if (target > MAX_HARDCOVER_PAGES) {
    throw new RangeError(
      `Book interior requires ${target} even pages, exceeding the ${MAX_HARDCOVER_PAGES}-page hardcover maximum. Split the volume using --branch or --root-person.`
    );
  }

  const paddingPages = target - rawPages;
  const versoPad = rawPages >= MIN_HARDCOVER_PAGES && paddingPages === 1;
  const ledgerPages = versoPad ? 0 : paddingPages;

  return {
    rawPages,
    finalPages: target,
    paddingPages,
    ledgerPages,
    versoPad,
  };
}

/**
 * Computes hardcover inside (binding-side) gutter margin in inches from trim edge.
 */
export function computeInsideGutterIn(pageCount: number): number {
  if (pageCount <= 150) {
    return 0.625;
  }
  if (pageCount <= 300) {
    return 0.75;
  }
  if (pageCount <= 500) {
    return 0.875;
  }
  return 1.0;
}

/**
 * Deterministic offline Casewrap hardcover spine width calculation in inches.
 * Uses Lulu's documented stepped binder-board spine tiers for 80# Coated White (444 PPI)
 * and linear 1/16" stepped PPI calculation above 222 pages or for 60# uncoated stock.
 */
export function computeOfflineSpineWidthIn(pageCount: number, paperStock: BookPaperStock): number {
  const normalized = normalizeBookPageCount(pageCount);
  const pages = normalized.finalPages;

  if (paperStock === '80lb-coated-white-color') {
    if (pages <= 84) {
      return 0.25;
    }
    if (pages <= 140) {
      return 0.5;
    }
    if (pages <= 168) {
      return 0.625;
    }
    if (pages <= 194) {
      return 0.6875;
    }
    if (pages <= 222) {
      return 0.75;
    }
  }

  const ppi = PAPER_STOCK_PPI[paperStock];
  return ceilToSixteenthInch(pages / ppi + 0.25);
}

export function resolveLuluPodPackageId(spec: BookPhysicalSpec): string {
  const trimToken = BOOK_TRIM_PRESETS[spec.trimPreset].luluTrimToken;
  const paperToken = spec.paperStock === '80lb-coated-white-color' ? '080CW444' : '060UC444';
  const finishToken = spec.binding === 'hardcover-casewrap-glossy' ? 'GXX' : 'MXX';
  return `${trimToken}.FC.PRE.CW.${paperToken}.${finishToken}`;
}

export function computeInteriorGeometry(spec: BookPhysicalSpec): BookInteriorGeometry {
  const preset = BOOK_TRIM_PRESETS[spec.trimPreset];
  const bleedWidthIn = roundToThousandth(preset.trimWidthIn + 2 * INTERIOR_BLEED_IN);
  const bleedHeightIn = roundToThousandth(preset.trimHeightIn + 2 * INTERIOR_BLEED_IN);
  const bleedWidthPt = inchesToPoints(bleedWidthIn);
  const bleedHeightPt = inchesToPoints(bleedHeightIn);
  const bleedPt = inchesToPoints(INTERIOR_BLEED_IN);

  return {
    trimPreset: spec.trimPreset,
    trimWidthIn: preset.trimWidthIn,
    trimHeightIn: preset.trimHeightIn,
    trimWidthMm: preset.trimWidthMm,
    trimHeightMm: preset.trimHeightMm,
    bleedIn: INTERIOR_BLEED_IN,
    bleedWidthIn,
    bleedHeightIn,
    bleedWidthPt,
    bleedHeightPt,
    safetyMarginIn: SAFETY_MARGIN_IN,
    insideGutterIn: computeInsideGutterIn(spec.interiorPageCount),
    mediaBoxPt: { x0: 0, y0: 0, x1: bleedWidthPt, y1: bleedHeightPt },
    bleedBoxPt: { x0: 0, y0: 0, x1: bleedWidthPt, y1: bleedHeightPt },
    trimBoxPt: {
      x0: bleedPt,
      y0: bleedPt,
      x1: roundToThousandth(bleedWidthPt - bleedPt),
      y1: roundToThousandth(bleedHeightPt - bleedPt),
    },
  };
}

export function buildCoverDimensionsFromValues(params: {
  readonly spec: BookPhysicalSpec;
  readonly totalWidthIn: number;
  readonly totalHeightIn: number;
  readonly spineWidthIn: number;
  readonly source: 'provider_api' | 'offline_estimate';
  readonly providerSku: string;
}): CoverDimensionsResult {
  const preset = BOOK_TRIM_PRESETS[params.spec.trimPreset];
  const totalWidthIn = roundToThousandth(params.totalWidthIn);
  const totalHeightIn = roundToThousandth(params.totalHeightIn);
  const spineWidthIn = roundToThousandth(params.spineWidthIn);
  const allowSpineText =
    params.spec.interiorPageCount >= SPINE_TEXT_MIN_PAGES && spineWidthIn >= SPINE_TEXT_MIN_WIDTH_IN;
  const maxSpineTextHeightIn = allowSpineText
    ? roundToThousandth(Math.max(0.125, spineWidthIn - SPINE_TEXT_CLEARANCE_IN))
    : 0;

  // Back cover occupies [wrapAllowanceIn .. wrapAllowanceIn + trimWidthIn].
  // Barcode safe zone sits in lower-right corner of the back cover, inset 0.50 in from spine & bottom trim.
  const barcodeXIn = roundToThousandth(
    HARDCOVER_WRAP_ALLOWANCE_IN + preset.trimWidthIn - BARCODE_INSET_IN - BARCODE_WIDTH_IN
  );
  const barcodeYIn = roundToThousandth(HARDCOVER_WRAP_ALLOWANCE_IN + BARCODE_INSET_IN);

  return {
    totalWidthIn,
    totalHeightIn,
    totalWidthPt: inchesToPoints(totalWidthIn),
    totalHeightPt: inchesToPoints(totalHeightIn),
    spineWidthIn,
    wrapAllowanceIn: HARDCOVER_WRAP_ALLOWANCE_IN,
    allowSpineText,
    maxSpineTextHeightIn,
    barcodeClearanceIn: {
      xIn: barcodeXIn,
      yIn: barcodeYIn,
      widthIn: BARCODE_WIDTH_IN,
      heightIn: BARCODE_HEIGHT_IN,
    },
    source: params.source,
    providerSku: params.providerSku,
  };
}

export function computeCoverDimensionsOffline(
  spec: BookPhysicalSpec,
  providerSku?: string
): CoverDimensionsResult {
  const preset = BOOK_TRIM_PRESETS[spec.trimPreset];
  const spineWidthIn = computeOfflineSpineWidthIn(spec.interiorPageCount, spec.paperStock);
  const totalWidthIn = roundToThousandth(
    HARDCOVER_WRAP_ALLOWANCE_IN +
      preset.trimWidthIn +
      spineWidthIn +
      preset.trimWidthIn +
      HARDCOVER_WRAP_ALLOWANCE_IN
  );
  const totalHeightIn = roundToThousandth(
    HARDCOVER_WRAP_ALLOWANCE_IN + preset.trimHeightIn + HARDCOVER_WRAP_ALLOWANCE_IN
  );

  return buildCoverDimensionsFromValues({
    spec,
    totalWidthIn,
    totalHeightIn,
    spineWidthIn,
    source: 'offline_estimate',
    providerSku: providerSku ?? resolveLuluPodPackageId(spec),
  });
}

export function evaluateImageDpi(params: {
  readonly mediaId: string;
  readonly file: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly placedWidthIn: number;
  readonly placedHeightIn: number;
}): BookImageDpiAudit {
  const safeW = Math.max(0.1, params.placedWidthIn);
  const safeH = Math.max(0.1, params.placedHeightIn);
  const effectiveDpi = Math.round(Math.min(params.widthPx / safeW, params.heightPx / safeH));
  const status: 'pass' | 'warn' | 'low' = effectiveDpi >= 300 ? 'pass' : effectiveDpi >= 200 ? 'warn' : 'low';

  let recommendedWidthIn = roundToThousandth(safeW);
  let recommendedHeightIn = roundToThousandth(safeH);
  if (status === 'low' && effectiveDpi > 0) {
    const scale = Math.min(1, effectiveDpi / 220);
    recommendedWidthIn = roundToThousandth(Math.max(1.25, safeW * scale));
    recommendedHeightIn = roundToThousandth(Math.max(1.0, safeH * scale));
  }

  return {
    mediaId: params.mediaId,
    file: params.file,
    widthPx: params.widthPx,
    heightPx: params.heightPx,
    placedWidthIn: roundToThousandth(safeW),
    placedHeightIn: roundToThousandth(safeH),
    effectiveDpi,
    status,
    recommendedWidthIn,
    recommendedHeightIn,
  };
}
