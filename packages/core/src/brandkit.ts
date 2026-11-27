import { edtfYear } from './edtf.js';
import { isPersonLivingPublic } from './privacy.js';
import type { KinloomSiteConfig, PrivacyConfig } from './schemas/config.js';
import type { RawPerson } from './schemas/entities.js';

export type BrandSurface = 'parchment' | 'navy';
export type BrandIconVariant = 'any' | 'apple' | 'maskable';

export const KINLOOM_BRAND_PALETTE = {
  parchment: '#F5EFE2',
  ivory: '#FCF9F2',
  linen: '#EAE1CE',
  navy: '#1B2A41',
  ochre: '#7A4612',
  pine: '#2F5245',
  inkPrimary: '#23272E',
  inkSecondary: '#4E4A42',
  inkInverse: '#FCF9F2',
  inkInverseMuted: '#D6CEBE',
  ruleLight: '#D6CEBE',
  ruleDark: '#334663',
} as const;

export const KINLOOM_OG_DIMENSIONS = {
  width: 1200,
  height: 630,
  safeX: 60,
  safeY: 15,
  safeWidth: 1080,
  safeHeight: 600,
  recommendedMaxBytes: 300 * 1024,
} as const;

export const KINLOOM_ICON_SIZES = {
  ico: [16, 32, 48] as const,
  appleTouch: 180,
  pwaSmall: 192,
  pwaLarge: 512,
  maskable: 512,
  maskableSafeRatio: 0.8,
} as const;

export interface ResolvedBrandSpec {
  readonly siteName: string;
  readonly title: string;
  readonly shortName: string;
  readonly subtitle: string;
  readonly description: string;
  readonly metadataLine: string;
  readonly footerCredit: string | null;
  readonly accent: string;
  readonly surface: BrandSurface;
  readonly themeColorLight: string;
  readonly themeColorDark: string;
  readonly ogImagePath: string;
  readonly ogImageAlt: string;
  readonly dynamicOg: boolean;
}

export interface BrandOverrides {
  readonly siteName?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly description?: string;
  readonly metadataLine?: string;
  readonly accent?: string;
  readonly surface?: BrandSurface;
  readonly footerCredit?: string | null;
  readonly ogImagePath?: string;
  readonly ogImageAlt?: string;
  readonly customMarkInnerSvg?: string;
  readonly vignetteDataUri?: string;
}

export interface WebManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: 'any' | 'maskable';
}

export interface KinloomWebManifest {
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly start_url: string;
  readonly display: 'standalone';
  readonly background_color: string;
  readonly theme_color: string;
  readonly icons: readonly WebManifestIcon[];
}

export interface RouteOgMetadata {
  readonly title: string;
  readonly description: string;
  readonly imagePath: string;
  readonly imageAlt: string;
  readonly ogType: 'website' | 'profile';
  readonly redacted: boolean;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeHex(candidate: string | undefined, fallback: string): string {
  if (candidate && HEX_COLOR_RE.test(candidate.trim())) {
    return candidate.trim().toUpperCase();
  }
  return fallback;
}

function deriveShortName(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length <= 16) {
    return trimmed;
  }
  const words = trimmed.split(/\s+/);
  let acc = '';
  for (const word of words) {
    const candidate = acc ? `${acc} ${word}` : word;
    if (candidate.length > 16) {
      break;
    }
    acc = candidate;
  }
  const cleaned = acc.replace(/[\s&·–—-]+$/, '').trim();
  return cleaned || trimmed.slice(0, 16).trim();
}

