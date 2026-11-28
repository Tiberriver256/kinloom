import type {
  ArchiveBundle,
  ArchiveCapabilities,
  ArchiveDataSource,
  ArchiveSessionState,
  MediaChecklistItem,
  OnboardingSessionResponse,
  ReadingsBundle,
} from '@kinloom/core';
import {
  createDefaultOnboardingSessionResponse,
  tryValidateArchiveBundle,
  tryValidateMediaChecklistItems,
  tryValidateReadingsBundle,
} from '@kinloom/core';

declare global {
  var __KINLOOM_ARCHIVE_PROMISE__: Promise<Response> | null | undefined;
}

const STATIC_ANONYMOUS_SESSION: ArchiveSessionState = {
  authenticated: false,
  principal_kind: 'anonymous',
};

const STATIC_READONLY_CAPABILITIES: ArchiveCapabilities = {
  canEdit: false,
  canUploadMedia: false,
  hasRevisionHistory: false,
  hasTalk: false,
  canManageSite: false,
};

function normalizeBaseUrl(raw?: string): string {
  const envBase = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL : undefined;
  const fallback = raw || envBase || '/';
  return fallback.endsWith('/') ? fallback : `${fallback}/`;
}

/**
 * Read-only ArchiveDataSource for static deployments (examples/demo and GitHub Pages).
 */
export class StaticDemoDataSource implements ArchiveDataSource {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl?: string, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
  }

  async loadArchive(): Promise<{
    bundle: ArchiveBundle;
    etag: string | null;
    notModified: boolean;
  }> {
    const preloaded = globalThis.__KINLOOM_ARCHIVE_PROMISE__;
    let res: Response | null = null;
    if (preloaded) {
      globalThis.__KINLOOM_ARCHIVE_PROMISE__ = null;
      try {
        const candidate = await preloaded;
        if (candidate.ok) {
          res = candidate;
        }
      } catch {
        res = null;
      }
    }
    if (!res) {
      res = await this.fetchImpl(`${this.baseUrl}data/archive.json`);
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} loading archive.json`);
    }
    const raw: unknown = await res.json();
    const fast = tryValidateArchiveBundle(raw);
    if (fast !== null) {
      return {
        bundle: fast,
        etag: res.headers.get('etag'),
        notModified: false,
      };
    }
    const { ArchiveBundleSchema } = await import('@kinloom/core/schemas');
    const bundle = ArchiveBundleSchema.parse(raw);
    return {
      bundle,
      etag: res.headers.get('etag'),
      notModified: false,
    };
  }

  async loadReadings(): Promise<ReadingsBundle | null> {
    const res = await this.fetchImpl(`${this.baseUrl}data/readings.json`);
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} loading readings.json`);
    }
    const raw: unknown = await res.json();
    const fast = tryValidateReadingsBundle(raw);
    if (fast !== null) {
      return fast;
    }
    const { ReadingsBundleSchema } = await import('@kinloom/core/schemas');
    return ReadingsBundleSchema.parse(raw);
  }

  async loadMediaChecklist(): Promise<MediaChecklistItem[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}data/media-checklist.json`);
    } catch {
      return [];
    }
    if (!res.ok) {
      return [];
    }
    const raw: unknown = await res.json();
    if (typeof raw !== 'object' || raw === null || !('items' in raw) || !Array.isArray(raw.items)) {
      throw new Error('Invalid media-checklist.json payload: expected object with items array');
    }
    const fast = tryValidateMediaChecklistItems(raw.items);
    if (fast !== null) {
      return fast;
    }
    const { MediaChecklistItemSchema } = await import('@kinloom/core/schemas');
    return raw.items.map((item) => MediaChecklistItemSchema.parse(item));
  }

  async getSession(): Promise<{
    session: ArchiveSessionState;
    capabilities: ArchiveCapabilities;
  }> {
    return {
      session: { ...STATIC_ANONYMOUS_SESSION },
      capabilities: { ...STATIC_READONLY_CAPABILITIES },
    };
  }

  async getOnboardingState(): Promise<OnboardingSessionResponse> {
    return createDefaultOnboardingSessionResponse();
  }
}

export function createStaticArchiveDataSource(baseUrl?: string, fetchImpl?: typeof fetch): ArchiveDataSource {
  return new StaticDemoDataSource(baseUrl, fetchImpl);
}
