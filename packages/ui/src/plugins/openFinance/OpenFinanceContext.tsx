import type React from 'react';
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { OpenFinanceClient } from '../../adapters/openFinanceClient.js';
import {
  buildUiOpenFinanceSummaryFromConfig,
  type UiOpenFinanceAdminConfigPayload,
  type UiOpenFinanceConfig,
  type UiOpenFinancePublicSummary,
} from '../../lib/openFinanceModel.js';

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
  const fallbackSummary = useMemo(
    () => (initialConfig ? buildUiOpenFinanceSummaryFromConfig(initialConfig, null) : null),
    [initialConfig]
  );

  const [summary, setSummary] = useState<UiOpenFinancePublicSummary | null>(fallbackSummary);
  const [loading, setLoading] = useState<boolean>(Boolean(client));
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      if (!client) {
        setSummary(fallbackSummary);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const fetched = await client.getPublicSummary({ signal });
        if (signal?.aborted) {
          return;
        }
        setSummary(fetched ?? fallbackSummary);
      } catch (err) {
        if (signal?.aborted) {
          return;
        }
        if (fallbackSummary) {
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
    [client, fallbackSummary]
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchSummary(controller.signal);
    return () => {
      controller.abort();
    };
  }, [fetchSummary]);

  const refreshPublicSummary = useCallback(async (): Promise<void> => {
    await fetchSummary();
  }, [fetchSummary]);

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
