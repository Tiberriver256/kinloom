/** @vitest-environment jsdom */
import {
  type ArchiveBundle,
  compileArchive,
  type KinloomSiteConfig,
  parseKinloomConfig,
} from '@kinloom/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  type BookPublishingClient,
  createHttpBookPublishingClient,
} from '../adapters/bookPublishingClient.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import {
  formatBookByteSize,
  formatBookCurrencyCents,
  formatBookJobStatusLabel,
  parseUiBookCompileResponse,
  parseUiBookEstimateResponse,
  parseUiBookStatusResponse,
  parseUiBookSubmitJobResponse,
  type UiBookCompileResponse,
  type UiBookEstimateResponse,
  type UiBookPrintJob,
  type UiBookStatusResponse,
  validateUiShippingAddress,
} from '../lib/bookPublishingModel.js';
import { AdminSettingsShell } from '../pages/admin/AdminSettingsShell.js';
import { BOOK_PUBLISHING_UI_PLUGIN_ID, createBookPublishingPlugin } from './bookPublishingPlugin.js';
import { KinloomPluginProvider } from './PluginContext.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const siteConfig: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Archival Explorer',
    familyName: 'Alder Family',
    gedcomSourceName: 'ALDER_BOOK_UI_TEST',
  },
});

const { bundle: testBundle }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig,
  mode: 'private',
  people: [],
  places: [],
  events: [],
  sources: [],
  kinship: [],
  narratives: [],
});

const SAMPLE_STATUS: UiBookStatusResponse = {
  plugin_id: 'kinloom-book-publishing',
  active_publisher: 'mock',
  publisher_provider: 'mock',
  environment: 'sandbox',
  pdf_renderer: 'deterministic-pdf',
  lulu_credentials_configured: false,
  defaults: {
    trim_preset: 'us-letter-landscape',
    binding: 'hardcover-casewrap-glossy',
    paper_stock: '80lb-coated-white-color',
    shipping_level: 'ground',
    contact_email: 'steward@archive.example',
  },
  branches: [{ id: 'alder', label: 'Alder Branch' }],
  readiness: {
    included_people: 12,
    excluded_living_people: 3,
    included_media: 8,
    excluded_living_media: 2,
    estimated_pages: 24,
    spine_width_in: 0.25,
    allow_spine_text: false,
    provider_sku: '1100X0850.FC.PRE.CW.080CW444.GXX',
    review_flags_detected: 1,
  },
  jobs: [],
};

const SAMPLE_COMPILED: UiBookCompileResponse = {
  renderer: 'deterministic-pdf',
  report: {
    title: 'Alder Family Hardcover',
    subtitle: 'Archival Volume',
    edition: 'public',
    colophonNotice: 'Public Archival Edition. Living relatives and private living media redacted.',
    counts: {
      includedPeople: 12,
      excludedLivingPeople: 3,
      includedMedia: 8,
      excludedLivingMedia: 2,
      rawContentPages: 20,
      paddingPages: 4,
      finalPageCount: 24,
    },
    coverDimensions: {
      totalWidthIn: 23.75,
      totalHeightIn: 10.0,
      spineWidthIn: 0.25,
      allowSpineText: false,
      providerSku: '1100X0850.FC.PRE.CW.080CW444.GXX',
    },
    warnings: [],
  },
  artifacts: {
    interior_pdf_url: '/api/plugins/book-publishing/artifacts/tok-int',
    cover_pdf_url: '/api/plugins/book-publishing/artifacts/tok-cov',
    interior_bytes: 28_672,
    cover_bytes: 8_192,
    expires_at: '2026-11-27T14:00:00.000Z',
  },
};

const SAMPLE_ESTIMATE: UiBookEstimateResponse = {
  quote: {
    providerId: 'mock',
    providerSku: '1100X0850.FC.PRE.CW.080CW444.GXX',
    currency: 'USD',
    manufacturingCostCents: 1786,
    shippingCostCents: 1199,
    fulfillmentFeeCents: 150,
    taxCents: 219,
    totalCostCents: 3354,
    sandbox: true,
  },
  cover_dimensions: {
    totalWidthIn: 23.75,
    totalHeightIn: 10.0,
    spineWidthIn: 0.25,
    allowSpineText: false,
    providerSku: '1100X0850.FC.PRE.CW.080CW444.GXX',
  },
};

