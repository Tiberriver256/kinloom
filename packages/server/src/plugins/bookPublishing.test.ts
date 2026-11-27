import {
  type ArchiveBundle,
  type AtomicMutationOp,
  compileArchive,
  type KinloomSiteConfig,
  type MediaItem,
  type Narrative,
  type Place,
  parseKinloomConfig,
  type RawEvent,
  type RawPerson,
  type SourceRecord,
  toEntityPayload,
} from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import type { FixedClock } from '../adapters/systemClock.js';
import { createKinloomServer } from '../http/router.js';
import { getSessionCookieName, signSessionToken } from '../http/session.js';
import {
  BOOK_PUBLISHING_ARTIFACTS_ROUTE,
  BOOK_PUBLISHING_COMPILE_ROUTE,
  BOOK_PUBLISHING_ESTIMATE_ROUTE,
  BOOK_PUBLISHING_JOBS_ROUTE,
  BOOK_PUBLISHING_PLUGIN_ID,
  BOOK_PUBLISHING_STATUS_ROUTE,
  BOOK_PUBLISHING_WEBHOOK_LULU_ROUTE,
  BOOK_TRIM_PRESETS,
  type BookPhysicalSpec,
  BookPrivacyError,
  type BookShippingAddress,
  compileArchivalBook,
  computeCoverDimensionsOffline,
  computeInsideGutterIn,
  computeInteriorGeometry,
  computeOfflineSpineWidthIn,
  createBookPublishingServerPlugin,
  createCloudflareBrowserPdfRenderer,
  createDeterministicPdfRenderer,
  createLuluBookPublisherAdapter,
  createMockBookPublisherAdapter,
  encodePdfLiteralString,
  evaluateImageDpi,
  inchesToMm,
  inspectPdfPrepress,
  LULU_PRODUCTION_BASE_URL,
  LULU_SANDBOX_BASE_URL,
  mapLuluStatusToBookPrintJobStatus,
  normalizeBookPageCount,
  parseDecimalDollarsToCents,
  resolveLuluPodPackageId,
  runBookPrivacyGate,
  signLuluWebhookHmacHex,
  verifyLuluWebhookHmac,
} from './bookPublishing.js';

const SESSION_SECRET = 'test-book-publishing-secret-at-least-32-chars!!';

const SAMPLE_ADDRESS: BookShippingAddress = {
  name: 'Rowan Alder',
  street1: '100 Maple Archival Lane',
  city: 'Springfield',
  stateCode: 'IL',
  countryCode: 'US',
  postalCode: '62701',
  phoneNumber: '+15555550100',
};

function makeSyntheticSiteConfig(): KinloomSiteConfig {
  return parseKinloomConfig({
    site: {
      title: 'Alder Family Chronicle',
      familyName: 'Alder Family',
      gedcomSourceName: 'ALDER_BOOK_TEST',
      description: 'Synthetic historical family chronicle for archival print verification.',
    },
    branches: [
      {
        id: 'alder',
        label: 'Alder Branch',
        surnames: ['Alder'],
        lineageGroups: ['direct'],
      },
      {
        id: 'cedar',
        label: 'Cedar Branch',
        surnames: ['Cedar'],
        lineageGroups: ['collateral'],
      },
    ],
    lineageSections: [
      {
        id: 'founding-alders',
        title: 'Founding Alder Generation',
        subtitle: 'Primary settlers and documented land grants',
        lineageGroups: ['direct'],
        branchId: 'alder',
      },
    ],
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
      stripLivingPortraits: true,
      stripLivingResidenceSpans: true,
    },
  });
}

