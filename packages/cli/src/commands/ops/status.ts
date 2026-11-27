import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  edtfYear,
  getMediaPersonIds,
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  type Place,
  type PrivacyConfig,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  type RawEvent,
  type RawPerson,
  resolveEffectiveLiving,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';

export { STATUS_HELP } from './help.js';

const ZERO_COORD_EPSILON = 1e-9;
const DEFAULT_STATUS_TEXT_LIMIT = 8;

export type BiographyQueueStatus = 'pending' | 'staged' | 'done_live';
export type StatusSortMode = 'sparsest' | 'richest' | 'chronological';

export interface StatusTextDisplay {
  limit?: number;
  filter?: BiographyQueueStatus;
  sort?: StatusSortMode;
  endOfLine?: boolean;
  missingBiography?: boolean;
}

export interface StatusCommandOptions extends StatusTextDisplay {
  repoDir?: string;
  json?: boolean;
}

export interface BiographyCoverageSummary {
  complete: number;
  missing: number;
  totalDeceased: number;
}

export interface DeceasedQueueItem {
  id: string;
  full_name: string;
  birth_edtf: string;
  death_edtf: string;
  events: number;
  sources: number;
  media: number;
  has_biography: boolean;
  hasBiography: boolean;
  biographyId: string | null;
  has_staged_patch: boolean;
  status: BiographyQueueStatus;
}

export interface StatusReport {
  repo: string;
  sort: StatusSortMode;
  endOfLine: boolean;
  endOfLineCount: number;
  missingBiography: boolean;
  people: { total: number; deceased: number; living: number };
  events: number;
  places: number;
  zeroCoordPlaces: number;
  sources: number;
  media: number;
  narratives: number;
  biographies: BiographyCoverageSummary;
  queue: { done_live: number; staged: number; pending: number };
  deceased: DeceasedQueueItem[];
}

export interface StatusCommandResult extends StatusReport {
  rendered: string;
}

const STATUS_RANK: Record<BiographyQueueStatus, number> = {
  pending: 0,
  staged: 1,
  done_live: 2,
};

export function parseStatusSort(value: string | undefined): StatusSortMode {
  if (value === undefined) {
    return 'sparsest';
  }
  const trimmed = value.trim();
  if (trimmed === 'sparsest' || trimmed === 'richest' || trimmed === 'chronological') {
    return trimmed;
  }
  throw new CliValidationError('Option `--sort` must be `sparsest`, `richest`, or `chronological`.');
}

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

function isZeroCoordPlace(place: Place): boolean {
  return Math.abs(place.lat) < ZERO_COORD_EPSILON && Math.abs(place.lng) < ZERO_COORD_EPSILON;
}

function compareNullableYear(a: number | null, b: number | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a - b;
}

function queueStatus(hasBiography: boolean, hasStagedPatch: boolean): BiographyQueueStatus {
  if (hasBiography) {
    return 'done_live';
  }
  if (hasStagedPatch) {
    return 'staged';
  }
  return 'pending';
}

const STATUS_SORT_COMPARATORS: Record<
  StatusSortMode,
  (a: DeceasedQueueItem, b: DeceasedQueueItem) => number
> = {
  sparsest: (a, b) =>
    a.events - b.events ||
    a.sources - b.sources ||
    a.media - b.media ||
    compareNullableYear(edtfYear(a.birth_edtf), edtfYear(b.birth_edtf)) ||
    a.id.localeCompare(b.id),
  richest: (a, b) =>
    b.events - a.events ||
    b.sources - a.sources ||
    b.media - a.media ||
    compareNullableYear(edtfYear(a.birth_edtf), edtfYear(b.birth_edtf)) ||
    a.id.localeCompare(b.id),
  chronological: (a, b) =>
    compareNullableYear(edtfYear(a.birth_edtf), edtfYear(b.birth_edtf)) ||
    compareNullableYear(edtfYear(a.death_edtf), edtfYear(b.death_edtf)) ||
    a.events - b.events ||
    a.id.localeCompare(b.id),
};

function compareDeceased(sort: StatusSortMode): (a: DeceasedQueueItem, b: DeceasedQueueItem) => number {
  const compareItems = STATUS_SORT_COMPARATORS[sort];
  return (a, b) => {
    const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (byStatus !== 0) {
      return byStatus;
    }
    return compareItems(a, b);
  };
}