const SAMPLE_JOB: UiBookPrintJob = {
  providerId: 'mock',
  jobId: 'mock-job-1',
  externalId: 'kinloom-book-1',
  title: 'Alder Family Hardcover',
  status: 'ready_for_production',
  trackingUrls: [],
  sandbox: true,
  quantity: 1,
  updatedAt: '2026-11-27T12:00:00.000Z',
};

function setNativeInputValue(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string
): void {
  const proto = Object.getPrototypeOf(el) as { value?: unknown };
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc?.set) {
    desc.set.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function mountAdminShell(params: {
  readonly canManageSite: boolean;
  readonly client?: BookPublishingClient;
  readonly includePlugin?: boolean;
}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const plugins =
    params.includePlugin === false ? [] : [createBookPublishingPlugin({ client: params.client })];

  await act(async () => {
    root.render(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={siteConfig}
          initialBundle={testBundle}
          capabilities={{
            canEdit: params.canManageSite,
            canManageSite: params.canManageSite,
            canUploadMedia: params.canManageSite,
          }}
        >
          <KinloomPluginProvider plugins={plugins}>
            <AdminSettingsShell
              diagnostics={null}
              diagnosticsLoading={false}
              diagnosticsError={null}
              diagnosticsSupported={false}
              onRefreshDiagnostics={async () => {}}
            />
          </KinloomPluginProvider>
        </ArchiveProvider>
      </MemoryRouter>
    );
  });
  await act(async () => {
    await Promise.resolve();
  });

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('bookPublishingModel pure helpers and HTTP adapter', () => {
  it('formats currency, byte sizes, statuses, and validates shipping addresses', () => {
    expect(formatBookCurrencyCents(3354, 'USD')).toBe('$33.54');
    expect(formatBookCurrencyCents(1250, 'EUR')).toBe('12.50 EUR');
    expect(formatBookByteSize(512)).toBe('512 B');
    expect(formatBookByteSize(28_672)).toBe('28.0 KB');
    expect(formatBookByteSize(2 * 1024 * 1024)).toBe('2.00 MB');

    expect(formatBookJobStatusLabel('created')).toBe('Created');
    expect(formatBookJobStatusLabel('validating')).toBe('Validating PDFs');
    expect(formatBookJobStatusLabel('ready_for_production')).toBe('Ready for Print');
    expect(formatBookJobStatusLabel('in_production')).toBe('In Production');
    expect(formatBookJobStatusLabel('shipped')).toBe('Shipped');
    expect(formatBookJobStatusLabel('rejected')).toBe('Rejected');
    expect(formatBookJobStatusLabel('canceled')).toBe('Canceled');
    expect(formatBookJobStatusLabel('custom')).toBe('custom');

    expect(
      validateUiShippingAddress({
        name: '',
        street1: '1 Main',
        city: 'City',
        countryCode: 'US',
        postalCode: '12345',
        phoneNumber: '5551234',
      })
    ).toContain('Recipient name');
    expect(
      validateUiShippingAddress({
        name: 'Rowan',
        street1: '1 Main',
        city: 'City',
        countryCode: 'USA',
        postalCode: '12345',
        phoneNumber: '5551234',
      })
    ).toContain('2-letter ISO');
    expect(
      validateUiShippingAddress({
        name: 'Rowan',
        street1: '1 Main',
        city: 'City',
        countryCode: 'US',
        postalCode: '12345',
        phoneNumber: '5551234',
      })
    ).toBeNull();

    expect(() => parseUiBookStatusResponse({})).toThrow(/Malformed/);
    expect(() => parseUiBookCompileResponse({})).toThrow(/Malformed/);
    expect(() => parseUiBookEstimateResponse({})).toThrow(/Malformed/);
    expect(() => parseUiBookSubmitJobResponse({})).toThrow(/Malformed/);
  });

  it('routes all book-publishing HTTP calls through createHttpBookPublishingClient and handles 404/errors', async () => {
    const client = createHttpBookPublishingClient({
      apiBaseUrl: 'https://archive.example',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/status')) {
          return new Response(JSON.stringify(SAMPLE_STATUS), { status: 200 });
        }
        if (url.endsWith('/compile')) {
          return new Response(JSON.stringify(SAMPLE_COMPILED), { status: 200 });
        }
        if (url.endsWith('/estimate')) {
          return new Response(JSON.stringify(SAMPLE_ESTIMATE), { status: 200 });
        }
        if (url.endsWith('/jobs')) {
          return new Response(JSON.stringify({ job: SAMPLE_JOB }), { status: 201 });
        }
        if (url.endsWith('/jobs/mock-job-1')) {
          return new Response(JSON.stringify({ job: { ...SAMPLE_JOB, status: 'shipped' } }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      },
    });

    expect((await client.getStatus())?.active_publisher).toBe('mock');
    expect(
      (
        await client.compileBook({
          trimPreset: 'us-letter-landscape',
          binding: 'hardcover-casewrap-glossy',
          paperStock: '80lb-coated-white-color',
          edition: 'public',
        })
      ).report.counts.finalPageCount
    ).toBe(24);
    expect(
      (
        await client.estimateCost({
          trimPreset: 'us-letter-landscape',
          binding: 'hardcover-casewrap-glossy',
          paperStock: '80lb-coated-white-color',
          interiorPageCount: 24,
          quantity: 1,
          shippingLevel: 'ground',
          shippingAddress: {
            name: 'Rowan',
            street1: '100 Main',
            city: 'Springfield',
            countryCode: 'US',
            postalCode: '62701',
            phoneNumber: '+15555550100',
          },
        })
      ).quote.totalCostCents
    ).toBe(3354);
    expect(
      (
        await client.submitPrintJob({
          trimPreset: 'us-letter-landscape',
          binding: 'hardcover-casewrap-glossy',
          paperStock: '80lb-coated-white-color',
          edition: 'public',
          quantity: 1,
          shippingLevel: 'ground',
          shippingAddress: {
            name: 'Rowan',
            street1: '100 Main',
            city: 'Springfield',
            countryCode: 'US',
            postalCode: '62701',
            phoneNumber: '+15555550100',
          },
        })
      ).job.jobId
    ).toBe('mock-job-1');
    expect((await client.getJobStatus('mock-job-1')).status).toBe('shipped');

    const disabledClient = createHttpBookPublishingClient({
      fetchImpl: async () => new Response('not found', { status: 404 }),
    });
    expect(await disabledClient.getStatus()).toBeNull();
  });
});

describe('createBookPublishingPlugin Admin UI isolation and interactive flows', () => {
  it('stays off by default, supports enabled:false, and renders nothing for non-admins', async () => {
    const disabled = createBookPublishingPlugin({ enabled: false });
    expect(disabled.id).toBe(BOOK_PUBLISHING_UI_PLUGIN_ID);
    expect(disabled.status).toBe('disabled');
    expect(disabled.slots).toBeUndefined();

    const withoutPlugin = await mountAdminShell({ canManageSite: true, includePlugin: false });
    expect(withoutPlugin.container.querySelector('[data-testid="admin-book-publishing-panel"]')).toBeNull();
    await withoutPlugin.unmount();

    const fakeClient: BookPublishingClient = {
      getStatus: async () => SAMPLE_STATUS,
      compileBook: async () => SAMPLE_COMPILED,
      estimateCost: async () => SAMPLE_ESTIMATE,
      submitPrintJob: async () => ({ job: SAMPLE_JOB }),
      getJobStatus: async () => SAMPLE_JOB,
    };

    const nonAdmin = await mountAdminShell({ canManageSite: false, client: fakeClient });
    expect(nonAdmin.container.querySelector('[data-testid="admin-book-publishing-panel"]')).toBeNull();
    await nonAdmin.unmount();
  });

  it('runs compile, private-edition guard, cost estimation, sandbox print submission, and job status refresh for admins', async () => {
    let refreshedCount = 0;
    const fakeClient: BookPublishingClient = {
      getStatus: async () => SAMPLE_STATUS,
      compileBook: async () => SAMPLE_COMPILED,
      estimateCost: async () => SAMPLE_ESTIMATE,
      submitPrintJob: async () => ({ job: SAMPLE_JOB }),
      getJobStatus: async () => {
        refreshedCount += 1;
        return { ...SAMPLE_JOB, status: 'shipped', trackingUrls: ['https://track.example/1'] };
      },
    };

    const mounted = await mountAdminShell({ canManageSite: true, client: fakeClient });
    const { container } = mounted;

    expect(container.querySelector('[data-testid="bp-active-publisher"]')?.textContent).toBe('mock');
    expect(container.querySelector('[data-testid="bp-included-people"]')?.textContent).toContain('12 people');

    // Compile book
    const compileBtn = container.querySelector('[data-testid="bp-compile-btn"]') as HTMLButtonElement;
    await act(async () => {
      compileBtn.click();
    });
    expect(container.querySelector('[data-testid="bp-compiled-preview"]')?.textContent).toContain('24 pages');
    expect(container.querySelector('[data-testid="bp-download-interior"]')?.getAttribute('href')).toBe(
      '/api/plugins/book-publishing/artifacts/tok-int'
    );

    // Fill shipping address & estimate cost
    const textInputs = Array.from(
      container.querySelectorAll('input[type="text"], input[type="tel"]')
    ) as HTMLInputElement[];
    // Fields order: title, subtitle, recipientName, street1, city, state, postal, country, phone
    const recipientInput = textInputs[2];
    const streetInput = textInputs[3];
    const cityInput = textInputs[4];
    const postalInput = textInputs[6];
    const phoneInput = textInputs[8];
    await act(async () => {
      setNativeInputValue(recipientInput, 'Rowan Alder');
      setNativeInputValue(streetInput, '100 Main St');
      setNativeInputValue(cityInput, 'Springfield');
      setNativeInputValue(postalInput, '62701');
      setNativeInputValue(phoneInput, '+15555550100');
    });

    const estimateBtn = container.querySelector('[data-testid="bp-estimate-btn"]') as HTMLButtonElement;
    await act(async () => {
      estimateBtn.click();
    });
    expect(container.querySelector('[data-testid="bp-quote-total"]')?.textContent).toBe('$33.54');

    // Submit sandbox job & refresh status
    const submitBtn = container.querySelector('[data-testid="bp-submit-job-btn"]') as HTMLButtonElement;
    await act(async () => {
      submitBtn.click();
    });
    expect(container.querySelector('[data-testid="bp-job-mock-job-1"]')?.textContent).toContain(
      'Ready for Print'
    );

    const refreshJobBtn = container.querySelector(
      '[data-testid="bp-job-mock-job-1"] button'
    ) as HTMLButtonElement;
    await act(async () => {
      refreshJobBtn.click();
    });
    expect(refreshedCount).toBe(1);
    expect(container.querySelector('[data-testid="bp-job-mock-job-1"]')?.textContent).toContain('Shipped');

    // Switch to private edition without confirming checkbox -> shows error feedback
    const selects = Array.from(container.querySelectorAll('select')) as HTMLSelectElement[];
    const editionSelect = selects[4]; // trim, binding, paper, branch, edition
    await act(async () => {
      setNativeInputValue(editionSelect, 'private');
    });
    await act(async () => {
      compileBtn.click();
    });
    expect(container.querySelector('[data-testid="bp-feedback"]')?.textContent).toContain(
      'Private Family Edition'
    );

    await mounted.unmount();
  });

  it('shows disabled banner when server endpoints return 404 and gates production confirmation', async () => {
    const disabledClient: BookPublishingClient = {
      getStatus: async () => null,
      compileBook: async () => SAMPLE_COMPILED,
      estimateCost: async () => SAMPLE_ESTIMATE,
      submitPrintJob: async () => ({ job: SAMPLE_JOB }),
      getJobStatus: async () => SAMPLE_JOB,
    };
    const disabledMounted = await mountAdminShell({ canManageSite: true, client: disabledClient });
    expect(disabledMounted.container.querySelector('[data-testid="bp-disabled-banner"]')).not.toBeNull();
    await disabledMounted.unmount();

    const prodClient: BookPublishingClient = {
      getStatus: async () => ({
        ...SAMPLE_STATUS,
        active_publisher: 'lulu-production',
        publisher_provider: 'lulu',
        environment: 'production',
        lulu_credentials_configured: true,
      }),
      compileBook: async () => SAMPLE_COMPILED,
      estimateCost: async () => SAMPLE_ESTIMATE,
      submitPrintJob: async () => ({ job: { ...SAMPLE_JOB, sandbox: false } }),
      getJobStatus: async () => SAMPLE_JOB,
    };
    const prodMounted = await mountAdminShell({ canManageSite: true, client: prodClient });
    const submitBtn = prodMounted.container.querySelector(
      '[data-testid="bp-submit-job-btn"]'
    ) as HTMLButtonElement;
    expect(submitBtn.textContent).toBe('Submit Paid Print Order');
    await act(async () => {
      submitBtn.click();
    });
    expect(prodMounted.container.querySelector('[data-testid="bp-feedback"]')?.textContent).toContain(
      'paid production print order'
    );
    await prodMounted.unmount();
  });
});
