import type {
  AdminDataSource,
  ArchiveAuthProviders,
  ArchiveBundle,
  ArchiveDataSource,
  ArchiveEvent,
  ArchiveSessionState,
  ArchiveStatus,
  ArchiveCapabilities as CoreArchiveCapabilities,
  KinloomSiteConfig,
  MediaChecklistItem,
  Person,
  Place,
  Pronunciation,
  ReadingsBundle,
  SourceRecord,
} from '@kinloom/core';
import { deriveArchiveStatus, mergePronunciationLexicons } from '@kinloom/core';
import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createStaticArchiveDataSource } from '../adapters/staticDemoDataSource.js';
import { AuthSessionActorContext, deriveSessionFromAuthSnapshot } from '../machines/authSessionMachine.js';
import {
  type ArchiveCapabilities,
  type ArchiveDataLoader,
  type ArchiveSession,
  createStaticArchiveLoader,
  normalizeBaseUrl,
  normalizeSessionProp,
  wrapLegacyLoader,
} from './archiveDataHelpers.js';

export type { ArchiveCapabilities, ArchiveDataLoader, ArchiveSession };
export { createStaticArchiveLoader };

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
  adminDataSource: AdminDataSource | null;
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

const ArchiveDataContext = createContext<ArchiveDataContextValue | null>(null);

interface ArchiveDataProviderInnerProps {
  siteConfig: KinloomSiteConfig;
  resolvedBaseUrl: string;
  resolvedDataSource: ArchiveDataSource;
  initialBundle: ArchiveBundle | null;
  initialReadings: ReadingsBundle | null;
  sessionProp: ArchiveSession | null | undefined;
  normalizedSessionProp: ArchiveSessionState | null;
  capabilitiesProp: Partial<ArchiveCapabilities> | undefined;
  children: React.ReactNode;
}

