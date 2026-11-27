import path from 'node:path';
import {
  type ChromiumLauncher,
  DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS,
  launchOptionalChromium,
  runWithBrowserSession,
} from '../../runtime/browser.js';
import {
  atomicWriteFileSync,
  cacheKeyFor,
  type SchemaCacheEntry,
  withAdvisoryLock,
} from '../../runtime/cache.js';
import { httpGetText, httpRequest } from '../../runtime/http.js';
import type { RecordCommandContext } from '../../runtime/types.js';
import {
  buildUrl,
  CACHE_SCHEMA,
  CALISPHERE_BASE,
  type CaExhibitsItem,
  type CaPortalItem,
  type CaSourceEntry,
  calisphereUrl,
  DEFAULT_SEARCH_TIMEOUT_SEC,
  dedupeCalisphereLinks,
  dedupeOacLinks,
  EXHIBITS_BASE,
  exhibitsUrl,
  isNavigationContextDestroyed,
  isTimeoutFailure,
  makeTimedOutEntry,
  OAC_BASE,
  oacUrl,
  PORTAL_BASE,
  parseExhibitsItemPayload,
  parseExhibitsSearchPayload,
  parsePortalItemHtml,
  parsePortalSearchHtml,
  portalUrl,
  type RawBrowserLink,
  USER_AGENT,
} from './domain.js';

const OAC_LINKS_JS =
  "() => Array.from(document.querySelectorAll('a[href*=\"/findaid/\"]')).map(a => ({href: a.getAttribute('href'), text: a.textContent.trim().replace(/\\s+/g, ' ').slice(0, 160)}))";
const CAL_LINKS_JS =
  "() => Array.from(document.querySelectorAll('a[href*=\"/item/\"]')).map(a => ({href: a.getAttribute('href'), text: a.textContent.trim().replace(/\\s+/g, ' ').slice(0, 160)}))";

export async function searchPortal(
  ctx: RecordCommandContext,
  query: string,
  limit = 10,
  timeoutMs = 30_000
): Promise<CaSourceEntry> {
  const url = portalUrl(query);
  const { text } = await httpGetText(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: USER_AGENT,
    timeoutMs: Math.max(1_000, Math.min(30_000, Math.floor(timeoutMs))),
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['archives.sos.ca.gov'] },
  });
  return parsePortalSearchHtml(text, url, limit);
}

export async function searchExhibits(
  ctx: RecordCommandContext,
  query: string,
  limit = 10,
  timeoutMs = 30_000
): Promise<CaSourceEntry> {
  const url = exhibitsUrl(query, limit);
  const response = await httpRequest(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: USER_AGENT,
    headers: { Accept: 'application/ld+json' },
    timeoutMs: Math.max(1_000, Math.min(30_000, Math.floor(timeoutMs))),
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['exhibits.sos.ca.gov'] },
  });
  return parseExhibitsSearchPayload(
    response.bytes.toString('utf8'),
    url,
    response.headers.get('Omeka-S-Total-Results')
  );
}

