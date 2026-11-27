import {
  type ChromiumLauncher,
  DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS,
  launchOptionalChromium,
  type OptionalBrowserPage,
  runWithBrowserSession,
} from '../../runtime/browser.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import type { RecordCommandContext } from '../../runtime/types.js';
import { buildSearchPayload, extractRecord } from './queryAndRecords.js';
import {
  CATALOG_WEB_BASE,
  DEFAULT_BROWSER_TIMEOUT_MS,
  type NaraRecordSummary,
  type NaraSearchPayload,
  USER_AGENT,
} from './types.js';

interface PlaywrightResponseLike {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  json(): Promise<unknown>;
}

interface ExtendedBrowserPage extends OptionalBrowserPage {
  on?: (event: string, listener: (resp: PlaywrightResponseLike) => void) => void;
  removeListener?: (event: string, listener: (resp: PlaywrightResponseLike) => void) => void;
  waitForFunction?: (fn: string, arg?: unknown, options?: { timeout?: number }) => Promise<unknown>;
  waitForTimeout?: (timeout: number) => Promise<void>;
}

interface BrowserSessionOverrides {
  readonly launcher?: ChromiumLauncher;
  readonly closeTimeoutMs?: number;
  readonly killGraceMs?: number;
}

export async function defaultBrowserSearchMany(
  items: readonly (readonly [string | null, string])[],
  ctx: RecordCommandContext,
  timeoutMs = DEFAULT_BROWSER_TIMEOUT_MS,
  sessionOverrides?: BrowserSessionOverrides
): Promise<NaraSearchPayload[]> {
  const totalTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const launchTimeoutMs = Math.min(DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS, totalTimeoutMs);
  const results: NaraSearchPayload[] = [];

  await runWithBrowserSession(
    {
      env: ctx.env,
      overrideEnvVar: 'NARA_BROWSER',
      userAgent: USER_AGENT,
      totalTimeoutMs,
      launchTimeoutMs,
      closeTimeoutMs: sessionOverrides?.closeTimeoutMs,
      killGraceMs: sessionOverrides?.killGraceMs,
      nowMs: ctx.nowMs,
      launcher: sessionOverrides?.launcher ?? launchOptionalChromium,
    },
    async (session) => {
      const page = session.page as ExtendedBrowserPage;

      for (const [query, searchUrl] of items) {
        const captured: Record<string, unknown>[] = [];
        const pendingReads: Promise<void>[] = [];

        const onResponse = (resp: PlaywrightResponseLike): void => {
          const u = resp.url();
          if (u.includes('/proxy/') && u.includes('/records/search') && resp.status() === 200) {
            const ct = resp.headers()['content-type'] ?? '';
            if (ct.toLowerCase().includes('json')) {
              const p = resp
                .json()
                .then((data) => {
                  if (isPlainRecord(data)) {
                    captured.push(data);
                  }
                })
                .catch(() => {
                  // Ignore unreadable response body.
                });
              pendingReads.push(p);
            }
          }
        };

        page.on?.('response', onResponse);
        try {
          await session.runStep('nara-search:goto', (stepMs) =>
            page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: stepMs })
          );
          if (page.waitForFunction) {
            const waitBudget = Math.min(20_000, Math.floor(session.remainingMs() * 0.6));
            if (waitBudget > 0) {
              try {
                await session.runStep(
                  'nara-search:waitForFunction',
                  (stepMs) =>
                    page.waitForFunction!(
                      `() => {
                        const t = document.body.innerText || '';
                        return /\\d+\\s+results?\\s+for|No results|0 results|did not match/i.test(t);
                      }`,
                      undefined,
                      { timeout: stepMs }
                    ),
                  waitBudget
                );
              } catch (waitErr: unknown) {
                if (session.remainingMs() <= 0) {
                  throw waitErr;
                }
                // Fall through to captured responses or DOM scrape.
              }
            }
          }
          const settleMs = Math.min(500, Math.floor(session.remainingMs() * 0.25));
          if (settleMs > 0) {
            await session.runStep('nara-search:settle', () =>
              page.waitForTimeout ? page.waitForTimeout(settleMs) : ctx.sleepFn(settleMs)
            );
          }
          if (pendingReads.length > 0) {
            await session.runStep('nara-search:read-responses', () => Promise.allSettled(pendingReads));
          }
        } finally {
          page.removeListener?.('response', onResponse);
        }

        let entry: NaraSearchPayload | null = null;
        for (let i = captured.length - 1; i >= 0; i -= 1) {
          const cap = captured[i];
          const body = isPlainRecord(cap.body) ? cap.body : cap;
          const hitsObj = isPlainRecord(body.hits) ? body.hits : {};
          if (Array.isArray(hitsObj.hits)) {
            entry = buildSearchPayload(query, searchUrl, cap);
            break;
          }
        }

        if (entry === null) {
          const domItems = await session.runStep('nara-search:evaluate', () =>
            page.evaluate<NaraRecordSummary[]>(
              `(() => {
                const items = [];
                const seen = new Set();
                for (const a of document.querySelectorAll('a[href*="/id/"]')) {
                  const m = (a.getAttribute('href') || '').match(/\\/id\\/(\\d+)/);
                  if (!m || seen.has(m[1])) continue;
                  const title = (a.textContent || '').trim();
                  if (!title) continue;
                  seen.add(m[1]);
                  items.push({ naId: m[1], title, url: 'https://catalog.archives.gov/id/' + m[1] });
                }
                return items;
              })()`
            )
          );
          const safeDom = Array.isArray(domItems) ? domItems : [];
          entry =
            query !== null
              ? { query, searchUrl, total: safeDom.length, results: safeDom }
              : { searchUrl, total: safeDom.length, results: safeDom };
        }
        results.push(entry);
      }
    }
  );
  return results;
}

