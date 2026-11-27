import { CliValidationError } from '../../../errors.js';
import { loadLocalArchiveRepo } from '../../dataFiles.js';
import type { LoadedVerifyArchive } from './types.js';

export async function loadVerifyArchive(rawRepoDir?: string): Promise<LoadedVerifyArchive> {
  const loaded = await loadLocalArchiveRepo(rawRepoDir, {
    requireConfig: true,
    includeEnrichments: true,
    includeYamlTexts: true,
  });
  if (!loaded.siteConfig) {
    throw new CliValidationError(`Missing kinloom.config.yaml at ${loaded.configPath}.`);
  }
  return {
    repoDir: loaded.repoDir,
    dataDir: loaded.dataDir,
    siteConfig: loaded.siteConfig,
    people: loaded.people,
    events: loaded.events,
    places: loaded.places,
    sources: loaded.sources,
    kinship: loaded.kinship,
    media: loaded.media,
    narratives: loaded.narratives,
    enrichments: loaded.enrichments,
    yamlTexts: loaded.yamlTexts,
  };
}
