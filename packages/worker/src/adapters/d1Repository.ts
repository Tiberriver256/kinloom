import type { ArchiveRepository, Clock, PrivacyConfig } from '@kinloom/core';
import type { D1Database } from '../types.js';
import { D1AccessAndTalkStore } from './d1/accessAndTalkStore.js';
import { D1AtomicMutationStore } from './d1/atomicMutationStore.js';
import { D1EntityReadStore } from './d1/entityReadStore.js';

export interface D1ArchiveRepositoryOptions {
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
 * Composes D1 entity reads, atomic DB.batch() mutations, and access/talk persistence stores
 * into one cohesive ArchiveRepository without trivial pass-through delegation methods.
 */
export function createD1ArchiveRepository(
  db: D1Database,
  options?: D1ArchiveRepositoryOptions
): ArchiveRepository {
  const entityReads = new D1EntityReadStore(db, options?.privacyConfig, options?.clock);
  const atomicMutations = new D1AtomicMutationStore(db, entityReads);
  const accessAndTalk = new D1AccessAndTalkStore(db);
  return Object.assign(
    {},
    bindPrototypeMethods(entityReads),
    bindPrototypeMethods(atomicMutations),
    bindPrototypeMethods(accessAndTalk)
  );
}

/**
 * Backward-compatible class constructor over `createD1ArchiveRepository`.
 */
export type D1ArchiveRepository = ArchiveRepository;

export const D1ArchiveRepository = class D1ArchiveRepository {
  constructor(db: D1Database, options?: D1ArchiveRepositoryOptions) {
    Object.assign(this, createD1ArchiveRepository(db, options));
  }
} as new (
  db: D1Database,
  options?: D1ArchiveRepositoryOptions
) => ArchiveRepository;
