import { type ArchiveBundle, compileArchive, type KinloomSiteConfig } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { compileArchivalBook, renderBookCoverHtml } from './compiler.js';
import { computeCoverDimensionsOffline, resolveLuluPodPackageId } from './geometry.js';
import {
  createLuluBookPublisherAdapter,
  createMockBookPublisherAdapter,
  mapLuluStatusToBookPrintJobStatus,
  parseDecimalDollarsToCents,
  signLuluWebhookHmacHex,
  verifyLuluWebhookHmac,
} from './publishers.js';
import type { BookPhysicalSpec, BookShippingAddress } from './types.js';

const SAMPLE_SPEC: BookPhysicalSpec = {
  trimPreset: 'us-letter-landscape',
  binding: 'hardcover-casewrap-glossy',
  paperStock: '80lb-coated-white-color',
  interiorPageCount: 48,
};

const SAMPLE_ADDRESS: BookShippingAddress = {
  name: 'Rowan Mercer',
  street1: '100 Archival Way',
  street2: 'Suite 4B',
  city: 'Madison',
  stateCode: 'WI',
  countryCode: 'US',
  postalCode: '53703',
  phoneNumber: '+15555550101',
};

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('bookPublishing publishers behavioral contracts', () => {
  it('parses decimal dollar strings and numbers into exact integer cents', () => {
    expect(parseDecimalDollarsToCents(null)).toBe(0);
    expect(parseDecimalDollarsToCents(undefined)).toBe(0);
    expect(parseDecimalDollarsToCents('   ')).toBe(0);
    expect(parseDecimalDollarsToCents(19.99)).toBe(1999);
    expect(parseDecimalDollarsToCents('-4.25')).toBe(-425);
    expect(parseDecimalDollarsToCents('12.345')).toBe(1235);
    expect(parseDecimalDollarsToCents('12.344')).toBe(1234);
    expect(() => parseDecimalDollarsToCents('$12.00')).toThrow(RangeError);
  });

  it('maps every Lulu print-job lifecycle status into canonical Kinloom statuses', () => {
    expect(mapLuluStatusToBookPrintJobStatus('CREATED')).toBe('created');
    expect(mapLuluStatusToBookPrintJobStatus('UNPAID')).toBe('created');
    expect(mapLuluStatusToBookPrintJobStatus('PAYMENT_IN_PROGRESS')).toBe('created');
    expect(mapLuluStatusToBookPrintJobStatus('VALIDATING')).toBe('validating');
    expect(mapLuluStatusToBookPrintJobStatus('NORMALIZING')).toBe('validating');
    expect(mapLuluStatusToBookPrintJobStatus('PRODUCTION_READY')).toBe('ready_for_production');
    expect(mapLuluStatusToBookPrintJobStatus('PRODUCTION_DELAYED')).toBe('ready_for_production');
    expect(mapLuluStatusToBookPrintJobStatus('IN_PRODUCTION')).toBe('in_production');
    expect(mapLuluStatusToBookPrintJobStatus('SHIPPED')).toBe('shipped');
    expect(mapLuluStatusToBookPrintJobStatus('REJECTED')).toBe('rejected');
    expect(mapLuluStatusToBookPrintJobStatus('ERROR')).toBe('rejected');
    expect(mapLuluStatusToBookPrintJobStatus('CANCELED')).toBe('canceled');
    expect(mapLuluStatusToBookPrintJobStatus('CANCELLED')).toBe('canceled');
    expect(mapLuluStatusToBookPrintJobStatus('UNKNOWN_FUTURE_STATE')).toBe('created');
  });

  it('verifies Lulu webhook HMAC-SHA256 signatures in hex and base64 and rejects invalid inputs', async () => {
    const secret = 'lulu-webhook-secret-test';
    const rawBody = new TextEncoder().encode('{"event":"PRINT_JOB_STATUS_CHANGED"}');
    const hexSig = await signLuluWebhookHmacHex(secret, rawBody);

    expect(await verifyLuluWebhookHmac('', rawBody, hexSig)).toBe(false);
    expect(await verifyLuluWebhookHmac(secret, rawBody, null)).toBe(false);
    expect(await verifyLuluWebhookHmac(secret, rawBody, 'not-valid-hex-or-base64!!!')).toBe(false);
    expect(await verifyLuluWebhookHmac(secret, rawBody, 'abcd')).toBe(false);
    expect(await verifyLuluWebhookHmac(secret, rawBody, hexSig)).toBe(true);

    // Convert hexSig to base64 and verify base64 path
    const bytes = new Uint8Array(hexSig.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(hexSig.slice(i * 2, i * 2 + 2), 16);
    }
    const base64Sig = btoa(String.fromCharCode(...bytes));
    expect(await verifyLuluWebhookHmac(secret, rawBody, base64Sig)).toBe(true);

    const tampered = new TextEncoder().encode('{"event":"TAMPERED"}');
    expect(await verifyLuluWebhookHmac(secret, tampered, hexSig)).toBe(false);
  });

  it('exercises Lulu adapter OAuth caching, 401 refresh, quotes, validation, print jobs, and errors', async () => {
    let tokenCalls = 0;
    let force401Once = true;
    let now = 1_700_000_000_000;

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/openid-connect/token')) {
        tokenCalls += 1;
        return makeJsonResponse({ access_token: `tok-${tokenCalls}`, expires_in: 3600 });
      }
      if (url.endsWith('/cover-dimensions/')) {
        if (force401Once) {
          force401Once = false;
          return new Response('expired', { status: 401 });
        }
        return makeJsonResponse({ width: '23.75', height: '10.25', unit: 'inch' });
      }
      if (url.endsWith('/print-job-cost-calculations/')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { shipping_option?: string };
        if (body.shipping_option === 'MAIL') {
          return makeJsonResponse({
            currency: 'USD',
            line_item_costs: [{ total_cost_excl_tax: '24.50' }],
            shipping_cost: { total_cost_excl_tax: '6.00' },
            fulfillment_cost: { total_cost_excl_tax: '1.50' },
            total_tax: '2.00',
          });
        }
        return makeJsonResponse({
          currency: 'USD',
          line_item_costs: [{ total_cost_excl_tax: '24.50' }],
          shipping_cost: { total_cost_excl_tax: '10.00' },
          fulfillment_cost: { total_cost_excl_tax: '1.50' },
          total_tax: '2.50',
          total_cost_incl_tax: '38.50',
        });
      }
      if (url.endsWith('/validate-interior/')) {
        return makeJsonResponse({ id: 101, status: 'VALIDATED', errors: [], warnings: ['minor'] });
      }
      if (url.endsWith('/validate-cover/')) {
        return makeJsonResponse({ id: 'cov-202', status: 'VALIDATING', errors: [], warnings: [] });
      }
      if (url.endsWith('/print-jobs/')) {
        return makeJsonResponse({
          id: 9001,
          external_id: 'ext-1',
          status: { name: 'PRODUCTION_READY', message: 'Queued for press' },
          line_items: [
            { title: 'Mercer Chronicle', quantity: 2, tracking_urls: ['https://track.example/1'] },
          ],
        });
      }
      if (url.includes('/print-jobs/9001/')) {
        return makeJsonResponse({
          id: '9001',
          external_id: 'ext-1',
          status: 'SHIPPED',
          line_items: [],
          date_modified: '2026-11-27T12:00:00Z',
        });
      }
      return new Response('not found', { status: 404 });
    };

    const adapter = createLuluBookPublisherAdapter({
      environment: 'production',
      clientId: 'cid',
      clientSecret: 'csec',
      webhookSecret: 'whsec',
      fetchImpl: fakeFetch,
      nowMs: () => now,
    });

    expect(adapter.id).toBe('lulu-production');
    expect(adapter.sandbox).toBe(false);
    expect(adapter.resolveProviderSku(SAMPLE_SPEC)).toBe(resolveLuluPodPackageId(SAMPLE_SPEC));

    // Cover dimensions triggers initial token + 401 refresh -> 2 token calls
    const dims = await adapter.getCoverDimensions(SAMPLE_SPEC);
    expect(dims.source).toBe('provider_api');
    expect(dims.totalWidthIn).toBe(23.75);
    expect(tokenCalls).toBe(2);

    // Subsequent calls reuse cached token across shipping levels
    for (const shippingLevel of ['mail', 'ground', 'expedited', 'express'] as const) {
      const quote = await adapter.estimateCost({
        spec: SAMPLE_SPEC,
        quantity: 1,
        shippingAddress: SAMPLE_ADDRESS,
        shippingLevel,
      });
      expect(quote.totalCostCents).toBeGreaterThan(0);
    }
    expect(tokenCalls).toBe(2);

    const validation = await adapter.validateInteriorAndCover({
      spec: SAMPLE_SPEC,
      interiorPdfUrl: 'https://example.test/interior.pdf',
      coverPdfUrl: 'https://example.test/cover.pdf',
    });
    expect(validation.interior.ok).toBe(true);
    expect(validation.interior.status).toBe('validated');
    expect(validation.cover.ok).toBe(true);
    expect(validation.cover.status).toBe('validating');

    const created = await adapter.createPrintJob({
      externalId: 'ext-1',
      title: 'Mercer Chronicle',
      contactEmail: 'steward@example.test',
      spec: SAMPLE_SPEC,
      quantity: 2,
      interiorPdfUrl: 'https://example.test/interior.pdf',
      coverPdfUrl: 'https://example.test/cover.pdf',
      shippingAddress: SAMPLE_ADDRESS,
      shippingLevel: 'ground',
    });
    expect(created.status).toBe('ready_for_production');
    expect(created.statusDetail).toBe('Queued for press');
    expect(created.trackingUrls).toEqual(['https://track.example/1']);

    const status = await adapter.getPrintJobStatus('9001');
    expect(status.status).toBe('shipped');
    expect(status.title).toBe('Archival Hardcover Book');

    const rawWebhook = new TextEncoder().encode('{"ok":true}');
    const sig = await signLuluWebhookHmacHex('whsec', rawWebhook);
    expect(await adapter.verifyWebhookSignature?.(rawWebhook, new Headers({ 'Lulu-HMAC-SHA256': sig }))).toBe(
      true
    );

    // Advance time past expiry and verify error handling on failed token & API responses
    now += 4_000_000;
    const failingTokenAdapter = createLuluBookPublisherAdapter({
      environment: 'sandbox',
      clientId: 'cid',
      clientSecret: 'bad',
      fetchImpl: async () => new Response('unauthorized', { status: 403 }),
    });
    await expect(failingTokenAdapter.getPrintJobStatus('9001')).rejects.toThrow(/OAuth token request failed/);

    const failingApiAdapter = createLuluBookPublisherAdapter({
      environment: 'sandbox',
      clientId: 'cid',
      clientSecret: 'csec',
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/openid-connect/token')) {
          return makeJsonResponse({ access_token: 'tok-ok', expires_in: 3600 });
        }
        return new Response('bad request', { status: 400 });
      },
    });
    await expect(failingApiAdapter.getPrintJobStatus('9001')).rejects.toThrow(/Lulu API GET/);
  });

  it('exercises mock publisher adapter edge cases (non-US tax, 60lb paper, empty URLs, missing job, webhook)', async () => {
    const mock = createMockBookPublisherAdapter({ webhookSecret: 'mock-secret' });
    expect(mock.resolveProviderSku(SAMPLE_SPEC)).toBe(resolveLuluPodPackageId(SAMPLE_SPEC));

    const intlQuote = await mock.estimateCost({
      spec: { ...SAMPLE_SPEC, paperStock: '60lb-uncoated-white-color' },
      quantity: 2,
      shippingAddress: { ...SAMPLE_ADDRESS, countryCode: 'CA', stateCode: 'ON' },
      shippingLevel: 'express',
    });
    expect(intlQuote.taxCents).toBe(0);

    const invalidUrls = await mock.validateInteriorAndCover({
      spec: SAMPLE_SPEC,
      interiorPdfUrl: '   ',
      coverPdfUrl: '',
    });
    expect(invalidUrls.interior.ok).toBe(false);
    expect(invalidUrls.cover.ok).toBe(false);

    await expect(mock.getPrintJobStatus('nonexistent-job')).rejects.toThrow(/was not found/);

    const payload = new TextEncoder().encode('{"job":"mock-job-1"}');
    const sig = await signLuluWebhookHmacHex('mock-secret', payload);
    expect(await mock.verifyWebhookSignature?.(payload, new Headers({ 'lulu-hmac-sha256': sig }))).toBe(true);
  });
});

