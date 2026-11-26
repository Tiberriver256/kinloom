import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getMediaPersonIds,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  resolveEffectiveLiving,
  type MediaItem,
  type Narrative,
  type Place,
  type PrivacyConfig,
  type RawEvent,
  type RawPerson,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';

export { STATUS_HELP } from './help.js';

const ZERO_COORD_EPSILON = 1e-9;
const DEFAULT_STATUS_TEXT_LIMIT = 8;

export type BiographyQueueStatus = 'pending' | 'staged' | 'done_live';

export interface StatusTextDisplay {
  limit?: number;
  filter?: BiographyQueueStatus;
}

export interface StatusCommandOptions extends StatusTextDisplay {
  repoDir?: string;
  json?: boolean;
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
  has_staged_patch: boolean;
  status: BiographyQueueStatus;
}

export interface StatusReport {
  repo: string;
  people: { total: number; deceased: number; living: number };
  events: number;
  places: number;
  zeroCoordPlaces: number;
  sources: number;
  media: number;
  narratives: number;
  biographies: number;
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

function birthSortKey(birthEdtf: string): string {
  const trimmed = birthEdtf.trim();
  return trimmed.length > 0 ? trimmed : '9999';
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

function compareDeceased(a: DeceasedQueueItem, b: DeceasedQueueItem): number {
  const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (byStatus !== 0) {
    return byStatus;
  }
  if (a.status === 'pending') {
    return (
      a.events - b.events ||
      a.sources - b.sources ||
      a.media - b.media ||
      birthSortKey(a.birth_edtf).localeCompare(birthSortKey(b.birth_edtf)) ||
      a.id.localeCompare(b.id)
    );
  }
  return a.id.localeCompare(b.id);
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

function biographySubjectIds(narratives: readonly Narrative[]): Set<string> {
  const subjects = new Set<string>();
  for (const narrative of narratives) {
    if (narrative.kind === 'biography' && narrative.subject_person_id) {
      subjects.add(narrative.subject_person_id);
    }
  }
  return subjects;
}

export function buildDeceasedQueue(input: {
  repoDir: string;
  people: readonly RawPerson[];
  events: readonly RawEvent[];
  media: readonly MediaItem[];
  narratives: readonly Narrative[];
  privacy?: Partial<PrivacyConfig>;
}): DeceasedQueueItem[] {
  const research = indexResearchCounts(input.events, input.media);
  const biographies = biographySubjectIds(input.narratives);
  const items: DeceasedQueueItem[] = [];
  for (const person of input.people) {
    if (resolveEffectiveLiving(person, input.privacy)) {
      continue;
    }
    const counts = research.get(person.id) ?? { events: 0, sources: 0, media: 0 };
    const hasBiography = biographies.has(person.id);
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
      has_staged_patch: hasStagedPatch,
      status: queueStatus(hasBiography, hasStagedPatch),
    });
  }
  items.sort(compareDeceased);
  return items;
}

const STATUS_LIST_HEADING: Record<BiographyQueueStatus, string> = {
  pending: 'Pending (sparsest first):',
  staged: 'Staged:',
  done_live: 'Done live:',
};

export function formatStatusTextReport(
  report: StatusReport,
  display: StatusTextDisplay = {}
): string {
  const limit = display.limit ?? DEFAULT_STATUS_TEXT_LIMIT;
  const filter = display.filter ?? 'pending';
  const lines = [
    `Status ${report.repo}`,
    `People: ${report.people.total} total, ${report.people.deceased} deceased, ${report.people.living} living`,
    `Events: ${report.events}`,
    `Places: ${report.places}`,
    `Zero-coordinate places: ${report.zeroCoordPlaces}`,
    `Sources: ${report.sources}`,
    `Media: ${report.media}`,
    `Narratives: ${report.narratives}`,
    `Biographies: ${report.biographies}`,
    `Queue: done_live=${report.queue.done_live} staged=${report.queue.staged} pending=${report.queue.pending}`,
  ];
  const matching = report.deceased.filter((person) => person.status === filter);
  lines.push(STATUS_LIST_HEADING[filter]);
  if (matching.length === 0) {
    lines.push('  (none)');
  } else {
    const shown = limit === 0 ? matching : matching.slice(0, limit);
    for (const person of shown) {
      const birth = person.birth_edtf.trim() || '?';
      lines.push(
        `  ${person.full_name} (${person.id}) birth=${birth} death=${person.death_edtf || '?'} events=${person.events} sources=${person.sources} media=${person.media}`
      );
    }
    const hidden = matching.length - shown.length;
    if (hidden > 0) {
      lines.push(`  ... and ${hidden} more ${filter}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function runStatusCommand(
  options: StatusCommandOptions = {}
): Promise<StatusCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }
  const dataDir = path.join(repoDir, 'data');
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new CliValidationError(`Missing data/ directory at ${dataDir}.`);
  }

  const [configText, peopleText, eventsText, placesText, sourcesText, mediaText, narrativesText] =
    await Promise.all([
      readOptionalUtf8(path.join(repoDir, 'kinloom.config.yaml')),
      readOptionalUtf8(path.join(dataDir, 'people.yaml')),
      readOptionalUtf8(path.join(dataDir, 'events.yaml')),
      readOptionalUtf8(path.join(dataDir, 'places.yaml')),
      readOptionalUtf8(path.join(dataDir, 'sources.yaml')),
      readOptionalUtf8(path.join(dataDir, 'media.yaml')),
      readOptionalUtf8(path.join(dataDir, 'narratives.yaml')),
    ]);

  const privacy: Partial<PrivacyConfig> = configText ? parseKinloomConfigYaml(configText).privacy : {};
  const people = peopleText ? parsePeopleYaml(peopleText) : [];
  const events = eventsText ? parseEventsYaml(eventsText) : [];
  const places = placesText ? parsePlacesYaml(placesText) : [];
  const sources = sourcesText ? parseSourcesYaml(sourcesText) : [];
  const media = mediaText ? parseMediaYaml(mediaText) : [];
  const narratives = narrativesText ? parseNarrativesYaml(narrativesText) : [];
  const deceased = buildDeceasedQueue({ repoDir, people, events, media, narratives, privacy });
  const livingCount = people.length - deceased.length;

  const report: StatusReport = {
    repo: repoDir,
    people: {
      total: people.length,
      deceased: deceased.length,
      living: livingCount,
    },
    events: events.length,
    places: places.length,
    zeroCoordPlaces: places.filter(isZeroCoordPlace).length,
    sources: sources.length,
    media: media.length,
    narratives: narratives.length,
    biographies: narratives.filter((narrative) => narrative.kind === 'biography').length,
    queue: {
      done_live: deceased.filter((person) => person.status === 'done_live').length,
      staged: deceased.filter((person) => person.status === 'staged').length,
      pending: deceased.filter((person) => person.status === 'pending').length,
    },
    deceased,
  };

  const rendered = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatStatusTextReport(report, { limit: options.limit, filter: options.filter });

  return { ...report, rendered };
}