function makeSyntheticRawArchive(): {
  people: RawPerson[];
  events: RawEvent[];
  places: Place[];
  sources: SourceRecord[];
  kinship: Array<{ from: string; to: string; relation: 'parent' | 'child' | 'spouse' }>;
  media: MediaItem[];
  narratives: Narrative[];
} {
  const people: RawPerson[] = [
    {
      id: 'p-thomas',
      slug: 'thomas-alder',
      full_name: 'Thomas Alder',
      given_name: 'Thomas',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'direct',
      branch: 'alder',
      birth_edtf: '1840-03-14',
      death_edtf: '1912-11-02',
      portrait_url: '/media/thomas-portrait.jpg',
    },
    {
      id: 'p-clara',
      slug: 'clara-cedar',
      full_name: 'Clara Cedar',
      given_name: 'Clara',
      surname: 'Cedar',
      alt_names: ['Clara Alder'],
      sex: 'F',
      is_living: false,
      lineage_group: 'collateral',
      branch: 'cedar',
      birth_edtf: '1844-07-19',
      death_edtf: '1919-04-08',
      portrait_url: null,
    },
    {
      id: 'p-living-morgan',
      slug: 'morgan-alder',
      full_name: 'Morgan SecretLiving Alder',
      given_name: 'Morgan',
      surname: 'Alder',
      alt_names: ['Morgie SecretAlias'],
      sex: 'X',
      is_living: true,
      lineage_group: 'direct',
      branch: 'alder',
      birth_edtf: '1992-05-10',
      death_edtf: '',
      portrait_url: '/media/living-morgan-portrait.jpg',
    },
  ];

  const places: Place[] = [
    {
      id: 'pl-springfield',
      slug: 'springfield-il',
      name: 'Springfield',
      full_name: 'Springfield, Sangamon County, Illinois',
      place_type: 'town',
      parent_id: null,
      lat: 39.7817,
      lng: -89.6501,
      summary: 'County seat where Thomas Alder operated a mill and Morgan SecretLiving Alder visited.',
    },
    {
      id: 'pl-lexington',
      slug: 'lexington-ky',
      name: 'Lexington',
      full_name: 'Lexington, Fayette County, Kentucky',
      place_type: 'town',
      parent_id: null,
      lat: 38.0406,
      lng: -84.5037,
      summary: 'Early homestead prior to the Illinois migration.',
    },
  ];

  const sources: SourceRecord[] = [
    {
      id: 'src-census-1880',
      citation: '1880 U.S. Federal Census, Sangamon County, Illinois, p. 42.',
      author: 'U.S. Census Bureau',
      publisher: 'National Archives',
      source_type: 'census',
      repository: 'NARA',
    },
    {
      id: 'src-deed-1868',
      citation: 'Sangamon County Land Deed Book 12, p. 88 (1868).',
      author: 'County Recorder',
      publisher: 'Sangamon County',
      source_type: 'deed',
    },
  ];

  const events: RawEvent[] = [
    {
      id: 'ev-thomas-birth',
      title: 'Birth of Thomas Alder',
      scope: 'personal',
      event_kind: 'point_event',
      edtf_date: '1840-03-14',
      place_id: 'pl-lexington',
      summary: 'Born in Fayette County, Kentucky.',
      participants: [{ person_id: 'p-thomas', role: 'subject' }],
      sources: [{ source_id: 'src-census-1880', confidence: 'high' }],
    },
    {
      id: 'ev-migration-1868',
      title: 'Settlement in Springfield',
      scope: 'family',
      event_kind: 'residence_anchor',
      edtf_date: '1868-06-01',
      place_id: 'pl-springfield',
      summary: 'Thomas Alder and Clara Cedar acquired farmland near Springfield.',
      participants: [
        { person_id: 'p-thomas', role: 'subject' },
        { person_id: 'p-clara', role: 'spouse' },
      ],
      sources: [{ source_id: 'src-deed-1868', confidence: 'high' }],
    },
    {
      id: 'ev-living-birth',
      title: 'Birth of Morgan SecretLiving Alder',
      scope: 'personal',
      event_kind: 'point_event',
      edtf_date: '1992-05-10',
      place_id: 'pl-springfield',
      summary: 'Private living relative birth event.',
      participants: [{ person_id: 'p-living-morgan', role: 'subject' }],
      sources: [],
    },
  ];

  const kinship: Array<{ from: string; to: string; relation: 'parent' | 'child' | 'spouse' }> = [
    { from: 'p-thomas', to: 'p-clara', relation: 'spouse' },
    { from: 'p-thomas', to: 'p-living-morgan', relation: 'parent' },
  ];

  const media: MediaItem[] = [
    {
      id: 'med-thomas-1',
      kind: 'portrait',
      person_id: 'p-thomas',
      file: 'media/thomas-1880.jpg',
      caption: 'Tintype portrait of Thomas Alder (1880) with note mentioning Morgan SecretLiving Alder.',
      date_edtf: '1880',
      provenance: 'Alder Trunk Collection',
    },
    {
      id: 'med-living-1',
      kind: 'portrait',
      person_id: 'p-living-morgan',
      file: 'media/living-morgan-2024.jpg',
      caption: 'Private modern photo of Morgan SecretLiving Alder.',
      date_edtf: '2024',
      provenance: 'Private Family Camera',
    },
  ];

  const narratives: Narrative[] = [
    {
      id: 'nar-thomas-mill',
      slug: 'thomas-alder-mill',
      kind: 'biography',
      subject_person_id: 'p-thomas',
      title: 'The Springfield Mill Years',
      summary: 'Account of the grist mill built in 1868.',
      body_md:
        '# The Mill\n\nThomas Alder operated a mill in Springfield. Descendant Morgan SecretLiving Alder later preserved the ledger.',
      person_ids: ['p-thomas', 'p-living-morgan'],
      place_ids: ['pl-springfield'],
      event_ids: ['ev-migration-1868'],
      source_ids: ['src-census-1880', 'src-deed-1868'],
    },
  ];

  return { people, events, places, sources, kinship, media, narratives };
}

function makeSyntheticBundle(): { bundle: ArchiveBundle; siteConfig: KinloomSiteConfig } {
  const siteConfig = makeSyntheticSiteConfig();
  const raw = makeSyntheticRawArchive();
  const { bundle } = compileArchive({
    ...raw,
    siteConfig,
    mode: 'private',
    generatedAt: '2026-11-27T12:00:00.000Z',
    referenceYear: 2026,
  });
  // Re-attach raw media so tests prove runBookPrivacyGate strips living media even if an unredacted bundle arrives.
  return { bundle: { ...bundle, media: raw.media }, siteConfig };
}

async function createSessionCookie(params: {
  clock: FixedClock;
  email: string;
  role: 'admin' | 'editor';
  displayName: string;
}): Promise<string> {
  const token = await signSessionToken({
    secret: SESSION_SECRET,
    clock: params.clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email: params.email,
      display_name: params.displayName,
      role: params.role,
    },
  });
  return `${getSessionCookieName(true)}=${token}`;
}