export function resolveBrandSpec(
  config?: KinloomSiteConfig | null,
  overrides?: BrandOverrides
): ResolvedBrandSpec {
  const brand = config?.brand;
  const title = overrides?.title?.trim() || brand?.title?.trim() || config?.site.title?.trim() || 'Kinloom';
  const siteName = overrides?.siteName?.trim() || brand?.siteName?.trim() || title;
  const defaultSubtitle = config?.site.familyName
    ? `${config.site.familyName} · Archival Explorer`
    : 'Archival Family History Explorer';
  const subtitle = overrides?.subtitle?.trim() || brand?.subtitle?.trim() || defaultSubtitle;
  const description =
    overrides?.description?.trim() ||
    config?.site.description?.trim() ||
    'Archival family history explorer built with Kinloom.';
  const metadataLine =
    overrides?.metadataLine?.trim() ||
    brand?.metadataLine?.trim() ||
    'OPEN-SOURCE · CITATION-FIRST · PRIVACY-SAFE';
  const accent = normalizeHex(
    overrides?.accent ?? brand?.accent ?? config?.theme?.accent,
    KINLOOM_BRAND_PALETTE.ochre
  );
  const surface: BrandSurface = overrides?.surface ?? brand?.surface ?? 'parchment';
  const themeColorLight = normalizeHex(brand?.themeColorLight, KINLOOM_BRAND_PALETTE.parchment);
  const themeColorDark = normalizeHex(brand?.themeColorDark, KINLOOM_BRAND_PALETTE.navy);
  const showFooterCredit = brand?.showFooterCredit ?? true;
  const rawFooter =
    overrides?.footerCredit !== undefined
      ? overrides.footerCredit
      : showFooterCredit
        ? (config?.site.footerCredit ?? 'Built with Kinloom')
        : null;
  const footerCredit = rawFooter?.trim() ? rawFooter.trim() : null;
  const ogImagePath = overrides?.ogImagePath?.trim() || brand?.ogImage?.trim() || '/og-default.png';
  const ogImageAlt = overrides?.ogImageAlt?.trim() || brand?.ogImageAlt?.trim() || `${title} — ${subtitle}`;

  return {
    siteName,
    title,
    shortName: deriveShortName(title),
    subtitle,
    description,
    metadataLine,
    footerCredit,
    accent,
    surface,
    themeColorLight,
    themeColorDark,
    ogImagePath,
    ogImageAlt,
    dynamicOg: brand?.dynamicOg ?? false,
  };
}

/**
 * Canonical 24x24 woven KinloomMark paths (matching KinloomFooter.tsx).
 */
export function renderKinloomMarkPaths(primaryColor: string, accentColor: string): string {
  return [
    `<path d="M8 2.5V13.5M8 18.5V21.5" stroke="${primaryColor}" stroke-width="2.5" stroke-linecap="round"/>`,
    `<path d="M16 2.5V5.5M16 10.5V21.5" stroke="${primaryColor}" stroke-width="2.5" stroke-linecap="round"/>`,
    `<path d="M2.5 8H5.5M10.5 8H21.5" stroke="${accentColor}" stroke-width="2.5" stroke-linecap="round"/>`,
    `<path d="M2.5 16H13.5M18.5 16H21.5" stroke="${primaryColor}" stroke-width="2.5" stroke-linecap="round"/>`,
  ].join('\n    ');
}

/**
 * Renders the light/dark adaptive 32x32 favicon.svg with embedded prefers-color-scheme CSS.
 */