interface PersonResearchCounts {
  events: number;
  sources: number;
  media: number;
}

function indexResearchCounts(
  events: readonly RawEvent[],
  media: readonly MediaItem[]
): Map<string, PersonResearchCounts> {
  const counts = new Map<string, { eventIds: Set<string>; sourceIds: Set<string>; mediaIds: Set<string> }>();
  const bucket = (personId: string) => {
    let row = counts.get(personId);
    if (!row) {
      row = { eventIds: new Set(), sourceIds: new Set(), mediaIds: new Set() };
      counts.set(personId, row);
    }
    return row;
  };

  for (const event of events) {
    const participantIds = new Set(event.participants.map((participant) => participant.person_id));
    const sourceIds = event.sources.map((source) => source.source_id);
    for (const personId of participantIds) {
      const row = bucket(personId);
      row.eventIds.add(event.id);
      for (const sourceId of sourceIds) {
        row.sourceIds.add(sourceId);
      }
    }
  }

  for (const item of media) {
    for (const personId of getMediaPersonIds(item)) {
      bucket(personId).mediaIds.add(item.id);
    }
  }

  const flattened = new Map<string, PersonResearchCounts>();
  for (const [personId, row] of counts) {
    flattened.set(personId, {
      events: row.eventIds.size,
      sources: row.sourceIds.size,
      media: row.mediaIds.size,
    });
  }
  return flattened;
}

function indexBiographyByPersonId(narratives: readonly Narrative[]): Map<string, string> {
  const byPerson = new Map<string, string>();
  for (const narrative of narratives) {
    if (narrative.kind === 'biography' && narrative.subject_person_id) {
      const existing = byPerson.get(narrative.subject_person_id);
      if (!existing || narrative.id.localeCompare(existing) < 0) {
        byPerson.set(narrative.subject_person_id, narrative.id);
      }
    }
  }
  return byPerson;
}

export function indexEndOfLinePersonIds(kinship: readonly KinshipEdge[]): Set<string> {
  const parentsByPerson = new Map<string, Set<string>>();
  const childrenByPerson = new Map<string, Set<string>>();
  const addLink = (map: Map<string, Set<string>>, key: string, value: string): void => {
    let set = map.get(key);
    if (!set) {
      set = new Set<string>();
      map.set(key, set);
    }
    set.add(value);
  };

  for (const edge of kinship) {
    if (edge.relation === 'parent') {
      addLink(parentsByPerson, edge.to, edge.from);
      addLink(childrenByPerson, edge.from, edge.to);
    } else if (edge.relation === 'child') {
      addLink(parentsByPerson, edge.from, edge.to);
      addLink(childrenByPerson, edge.to, edge.from);
    }
  }

  const endOfLine = new Set<string>();
  for (const [personId, children] of childrenByPerson) {
    if (children.size > 0 && (parentsByPerson.get(personId)?.size ?? 0) === 0) {
      endOfLine.add(personId);
    }
  }
  return endOfLine;
}

export function buildDeceasedQueue(input: {
  repoDir: string;
  people: readonly RawPerson[];
  events: readonly RawEvent[];
  media: readonly MediaItem[];
  narratives: readonly Narrative[];
  kinship?: readonly KinshipEdge[];
  privacy?: Partial<PrivacyConfig>;
  sort?: StatusSortMode;
  endOfLine?: boolean;
}): DeceasedQueueItem[] {
  const sort = parseStatusSort(input.sort);
  const endOfLineIds = input.endOfLine ? indexEndOfLinePersonIds(input.kinship ?? []) : null;
  const research = indexResearchCounts(input.events, input.media);
  const biographiesByPerson = indexBiographyByPersonId(input.narratives);
  const items: DeceasedQueueItem[] = [];
  for (const person of input.people) {
    if (resolveEffectiveLiving(person, input.privacy)) {
      continue;
    }
    if (endOfLineIds && !endOfLineIds.has(person.id)) {
      continue;
    }
    const counts = research.get(person.id) ?? { events: 0, sources: 0, media: 0 };
    const biographyId = biographiesByPerson.get(person.id) ?? null;
    const hasBiography = biographyId !== null;
    const hasStagedPatch = fs.existsSync(
      path.join(input.repoDir, 'research', 'people', person.id, 'patch.json')
    );
    items.push({
      id: person.id,
      full_name: person.full_name,
      birth_edtf: person.birth_edtf,
      death_edtf: person.death_edtf,
      events: counts.events,
      sources: counts.sources,
      media: counts.media,
      has_biography: hasBiography,
      hasBiography,
      biographyId,
      has_staged_patch: hasStagedPatch,
      status: queueStatus(hasBiography, hasStagedPatch),
    });
  }
  items.sort(input.endOfLine ? STATUS_SORT_COMPARATORS[sort] : compareDeceased(sort));
  return items;
}

