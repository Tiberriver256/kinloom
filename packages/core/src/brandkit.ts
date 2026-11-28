import {
  type BrandIconVariant,
  type BrandSurface,
  contrastRatio,
  deriveDarkModeFaviconAccent,
  escapeXml,
  type FaviconColorMode,
  KINLOOM_BRAND_PALETTE,
  KINLOOM_ICON_SIZES,
  KINLOOM_OG_DIMENSIONS,
  normalizeHex,
  type RenderFaviconSvgOptions,
  relativeLuminance,
  renderDarkFaviconSvg,
  renderFaviconSvg,
  renderIconSvg,
  renderKinloomMarkPaths,
  renderLightFaviconSvg,
  renderOgCardSvg,
} from './brandkitSvg.js';
import { edtfYear } from './edtf.js';
import { isPersonLivingPublic } from './privacy.js';
import { joinPwaBasePath, normalizePwaBaseUrl } from './pwa.js';
import type { KinloomSiteConfig, PrivacyConfig } from './schemas/config.js';
import type { RawPerson } from './schemas/entities.js';

export {
  type BrandIconVariant,
  type BrandSurface,
  contrastRatio,
  deriveDarkModeFaviconAccent,
  escapeXml,
  type FaviconColorMode,
  KINLOOM_BRAND_PALETTE,
  KINLOOM_ICON_SIZES,
  KINLOOM_OG_DIMENSIONS,
  type RenderFaviconSvgOptions,
  relativeLuminance,
  renderDarkFaviconSvg,
  renderFaviconSvg,
  renderIconSvg,
  renderKinloomMarkPaths,
  renderLightFaviconSvg,
  renderOgCardSvg,
};

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
  readonly baseUrl?: string;
}

export interface WebManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose: 'any' | 'maskable';
}

export interface KinloomWebManifest {
  readonly id: string;
  readonly name: string;
  readonly short_name: string;
  readonly description: string;
  readonly start_url: string;
  readonly scope: string;
  readonly display: 'standalone';
  readonly orientation: 'any';
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
  const metadataLine = overrides?.metadataLine?.trim() || brand?.metadataLine?.trim() || '';
  const accent = normalizeHex(
    overrides?.accent ?? brand?.accent ?? config?.theme?.accent,
    KINLOOM_BRAND_PALETTE.ochre
  );
  const surface: BrandSurface = overrides?.surface ?? brand?.surface ?? 'parchment';
  const themeColorLight = normalizeHex(brand?.themeColorLight, KINLOOM_BRAND_PALETTE.parchment);
  const themeColorDark = normalizeHex(brand?.themeColorDark, KINLOOM_BRAND_PALETTE.charcoalFolio);
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

export function buildWebManifest(
  config?: KinloomSiteConfig | null,
  overrides?: BrandOverrides
): KinloomWebManifest {
  const spec = resolveBrandSpec(config, overrides);
  const baseUrl = normalizePwaBaseUrl(overrides?.baseUrl);
  const surfaceColor = spec.surface === 'navy' ? spec.themeColorDark : spec.themeColorLight;
  return {
    id: baseUrl,
    name: spec.title,
    short_name: spec.shortName,
    description: spec.description,
    start_url: baseUrl,
    scope: baseUrl,
    display: 'standalone',
    orientation: 'any',
    background_color: surfaceColor,
    theme_color: surfaceColor,
    icons: [
      {
        src: joinPwaBasePath(baseUrl, 'icon-192.png'),
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: joinPwaBasePath(baseUrl, 'icon-512.png'),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: joinPwaBasePath(baseUrl, 'icon-maskable-512.png'),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

export function renderThemeInitScript(): string {
  return `<script>try{var t=localStorage.getItem('kinloom-theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="color-scheme"]');if(m)m.content=t;}}catch(e){}</script>`;
}

export function renderBrandkitHeadTags(
  config?: KinloomSiteConfig | null,
  overrides?: BrandOverrides
): string {
  const spec = resolveBrandSpec(config, overrides);
  const baseUrl = normalizePwaBaseUrl(overrides?.baseUrl);
  const siteName = escapeXml(spec.siteName);
  const title = escapeXml(spec.title);
  const shortName = escapeXml(spec.shortName);
  const description = escapeXml(spec.description);
  const ogImage = escapeXml(spec.ogImagePath);
  const ogAlt = escapeXml(spec.ogImageAlt);

  return [
    `<meta name="description" content="${description}" />`,
    `<meta name="color-scheme" content="light dark" />`,
    renderThemeInitScript(),
    `<meta name="theme-color" content="${spec.themeColorLight}" media="(prefers-color-scheme: light)" />`,
    `<meta name="theme-color" content="${spec.themeColorDark}" media="(prefers-color-scheme: dark)" />`,
    `<meta name="mobile-web-app-capable" content="yes" />`,
    `<meta name="apple-mobile-web-app-capable" content="yes" />`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="default" />`,
    `<meta name="apple-mobile-web-app-title" content="${shortName}" />`,
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
    `<link rel="icon" href="${joinPwaBasePath(baseUrl, 'favicon.ico')}" sizes="48x48" />`,
    `<link rel="icon" type="image/svg+xml" media="(prefers-color-scheme: light)" href="${joinPwaBasePath(baseUrl, 'favicon-light.svg')}" />`,
    `<link rel="icon" type="image/svg+xml" media="(prefers-color-scheme: dark)" href="${joinPwaBasePath(baseUrl, 'favicon-dark.svg')}" />`,
    `<link rel="icon" type="image/svg+xml" href="${joinPwaBasePath(baseUrl, 'favicon.svg')}" />`,
    `<link rel="apple-touch-icon" sizes="180x180" href="${joinPwaBasePath(baseUrl, 'apple-touch-icon.png')}" />`,
    `<link rel="manifest" href="${joinPwaBasePath(baseUrl, 'site.webmanifest')}" />`,
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

export function resolveRouteOgMetadata(options: {
  siteConfig: KinloomSiteConfig;
  person?: RawPerson | null;
  privacyConfig?: PrivacyConfig;
  referenceYear?: number;
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
  const referenceYear = options.referenceYear ?? privacy.referenceYear;
  const isLiving = isPersonLivingPublic({
    explicitLiving: options.person.is_living,
    hasDeathOrBurial: Boolean(options.person.death_edtf),
    birthYear: edtfYear(options.person.birth_edtf),
    earliestEventYear: null,
    // Fail-closed (0) when no referenceYear is supplied and death date is absent so OG cards never leak living people.
    referenceYear: referenceYear ?? 0,
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