export async function browserSearch(
  ctx: RecordCommandContext,
  sources: readonly ('oac' | 'calisphere')[],
  query: string,
  limit = 10,
  timeoutMs = DEFAULT_SEARCH_TIMEOUT_SEC * 1000,
  launcher: ChromiumLauncher = launchOptionalChromium,
  sessionOptions?: { readonly closeTimeoutMs?: number; readonly killGraceMs?: number }
): Promise<Partial<Record<'oac' | 'calisphere', CaSourceEntry>>> {
  const out: Partial<Record<'oac' | 'calisphere', CaSourceEntry>> = {};
  const totalTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  const launchTimeoutMs = Math.min(DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS, totalTimeoutMs);

  try {
    await runWithBrowserSession(
      {
        env: ctx.env,
        overrideEnvVar: 'CA_ARCHIVES_BROWSER',
        userAgent: USER_AGENT,
        totalTimeoutMs,
        launchTimeoutMs,
        closeTimeoutMs: sessionOptions?.closeTimeoutMs,
        killGraceMs: sessionOptions?.killGraceMs,
        nowMs: ctx.nowMs,
        launcher,
      },
      async (session) => {
        const { page } = session;

        for (let idx = 0; idx < sources.length; idx += 1) {
          const src = sources[idx];
          const url = src === 'oac' ? oacUrl(query) : calisphereUrl(query);
          const remainingCount = sources.length - idx;
          const remainingTotal = session.remainingMs();
          if (remainingTotal <= 0) {
            out[src] = makeTimedOutEntry(
              src,
              url,
              `Browser search budget (${totalTimeoutMs}ms) exhausted before ${src}.`
            );
            continue;
          }

          const sourceBudgetMs = Math.max(1, Math.floor(remainingTotal / remainingCount));
          const sourceDeadline = ctx.nowMs() + sourceBudgetMs;
          const sourceRemaining = (): number =>
            Math.min(session.remainingMs(), Math.max(0, sourceDeadline - ctx.nowMs()));

          try {
            await session.runStep(
              `${src}:goto`,
              (stepMs) => page.goto(url, { waitUntil: 'domcontentloaded', timeout: stepMs }),
              sourceRemaining()
            );

            const waitForFn =
              typeof page.waitForFunction === 'function' ? page.waitForFunction.bind(page) : undefined;
            if (waitForFn) {
              const waitExpr =
                src === 'oac'
                  ? '() => /of \\d+ entries|No results/i.test(document.body.innerText)'
                  : '() => /\\d+ items? found|No results/i.test(document.body.innerText)';
              for (let navAttempt = 0; navAttempt < 3; navAttempt += 1) {
                const waitBudget = Math.min(15_000, Math.floor(sourceRemaining() * 0.6));
                if (waitBudget <= 0) {
                  break;
                }
                try {
                  await session.runStep(
                    `${src}:waitForFunction`,
                    (stepMs) => waitForFn(waitExpr, undefined, { timeout: stepMs }),
                    waitBudget
                  );
                  break;
                } catch (waitErr: unknown) {
                  if (session.remainingMs() <= 0) {
                    throw waitErr;
                  }
                  if (isNavigationContextDestroyed(waitErr) && navAttempt < 2 && sourceRemaining() > 300) {
                    const retryWaitMs = Math.min(400, Math.floor(sourceRemaining() * 0.2));
                    await session.runStep(
                      `${src}:nav-retry`,
                      () =>
                        typeof page.waitForTimeout === 'function'
                          ? page.waitForTimeout(retryWaitMs)
                          : ctx.sleepFn(retryWaitMs),
                      sourceRemaining()
                    );
                    continue;
                  }
                  // Proceed to inspect current DOM if the page text heuristic timed out.
                  break;
                }
              }

              const settleMs = Math.min(500, Math.floor(sourceRemaining() * 0.2));
              if (settleMs > 0) {
                await session.runStep(
                  `${src}:settle`,
                  () =>
                    typeof page.waitForTimeout === 'function'
                      ? page.waitForTimeout(settleMs)
                      : ctx.sleepFn(settleMs),
                  sourceRemaining()
                );
              }
            }

            const evaluateWithNavRetry = async <T>(phase: string, expr: string): Promise<T> => {
              for (let attempt = 0; attempt < 3; attempt += 1) {
                try {
                  return await session.runStep(phase, () => page.evaluate<T>(expr), sourceRemaining());
                } catch (evalErr: unknown) {
                  if (isNavigationContextDestroyed(evalErr) && attempt < 2 && sourceRemaining() > 300) {
                    const retryWaitMs = Math.min(400, Math.floor(sourceRemaining() * 0.2));
                    await session.runStep(
                      `${phase}:nav-retry`,
                      () =>
                        typeof page.waitForTimeout === 'function'
                          ? page.waitForTimeout(retryWaitMs)
                          : ctx.sleepFn(retryWaitMs),
                      sourceRemaining()
                    );
                    continue;
                  }
                  throw evalErr;
                }
              }
              return session.runStep(phase, () => page.evaluate<T>(expr), sourceRemaining());
            };

            const text = await evaluateWithNavRetry<string>(
              `${src}:evaluate-text`,
              'document.body.innerText'
            );
            const links = await evaluateWithNavRetry<RawBrowserLink[]>(
              `${src}:evaluate-links`,
              src === 'oac' ? OAC_LINKS_JS : CAL_LINKS_JS
            );

            if (src === 'oac') {
              const totalMatch = /of (\d+) entries/.exec(typeof text === 'string' ? text : '');
              const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : null;
              out.oac = {
                source: 'oac',
                url,
                total,
                results: dedupeOacLinks(Array.isArray(links) ? links : [], OAC_BASE, limit),
              };
            } else {
              const totalMatch = /(\d+) items? found/.exec(typeof text === 'string' ? text : '');
              const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : null;
              out.calisphere = {
                source: 'calisphere',
                url,
                total,
                results: dedupeCalisphereLinks(Array.isArray(links) ? links : [], CALISPHERE_BASE, limit),
              };
            }
          } catch (err: unknown) {
            if (isTimeoutFailure(err)) {
              const message = err instanceof Error ? err.message : String(err);
              out[src] = makeTimedOutEntry(src, url, message);
              continue;
            }
            throw err;
          }
        }
      }
    );
  } catch (err: unknown) {
    if (isTimeoutFailure(err)) {
      const message = err instanceof Error ? err.message : String(err);
      for (const src of sources) {
        if (!out[src]) {
          out[src] = makeTimedOutEntry(src, buildUrl(src, query, limit), message);
        }
      }
      return out;
    }
    throw err;
  }

  return out;
}

export async function fetchPortalItem(ctx: RecordCommandContext, portalId: string): Promise<CaPortalItem> {
  const url = `${PORTAL_BASE}/Items/Details/${portalId}`;
  const { text } = await httpGetText(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: USER_AGENT,
    timeoutMs: 30_000,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['archives.sos.ca.gov'] },
  });
  return parsePortalItemHtml(text, portalId, url);
}

export async function fetchExhibitsItem(
  ctx: RecordCommandContext,
  exhibitsId: string
): Promise<CaExhibitsItem> {
  const url = `${EXHIBITS_BASE}/api/items/${exhibitsId}`;
  const response = await httpRequest(url, {
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
    userAgent: USER_AGENT,
    headers: { Accept: 'application/ld+json' },
    timeoutMs: 30_000,
    maxAttempts: 1,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['exhibits.sos.ca.gov'] },
  });
  return parseExhibitsItemPayload(response.bytes.toString('utf8'), exhibitsId, url);
}

export async function writeSchemaCacheEntry<T>(
  ctx: RecordCommandContext,
  cacheDir: string,
  kind: string,
  payload: unknown,
  result: T
): Promise<void> {
  const key = cacheKeyFor(kind, payload);
  const entryPath = path.join(cacheDir, `${key}.json`);
  const lockPath = path.join(cacheDir, `${key}.lock`);
  await withAdvisoryLock(
    lockPath,
    async () => {
      const envelope: SchemaCacheEntry<T> = {
        schema: CACHE_SCHEMA,
        fetched_at: ctx.nowMs() / 1000,
        kind,
        query: payload,
        result,
      };
      atomicWriteFileSync(entryPath, JSON.stringify(envelope));
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}