describe('compileArchivalBook behavioral options and scoping', () => {
  it('supports branch/root scoping, dedication, DPI warnings, narratives, plates, and spine text cover', () => {
    const siteConfig: KinloomSiteConfig = {
      schemaVersion: 1,
      site: {
        title: 'Mercer & Alder Archive',
        familyName: 'Mercer Family',
        gedcomSourceName: 'MERCER_TEST',
      },
      privacy: {
        livingCutoffYears: 101,
        referenceYear: 2026,
      },
      branches: [
        {
          id: 'alder-branch',
          label: 'Alder Branch',
          lineageGroups: ['alder'],
          surnames: ['Alder'],
        },
      ],
      lineageSections: [
        {
          id: 'founders',
          title: 'Founding Generation',
          subtitle: 'Early settlers',
          lineageGroups: ['direct'],
          branchId: 'alder-branch',
        },
      ],
      migrationEras: [],
    } as unknown as KinloomSiteConfig;

    const { bundle } = compileArchive({
      people: [
        {
          id: 'p-root',
          slug: 'arthur-mercer',
          full_name: 'Arthur Mercer',
          given_name: 'Arthur',
          surname: 'Mercer',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'direct',
          branch: 'alder-branch',
          birth_edtf: '1810',
          death_edtf: '1880',
          portrait_url: null,
        },
        {
          id: 'p-child',
          slug: 'clara-alder',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          alt_names: [],
          sex: 'F',
          is_living: false,
          lineage_group: 'collateral',
          birth_edtf: '1842',
          death_edtf: '1915',
          portrait_url: null,
        },
        {
          id: 'p-other',
          slug: 'julian-vance',
          full_name: 'Julian Vance',
          given_name: 'Julian',
          surname: 'Vance',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'extended',
          birth_edtf: '1850',
          death_edtf: '1920',
          portrait_url: null,
        },
      ],
      events: [
        {
          id: 'ev-1',
          title: 'Mill Founding',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '1845',
          place_id: 'pl-1',
          summary: 'Arthur Mercer established a timber mill near Oak Ridge.',
          participants: [{ person_id: 'p-root', role: 'subject' }],
          sources: [{ source_id: 'src-1', confidence: 'high' }],
        },
      ],
      places: [
        {
          id: 'pl-1',
          slug: 'oak-ridge',
          name: 'Oak Ridge',
          full_name: 'Oak Ridge, Wisconsin',
          place_type: 'town',
          parent_id: null,
          lat: 43.0731,
          lng: -89.4012,
          summary: 'River crossing settlement.',
        },
      ],
      sources: [
        {
          id: 'src-1',
          citation: '1850 Wisconsin Territorial Census.',
          source_type: 'census',
          author: 'Territorial Clerk',
          repository: 'State Archives',
        },
      ],
      kinship: [
        { from: 'p-root', to: 'p-child', relation: 'parent' },
        { from: 'p-child', to: 'p-root', relation: 'child' },
      ],
      media: [
        {
          id: 'med-low',
          kind: 'document_scan',
          person_id: 'p-root',
          file: 'media/low-scan.jpg',
          caption: 'Low resolution deed scan',
          date_edtf: '1845',
          provenance: 'Family trunk',
        },
        {
          id: 'med-warn',
          kind: 'portrait',
          person_id: 'p-child',
          file: 'media/med-scan.jpg',
          caption: 'Medium resolution portrait',
        },
      ],
      narratives: [
        {
          id: 'nar-1',
          slug: 'mill-story',
          title: 'The Timber Mill Years',
          subject_person_id: 'p-root',
          person_ids: ['p-root'],
          place_ids: ['pl-1'],
          event_ids: ['ev-1'],
          source_ids: ['src-1', 'src-missing'],
          body_md: '# Timber Mill\n\nArthur built the **mill** along the [river](https://example.test).',
        },
      ],
      siteConfig,
      mode: 'private',
      generatedAt: '2026-11-27T12:00:00.000Z',
      referenceYear: 2026,
    });

    const bundleWithMedia: ArchiveBundle = {
      ...bundle,
      media: [
        {
          id: 'med-low',
          kind: 'document_scan',
          person_id: 'p-root',
          file: 'media/low-scan.jpg',
          caption: 'Low resolution deed scan',
          date_edtf: '1845',
          provenance: 'Family trunk',
        },
        {
          id: 'med-warn',
          kind: 'portrait',
          person_id: 'p-child',
          file: 'media/med-scan.jpg',
          caption: 'Medium resolution portrait',
        },
      ],
    };

    const compiled = compileArchivalBook({
      bundle: bundleWithMedia,
      siteConfig,
      options: {
        title: 'Custom Mercer Folio',
        subtitle: 'Annotated Lineage',
        dedication: 'For the archivists who preserved every ledger and photograph across generations.',
        branchId: 'alder-branch',
        rootPersonId: 'p-child',
        proofMarks: true,
        imageDimensionsByFile: {
          'media/low-scan.jpg': { widthPx: 400, heightPx: 300 },
          'media/med-scan.jpg': { widthPx: 1100, heightPx: 800 },
        },
      },
    });

    // Branch + ancestor scoping includes Arthur & Clara and excludes unrelated Julian Vance
    expect(compiled.report.counts.includedPeople).toBe(2);
    expect(compiled.report.warnings.some((w) => w.code === 'low_resolution_image')).toBe(true);
    expect(compiled.report.warnings.some((w) => w.code === 'medium_resolution_image')).toBe(true);
    expect(compiled.pages.some((p) => p.kind === 'dedication')).toBe(true);
    expect(compiled.pages.some((p) => p.kind === 'photo-plate')).toBe(true);
    expect(compiled.interiorHtml).toContain('Custom Mercer Folio');
    expect(compiled.interiorHtml).toContain('outline: 1px dashed');

    // Verify thick-book cover renders spine text and proof marks
    const thickSpec: BookPhysicalSpec = { ...SAMPLE_SPEC, interiorPageCount: 120 };
    const thickCoverDims = computeCoverDimensionsOffline(thickSpec, resolveLuluPodPackageId(thickSpec));
    const thickCoverHtml = renderBookCoverHtml({
      title: 'Custom Mercer Folio',
      subtitle: 'Annotated Lineage',
      familyName: 'Mercer Family',
      colophonNotice: 'Archival Edition',
      coverDimensions: thickCoverDims,
      accentColor: '#7A4612',
      proofMarks: true,
    });
    expect(thickCoverHtml).toContain('data-spine-text="enabled"');
  });
});

