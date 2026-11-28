import type {
  ArchiveBundle,
  ArchiveCapabilities,
  ArchiveSessionState,
  EntityType,
  KinloomSiteConfig,
  Narrative,
  Person,
  Place,
  PluginSettingsSnapshot,
} from '@kinloom/core';
import type React from 'react';
import { createContext, Fragment, useCallback, useContext, useMemo, useRef } from 'react';
import { createHttpPluginApiClient, type PluginApiClient } from '../adapters/pluginApiClient.js';
import statusShellStyles from '../components/ArchiveStatusShell.module.css';
import type {
  EntityCreateFormEntry,
  EntityEditFormEntry,
} from '../components/wiki/entityForms/fieldTypes.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { cx } from '../lib/cx.js';
import type {
  KinloomMediaRenderer,
  KinloomUiPlugin,
  KinloomUiPluginRoute,
  KinloomUiPluginSlotContext,
  KinloomUiPluginSlotName,
} from './types.js';
import {
  type CompiledKinloomOnboardingStep,
  type CompiledKinloomTutorialChapter,
  RESERVED_UI_ROUTE_PATHS,
  resolveDynamicPluginOnboardingSteps,
  resolveDynamicPluginTutorialChapters,
  validateAndCompileUiPlugins,
} from './validatePlugins.js';

export {
  type CompiledKinloomOnboardingStep,
  type CompiledKinloomTutorialChapter,
  RESERVED_UI_ROUTE_PATHS,
  resolveDynamicPluginOnboardingSteps,
  resolveDynamicPluginTutorialChapters,
  validateAndCompileUiPlugins,
};

export interface PluginSettingsSyncEvent {
  readonly pluginId: string;
  readonly snapshot?: PluginSettingsSnapshot;
  readonly source: 'plugin-settings-section' | 'plugin-panel';
}

export type PluginSettingsListener = (event: PluginSettingsSyncEvent) => void;

export interface KinloomPluginContextValue {
  readonly plugins: readonly KinloomUiPlugin[];
  readonly routes: readonly (KinloomUiPluginRoute & { pluginId: string })[];
  readonly mediaRenderers: readonly KinloomMediaRenderer[];
  readonly entityEditForms: Readonly<Partial<Record<EntityType, EntityEditFormEntry>>>;
  readonly entityCreateForms: Readonly<Partial<Record<EntityType, EntityCreateFormEntry>>>;
  readonly onboardingSteps: readonly CompiledKinloomOnboardingStep[];
  readonly tutorialChapters: readonly CompiledKinloomTutorialChapter[];
  readonly apiClient: PluginApiClient;
  readonly subscribePluginSettings: (pluginId: string | '*', listener: PluginSettingsListener) => () => void;
  readonly notifyPluginSettingsUpdated: (event: PluginSettingsSyncEvent) => void;
}

export interface KinloomPluginRuntimeContext {
  readonly siteConfig: KinloomSiteConfig;
  readonly baseUrl: string;
  readonly session: ArchiveSessionState | null;
  readonly capabilities: ArchiveCapabilities;
  readonly bundle: ArchiveBundle | null;
  readonly apiClient: PluginApiClient;
  readonly getDeceasedPersonById: (personId: string) => Person | null;
  readonly searchDeceasedPeople: (query: string, limit?: number) => readonly Person[];
}

const EMPTY_PLUGINS: readonly KinloomUiPlugin[] = [];
const EMPTY_EDIT_FORMS: Readonly<Partial<Record<EntityType, EntityEditFormEntry>>> = {};
const EMPTY_CREATE_FORMS: Readonly<Partial<Record<EntityType, EntityCreateFormEntry>>> = {};
const DEFAULT_PLUGIN_API_CLIENT: PluginApiClient = createHttpPluginApiClient();

const NOOP_UNSUBSCRIBE = (): void => {};
const NOOP_SUBSCRIBE = (): (() => void) => NOOP_UNSUBSCRIBE;
const NOOP_NOTIFY = (): void => {};

const KinloomPluginContext = createContext<KinloomPluginContextValue>({
  plugins: EMPTY_PLUGINS,
  routes: [],
  mediaRenderers: [],
  entityEditForms: EMPTY_EDIT_FORMS,
  entityCreateForms: EMPTY_CREATE_FORMS,
  onboardingSteps: [],
  tutorialChapters: [],
  apiClient: DEFAULT_PLUGIN_API_CLIENT,
  subscribePluginSettings: NOOP_SUBSCRIBE,
  notifyPluginSettingsUpdated: NOOP_NOTIFY,
});

export interface KinloomPluginProviderProps {
  plugins?: readonly KinloomUiPlugin[] | undefined;
  apiClient?: PluginApiClient | undefined;
  children: React.ReactNode;
}

