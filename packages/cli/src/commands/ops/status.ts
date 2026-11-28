import fs from 'node:fs';
import path from 'node:path';
import {
  edtfYear,
  fastLocaleCompare,
  getCurrentReferenceYear,
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
  limit?: number | undefined;
  filter?: BiographyQueueStatus | undefined;
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

const parsedYearsCache = new WeakMap<
  DeceasedQueueItem,
  { readonly birthYear: number | null; readonly deathYear: number | null }
>();

function getItemYears(item: DeceasedQueueItem): {
  readonly birthYear: number | null;
  readonly deathYear: number | null;
} {
  let cached = parsedYearsCache.get(item);
  if (!cached) {
    cached = {
      birthYear: edtfYear(item.birth_edtf),
      deathYear: edtfYear(item.death_edtf),
    };
    parsedYearsCache.set(item, cached);
  }
  return cached;
}

const STATUS_SORT_COMPARATORS: Record<
  StatusSortMode,
  (a: DeceasedQueueItem, b: DeceasedQueueItem) => number
> = {
  sparsest: (a, b) =>
    a.events - b.events ||
    a.sources - b.sources ||
    a.media - b.media ||
    compareNullableYear(getItemYears(a).birthYear, getItemYears(b).birthYear) ||
    fastLocaleCompare(a.id, b.id),
  richest: (a, b) =>
    b.events - a.events ||
    b.sources - a.sources ||
    b.media - a.media ||
    compareNullableYear(getItemYears(a).birthYear, getItemYears(b).birthYear) ||
    fastLocaleCompare(a.id, b.id),
  chronological: (a, b) => {
    const ya = getItemYears(a);
    const yb = getItemYears(b);
    return (
      compareNullableYear(ya.birthYear, yb.birthYear) ||
      compareNullableYear(ya.deathYear, yb.deathYear) ||
      a.events - b.events ||
      fastLocaleCompare(a.id, b.id)
    );
  },
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

interface MutablePersonResearchBucket {
  eventIds: Set<string>;
  sourceIds: Set<string>;
  mediaIds: Set<string>;
}

function getOrCreateBucket(
  counts: Map<string, MutablePersonResearchBucket>,
  personId: string
): MutablePersonResearchBucket {
  let row = counts.get(personId);
  if (!row) {
    row = { eventIds: new Set(), sourceIds: new Set(), mediaIds: new Set() };
    counts.set(personId, row);
  }
  return row;
}

function finalizeResearchBuckets(
  counts: Map<string, MutablePersonResearchBucket>,
  media: readonly MediaItem[]
): Map<string, PersonResearchCounts> {
  for (let i = 0; i < media.length; i += 1) {
    const item = media[i];
    if (item === undefined) continue;
    const pids = getMediaPersonIds(item);
    for (const pid of pids) {
      getOrCreateBucket(counts, pid).mediaIds.add(item.id);
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

function indexResearchCounts(
  events: readonly RawEvent[],
  media: readonly MediaItem[]
): Map<string, PersonResearchCounts> {
  const counts = new Map<string, MutablePersonResearchBucket>();

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined) continue;
    const pts = event.participants;
    const srcs = event.sources;
    const ptLen = pts.length;
    if (ptLen === 0) {
      continue;
    }
    if (ptLen === 1) {
      const pt0 = pts[0];
      if (!pt0) continue;
      const row = getOrCreateBucket(counts, pt0.person_id);
      row.eventIds.add(event.id);
      for (const src of srcs) {
        row.sourceIds.add(src.source_id);
      }
      continue;
    }
    for (let p = 0; p < ptLen; p += 1) {
      const pt = pts[p];
      if (!pt) continue;
      const personId = pt.person_id;
      let duplicatePt = false;
      for (let prev = 0; prev < p; prev += 1) {
        if (pts[prev]?.person_id === personId) {
          duplicatePt = true;
          break;
        }
      }
      if (duplicatePt) {
        continue;
      }
      const row = getOrCreateBucket(counts, personId);
      row.eventIds.add(event.id);
      for (const src of srcs) {
        row.sourceIds.add(src.source_id);
      }
    }
  }

  return finalizeResearchBuckets(counts, media);
}

function readSimpleYamlIdScalar(text: string, rawStart: number, end: number): string | null {
  let start = rawStart;
  while (start < end && text.charCodeAt(start) === 32) {
    start += 1;
  }
  if (start >= end) {
    return '';
  }
  const c0 = text.charCodeAt(start);
  if (c0 === 34) {
    if (end - start < 2 || text.charCodeAt(end - 1) !== 34) {
      return null;
    }
    for (let i = start + 1; i < end - 1; i += 1) {
      if (text.charCodeAt(i) === 92) {
        try {
          const parsed = JSON.parse(text.slice(start, end));
          return typeof parsed === 'string' ? parsed : null;
        } catch {
          return null;
        }
      }
    }
    return text.slice(start + 1, end - 1);
  }
  if (
    c0 === 39 ||
    c0 === 124 ||
    c0 === 62 ||
    c0 === 91 ||
    c0 === 123 ||
    c0 === 38 ||
    c0 === 42 ||
    c0 === 33
  ) {
    return null;
  }
  for (let i = start; i < end; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 35 && i > start && text.charCodeAt(i - 1) === 32) {
      return null;
    }
  }
  const val = text.slice(start, end);
  if (val === 'null' || val === 'Null' || val === 'NULL' || val === '~') {
    return '';
  }
  return val;
}

function flushScannedStatusEvent(
  counts: Map<string, MutablePersonResearchBucket>,
  eventId: string,
  participants: readonly string[],
  sources: readonly string[]
): void {
  const ptLen = participants.length;
  if (ptLen === 0) {
    return;
  }
  if (ptLen === 1) {
    const p0 = participants[0];
    if (p0 === undefined) return;
    const row = getOrCreateBucket(counts, p0);
    row.eventIds.add(eventId);
    for (const src of sources) {
      row.sourceIds.add(src);
    }
    return;
  }
  for (let p = 0; p < ptLen; p += 1) {
    const personId = participants[p];
    let duplicatePt = false;
    for (let prev = 0; prev < p; prev += 1) {
      if (participants[prev] === personId) {
        duplicatePt = true;
        break;
      }
    }
    if (duplicatePt) {
      continue;
    }
    if (personId === undefined) continue;
    const row = getOrCreateBucket(counts, personId);
    row.eventIds.add(eventId);
    for (const src of sources) {
      row.sourceIds.add(src);
    }
  }
}

function tryScanCanonicalEventsForStatus(
  eventsText: string,
  media: readonly MediaItem[]
): { eventsCount: number; research: Map<string, PersonResearchCounts> } | null {
  const len = eventsText.length;
  let pos = len > 0 && eventsText.charCodeAt(0) === 0xfeff ? 1 : 0;

  const counts = new Map<string, MutablePersonResearchBucket>();
  let eventsCount = 0;
  let curEventId: string | null = null;
  const curParticipants: string[] = [];
  const curSources: string[] = [];
  let section: 0 | 1 | 2 = 0; // 0 = other, 1 = participants, 2 = sources

  while (pos < len) {
    let lineEnd = eventsText.indexOf('\n', pos);
    if (lineEnd === -1) {
      lineEnd = len;
    }
    let trimEnd = lineEnd;
    if (trimEnd > pos && eventsText.charCodeAt(trimEnd - 1) === 13) {
      trimEnd -= 1;
    }

    let indent = 0;
    let cur = pos;
    while (cur < trimEnd) {
      const c = eventsText.charCodeAt(cur);
      if (c === 32) {
        indent += 1;
        cur += 1;
      } else if (c === 9) {
        return null;
      } else {
        break;
      }
    }
    while (trimEnd > cur && eventsText.charCodeAt(trimEnd - 1) === 32) {
      trimEnd -= 1;
    }

    pos = lineEnd + 1;
    if (cur >= trimEnd || eventsText.charCodeAt(cur) === 35) {
      continue;
    }

    if (indent === 0) {
      if (trimEnd - cur === 2 && eventsText.charCodeAt(cur) === 91 && eventsText.charCodeAt(cur + 1) === 93) {
        return eventsCount === 0
          ? { eventsCount: 0, research: finalizeResearchBuckets(counts, media) }
          : null;
      }
      if (eventsText.charCodeAt(cur) !== 45 || (cur + 1 < trimEnd && eventsText.charCodeAt(cur + 1) !== 32)) {
        return null;
      }
      if (eventsCount > 0) {
        if (!curEventId) {
          return null;
        }
        flushScannedStatusEvent(counts, curEventId, curParticipants, curSources);
      }
      eventsCount += 1;
      curEventId = null;
      curParticipants.length = 0;
      curSources.length = 0;
      section = 0;

      if (eventsText.startsWith('- id:', cur)) {
        const idVal = readSimpleYamlIdScalar(eventsText, cur + 5, trimEnd);
        if (!idVal) {
          return null;
        }
        curEventId = idVal;
      }
      continue;
    }

    if (eventsCount === 0) {
      return null;
    }

    if (indent === 2) {
      section = 0;
      const c0 = eventsText.charCodeAt(cur);
      if (c0 === 105 && eventsText.startsWith('id:', cur)) {
        const idVal = readSimpleYamlIdScalar(eventsText, cur + 3, trimEnd);
        if (!idVal) {
          return null;
        }
        curEventId = idVal;
      } else if (c0 === 112 && eventsText.startsWith('participants:', cur)) {
        let rest = cur + 13;
        while (rest < trimEnd && eventsText.charCodeAt(rest) === 32) {
          rest += 1;
        }
        if (rest === trimEnd) {
          section = 1;
        } else if (
          trimEnd - rest === 2 &&
          eventsText.charCodeAt(rest) === 91 &&
          eventsText.charCodeAt(rest + 1) === 93
        ) {
          section = 0;
        } else {
          return null;
        }
      } else if (c0 === 115 && eventsText.startsWith('sources:', cur)) {
        let rest = cur + 8;
        while (rest < trimEnd && eventsText.charCodeAt(rest) === 32) {
          rest += 1;
        }
        if (rest === trimEnd) {
          section = 2;
        } else if (
          trimEnd - rest === 2 &&
          eventsText.charCodeAt(rest) === 91 &&
          eventsText.charCodeAt(rest + 1) === 93
        ) {
          section = 0;
        } else {
          return null;
        }
      } else {
        const lastChar = eventsText.charCodeAt(trimEnd - 1);
        if (lastChar === 124 || lastChar === 62) {
          return null;
        }
      }
      continue;
    }

    if (indent === 4 && section !== 0) {
      if (section === 1) {
        if (eventsText.startsWith('- person_id:', cur)) {
          const pid = readSimpleYamlIdScalar(eventsText, cur + 12, trimEnd);
          if (!pid) {
            return null;
          }
          curParticipants.push(pid);
        } else if (eventsText.charCodeAt(cur) === 45 && cur + 2 < trimEnd) {
          const afterDash = eventsText.charCodeAt(cur + 2);
          if (afterDash === 91 || afterDash === 123) {
            return null;
          }
        }
      } else if (eventsText.startsWith('- source_id:', cur)) {
        const sid = readSimpleYamlIdScalar(eventsText, cur + 12, trimEnd);
        if (!sid) {
          return null;
        }
        curSources.push(sid);
      } else if (eventsText.charCodeAt(cur) === 45 && cur + 2 < trimEnd) {
        const afterDash = eventsText.charCodeAt(cur + 2);
        if (afterDash === 91 || afterDash === 123) {
          return null;
        }
      }
      continue;
    }

    if (indent === 6 && section !== 0) {
      if (section === 1 && eventsText.startsWith('person_id:', cur)) {
        const pid = readSimpleYamlIdScalar(eventsText, cur + 10, trimEnd);
        if (!pid) {
          return null;
        }
        curParticipants.push(pid);
      } else if (section === 2 && eventsText.startsWith('source_id:', cur)) {
        const sid = readSimpleYamlIdScalar(eventsText, cur + 10, trimEnd);
        if (!sid) {
          return null;
        }
        curSources.push(sid);
      }
    }
  }

  if (eventsCount > 0) {
    if (!curEventId) {
      return null;
    }
    flushScannedStatusEvent(counts, curEventId, curParticipants, curSources);
  }

  return {
    eventsCount,
    research: finalizeResearchBuckets(counts, media),
  };
}

function tryCountCanonicalSources(sourcesText: string): number | null {
  const len = sourcesText.length;
  let pos = len > 0 && sourcesText.charCodeAt(0) === 0xfeff ? 1 : 0;
  let count = 0;

  while (pos < len) {
    let lineEnd = sourcesText.indexOf('\n', pos);
    if (lineEnd === -1) {
      lineEnd = len;
    }
    let trimEnd = lineEnd;
    if (trimEnd > pos && sourcesText.charCodeAt(trimEnd - 1) === 13) {
      trimEnd -= 1;
    }
    let indent = 0;
    let cur = pos;
    while (cur < trimEnd) {
      const c = sourcesText.charCodeAt(cur);
      if (c === 32) {
        indent += 1;
        cur += 1;
      } else if (c === 9) {
        return null;
      } else {
        break;
      }
    }
    while (trimEnd > cur && sourcesText.charCodeAt(trimEnd - 1) === 32) {
      trimEnd -= 1;
    }
    pos = lineEnd + 1;
    if (cur >= trimEnd || sourcesText.charCodeAt(cur) === 35) {
      continue;
    }
    if (indent === 0) {
      if (
        trimEnd - cur === 2 &&
        sourcesText.charCodeAt(cur) === 91 &&
        sourcesText.charCodeAt(cur + 1) === 93
      ) {
        return count === 0 ? 0 : null;
      }
      if (!sourcesText.startsWith('- id:', cur)) {
        return null;
      }
      const idVal = readSimpleYamlIdScalar(sourcesText, cur + 5, trimEnd);
      if (!idVal) {
        return null;
      }
      count += 1;
    }
  }

  return count;
}

function readOptionalUtf8Sync(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

function indexBiographyByPersonId(narratives: readonly Narrative[]): Map<string, string> {
  const byPerson = new Map<string, string>();
  for (const narrative of narratives) {
    if (narrative.kind === 'biography' && narrative.subject_person_id) {
      const existing = byPerson.get(narrative.subject_person_id);
      if (!existing || fastLocaleCompare(narrative.id, existing) < 0) {
        byPerson.set(narrative.subject_person_id, narrative.id);
      }
    }
  }
  return byPerson;
}

export function indexEndOfLinePersonIds(kinship: readonly KinshipEdge[]): Set<string> {
  const hasParent = new Set<string>();
  const hasChild = new Set<string>();

  for (let i = 0; i < kinship.length; i += 1) {
    const edge = kinship[i];
    if (edge === undefined) continue;
    if (edge.relation === 'parent') {
      hasParent.add(edge.to);
      hasChild.add(edge.from);
    } else if (edge.relation === 'child') {
      hasParent.add(edge.from);
      hasChild.add(edge.to);
    }
  }

  const endOfLine = new Set<string>();
  for (const personId of hasChild) {
    if (!hasParent.has(personId)) {
      endOfLine.add(personId);
    }
  }
  return endOfLine;
}

function discoverStagedPatchPersonIds(repoDir: string): Set<string> {
  const staged = new Set<string>();
  const peopleResearchDir = path.join(repoDir, 'research', 'people');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(peopleResearchDir, { withFileTypes: true });
  } catch {
    return staged;
  }
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    if (fs.existsSync(path.join(peopleResearchDir, entry.name, 'patch.json'))) {
      staged.add(entry.name);
    }
  }
  return staged;
}

function buildDeceasedQueueFromResearch(input: {
  repoDir: string;
  people: readonly RawPerson[];
  narratives: readonly Narrative[];
  research: ReadonlyMap<string, PersonResearchCounts>;
  endOfLineIds: ReadonlySet<string> | null;
  privacy?: Partial<PrivacyConfig> | undefined;
  sort: StatusSortMode;
  endOfLine: boolean;
}): DeceasedQueueItem[] {
  const biographiesByPerson = indexBiographyByPersonId(input.narratives);
  const stagedPatchIds = discoverStagedPatchPersonIds(input.repoDir);
  const items: DeceasedQueueItem[] = [];
  const referenceYear = input.privacy?.referenceYear ?? getCurrentReferenceYear();
  for (let i = 0; i < input.people.length; i += 1) {
    const person = input.people[i];
    if (person === undefined) continue;
    if (resolveEffectiveLiving(person, input.privacy, referenceYear)) {
      continue;
    }
    if (input.endOfLineIds && !input.endOfLineIds.has(person.id)) {
      continue;
    }
    const counts = input.research.get(person.id);
    const biographyId = biographiesByPerson.get(person.id) ?? null;
    const hasBiography = biographyId !== null;
    const hasStagedPatch = stagedPatchIds.has(person.id);
    items.push({
      id: person.id,
      full_name: person.full_name,
      birth_edtf: person.birth_edtf,
      death_edtf: person.death_edtf,
      events: counts ? counts.events : 0,
      sources: counts ? counts.sources : 0,
      media: counts ? counts.media : 0,
      has_biography: hasBiography,
      hasBiography,
      biographyId,
      has_staged_patch: hasStagedPatch,
      status: queueStatus(hasBiography, hasStagedPatch),
    });
  }
  items.sort(input.endOfLine ? STATUS_SORT_COMPARATORS[input.sort] : compareDeceased(input.sort));
  return items;
}

export function buildDeceasedQueue(input: {
  repoDir: string;
  people: readonly RawPerson[];
  events: readonly RawEvent[];
  media: readonly MediaItem[];
  narratives: readonly Narrative[];
  kinship?: readonly KinshipEdge[];
  privacy?: Partial<PrivacyConfig> | undefined;
  sort?: StatusSortMode;
  endOfLine?: boolean;
}): DeceasedQueueItem[] {
  const sort = parseStatusSort(input.sort);
  const endOfLine = Boolean(input.endOfLine);
  return buildDeceasedQueueFromResearch({
    repoDir: input.repoDir,
    people: input.people,
    narratives: input.narratives,
    research: indexResearchCounts(input.events, input.media),
    endOfLineIds: endOfLine ? indexEndOfLinePersonIds(input.kinship ?? []) : null,
    privacy: input.privacy,
    sort,
    endOfLine,
  });
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
  const repoStat = fs.statSync(repoDir, { throwIfNoEntry: false });
  if (!repoStat?.isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }
  const dataDir = path.join(repoDir, 'data');
  const dataStat = fs.statSync(dataDir, { throwIfNoEntry: false });
  if (!dataStat?.isDirectory()) {
    throw new CliValidationError(`Missing data/ directory at ${dataDir}.`);
  }

  const dataEntries = fs.readdirSync(dataDir, { withFileTypes: true });
  const dataFiles = new Set<string>();
  for (const entry of dataEntries) {
    if (!entry.isDirectory()) {
      dataFiles.add(entry.name);
    }
  }
  const readDataFile = (name: string): string | null =>
    dataFiles.has(name) ? readOptionalUtf8Sync(path.join(dataDir, name)) : null;

  const configText = readOptionalUtf8Sync(path.join(repoDir, 'kinloom.config.yaml'));
  const siteConfig = configText ? parseKinloomConfigYaml(configText) : null;
  const privacy: Partial<PrivacyConfig> = siteConfig ? siteConfig.privacy : {};

  const peopleText = readDataFile('people.yaml');
  const placesText = readDataFile('places.yaml');
  const kinshipText = readDataFile('kinship.yaml');
  const mediaText = readDataFile('media.yaml');
  const narrativesText = readDataFile('narratives.yaml');
  const sourcesText = readDataFile('sources.yaml');
  const eventsText = readDataFile('events.yaml');

  const people = peopleText ? parsePeopleYaml(peopleText) : [];
  const places = placesText ? parsePlacesYaml(placesText) : [];
  const kinship = kinshipText ? parseKinshipYaml(kinshipText) : [];
  const media = mediaText ? parseMediaYaml(mediaText) : [];
  const narratives = narrativesText ? parseNarrativesYaml(narrativesText) : [];

  const sourcesCount =
    sourcesText === null
      ? 0
      : (tryCountCanonicalSources(sourcesText) ?? parseSourcesYaml(sourcesText).length);

  let eventsCount = 0;
  let research: Map<string, PersonResearchCounts>;
  if (eventsText === null) {
    research = finalizeResearchBuckets(new Map(), media);
  } else {
    const fastEvents = tryScanCanonicalEventsForStatus(eventsText, media);
    if (fastEvents) {
      eventsCount = fastEvents.eventsCount;
      research = fastEvents.research;
    } else {
      const parsedEvents = parseEventsYaml(eventsText);
      eventsCount = parsedEvents.length;
      research = indexResearchCounts(parsedEvents, media);
    }
  }

  const endOfLineIds = indexEndOfLinePersonIds(kinship);
  const allDeceased = buildDeceasedQueueFromResearch({
    repoDir,
    people,
    narratives,
    research,
    endOfLineIds: null,
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

  let biographyCompleteCount = 0;
  for (const d of allDeceased) {
    if (d.hasBiography) {
      biographyCompleteCount += 1;
    }
  }
  let doneLiveCount = 0;
  let stagedCount = 0;
  let pendingCount = 0;
  for (const d of deceased) {
    const st = d.status;
    if (st === 'done_live') doneLiveCount += 1;
    else if (st === 'staged') stagedCount += 1;
    else pendingCount += 1;
  }

  let zeroCoordPlaces = 0;
  for (const pl of places) {
    if (isZeroCoordPlace(pl)) {
      zeroCoordPlaces += 1;
    }
  }

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
    events: eventsCount,
    places: places.length,
    zeroCoordPlaces,
    sources: sourcesCount,
    media: media.length,
    narratives: narratives.length,
    biographies: {
      complete: biographyCompleteCount,
      missing: allDeceased.length - biographyCompleteCount,
      totalDeceased: allDeceased.length,
    },
    queue: {
      done_live: doneLiveCount,
      staged: stagedCount,
      pending: pendingCount,
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
