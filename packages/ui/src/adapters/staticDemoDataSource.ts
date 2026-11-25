import type {
  ArchiveBundle,
  ArchiveDataSource,
  MediaChecklistItem,
  ReadingsBundle,
} from '@kinloom/core';
import { ArchiveBundleSchema, ReadingsBundleSchema } from '@kinloom/core';

function normalizeBaseUrl(raw?: string): string {
  const envBase = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL : undefined;
  const fallback = raw || envBase || '/';
  return fallback.endsWith('/') ? fallback : `${fallback}/`;
}

function isMediaChecklistResponse(data: unknown): data is { items: MediaChecklistItem[] } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'items' in data &&
    Array.isArray((data as { items: unknown }).items)
  );
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
    const res = await this.fetchImpl(`${this.baseUrl}data/archive.json`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} loading archive.json`);
    }
    const raw: unknown = await res.json();
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
    return ReadingsBundleSchema.parse(raw);
  }

  async loadMediaChecklist(): Promise<MediaChecklistItem[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}data/media-checklist.json`);
      if (!res.ok) {
        return [];
      }
      const raw: unknown = await res.json();
      return isMediaChecklistResponse(raw) ? raw.items : [];
    } catch {
      return [];
    }
  }
}

export function createStaticArchiveDataSource(
  baseUrl?: string,
  fetchImpl?: typeof fetch,
): ArchiveDataSource {
  return new StaticDemoDataSource(baseUrl, fetchImpl);
}