interface PluginSettingsSubscription {
  readonly pluginId: string | '*';
  readonly listener: PluginSettingsListener;
}

export const KinloomPluginProvider: React.FC<KinloomPluginProviderProps> = ({
  plugins = EMPTY_PLUGINS,
  apiClient = DEFAULT_PLUGIN_API_CLIENT,
  children,
}) => {
  const subscriptionsRef = useRef<Set<PluginSettingsSubscription>>(new Set());

  const subscribePluginSettings = useCallback(
    (pluginId: string | '*', listener: PluginSettingsListener): (() => void) => {
      const entry: PluginSettingsSubscription = { pluginId, listener };
      subscriptionsRef.current.add(entry);
      return () => {
        subscriptionsRef.current.delete(entry);
      };
    },
    []
  );

  const notifyPluginSettingsUpdated = useCallback((event: PluginSettingsSyncEvent): void => {
    for (const sub of [...subscriptionsRef.current]) {
      if (sub.pluginId !== '*' && sub.pluginId !== event.pluginId) {
        continue;
      }
      try {
        sub.listener(event);
      } catch {
        // Isolate subscriber failures so one panel error cannot block sibling updates.
      }
    }
  }, []);

  const value = useMemo<KinloomPluginContextValue>(
    () => ({
      ...validateAndCompileUiPlugins(plugins),
      apiClient,
      subscribePluginSettings,
      notifyPluginSettingsUpdated,
    }),
    [plugins, apiClient, subscribePluginSettings, notifyPluginSettingsUpdated]
  );

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

function isDeceasedPublicPerson(person: Person): boolean {
  return !person.is_living && person.full_name !== 'Living';
}

/**
 * Typed runtime context for UI plugin routes and slot components.
 * Exposes archive session, capabilities, CSRF-safe PluginApiClient, and strictly
 * deceased-only ancestor lookup helpers.
 */
export function useKinloomPluginContext(): KinloomPluginRuntimeContext {
  const { siteConfig, baseUrl, session, capabilities, bundle, peopleById } = useArchiveData();
  const { apiClient } = useKinloomPlugins();

  const getDeceasedPersonById = useCallback(
    (personId: string): Person | null => {
      const found = peopleById.get(personId);
      if (!found || !isDeceasedPublicPerson(found)) {
        return null;
      }
      return found;
    },
    [peopleById]
  );

  const searchDeceasedPeople = useCallback(
    (query: string, limit = 20): readonly Person[] => {
      if (!bundle) {
        return [];
      }
      const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
      const needle = query.trim().toLowerCase();
      const matched: Person[] = [];
      for (const person of bundle.people) {
        if (!isDeceasedPublicPerson(person)) {
          continue;
        }
        if (needle.length > 0) {
          const nameMatch = person.full_name.toLowerCase().includes(needle);
          const altMatch = (person.alt_names ?? []).some((alt) => alt.toLowerCase().includes(needle));
          if (!nameMatch && !altMatch) {
            continue;
          }
        }
        matched.push(person);
      }
      return matched.toSorted((a, b) => a.full_name.localeCompare(b.full_name)).slice(0, safeLimit);
    },
    [bundle]
  );

  return useMemo<KinloomPluginRuntimeContext>(
    () => ({
      siteConfig,
      baseUrl,
      session,
      capabilities,
      bundle,
      apiClient,
      getDeceasedPersonById,
      searchDeceasedPeople,
    }),
    [
      siteConfig,
      baseUrl,
      session,
      capabilities,
      bundle,
      apiClient,
      getDeceasedPersonById,
      searchDeceasedPeople,
    ]
  );
}

export interface PluginSlotProps {
  name: KinloomUiPluginSlotName;
  person?: Person | undefined;
  place?: Place | undefined;
  narrative?: Narrative | undefined;
  className?: string | undefined;
  as?: 'div' | 'fragment' | undefined;
}

/**
 * Renders every plugin contribution registered for `name`.
 * Returns `null` when no plugins contribute output so empty slots add zero DOM clutter.
 */
export const PluginSlot: React.FC<PluginSlotProps> = ({
  name,
  person,
  place,
  narrative,
  className,
  as = 'div',
}) => {
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
        as === 'fragment' ? (
          <Fragment key={`${plugin.id}:${name}`}>{output}</Fragment>
        ) : (
          <div key={`${plugin.id}:${name}`} className={'kinloom-plugin-slot-item'} data-plugin-id={plugin.id}>
            {output}
          </div>
        )
      );
    }
  }

  if (rendered.length === 0) {
    return null;
  }

  if (as === 'fragment') {
    return <>{rendered}</>;
  }

  return (
    <div
      className={cx(
        statusShellStyles,
        className ? `kinloom-plugin-slot ${className}` : 'kinloom-plugin-slot'
      )}
      data-slot={name}
    >
      {rendered}
    </div>
  );
};
