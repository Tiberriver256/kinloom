import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

interface CwvThresholds {
  readonly maxLcpMs: number;
  readonly maxFcpMs: number;
  readonly maxCls: number;
  readonly maxInteractionMs: number;
}

interface CwvMetricsSnapshot {
  readonly fcpMs: number | null;
  readonly lcpMs: number | null;
  readonly cls: number;
  readonly maxEventDurationMs: number;
  readonly interactionLatencyMs: number;
}

interface CwvWindowState {
  fcpMs: number | null;
  lcpMs: number | null;
  cls: number;
  maxEventDurationMs: number;
  interactionCount: number;
  fallbackInputToPaintMs: number;
}

interface LayoutShiftLikeEntry extends PerformanceEntry {
  readonly value: number;
  readonly hadRecentInput: boolean;
}

interface EventTimingLikeEntry extends PerformanceEntry {
  readonly interactionId?: number;
}

declare global {
  interface Window {
    __kinloomCwvState?: CwvWindowState;
  }
}

function parsePositiveThreshold(envValue: string | undefined, fallback: number): number {
  if (!envValue?.trim()) {
    return fallback;
  }
  const parsed = Number(envValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CWV_THRESHOLDS: CwvThresholds = {
  maxLcpMs: parsePositiveThreshold(process.env.KINLOOM_CWV_MAX_LCP_MS, 2500),
  maxFcpMs: parsePositiveThreshold(process.env.KINLOOM_CWV_MAX_FCP_MS, 1800),
  maxCls: parsePositiveThreshold(process.env.KINLOOM_CWV_MAX_CLS, 0.1),
  maxInteractionMs: parsePositiveThreshold(process.env.KINLOOM_CWV_MAX_INTERACTION_MS, 200),
};

async function installCwvObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: CwvWindowState = {
      fcpMs: null,
      lcpMs: null,
      cls: 0,
      maxEventDurationMs: 0,
      interactionCount: 0,
      fallbackInputToPaintMs: 0,
    };
    window.__kinloomCwvState = state;

    const recordFallbackInput = (event: Event): void => {
      const startedAt =
        typeof event.timeStamp === 'number' && event.timeStamp > 0 ? event.timeStamp : performance.now();
      requestAnimationFrame(() => {
        const elapsed = Math.max(0, performance.now() - startedAt);
        if (elapsed > state.fallbackInputToPaintMs) {
          state.fallbackInputToPaintMs = elapsed;
        }
      });
    };
    window.addEventListener('click', recordFallbackInput, { capture: true, passive: true });
    window.addEventListener('keydown', recordFallbackInput, { capture: true, passive: true });

    try {
      const paintObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') {
            state.fcpMs = entry.startTime;
          }
        }
      });
      paintObserver.observe({ type: 'paint', buffered: true });
    } catch {
      // Paint observer unavailable in this browser context.
    }

    try {
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const latest = entries[entries.length - 1];
        if (latest) {
          state.lcpMs = latest.startTime;
        }
      });
      lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      // LCP observer unavailable in this browser context.
    }

    try {
      const clsObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const shift = entry as LayoutShiftLikeEntry;
          if (!shift.hadRecentInput && typeof shift.value === 'number') {
            state.cls += shift.value;
          }
        }
      });
      clsObserver.observe({ type: 'layout-shift', buffered: true });
    } catch {
      // Layout shift observer unavailable in this browser context.
    }

    try {
      const eventObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const eventEntry = entry as EventTimingLikeEntry;
          if ((eventEntry.interactionId ?? 0) > 0 && typeof eventEntry.duration === 'number') {
            state.interactionCount += 1;
            if (eventEntry.duration > state.maxEventDurationMs) {
              state.maxEventDurationMs = eventEntry.duration;
            }
          }
        }
      });
      eventObserver.observe({
        type: 'event',
        buffered: true,
        durationThreshold: 0,
      } as PerformanceObserverInit);
    } catch {
      // Event Timing observer unavailable in this browser context.
    }
  });
}

async function stubExternalMapTiles(page: Page): Promise<void> {
  await page.route('https://www.openhistoricalmap.org/map-styles/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#ece4d2' } }],
      }),
    })
  );
  await page.route('https://vtiles.openhistoricalmap.org/**', (route) =>
    route.fulfill({ status: 204, body: '' })
  );
}

async function flushPaintFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      })
  );
}