const STATUS_FILTER_TITLE: Record<BiographyQueueStatus, string> = {
  pending: 'Pending',
  staged: 'Staged',
  done_live: 'Done live',
};

const STATUS_SORT_LABEL: Record<StatusSortMode, string> = {
  sparsest: 'sparsest first',
  richest: 'richest first',
  chronological: 'chronological',
};

function formatQueueHeading(
  filter: BiographyQueueStatus | undefined,
  sort: StatusSortMode,
  endOfLine: boolean,
  missingBiography: boolean
): string {
  if (missingBiography) {
    const scope = endOfLine ? 'End-of-line missing biography' : 'Missing biography';
    if (filter) {
      return `${scope} ${STATUS_FILTER_TITLE[filter].toLowerCase()} (${STATUS_SORT_LABEL[sort]}):`;
    }
    return `${scope} (${STATUS_SORT_LABEL[sort]}):`;
  }
  if (endOfLine) {
    if (filter) {
      return `End-of-line ${STATUS_FILTER_TITLE[filter].toLowerCase()} (${STATUS_SORT_LABEL[sort]}):`;
    }
    return `End-of-line ancestors (${STATUS_SORT_LABEL[sort]}):`;
  }
  const activeFilter = filter ?? 'pending';
  return `${STATUS_FILTER_TITLE[activeFilter]} (${STATUS_SORT_LABEL[sort]}):`;
}

