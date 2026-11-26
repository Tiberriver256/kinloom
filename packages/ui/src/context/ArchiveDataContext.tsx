import type {
  ArchiveAuthProviders,
  ArchiveBundle,
  ArchiveCapabilities as CoreArchiveCapabilities,
  ArchiveDataSource,
  ArchiveEvent,
  ArchiveSessionState,
  ArchiveStatus,
  KinloomSiteConfig,
  MediaChecklistItem,
  Person,
  Place,
  Pronunciation,
  ReadingsBundle,
  SourceRecord,
} from '@kinloom/core';
import {
  ArchiveBundleSchema,
  ReadingsBundleSchema,
  deriveArchiveStatus,
  resolveCapabilities,
} from '@kinloom/core';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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

export interface ArchiveDataProviderProps {
  siteConfig: KinloomSiteConfig;
  loader?: ArchiveDataLoader;
  dataSource?: ArchiveDataSource;
  baseUrl?: string;
  initialBundle?: ArchiveBundle | null;
  initialReadings?: ReadingsBundle | null;
  session?: ArchiveSession | null;
  capabilities?: Partial<ArchiveCapabilities>;
  children: React.ReactNode;
}

export interface ArchiveDataContextValue {
  siteConfig: KinloomSiteConfig;
  baseUrl: string;
  dataSource: ArchiveDataSource;
  bundle: ArchiveBundle | null;
  etag: string | null;
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
  refreshSession: () => Promise<void>;
  session: ArchiveSessionState | null;
  capabilities: CoreArchiveCapabilities;
  authProviders: ArchiveAuthProviders;
  pronunciations: Readonly<Record<string, Pronunciation>>;
  setPronunciations: (next: Record<string, Pronunciation>) => void;
}

const DEFAULT_CAPABILITIES: CoreArchiveCapabilities = {
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

function isMediaChecklistResponse(data: unknown): data is { items: MediaChecklistItem[] } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'items' in data &&
    Array.isArray((data as { items: unknown }).items)
  );
}

