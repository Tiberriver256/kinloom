import type {
  ArchiveBundle,
  ArchiveDataSource,
  ArchiveSessionState,
  ArchiveCapabilities as CoreArchiveCapabilities,
  MediaChecklistItem,
  Pronunciation,
  ReadingsBundle,
} from '@kinloom/core';
import { ArchiveBundleSchema, ReadingsBundleSchema, resolveCapabilities } from '@kinloom/core';

export interface ArchiveDataLoader {
  loadArchive: () => Promise<ArchiveBundle>;
  loadReadings: () => Promise<ReadingsBundle | null>;
  loadMediaChecklist?: () => Promise<MediaChecklistItem[]>;
}

/**
 * Backward-compatible session shape accepted by KinloomApp / ArchiveDataProvider.
 */
export interface ArchiveSession {
  authenticated: boolean;
  principal_kind?: 'anonymous' | 'invite_viewer' | 'user';
  email?: string;
  displayName?: string;
  role?: 'admin' | 'editor' | 'viewer';
  inviteLabel?: string;
}

export interface ArchiveCapabilities {
  canEdit: boolean;
  canUploadMedia: boolean;
  hasRevisionHistory: boolean;
  hasTalk: boolean;
  canManageSite: boolean;
}

export const DEFAULT_ARCHIVE_CAPABILITIES: CoreArchiveCapabilities = {
  canEdit: false,
  canUploadMedia: false,
  hasRevisionHistory: false,
  hasTalk: false,
  canManageSite: false,
};

export function normalizeBaseUrl(raw?: string): string {
  const envBase = typeof import.meta !== 'undefined' ? import.meta.env?.BASE_URL : undefined;
  const fallback = raw || envBase || '/';
  return fallback.endsWith('/') ? fallback : `${fallback}/`;
}

export function isMediaChecklistResponse(data: unknown): data is { items: MediaChecklistItem[] } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'items' in data &&
    Array.isArray((data as { items: unknown }).items)
  );
}

export function isPronunciationsResponse(
  data: unknown
): data is { pronunciations: Record<string, Pronunciation> } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'pronunciations' in data &&
    typeof (data as { pronunciations: unknown }).pronunciations === 'object' &&
    (data as { pronunciations: unknown }).pronunciations !== null &&
    !Array.isArray((data as { pronunciations: unknown }).pronunciations)
  );
}

export function normalizeSessionProp(session: ArchiveSession | null | undefined): ArchiveSessionState | null {
  if (!session) {
    return null;
  }
  const inferredKind: ArchiveSessionState['principal_kind'] =
    session.principal_kind ??
    (session.authenticated ? 'user' : session.role === 'viewer' ? 'invite_viewer' : 'anonymous');
  return {
    authenticated: session.authenticated,
    principal_kind: inferredKind,
    email: session.email,
    displayName: session.displayName,
    role: session.role,
    inviteLabel: session.inviteLabel,
  };
}

export function normalizeCapabilities(
  caps: Partial<ArchiveCapabilities> | undefined,
  session: ArchiveSessionState | null
): CoreArchiveCapabilities {
  if (!caps) {
    return session ? resolveCapabilities(session) : DEFAULT_ARCHIVE_CAPABILITIES;
  }
  return {
    canEdit: caps.canEdit ?? false,
    canUploadMedia: caps.canUploadMedia ?? false,
    hasRevisionHistory: caps.hasRevisionHistory ?? false,
    hasTalk: caps.hasTalk ?? false,
    canManageSite: caps.canManageSite ?? false,
  };
}

export function wrapLegacyLoader(loader: ArchiveDataLoader): ArchiveDataSource {
  return {
    async loadArchive() {
      const bundle = await loader.loadArchive();
      return { bundle, etag: null, notModified: false };
    },
    loadReadings: () => loader.loadReadings(),
    loadMediaChecklist: loader.loadMediaChecklist ? () => loader.loadMediaChecklist!() : undefined,
  };
}

export function createStaticArchiveLoader(baseUrl?: string): ArchiveDataLoader {
  const base = normalizeBaseUrl(baseUrl);
  return {
    async loadArchive(): Promise<ArchiveBundle> {
      const res = await fetch(`${base}data/archive.json`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} loading archive.json`);
      }
      const raw: unknown = await res.json();
      return ArchiveBundleSchema.parse(raw);
    },
    async loadReadings(): Promise<ReadingsBundle | null> {
      const res = await fetch(`${base}data/readings.json`);
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} loading readings.json`);
      }
      const raw: unknown = await res.json();
      return ReadingsBundleSchema.parse(raw);
    },
    async loadMediaChecklist(): Promise<MediaChecklistItem[]> {
      try {
        const res = await fetch(`${base}data/media-checklist.json`);
        if (!res.ok) {
          return [];
        }
        const raw: unknown = await res.json();
        return isMediaChecklistResponse(raw) ? raw.items : [];
      } catch {
        return [];
      }
    },
  };
}
