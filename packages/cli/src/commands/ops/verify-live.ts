import path from 'node:path';
import { CliValidationError } from '../../errors.js';
import {
  parseExpectedPluginsCsv,
  runSyntheticProbe,
  type SyntheticProbeClock,
  type SyntheticProbeReport,
} from '../../plugins/syntheticProbe.js';
import {
  checkFaviconLightAccentDrift,
  checkServiceWorkerAccentDrift,
  checkWebManifestDrift,
  type ExpectedBrandkitProfile,
  tryLoadExpectedBrandkitProfile,
} from './shared/brandkitDrift.js';
import {
  type EphemeralAuthCleanupSummary,
  type EphemeralSignalTarget,
  hasWranglerConfig,
  normalizeSiteUrl,
  redeemEphemeralInviteSession,
  withEphemeralD1Auth,
} from './shared/ephemeralAuth.js';
import type { WranglerExecutor } from './shared/wrangler.js';

export { VERIFY_LIVE_HELP } from './help.js';

const DEFAULT_VERIFY_LIVE_TIMEOUT_MS = 15_000;
const YEAR_ONLY_RE = /^\d{4}$/;

export type VerifyLiveAuthMode = 'ephemeral-d1' | 'bearer-token' | 'anonymous';

export interface AnonymousBundleGateResult {
  readonly status: 'pass' | 'fail';
  readonly url: string;
  readonly httpStatus: number | null;
  readonly detail: string;
  readonly violations: readonly string[];
}

export interface LiveBundlePrivacyCounts {
  readonly livingPeople: number;
  readonly livingPortraits: number;
  readonly livingExactBirthdates: number;
  readonly livingResidenceSpans: number;
  readonly livingMedia: number;
  readonly livingNarratives: number;
  readonly livingEventLeaks: number;
  readonly livingPrimaryPlaces: number;
}

export interface LiveBundlePrivacyResult {
  readonly status: 'pass' | 'fail';
  readonly url: string;
  readonly httpStatus: number | null;
  readonly buildMode: 'private' | 'public' | 'unknown';
  readonly counts: LiveBundlePrivacyCounts;
  readonly violations: readonly string[];
}

export interface VerifyLiveBrowserCookieSpec {
  readonly name: string;
  readonly value: string;
  readonly url: string;
}

export interface VerifyLiveBrowserPageHandle {
  goto(url: string, options?: { readonly waitUntil?: string; readonly timeout?: number }): Promise<unknown>;
  waitForSelector?(
    selector: string,
    options?: { readonly state?: 'attached' | 'visible'; readonly timeout?: number }
  ): Promise<unknown>;
  evaluate<T>(expr: string): Promise<T>;
  on(event: 'pageerror', listener: (err: Error) => void): void;
  on(
    event: 'requestfailed',
    listener: (req: { url(): string; failure(): { errorText?: string } | null }) => void
  ): void;
  on(event: 'response', listener: (res: { url(): string; status(): number }) => void): void;
  close(): Promise<void>;
}

export interface VerifyLiveBrowserContextHandle {
  addCookies?(cookies: readonly VerifyLiveBrowserCookieSpec[]): Promise<void>;
  newPage(): Promise<VerifyLiveBrowserPageHandle>;
  close(): Promise<void>;
}

export interface VerifyLiveBrowserHandle {
  newContext(options?: {
    readonly viewport?: { readonly width: number; readonly height: number };
    readonly extraHTTPHeaders?: Readonly<Record<string, string>>;
  }): Promise<VerifyLiveBrowserContextHandle>;
  close(): Promise<void>;
}

export type VerifyLiveBrowserFactory = () => Promise<VerifyLiveBrowserHandle>;

export interface VerifyLiveBrowserCheckResult {
  readonly status: 'pass' | 'fail' | 'skipped';
  readonly url: string;
  readonly h1Visible: boolean;
  readonly h1Text: string;
  readonly pageErrors: readonly string[];
  readonly failedRequests: readonly string[];
  readonly failedResponses: readonly string[];
  readonly violations: readonly string[];
}

export interface VerifyLivePwaAssetStatus {
  readonly path: string;
  readonly ok: boolean;
  readonly httpStatus: number | null;
  readonly detail: string;
}

