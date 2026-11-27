import type { CompiledBookDocument, CoverDimensionsResult, PdfRendererPort } from '@kinloom/server';

export interface PlaywrightPdfPageHandle {
  setContent(
    html: string,
    options?: { readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' }
  ): Promise<void>;
  pdf(options: {
    readonly preferCSSPageSize: boolean;
    readonly printBackground: boolean;
    readonly width: string;
    readonly height: string;
    readonly margin: {
      readonly top: string;
      readonly right: string;
      readonly bottom: string;
      readonly left: string;
    };
  }): Promise<Uint8Array | Buffer>;
  close(): Promise<void>;
}

export interface PlaywrightPdfBrowserHandle {
  newPage(): Promise<PlaywrightPdfPageHandle>;
  close(): Promise<void>;
}

export type PlaywrightPdfBrowserFactory = () => Promise<PlaywrightPdfBrowserHandle>;

interface MinimalPlaywrightModule {
  readonly chromium: {
    launch(options: { readonly headless: boolean }): Promise<PlaywrightPdfBrowserHandle>;
  };
}

function isMinimalPlaywrightModule(value: unknown): value is MinimalPlaywrightModule {
  if (typeof value !== 'object' || value === null || !('chromium' in value)) {
    return false;
  }
  const chromium = (value as { chromium?: unknown }).chromium;
  return (
    typeof chromium === 'object' &&
    chromium !== null &&
    'launch' in chromium &&
    typeof (chromium as { launch?: unknown }).launch === 'function'
  );
}

async function defaultLaunchPlaywrightBrowser(
  importer: (specifier: 'playwright-core' | 'playwright') => Promise<unknown> = (name) => import(name)
): Promise<PlaywrightPdfBrowserHandle> {
  for (const specifier of ['playwright-core', 'playwright'] as const) {
    try {
      const mod = await importer(specifier);
      if (isMinimalPlaywrightModule(mod)) {
        return await mod.chromium.launch({ headless: true });
      }
    } catch {
      // Try next candidate Playwright package.
    }
  }
  throw new Error(
    'Playwright PDF rendering requires optional `playwright-core` (or `playwright`). Use `--renderer deterministic` for browser-free PDF generation.'
  );
}

export interface PlaywrightPdfRendererOptions {
  readonly browserFactory?: PlaywrightPdfBrowserFactory;
  readonly importer?: (specifier: 'playwright-core' | 'playwright') => Promise<unknown>;
}

/**
 * Node CLI Playwright Chromium PDF renderer adapter implementing PdfRendererPort.
 * Accepts an injectable browserFactory so unit tests stay 100% hermetic without launching Chromium.
 */
export function createPlaywrightPdfRenderer(options: PlaywrightPdfRendererOptions = {}): PdfRendererPort {
  const launchBrowser = options.browserFactory ?? (() => defaultLaunchPlaywrightBrowser(options.importer));

  async function renderHtml(html: string, widthIn: number, heightIn: number): Promise<Uint8Array> {
    const browser = await launchBrowser();
    let page: PlaywrightPdfPageHandle | undefined;
    try {
      page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      const raw = await page.pdf({
        preferCSSPageSize: true,
        printBackground: true,
        width: `${widthIn}in`,
        height: `${heightIn}in`,
        margin: { top: '0in', right: '0in', bottom: '0in', left: '0in' },
      });
      return new Uint8Array(raw);
    } finally {
      await page?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  return {
    adapterKind: 'playwright-chromium',
    async renderInterior(doc: CompiledBookDocument): Promise<Uint8Array> {
      const geom = doc.report.interiorGeometry;
      return renderHtml(doc.interiorHtml, geom.bleedWidthIn, geom.bleedHeightIn);
    },
    async renderCover(
      doc: CompiledBookDocument,
      overrideCoverDimensions?: CoverDimensionsResult
    ): Promise<Uint8Array> {
      const dims = overrideCoverDimensions ?? doc.report.coverDimensions;
      return renderHtml(doc.coverHtml, dims.totalWidthIn, dims.totalHeightIn);
    },
  };
}
