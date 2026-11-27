import { CliValidationError } from '../../../errors.js';
import type {
  AuthHeader,
  IncludeScope,
  ScreenshotCategory,
  ScreenshotCookieSpec,
  ScreenshotTheme,
  ViewportSpec,
} from './types.js';

export const DEFAULT_OUT_DIR = './kinloom-screenshots';
export const DEFAULT_WAIT_MS = 350;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 8;
export const DEFAULT_SAMPLE_PEOPLE = 1;
export const DEFAULT_SAMPLE_PLACES = 1;

export const PRESET_VIEWPORTS: Readonly<Record<string, ViewportSpec>> = Object.freeze({
  mobile: Object.freeze({ name: 'mobile', width: 390, height: 844 }),
  tablet: Object.freeze({ name: 'tablet', width: 768, height: 1024 }),
  desktop: Object.freeze({ name: 'desktop', width: 1440, height: 900 }),
});

export const DEFAULT_VIEWPORTS: readonly ViewportSpec[] = Object.freeze([
  PRESET_VIEWPORTS.mobile,
  PRESET_VIEWPORTS.tablet,
  PRESET_VIEWPORTS.desktop,
]);

export const DEFAULT_THEMES: readonly ScreenshotTheme[] = Object.freeze(['light', 'dark']);

export const DEFAULT_INCLUDE: readonly IncludeScope[] = Object.freeze(['pages', 'components', 'plugins']);

const SENSITIVE_QUERY_KEYS = new Set([
  'token',
  'access_token',
  'auth',
  'key',
  'api_key',
  'apikey',
  'secret',
  'code',
  'session',
  'cookie',
  'password',
  'sig',
  'signature',
]);

export function sanitizeSlug(raw: string, fallback = 'item'): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 80) : fallback;
}

export function validateTargetBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CliValidationError('Missing required option `--url`.');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CliValidationError(`Invalid \`--url\` value '${raw}'. Expected an http:// or https:// URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliValidationError(
      `Unsupported URL protocol '${parsed.protocol}'. Only http:// and https:// URLs are supported.`
    );
  }
  if (parsed.username || parsed.password) {
    throw new CliValidationError(
      'Embedded credentials in `--url` are not allowed. Use `--auth-cookie` or `--auth-header` instead.'
    );
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${cleanPath}`;
}

export function normalizeRoutePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CliValidationError('Route path cannot be empty.');
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    throw new CliValidationError(`Route '${raw}' must be a relative path starting with '/'.`);
  }
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutHash = withSlash.split('#')[0];
  const [pathnamePart, queryPart] = withoutHash.split('?');
  const collapsedPath = pathnamePart.replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
  return queryPart ? `${collapsedPath}?${queryPart}` : collapsedPath;
}

export function routeToSlug(route: string): string {
  const pathOnly = route.split('?')[0];
  if (pathOnly === '/' || pathOnly === '') {
    return 'home';
  }
  return sanitizeSlug(pathOnly.replace(/^\/+/, '').replace(/\//g, '-'), 'page');
}

export function parseViewportsOption(raw: string): readonly ViewportSpec[] {
  const tokens = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new CliValidationError('Option `--viewports` must list at least one viewport.');
  }
  const result: ViewportSpec[] = [];
  const seenNames = new Set<string>();
  for (const token of tokens) {
    const preset = PRESET_VIEWPORTS[token.toLowerCase()];
    if (preset) {
      if (!seenNames.has(preset.name)) {
        seenNames.add(preset.name);
        result.push(preset);
      }
      continue;
    }
    const match = /^([a-zA-Z0-9_-]+):(\d+)x(\d+)$/.exec(token);
    if (!match) {
      throw new CliValidationError(
        `Invalid viewport '${token}'. Expected preset (mobile, tablet, desktop) or '<name>:<width>x<height>'.`
      );
    }
    const name = sanitizeSlug(match[1], 'viewport');
    const width = Number.parseInt(match[2], 10);
    const height = Number.parseInt(match[3], 10);
    if (width < 200 || width > 7680 || height < 200 || height > 7680) {
      throw new CliValidationError(`Viewport '${token}' dimensions must be between 200 and 7680 pixels.`);
    }
    if (seenNames.has(name)) {
      throw new CliValidationError(`Duplicate viewport name '${name}' in \`--viewports\`.`);
    }
    seenNames.add(name);
    result.push({ name, width, height });
  }
  return result;
}