async function seedInMemoryRepo(ports: ReturnType<typeof createInMemoryServerPorts>) {
  const raw = makeSyntheticRawArchive();
  const makeOp = (
    entity_type: AtomicMutationOp['entity_type'],
    entity_id: string,
    payload: Record<string, unknown>,
    slug?: string | null
  ): AtomicMutationOp => ({
    entity_type,
    entity_id,
    slug: slug ?? null,
    action: 'create',
    expected_parent_revision_id: null,
    summary: `Seed ${entity_type} ${entity_id}`,
    has_primary_source: true,
    before_json: null,
    after_json: toEntityPayload(payload),
  });

  const ops: AtomicMutationOp[] = [
    ...raw.people.map((p) => makeOp('person', p.id, p, p.slug)),
    ...raw.places.map((pl) => makeOp('place', pl.id, pl, pl.slug)),
    ...raw.sources.map((s) => makeOp('source', s.id, s)),
    ...raw.events.map((e) => makeOp('event', e.id, e)),
    ...raw.media.map((m) => makeOp('media', m.id, m)),
    ...raw.narratives.map((n) => makeOp('narrative', n.id, n, n.slug)),
    ...raw.kinship.map((k, idx) => makeOp('kinship_edge', `k-${idx}`, k)),
  ];

  await ports.repository.commitAtomicMutations({
    batch_id: null,
    author: { author_id: 'seed', author_name: 'Seed', author_type: 'system_seed' },
    nowIso: '2026-11-27T12:00:00.000Z',
    operations: ops,
  });
}

describe('book prepress geometry and pagination math', () => {
  it('computes exact bleed, MediaBox, BleedBox, TrimBox, and mm conversions for all landscape presets', () => {
    const usLetter = computeInteriorGeometry({
      trimPreset: 'us-letter-landscape',
      binding: 'hardcover-casewrap-glossy',
      paperStock: '80lb-coated-white-color',
      interiorPageCount: 120,
    });
    expect(usLetter.bleedWidthIn).toBe(11.25);
    expect(usLetter.bleedHeightIn).toBe(8.75);
    expect(usLetter.mediaBoxPt).toEqual({ x0: 0, y0: 0, x1: 810, y1: 630 });
    expect(usLetter.trimBoxPt).toEqual({ x0: 9, y0: 9, x1: 801, y1: 621 });
    expect(usLetter.insideGutterIn).toBe(0.625);
    expect(inchesToMm(11)).toBe(279.4);

    const a4 = computeInteriorGeometry({
      trimPreset: 'a4-landscape',
      binding: 'hardcover-casewrap-matte',
      paperStock: '60lb-uncoated-white-color',
      interiorPageCount: 320,
    });
    expect(a4.bleedWidthIn).toBe(11.94);
    expect(a4.bleedHeightIn).toBe(8.52);
    expect(a4.insideGutterIn).toBe(0.875);
    expect(BOOK_TRIM_PRESETS['photo-10x8-landscape'].luluTrimToken).toBe('1000X0800');
    expect(BOOK_TRIM_PRESETS['small-9x7-landscape'].luluTrimToken).toBe('0900X0700');
  });

  it('enforces 24..800 even page counts, stepped gutters, and spine tiers', () => {
    expect(normalizeBookPageCount(10)).toEqual({
      rawPages: 10,
      finalPages: 24,
      paddingPages: 14,
      ledgerPages: 14,
      versoPad: false,
    });
    expect(normalizeBookPageCount(25)).toEqual({
      rawPages: 25,
      finalPages: 26,
      paddingPages: 1,
      ledgerPages: 0,
      versoPad: true,
    });
    expect(() => normalizeBookPageCount(0)).toThrow(RangeError);
    expect(() => normalizeBookPageCount(801)).toThrow(/800-page hardcover/);

    expect(computeInsideGutterIn(150)).toBe(0.625);
    expect(computeInsideGutterIn(200)).toBe(0.75);
    expect(computeInsideGutterIn(400)).toBe(0.875);
    expect(computeInsideGutterIn(600)).toBe(1.0);

    expect(computeOfflineSpineWidthIn(40, '80lb-coated-white-color')).toBe(0.25);
    expect(computeOfflineSpineWidthIn(120, '80lb-coated-white-color')).toBe(0.5);
    expect(computeOfflineSpineWidthIn(160, '80lb-coated-white-color')).toBe(0.625);
    expect(computeOfflineSpineWidthIn(180, '80lb-coated-white-color')).toBe(0.6875);
    expect(computeOfflineSpineWidthIn(210, '80lb-coated-white-color')).toBe(0.75);
    expect(computeOfflineSpineWidthIn(300, '80lb-coated-white-color')).toBe(0.9375);
    expect(computeOfflineSpineWidthIn(100, '60lb-uncoated-white-color')).toBe(0.5625);
  });

  it('computes exact wraparound cover dimensions, omits spine text below 80 pages, and reserves barcode zone', () => {
    const cover120 = computeCoverDimensionsOffline({
      trimPreset: 'us-letter-landscape',
      binding: 'hardcover-casewrap-glossy',
      paperStock: '80lb-coated-white-color',
      interiorPageCount: 120,
    });
    expect(cover120.totalWidthIn).toBe(24.0);
    expect(cover120.totalHeightIn).toBe(10.0);
    expect(cover120.totalWidthPt).toBe(1728);
    expect(cover120.totalHeightPt).toBe(720);
    expect(cover120.allowSpineText).toBe(true);
    expect(cover120.providerSku).toBe('1100X0850.FC.PRE.CW.080CW444.GXX');
    expect(cover120.barcodeClearanceIn).toEqual({ xIn: 9.25, yIn: 1.25, widthIn: 2, heightIn: 1.25 });

    const cover40 = computeCoverDimensionsOffline({
      trimPreset: 'a4-landscape',
      binding: 'hardcover-casewrap-matte',
      paperStock: '60lb-uncoated-white-color',
      interiorPageCount: 40,
    });
    expect(cover40.allowSpineText).toBe(false);
    expect(cover40.maxSpineTextHeightIn).toBe(0);
    expect(
      resolveLuluPodPackageId({
        trimPreset: 'a4-landscape',
        binding: 'hardcover-casewrap-matte',
        paperStock: '60lb-uncoated-white-color',
        interiorPageCount: 40,
      })
    ).toBe('1169X0827.FC.PRE.CW.060UC444.MXX');
  });

  it('classifies raster DPI across pass, warn, and low tiers with recommended frame sizing', () => {
    const pass = evaluateImageDpi({
      mediaId: 'm1',
      file: 'hi.jpg',
      widthPx: 1800,
      heightPx: 1200,
      placedWidthIn: 4.5,
      placedHeightIn: 3.25,
    });
    expect(pass.status).toBe('pass');
    expect(pass.effectiveDpi).toBe(369);

    const warn = evaluateImageDpi({
      mediaId: 'm2',
      file: 'med.jpg',
      widthPx: 1100,
      heightPx: 800,
      placedWidthIn: 4.5,
      placedHeightIn: 3.25,
    });
    expect(warn.status).toBe('warn');

    const low = evaluateImageDpi({
      mediaId: 'm3',
      file: 'lo.jpg',
      widthPx: 600,
      heightPx: 400,
      placedWidthIn: 4.5,
      placedHeightIn: 3.25,
    });
    expect(low.status).toBe('low');
    expect(low.recommendedWidthIn).toBeLessThan(4.5);
  });
});

