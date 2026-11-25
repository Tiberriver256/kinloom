import type {
  ArchiveBundle,
  ArchiveEvent,
  ArchiveStatus,
  KinloomSiteConfig,
  MediaChecklistItem,
  Person,
  Place,
  ReadingsBundle,
  SourceRecord,
} from '@kinloom/core';
import {
  ArchiveBundleSchema,
  ReadingsBundleSchema,
  deriveArchiveStatus,
} from '@kinloom/core';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

export interface ArchiveDataLoader {
  loadArchive: () => Promise<ArchiveBundle>;
  loadReadings: () => Promise<ReadingsBundle | null>;
  loadMediaChecklist?: () => Promise<MediaChecklistItem[]>;
}

/**
 * Extension hooks ready for Phase 3's live Cloudflare D1 Wiki API,
 * user session, and revision history.
 */
export interface ArchiveSession {
  authenticated: boolean;
  email?: string;
  displayName?: string;
  role?: 'admin' | 'editor' | 'viewer';
}

export interface ArchiveCapabilities {
  canEdit: boolean;
  canUploadMedia: boolean;
  hasRevisionHistory: boolean;
}

export interface ArchiveDataProviderProps {
  siteConfig: KinloomSiteConfig;
  loader?: ArchiveDataLoader;
  baseUrl?: string;
  initialBundle?: ArchiveBundle | null;
  initialReadings?: ReadingsBundle | null;
  session?: ArchiveSession | null;
  capabilities?: ArchiveCapabilities;
  children: React.ReactNode;
}

export interface ArchiveDataContextValue {
  siteConfig: KinloomSiteConfig;
  baseUrl: string;
  bundle: ArchiveBundle | null;
  loading: boolean;
  error: string | null;
  status: ArchiveStatus;
  peopleById: Map<string, Person>;
  peopleBySlug: Map<string, Person>;
  placesById: Map<string, Place>;
  placesBySlug: Map<string, Place>;
  sourcesById: Map<string, SourceRecord>;
  eventsById: Map<string, ArchiveEvent>;
  readings: ReadingsBundle | null;
  readingsLoading: boolean;
  readingsError: string | null;
  readableSourceIds: ReadonlySet<string>;
  featuredDocumentId: string | null;
  ensureReadings: () => void;
  loadMediaChecklist: () => Promise<MediaChecklistItem[]>;
  reloadArchive: () => void;
  session: ArchiveSession | null;
  capabilities: ArchiveCapabilities;
}

const DEFAULT_CAPABILITIES: ArchiveCapabilities = {
  canEdit: false,
  canUploadMedia: false,
  hasRevisionHistory: false,
};

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

const ArchiveDataContext = createContext<ArchiveDataContextValue | null>(null);

