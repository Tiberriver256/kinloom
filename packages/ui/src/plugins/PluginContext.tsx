import type { Narrative, Person, Place } from '@kinloom/core';
import type React from 'react';
import { createContext, useContext, useMemo } from 'react';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import type {
  KinloomMediaRenderer,
  KinloomUiPlugin,
  KinloomUiPluginRoute,
  KinloomUiPluginSlotContext,
  KinloomUiPluginSlotName,
} from './types.js';

export interface KinloomPluginContextValue {
  readonly plugins: readonly KinloomUiPlugin[];
  readonly routes: readonly (KinloomUiPluginRoute & { pluginId: string })[];
  readonly mediaRenderers: readonly KinloomMediaRenderer[];
}

const EMPTY_PLUGINS: readonly KinloomUiPlugin[] = [];

const KinloomPluginContext = createContext<KinloomPluginContextValue>({
  plugins: EMPTY_PLUGINS,
  routes: [],
  mediaRenderers: [],
});

export interface KinloomPluginProviderProps {
  plugins?: readonly KinloomUiPlugin[];
  children: React.ReactNode;
}

export const KinloomPluginProvider: React.FC<KinloomPluginProviderProps> = ({
  plugins = EMPTY_PLUGINS,
  children,
}) => {
  const value = useMemo<KinloomPluginContextValue>(() => {
    const routes: (KinloomUiPluginRoute & { pluginId: string })[] = [];
    const mediaRenderers: KinloomMediaRenderer[] = [];
    for (const plugin of plugins) {
      if (plugin.routes) {
        for (const route of plugin.routes) {
          routes.push({ ...route, pluginId: plugin.id });
        }
      }
      if (plugin.mediaRenderers) {
        mediaRenderers.push(...plugin.mediaRenderers);
      }
    }
    return { plugins, routes, mediaRenderers };
  }, [plugins]);

  const wrappedChildren = plugins.reduceRight<React.ReactNode>((acc, plugin) => {
    if (!plugin.provider) {
      return acc;
    }
    const Provider = plugin.provider;
    return <Provider key={plugin.id}>{acc}</Provider>;
  }, children);

  return <KinloomPluginContext.Provider value={value}>{wrappedChildren}</KinloomPluginContext.Provider>;
};

export function useKinloomPlugins(): KinloomPluginContextValue {
  return useContext(KinloomPluginContext);
}

export interface PluginSlotProps {
  name: KinloomUiPluginSlotName;
  person?: Person;
  place?: Place;
  narrative?: Narrative;
  className?: string;
}

/**
 * Renders every plugin contribution registered for `name`.
 * Returns `null` when no plugins contribute output so empty slots add zero DOM clutter.
 */
export const PluginSlot: React.FC<PluginSlotProps> = ({ name, person, place, narrative, className }) => {
  const { plugins } = useKinloomPlugins();
  const { bundle, siteConfig, baseUrl, session, capabilities } = useArchiveData();

  if (plugins.length === 0) {
    return null;
  }

  const slotCtx: KinloomUiPluginSlotContext = {
    bundle,
    siteConfig,
    baseUrl,
    session,
    capabilities,
    person,
    place,
    narrative,
  };

  const rendered: React.ReactNode[] = [];
  for (const plugin of plugins) {
    const renderer = plugin.slots?.[name];
    if (!renderer) {
      continue;
    }
    const output = renderer(slotCtx);
    if (output !== null && output !== undefined && output !== false) {
      rendered.push(
        <div key={`${plugin.id}:${name}`} className="kinloom-plugin-slot-item" data-plugin-id={plugin.id}>
          {output}
        </div>
      );
    }
  }

  if (rendered.length === 0) {
    return null;
  }

  return (
    <div className={className ? `kinloom-plugin-slot ${className}` : 'kinloom-plugin-slot'} data-slot={name}>
      {rendered}
    </div>
  );
};