describe('mandatory living-person privacy redaction gate and compiler', () => {
  it('excludes living people, private media, and scrubs living names from HTML and PDF in public edition', async () => {
    const { bundle, siteConfig } = makeSyntheticBundle();
    const compiled = compileArchivalBook({
      bundle,
      siteConfig,
      options: {
        edition: 'public',
        dedication: 'Dedicated to Thomas Alder and Morgan SecretLiving Alder.',
        imageDimensionsByFile: {
          'media/thomas-1880.jpg': { widthPx: 700, heightPx: 500 },
        },
      },
    });

    expect(compiled.report.counts.includedPeople).toBe(2);
    expect(compiled.report.counts.excludedLivingPeople).toBe(1);
    expect(compiled.report.counts.excludedLivingMedia).toBe(1);
    expect(compiled.report.counts.finalPageCount).toBe(24);
    expect(compiled.report.warnings.some((w) => w.code === 'low_resolution_image')).toBe(true);

    // Living person name, alias, and private photo file must NEVER appear in compiled HTML or index
    expect(compiled.interiorHtml).not.toContain('Morgan SecretLiving Alder');
    expect(compiled.interiorHtml).not.toContain('Morgie SecretAlias');
    expect(compiled.interiorHtml).not.toContain('living-morgan-2024.jpg');
    expect(compiled.coverHtml).not.toContain('Morgan SecretLiving Alder');
    expect(compiled.indexEntries.some((e) => e.term.includes('Morgan'))).toBe(false);
    expect(compiled.interiorHtml).toContain('Thomas Alder');
    expect(compiled.interiorHtml).toContain('1880 U.S. Federal Census');

    // Render deterministic interior + cover PDFs and inspect actual binary output
    const renderer = createDeterministicPdfRenderer();
    const interiorBytes = await renderer.renderInterior(compiled);
    const coverBytes = await renderer.renderCover(compiled);

    const interiorInfo = inspectPdfPrepress(interiorBytes);
    expect(interiorInfo.validHeader).toBe(true);
    expect(interiorInfo.validEof).toBe(true);
    expect(interiorInfo.pageCount).toBe(24);
    expect(interiorInfo.mediaBoxPt).toEqual({ x0: 0, y0: 0, x1: 810, y1: 630 });
    expect(interiorInfo.trimBoxPt).toEqual({ x0: 9, y0: 9, x1: 801, y1: 621 });
    expect(interiorInfo.rawText).toContain('Thomas Alder');
    expect(interiorInfo.rawText).not.toContain('Morgan SecretLiving Alder');
    expect(interiorInfo.rawText).not.toContain('living-morgan-2024.jpg');

    const coverInfo = inspectPdfPrepress(coverBytes);
    expect(coverInfo.validHeader).toBe(true);
    expect(coverInfo.validEof).toBe(true);
    expect(coverInfo.pageCount).toBe(1);
    expect(coverInfo.mediaBoxPt?.x1).toBe(compiled.report.coverDimensions.totalWidthPt);
    expect(coverInfo.mediaBoxPt?.y1).toBe(compiled.report.coverDimensions.totalHeightPt);
  });

  it('fails closed when public privacy review flags exist unless acknowledged, and gates private edition', () => {
    const { bundle, siteConfig } = makeSyntheticBundle();
    // Inject an event whose summary mentions a living person without listing them as a participant
    const flaggedBundle: ArchiveBundle = {
      ...bundle,
      events: [
        ...bundle.events,
        {
          id: 'ev-unlinked-mention',
          title: 'Town Reunion',
          scope: 'family',
          event_kind: 'point_event',
          edtf_date: '1900',
          display_date: '1900',
          year: 1900,
          time_min: 19000101,
          time_max: 19001231,
          place_id: 'pl-springfield',
          summary: 'Later researched by Morgan SecretLiving Alder.',
          participants: [{ person_id: 'p-thomas', role: 'subject' }],
          sources: [],
        },
      ],
    };

    expect(() =>
      runBookPrivacyGate({
        bundle: flaggedBundle,
        siteConfig,
        edition: 'public',
        referenceYear: 2026,
      })
    ).toThrow(BookPrivacyError);

    const acknowledged = compileArchivalBook({
      bundle: flaggedBundle,
      siteConfig,
      options: { edition: 'public', acknowledgeReviewFlags: true, referenceYear: 2026 },
    });
    expect(acknowledged.report.privacy.reviewFlagsDetected).toBeGreaterThan(0);
    expect(acknowledged.report.privacy.reviewFlagsAcknowledged).toBe(true);
    expect(acknowledged.interiorHtml).not.toContain('Morgan SecretLiving Alder');

    expect(() =>
      runBookPrivacyGate({
        bundle,
        siteConfig,
        edition: 'private',
        referenceYear: 2026,
      })
    ).toThrow(/includeLiving/);

    const privateEdition = compileArchivalBook({
      bundle,
      siteConfig,
      options: {
        edition: 'private',
        includeLiving: true,
        allowLivingPortraits: false,
        branchId: 'alder',
        proofMarks: true,
        referenceYear: 2026,
      },
    });
    expect(privateEdition.report.edition).toBe('private');
    expect(privateEdition.report.colophonNotice).toBe('Private Family Edition. Not for Public Distribution.');
    expect(privateEdition.report.counts.includedPeople).toBe(2); // Thomas + Morgan in alder branch
    expect(privateEdition.report.counts.excludedLivingMedia).toBe(1); // living portrait still stripped
  });

  it('escapes PDF literal characters and supports Cloudflare Browser Rendering adapter', async () => {
    expect(encodePdfLiteralString('A (test) \\ — “quoted”')).toBe('A \\(test\\) \\\\ -- "quoted"');

    const calls: string[] = [];
    const cfRenderer = createCloudflareBrowserPdfRenderer({
      accountId: 'acct-123',
      apiToken: 'cf-token',
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(new TextEncoder().encode('%PDF-1.4\n%%EOF\n'), { status: 200 });
      },
    });

    const { bundle, siteConfig } = makeSyntheticBundle();
    const compiled = compileArchivalBook({ bundle, siteConfig, options: { edition: 'public' } });
    const interior = await cfRenderer.renderInterior(compiled);
    const cover = await cfRenderer.renderCover(compiled);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/accounts/acct-123/browser-rendering/pdf');
    expect(inspectPdfPrepress(interior).validHeader).toBe(true);
    expect(inspectPdfPrepress(cover).validHeader).toBe(true);

    const failingRenderer = createCloudflareBrowserPdfRenderer({
      accountId: 'acct-123',
      apiToken: 'bad',
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    });
    await expect(failingRenderer.renderInterior(compiled)).rejects.toThrow(/401/);
  });
});