export function formatStatusTextReport(report: StatusReport, display: StatusTextDisplay = {}): string {
  const limit = display.limit ?? DEFAULT_STATUS_TEXT_LIMIT;
  const endOfLine = display.endOfLine ?? report.endOfLine;
  const missingBiography = display.missingBiography ?? report.missingBiography;
  const filter = endOfLine || missingBiography ? display.filter : (display.filter ?? 'pending');
  const sort = parseStatusSort(display.sort ?? report.sort);
  const lines = [
    `Status ${report.repo}`,
    `People: ${report.people.total} total, ${report.people.deceased} deceased, ${report.people.living} living`,
    `Events: ${report.events}`,
    `Places: ${report.places}`,
    `Zero-coordinate places: ${report.zeroCoordPlaces}`,
    `Sources: ${report.sources}`,
    `Media: ${report.media}`,
    `Narratives: ${report.narratives}`,
    `Biographies: ${report.biographies.complete}/${report.biographies.totalDeceased} deceased (${report.biographies.missing} missing)`,
    `End-of-line ancestors: ${report.endOfLineCount}`,
    `Queue: done_live=${report.queue.done_live} staged=${report.queue.staged} pending=${report.queue.pending}`,
  ];
  const baseRows = missingBiography
    ? report.deceased.filter((person) => !person.hasBiography)
    : report.deceased;
  const matching = filter ? baseRows.filter((person) => person.status === filter) : baseRows;
  lines.push(formatQueueHeading(filter, sort, endOfLine, missingBiography));
  if (matching.length === 0) {
    lines.push('  (none)');
  } else {
    const shown = limit === 0 ? matching : matching.slice(0, limit);
    const showStatus = (endOfLine || missingBiography) && !filter;
    for (const person of shown) {
      const birth = person.birth_edtf.trim() || '?';
      const bioValue = person.hasBiography ? 'yes' : 'no';
      const statusSuffix = showStatus ? ` status=${person.status}` : '';
      lines.push(
        `  ${person.full_name} (${person.id}) birth=${birth} death=${person.death_edtf || '?'} events=${person.events} sources=${person.sources} media=${person.media} Bio=${bioValue}${statusSuffix}`
      );
    }
    const hidden = matching.length - shown.length;
    if (hidden > 0) {
      const label = missingBiography
        ? endOfLine
          ? filter
            ? `end-of-line missing-biography ${filter}`
            : 'end-of-line missing-biography'
          : filter
            ? `missing-biography ${filter}`
            : 'missing-biography'
        : endOfLine
          ? filter
            ? `end-of-line ${filter}`
            : 'end-of-line'
          : (filter ?? 'pending');
      lines.push(`  ... and ${hidden} more ${label}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function runStatusCommand(options: StatusCommandOptions = {}): Promise<StatusCommandResult> {
  const sort = parseStatusSort(options.sort);
  const endOfLine = Boolean(options.endOfLine);
  const missingBiography = Boolean(options.missingBiography);
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }
  const dataDir = path.join(repoDir, 'data');
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new CliValidationError(`Missing data/ directory at ${dataDir}.`);
  }

  const [
    configText,
    peopleText,
    eventsText,
    placesText,
    sourcesText,
    mediaText,
    narrativesText,
    kinshipText,
  ] = await Promise.all([
    readOptionalUtf8(path.join(repoDir, 'kinloom.config.yaml')),
    readOptionalUtf8(path.join(dataDir, 'people.yaml')),
    readOptionalUtf8(path.join(dataDir, 'events.yaml')),
    readOptionalUtf8(path.join(dataDir, 'places.yaml')),
    readOptionalUtf8(path.join(dataDir, 'sources.yaml')),
    readOptionalUtf8(path.join(dataDir, 'media.yaml')),
    readOptionalUtf8(path.join(dataDir, 'narratives.yaml')),
    readOptionalUtf8(path.join(dataDir, 'kinship.yaml')),
  ]);

  const privacy: Partial<PrivacyConfig> = configText ? parseKinloomConfigYaml(configText).privacy : {};
  const people = peopleText ? parsePeopleYaml(peopleText) : [];
  const events = eventsText ? parseEventsYaml(eventsText) : [];
  const places = placesText ? parsePlacesYaml(placesText) : [];
  const sources = sourcesText ? parseSourcesYaml(sourcesText) : [];
  const media = mediaText ? parseMediaYaml(mediaText) : [];
  const narratives = narrativesText ? parseNarrativesYaml(narrativesText) : [];
  const kinship = kinshipText ? parseKinshipYaml(kinshipText) : [];
  const endOfLineIds = indexEndOfLinePersonIds(kinship);
  const allDeceased = buildDeceasedQueue({
    repoDir,
    people,
    events,
    media,
    narratives,
    kinship,
    privacy,
    sort,
    endOfLine: false,
  });
  const endOfLineDeceased = allDeceased
    .filter((person) => endOfLineIds.has(person.id))
    .toSorted(STATUS_SORT_COMPARATORS[sort]);
  const scopedDeceased = endOfLine ? endOfLineDeceased : allDeceased;
  const deceased = missingBiography
    ? scopedDeceased.filter((person) => !person.hasBiography)
    : scopedDeceased;
  const livingCount = people.length - allDeceased.length;
  const biographyCompleteCount = allDeceased.filter((person) => person.hasBiography).length;

  const report: StatusReport = {
    repo: repoDir,
    sort,
    endOfLine,
    endOfLineCount: endOfLineDeceased.length,
    missingBiography,
    people: {
      total: people.length,
      deceased: allDeceased.length,
      living: livingCount,
    },
    events: events.length,
    places: places.length,
    zeroCoordPlaces: places.filter(isZeroCoordPlace).length,
    sources: sources.length,
    media: media.length,
    narratives: narratives.length,
    biographies: {
      complete: biographyCompleteCount,
      missing: allDeceased.length - biographyCompleteCount,
      totalDeceased: allDeceased.length,
    },
    queue: {
      done_live: deceased.filter((person) => person.status === 'done_live').length,
      staged: deceased.filter((person) => person.status === 'staged').length,
      pending: deceased.filter((person) => person.status === 'pending').length,
    },
    deceased,
  };

  const rendered = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatStatusTextReport(report, {
        limit: options.limit,
        filter: options.filter,
        sort,
        endOfLine,
        missingBiography,
      });

  return { ...report, rendered };
}
