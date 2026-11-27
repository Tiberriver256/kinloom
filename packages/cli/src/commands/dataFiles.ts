import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ArchiveRawSnapshot,
  type BuildMode,
  type CompileArchiveInput,
  type KinloomSiteConfig,
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  type Place,
  parseEntityPayload,
  parseEventsYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  type RawEvent,
  type RawPerson,
  type SourceRecord,
  serializeEventsYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from '@kinloom/core';

export const ARCHIVE_YAML_FILE_NAMES = [
  'people.yaml',
  'events.yaml',
  'places.yaml',
  'sources.yaml',
  'kinship.yaml',
  'media.yaml',
  'narratives.yaml',
] as const;

export type ArchiveYamlFileName = (typeof ARCHIVE_YAML_FILE_NAMES)[number];

export interface LocalArchiveData {
  people: RawPerson[];
  events: RawEvent[];
  places: Place[];
  sources: SourceRecord[];
  kinship: KinshipEdge[];
  media: MediaItem[];
  narratives: Narrative[];
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function loadArchiveDataDir(dataDir: string): Promise<LocalArchiveData> {
  const [peopleText, eventsText, placesText, sourcesText, kinshipText, mediaText, narrativesText] =
    await Promise.all([
      readOptionalFile(path.join(dataDir, 'people.yaml')),
      readOptionalFile(path.join(dataDir, 'events.yaml')),
      readOptionalFile(path.join(dataDir, 'places.yaml')),
      readOptionalFile(path.join(dataDir, 'sources.yaml')),
      readOptionalFile(path.join(dataDir, 'kinship.yaml')),
      readOptionalFile(path.join(dataDir, 'media.yaml')),
      readOptionalFile(path.join(dataDir, 'narratives.yaml')),
    ]);

  return {
    people: peopleText ? parsePeopleYaml(peopleText) : [],
    events: eventsText ? parseEventsYaml(eventsText) : [],
    places: placesText ? parsePlacesYaml(placesText) : [],
    sources: sourcesText ? parseSourcesYaml(sourcesText) : [],
    kinship: kinshipText ? parseKinshipYaml(kinshipText) : [],
    media: mediaText ? parseMediaYaml(mediaText) : [],
    narratives: narrativesText ? parseNarrativesYaml(narrativesText) : [],
  };
}

export function serializeArchiveDataToYamlFiles(data: LocalArchiveData): Record<ArchiveYamlFileName, string> {
  return {
    'people.yaml': serializePeopleYaml(data.people, { sortById: true }),
    'events.yaml': serializeEventsYaml(data.events, { sortById: true }),
    'places.yaml': serializePlacesYaml(data.places, { sortById: true }),
    'sources.yaml': serializeSourcesYaml(data.sources, { sortById: true }),
    'kinship.yaml': serializeKinshipYaml(data.kinship, { sortDeterministic: true }),
    'media.yaml': serializeMediaYaml(data.media, { sortById: true }),
    'narratives.yaml': serializeNarrativesYaml(data.narratives, { sortById: true }),
  };
}

export async function writeArchiveDataDir(outDir: string, data: LocalArchiveData): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const files = serializeArchiveDataToYamlFiles(data);
  const written: string[] = [];
  for (const name of ARCHIVE_YAML_FILE_NAMES) {
    const filePath = path.join(outDir, name);
    await writeFile(filePath, files[name], 'utf8');
    written.push(filePath);
  }
  return written;
}

export function snapshotToArchiveData(snapshot: ArchiveRawSnapshot): LocalArchiveData {
  const people: RawPerson[] = [];
  const events: RawEvent[] = [];
  const places: Place[] = [];
  const sources: SourceRecord[] = [];
  const media: MediaItem[] = [];
  const narratives: Narrative[] = [];

  for (const row of snapshot.entities) {
    if (row.deleted_at !== null) {
      continue;
    }
    const rawWithCitation: Record<string, unknown> =
      row.data.has_primary_source === undefined && row.has_primary_source === false
        ? { ...row.data, has_primary_source: false }
        : row.data;

    switch (row.entity_type) {
      case 'person':
        people.push(parseEntityPayload('person', rawWithCitation));
        break;
      case 'event':
        events.push(parseEntityPayload('event', rawWithCitation));
        break;
      case 'place':
        places.push(parseEntityPayload('place', rawWithCitation));
        break;
      case 'source':
        sources.push(parseEntityPayload('source', rawWithCitation));
        break;
      case 'media':
        media.push(parseEntityPayload('media', rawWithCitation));
        break;
      case 'narrative':
        narratives.push(parseEntityPayload('narrative', rawWithCitation));
        break;
      default: {
        const _exhaustive: never = row.entity_type;
        throw new Error(`Unexpected entity_type: ${String(_exhaustive)}`);
      }
    }
  }

  const kinship: KinshipEdge[] = [];
  for (const row of snapshot.kinship) {
    if (row.deleted_at !== null) {
      continue;
    }
    kinship.push(parseEntityPayload('kinship_edge', row.edge));
  }

  return { people, events, places, sources, kinship, media, narratives };
}

export function serializeSnapshotToYamlFiles(
  snapshot: ArchiveRawSnapshot
): Record<ArchiveYamlFileName, string> {
  return serializeArchiveDataToYamlFiles(snapshotToArchiveData(snapshot));
}

export function snapshotToCompileInput(params: {
  snapshot: ArchiveRawSnapshot;
  siteConfig: KinloomSiteConfig;
  mode: BuildMode;
  generatedAt?: string;
  version?: string;
  includeEmptyNarratives?: boolean;
}): CompileArchiveInput {
  const data = snapshotToArchiveData(params.snapshot);
  return {
    people: data.people,
    events: data.events,
    places: data.places,
    sources: data.sources,
    kinship: data.kinship,
    media: data.media,
    ...(data.narratives.length > 0 || params.includeEmptyNarratives ? { narratives: data.narratives } : {}),
    siteConfig: params.siteConfig,
    mode: params.mode,
    generatedAt: params.generatedAt,
    version: params.version,
    maxRevisionId: params.snapshot.head_revision_id,
  };
}
