import type React from 'react';
import { createContext, createElement, useContext, useMemo } from 'react';
import type { BookPublishingClient } from '../../adapters/bookPublishingClient.js';

export interface BookPublishingContextValue {
  readonly client: BookPublishingClient;
}

const BookPublishingContext = createContext<BookPublishingContextValue | null>(null);

export interface BookPublishingProviderProps {
  readonly client: BookPublishingClient;
  readonly children?: React.ReactNode;
}

export const BookPublishingProvider: React.FC<BookPublishingProviderProps> = ({ client, children }) => {
  const value = useMemo<BookPublishingContextValue>(() => ({ client }), [client]);
  return <BookPublishingContext.Provider value={value}>{children}</BookPublishingContext.Provider>;
};

export function bindBookPublishingProvider(
  config: Omit<BookPublishingProviderProps, 'children'>
): React.ComponentType<{ children: React.ReactNode }> {
  return (props: { children: React.ReactNode }) =>
    createElement(BookPublishingProvider, config, props.children);
}

export function useBookPublishingContext(): BookPublishingContextValue {
  const ctx = useContext(BookPublishingContext);
  if (!ctx) {
    throw new Error('useBookPublishingContext must be used inside BookPublishingProvider.');
  }
  return ctx;
}