export interface VerifyLivePwaCheckResult {
  readonly status: 'pass' | 'fail' | 'skipped';
  readonly assets: readonly VerifyLivePwaAssetStatus[];
  readonly violations: readonly string[];
}

export interface VerifyLiveCommandOptions {
  readonly repoDir?: string | undefined;
  readonly url?: string | undefined;
  readonly token?: string | undefined;
  readonly withTempAuth?: boolean | undefined;
  readonly expectPlugins?: readonly string[] | undefined;
  readonly browser?: boolean | undefined;
  readonly checkPwa?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly json?: boolean | undefined;
  readonly backupTokenLabel?: string | undefined;
  readonly wranglerBin?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly execWrangler?: WranglerExecutor | undefined;
  readonly browserFactory?: VerifyLiveBrowserFactory | undefined;
  readonly clock?: SyntheticProbeClock | undefined;
  readonly signalTarget?: EphemeralSignalTarget | undefined;
  readonly onSignalAfterCleanup?: ((signal: 'SIGINT' | 'SIGTERM') => void) | undefined;
}

export interface VerifyLiveCommandResult {
  readonly ok: boolean;
  readonly targetUrl: string;
  readonly authMode: VerifyLiveAuthMode;
  readonly anonymousGate: AnonymousBundleGateResult;
  readonly probe: SyntheticProbeReport;
  readonly privacy: LiveBundlePrivacyResult;
  readonly browser: VerifyLiveBrowserCheckResult;
  readonly pwa: VerifyLivePwaCheckResult;
  readonly cleanup: EphemeralAuthCleanupSummary | null;
  readonly violations: readonly string[];
  readonly rendered: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTrimmedString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim().length > 0) {
      out.push(item.trim());
    }
  }
  return out;
}