describe('BookPublisherProvider adapters (Lulu Print API & Mock)', () => {
  it('parses decimal dollar amounts into exact integer cents and maps Lulu statuses', () => {
    expect(parseDecimalDollarsToCents('54.06')).toBe(5406);
    expect(parseDecimalDollarsToCents('0.995')).toBe(100);
    expect(parseDecimalDollarsToCents(12.5)).toBe(1250);
    expect(parseDecimalDollarsToCents(null)).toBe(0);
    expect(() => parseDecimalDollarsToCents('not-a-number')).toThrow(RangeError);

    expect(mapLuluStatusToBookPrintJobStatus('UNPAID')).toBe('created');
    expect(mapLuluStatusToBookPrintJobStatus('NORMALIZING')).toBe('validating');
    expect(mapLuluStatusToBookPrintJobStatus('PRODUCTION_READY')).toBe('ready_for_production');
    expect(mapLuluStatusToBookPrintJobStatus('IN_PRODUCTION')).toBe('in_production');
    expect(mapLuluStatusToBookPrintJobStatus('SHIPPED')).toBe('shipped');
    expect(mapLuluStatusToBookPrintJobStatus('REJECTED')).toBe('rejected');
    expect(mapLuluStatusToBookPrintJobStatus('CANCELED')).toBe('canceled');
  });

  it('handles Lulu OAuth2 token caching, 401 token refresh, dimensions, cost quote, preflight, print job, and HMAC verification', async () => {
    let tokenFetches = 0;
    let costCalls = 0;
    const requestedUrls: string[] = [];

    const lulu = createLuluBookPublisherAdapter({
      environment: 'sandbox',
      clientId: 'lulu-key',
      clientSecret: 'lulu-secret-value',
      webhookSecret: 'webhook-signing-secret',
      nowMs: () => 1_760_000_000_000,
      fetchImpl: async (input, init) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url.endsWith('/openid-connect/token')) {
          tokenFetches += 1;
          return new Response(
            JSON.stringify({ access_token: `tok-${tokenFetches}`, expires_in: 3600, token_type: 'bearer' }),
            { status: 200 }
          );
        }
        if (url.endsWith('/cover-dimensions/')) {
          return new Response(JSON.stringify({ width: '24.000', height: '10.000', unit: 'inch' }), {
            status: 200,
          });
        }
        if (url.endsWith('/print-job-cost-calculations/')) {
          costCalls += 1;
          // Force a 401 on the first call to verify automatic token refresh retry
          if (
            costCalls === 1 &&
            init?.headers &&
            new Headers(init.headers).get('authorization') === 'Bearer tok-1'
          ) {
            return new Response('token expired', { status: 401 });
          }
          return new Response(
            JSON.stringify({
              currency: 'USD',
              line_item_costs: [{ total_cost_excl_tax: '32.50' }],
              shipping_cost: { total_cost_excl_tax: '11.99' },
              fulfillment_cost: { total_cost_excl_tax: '1.50' },
              total_tax: '3.22',
              total_cost_incl_tax: '49.21',
            }),
            { status: 200 }
          );
        }
        if (url.endsWith('/validate-interior/')) {
          return new Response(JSON.stringify({ id: 'val-int-1', status: 'NORMALIZED', errors: [] }), {
            status: 200,
          });
        }
        if (url.endsWith('/validate-cover/')) {
          return new Response(JSON.stringify({ id: 'val-cov-1', status: 'VALIDATED', errors: [] }), {
            status: 200,
          });
        }
        if (url.endsWith('/print-jobs/')) {
          return new Response(
            JSON.stringify({
              id: 98765,
              external_id: 'ext-1',
              status: { name: 'CREATED', message: 'Queued' },
              line_items: [{ title: 'Alder Chronicle', quantity: 2, tracking_urls: [] }],
              date_modified: '2026-11-27T12:00:00Z',
            }),
            { status: 201 }
          );
        }
        if (url.endsWith('/print-jobs/98765/')) {
          return new Response(
            JSON.stringify({
              id: 98765,
              external_id: 'ext-1',
              status: { name: 'SHIPPED', message: 'Carrier picked up' },
              line_items: [
                { title: 'Alder Chronicle', quantity: 2, tracking_urls: ['https://track.example/98765'] },
              ],
              date_modified: '2026-11-28T12:00:00Z',
            }),
            { status: 200 }
          );
        }
        return new Response('unexpected', { status: 404 });
      },
    });

    const spec: BookPhysicalSpec = {
      trimPreset: 'us-letter-landscape',
      binding: 'hardcover-casewrap-glossy',
      paperStock: '80lb-coated-white-color',
      interiorPageCount: 120,
    };

    const dims = await lulu.getCoverDimensions(spec);
    expect(dims.source).toBe('provider_api');
    expect(dims.totalWidthIn).toBe(24);
    expect(dims.totalHeightIn).toBe(10);
    expect(tokenFetches).toBe(1);

    const quote = await lulu.estimateCost({
      spec,
      quantity: 2,
      shippingAddress: SAMPLE_ADDRESS,
      shippingLevel: 'ground',
    });
    expect(tokenFetches).toBe(2); // refreshed after 401
    expect(quote.manufacturingCostCents).toBe(3250);
    expect(quote.shippingCostCents).toBe(1199);
    expect(quote.fulfillmentFeeCents).toBe(150);
    expect(quote.taxCents).toBe(322);
    expect(quote.totalCostCents).toBe(4921);
    expect(quote.sandbox).toBe(true);
    expect(requestedUrls.every((u) => u.startsWith(LULU_SANDBOX_BASE_URL))).toBe(true);

    const validated = await lulu.validateInteriorAndCover({
      spec,
      interiorPdfUrl: 'https://archive.example/int.pdf',
      coverPdfUrl: 'https://archive.example/cov.pdf',
    });
    expect(validated.interior.ok).toBe(true);
    expect(validated.cover.ok).toBe(true);

    const created = await lulu.createPrintJob({
      externalId: 'ext-1',
      title: 'Alder Chronicle',
      contactEmail: 'steward@archive.example',
      spec,
      quantity: 2,
      interiorPdfUrl: 'https://archive.example/int.pdf',
      coverPdfUrl: 'https://archive.example/cov.pdf',
      shippingAddress: SAMPLE_ADDRESS,
      shippingLevel: 'ground',
    });
    expect(created.jobId).toBe('98765');
    expect(created.status).toBe('created');

    const polled = await lulu.getPrintJobStatus('98765');
    expect(polled.status).toBe('shipped');
    expect(polled.trackingUrls).toEqual(['https://track.example/98765']);

    // Verify Lulu-HMAC-SHA256 on raw body bytes
    const rawBody = new TextEncoder().encode(
      JSON.stringify({ topic: 'PRINT_JOB_STATUS_CHANGED', data: { id: 98765 } })
    );
    const validHex = await signLuluWebhookHmacHex('webhook-signing-secret', rawBody);
    expect(await lulu.verifyWebhookSignature?.(rawBody, new Headers({ 'Lulu-HMAC-SHA256': validHex }))).toBe(
      true
    );
    expect(
      await lulu.verifyWebhookSignature?.(
        new TextEncoder().encode('{"tampered":true}'),
        new Headers({ 'Lulu-HMAC-SHA256': validHex })
      )
    ).toBe(false);
    expect(await verifyLuluWebhookHmac('webhook-signing-secret', rawBody, 'not-valid')).toBe(false);

    // Production adapter targets production base URL
    let prodUrl = '';
    const prodLulu = createLuluBookPublisherAdapter({
      environment: 'production',
      clientId: 'prod-key',
      clientSecret: 'prod-secret',
      fetchImpl: async (input) => {
        prodUrl = String(input);
        return new Response('nope', { status: 401 });
      },
    });
    await expect(prodLulu.getCoverDimensions(spec)).rejects.toThrow(/OAuth token request failed/);
    expect(prodUrl.startsWith(LULU_PRODUCTION_BASE_URL)).toBe(true);
  });

  it('executes deterministic offline flows with MockBookPublisherAdapter', async () => {
    const mock = createMockBookPublisherAdapter({ webhookSecret: 'mock-secret' });
    const spec: BookPhysicalSpec = {
      trimPreset: 'us-letter-landscape',
      binding: 'hardcover-casewrap-glossy',
      paperStock: '80lb-coated-white-color',
      interiorPageCount: 24,
    };
    const quote = await mock.estimateCost({
      spec,
      quantity: 1,
      shippingAddress: SAMPLE_ADDRESS,
      shippingLevel: 'mail',
    });
    expect(quote.providerId).toBe('mock');
    expect(quote.totalCostCents).toBeGreaterThan(0);

    const job = await mock.createPrintJob({
      externalId: 'dry-1',
      title: 'Alder Test Book',
      contactEmail: 'steward@archive.example',
      spec,
      quantity: 1,
      interiorPdfUrl: 'https://archive.example/i.pdf',
      coverPdfUrl: 'https://archive.example/c.pdf',
      shippingAddress: SAMPLE_ADDRESS,
      shippingLevel: 'mail',
    });
    expect(job.jobId).toBe('mock-job-1');
    expect((await mock.getPrintJobStatus(job.jobId)).status).toBe('ready_for_production');
    await expect(mock.getPrintJobStatus('unknown-job')).rejects.toThrow(/was not found/);
  });
});