async function collectCwvSnapshot(page: Page): Promise<CwvMetricsSnapshot> {
  return page.evaluate(() => {
    const state = window.__kinloomCwvState;
    const paintEntries = performance.getEntriesByType('paint');
    const fcpEntry = paintEntries.find((entry) => entry.name === 'first-contentful-paint');
    const fcpMs = state?.fcpMs ?? (fcpEntry ? fcpEntry.startTime : null);
    const lcpMs = state?.lcpMs ?? null;
    const cls = Math.round((state?.cls ?? 0) * 10_000) / 10_000;
    const maxEventDurationMs = Math.round((state?.maxEventDurationMs ?? 0) * 100) / 100;
    const fallbackMs = Math.round((state?.fallbackInputToPaintMs ?? 0) * 100) / 100;
    const interactionLatencyMs = (state?.interactionCount ?? 0) > 0 ? maxEventDurationMs : fallbackMs;
    return {
      fcpMs: fcpMs === null ? null : Math.round(fcpMs * 100) / 100,
      lcpMs: lcpMs === null ? null : Math.round(lcpMs * 100) / 100,
      cls,
      maxEventDurationMs,
      interactionLatencyMs,
    };
  });
}

interface CwvRouteTarget {
  readonly name: string;
  readonly path: string;
  readonly waitForReady: (page: Page) => Promise<void>;
  readonly runInteraction: (page: Page) => Promise<void>;
}

const CWV_ROUTES: readonly CwvRouteTarget[] = [
  {
    name: 'index',
    path: '/',
    waitForReady: async (page) => {
      await expect(page.getByRole('heading', { name: 'Lincoln & Todd Family' })).toBeVisible();
    },
    runInteraction: async (page) => {
      const searchButton = page.getByRole('button', { name: /Search/i }).first();
      await searchButton.click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
    },
  },
  {
    name: 'tree',
    path: '/tree',
    waitForReady: async (page) => {
      await expect(page.getByRole('group', { name: /family tree chart/ })).toBeVisible();
    },
    runInteraction: async (page) => {
      await page.getByRole('group', { name: /family tree chart/ }).click({ position: { x: 40, y: 40 } });
    },
  },
  {
    name: 'map',
    path: '/map',
    waitForReady: async (page) => {
      await expect(page.getByLabel('Filter migration map by person')).toBeVisible();
      await expect(page.locator('.map-canvas')).toBeVisible();
    },
    runInteraction: async (page) => {
      await page.getByLabel('Filter migration map by person').focus();
    },
  },
  {
    name: 'person',
    path: '/person/abraham-lincoln-1809',
    waitForReady: async (page) => {
      await expect(page.getByRole('heading', { name: 'Abraham Lincoln', exact: true })).toBeVisible();
    },
    runInteraction: async (page) => {
      const firstMediaButton = page
        .locator('section[aria-label="Photos and documents"] button.person-media-card')
        .first();
      await firstMediaButton.click();
      await expect(page.getByLabel('Photo and document lightbox')).toBeVisible();
      await page.keyboard.press('Escape');
    },
  },
];

test.describe('Opt-in Core Web Vitals performance budgets', () => {
  for (const route of CWV_ROUTES) {
    test(`route ${route.path} stays within FCP, LCP, CLS, and interaction budgets`, async ({ page }) => {
      await stubExternalMapTiles(page);
      await installCwvObservers(page);

      await page.goto(route.path, { waitUntil: 'networkidle' });
      await route.waitForReady(page);
      await route.runInteraction(page);
      await flushPaintFrame(page);

      const snapshot = await collectCwvSnapshot(page);

      expect(
        snapshot.fcpMs,
        `${route.name} (${route.path}) did not emit a first-contentful-paint entry`
      ).not.toBeNull();
      expect(
        snapshot.lcpMs,
        `${route.name} (${route.path}) did not emit a largest-contentful-paint entry`
      ).not.toBeNull();

      expect(
        snapshot.fcpMs ?? Number.POSITIVE_INFINITY,
        `${route.name} FCP ${snapshot.fcpMs}ms exceeded ${CWV_THRESHOLDS.maxFcpMs}ms`
      ).toBeLessThanOrEqual(CWV_THRESHOLDS.maxFcpMs);
      expect(
        snapshot.lcpMs ?? Number.POSITIVE_INFINITY,
        `${route.name} LCP ${snapshot.lcpMs}ms exceeded ${CWV_THRESHOLDS.maxLcpMs}ms`
      ).toBeLessThanOrEqual(CWV_THRESHOLDS.maxLcpMs);
      expect(
        snapshot.cls,
        `${route.name} CLS ${snapshot.cls} exceeded ${CWV_THRESHOLDS.maxCls}`
      ).toBeLessThanOrEqual(CWV_THRESHOLDS.maxCls);
      expect(
        snapshot.interactionLatencyMs,
        `${route.name} interaction latency ${snapshot.interactionLatencyMs}ms exceeded ${CWV_THRESHOLDS.maxInteractionMs}ms`
      ).toBeLessThanOrEqual(CWV_THRESHOLDS.maxInteractionMs);
    });
  }
});