export function renderFaviconSvg(options?: {
  accent?: string;
  label?: string;
  customMarkInnerSvg?: string;
}): string {
  const accent = normalizeHex(options?.accent, KINLOOM_BRAND_PALETTE.ochre);
  const label = escapeXml(options?.label?.trim() || 'Kinloom icon');
  const markContent = options?.customMarkInnerSvg
    ? options.customMarkInnerSvg
    : [
        '<path class="kl-warp" d="M8 2.5V13.5M8 18.5V21.5" stroke-width="2.5" stroke-linecap="round"/>',
        '<path class="kl-warp" d="M16 2.5V5.5M16 10.5V21.5" stroke-width="2.5" stroke-linecap="round"/>',
        '<path class="kl-accent" d="M2.5 8H5.5M10.5 8H21.5" stroke-width="2.5" stroke-linecap="round"/>',
        '<path class="kl-warp" d="M2.5 16H13.5M18.5 16H21.5" stroke-width="2.5" stroke-linecap="round"/>',
      ].join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32" fill="none" role="img" aria-label="${label}">
  <style>
    .kl-bg { fill: ${KINLOOM_BRAND_PALETTE.parchment}; stroke: ${KINLOOM_BRAND_PALETTE.ruleLight}; }
    .kl-warp { stroke: ${KINLOOM_BRAND_PALETTE.navy}; }
    .kl-accent { stroke: ${accent}; }
    @media (prefers-color-scheme: dark) {
      .kl-bg { fill: ${KINLOOM_BRAND_PALETTE.navy}; stroke: ${KINLOOM_BRAND_PALETTE.ruleDark}; }
      .kl-warp { stroke: ${KINLOOM_BRAND_PALETTE.ivory}; }
      .kl-accent { stroke: ${accent}; }
    }
  </style>
  <rect class="kl-bg" x="0.75" y="0.75" width="30.5" height="30.5" rx="6" stroke-width="1.5"/>
  <g transform="translate(4, 4)">
    ${markContent}
  </g>
</svg>
`;
}

/**
 * Renders a square raster-ready SVG for apple-touch-icon, standard PWA icons, ICO frames,
 * or Android adaptive maskable icons (strictly respecting the central 80% safe circle).
 */
export function renderIconSvg(options: {
  size: number;
  variant: BrandIconVariant;
  surface?: BrandSurface;
  accent?: string;
  transparentBackground?: boolean;
  customMarkInnerSvg?: string;
}): string {
  const { size, variant, transparentBackground = false } = options;
  const surface: BrandSurface = options.surface ?? 'parchment';
  const accent = normalizeHex(options.accent, KINLOOM_BRAND_PALETTE.ochre);
  const bgColor = surface === 'navy' ? KINLOOM_BRAND_PALETTE.navy : KINLOOM_BRAND_PALETTE.parchment;
  const borderColor = surface === 'navy' ? KINLOOM_BRAND_PALETTE.ruleDark : KINLOOM_BRAND_PALETTE.ruleLight;
  const primaryStroke = surface === 'navy' ? KINLOOM_BRAND_PALETTE.ivory : KINLOOM_BRAND_PALETTE.navy;

  // Maskable icons keep the mark comfortably inside the central 80% safe circle (diameter = 0.8 * size,
  // inscribed square side = 0.8 * size / sqrt(2) ~= 0.565 * size). Using 0.52 gives generous breathing room.
  const markRatio =
    variant === 'maskable' ? 0.52 : variant === 'apple' ? 0.68 : transparentBackground ? 0.8 : 0.72;
  const markSize = size * markRatio;
  const scale = markSize / 24;
  const offset = (size - markSize) / 2;

  const backgroundMarkup = transparentBackground
    ? ''
    : variant === 'apple' || variant === 'maskable'
      ? `<rect x="0" y="0" width="${size}" height="${size}" fill="${bgColor}"/>`
      : `<rect x="${(size * 0.02).toFixed(2)}" y="${(size * 0.02).toFixed(2)}" width="${(size * 0.96).toFixed(2)}" height="${(size * 0.96).toFixed(2)}" rx="${(size * 0.18).toFixed(2)}" fill="${bgColor}" stroke="${borderColor}" stroke-width="${Math.max(1, size * 0.025).toFixed(2)}"/>`;

  const markContent = options.customMarkInnerSvg
    ? options.customMarkInnerSvg
    : renderKinloomMarkPaths(primaryStroke, accent);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" fill="none">
  ${backgroundMarkup}
  <g transform="translate(${offset.toFixed(2)}, ${offset.toFixed(2)}) scale(${scale.toFixed(4)})">
    ${markContent}
  </g>
</svg>
`;
}

function wrapTextLines(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let current = words[0];

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    if (`${current} ${word}`.length <= maxCharsPerLine) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) {
        const remaining = [current, ...words.slice(i + 1)].join(' ');
        lines.push(
          remaining.length > maxCharsPerLine
            ? `${remaining.slice(0, maxCharsPerLine - 1).trimEnd()}…`
            : remaining
        );
        return lines;
      }
    }
  }
  lines.push(current);
  return lines.slice(0, maxLines);
}

/**
 * Renders a 1200x630 archival Open Graph card SVG with all critical content
 * strictly inside the 1080x600 safe zone. Supports both centered default cards
 * and split editorial cards with an optional right-side vignette image.
 */
