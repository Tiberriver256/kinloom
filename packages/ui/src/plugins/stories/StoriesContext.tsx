import type React from 'react';
import { createContext, createElement, useContext, useMemo } from 'react';
import type { StoriesClient } from '../../adapters/storiesClient.js';
import { DEFAULT_STORIES_ROUTE_BASE } from '../../lib/storiesModel.js';

export interface StoriesPluginRuntimeValue {
  readonly client: StoriesClient;
  readonly basePath: string;
  readonly pageTitle: string;
  readonly pageDescription: string;
}

const StoriesPluginContext = createContext<StoriesPluginRuntimeValue | null>(null);

export interface StoriesPluginProviderProps {
  readonly client: StoriesClient;
  readonly basePath: string;
  readonly pageTitle: string;
  readonly pageDescription: string;
  readonly children?: React.ReactNode;
}

export const StoriesPluginProvider: React.FC<StoriesPluginProviderProps> = ({
  client,
  basePath,
  pageTitle,
  pageDescription,
  children,
}) => {
  const value = useMemo<StoriesPluginRuntimeValue>(
    () => ({
      client,
      basePath,
      pageTitle,
      pageDescription,
    }),
    [client, basePath, pageTitle, pageDescription]
  );
  return <StoriesPluginContext.Provider value={value}>{children}</StoriesPluginContext.Provider>;
};

export interface BindStoriesProviderOptions {
  readonly client: StoriesClient;
  readonly basePath?: string | undefined;
  readonly pageTitle?: string | undefined;
  readonly pageDescription?: string | undefined;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

export function bindStoriesProvider(
  options: BindStoriesProviderOptions
): React.ComponentType<{ children: React.ReactNode }> {
  const normalizedBasePath = options.basePath ? trimTrailingSlashes(options.basePath.trim()) : '';
  const config: Omit<StoriesPluginProviderProps, 'children'> = {
    client: options.client,
    basePath: normalizedBasePath || DEFAULT_STORIES_ROUTE_BASE,
    pageTitle: options.pageTitle?.trim() || 'Specialty Stories',
    pageDescription:
      options.pageDescription?.trim() ||
      'Interactive documentaries, scroll chapters, and chronological journey maps grounded in primary archival sources.',
  };

  return (props: { children: React.ReactNode }) =>
    createElement(StoriesPluginProvider, config, props.children);
}

export function useStoriesPlugin(): StoriesPluginRuntimeValue {
  const ctx = useContext(StoriesPluginContext);
  if (!ctx) {
    throw new Error('useStoriesPlugin must be used inside a KinloomApp with createStoriesUiPlugin enabled.');
  }
  return ctx;
}
