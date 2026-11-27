import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import {
  HTML_ERROR_PREFIXES,
  hasControlChar,
  hasMagicPrefix,
  PDF_MAGIC,
  resolveSafeChildPath,
  stripLeadingBomAndWs,
} from '../../runtime/primitives.js';
import { RecordRuntimeError } from '../../runtime/types.js';
import {
  CATALOG_API_BASE,
  CATALOG_RECORD_URL_RE,
  CATALOG_WEB_BASE,
  DEFAULT_QUERY_TTL_HOURS,
  HTML_EXTENSIONS,
  NARA_BUCKET_HOST_RE,
  NARA_PATH_PREFIXES,
  S3_PATH_HOST_RE,
  VALID_LEVELS,
} from './types.js';

export function quotePythonStyle(value: string, safeSlash = true): string {
  let encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  if (safeSlash) {
    encoded = encoded.replace(/%2F/g, '/');
  }
  return encoded;
}

export function hasParentTraversal(rawPath: string): boolean {
  return rawPath.split(/[\\/]/).includes('..');
}

export function resolveUserPath(rawPath: string, cwd: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.join(cwd, rawPath);
}

export function resolveQueryTtlHours(cliTtl: number | undefined, env: NodeJS.ProcessEnv): number {
  if (cliTtl !== undefined) {
    if (!Number.isFinite(cliTtl) || cliTtl < 0) {
      throw new CliValidationError(`Invalid --cache-ttl-hours value: ${String(cliTtl)} (must be >= 0).`);
    }
    return cliTtl;
  }
  const raw = env.KINLOOM_NARA_QUERY_TTL_HOURS;
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed)) {
      throw new CliValidationError(`Invalid KINLOOM_NARA_QUERY_TTL_HOURS value: '${raw}'.`);
    }
    if (parsed < 0) {
      throw new CliValidationError(`Invalid KINLOOM_NARA_QUERY_TTL_HOURS value: '${raw}' (must be >= 0).`);
    }
    return parsed;
  }
  return DEFAULT_QUERY_TTL_HOURS;
}

export function validateNaid(naid: string): string {
  const raw = String(naid).trim();
  if (!raw || raw.includes('\0') || raw.includes('..')) {
    throw new CliValidationError(`Invalid NAID: '${naid}'`);
  }
  const urlMatch = CATALOG_RECORD_URL_RE.exec(raw);
  if (urlMatch) {
    return urlMatch[1];
  }
  if (raw.includes('/') || raw.includes('\\')) {
    throw new CliValidationError(`Invalid NAID: '${naid}'`);
  }
  const match = /^(?:NAID[\s:-]*)?(\d+)$/i.exec(raw);
  if (!match) {
    throw new CliValidationError(`Invalid NAID (expected digits): '${naid}'`);
  }
  return match[1];
}

export function isDirectDownloadUrl(raw: string): boolean {
  const text = String(raw).trim();
  if (CATALOG_RECORD_URL_RE.test(text)) {
    return false;
  }
  const lower = text.toLowerCase();
  return lower.startsWith('https://') || lower.startsWith('http://');
}

export function validateNaraDownloadUrl(rawUrl: string): string {
  const text = String(rawUrl).trim();
  if (!text || text.includes('\0') || hasControlChar(text)) {
    throw new RecordRuntimeError(`Invalid download URL: '${rawUrl}'`);
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new RecordRuntimeError(`Invalid download URL: '${rawUrl}'`);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    !host ||
    (parsed.port !== '' && parsed.port !== '443') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new RecordRuntimeError(`Refusing non-HTTPS or disallowed download URL: ${text}`);
  }
  const pathLower = parsed.pathname.toLowerCase();
  const allowed =
    host === 'archives.gov' ||
    host.endsWith('.archives.gov') ||
    NARA_BUCKET_HOST_RE.test(host) ||
    (S3_PATH_HOST_RE.test(host) && NARA_PATH_PREFIXES.some((prefix) => pathLower.startsWith(prefix)));
  if (!allowed) {
    throw new RecordRuntimeError(`Refusing download from disallowed host '${host}': ${text}`);
  }
  return text;
}

