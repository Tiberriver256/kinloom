import type React from 'react';
import { createContext, createElement, useContext, useMemo } from 'react';
import type { RecipesClient } from '../../adapters/recipesClient.js';
import { DEFAULT_RECIPES_ROUTE_BASE } from '../../lib/recipesModel.js';

export interface RecipesPluginRuntimeValue {
  readonly client: RecipesClient;
  readonly basePath: string;
  readonly showIndexWidget: boolean;
  readonly pageTitle: string;
  readonly pageDescription: string;
}

const RecipesPluginContext = createContext<RecipesPluginRuntimeValue | null>(null);

export interface RecipesPluginProviderProps {
  readonly client: RecipesClient;
  readonly basePath: string;
  readonly showIndexWidget: boolean;
  readonly pageTitle: string;
  readonly pageDescription: string;
  readonly children?: React.ReactNode;
}

export const RecipesPluginProvider: React.FC<RecipesPluginProviderProps> = ({
  client,
  basePath,
  showIndexWidget,
  pageTitle,
  pageDescription,
  children,
}) => {
  const value = useMemo<RecipesPluginRuntimeValue>(
    () => ({
      client,
      basePath,
      showIndexWidget,
      pageTitle,
      pageDescription,
    }),
    [client, basePath, showIndexWidget, pageTitle, pageDescription]
  );
  return <RecipesPluginContext.Provider value={value}>{children}</RecipesPluginContext.Provider>;
};

export interface BindRecipesProviderOptions {
  readonly client: RecipesClient;
  readonly basePath?: string;
  readonly showIndexWidget?: boolean;
  readonly pageTitle?: string;
  readonly pageDescription?: string;
}

export function bindRecipesProvider(
  options: BindRecipesProviderOptions
): React.ComponentType<{ children: React.ReactNode }> {
  const config: Omit<RecipesPluginProviderProps, 'children'> = {
    client: options.client,
    basePath: options.basePath?.trim().replace(/\/+$/, '') || DEFAULT_RECIPES_ROUTE_BASE,
    showIndexWidget: options.showIndexWidget ?? true,
    pageTitle: options.pageTitle?.trim() || 'Family Recipe Box',
    pageDescription:
      options.pageDescription?.trim() ||
      'Heirloom recipe cards, kitchen notes, and family culinary traditions preserved alongside the archive.',
  };

  return (props: { children: React.ReactNode }) =>
    createElement(RecipesPluginProvider, config, props.children);
}

export function useRecipesPlugin(): RecipesPluginRuntimeValue {
  const ctx = useContext(RecipesPluginContext);
  if (!ctx) {
    throw new Error('useRecipesPlugin must be used inside a KinloomApp with createRecipesUiPlugin enabled.');
  }
  return ctx;
}
