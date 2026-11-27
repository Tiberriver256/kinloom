import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativeEnrichmentsYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
} from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import type { LoadedVerifyArchive } from './types.js';

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function loadVerifyArchive(rawRepoDir?: string): Promise<LoadedVerifyArchive> {
  const repoDir = path.resolve(rawRepoDir?.trim() || process.cwd());
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }

  const dataDir = path.join(repoDir, 'data');
  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new CliValidationError(`Missing data/ directory at ${dataDir}.`);
  }
  if (!fs.existsSync(configPath)) {
    throw new CliValidationError(`Missing kinloom.config.yaml at ${configPath}.`);
  }

  const [
    configText,
    peopleText,
    eventsText,
    placesText,
    sourcesText,
    kinshipText,
    mediaText,
    narrativesText,
    enrichmentsText,
  ] = await Promise.all([
    readFile(configPath, 'utf8'),
    readOptionalUtf8(path.join(dataDir, 'people.yaml')),
    readOptionalUtf8(path.join(dataDir, 'events.yaml')),
    readOptionalUtf8(path.join(dataDir, 'places.yaml')),
    readOptionalUtf8(path.join(dataDir, 'sources.yaml')),
    readOptionalUtf8(path.join(dataDir, 'kinship.yaml')),
    readOptionalUtf8(path.join(dataDir, 'media.yaml')),
    readOptionalUtf8(path.join(dataDir, 'narratives.yaml')),
    readOptionalUtf8(path.join(dataDir, 'narrative_enrichments.yaml')),
  ]);

  const yamlEntries = fs
    .readdirSync(dataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')))
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const yamlTexts = await Promise.all(
    yamlEntries.map(async (entry) => ({
      name: `data/${entry.name}`,
      content: await readFile(path.join(dataDir, entry.name), 'utf8'),
    }))
  );

  return {
    repoDir,
    dataDir,
    siteConfig: parseKinloomConfigYaml(configText),
    people: peopleText ? parsePeopleYaml(peopleText) : [],
    events: eventsText ? parseEventsYaml(eventsText) : [],
    places: placesText ? parsePlacesYaml(placesText) : [],
    sources: sourcesText ? parseSourcesYaml(sourcesText) : [],
    kinship: kinshipText ? parseKinshipYaml(kinshipText) : [],
    media: mediaText ? parseMediaYaml(mediaText) : [],
    narratives: narrativesText ? parseNarrativesYaml(narrativesText) : [],
    enrichments: enrichmentsText ? parseNarrativeEnrichmentsYaml(enrichmentsText) : [],
    yamlTexts,
  };
}