function emptyPrivacyCounts(): LiveBundlePrivacyCounts {
  return {
    livingPeople: 0,
    livingPortraits: 0,
    livingExactBirthdates: 0,
    livingResidenceSpans: 0,
    livingMedia: 0,
    livingNarratives: 0,
    livingEventLeaks: 0,
    livingPrimaryPlaces: 0,
  };
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function evaluateLiveBundlePrivacy(
  payload: unknown,
  url: string,
  httpStatus: number
): LiveBundlePrivacyResult {
  if (!isRecord(payload) || !Array.isArray(payload['people'])) {
    return {
      status: 'fail',
      url,
      httpStatus,
      buildMode: 'unknown',
      counts: emptyPrivacyCounts(),
      violations: ['Live /api/bundle returned invalid bundle JSON (missing people array).'],
    };
  }

  const meta = isRecord(payload['meta']) ? payload['meta'] : null;
  const rawMode = meta ? readTrimmedString(meta, 'build_mode') : '';
  const buildMode: 'private' | 'public' | 'unknown' =
    rawMode === 'private' || rawMode === 'public' ? rawMode : 'unknown';

  const livingPeople: Record<string, unknown>[] = [];
  const livingIds = new Set<string>();
  for (const rawPerson of payload['people']) {
    if (!isRecord(rawPerson)) {
      continue;
    }
    const id = readTrimmedString(rawPerson, 'id');
    const fullName = readTrimmedString(rawPerson, 'full_name');
    if (rawPerson['is_living'] === true || fullName.toLowerCase() === 'living') {
      livingPeople.push(rawPerson);
      if (id) {
        livingIds.add(id);
      }
    }
  }

  let livingPortraits = 0;
  let livingExactBirthdates = 0;
  let livingResidenceSpans = 0;
  let livingMedia = 0;
  let livingNarratives = 0;
  let livingEventLeaks = 0;
  let livingPrimaryPlaces = 0;
  const violations: string[] = [];

  for (const person of livingPeople) {
    const id = readTrimmedString(person, 'id') || 'unknown';
    const fullName = readTrimmedString(person, 'full_name');
    const birthEdtf = readTrimmedString(person, 'birth_edtf');
    const altNames = readStringArray(person, 'alt_names');
    const primaryPlaceId = readTrimmedString(person, 'primary_place_id');
    const portraitUrl = readTrimmedString(person, 'portrait_url');
    const thumbUrl = readTrimmedString(person, 'thumb_url');
    const mediaCount = typeof person['media_count'] === 'number' ? person['media_count'] : 0;

    if (buildMode === 'public') {
      if (fullName !== 'Living') {
        violations.push(`Living privacy leak: public person '${id}' exposed non-redacted full_name.`);
      }
      if (birthEdtf.length > 0) {
        livingExactBirthdates += 1;
        violations.push(`Living privacy leak: public person '${id}' exposed birth_edtf '${birthEdtf}'.`);
      }
      if (altNames.length > 0) {
        violations.push(`Living privacy leak: public person '${id}' exposed alt_names.`);
      }
    } else if (birthEdtf.length > 0 && !YEAR_ONLY_RE.test(birthEdtf)) {
      livingExactBirthdates += 1;
      violations.push(
        `Living privacy leak: person '${id}' exposed non-year birth_edtf '${birthEdtf}' (must be year-only or omitted).`
      );
    }

    if (portraitUrl || thumbUrl) {
      livingPortraits += 1;
      violations.push(`Living privacy leak: person '${id}' exposed portrait_url/thumb_url.`);
    }
    if (primaryPlaceId) {
      livingPrimaryPlaces += 1;
      violations.push(`Living privacy leak: person '${id}' exposed primary_place_id.`);
    }
    if (mediaCount > 0) {
      livingMedia += 1;
      violations.push(`Living privacy leak: person '${id}' reported media_count=${mediaCount}.`);
    }
  }

  const livingEventIds = new Set<string>();
  const events = Array.isArray(payload['events']) ? payload['events'] : [];
  for (const rawEvent of events) {
    if (!isRecord(rawEvent)) {
      continue;
    }
    const participants = Array.isArray(rawEvent['participants']) ? rawEvent['participants'] : [];
    const hasLiving = participants.some(
      (part) => isRecord(part) && livingIds.has(readTrimmedString(part, 'person_id'))
    );
    if (!hasLiving) {
      continue;
    }
    const eventId = readTrimmedString(rawEvent, 'id') || 'unknown';
    livingEventIds.add(eventId);
    const edtfDate = readTrimmedString(rawEvent, 'edtf_date');
    if (edtfDate.length > 0 && !YEAR_ONLY_RE.test(edtfDate)) {
      livingEventLeaks += 1;
      violations.push(`Living privacy leak: event '${eventId}' exposed exact edtf_date '${edtfDate}'.`);
    }
    if (readTrimmedString(rawEvent, 'place_id')) {
      livingEventLeaks += 1;
      violations.push(`Living privacy leak: event '${eventId}' exposed place_id.`);
    }
    if (readTrimmedString(rawEvent, 'photo_url')) {
      livingEventLeaks += 1;
      violations.push(`Living privacy leak: event '${eventId}' exposed photo_url.`);
    }
  }

  const residenceSpans = Array.isArray(payload['residence_spans']) ? payload['residence_spans'] : [];
  for (const rawSpan of residenceSpans) {
    if (!isRecord(rawSpan)) {
      continue;
    }
    if (livingIds.has(readTrimmedString(rawSpan, 'person_id'))) {
      livingResidenceSpans += 1;
      const spanId = readTrimmedString(rawSpan, 'id') || 'unknown';
      violations.push(`Living privacy leak: residence_span '${spanId}' linked to living person.`);
    }
  }

  const mediaItems = Array.isArray(payload['media']) ? payload['media'] : [];
  for (const rawMedia of mediaItems) {
    if (!isRecord(rawMedia)) {
      continue;
    }
    const linked =
      livingIds.has(readTrimmedString(rawMedia, 'person_id')) ||
      livingEventIds.has(readTrimmedString(rawMedia, 'event_id')) ||
      readStringArray(rawMedia, 'person_ids').some((pid) => livingIds.has(pid));
    if (linked) {
      livingMedia += 1;
      const mediaId = readTrimmedString(rawMedia, 'id') || 'unknown';
      violations.push(`Living privacy leak: media '${mediaId}' linked to living person or event.`);
    }
  }

  const narratives = Array.isArray(payload['narratives']) ? payload['narratives'] : [];
  for (const rawNarrative of narratives) {
    if (!isRecord(rawNarrative)) {
      continue;
    }
    const linked =
      livingIds.has(readTrimmedString(rawNarrative, 'subject_person_id')) ||
      livingIds.has(readTrimmedString(rawNarrative, 'person_id')) ||
      readStringArray(rawNarrative, 'person_ids').some((pid) => livingIds.has(pid)) ||
      readStringArray(rawNarrative, 'subject_person_ids').some((pid) => livingIds.has(pid));
    if (linked) {
      livingNarratives += 1;
      const narrativeId = readTrimmedString(rawNarrative, 'id') || 'unknown';
      violations.push(`Living privacy leak: narrative '${narrativeId}' linked to living person.`);
    }
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    url,
    httpStatus,
    buildMode,
    counts: {
      livingPeople: livingPeople.length,
      livingPortraits,
      livingExactBirthdates,
      livingResidenceSpans,
      livingMedia,
      livingNarratives,
      livingEventLeaks,
      livingPrimaryPlaces,
    },
    violations,
  };
}

async function checkAnonymousBundleGate(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<AnonymousBundleGateResult> {
  const url = `${baseUrl}/api/bundle`;
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      url,
      { method: 'GET', headers: { Accept: 'application/json' } },
      timeoutMs
    );
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) {
      return {
        status: 'pass',
        url,
        httpStatus: 401,
        detail: 'Anonymous /api/bundle returned HTTP 401 (privacy gate active).',
        violations: [],
      };
    }
    const detail = `Anonymous GET /api/bundle returned HTTP ${response.status} (expected HTTP 401 privacy gate).`;
    return {
      status: 'fail',
      url,
      httpStatus: response.status,
      detail,
      violations: [detail],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const detail = `Anonymous GET /api/bundle request failed: ${message}`;
    return {
      status: 'fail',
      url,
      httpStatus: null,
      detail,
      violations: [detail],
    };
  }
}

