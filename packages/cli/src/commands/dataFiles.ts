import fs from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ArchiveRawSnapshot,
  type BuildMode,
  type CompileArchiveInput,
  type EntityType,
  fastLocaleCompare,
  type KinloomSiteConfig,
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  type NarrativeEnrichment,
  type Place,
  parseEntityPayload,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativeEnrichmentsYaml,
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
import { CliValidationError } from '../errors.js';

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

export interface LoadLocalArchiveRepoOptions {
  dataDirOverride?: string;
  requireConfig?: boolean;
  requirePeopleFile?: boolean;
  includeEnrichments?: boolean;
  includeYamlTexts?: boolean;
}

export interface LoadedLocalArchiveRepo extends LocalArchiveData {
  repoDir: string;
  dataDir: string;
  configPath: string;
  siteConfig: KinloomSiteConfig | null;
  enrichments: NarrativeEnrichment[];
  yamlTexts: Array<{ name: string; content: string }>;
}

interface RawLocalArchiveTexts {
  configText: string | null;
  peopleText: string | null;
  eventsText: string | null;
  placesText: string | null;
  sourcesText: string | null;
  kinshipText: string | null;
  mediaText: string | null;
  narrativesText: string | null;
  enrichmentsText: string | null;
}

function readOptionalFileSync(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function parseLocalArchiveTexts(texts: RawLocalArchiveTexts): LocalArchiveData & {
  siteConfig: KinloomSiteConfig | null;
  enrichments: NarrativeEnrichment[];
} {
  return {
    siteConfig: texts.configText ? parseKinloomConfigYaml(texts.configText) : null,
    people: texts.peopleText ? parsePeopleYaml(texts.peopleText) : [],
    events: texts.eventsText ? parseEventsYaml(texts.eventsText) : [],
    places: texts.placesText ? parsePlacesYaml(texts.placesText) : [],
    sources: texts.sourcesText ? parseSourcesYaml(texts.sourcesText) : [],
    kinship: texts.kinshipText ? parseKinshipYaml(texts.kinshipText) : [],
    media: texts.mediaText ? parseMediaYaml(texts.mediaText) : [],
    narratives: texts.narrativesText ? parseNarrativesYaml(texts.narrativesText) : [],
    enrichments: texts.enrichmentsText ? parseNarrativeEnrichmentsYaml(texts.enrichmentsText) : [],
  };
}

function resolveLocalArchiveRepoPaths(
  rawRepoDir: string | undefined,
  options: LoadLocalArchiveRepoOptions
): { repoDir: string; dataDir: string; configPath: string } {
  const repoDir = path.resolve(rawRepoDir?.trim() || process.cwd());
  const repoStat = fs.statSync(repoDir, { throwIfNoEntry: false });
  if (!repoStat?.isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }
  const dataDir = options.dataDirOverride
    ? path.resolve(options.dataDirOverride)
    : path.join(repoDir, 'data');
  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  const dataStat = fs.statSync(dataDir, { throwIfNoEntry: false });
  if (!dataStat?.isDirectory()) {
    throw new CliValidationError(`Missing data/ directory at ${dataDir}.`);
  }
  return { repoDir, dataDir, configPath };
}

function buildKnownDataTextMap(texts: RawLocalArchiveTexts): Map<string, string> {
  const known = new Map<string, string>();
  if (texts.peopleText !== null) known.set('people.yaml', texts.peopleText);
  if (texts.eventsText !== null) known.set('events.yaml', texts.eventsText);
  if (texts.placesText !== null) known.set('places.yaml', texts.placesText);
  if (texts.sourcesText !== null) known.set('sources.yaml', texts.sourcesText);
  if (texts.kinshipText !== null) known.set('kinship.yaml', texts.kinshipText);
  if (texts.mediaText !== null) known.set('media.yaml', texts.mediaText);
  if (texts.narrativesText !== null) known.set('narratives.yaml', texts.narrativesText);
  if (texts.enrichmentsText !== null) known.set('narrative_enrichments.yaml', texts.enrichmentsText);
  return known;
}

export async function loadArchiveDataDir(dataDir: string): Promise<LocalArchiveData> {
  const files = new Set<string>(fs.readdirSync(dataDir));
  const readIfPresent = (name: string): string | null =>
    files.has(name) ? readOptionalFileSync(path.join(dataDir, name)) : null;

  const parsed = parseLocalArchiveTexts({
    configText: null,
    peopleText: readIfPresent('people.yaml'),
    eventsText: readIfPresent('events.yaml'),
    placesText: readIfPresent('places.yaml'),
    sourcesText: readIfPresent('sources.yaml'),
    kinshipText: readIfPresent('kinship.yaml'),
    mediaText: readIfPresent('media.yaml'),
    narrativesText: readIfPresent('narratives.yaml'),
    enrichmentsText: null,
  });

  return {
    people: parsed.people,
    events: parsed.events,
    places: parsed.places,
    sources: parsed.sources,
    kinship: parsed.kinship,
    media: parsed.media,
    narratives: parsed.narratives,
  };
}

export async function loadLocalArchiveRepo(
  rawRepoDir?: string,
  options: LoadLocalArchiveRepoOptions = {}
): Promise<LoadedLocalArchiveRepo> {
  return loadLocalArchiveRepoSync(rawRepoDir, options);
}

export function loadLocalArchiveRepoSync(
  rawRepoDir?: string,
  options: LoadLocalArchiveRepoOptions = {}
): LoadedLocalArchiveRepo {
  const { repoDir, dataDir, configPath } = resolveLocalArchiveRepoPaths(rawRepoDir, options);
  const configText = readOptionalFileSync(configPath);
  if (options.requireConfig !== false && configText === null) {
    throw new CliValidationError(`Missing kinloom.config.yaml at ${configPath}.`);
  }

  const dataEntries = fs.readdirSync(dataDir, { withFileTypes: true });
  const dataEntryNames = new Set<string>();
  const regularFileNames = new Set<string>();
  for (let i = 0; i < dataEntries.length; i += 1) {
    dataEntryNames.add(dataEntries[i].name);
    if (!dataEntries[i].isDirectory()) {
      regularFileNames.add(dataEntries[i].name);
    }
  }
  if (options.requirePeopleFile && !regularFileNames.has('people.yaml')) {
    throw new CliValidationError(`Missing ${path.join(dataDir, 'people.yaml')}.`);
  }

  const readDataFile = (name: string): string | null =>
    dataEntryNames.has(name) ? readOptionalFileSync(path.join(dataDir, name)) : null;

  const rawTexts: RawLocalArchiveTexts = {
    configText,
    peopleText: readDataFile('people.yaml'),
    eventsText: readDataFile('events.yaml'),
    placesText: readDataFile('places.yaml'),
    sourcesText: readDataFile('sources.yaml'),
    kinshipText: readDataFile('kinship.yaml'),
    mediaText: readDataFile('media.yaml'),
    narrativesText: readDataFile('narratives.yaml'),
    enrichmentsText: options.includeEnrichments ? readDataFile('narrative_enrichments.yaml') : null,
  };
  const parsed = parseLocalArchiveTexts(rawTexts);

  let yamlTexts: Array<{ name: string; content: string }> = [];
  if (options.includeYamlTexts) {
    const knownByFile = buildKnownDataTextMap(rawTexts);
    const yamlNames: string[] = [];
    for (let i = 0; i < dataEntries.length; i += 1) {
      const entry = dataEntries[i];
      if (entry.isFile() && (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml'))) {
        yamlNames.push(entry.name);
      }
    }
    yamlNames.sort(fastLocaleCompare);
    yamlTexts = yamlNames.map((name) => ({
      name: `data/${name}`,
      content: knownByFile.get(name) ?? fs.readFileSync(path.join(dataDir, name), 'utf8'),
    }));
  }

  return {
    repoDir,
    dataDir,
    configPath,
    ...parsed,
    yamlTexts,
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

type SnapshotEntityType = Exclude<EntityType, 'kinship_edge'>;

export function snapshotToArchiveData(snapshot: ArchiveRawSnapshot): LocalArchiveData {
  const people: RawPerson[] = [];
  const events: RawEvent[] = [];
  const places: Place[] = [];
  const sources: SourceRecord[] = [];
  const media: MediaItem[] = [];
  const narratives: Narrative[] = [];

  const appendEntityByType: Readonly<Record<SnapshotEntityType, (raw: Record<string, unknown>) => void>> = {
    person: (raw) => {
      people.push(parseEntityPayload('person', raw));
    },
    event: (raw) => {
      events.push(parseEntityPayload('event', raw));
    },
    place: (raw) => {
      places.push(parseEntityPayload('place', raw));
    },
    source: (raw) => {
      sources.push(parseEntityPayload('source', raw));
    },
    media: (raw) => {
      media.push(parseEntityPayload('media', raw));
    },
    narrative: (raw) => {
      narratives.push(parseEntityPayload('narrative', raw));
    },
  };

  for (const row of snapshot.entities) {
    if (row.deleted_at !== null) {
      continue;
    }
    const rawWithCitation: Record<string, unknown> =
      row.data.has_primary_source === undefined && row.has_primary_source === false
        ? { ...row.data, has_primary_source: false }
        : row.data;
    appendEntityByType[row.entity_type](rawWithCitation);
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
