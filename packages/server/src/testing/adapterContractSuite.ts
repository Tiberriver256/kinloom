import { describe } from 'vitest';
import { registerAuthAndTokenContractTests } from './contract/authAndTokenContract.js';
import { registerBatchAndRevisionContractTests } from './contract/batchAndRevisionContract.js';
import { registerEntityAndPrivacyContractTests } from './contract/entityAndPrivacyContract.js';
import { type BackendAdapterContractFactory, createContractHarnessRunner } from './contract/harness.js';
import { registerMediaContractTests } from './contract/mediaContract.js';

export {
  type RecipesRepositoryFactory,
  runRecipesRepositoryContractSuite,
} from '../plugins/recipes/recipesRepositoryContractSuite.js';
export {
  type BackendAdapterContractFactory,
  type BackendAdapterContractHarness,
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticEvent,
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  createSyntheticSiteConfig,
} from './contract/harness.js';

/**
 * Reusable Vitest backend adapter contract suite.
 * Run identically against InMemory adapters (@kinloom/server) and Cloudflare D1 + R2 Miniflare adapters (@kinloom/worker).
 */
export function runBackendAdapterContractTests(
  adapterName: string,
  createHarness: BackendAdapterContractFactory
): void {
  describe(`Backend Adapter Contract Suite: ${adapterName}`, () => {
    const withHarness = createContractHarnessRunner(createHarness);
    registerEntityAndPrivacyContractTests(withHarness);
    registerBatchAndRevisionContractTests(withHarness);
    registerMediaContractTests(withHarness);
    registerAuthAndTokenContractTests(withHarness);
  });
}