async function checkAuthenticatedBundlePrivacy(input: {
  readonly baseUrl: string;
  readonly bearerToken?: string | undefined;
  readonly sessionCookie?: string | undefined;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
}): Promise<LiveBundlePrivacyResult> {
  const url = `${input.baseUrl}/api/bundle`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (input.bearerToken) {
    headers['Authorization'] = `Bearer ${input.bearerToken}`;
  } else if (input.sessionCookie) {
    headers['Cookie'] = input.sessionCookie;
  }

  try {
    const response = await fetchWithTimeout(
      input.fetchImpl,
      url,
      { method: 'GET', headers },
      input.timeoutMs
    );
    const bodyText = await response.text();
    if (response.status !== 200) {
      return {
        status: 'fail',
        url,
        httpStatus: response.status,
        buildMode: 'unknown',
        counts: emptyPrivacyCounts(),
        violations: [`Authenticated GET /api/bundle returned HTTP ${response.status} (expected 200).`],
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return {
        status: 'fail',
        url,
        httpStatus: response.status,
        buildMode: 'unknown',
        counts: emptyPrivacyCounts(),
        violations: ['Authenticated GET /api/bundle returned non-JSON response body.'],
      };
    }
    return evaluateLiveBundlePrivacy(parsed, url, response.status);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'fail',
      url,
      httpStatus: null,
      buildMode: 'unknown',
      counts: emptyPrivacyCounts(),
      violations: [`Authenticated GET /api/bundle request failed: ${message}`],
    };
  }
}