const ArchiveDataProviderInner: React.FC<ArchiveDataProviderInnerProps> = ({
  siteConfig,
  resolvedBaseUrl,
  resolvedDataSource,
  initialBundle,
  initialReadings,
  sessionProp,
  normalizedSessionProp,
  capabilitiesProp,
  children,
}) => {
  const authActorRef = AuthSessionActorContext.useActorRef();
  const authSnapshot = AuthSessionActorContext.useSelector((state) => state);

  const [bundle, setBundle] = useState<ArchiveBundle | null>(initialBundle);
  const [etag, setEtag] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(initialBundle === null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [readings, setReadings] = useState<ReadingsBundle | null>(initialReadings);
  const [readingsLoading, setReadingsLoading] = useState(false);
  const [readingsError, setReadingsError] = useState<string | null>(null);
  const [livePronunciations, setLivePronunciations] = useState<Record<string, Pronunciation>>({});
  const [archiveLoadedOverHttp, setArchiveLoadedOverHttp] = useState(false);
  const readingsFetchedRef = useRef(initialReadings !== null);
  const etagRef = useRef<string | null>(null);
  const hasBundleRef = useRef(initialBundle !== null);
  const prevDataSourceRef = useRef(resolvedDataSource);
  const prevSessionPropRef = useRef(sessionProp);
  const prevCapabilitiesPropRef = useRef(capabilitiesProp);

  const setPronunciations = useCallback((next: Record<string, Pronunciation>) => {
    setLivePronunciations(next);
  }, []);

  useEffect(() => {
    if (prevDataSourceRef.current !== resolvedDataSource) {
      prevDataSourceRef.current = resolvedDataSource;
      authActorRef.send({ type: 'SYNC_DATA_SOURCE', dataSource: resolvedDataSource });
      if (sessionProp === undefined && resolvedDataSource.getSession) {
        authActorRef.send({ type: 'REFRESH_SESSION' });
      }
    }
  }, [authActorRef, resolvedDataSource, sessionProp]);

  useEffect(() => {
    if (prevSessionPropRef.current !== sessionProp) {
      prevSessionPropRef.current = sessionProp;
      if (sessionProp !== undefined) {
        authActorRef.send({ type: 'SYNC_EXPLICIT_SESSION', session: normalizedSessionProp });
      } else if (resolvedDataSource.getSession) {
        authActorRef.send({ type: 'REFRESH_SESSION' });
      }
    }
  }, [authActorRef, sessionProp, normalizedSessionProp, resolvedDataSource]);

  useEffect(() => {
    if (prevCapabilitiesPropRef.current !== capabilitiesProp) {
      prevCapabilitiesPropRef.current = capabilitiesProp;
      authActorRef.send({ type: 'SYNC_CAPABILITIES_OVERRIDE', capabilities: capabilitiesProp });
    }
  }, [authActorRef, capabilitiesProp]);

  const {
    session: derivedSession,
    capabilities,
    authProviders,
  } = useMemo(() => deriveSessionFromAuthSnapshot(authSnapshot), [authSnapshot]);

  const session: ArchiveSessionState | null = authSnapshot.matches('hydrating') ? null : derivedSession;

  const clearCachedArchiveState = useCallback(() => {
    hasBundleRef.current = false;
    etagRef.current = null;
    setEtag(null);
    setBundle(null);
    setReadings(null);
    readingsFetchedRef.current = false;
  }, []);

  const prevPrincipalKindRef = useRef<ArchiveSessionState['principal_kind'] | null>(
    session?.principal_kind ?? null
  );
  useEffect(() => {
    const prevKind = prevPrincipalKindRef.current;
    const nextKind = session?.principal_kind ?? null;
    if (nextKind !== null) {
      prevPrincipalKindRef.current = nextKind;
    }
    if ((prevKind === 'user' || prevKind === 'invite_viewer') && nextKind === 'anonymous') {
      clearCachedArchiveState();
    }
  }, [session?.principal_kind, clearCachedArchiveState]);

  const refreshSession = useCallback(async (): Promise<void> => {
    if (!resolvedDataSource.getSession) {
      return;
    }
    await new Promise<void>((resolve) => {
      let sawHydrating = false;
      const sub = authActorRef.subscribe((snap) => {
        if (snap.matches('hydrating')) {
          sawHydrating = true;
          return;
        }
        if (sawHydrating) {
          sub.unsubscribe();
          const refreshed = deriveSessionFromAuthSnapshot(snap);
          if (refreshed.session.principal_kind === 'anonymous') {
            clearCachedArchiveState();
          }
          resolve();
        }
      });
      authActorRef.send({ type: 'REFRESH_SESSION' });
      const current = authActorRef.getSnapshot();
      if (!current.matches('hydrating')) {
        sub.unsubscribe();
        const refreshed = deriveSessionFromAuthSnapshot(current);
        if (refreshed.session.principal_kind === 'anonymous') {
          clearCachedArchiveState();
        }
        resolve();
      }
    });
  }, [authActorRef, resolvedDataSource, clearCachedArchiveState]);

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

  // Fetch live pronunciation overrides through the ArchiveDataSource port when available.
  // Fails silently in static/offline mode.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fetch live pronunciations when reloadTick increments
  useEffect(() => {
    if ((!capabilities.canEdit && !archiveLoadedOverHttp) || !resolvedDataSource.loadPronunciations) {
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    void resolvedDataSource
      .loadPronunciations({ signal: controller.signal })
      .then((next) => {
        if (!cancelled && next) {
          setLivePronunciations(next);
        }
      })
      .catch(() => {
        // Static or offline mode: keep static siteConfig + bundle pronunciations.
      });
    return (): void => {
      cancelled = true;
      controller.abort();
    };
  }, [resolvedDataSource, capabilities.canEdit, archiveLoadedOverHttp, reloadTick]);

  const pronunciations = useMemo<Readonly<Record<string, Pronunciation>>>(
    () =>
      mergePronunciationLexicons(
        mergePronunciationLexicons(siteConfig.pronunciations, bundle?.pronunciations),
        livePronunciations
      ),
    [siteConfig.pronunciations, bundle?.pronunciations, livePronunciations]
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

  const adminDataSource = resolvedDataSource.admin ?? null;

  const value = useMemo<ArchiveDataContextValue>(
    () => ({
      siteConfig,
      baseUrl: resolvedBaseUrl,
      dataSource: resolvedDataSource,
      adminDataSource,
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
      session,
      capabilities,
      authProviders,
      pronunciations,
      setPronunciations,
    }),
    [
      siteConfig,
      resolvedBaseUrl,
      resolvedDataSource,
      adminDataSource,
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
      session,
      capabilities,
      authProviders,
      pronunciations,
      setPronunciations,
    ]
  );

  return <ArchiveDataContext.Provider value={value}>{children}</ArchiveDataContext.Provider>;
};

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

  const normalizedSessionProp = useMemo(() => normalizeSessionProp(sessionProp), [sessionProp]);

  const initialActorOptionsRef = useRef({
    input: {
      dataSource: resolvedDataSource,
      initialSession: normalizedSessionProp,
      hasExplicitSession: sessionProp !== undefined,
      capabilitiesOverride: capabilitiesProp,
    },
  });

  return (
    <AuthSessionActorContext.Provider options={initialActorOptionsRef.current}>
      <ArchiveDataProviderInner
        siteConfig={siteConfig}
        resolvedBaseUrl={resolvedBaseUrl}
        resolvedDataSource={resolvedDataSource}
        initialBundle={initialBundle}
        initialReadings={initialReadings}
        sessionProp={sessionProp}
        normalizedSessionProp={normalizedSessionProp}
        capabilitiesProp={capabilitiesProp}
      >
        {children}
      </ArchiveDataProviderInner>
    </AuthSessionActorContext.Provider>
  );
};

export function useOptionalArchiveData(): ArchiveDataContextValue | null {
  return useContext(ArchiveDataContext);
}

export function useArchiveData(): ArchiveDataContextValue {
  const ctx = useContext(ArchiveDataContext);
  if (!ctx) {
    throw new Error('useArchiveData must be used inside ArchiveDataProvider');
  }
  return ctx;
}
