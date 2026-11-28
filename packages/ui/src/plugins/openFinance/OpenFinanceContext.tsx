import type React from 'react';
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiClientError } from '../../adapters/httpWiki/httpClient.js';
import type { OpenFinanceClient } from '../../adapters/openFinanceClient.js';
import { useOptionalArchiveData } from '../../context/ArchiveDataContext.js';
import {
  buildUiOpenFinanceSummaryFromConfig,
  OPEN_FINANCE_SERVER_PLUGIN_ID,
  type UiOpenFinanceAdminConfigPayload,
  type UiOpenFinanceConfig,
  type UiOpenFinancePublicSummary,
} from '../../lib/openFinanceModel.js';
import { useKinloomPlugins } from '../PluginContext.js';

export interface OpenFinanceContextValue {
  readonly routePath: string;
  readonly client: OpenFinanceClient | null;
  readonly summary: UiOpenFinancePublicSummary | null;
  readonly initialConfig: UiOpenFinanceConfig | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refreshPublicSummary: () => Promise<void>;
  readonly applyAdminUpdate: (payload: UiOpenFinanceAdminConfigPayload) => void;
}

const OpenFinanceContext = createContext<OpenFinanceContextValue | null>(null);

export interface OpenFinanceProviderProps {
  readonly routePath: string;
  readonly client: OpenFinanceClient | null;
  readonly initialConfig: UiOpenFinanceConfig | null;
  readonly children?: React.ReactNode;
}

export const OpenFinanceProvider: React.FC<OpenFinanceProviderProps> = ({
  routePath,
  client,
  initialConfig,
  children,
}) => {
  const archiveData = useOptionalArchiveData();
  const { subscribePluginSettings } = useKinloomPlugins();

  const fallbackSummary = useMemo(
    () => (initialConfig ? buildUiOpenFinanceSummaryFromConfig(initialConfig, null) : null),
    [initialConfig]
  );

  const [summary, setSummary] = useState<UiOpenFinancePublicSummary | null>(fallbackSummary);
  const [loading, setLoading] = useState<boolean>(Boolean(client));
  const [error, setError] = useState<string | null>(null);

  const hasSessionLoader = Boolean(archiveData?.dataSource.getSession);
  const session = archiveData?.session ?? null;
  const sessionAuthenticated = session?.authenticated ?? false;
  const sessionPrincipalKind = session?.principal_kind ?? null;

  const fetchSummary = useCallback(
    async (options?: { readonly signal?: AbortSignal; readonly cache?: RequestCache }): Promise<void> => {
      const signal = options?.signal;
      if (!client) {
        setSummary(fallbackSummary);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const fetched = await client.getPublicSummary({
          signal,
          ...(options?.cache ? { cache: options.cache } : {}),
        });
        if (signal?.aborted) {
          return;
        }
        setSummary(fetched ?? fallbackSummary);
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        if (err instanceof ApiClientError && err.status === 401 && sessionPrincipalKind === 'anonymous') {
          setSummary(fallbackSummary);
          setError(null);
        } else if (fallbackSummary) {
          setSummary(fallbackSummary);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [client, fallbackSummary, sessionPrincipalKind]
  );

  useEffect(() => {
    if (hasSessionLoader && sessionPrincipalKind === null) {
      return;
    }
    const controller = new AbortController();
    void fetchSummary({
      signal: controller.signal,
      ...(sessionAuthenticated ? { cache: 'no-store' } : {}),
    });
    return () => {
      controller.abort();
    };
  }, [fetchSummary, hasSessionLoader, sessionAuthenticated, sessionPrincipalKind]);

  const refreshPublicSummary = useCallback(async (): Promise<void> => {
    await fetchSummary({ cache: 'no-store' });
  }, [fetchSummary]);

  useEffect(() => {
    return subscribePluginSettings(OPEN_FINANCE_SERVER_PLUGIN_ID, () => {
      void refreshPublicSummary();
    });
  }, [subscribePluginSettings, refreshPublicSummary]);

  const applyAdminUpdate = useCallback((payload: UiOpenFinanceAdminConfigPayload): void => {
    setSummary(payload.summary);
    setError(null);
  }, []);

  const value = useMemo<OpenFinanceContextValue>(
    () => ({
      routePath,
      client,
      summary,
      initialConfig,
      loading,
      error,
      refreshPublicSummary,
      applyAdminUpdate,
    }),
    [routePath, client, summary, initialConfig, loading, error, refreshPublicSummary, applyAdminUpdate]
  );

  return <OpenFinanceContext.Provider value={value}>{children}</OpenFinanceContext.Provider>;
};

export function bindOpenFinanceProvider(
  config: Omit<OpenFinanceProviderProps, 'children'>
): React.ComponentType<{ children: React.ReactNode }> {
  return (props: { children: React.ReactNode }) => createElement(OpenFinanceProvider, config, props.children);
}

export function useOpenFinanceContext(): OpenFinanceContextValue {
  const ctx = useContext(OpenFinanceContext);
  if (!ctx) {
    throw new Error('useOpenFinanceContext must be used inside OpenFinanceProvider.');
  }
  return ctx;
}
