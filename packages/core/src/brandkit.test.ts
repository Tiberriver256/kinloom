import { describe, expect, it } from 'vitest';
import {
  buildWebManifest,
  contrastRatio,
  deriveDarkModeFaviconAccent,
  KINLOOM_BRAND_PALETTE,
  KINLOOM_OG_DIMENSIONS,
  relativeLuminance,
  renderBrandkitHeadTags,
  renderDarkFaviconSvg,
  renderFaviconSvg,
  renderIconSvg,
  renderLightFaviconSvg,
  renderOgCardSvg,
  renderThemeInitScript,
  renderThemeInitScriptSource,
  resolveBrandSpec,
  resolveRouteOgMetadata,
} from './brandkit.js';
import { parseKinloomConfig } from './schemas/config.js';
import type { RawPerson } from './schemas/entities.js';

function parseFaviconThemeColors(svg: string): {
  light: { bgFill: string; bgStroke: string; warp: string; accent: string };
  dark: { bgFill: string; bgStroke: string; warp: string; accent: string };
} {
  const [lightCss, darkCss = ''] = svg.split('@media (prefers-color-scheme: dark)');
  const extract = (css: string) => {
    const bgMatch = /\.kl-bg\s*\{\s*fill:\s*(#[0-9A-Fa-f]{6});\s*stroke:\s*(#[0-9A-Fa-f]{6});/.exec(css);
    const warpMatch = /\.kl-warp\s*\{\s*stroke:\s*(#[0-9A-Fa-f]{6});/.exec(css);
    const accentMatch = /\.kl-accent\s*\{\s*stroke:\s*(#[0-9A-Fa-f]{6});/.exec(css);
    if (!bgMatch || !warpMatch || !accentMatch) {
      throw new Error(`Missing favicon CSS rules in block:\n${css}`);
    }
    return {
      bgFill: bgMatch[1],
      bgStroke: bgMatch[2],
      warp: warpMatch[1],
      accent: accentMatch[1],
    };
  };
  return { light: extract(lightCss), dark: extract(darkCss) };
}

function makeSampleConfig(brandOverrides?: Record<string, unknown>) {
  return parseKinloomConfig({
    schemaVersion: 1,
    site: {
      title: 'Alder Family Archive',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER_ARCHIVE',
      description: 'Five generations of the Alder family across Ohio and Oregon.',
      footerCredit: 'Built with Kinloom',
    },
    theme: {
      accent: '#2F5245',
    },
    brand: brandOverrides,
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
    },
  });
}

describe('brandkit core primitives', () => {
  it('resolves zero-config Kinloom defaults when no site config is provided', () => {
    const spec = resolveBrandSpec(null);
    expect(spec.title).toBe('Kinloom');
    expect(spec.subtitle).toBe('Archival Family History Explorer');
    expect(spec.accent).toBe('#7A4612');
    expect(spec.surface).toBe('parchment');
    expect(spec.ogImagePath).toBe('/og-default.png');
    expect(spec.dynamicOg).toBe(false);
  });

  it('parses brand config overrides and inherits theme.accent when brand.accent is omitted', () => {
    const config = makeSampleConfig({
      subtitle: 'Five Generations · 1812–1968',
      surface: 'navy',
      dynamicOg: true,
    });
    const spec = resolveBrandSpec(config);
    expect(spec.title).toBe('Alder Family Archive');
    expect(spec.subtitle).toBe('Five Generations · 1812–1968');
    expect(spec.accent).toBe('#2F5245');
    expect(spec.surface).toBe('navy');
    expect(spec.dynamicOg).toBe(true);
  });

  it('renders light/dark adaptive favicon SVG with prefers-color-scheme media query', () => {
    const svg = renderFaviconSvg({ accent: '#2F5245', label: 'Alder & Co' });
    expect(svg).toContain('@media (prefers-color-scheme: dark)');
    expect(svg).toContain('#2F5245');
    expect(svg).toContain('aria-label="Alder &amp; Co"');
  });

  it('renders explicit light-only and dark-only favicon SVG variants for Android Chrome', () => {
    const lightSvg = renderLightFaviconSvg({ accent: '#2F5245', label: 'Alder Light' });
    expect(lightSvg).not.toContain('@media (prefers-color-scheme: dark)');
    expect(lightSvg).toContain(`fill: ${KINLOOM_BRAND_PALETTE.parchment}`);
    expect(lightSvg).toContain('stroke: #2F5245;');
    expect(lightSvg).toContain('aria-label="Alder Light"');

    const darkSvg = renderDarkFaviconSvg({ accent: '#2F5245', label: 'Alder Dark' });
    expect(darkSvg).not.toContain('@media (prefers-color-scheme: dark)');
    expect(darkSvg).toContain(`fill: ${KINLOOM_BRAND_PALETTE.navyElevated}`);
    expect(darkSvg).toContain(`stroke: ${KINLOOM_BRAND_PALETTE.ivory}`);
    expect(darkSvg).not.toContain('stroke: #2F5245;');
    expect(darkSvg).toContain('aria-label="Alder Dark"');

    const customDarkAccentSvg = renderFaviconSvg({
      accent: '#2F5245',
      accentDark: '#7CC2A6',
      mode: 'dark',
    });
    expect(customDarkAccentSvg).toContain('stroke: #7CC2A6;');
  });

  it('meets WCAG contrast thresholds in both light and dark favicon themes across dark accents', () => {
    const darkChromeHex = '#181818';
    const accents = ['#7A4612', '#2F5245', '#1B2A41', '#8A2B2B'] as const;

    for (const accent of accents) {
      const svg = renderFaviconSvg({ accent });
      const { light, dark } = parseFaviconThemeColors(svg);

      expect(light.accent).toBe(accent);
      expect(contrastRatio(light.accent, light.bgFill)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(light.warp, light.bgFill)).toBeGreaterThanOrEqual(7.0);

      expect(dark.accent).not.toBe(accent);
      expect(contrastRatio(dark.accent, dark.bgFill)).toBeGreaterThanOrEqual(5.0);
      expect(contrastRatio(dark.warp, dark.bgFill)).toBeGreaterThanOrEqual(7.0);
      expect(contrastRatio(dark.bgStroke, darkChromeHex)).toBeGreaterThanOrEqual(3.0);
    }
  });

  it('derives dark-mode favicon accents across hue sectors, achromatic colors, already-bright colors, and fallbacks', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBe(1);
    expect(contrastRatio('#000000', '#FFFFFF')).toBe(21);

    const ochreDark = deriveDarkModeFaviconAccent('#7A4612');
    expect(ochreDark).toBe('#E7A35E');
    expect(contrastRatio(ochreDark, KINLOOM_BRAND_PALETTE.navyElevated)).toBeGreaterThanOrEqual(6.0);

    const alreadyBright = deriveDarkModeFaviconAccent('#E8AD63', KINLOOM_BRAND_PALETTE.navyElevated, 5.0);
    expect(alreadyBright).toBe('#E8AD63');

    const achromatic = deriveDarkModeFaviconAccent('#000000', KINLOOM_BRAND_PALETTE.navyElevated, 5.0);
    expect(contrastRatio(achromatic, KINLOOM_BRAND_PALETTE.navyElevated)).toBeGreaterThanOrEqual(5.0);

    const magentaDark = deriveDarkModeFaviconAccent('#701A4E', KINLOOM_BRAND_PALETTE.navyElevated, 5.0);
    expect(contrastRatio(magentaDark, KINLOOM_BRAND_PALETTE.navyElevated)).toBeGreaterThanOrEqual(5.0);

    const pastelNeedBoost = deriveDarkModeFaviconAccent('#9A8B7A', KINLOOM_BRAND_PALETTE.navyElevated, 6.0);
    expect(contrastRatio(pastelNeedBoost, KINLOOM_BRAND_PALETTE.navyElevated)).toBeGreaterThanOrEqual(6.0);

    const fallbackHex = deriveDarkModeFaviconAccent('not-a-color', 'also-invalid', 5.0);
    expect(contrastRatio(fallbackHex, KINLOOM_BRAND_PALETTE.navyElevated)).toBeGreaterThanOrEqual(5.0);

    const clamped = deriveDarkModeFaviconAccent('#7A4612', '#FFFFFF', 21);
    expect(clamped).toBe('#FFFFFF');
  });

  it('renders opaque apple-touch and maskable icon SVGs with safe-zone scaling', () => {
    const apple = renderIconSvg({ size: 180, variant: 'apple', surface: 'parchment' });
    expect(apple).toContain('viewBox="0 0 180 180"');
    expect(apple).toContain('<rect x="0" y="0" width="180" height="180" fill="#F5EFE2"/>');

    const maskable = renderIconSvg({ size: 512, variant: 'maskable', surface: 'navy', accent: '#2F5245' });
    expect(maskable).toContain('viewBox="0 0 512 512"');
    expect(maskable).toContain('fill="#1B2A41"');
    expect(maskable).toContain('translate(122.88, 122.88)');

    const transparentAny = renderIconSvg({
      size: 192,
      variant: 'any',
      transparentBackground: true,
    });
    expect(transparentAny).not.toContain('<rect');
    expect(transparentAny).toContain('translate(19.20, 19.20)');
  });

  it('renders 1200x630 centered and split-vignette OG SVGs with XML escaping', () => {
    const centered = renderOgCardSvg({
      title: 'Alder & Oak <Archive>',
      subtitle: '1812–1968',
      metadataLine: 'OHIO & OREGON',
      accent: '#2F5245',
    });
    expect(centered).toContain(
      `viewBox="0 0 ${KINLOOM_OG_DIMENSIONS.width} ${KINLOOM_OG_DIMENSIONS.height}"`
    );
    expect(centered).toContain('Alder &amp; Oak');
    expect(centered).toContain('&lt;Archive&gt;');
    expect(centered).toContain('OHIO &amp; OREGON');

    const threeWordWrap = renderOgCardSvg({
      title: 'Alder Family Historical Records Archive',
      subtitle: 'Five Generations Across Four States',
      surface: 'navy',
      footerCredit: 'Built with Kinloom',
    });
    expect(threeWordWrap).toContain('Alder Family');
    expect(threeWordWrap).toContain('Historical Records…');
    expect(threeWordWrap).toContain('BUILT WITH KINLOOM');

    const split = renderOgCardSvg({
      title: 'Alder Family Archive',
      subtitle: 'Five Generations · 1812–1968',
      vignetteDataUri: 'data:image/jpeg;base64,AAAA',
    });
    expect(split).toContain('clipPath id="kl-vignette-clip"');
    expect(split).toContain('href="data:image/jpeg;base64,AAAA"');
  });

  it('builds a complete web manifest with standalone metadata, subpath baseUrl, and any + maskable icons', () => {
    const config = makeSampleConfig();
    const manifest = buildWebManifest(config);
    expect(manifest.id).toBe('/');
    expect(manifest.name).toBe('Alder Family Archive');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('any');
    expect(manifest.theme_color).toBe('#F5EFE2');
    expect(manifest.background_color).toBe('#F5EFE2');
    expect(manifest.icons.map((i) => `${i.src}:${i.sizes}:${i.purpose}`)).toEqual([
      '/icon-192.png:192x192:any',
      '/icon-512.png:512x512:any',
      '/icon-maskable-512.png:512x512:maskable',
    ]);

    const subpathManifest = buildWebManifest(config, { baseUrl: '/kinloom' });
    expect(subpathManifest.id).toBe('/kinloom/');
    expect(subpathManifest.start_url).toBe('/kinloom/');
    expect(subpathManifest.scope).toBe('/kinloom/');
    expect(subpathManifest.icons.map((i) => i.src)).toEqual([
      '/kinloom/icon-192.png',
      '/kinloom/icon-512.png',
      '/kinloom/icon-maskable-512.png',
    ]);
  });

  it('renders complete head tags with standalone PWA meta tags, color-scheme, pre-paint init, light/dark favicons, OG tags, and manifest', () => {
    const tags = renderBrandkitHeadTags(makeSampleConfig());
    expect(tags).toContain('<meta name="color-scheme" content="light dark" />');
    expect(tags).toContain(renderThemeInitScript());
    expect(renderThemeInitScript()).toBe('<script src="/theme-init.js"></script>');
    expect(renderThemeInitScript('/kinloom/')).toBe('<script src="/kinloom/theme-init.js"></script>');
    expect(renderThemeInitScriptSource()).toContain("localStorage.getItem('kinloom-theme')");
    expect(tags.match(/<script\b/g)).toHaveLength(1);
    expect(tags).toContain('name="theme-color" content="#171614" media="(prefers-color-scheme: dark)"');
    expect(tags).toContain('<meta name="mobile-web-app-capable" content="yes" />');
    expect(tags).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(tags).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default" />');
    expect(tags).toContain('<meta name="apple-mobile-web-app-title" content="Alder Family" />');
    expect(tags).toContain(
      '<link rel="icon" type="image/svg+xml" media="(prefers-color-scheme: light)" href="/favicon-light.svg" />'
    );
    expect(tags).toContain(
      '<link rel="icon" type="image/svg+xml" media="(prefers-color-scheme: dark)" href="/favicon-dark.svg" />'
    );
    expect(tags).toContain('property="og:site_name" content="Alder Family Archive"');
    expect(tags).toContain('name="twitter:card" content="summary_large_image"');
    expect(tags).toContain('property="og:image:width" content="1200"');
    expect(tags).toContain('property="og:image:height" content="630"');
    expect(tags).toContain('rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"');
    expect(tags).toContain('rel="manifest" href="/site.webmanifest"');

    const subpathTags = renderBrandkitHeadTags(makeSampleConfig(), { baseUrl: '/kinloom/' });
    expect(subpathTags).toContain('<script src="/kinloom/theme-init.js"></script>');
    expect(subpathTags).toContain(
      'rel="apple-touch-icon" sizes="180x180" href="/kinloom/apple-touch-icon.png"'
    );
    expect(subpathTags).toContain('rel="manifest" href="/kinloom/site.webmanifest"');
  });

  it('strictly redacts living people in resolveRouteOgMetadata while allowing deceased ancestors', () => {
    const config = makeSampleConfig({ dynamicOg: true });
    const livingPerson: RawPerson = {
      id: 'per_living_alder',
      slug: 'jordan-alder',
      full_name: 'Jordan Alder',
      given_name: 'Jordan',
      surname: 'Alder',
      alt_names: [],
      sex: 'U',
      birth_edtf: '1988-04-12',
      death_edtf: '',
      is_living: true,
      lineage_group: 'descendant',
      branch: 'alder',
      has_primary_source: false,
      portrait_url: null,
      thumb_url: null,
    };
    const livingOg = resolveRouteOgMetadata({ siteConfig: config, person: livingPerson });
    expect(livingOg.redacted).toBe(true);
    expect(livingOg.title).toBe('Alder Family Archive');
    expect(livingOg.title).not.toContain('Jordan');
    expect(livingOg.description).not.toContain('Jordan');
    expect(livingOg.imagePath).toBe('/og-default.png');

    const deceasedPerson: RawPerson = {
      id: 'per_arthur_alder',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      birth_edtf: '1842',
      death_edtf: '1918',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'alder',
      has_primary_source: true,
      portrait_url: null,
      thumb_url: null,
    };
    const deceasedOg = resolveRouteOgMetadata({ siteConfig: config, person: deceasedPerson });
    expect(deceasedOg.redacted).toBe(false);
    expect(deceasedOg.ogType).toBe('profile');
    expect(deceasedOg.title).toBe('Arthur Alder (1842–1918) | Alder Family Archive');
    expect(deceasedOg.imagePath).toBe('/og/person/per_arthur_alder.svg');
  });
});
