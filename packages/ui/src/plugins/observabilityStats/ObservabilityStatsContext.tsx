import type React from 'react';
import { createContext, createElement, useContext, useEffect, useMemo, useState } from 'react';
import type { ObservabilityStatsClient } from '../../adapters/observabilityStatsClient.js';
import { useOptionalArchiveData } from '../../context/ArchiveDataContext.js';
import {
  OBSERVABILITY_STATS_SERVER_PLUGIN_ID,
  type UiObservabilityStatsWindow,
} from '../../lib/observabilityStatsModel.js';
import { useKinloomPlugins } from '../PluginContext.js';

export interface ObservabilityStatsContextValue {
  readonly client: ObservabilityStatsClient;
  readonly defaultWindow: UiObservabilityStatsWindow;
  readonly showPublicBadges: boolean;
  readonly recordSpaBeacons: boolean;
  readonly initialLoadWasUnauthenticated: boolean;
  readonly setShowPublicBadges: (next: boolean) => void;
}

const ObservabilityStatsContext = createContext<ObservabilityStatsContextValue | null>(null);

export interface ObservabilityStatsProviderProps {
  readonly client: ObservabilityStatsClient;
  readonly initialShowPublicBadges: boolean;
  readonly defaultWindow: UiObservabilityStatsWindow;
  readonly children?: React.ReactNode;
}

export const ObservabilityStatsProvider: React.FC<ObservabilityStatsProviderProps> = ({
  client,
  initialShowPublicBadges,
  defaultWindow,
  children,
}) => {
  const archiveData = useOptionalArchiveData();
  const { subscribePluginSettings } = useKinloomPlugins();

  const [showPublicBadges, setShowPublicBadges] = useState<boolean>(initialShowPublicBadges);
  const [recordSpaBeacons, setRecordSpaBeacons] = useState<boolean>(true);
  const [initialLoadWasUnauthenticated, setInitialLoadWasUnauthenticated] = useState<boolean>(false);

  const hasSessionLoader = Boolean(archiveData?.dataSource.getSession);
  const session = archiveData?.session ?? null;
  const sessionAuthenticated = session?.authenticated ?? false;
  const sessionPrincipalKind = session?.principal_kind ?? null;
  const hasBundle = archiveData !== null ? archiveData.bundle !== null : true;

  useEffect(() => {
    if (!hasBundle && sessionPrincipalKind === 'anonymous') {
      setInitialLoadWasUnauthenticated(true);
    }
  }, [hasBundle, sessionPrincipalKind]);

  const shouldFetchConfig =
    !(hasSessionLoader && sessionPrincipalKind === null) &&
    !(!hasBundle && !sessionAuthenticated && sessionPrincipalKind === 'anonymous');
  const configFetchKey = shouldFetchConfig
    ? `${sessionAuthenticated ? 'auth' : 'anon'}:${sessionPrincipalKind ?? 'none'}`
    : null;

  useEffect(() => {
    if (typeof client.getPublicConfig !== 'function' || configFetchKey === null) {
      return;
    }

    const controller = new AbortController();
    let active = true;

    void client
      .getPublicConfig({ signal: controller.signal, cache: 'no-store' })
      .then((cfg) => {
        if (!active || !cfg) {
          return;
        }
        setShowPublicBadges(cfg.public_badges_enabled);
        setRecordSpaBeacons(cfg.record_spa_beacons);
      })
      .catch(() => {
        // Keep current badge visibility when config endpoint is unavailable.
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [client, configFetchKey]);

  useEffect(() => {
    return subscribePluginSettings(OBSERVABILITY_STATS_SERVER_PLUGIN_ID, (evt) => {
      const nextFlag = evt.snapshot?.values.show_public_visit_badges;
      if (typeof nextFlag === 'boolean') {
        setShowPublicBadges(nextFlag);
        return;
      }
      if (typeof client.getPublicConfig === 'function') {
        void client
          .getPublicConfig({ cache: 'no-store' })
          .then((cfg) => {
            if (cfg) {
              setShowPublicBadges(cfg.public_badges_enabled);
              setRecordSpaBeacons(cfg.record_spa_beacons);
            }
          })
          .catch(() => {
            // Ignore transient refresh failures.
          });
      }
    });
  }, [subscribePluginSettings, client]);

  const value = useMemo<ObservabilityStatsContextValue>(
    () => ({
      client,
      defaultWindow,
      showPublicBadges,
      recordSpaBeacons,
      initialLoadWasUnauthenticated,
      setShowPublicBadges,
    }),
    [client, defaultWindow, showPublicBadges, recordSpaBeacons, initialLoadWasUnauthenticated]
  );

  return <ObservabilityStatsContext.Provider value={value}>{children}</ObservabilityStatsContext.Provider>;
};

export function bindObservabilityStatsProvider(
  config: Omit<ObservabilityStatsProviderProps, 'children'>
): React.ComponentType<{ children: React.ReactNode }> {
  return (props: { children: React.ReactNode }) =>
    createElement(ObservabilityStatsProvider, config, props.children);
}

export function useObservabilityStatsContext(): ObservabilityStatsContextValue {
  const ctx = useContext(ObservabilityStatsContext);
  if (!ctx) {
    throw new Error('useObservabilityStatsContext must be used inside ObservabilityStatsProvider.');
  }
  return ctx;
}
