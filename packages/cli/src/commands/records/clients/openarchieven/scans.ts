import { isPrivateOrReservedIp, SsrfBlockedError } from '../../runtime/http.js';

export const ALLOWED_API_HOSTS: ReadonlySet<string> = new Set(['api.openarch.nl']);

const PROXY_THUMB_RE = /^https?:\/\/proxy\.archieven\.nl\/thumb\/([^/?#]+)\/([^/?#]+)(?:[?#].*)?$/i;
const IIIF_INFO_RE = /^(https?:\/\/.+)\/info\.json(?:[?#].*)?$/i;
const IIIF_JP2_RE = /^(https?:\/\/.+\/full\/[^/?#]+\/[^/?#]+\/default)\.jp2(?:[?#].*)?$/i;

const VIEWER_HOSTS: ReadonlySet<string> = new Set([
  'www.archieven.nl',
  'archieven.nl',
  'www.zeeuwsarchief.nl',
  'zeeuwsarchief.nl',
  'www.zeeuwengezocht.nl',
  'zeeuwengezocht.nl',
  'hdl.handle.net',
  'collectie-delft.nl',
  'www.collectie-delft.nl',
  'allefriezen.nl',
  'www.allefriezen.nl',
  'westbrabantsarchief.nl',
  'www.westbrabantsarchief.nl',
  'stadsarchief.rotterdam.nl',
  'www.stadsarchief.rotterdam.nl',
  'hetutrechtsarchief.nl',
  'www.hetutrechtsarchief.nl',
  'www.bhic.nl',
  'bhic.nl',
  'www.allegroningers.nl',
  'allegroningers.nl',
]);

export function validateApiUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(url, `Refusing invalid API URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(url, `Refusing non-HTTPS API URL: ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError(url, 'Refusing API URL containing embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!ALLOWED_API_HOSTS.has(host)) {
    const allowed = Array.from(ALLOWED_API_HOSTS).toSorted().join(', ');
    throw new SsrfBlockedError(url, `Refusing API host '${host}'; allowed hosts: ${allowed}.`);
  }
  return url;
}

export function validateScanUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError(url, `Refusing to download a scan URL that is not http or https: ${url}`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new SsrfBlockedError(url, `Refusing to download a scan URL that is not http or https: ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new SsrfBlockedError(url, 'Refusing scan URL containing embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new SsrfBlockedError(url, `Refusing local or private scan host '${host}': ${url}`);
  }
  if (isPrivateOrReservedIp(host)) {
    throw new SsrfBlockedError(url, `Refusing private or reserved IP scan host '${host}': ${url}`);
  }
  return url;
}

export function isViewerUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (VIEWER_HOSTS.has(host)) {
    return true;
  }
  return host === 'sgen.schiedam.nl' && !parsed.pathname.toLowerCase().startsWith('/scans/');
}

export function deriveProxyDownloadUrl(url: string): string | undefined {
  if (!url) {
    return undefined;
  }
  const match = PROXY_THUMB_RE.exec(url.trim());
  if (!match) {
    return undefined;
  }
  return `https://proxy.archieven.nl/download/${match[1]}/${match[2]}`;
}

export function deriveIiifJpegUrl(url: string): string | undefined {
  if (!url) {
    return undefined;
  }
  const cleaned = url.trim();
  const infoMatch = IIIF_INFO_RE.exec(cleaned);
  if (infoMatch) {
    return `${infoMatch[1]}/full/full/0/default.jpg`;
  }
  const jp2Match = IIIF_JP2_RE.exec(cleaned);
  if (jp2Match) {
    return `${jp2Match[1]}.jpg`;
  }
  return undefined;
}

export function buildDirectScanCandidates(
  directUrl: string,
  preview: boolean
): readonly (readonly [string, boolean])[] {
  const candidates: (readonly [string, boolean])[] = [];
  const iiifJpg = deriveIiifJpegUrl(directUrl);
  if (iiifJpg) {
    candidates.push([iiifJpg, true]);
  }
  const proxyFull = deriveProxyDownloadUrl(directUrl);
  if (proxyFull && !preview) {
    candidates.push([proxyFull, true]);
  }
  candidates.push([directUrl, false]);
  return candidates;
}

function appendUniqueUrl(items: string[], candidate: string | undefined): void {
  if (!candidate) {
    return;
  }
  const cleaned = candidate.trim();
  if (cleaned && !items.includes(cleaned)) {
    items.push(cleaned);
  }
}

export class ScanImage {
  readonly index: number;
  readonly order: number | null;
  readonly label: string;
  readonly uri: string;
  readonly uriPreview: string;

  constructor(index: number, order: number | null, label: string, uri: string, uriPreview: string) {
    this.index = index;
    this.order = order;
    this.label = label;
    this.uri = uri;
    this.uriPreview = uriPreview;
  }

  chosenUrl(preview: boolean): string {
    if (preview) {
      return this.uriPreview || this.uri;
    }
    return this.uri || this.uriPreview;
  }

  candidateUrls(preview: boolean): readonly (readonly [string, boolean])[] {
    if (preview) {
      const urls: string[] = [];
      appendUniqueUrl(urls, this.uriPreview);
      appendUniqueUrl(urls, this.uri);
      return urls.map((u) => [u, false] as const);
    }

    const proxyFull = deriveProxyDownloadUrl(this.uriPreview) ?? deriveProxyDownloadUrl(this.uri);
    const iiifJpg = deriveIiifJpegUrl(this.uri);
    const candidates: (readonly [string, boolean])[] = [];
    const seen = new Set<string>();

    const add = (url: string | undefined, fallbackOn5xx: boolean): void => {
      if (!url) {
        return;
      }
      const cleaned = url.trim();
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        candidates.push([cleaned, fallbackOn5xx] as const);
      }
    };

    if (this.uri && isViewerUrl(this.uri) && (proxyFull || this.uriPreview)) {
      add(proxyFull, true);
      add(this.uriPreview, false);
      return candidates;
    }

    add(iiifJpg, true);
    add(this.uri, false);
    add(proxyFull, true);
    add(this.uriPreview, false);
    return candidates;
  }
}

export function scanFilename(archive: string, identifier: string, index: number, ext: string): string {
  const short =
    identifier
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 8)
      .toLowerCase() || 'record';
  const safeArchive = archive.replace(/[^A-Za-z0-9_-]/g, '').toLowerCase() || 'archive';
  const safeExt = ext.replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'img';
  return `${safeArchive}-${short}-scan-${String(index).padStart(2, '0')}.${safeExt}`;
}