export function safeObjectFilename(pageNum: number, rawName: string | null | undefined): string {
  if (!Number.isInteger(pageNum) || pageNum < 1) {
    throw new RangeError(`Invalid page number: ${String(pageNum)}`);
  }
  const candidate = (rawName ?? '').replace(/\\/g, '/');
  const slashIdx = candidate.lastIndexOf('/');
  const base = (slashIdx === -1 ? candidate : candidate.slice(slashIdx + 1)).trim();
  let safeBase: string;
  if (!base || base === '.' || base === '..' || base.includes('\0')) {
    safeBase = `${pageNum}.bin`;
  } else {
    safeBase = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
    if (!safeBase || safeBase === '.' || safeBase === '..') {
      safeBase = `${pageNum}.bin`;
    }
  }
  return `${String(pageNum).padStart(3, '0')}_${safeBase}`;
}

export function resolveSafeChild(root: string, filename: string): string {
  return resolveSafeChildPath(root, filename, {
    errorFactory: (msg) => new RangeError(msg),
  });
}

export function detectErrorPayload(head: Buffer, contentType: string, filenameHint = ''): string | null {
  const ext = filenameHint ? path.extname(filenameHint).toLowerCase() : '';
  if (HTML_EXTENSIONS.has(ext)) {
    return null;
  }
  const ctLower = (contentType || '').toLowerCase();
  if (ctLower.includes('text/html') || ctLower.includes('application/xhtml')) {
    return `HTML response (${contentType})`;
  }
  const sample = stripLeadingBomAndWs(head, 512);
  if (HTML_ERROR_PREFIXES.some((prefix) => sample.startsWith(prefix))) {
    return 'HTML error page';
  }
  if (sample.startsWith('<?xml') && sample.includes('<error>')) {
    return 'S3 XML error response';
  }
  if (ext === '.pdf' && !hasMagicPrefix(head, PDF_MAGIC)) {
    return 'non-PDF payload';
  }
  return null;
}

export function normalizeQueryForWafRetry(query: string): string | null {
  let stripped = query.replace(/"/g, ' ');
  stripped = stripped.replace(/\bAND\b/g, ' ');
  const normalized = stripped.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized === query.trim()) {
    return null;
  }
  return normalized;
}