export function parseThemesOption(raw: string): readonly ScreenshotTheme[] {
  const tokens = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new CliValidationError('Option `--themes` must include `light`, `dark`, or both.');
  }
  const themes: ScreenshotTheme[] = [];
  for (const token of tokens) {
    if (token !== 'light' && token !== 'dark') {
      throw new CliValidationError(`Unknown theme '${token}'. Expected \`light\` or \`dark\`.`);
    }
    if (!themes.includes(token)) {
      themes.push(token);
    }
  }
  return themes;
}

export function parseIncludeOption(raw: string): readonly IncludeScope[] {
  const tokens = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new CliValidationError('Option `--include` must list at least one of: pages, components, plugins.');
  }
  const scopes: IncludeScope[] = [];
  for (const token of tokens) {
    if (token !== 'pages' && token !== 'components' && token !== 'plugins') {
      throw new CliValidationError(
        `Unknown include scope '${token}'. Expected \`pages\`, \`components\`, or \`plugins\`.`
      );
    }
    if (!scopes.includes(token)) {
      scopes.push(token);
    }
  }
  return scopes;
}

export function parseRouteList(rawValues: readonly string[]): readonly string[] {
  const routes: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawValues) {
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }
      const normalized = normalizeRoutePath(trimmed);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        routes.push(normalized);
      }
    }
  }
  return routes;
}

export function parseAuthHeader(raw: string): AuthHeader {
  if (/[\r\n]/.test(raw)) {
    throw new CliValidationError('Option `--auth-header` must not contain CR or LF characters.');
  }
  const colonIdx = raw.indexOf(':');
  if (colonIdx <= 0) {
    throw new CliValidationError('Option `--auth-header` must be formatted as `Header-Name: value`.');
  }
  const name = raw.slice(0, colonIdx).trim();
  const value = raw.slice(colonIdx + 1).trim();
  if (!name || !value || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new CliValidationError('Option `--auth-header` has an invalid HTTP header name or empty value.');
  }
  return { name, value };
}

export function parseAuthCookieSpecs(
  cookieHeader: string,
  targetBaseUrl: string
): readonly ScreenshotCookieSpec[] {
  if (/[\r\n]/.test(cookieHeader)) {
    throw new CliValidationError('Option `--auth-cookie` must not contain CR or LF characters.');
  }
  const originUrl = new URL(targetBaseUrl).origin;
  const specs: ScreenshotCookieSpec[] = [];
  for (const pair of cookieHeader.split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) {
      continue;
    }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) {
      throw new CliValidationError('Option `--auth-cookie` entries must be formatted as `name=value`.');
    }
    const name = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!name) {
      throw new CliValidationError('Option `--auth-cookie` contains an empty cookie name.');
    }
    specs.push({ name, value, url: originUrl });
  }
  if (specs.length === 0) {
    throw new CliValidationError('Option `--auth-cookie` must include at least one `name=value` pair.');
  }
  return specs;
}

export function buildScreenshotRelativePath(input: {
  readonly category: ScreenshotCategory;
  readonly slug: string;
  readonly state?: string;
  readonly viewport: string;
  readonly theme: ScreenshotTheme;
}): string {
  const safeSlug = sanitizeSlug(input.slug, 'item');
  const safeViewport = sanitizeSlug(input.viewport, 'viewport');
  const fileName = `${safeViewport}-${input.theme}.png`;
  if (input.category === 'page') {
    return `pages/${safeSlug}/${fileName}`;
  }
  if (input.category === 'component') {
    const safeState = sanitizeSlug(input.state ?? 'default', 'default');
    return `components/${safeSlug}/${safeState}/${fileName}`;
  }
  return `plugins/${safeSlug}/${fileName}`;
}

export function sanitizeUrlForReport(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl.replace(/(token|secret|auth|cookie|key)=[^&\s]+/gi, '$1=[redacted]');
  }
}

export function buildAuthRequestHeaders(options: {
  readonly authCookie?: string;
  readonly authHeaders?: readonly AuthHeader[];
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.authHeaders) {
    for (const header of options.authHeaders) {
      headers[header.name] = header.value;
    }
  }
  if (options.authCookie?.trim()) {
    headers.Cookie = options.authCookie.trim();
  }
  return headers;
}