export function renderOgCardSvg(options: {
  title: string;
  subtitle: string;
  metadataLine?: string;
  footerCredit?: string | null;
  kicker?: string;
  surface?: BrandSurface;
  accent?: string;
  customMarkInnerSvg?: string;
  vignetteDataUri?: string;
}): string {
  const { width, height } = KINLOOM_OG_DIMENSIONS;
  const surface: BrandSurface = options.surface ?? 'parchment';
  const accent = normalizeHex(options.accent, KINLOOM_BRAND_PALETTE.ochre);
  const isNavy = surface === 'navy';
  const bg = isNavy ? KINLOOM_BRAND_PALETTE.navy : KINLOOM_BRAND_PALETTE.parchment;
  const cardBg = isNavy ? '#22344F' : KINLOOM_BRAND_PALETTE.ivory;
  const ruleColor = isNavy ? KINLOOM_BRAND_PALETTE.ruleDark : KINLOOM_BRAND_PALETTE.ruleLight;
  const subtleLine = isNavy ? '#2A3F5F' : '#E5DAC5';
  const titleColor = isNavy ? KINLOOM_BRAND_PALETTE.inkInverse : KINLOOM_BRAND_PALETTE.inkPrimary;
  const subtitleColor = isNavy ? KINLOOM_BRAND_PALETTE.inkInverseMuted : KINLOOM_BRAND_PALETTE.inkSecondary;
  const markPrimary = isNavy ? KINLOOM_BRAND_PALETTE.ivory : KINLOOM_BRAND_PALETTE.navy;

  const markContent = options.customMarkInnerSvg
    ? options.customMarkInnerSvg
    : renderKinloomMarkPaths(markPrimary, accent);

  const serifFont = `'Newsreader', Georgia, 'Times New Roman', serif`;
  const monoFont = `'IBM Plex Mono', 'DejaVu Sans Mono', ui-monospace, monospace`;

  const ledgerLines = Array.from({ length: 10 }, (_, idx) => {
    const y = 78 + idx * 52;
    return `<line x1="980" y1="${y}" x2="1172" y2="${y}" stroke="${subtleLine}" stroke-width="1"/>`;
  }).join('\n    ');

  const verticalLedger = [1040, 1096, 1144]
    .map((x) => `<line x1="${x}" y1="28" x2="${x}" y2="602" stroke="${subtleLine}" stroke-width="1"/>`)
    .join('\n    ');

  if (options.vignetteDataUri) {
    const titleLines = wrapTextLines(options.title, 18, 2);
    const titleFontSize = titleLines.some((line) => line.length > 14) ? 62 : 70;
    const titleStartY = titleLines.length === 1 ? 268 : 238;
    const titleSvg = titleLines
      .map(
        (line, idx) =>
          `<text x="90" y="${titleStartY + idx * (titleFontSize + 12)}" fill="${titleColor}" font-family="${serifFont}" font-size="${titleFontSize}" font-weight="700">${escapeXml(line)}</text>`
      )
      .join('\n    ');

    const ruleY = titleStartY + titleLines.length * (titleFontSize + 12) + 14;
    const subtitleLines = wrapTextLines(options.subtitle, 28, 2);
    const subtitleSvg = subtitleLines
      .map(
        (line, idx) =>
          `<text x="90" y="${ruleY + 48 + idx * 42}" fill="${subtitleColor}" font-family="${serifFont}" font-size="34" font-weight="500">${escapeXml(line)}</text>`
      )
      .join('\n    ');

    const metaY = ruleY + 48 + subtitleLines.length * 42 + 20;
    const metaSvg = options.metadataLine
      ? `<text x="90" y="${Math.min(metaY, 514)}" fill="${titleColor}" font-family="${monoFont}" font-size="22" font-weight="600" letter-spacing="1.6">${escapeXml(options.metadataLine.toUpperCase())}</text>`
      : '';

    const footerSvg = options.footerCredit
      ? `<text x="90" y="562" fill="${subtitleColor}" font-family="${monoFont}" font-size="20" font-weight="600" letter-spacing="1.6">${escapeXml(options.footerCredit.toUpperCase())}</text>`
      : '';

    const kickerSvg = options.kicker
      ? `<text x="160" y="138" fill="${accent}" font-family="${monoFont}" font-size="20" font-weight="600" letter-spacing="2">${escapeXml(options.kicker.toUpperCase())}</text>`
      : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" fill="none">
  <defs>
    <clipPath id="kl-vignette-clip">
      <rect x="774" y="88" width="330" height="454" rx="2"/>
    </clipPath>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="${bg}"/>
  <rect x="34" y="34" width="${width - 68}" height="${height - 68}" fill="${cardBg}" stroke="${ruleColor}" stroke-width="1.5"/>
  <g transform="translate(90, 96) scale(2.2)">
    ${markContent}
  </g>
  ${kickerSvg}
  ${titleSvg}
  <line x1="90" y1="${ruleY}" x2="660" y2="${ruleY}" stroke="${accent}" stroke-width="4"/>
  ${subtitleSvg}
  ${metaSvg}
  ${footerSvg}
  <rect x="766" y="80" width="346" height="470" fill="${bg}" stroke="${ruleColor}" stroke-width="1.5"/>
  <image href="${escapeXml(options.vignetteDataUri)}" x="774" y="88" width="330" height="454" preserveAspectRatio="xMidYMid slice" clip-path="url(#kl-vignette-clip)"/>
</svg>
`;
  }

  // Centered editorial layout tuned for high-contrast phone legibility inside the 1080x600 safe zone
  const titleLines = wrapTextLines(options.title, 22, 2);
  const titleFontSize = titleLines.length === 1 ? 86 : 74;
  const titleStartY = titleLines.length === 1 ? 320 : 280;
  const titleSvg = titleLines
    .map(
      (line, idx) =>
        `<text x="600" y="${titleStartY + idx * (titleFontSize + 12)}" text-anchor="middle" fill="${titleColor}" font-family="${serifFont}" font-size="${titleFontSize}" font-weight="700">${escapeXml(line)}</text>`
    )
    .join('\n  ');

  const subtitleY = titleStartY + (titleLines.length - 1) * (titleFontSize + 12) + 66;
  const subtitleLines = wrapTextLines(options.subtitle, 42, 2);
  const subtitleSvg = subtitleLines
    .map(
      (line, idx) =>
        `<text x="600" y="${subtitleY + idx * 46}" text-anchor="middle" fill="${subtitleColor}" font-family="${serifFont}" font-size="38" font-weight="500">${escapeXml(line)}</text>`
    )
    .join('\n  ');

  const ruleY = subtitleY + (subtitleLines.length - 1) * 46 + 38;
  const metaY = Math.min(ruleY + 52, 566);
  const metaText = options.metadataLine?.trim() || options.footerCredit?.trim() || '';
  const metaSvg = metaText
    ? `<text x="600" y="${metaY}" text-anchor="middle" fill="${titleColor}" font-family="${monoFont}" font-size="24" font-weight="600" letter-spacing="1.8">${escapeXml(metaText.toUpperCase())}</text>`
    : '';

  const kickerSvg = options.kicker
    ? `<text x="600" y="84" text-anchor="middle" fill="${accent}" font-family="${monoFont}" font-size="22" font-weight="600" letter-spacing="2.2">${escapeXml(options.kicker.toUpperCase())}</text>`
    : '';

  const markY = options.kicker ? 102 : 70;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" fill="none">
  <rect x="0" y="0" width="${width}" height="${height}" fill="${bg}"/>
  <g opacity="0.65">
    ${ledgerLines}
    ${verticalLedger}
  </g>
  <rect x="28" y="28" width="${width - 56}" height="${height - 56}" stroke="${ruleColor}" stroke-width="1.5"/>
  ${kickerSvg}
  <g transform="translate(534, ${markY}) scale(5.5)">
    ${markContent}
  </g>
  ${titleSvg}
  ${subtitleSvg}
  <line x1="510" y1="${ruleY}" x2="690" y2="${ruleY}" stroke="${accent}" stroke-width="4"/>
  ${metaSvg}
</svg>
`;
}

export function buildWebManifest(
  config?: KinloomSiteConfig | null,
  overrides?: BrandOverrides
): KinloomWebManifest {
  const spec = resolveBrandSpec(config, overrides);
  return {
    name: spec.title,
    short_name: spec.shortName,
    description: spec.description,
    start_url: '/',
    display: 'standalone',
    background_color: spec.surface === 'navy' ? spec.themeColorDark : spec.themeColorLight,
    theme_color: spec.surface === 'navy' ? spec.themeColorDark : spec.themeColorLight,
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

export function renderBrandkitHeadTags(
  config?: KinloomSiteConfig | null,
  overrides?: BrandOverrides
): string {
  const spec = resolveBrandSpec(config, overrides);
  const siteName = escapeXml(spec.siteName);
  const title = escapeXml(spec.title);
  const description = escapeXml(spec.description);
  const ogImage = escapeXml(spec.ogImagePath);
  const ogAlt = escapeXml(spec.ogImageAlt);

  return [
    `<meta name="description" content="${description}" />`,
    `<meta name="theme-color" content="${spec.themeColorLight}" media="(prefers-color-scheme: light)" />`,
    `<meta name="theme-color" content="${spec.themeColorDark}" media="(prefers-color-scheme: dark)" />`,
    `<meta property="og:site_name" content="${siteName}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta property="og:image:width" content="${KINLOOM_OG_DIMENSIONS.width}" />`,
    `<meta property="og:image:height" content="${KINLOOM_OG_DIMENSIONS.height}" />`,
    `<meta property="og:image:alt" content="${ogAlt}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${ogImage}" />`,
    `<meta name="twitter:image:alt" content="${ogAlt}" />`,
    `<link rel="icon" href="/favicon.ico" sizes="48x48" />`,
    `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`,
    `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />`,
    `<link rel="manifest" href="/site.webmanifest" />`,
  ].join('\n');
}

export function formatDeceasedLifespan(person: Pick<RawPerson, 'birth_edtf' | 'death_edtf'>): string {
  const birth = edtfYear(person.birth_edtf);
  const death = edtfYear(person.death_edtf);
  if (birth !== null && death !== null) {
    return `${birth}–${death}`;
  }
  if (birth !== null) {
    return `b. ${birth}`;
  }
  if (death !== null) {
    return `d. ${death}`;
  }
  return 'Historical Record';
}

/**
 * Privacy-safe per-route OG metadata resolver.
 * Strictly enforces living-person redaction: if a person is living or unknown,
 * falls back to the site-level OG card without exposing living names, dates, or portraits.
 */
export function resolveRouteOgMetadata(options: {
  siteConfig: KinloomSiteConfig;
  person?: RawPerson | null;
  privacyConfig?: PrivacyConfig;
}): RouteOgMetadata {
  const spec = resolveBrandSpec(options.siteConfig);
  const fallback: RouteOgMetadata = {
    title: spec.title,
    description: spec.description,
    imagePath: spec.ogImagePath,
    imageAlt: spec.ogImageAlt,
    ogType: 'website',
    redacted: false,
  };

  if (!options.person) {
    return fallback;
  }

  const privacy = options.privacyConfig ?? options.siteConfig.privacy;
  const isLiving = isPersonLivingPublic({
    explicitLiving: options.person.is_living,
    hasDeathOrBurial: Boolean(options.person.death_edtf),
    birthYear: edtfYear(options.person.birth_edtf),
    earliestEventYear: null,
    referenceYear: privacy.referenceYear,
    livingCutoffYears: privacy.livingCutoffYears,
  });

  if (isLiving) {
    return {
      ...fallback,
      redacted: true,
    };
  }

  const displayName = options.person.full_name.trim() || 'Historical Person';
  const lifespan = formatDeceasedLifespan(options.person);
  const personTitle = `${displayName} (${lifespan}) | ${spec.title}`;
  const personDescription = `${displayName} (${lifespan}) in ${spec.title}.`;
  const imagePath = spec.dynamicOg
    ? `/og/person/${encodeURIComponent(options.person.id)}.svg`
    : spec.ogImagePath;

  return {
    title: personTitle,
    description: personDescription,
    imagePath,
    imageAlt: `${displayName} (${lifespan}) — ${spec.title}`,
    ogType: 'profile',
    redacted: false,
  };
}