export async function defaultBrowserGetRecords(
  naids: readonly string[],
  options: {
    readonly includeObjects: boolean;
    readonly includeText: boolean;
    readonly pageSpec: string | null;
    readonly timeoutMs?: number;
  },
  ctx: RecordCommandContext,
  sessionOverrides?: BrowserSessionOverrides
): Promise<NaraRecordSummary[]> {
  const totalTimeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS));
  const launchTimeoutMs = Math.min(DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS, totalTimeoutMs);
  const records: NaraRecordSummary[] = [];

  await runWithBrowserSession(
    {
      env: ctx.env,
      overrideEnvVar: 'NARA_BROWSER',
      userAgent: USER_AGENT,
      totalTimeoutMs,
      launchTimeoutMs,
      closeTimeoutMs: sessionOverrides?.closeTimeoutMs,
      killGraceMs: sessionOverrides?.killGraceMs,
      nowMs: ctx.nowMs,
      launcher: sessionOverrides?.launcher ?? launchOptionalChromium,
    },
    async (session) => {
      const page = session.page as ExtendedBrowserPage;

      for (const naid of naids) {
        const cleanId = String(naid).replace(/\D+/g, '');
        let capturedRecord: NaraRecordSummary | null = null;
        const contributions: Record<string, unknown>[] = [];
        const pendingReads: Promise<void>[] = [];

        const onResponse = (resp: PlaywrightResponseLike): void => {
          const u = resp.url();
          const ct = resp.headers()['content-type'] ?? '';
          if (resp.status() !== 200 || !ct.toLowerCase().includes('json')) {
            return;
          }
          if (u.includes(`naId_is=${cleanId}`) && u.includes('/records/search')) {
            const p = resp
              .json()
              .then((payload) => {
                if (!isPlainRecord(payload)) {
                  return;
                }
                const body = isPlainRecord(payload.body) ? payload.body : payload;
                const hitsObj = isPlainRecord(body.hits) ? body.hits : {};
                const hits = Array.isArray(hitsObj.hits) ? hitsObj.hits : [];
                if (hits.length > 0) {
                  capturedRecord = extractRecord(hits[0], {
                    includeObjects: options.includeObjects,
                    includeText: options.includeText,
                    pageSpec: options.pageSpec,
                  });
                }
              })
              .catch(() => {
                // Ignore parse error.
              });
            pendingReads.push(p);
          } else if (
            options.includeText &&
            u.includes(`targetNaId/${cleanId}`) &&
            u.includes('/contributions/')
          ) {
            const p = resp
              .json()
              .then((c) => {
                if (Array.isArray(c)) {
                  for (const item of c) {
                    if (isPlainRecord(item)) {
                      contributions.push(item);
                    }
                  }
                }
              })
              .catch(() => {
                // Ignore parse error.
              });
            pendingReads.push(p);
          }
        };

        page.on?.('response', onResponse);
        const url = `${CATALOG_WEB_BASE}/id/${cleanId}`;
        try {
          await session.runStep('nara-get:goto', (stepMs) =>
            page.goto(url, { waitUntil: 'domcontentloaded', timeout: stepMs })
          );
          if (page.waitForFunction) {
            const waitBudget = Math.min(20_000, Math.floor(session.remainingMs() * 0.6));
            if (waitBudget > 0) {
              try {
                await session.runStep(
                  'nara-get:waitForFunction',
                  (stepMs) =>
                    page.waitForFunction!(
                      `() => /National Archives Identifier/i.test(document.body.innerText || '')`,
                      undefined,
                      { timeout: stepMs }
                    ),
                  waitBudget
                );
              } catch (waitErr: unknown) {
                if (session.remainingMs() <= 0) {
                  throw waitErr;
                }
                // Proceed to wait loop.
              }
            }
          }
          for (let tick = 0; tick < 25 && session.remainingMs() > 0; tick += 1) {
            if (pendingReads.length > 0) {
              await session.runStep('nara-get:read-responses', () => Promise.allSettled(pendingReads));
            }
            if (capturedRecord !== null && (!options.includeText || contributions.length > 0)) {
              break;
            }
            const tickMs = Math.min(200, session.remainingMs());
            if (tickMs <= 0) {
              break;
            }
            await session.runStep('nara-get:poll', () =>
              page.waitForTimeout ? page.waitForTimeout(tickMs) : ctx.sleepFn(tickMs)
            );
          }
          if (pendingReads.length > 0 && session.remainingMs() > 0) {
            await session.runStep('nara-get:read-responses', () => Promise.allSettled(pendingReads));
          }
        } finally {
          page.removeListener?.('response', onResponse);
        }

        if (capturedRecord === null) {
          records.push({
            naId: cleanId,
            url,
            error: 'Record metadata not captured.',
          });
        } else {
          const rec: NaraRecordSummary = capturedRecord;
          if (options.includeText && contributions.length > 0) {
            const transcriptions: string[] = [];
            for (const c of contributions) {
              if (c.contributionType === 'transcription') {
                const textVal =
                  (typeof c.text === 'string' && c.text) ||
                  (typeof c.transcription === 'string' && c.transcription) ||
                  '';
                if (textVal) {
                  transcriptions.push(textVal);
                }
              }
            }
            if (transcriptions.length > 0) {
              rec.transcriptions = transcriptions;
            }
          }
          records.push(rec);
        }
      }
    }
  );
  return records;
}