describe('createBookPublishingServerPlugin off-by-default isolation, RBAC, secrets, and HTTP lifecycle', () => {
  it('exposes zero routes when unregistered or disabled', async () => {
    const siteConfig = makeSyntheticSiteConfig();
    const defaultPorts = createInMemoryServerPorts(siteConfig);
    const defaultServer = createKinloomServer({
      siteConfig,
      ports: defaultPorts,
      sessionSecret: SESSION_SECRET,
    });
    const res = await defaultServer.fetch(
      new Request(`https://archive.example${BOOK_PUBLISHING_STATUS_ROUTE}`)
    );
    expect(res.status).toBe(404);

    const disabledPlugin = createBookPublishingServerPlugin({ enabled: false });
    expect(disabledPlugin.status).toBe('disabled');
    expect(disabledPlugin.routes).toBeUndefined();
    expect(disabledPlugin.settingsSchema).toBeUndefined();
    expect(disabledPlugin.getStatus?.()).toEqual({
      status: 'disabled',
      detail: 'Disabled via plugin options',
    });
  });

  it('enforces admin RBAC, CSRF, write-only #44 secret hygiene, PDF artifact capability tokens, and HMAC webhooks', async () => {
    const siteConfig = makeSyntheticSiteConfig();
    const bundlePorts = createInMemoryServerPorts(siteConfig);
    await seedInMemoryRepo(bundlePorts);

    await bundlePorts.repository.upsertUser({
      email: 'admin@archive.example',
      display_name: 'Archive Admin',
      role: 'admin',
      added_by: 'system',
      added_at: '2026-11-27T10:00:00.000Z',
      last_login_at: '2026-11-27T10:00:00.000Z',
    });
    await bundlePorts.repository.upsertUser({
      email: 'editor@archive.example',
      display_name: 'Archive Editor',
      role: 'editor',
      added_by: 'system',
      added_at: '2026-11-27T10:00:00.000Z',
      last_login_at: '2026-11-27T10:00:00.000Z',
    });

    const bookPlugin = createBookPublishingServerPlugin({
      artifactSigningSecret: 'artifact-signing-secret-for-tests-32-chars',
    });

    const server = createKinloomServer({
      siteConfig,
      ports: { ...bundlePorts, plugins: [bookPlugin] },
      sessionSecret: SESSION_SECRET,
    });

    const adminCookie = await createSessionCookie({
      clock: bundlePorts.clock,
      email: 'admin@archive.example',
      role: 'admin',
      displayName: 'Archive Admin',
    });
    const editorCookie = await createSessionCookie({
      clock: bundlePorts.clock,
      email: 'editor@archive.example',
      role: 'editor',
      displayName: 'Archive Editor',
    });

    // 1. Anonymous & non-admin RBAC checks
    const anonRes = await server.fetch(new Request(`https://archive.example${BOOK_PUBLISHING_STATUS_ROUTE}`));
    expect(anonRes.status).toBe(401);

    const editorRes = await server.fetch(
      new Request(`https://archive.example${BOOK_PUBLISHING_STATUS_ROUTE}`, {
        headers: { cookie: editorCookie },
      })
    );
    expect(editorRes.status).toBe(403);

    // 2. Write-only #44 settingsSchema secret storage & zero plaintext leakage
    const saveSecretsRes = await server.fetch(
      new Request(`https://archive.example/api/admin/plugin-settings/${BOOK_PUBLISHING_PLUGIN_ID}`, {
        method: 'PUT',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          values: {
            publisher_provider: 'mock',
            environment: 'sandbox',
            contact_email: 'steward@archive.example',
          },
          secrets: {
            lulu_client_id: { action: 'set', value: 'SUPER_SECRET_LULU_CLIENT_ID_999' },
            lulu_client_secret: { action: 'set', value: 'SUPER_SECRET_LULU_CLIENT_SECRET_999' },
            lulu_webhook_secret: { action: 'set', value: 'SUPER_SECRET_WEBHOOK_KEY_999' },
          },
        }),
      })
    );
    expect(saveSecretsRes.status).toBe(200);
    const saveSettingsText = await saveSecretsRes.text();
    expect(saveSettingsText).not.toContain('SUPER_SECRET_LULU_CLIENT_ID_999');
    expect(saveSettingsText).not.toContain('SUPER_SECRET_LULU_CLIENT_SECRET_999');
    expect(saveSettingsText).not.toContain('SUPER_SECRET_WEBHOOK_KEY_999');

    const getSettingsRes = await server.fetch(
      new Request('https://archive.example/api/admin/plugin-settings', {
        headers: { cookie: adminCookie },
      })
    );
    expect(getSettingsRes.status).toBe(200);
    const getSettingsText = await getSettingsRes.text();
    expect(getSettingsText).not.toContain('SUPER_SECRET_LULU_CLIENT_ID_999');
    expect(getSettingsText).not.toContain('SUPER_SECRET_LULU_CLIENT_SECRET_999');
    expect(getSettingsText).not.toContain('SUPER_SECRET_WEBHOOK_KEY_999');
    expect(getSettingsText).toContain('lulu_client_id, lulu_client_secret, lulu_webhook_secret');

    // 3. Status endpoint reports readiness & excluded living counts
    const statusRes = await server.fetch(
      new Request(`https://archive.example${BOOK_PUBLISHING_STATUS_ROUTE}`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(statusRes.status).toBe(200);
    const statusJson = (await statusRes.json()) as {
      active_publisher: string;
      readiness: { included_people: number; excluded_living_people: number; estimated_pages: number };
    };
    expect(statusJson.active_publisher).toBe('mock');
    expect(statusJson.readiness.included_people).toBe(2);
    expect(statusJson.readiness.excluded_living_people).toBe(1);
    expect(statusJson.readiness.estimated_pages).toBe(24);

    // 4. CSRF rejection on POST compile without matching Origin
    const csrfBadRes = await server.fetch(
      new Request(`https://archive.example${BOOK_PUBLISHING_COMPILE_ROUTE}`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      })
    );
    expect(csrfBadRes.status).toBe(403);

    // 5. Compile book & download signed PDF artifacts; prove living person never leaks
    const compileRes = await server.fetch(
      new Request(`https://archive.example${BOOK_PUBLISHING_COMPILE_ROUTE}`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Alder Family Hardcover',
          trimPreset: 'us-letter-landscape',
          edition: 'public',
        }),
      })
    );
    expect(compileRes.status).toBe(200);
    const compileJson = (await compileRes.json()) as {
      report: { counts: { finalPageCount: number; excludedLivingPeople: number } };
      artifacts: { interior_pdf_url: string; cover_pdf_url: string };
      preview: { interior_html: string };
    };
    expect(compileJson.report.counts.finalPageCount).toBe(24);
    expect(compileJson.report.counts.excludedLivingPeople).toBe(1);
    expect(compileJson.preview.interior_html).not.toContain('Morgan SecretLiving Alder');

    const interiorPdfRes = await server.fetch(
      new Request(`https://archive.example${compileJson.artifacts.interior_pdf_url}`)
    );
    expect(interiorPdfRes.status).toBe(200);
    expect(interiorPdfRes.headers.get('content-type')).toBe('application/pdf');
    expect(interiorPdfRes.headers.get('cache-control')).toBe('no-store');
    const pdfInfo = inspectPdfPrepress(new Uint8Array(await interiorPdfRes.arrayBuffer()));
    expect(pdfInfo.validHeader).toBe(true);
    expect(pdfInfo.pageCount).toBe(24);
    expect(pdfInfo.rawText).not.toContain('Morgan SecretLiving Alder');

    const badArtifactRes = await server.fetch(
      new Request(`https://archive.example${BOOK_PUBLISHING_ARTIFACTS_ROUTE}/tampered.token`)
    );
    expect(badArtifactRes.status).toBe(401);

    // 6. Estimate cost
    const estimateRes = await server.fetch(
      new Request(`https://archive.example${BOOK_PUBLISHING_ESTIMATE_ROUTE}`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          interiorPageCount: 24,
          quantity: 2,
          shippingLevel: 'ground',
          shippingAddress: SAMPLE_ADDRESS,
        }),
      })
    );
    expect(estimateRes.status).toBe(200);
    const estimateJson = (await estimateRes.json()) as { quote: { totalCostCents: number } };
    expect(estimateJson.quote.totalCostCents).toBeGreaterThan(0);

    // 7. Submit print job & poll status
    const createJobRes = await server.fetch(
      new Request(`https://archive.example${BOOK_PUBLISHING_JOBS_ROUTE}`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: 'https://archive.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Alder Family Hardcover',
          quantity: 1,
          shippingLevel: 'ground',
          shippingAddress: SAMPLE_ADDRESS,
        }),
      })
    );
    expect(createJobRes.status).toBe(201);
    const createdJobJson = (await createJobRes.json()) as { job: { jobId: string; status: string } };
    expect(createdJobJson.job.jobId).toBe('mock-job-1');

    const getJobRes = await server.fetch(
      new Request(`https://archive.example${BOOK_PUBLISHING_JOBS_ROUTE}/${createdJobJson.job.jobId}`, {
        headers: { cookie: adminCookie },
      })
    );
    expect(getJobRes.status).toBe(200);

    // 8. Inbound Lulu webhook HMAC verification (reject invalid, accept valid & update job status)
    const webhookBody = new TextEncoder().encode(
      JSON.stringify({
        topic: 'PRINT_JOB_STATUS_CHANGED',
        data: {
          id: createdJobJson.job.jobId,
          status: { name: 'SHIPPED', message: 'Shipped via UPS' },
          line_items: [{ tracking_urls: ['https://track.example/alder-1'] }],
        },
      })
    );
    const badWebhookRes = await server.fetch(
      new Request(`https://archive.example${BOOK_PUBLISHING_WEBHOOK_LULU_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Lulu-HMAC-SHA256': '00'.repeat(32) },
        body: webhookBody,
      })
    );
    expect(badWebhookRes.status).toBe(401);

    const validSig = await signLuluWebhookHmacHex('SUPER_SECRET_WEBHOOK_KEY_999', webhookBody);
    const goodWebhookRes = await server.fetch(
      new Request(`https://archive.example${BOOK_PUBLISHING_WEBHOOK_LULU_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'Lulu-HMAC-SHA256': validSig },
        body: webhookBody,
      })
    );
    expect(goodWebhookRes.status).toBe(200);
    const webhookJson = (await goodWebhookRes.json()) as { accepted: boolean; status: string };
    expect(webhookJson.accepted).toBe(true);
    expect(webhookJson.status).toBe('shipped');
  });
});