function isTrackedSmokePath(requestUrl: string, targetOrigin: string): boolean {
  try {
    const parsed = new URL(requestUrl);
    if (parsed.origin !== targetOrigin) {
      return false;
    }
    return parsed.pathname.startsWith('/assets/') || parsed.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function parseSessionCookieSpec(cookiePair: string, baseUrl: string): VerifyLiveBrowserCookieSpec | null {
  const eqIdx = cookiePair.indexOf('=');
  if (eqIdx <= 0) {
    return null;
  }
  const name = cookiePair.slice(0, eqIdx).trim();
  const value = cookiePair.slice(eqIdx + 1).trim();
  if (!name || !value) {
    return null;
  }
  return { name, value, url: new URL(baseUrl).origin };
}

interface PlaywrightChromiumLauncher {
  readonly chromium: {
    launch(options?: { readonly headless?: boolean }): Promise<VerifyLiveBrowserHandle>;
  };
}

function isPlaywrightChromiumLauncher(value: unknown): value is PlaywrightChromiumLauncher {
  if (!isRecord(value) || !isRecord(value['chromium'])) {
    return false;
  }
  return typeof value['chromium']['launch'] === 'function';
}

async function defaultVerifyLiveBrowserFactory(): Promise<VerifyLiveBrowserHandle> {
  for (const modName of ['playwright-core', 'playwright'] as const) {
    try {
      const loaded: unknown = await import(modName);
      if (isPlaywrightChromiumLauncher(loaded)) {
        return await loaded.chromium.launch({ headless: true });
      }
    } catch {
      // Try next Playwright module candidate
    }
  }
  throw new Error(
    'Playwright is not installed (install playwright-core or playwright for `kinloom verify-live --browser`).'
  );
}

const INSPECT_H1_EXPR = `(() => {
  const h1 = document.querySelector('h1');
  if (!h1) return { visible: false, text: '' };
  const rect = h1.getBoundingClientRect();
  const cs = getComputedStyle(h1);
  const text = (h1.textContent || '').trim();
  const visible = rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && text.length > 0;
  return { visible, text };
})()`;

async function runBrowserSmokeCheck(input: {
  readonly baseUrl: string;
  readonly bearerToken?: string | undefined;
  readonly sessionCookie?: string | undefined;
  readonly timeoutMs: number;
  readonly browserFactory?: VerifyLiveBrowserFactory | undefined;
}): Promise<VerifyLiveBrowserCheckResult> {
  const targetUrl = `${input.baseUrl}/`;
  const targetOrigin = new URL(input.baseUrl).origin;
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const failedResponses: string[] = [];
  const violations: string[] = [];

  let browser: VerifyLiveBrowserHandle | null = null;
  let context: VerifyLiveBrowserContextHandle | null = null;
  let page: VerifyLiveBrowserPageHandle | null = null;
  let h1Visible = false;
  let h1Text = '';

  try {
    browser = await (input.browserFactory ?? defaultVerifyLiveBrowserFactory)();
    const extraHTTPHeaders: Record<string, string> = {};
    if (input.sessionCookie) {
      extraHTTPHeaders['Cookie'] = input.sessionCookie;
    } else if (input.bearerToken) {
      extraHTTPHeaders['Authorization'] = `Bearer ${input.bearerToken}`;
    }

    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ...(Object.keys(extraHTTPHeaders).length > 0 ? { extraHTTPHeaders } : {}),
    });

    if (input.sessionCookie && context.addCookies) {
      const spec = parseSessionCookieSpec(input.sessionCookie, input.baseUrl);
      if (spec) {
        await context.addCookies([spec]);
      }
    }

    page = await context.newPage();
    page.on('pageerror', (err) => {
      pageErrors.push(err.message || String(err));
    });
    page.on('requestfailed', (req) => {
      const reqUrl = req.url();
      if (isTrackedSmokePath(reqUrl, targetOrigin)) {
        const reason = req.failure()?.errorText;
        failedRequests.push(reason ? `${reqUrl} (${reason})` : reqUrl);
      }
    });
    page.on('response', (res) => {
      const resUrl = res.url();
      if (res.status() >= 400 && isTrackedSmokePath(resUrl, targetOrigin)) {
        failedResponses.push(`${res.status()} ${resUrl}`);
      }
    });

    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: input.timeoutMs });
    if (page.waitForSelector) {
      await page
        .waitForSelector('h1', { state: 'visible', timeout: Math.min(5_000, input.timeoutMs) })
        .catch(() => undefined);
    }

    const h1State = await page.evaluate<{ readonly visible: boolean; readonly text: string }>(
      INSPECT_H1_EXPR
    );
    h1Visible = Boolean(h1State?.visible);
    h1Text = typeof h1State?.text === 'string' ? h1State.text : '';

    if (!h1Visible) {
      violations.push('Browser smoke check failed: visible non-empty <h1> was not rendered on /.');
    }
    if (pageErrors.length > 0) {
      violations.push(`Browser smoke check captured ${pageErrors.length} pageerror(s): ${pageErrors[0]}`);
    }
    if (failedRequests.length > 0) {
      violations.push(
        `Browser smoke check observed ${failedRequests.length} failed /assets/* or /api/* request(s): ${failedRequests[0]}`
      );
    }
    if (failedResponses.length > 0) {
      violations.push(
        `Browser smoke check observed ${failedResponses.length} HTTP >=400 /assets/* or /api/* response(s): ${failedResponses[0]}`
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    violations.push(`Browser smoke check failed: ${message}`);
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    url: targetUrl,
    h1Visible,
    h1Text,
    pageErrors,
    failedRequests,
    failedResponses,
    violations,
  };
}