function isPronunciationsResponse(
  data: unknown,
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

function normalizeSessionProp(session: ArchiveSession | null | undefined): ArchiveSessionState | null {
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

function normalizeCapabilities(
  caps: Partial<ArchiveCapabilities> | undefined,
  session: ArchiveSessionState | null,
): CoreArchiveCapabilities {
  if (!caps) {
    return session ? resolveCapabilities(session) : DEFAULT_CAPABILITIES;
  }
  return {
    canEdit: caps.canEdit ?? false,
    canUploadMedia: caps.canUploadMedia ?? false,
    hasRevisionHistory: caps.hasRevisionHistory ?? false,
    hasTalk: caps.hasTalk ?? false,
    canManageSite: caps.canManageSite ?? false,
  };
}

function wrapLegacyLoader(loader: ArchiveDataLoader): ArchiveDataSource {
  return {
    async loadArchive() {
      const bundle = await loader.loadArchive();
      return { bundle, etag: null, notModified: false };
    },
    loadReadings: () => loader.loadReadings(),
    loadMediaChecklist: loader.loadMediaChecklist
      ? () => loader.loadMediaChecklist!()
      : undefined,
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

const ArchiveDataContext = createContext<ArchiveDataContextValue | null>(null);

export const ArchiveDataProvider: React.FC<ArchiveDataProviderProps> = ({
  siteConfig,
  loader,
  dataSource,
  baseUrl,
  initialBundle = null,
  initialReadings = null,
  session: sessionProp,
  capabilities: capabilitiesProp,
  children,
}) => {
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  const resolvedDataSource = useMemo<ArchiveDataSource>(() => {
    if (dataSource) {
      return dataSource;
    }
    if (loader) {
      return wrapLegacyLoader(loader);
    }
    return createStaticArchiveDataSource(resolvedBaseUrl);
  }, [dataSource, loader, resolvedBaseUrl]);

  const initialNormalizedSession = useMemo(
    () => normalizeSessionProp(sessionProp),
    [sessionProp],
  );
  const initialNormalizedCaps = useMemo(
    () => normalizeCapabilities(capabilitiesProp, initialNormalizedSession),
    [capabilitiesProp, initialNormalizedSession],
  );

  const [bundle, setBundle] = useState<ArchiveBundle | null>(initialBundle);
  const [etag, setEtag] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(initialBundle === null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [liveSession, setLiveSession] = useState<ArchiveSessionState | null>(
    initialNormalizedSession,
  );
  const [liveCapabilities, setLiveCapabilities] = useState<CoreArchiveCapabilities>(
    initialNormalizedCaps,
  );
  const [liveAuthProviders, setLiveAuthProviders] = useState<ArchiveAuthProviders>({
    google: false,
    magicLink: Boolean(resolvedDataSource.requestMagicLink),
  });

  const [readings, setReadings] = useState<ReadingsBundle | null>(initialReadings);
  const [readingsLoading, setReadingsLoading] = useState(false);
  const [readingsError, setReadingsError] = useState<string | null>(null);
  const [livePronunciations, setLivePronunciations] = useState<Record<string, Pronunciation>>({});
  const [archiveLoadedOverHttp, setArchiveLoadedOverHttp] = useState(false);
  const readingsFetchedRef = useRef(initialReadings !== null);
  const etagRef = useRef<string | null>(null);
  const hasBundleRef = useRef(initialBundle !== null);

  const setPronunciations = useCallback((next: Record<string, Pronunciation>) => {
    setLivePronunciations(next);
  }, []);

  useEffect(() => {
    if (sessionProp !== undefined) {
      setLiveSession(initialNormalizedSession);
    }
  }, [sessionProp, initialNormalizedSession]);

  useEffect(() => {
    if (capabilitiesProp !== undefined || sessionProp !== undefined) {
      setLiveCapabilities(initialNormalizedCaps);
    }
  }, [capabilitiesProp, sessionProp, initialNormalizedCaps]);

  const refreshSession = useCallback(async (): Promise<void> => {
    if (!resolvedDataSource.getSession) {
      return;
    }
    try {
      const res = await resolvedDataSource.getSession();
      setLiveSession(res.session);
      setLiveCapabilities(res.capabilities);
      if (res.authProviders) {
        setLiveAuthProviders(res.authProviders);
      }
      if (res.session.principal_kind === 'anonymous') {
        hasBundleRef.current = false;
        etagRef.current = null;
        setEtag(null);
        setBundle(null);
        setReadings(null);
        readingsFetchedRef.current = false;
      }
    } catch {
      // Keep current session state on transient refresh failure.
    }
  }, [resolvedDataSource]);

  useEffect(() => {
    if (sessionProp !== undefined || !resolvedDataSource.getSession) {
      return;
    }
    let cancelled = false;
    void resolvedDataSource
      .getSession()
      .then((res) => {
        if (!cancelled) {
          setLiveSession(res.session);
          setLiveCapabilities(res.capabilities);
          if (res.authProviders) {
            setLiveAuthProviders(res.authProviders);
          }
        }
      })
      .catch(() => {
        // Leave anonymous/read-only state on error.
      });
    return (): void => {
      cancelled = true;
    };
  }, [resolvedDataSource, sessionProp]);

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
    resolvedDataSource
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
  }, [resolvedDataSource]);

  useEffect(() => {
    if (initialBundle !== null && reloadTick === 0) {
      return;
    }
    let cancelled = false;
    // Keep mounted views/drawers intact during background stale-while-revalidate reloads.
    if (!hasBundleRef.current) {
      setLoading(true);
    }
    setError(null);
    resolvedDataSource
      .loadArchive({ ifNoneMatch: etagRef.current ?? undefined })
      .then((result) => {
        if (cancelled) {
          return;
        }
        hasBundleRef.current = true;
        etagRef.current = result.etag;
        setEtag(result.etag);
        setBundle(result.bundle);
        setArchiveLoadedOverHttp(true);
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
  }, [resolvedDataSource, initialBundle, reloadTick]);

  // Quietly load readings once archive is ready so dynamic readableSourceIds
  // populate without hardcoding any source IDs in code.
  useEffect(() => {
    if (!loading && bundle && !readingsFetchedRef.current) {
      ensureReadings();
    }
  }, [loading, bundle, ensureReadings]);

  // Fetch live D1 pronunciation overrides when editing is enabled or archive loads over HTTP.
  // Fails silently in static/offline mode.
  useEffect(() => {
    if (!liveCapabilities.canEdit && !archiveLoadedOverHttp) {
      return;
    }
    if (typeof fetch !== 'function') {
      return;
    }
    let cancelled = false;
    void fetch('/api/pronunciations', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) {
          return null;
        }
        return (await res.json()) as unknown;
      })
      .then((raw) => {
        if (!cancelled && isPronunciationsResponse(raw)) {
          setLivePronunciations((prev) => ({
            ...prev,
            ...raw.pronunciations,
          }));
        }
      })
      .catch(() => {
        // Static or offline mode: keep static siteConfig + bundle pronunciations.
      });
    return (): void => {
      cancelled = true;
    };
  }, [liveCapabilities.canEdit, archiveLoadedOverHttp, reloadTick]);

  const pronunciations = useMemo<Readonly<Record<string, Pronunciation>>>(
    () => ({
      ...siteConfig.pronunciations,
      ...bundle?.pronunciations,
      ...livePronunciations,
    }),
    [siteConfig.pronunciations, bundle?.pronunciations, livePronunciations],
  );

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
    if (!resolvedDataSource.loadMediaChecklist) {
      return [];
    }
    return resolvedDataSource.loadMediaChecklist();
  }, [resolvedDataSource]);

  const value = useMemo<ArchiveDataContextValue>(
    () => ({
      siteConfig,
      baseUrl: resolvedBaseUrl,
      dataSource: resolvedDataSource,
      bundle,
      etag,
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
      refreshSession,
      session: liveSession,
      capabilities: liveCapabilities,
      authProviders: liveAuthProviders,
      pronunciations,
      setPronunciations,
    }),
    [
      siteConfig,
      resolvedBaseUrl,
      resolvedDataSource,
      bundle,
      etag,
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
      refreshSession,
      liveSession,
      liveCapabilities,
      liveAuthProviders,
      pronunciations,
      setPronunciations,
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
