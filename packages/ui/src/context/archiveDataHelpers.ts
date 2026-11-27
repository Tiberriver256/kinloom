import type {
  ArchiveBundle,
  ArchiveDataSource,
  ArchiveSessionState,
  ArchiveCapabilities as CoreArchiveCapabilities,
  MediaChecklistItem,
  ReadingsBundle,
} from '@kinloom/core';
import { resolveCapabilities } from '@kinloom/core';
import { createStaticArchiveDataSource } from '../adapters/staticDemoDataSource.js';

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
  const loadChecklist = loader.loadMediaChecklist;
  return {
    async loadArchive() {
      const bundle = await loader.loadArchive();
      return { bundle, etag: null, notModified: false };
    },
    loadReadings: () => loader.loadReadings(),
    loadMediaChecklist: loadChecklist ? () => loadChecklist() : undefined,
  };
}

export function createStaticArchiveLoader(baseUrl?: string): ArchiveDataLoader {
  const source = createStaticArchiveDataSource(normalizeBaseUrl(baseUrl));
  return {
    async loadArchive(): Promise<ArchiveBundle> {
      const result = await source.loadArchive();
      return result.bundle;
    },
    loadReadings: () => source.loadReadings(),
    loadMediaChecklist: () => (source.loadMediaChecklist ? source.loadMediaChecklist() : Promise.resolve([])),
  };
}