describe('compileArchivalBook empty-archive and private-edition fallbacks', () => {
  it('handles empty events/places/sources, no-surname person, private edition with review flags, and thin cover without spine text', () => {
    const siteConfig: KinloomSiteConfig = {
      schemaVersion: 1,
      site: {
        title: 'Minimal Archive',
        familyName: 'Linden Family',
        gedcomSourceName: 'LINDEN_TEST',
      },
      privacy: {
        livingCutoffYears: 101,
        referenceYear: 2026,
      },
      branches: [],
      lineageSections: [],
      migrationEras: [],
    } as unknown as KinloomSiteConfig;

    const { bundle } = compileArchive({
      people: [
        {
          id: 'p-nosurname',
          slug: 'mononym-linden',
          full_name: 'Mononym',
          given_name: 'Mononym',
          surname: '',
          alt_names: [],
          sex: 'U',
          is_living: false,
          lineage_group: 'direct',
          birth_edtf: '',
          death_edtf: '',
          portrait_url: null,
        },
        {
          id: 'p-living-linden',
          slug: 'quinn-linden',
          full_name: 'Quinn Linden',
          given_name: 'Quinn',
          surname: 'Linden',
          alt_names: [],
          sex: 'X',
          is_living: true,
          lineage_group: 'direct',
          birth_edtf: '1992',
          death_edtf: '',
          portrait_url: null,
        },
      ],
      events: [],
      places: [],
      sources: [],
      kinship: [],
      media: [],
      narratives: [],
      siteConfig,
      mode: 'private',
      generatedAt: '2026-11-27T12:00:00.000Z',
      referenceYear: 2026,
    });

    const compiled = compileArchivalBook({
      bundle,
      siteConfig,
      options: {
        edition: 'private',
        includeLiving: true,
        allowLivingPortraits: true,
        acknowledgeReviewFlags: true,
        proofMarks: false,
      },
    });

    expect(compiled.report.edition).toBe('private');
    expect(compiled.report.counts.includedPeople).toBe(2);
    expect(compiled.interiorHtml).toContain('No chronological family milestones recorded');
    expect(compiled.interiorHtml).toContain('No places documented in this archive scope');
    expect(compiled.interiorHtml).toContain('No archival sources recorded');
    expect(compiled.coverHtml).toContain('Spine text intentionally omitted');

    // Empty scope (unmatched branch) exercises empty index & zero-people fallback
    const emptyScoped = compileArchivalBook({
      bundle,
      siteConfig,
      options: {
        branchId: 'nonexistent-branch',
      },
    });
    expect(emptyScoped.report.counts.includedPeople).toBe(0);
    expect(emptyScoped.interiorHtml).toContain('No indexed entries.');
  });
});
