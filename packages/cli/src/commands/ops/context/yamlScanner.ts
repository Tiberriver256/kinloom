import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  extractYamlBlockId,
  isPlainYamlRecord,
  parseBlocksById,
  parseMatchingYamlBlocks,
  splitTopLevelYamlList,
} from '../shared/yamlScanner.js';
import type { ArchiveYamlBlocks, LooseYamlRecord } from './types.js';

export { extractYamlBlockId, parseBlocksById, parseMatchingYamlBlocks, splitTopLevelYamlList };

export function isPlainRecord(value: unknown): value is LooseYamlRecord {
  return isPlainYamlRecord(value);
}

export function asNonEmptyString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

export function extractNumericXref(xref: unknown): string | null {
  if (typeof xref !== 'string') {
    return null;
  }
  const match = /(\d{6,})/.exec(xref);
  return match ? match[1] : null;
}

export function formatLifespan(person: LooseYamlRecord): string {
  const birth = asNonEmptyString(person.birth_edtf) || '?';
  const death = asNonEmptyString(person.death_edtf) || '?';
  return `${birth} - ${death}`;
}

export async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function loadArchiveYamlBlocks(repoDir: string, dataDir: string): Promise<ArchiveYamlBlocks> {
  const [
    configText,
    peopleText,
    kinshipText,
    eventsText,
    placesText,
    sourcesText,
    mediaText,
    narrativesText,
  ] = await Promise.all([
    readOptionalUtf8(path.join(repoDir, 'kinloom.config.yaml')).then(
      (text) => text || readOptionalUtf8(path.join(dataDir, 'kinloom.config.yaml'))
    ),
    readOptionalUtf8(path.join(dataDir, 'people.yaml')),
    readOptionalUtf8(path.join(dataDir, 'kinship.yaml')),
    readOptionalUtf8(path.join(dataDir, 'events.yaml')),
    readOptionalUtf8(path.join(dataDir, 'places.yaml')),
    readOptionalUtf8(path.join(dataDir, 'sources.yaml')),
    readOptionalUtf8(path.join(dataDir, 'media.yaml')),
    readOptionalUtf8(path.join(dataDir, 'narratives.yaml')),
  ]);

  return {
    configText,
    peopleBlocks: splitTopLevelYamlList(peopleText),
    kinshipBlocks: splitTopLevelYamlList(kinshipText),
    eventBlocks: splitTopLevelYamlList(eventsText),
    placeBlocks: splitTopLevelYamlList(placesText),
    sourceBlocks: splitTopLevelYamlList(sourcesText),
    mediaBlocks: splitTopLevelYamlList(mediaText),
    narrativeBlocks: splitTopLevelYamlList(narrativesText),
  };
}