async function runPwaChecks(input: {
  readonly baseUrl: string;
  readonly bearerToken?: string | undefined;
  readonly sessionCookie?: string | undefined;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly expectedBrandkit?: ExpectedBrandkitProfile | null | undefined;
}): Promise<VerifyLivePwaCheckResult> {
  const headers: Record<string, string> = {};
  if (input.bearerToken) {
    headers['Authorization'] = `Bearer ${input.bearerToken}`;
  } else if (input.sessionCookie) {
    headers['Cookie'] = input.sessionCookie;
  }

  const assets: VerifyLivePwaAssetStatus[] = [];
  const violations: string[] = [];

  const fetchAsset = async (
    assetPath: string,
    validate: (body: string, contentType: string) => string | null
  ): Promise<void> => {
    const url = `${input.baseUrl}${assetPath}`;
    try {
      const response = await fetchWithTimeout(
        input.fetchImpl,
        url,
        { method: 'GET', headers },
        input.timeoutMs
      );
      const body = await response.text();
      if (response.status !== 200) {
        const detail = `HTTP ${response.status} (expected 200)`;
        assets.push({ path: assetPath, ok: false, httpStatus: response.status, detail });
        violations.push(`PWA check failed for ${assetPath}: ${detail}.`);
        return;
      }
      const contentType = response.headers.get('content-type') ?? '';
      const validationError = validate(body, contentType);
      if (validationError) {
        assets.push({ path: assetPath, ok: false, httpStatus: response.status, detail: validationError });
        violations.push(`PWA check failed for ${assetPath}: ${validationError}.`);
        return;
      }
      assets.push({ path: assetPath, ok: true, httpStatus: 200, detail: 'ok' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      assets.push({ path: assetPath, ok: false, httpStatus: null, detail: message });
      violations.push(`PWA check failed for ${assetPath}: ${message}`);
    }
  };

  await fetchAsset('/site.webmanifest', (body) => {
    const manifestCheck = checkWebManifestDrift(body, input.expectedBrandkit);
    if (manifestCheck.parseError) {
      return manifestCheck.parseError;
    }
    const hasName = manifestCheck.manifestName !== null || manifestCheck.manifestShortName !== null;
    if (!hasName || !manifestCheck.hasIcons) {
      return 'manifest missing required name or non-empty icons array';
    }
    if (manifestCheck.driftMessage) {
      return manifestCheck.driftMessage;
    }
    return null;
  });

  await fetchAsset('/sw.js', (body) => {
    const trimmed = body.trim();
    if (!trimmed) {
      return 'empty service worker script';
    }
    if (/^<!doctype\s+html|^<html\b/i.test(trimmed)) {
      return 'received HTML fallback instead of JavaScript service worker';
    }
    if (input.expectedBrandkit) {
      const swDrift = checkServiceWorkerAccentDrift(body, input.expectedBrandkit);
      if (swDrift.driftMessage) {
        return swDrift.driftMessage;
      }
    }
    return null;
  });

  for (const faviconPath of ['/favicon-light.svg', '/favicon-dark.svg'] as const) {
    await fetchAsset(faviconPath, (body) => {
      if (!body.toLowerCase().includes('<svg')) {
        return 'response body does not contain an SVG document';
      }
      if (faviconPath === '/favicon-light.svg' && input.expectedBrandkit) {
        const faviconDrift = checkFaviconLightAccentDrift(body, input.expectedBrandkit);
        if (faviconDrift.driftMessage) {
          return faviconDrift.driftMessage;
        }
      }
      return null;
    });
  }

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    assets,
    violations,
  };
}

export function formatVerifyLiveTextReport(result: Omit<VerifyLiveCommandResult, 'rendered'>): string {
  const lines: string[] = [
    `Live Verification: ${result.ok ? 'PASS' : 'FAIL'}`,
    `Target:     ${result.targetUrl}`,
    `Auth Mode:  ${result.authMode}`,
    `Anon Gate:  ${result.anonymousGate.status.toUpperCase()} (${result.anonymousGate.detail})`,
    `Probe:      ${result.probe.ok ? 'PASS' : 'FAIL'} (html=${result.probe.html.status}, bundle=${result.probe.bundle.status}, plugins=${result.probe.plugins?.status ?? 'skipped'})`,
    `Privacy:    ${result.privacy.status.toUpperCase()} (mode=${result.privacy.buildMode}, living=${result.privacy.counts.livingPeople}, portraits=${result.privacy.counts.livingPortraits}, exactBirth=${result.privacy.counts.livingExactBirthdates}, spans=${result.privacy.counts.livingResidenceSpans}, media=${result.privacy.counts.livingMedia}, narratives=${result.privacy.counts.livingNarratives})`,
    `Browser:    ${result.browser.status.toUpperCase()}${result.browser.status === 'skipped' ? ' (--browser not set)' : ` (h1Visible=${result.browser.h1Visible}, pageErrors=${result.browser.pageErrors.length}, failedReq=${result.browser.failedRequests.length}, failedRes=${result.browser.failedResponses.length})`}`,
    `PWA:        ${result.pwa.status.toUpperCase()}${result.pwa.status === 'skipped' ? ' (--check-pwa not set)' : ` (${result.pwa.assets.filter((a) => a.ok).length}/${result.pwa.assets.length} assets ok)`}`,
  ];
  if (result.cleanup) {
    lines.push(
      `D1 Cleanup: PASS (backupBefore=${result.cleanup.backupCountBefore ?? 'n/a'}, backupAfter=${result.cleanup.backupCountAfter}, remainingTmp=${result.cleanup.remainingTmpCount}, deletedTokens=${result.cleanup.deletedTokenIds.length}, deletedInvites=${result.cleanup.deletedInviteTokens.length})`
    );
  }
  if (result.violations.length > 0) {
    lines.push('Violations:');
    for (const violation of result.violations) {
      lines.push(`  - ${violation}`);
    }
  }
  return lines.join('\n');
}

export async function runVerifyLiveCommand(
  options: VerifyLiveCommandOptions = {}
): Promise<VerifyLiveCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const explicitToken = options.token?.trim() || undefined;
  if (options.withTempAuth && explicitToken) {
    throw new CliValidationError('Specify either `--token` or `--with-temp-auth`, not both.');
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_LIVE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500) {
    throw new CliValidationError('Option `--timeout-ms` must be an integer >= 500.');
  }

  const expectPlugins = options.expectPlugins ?? [];
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const useEphemeralAuth = Boolean(options.withTempAuth) || (!explicitToken && hasWranglerConfig(repoDir));
  const authMode: VerifyLiveAuthMode = useEphemeralAuth
    ? 'ephemeral-d1'
    : explicitToken
      ? 'bearer-token'
      : 'anonymous';

  const runChecks = async (params: {
    readonly baseUrl: string;
    readonly bearerToken?: string | undefined;
    readonly sessionCookie?: string | undefined;
  }): Promise<Omit<VerifyLiveCommandResult, 'cleanup' | 'rendered'>> => {
    const anonymousGate = await checkAnonymousBundleGate(params.baseUrl, fetchImpl, timeoutMs);
    const probe = await runSyntheticProbe({
      targetUrl: params.baseUrl,
      token: params.bearerToken,
      timeoutMs,
      checkPlugins: true,
      expectPlugins,
      fetchImpl,
      clock: options.clock,
    });
    const privacy = await checkAuthenticatedBundlePrivacy({
      baseUrl: params.baseUrl,
      bearerToken: params.bearerToken,
      sessionCookie: params.sessionCookie,
      fetchImpl,
      timeoutMs,
    });

    const browser: VerifyLiveBrowserCheckResult = options.browser
      ? await runBrowserSmokeCheck({
          baseUrl: params.baseUrl,
          bearerToken: params.bearerToken,
          sessionCookie: params.sessionCookie,
          timeoutMs,
          browserFactory: options.browserFactory,
        })
      : {
          status: 'skipped',
          url: `${params.baseUrl}/`,
          h1Visible: false,
          h1Text: '',
          pageErrors: [],
          failedRequests: [],
          failedResponses: [],
          violations: [],
        };

    const expectedBrandkit = options.checkPwa ? tryLoadExpectedBrandkitProfile(repoDir) : null;
    const pwa: VerifyLivePwaCheckResult = options.checkPwa
      ? await runPwaChecks({
          baseUrl: params.baseUrl,
          bearerToken: params.bearerToken,
          sessionCookie: params.sessionCookie,
          fetchImpl,
          timeoutMs,
          expectedBrandkit,
        })
      : {
          status: 'skipped',
          assets: [],
          violations: [],
        };

    const violations = [
      ...anonymousGate.violations,
      ...probe.violations,
      ...privacy.violations,
      ...browser.violations,
      ...pwa.violations,
    ];

    return {
      ok: violations.length === 0,
      targetUrl: params.baseUrl,
      authMode,
      anonymousGate,
      probe,
      privacy,
      browser,
      pwa,
      violations,
    };
  };

  let coreResult: Omit<VerifyLiveCommandResult, 'cleanup' | 'rendered'>;
  let cleanup: EphemeralAuthCleanupSummary | null = null;

  if (useEphemeralAuth) {
    const wrapped = await withEphemeralD1Auth(
      {
        repoDir,
        urlOverride: options.url,
        wranglerBin: options.wranglerBin,
        execWrangler: options.execWrangler,
        agentTokenScopes: ['read_backup'],
        mintInvite: Boolean(options.browser),
        tokenLabel: 'tmp-kinloom-verify-live',
        inviteLabel: 'tmp-kinloom-verify-live-invite',
        createdBy: 'kinloom verify-live',
        backupTokenLabel: options.backupTokenLabel,
        signalTarget: options.signalTarget,
        onSignalAfterCleanup: options.onSignalAfterCleanup,
      },
      async (auth) => {
        const resolvedUrl = options.url?.trim()
          ? normalizeSiteUrl(options.url).baseUrl
          : (auth.baseUrl ?? '');
        if (!resolvedUrl) {
          throw new CliValidationError(
            'Missing target URL. Pass `--url <url>` or configure `routes[0].pattern` in wrangler config.'
          );
        }
        const bearerToken = auth.agentTokens.read_backup?.rawToken;
        let sessionCookie: string | undefined;
        if (options.browser && auth.invite) {
          sessionCookie = await redeemEphemeralInviteSession({
            baseUrl: resolvedUrl,
            inviteToken: auth.invite.token,
            fetchImpl,
            timeoutMs,
          });
        }
        return runChecks({ baseUrl: resolvedUrl, bearerToken, sessionCookie });
      }
    );
    coreResult = wrapped.value;
    cleanup = wrapped.cleanup;
  } else {
    if (!options.url?.trim()) {
      throw new CliValidationError(
        'Missing target URL. Pass `--url <url>` or run inside an archive directory with a wrangler config.'
      );
    }
    const baseUrl = normalizeSiteUrl(options.url).baseUrl;
    coreResult = await runChecks({ baseUrl, bearerToken: explicitToken });
  }

  const fullWithoutRendered: Omit<VerifyLiveCommandResult, 'rendered'> = {
    ...coreResult,
    cleanup,
  };
  const rendered = options.json
    ? `${JSON.stringify(fullWithoutRendered, null, 2)}\n`
    : formatVerifyLiveTextReport(fullWithoutRendered);

  return {
    ...fullWithoutRendered,
    rendered,
  };
}

export { parseExpectedPluginsCsv };
