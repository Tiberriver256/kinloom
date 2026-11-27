import type {
  ArchiveRepository,
  Clock,
  KinloomServerPorts,
  KinloomSiteConfig,
  PrivacyConfig,
} from '@kinloom/core';
import { InMemoryAccessAndTalkStore } from './inMemory/accessAndTalkStore.js';
import { FakeAuthProvider, InMemoryEmailSender } from './inMemory/authAndEmailFakes.js';
import {
  InMemoryIncrementalBundleCache,
  InMemoryMediaStore,
  InMemoryPluginSettingsStore,
  InMemoryPronunciationLexiconStore,
} from './inMemory/bundleAndMediaStores.js';
import { InMemoryEntityAndMutationStore } from './inMemory/entityAndMutationStore.js';
import { FixedClock } from './systemClock.js';

export { extractCollectionsFromSnapshot } from '@kinloom/core';
export {
  FakeAuthProvider,
  type FakeOAuthProfile,
  InMemoryEmailSender,
  type SentMagicLinkEmail,
} from './inMemory/authAndEmailFakes.js';
export {
  InMemoryIncrementalBundleCache,
  InMemoryMediaStore,
  InMemoryPluginSettingsStore,
  InMemoryPronunciationLexiconStore,
} from './inMemory/bundleAndMediaStores.js';

export interface InMemoryArchiveRepositoryOptions {
  privacyConfig?: Partial<PrivacyConfig>;
  clock?: Clock;
}

function bindPrototypeMethods<T extends object>(instance: T): T {
  const proto = Object.getPrototypeOf(instance) as object;
  const bound: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor') {
      continue;
    }
    const value: unknown = Reflect.get(instance, key, instance);
    if (typeof value === 'function') {
      bound[key] = value.bind(instance);
    }
  }
  return bound as T;
}

/**
 * Composes in-memory entity/mutation and access/talk stores into one cohesive
 * ArchiveRepository without trivial pass-through delegation methods.
 */
export function createInMemoryArchiveRepository(
  options?: InMemoryArchiveRepositoryOptions
): ArchiveRepository {
  const entityStore = new InMemoryEntityAndMutationStore(options);
  const accessStore = new InMemoryAccessAndTalkStore();
  return Object.assign(
    { adapterKind: 'in-memory' as const },
    bindPrototypeMethods(entityStore),
    bindPrototypeMethods(accessStore)
  );
}

/**
 * Backward-compatible class constructor over `createInMemoryArchiveRepository`.
 */
export type InMemoryArchiveRepository = ArchiveRepository;

export const InMemoryArchiveRepository = class InMemoryArchiveRepository {
  constructor(options?: InMemoryArchiveRepositoryOptions) {
    Object.assign(this, createInMemoryArchiveRepository(options));
  }
} as new (
  options?: InMemoryArchiveRepositoryOptions
) => ArchiveRepository;

export interface InMemoryServerPortsBundle extends KinloomServerPorts {
  repository: InMemoryArchiveRepository;
  bundleCache: InMemoryIncrementalBundleCache;
  mediaStore: InMemoryMediaStore;
  emailSender: InMemoryEmailSender;
  authProvider: FakeAuthProvider;
  clock: FixedClock;
  pronunciationLexiconStore: InMemoryPronunciationLexiconStore;
  pluginSettingsStore: InMemoryPluginSettingsStore;
}

export function createInMemoryServerPorts(
  siteConfig: KinloomSiteConfig,
  options?: { initialIso?: string }
): InMemoryServerPortsBundle {
  const clock = new FixedClock(options?.initialIso ?? '2026-06-01T12:00:00.000Z');
  const repository = createInMemoryArchiveRepository({ privacyConfig: siteConfig.privacy, clock });
  const bundleCache = new InMemoryIncrementalBundleCache(siteConfig, clock);
  const mediaStore = new InMemoryMediaStore();
  const emailSender = new InMemoryEmailSender();
  const authProvider = new FakeAuthProvider();
  const pronunciationLexiconStore = new InMemoryPronunciationLexiconStore();
  const pluginSettingsStore = new InMemoryPluginSettingsStore();

  return {
    repository,
    bundleCache,
    mediaStore,
    emailSender,
    authProvider,
    clock,
    pronunciationLexiconStore,
    pluginSettingsStore,
  };
}
