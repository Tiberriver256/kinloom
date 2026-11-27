import type React from 'react';
import { createContext, createElement, useContext, useMemo, useState } from 'react';
import type { ObservabilityStatsClient } from '../../adapters/observabilityStatsClient.js';
import type { UiObservabilityStatsWindow } from '../../lib/observabilityStatsModel.js';

export interface ObservabilityStatsContextValue {
  readonly client: ObservabilityStatsClient;
  readonly defaultWindow: UiObservabilityStatsWindow;
  readonly showPublicBadges: boolean;
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
  const [showPublicBadges, setShowPublicBadges] = useState<boolean>(initialShowPublicBadges);

  const value = useMemo<ObservabilityStatsContextValue>(
    () => ({
      client,
      defaultWindow,
      showPublicBadges,
      setShowPublicBadges,
    }),
    [client, defaultWindow, showPublicBadges]
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
