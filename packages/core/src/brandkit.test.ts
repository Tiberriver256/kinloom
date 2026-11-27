import { describe, expect, it } from 'vitest';
import {
  buildWebManifest,
  KINLOOM_OG_DIMENSIONS,
  renderBrandkitHeadTags,
  renderFaviconSvg,
  renderIconSvg,
  renderOgCardSvg,
  resolveBrandSpec,
  resolveRouteOgMetadata,
} from './brandkit.js';
import { parseKinloomConfig } from './schemas/config.js';
import type { RawPerson } from './schemas/entities.js';

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

  it('renders opaque apple-touch and maskable icon SVGs with safe-zone scaling', () => {
    const apple = renderIconSvg({ size: 180, variant: 'apple', surface: 'parchment' });
    expect(apple).toContain('viewBox="0 0 180 180"');
    expect(apple).toContain('<rect x="0" y="0" width="180" height="180" fill="#F5EFE2"/>');

    const maskable = renderIconSvg({ size: 512, variant: 'maskable', surface: 'navy', accent: '#2F5245' });
    expect(maskable).toContain('viewBox="0 0 512 512"');
    expect(maskable).toContain('fill="#1B2A41"');
    expect(maskable).toContain('translate(122.88, 122.88)');
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

    const split = renderOgCardSvg({
      title: 'Alder Family Archive',
      subtitle: 'Five Generations · 1812–1968',
      vignetteDataUri: 'data:image/jpeg;base64,AAAA',
    });
    expect(split).toContain('clipPath id="kl-vignette-clip"');
    expect(split).toContain('href="data:image/jpeg;base64,AAAA"');
  });

  it('builds a complete web manifest with any and maskable icons', () => {
    const config = makeSampleConfig();
    const manifest = buildWebManifest(config);
    expect(manifest.name).toBe('Alder Family Archive');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map((i) => `${i.sizes}:${i.purpose}`)).toEqual([
      '192x192:any',
      '512x512:any',
      '512x512:maskable',
    ]);
  });

  it('renders complete head tags with summary_large_image, raster apple-touch-icon, and manifest', () => {
    const tags = renderBrandkitHeadTags(makeSampleConfig());
    expect(tags).toContain('property="og:site_name" content="Alder Family Archive"');
    expect(tags).toContain('name="twitter:card" content="summary_large_image"');
    expect(tags).toContain('property="og:image:width" content="1200"');
    expect(tags).toContain('property="og:image:height" content="630"');
    expect(tags).toContain('rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"');
    expect(tags).toContain('rel="manifest" href="/site.webmanifest"');
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