export const ArchiveDataProvider: React.FC<ArchiveDataProviderProps> = ({
  siteConfig,
  loader,
  baseUrl,
  initialBundle = null,
  initialReadings = null,
  session = null,
  capabilities = DEFAULT_CAPABILITIES,
  children,
}) => {
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  const resolvedLoader = useMemo(
    () => loader ?? createStaticArchiveLoader(resolvedBaseUrl),
    [loader, resolvedBaseUrl],
  );

  const [bundle, setBundle] = useState<ArchiveBundle | null>(initialBundle);
  const [loading, setLoading] = useState<boolean>(initialBundle === null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [readings, setReadings] = useState<ReadingsBundle | null>(initialReadings);
  const [readingsLoading, setReadingsLoading] = useState(false);
  const [readingsError, setReadingsError] = useState<string | null>(null);
  const readingsFetchedRef = useRef(initialReadings !== null);

  const reloadArchive = useCallback(() => {
    setReloadTick((t) => t + 1);
  }, []);

  const ensureReadings = useCallback(() => {
    if (readingsFetchedRef.current) {
      return;
    }
    readingsFetchedRef.current = true;
    setReadingsLoading(true);
    setReadingsError(null);
    resolvedLoader
      .loadReadings()
      .then((data) => {
        setReadings(data);
        setReadingsLoading(false);
      })
      .catch((error_: unknown) => {
        readingsFetchedRef.current = false;
        setReadingsError(String(error_));
        setReadingsLoading(false);
      });
  }, [resolvedLoader]);

  useEffect(() => {
    if (initialBundle !== null && reloadTick === 0) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    resolvedLoader
      .loadArchive()
      .then((data) => {
        if (cancelled) {
          return;
        }
        setBundle(data);
        setLoading(false);
      })
      .catch((error_: unknown) => {
        if (cancelled) {
          return;
        }
        setError(String(error_));
        setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [resolvedLoader, initialBundle, reloadTick]);

  // Quietly load readings once archive is ready so dynamic readableSourceIds
  // populate without hardcoding any source IDs in code.
  useEffect(() => {
    if (!loading && bundle && !readingsFetchedRef.current) {
      ensureReadings();
    }
  }, [loading, bundle, ensureReadings]);

  const status = deriveArchiveStatus({ loading, error, bundle });

  const maps = useMemo(() => {
    const peopleById = new Map<string, Person>();
    const peopleBySlug = new Map<string, Person>();
    const placesById = new Map<string, Place>();
    const placesBySlug = new Map<string, Place>();
    const sourcesById = new Map<string, SourceRecord>();
    const eventsById = new Map<string, ArchiveEvent>();
    if (bundle) {
      for (const p of bundle.people) {
        peopleById.set(p.id, p);
        peopleBySlug.set(p.slug, p);
      }
      for (const pl of bundle.places) {
        placesById.set(pl.id, pl);
        placesBySlug.set(pl.slug, pl);
      }
      for (const s of bundle.sources) {
        sourcesById.set(s.id, s);
      }
      for (const e of bundle.events) {
        eventsById.set(e.id, e);
      }
    }
    return { peopleById, peopleBySlug, placesById, placesBySlug, sourcesById, eventsById };
  }, [bundle]);

  const readableSourceIds = useMemo<ReadonlySet<string>>(() => {
    const set = new Set<string>();
    if (readings) {
      for (const [docId, doc] of Object.entries(readings.documents)) {
        if (doc.pages.length > 0) {
          set.add(docId);
        }
      }
    } else if (siteConfig.featuredDocumentId) {
      set.add(siteConfig.featuredDocumentId);
    }
    return set;
  }, [readings, siteConfig.featuredDocumentId]);

  const featuredDocumentId = useMemo<string | null>(() => {
    if (siteConfig.featuredDocumentId) {
      if (!readings || readings.documents[siteConfig.featuredDocumentId]) {
        return siteConfig.featuredDocumentId;
      }
    }
    if (readings) {
      const first = Object.values(readings.documents).find((doc) => doc.pages.length > 0);
      if (first) {
        return first.source_id;
      }
    }
    return siteConfig.featuredDocumentId ?? null;
  }, [readings, siteConfig.featuredDocumentId]);

  const loadMediaChecklist = useCallback(async (): Promise<MediaChecklistItem[]> => {
    if (!resolvedLoader.loadMediaChecklist) {
      return [];
    }
    return resolvedLoader.loadMediaChecklist();
  }, [resolvedLoader]);

  const value = useMemo<ArchiveDataContextValue>(
    () => ({
      siteConfig,
      baseUrl: resolvedBaseUrl,
      bundle,
      loading,
      error,
      status,
      ...maps,
      readings,
      readingsLoading,
      readingsError,
      readableSourceIds,
      featuredDocumentId,
      ensureReadings,
      loadMediaChecklist,
      reloadArchive,
      session,
      capabilities,
    }),
    [
      siteConfig,
      resolvedBaseUrl,
      bundle,
      loading,
      error,
      status,
      maps,
      readings,
      readingsLoading,
      readingsError,
      readableSourceIds,
      featuredDocumentId,
      ensureReadings,
      loadMediaChecklist,
      reloadArchive,
      session,
      capabilities,
    ],
  );

  return <ArchiveDataContext.Provider value={value}>{children}</ArchiveDataContext.Provider>;
};

export function useArchiveData(): ArchiveDataContextValue {
  const ctx = useContext(ArchiveDataContext);
  if (!ctx) {
    throw new Error('useArchiveData must be used inside ArchiveDataProvider');
  }
  return ctx;
}