export function buildQueryParams(
  query: string | null | undefined,
  options: {
    readonly levels?: readonly string[];
    readonly recordGroups?: readonly string[];
    readonly online?: boolean;
    readonly materialType?: string;
    readonly person?: string;
    readonly title?: string;
    readonly geo?: string;
    readonly control?: string;
    readonly series?: string;
    readonly startDate?: string;
    readonly endDate?: string;
    readonly page?: number;
    readonly limit?: number;
    readonly forApi?: boolean;
  } = {}
): [string, string][] {
  const page = options.page ?? 1;
  const limit = options.limit ?? 20;
  const forApi = options.forApi ?? false;
  const params: [string, string][] = [];

  const rawSeries = options.series?.trim() || null;
  let effectiveStartDate = options.startDate ?? null;
  let effectiveEndDate = options.endDate ?? null;
  let effectiveControl = options.control ?? null;
  let effectiveTitle = options.title ?? null;
  let seriesNaId: string | null = null;
  let extraQuerySeries: string | null = null;

  if (rawSeries) {
    if (/^\d{4}$/.test(rawSeries)) {
      effectiveStartDate ??= rawSeries;
      effectiveEndDate ??= rawSeries;
    } else if (/^[A-Za-z]\d{2,5}$/.test(rawSeries)) {
      if (!effectiveControl) {
        effectiveControl = rawSeries.toUpperCase();
      } else {
        extraQuerySeries = rawSeries;
      }
    } else if (/^\d{5,}$/.test(rawSeries)) {
      seriesNaId = rawSeries;
    } else if (!effectiveTitle) {
      effectiveTitle = rawSeries;
    } else {
      extraQuerySeries = rawSeries;
    }
  }

  const combinedQuery =
    query && extraQuerySeries ? `${query} ${extraQuerySeries}` : query || extraQuerySeries;

  if (combinedQuery) {
    params.push(['q', combinedQuery]);
  }
  if (effectiveTitle) {
    params.push(['title', effectiveTitle]);
  }
  if (options.person) {
    params.push(['personOrOrg', options.person]);
  }
  if (options.geo) {
    params.push(['geographicReference', options.geo]);
  }
  if (effectiveControl) {
    params.push(['controlNumbers', effectiveControl]);
  }
  if (seriesNaId) {
    params.push(['ancestorNaIds', seriesNaId]);
  }
  if (options.levels && options.levels.length > 0) {
    const flat = options.levels
      .flatMap((item) => item.split(','))
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const validSet: ReadonlySet<string> = new Set(VALID_LEVELS);
    const invalid = flat.filter((lv) => !validSet.has(lv));
    if (invalid.length > 0) {
      throw new CliValidationError(
        `Invalid level(s): ${invalid.join(', ')}. Choose from: ${VALID_LEVELS.join(', ')}`
      );
    }
    if (flat.length > 0) {
      params.push(['levelOfDescription', flat.join(',')]);
    }
  }
  if (options.recordGroups && options.recordGroups.length > 0) {
    const flatRg = options.recordGroups
      .flatMap((item) => item.split(','))
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (flatRg.length > 0) {
      params.push(['recordGroupNumber', flatRg.join(',')]);
    }
  }
  if (options.online) {
    params.push(['availableOnline', 'true']);
    if (!forApi) {
      params.push(['dataSource', 'description']);
    }
  }
  if (options.materialType) {
    params.push(['typeOfMaterials', options.materialType]);
  }
  if (effectiveStartDate) {
    params.push(['startDate', effectiveStartDate]);
  }
  if (effectiveEndDate) {
    params.push(['endDate', effectiveEndDate]);
  }
  if (page > 1 || forApi) {
    params.push(['page', String(page)]);
  }
  if (forApi || limit !== 20) {
    params.push(['limit', String(limit)]);
  }
  return params;
}

export function encodeCatalogUrl(params: readonly (readonly [string, string])[], forApi = false): string {
  const base = forApi ? `${CATALOG_API_BASE}/records/search` : `${CATALOG_WEB_BASE}/search`;
  if (params.length === 0) {
    return base;
  }
  const qs = params.map(([k, v]) => `${quotePythonStyle(k, true)}=${quotePythonStyle(v, true)}`).join('&');
  return `${base}?${qs}`;
}

export function parsePageSpec(spec: string | null | undefined, total: number): number[] {
  if (total <= 0) {
    return [];
  }
  if (!spec || spec.trim().toLowerCase() === 'all') {
    return Array.from({ length: total }, (_v, idx) => idx + 1);
  }
  const chosen = new Set<number>();
  for (const rawPart of spec.split(',')) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    const dashIdx = part.indexOf('-');
    if (dashIdx !== -1) {
      const aStr = part.slice(0, dashIdx).trim();
      const bStr = part.slice(dashIdx + 1).trim();
      if ((aStr && !/^\d+$/.test(aStr)) || (bStr && !/^\d+$/.test(bStr))) {
        throw new CliValidationError(`Invalid page range '${part}'.`);
      }
      let a = aStr ? Number.parseInt(aStr, 10) : 1;
      let b = bStr ? Number.parseInt(bStr, 10) : total;
      if (a > b) {
        [a, b] = [b, a];
      }
      const start = Math.max(1, a);
      const end = Math.min(total, b);
      for (let p = start; p <= end; p += 1) {
        chosen.add(p);
      }
    } else {
      if (!/^\d+$/.test(part)) {
        throw new CliValidationError(`Invalid page number '${part}'.`);
      }
      const idx = Number.parseInt(part, 10);
      if (idx >= 1 && idx <= total) {
        chosen.add(idx);
      }
    }
  }
  return Array.from(chosen).toSorted((x, y) => x - y);
}
