import {
  fastLocaleCompare,
  getCurrentReferenceYear,
  getMediaPersonIds,
  type MediaItem,
  type Narrative,
  type Place,
  type PrivacyConfig,
  type RawEvent,
  type RawPerson,
  resolveEffectiveLiving,
  type SourceRecord,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';
import { type LoadedLocalArchiveRepo, loadLocalArchiveRepoSync } from '../dataFiles.js';
import {
  compileMatchRegex,
  formatCompactTable,
  isFieldMissing,
  matchesRecordRegex,
  parseFieldsCsv,
  projectRecordFields,
} from './query/helpers.js';
import { formatSchemaTextReport, inspectArchiveYamlSchema } from './query/schema.js';
import { buildGenerationGroups, DEFAULT_TRAVERSAL_DEPTH, traverseKinship } from './query/traversal.js';
import {
  type EntityQueryTarget,
  type KinshipTraversalSummary,
  QUERY_TARGETS,
  type QueryAppliedFilters,
  type QueryCommandOptions,
  type QueryCommandResult,
  type QueryEntitiesReport,
  type QueryEntityRecord,
  type QueryTarget,
} from './query/types.js';

export { QUERY_HELP } from './help.js';
export {
  compileMatchRegex,
  formatCellValue,
  formatCompactTable,
  getNestedFieldValue,
  isFieldMissing,
  matchesRecordRegex,
  parseFieldsCsv,
  projectRecordFields,
} from './query/helpers.js';
export { formatSchemaTextReport, inspectArchiveYamlSchema } from './query/schema.js';
export {
  buildGenerationGroups,
  buildKinshipAdjacency,
  DEFAULT_TRAVERSAL_DEPTH,
  formatGenerationLabel,
  type KinshipAdjacency,
  type TraverseKinshipInput,
  traverseKinship,
} from './query/traversal.js';
export {
  type EntityQueryTarget,
  type KinshipGenerationGroup,
  type KinshipSpouseRef,
  type KinshipTraversalDirection,
  type KinshipTraversalEntry,
  type KinshipTraversalSummary,
  QUERY_TARGETS,
  type QueryAppliedFilters,
  type QueryCommandOptions,
  type QueryCommandResult,
  type QueryEntitiesReport,
  type QueryEntityRecord,
  type QueryPrivacyMeta,
  type QueryReport,
  type QuerySchemaReport,
  type QueryTarget,
  type SchemaFileInspection,
  type SchemaKeyFrequency,
} from './query/types.js';

const DEFAULT_COLUMNS: Record<EntityQueryTarget, readonly string[]> = {
  people: ['id', 'full_name', 'birth_edtf', 'death_edtf', 'lineage_group'],
  places: ['id', 'name', 'place_type', 'lat', 'lng', 'parent_id'],
  events: ['id', 'edtf_date', 'event_kind', 'scope', 'title', 'place_id'],
  narratives: ['id', 'kind', 'subject_person_id', 'date_edtf', 'title'],
  sources: ['id', 'source_type', 'author', 'citation'],
  media: ['id', 'kind', 'person_id', 'date_edtf', 'file', 'caption'],
};

export function parseQueryTarget(raw: string | undefined): QueryTarget {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) {
    throw new CliValidationError(`Missing query target. Expected one of: ${QUERY_TARGETS.join(', ')}.`);
  }
  for (const target of QUERY_TARGETS) {
    if (trimmed === target) {
      return target;
    }
  }
  throw new CliValidationError(
    `Unknown query target '${raw ?? ''}'. Expected one of: ${QUERY_TARGETS.join(', ')}.`
  );
}

function validateQueryOptions(options: QueryCommandOptions): void {
  const { target } = options;
  const hasTraversal = Boolean(options.descendantsOf?.trim() || options.ancestorsOf?.trim());

  if (options.descendantsOf?.trim() && options.ancestorsOf?.trim()) {
    throw new CliValidationError('Cannot combine `--descendants-of` and `--ancestors-of` in one query.');
  }
  if (options.deceased && options.living) {
    throw new CliValidationError('Cannot combine `--deceased` and `--living` in one query.');
  }
  if (options.living && !options.includeLiving) {
    throw new CliValidationError(
      'Privacy fence: `--living` requires explicit `--include-living` on local private repositories.'
    );
  }
  if (options.depth !== undefined) {
    if (!Number.isInteger(options.depth) || options.depth < 0) {
      throw new CliValidationError('Option `--depth` must be a non-negative integer.');
    }
    if (!hasTraversal) {
      throw new CliValidationError(
        'Option `--depth` can only be used with `--descendants-of` or `--ancestors-of`.'
      );
    }
  }
  if (target !== 'people') {
    if (options.deceased || options.living || hasTraversal) {
      throw new CliValidationError(
        'Options `--deceased`, `--living`, `--descendants-of`, `--ancestors-of`, and `--depth` are only supported for `kinloom query people`.'
      );
    }
  }
  if (target === 'schema') {
    if (
      options.match !== undefined ||
      options.kind !== undefined ||
      options.missing !== undefined ||
      options.person !== undefined ||
      options.fields !== undefined ||
      options.includeLiving
    ) {
      throw new CliValidationError('`kinloom query schema` only accepts `--repo` and `--json`.');
    }
  }
  if (target === 'people' && (options.kind !== undefined || options.person !== undefined)) {
    throw new CliValidationError(
      'Options `--kind` and `--person` are not supported for `kinloom query people`.'
    );
  }
}

function buildLivingIds(repo: LoadedLocalArchiveRepo): Set<string> {
  const privacy: Partial<PrivacyConfig> = repo.siteConfig ? repo.siteConfig.privacy : {};
  const referenceYear = privacy.referenceYear ?? getCurrentReferenceYear();
  const livingIds = new Set<string>();
  for (const person of repo.people) {
    if (resolveEffectiveLiving(person, privacy, referenceYear)) {
      livingIds.add(person.id);
    }
  }
  return livingIds;
}

function assertPersonFilterAllowed(
  personId: string,
  peopleById: ReadonlyMap<string, RawPerson>,
  livingIds: ReadonlySet<string>,
  includeLiving: boolean
): void {
  if (!peopleById.has(personId)) {
    throw new CliValidationError(`Person '${personId}' not found in data/people.yaml.`);
  }
  if (!includeLiving && livingIds.has(personId)) {
    throw new CliValidationError(
      `Privacy fence: person '${personId}' is living. Pass --include-living on a local private repository to query living records.`
    );
  }
}

function eventInvolvesLiving(event: RawEvent, livingIds: ReadonlySet<string>): boolean {
  for (const participant of event.participants) {
    if (livingIds.has(participant.person_id)) {
      return true;
    }
  }
  return false;
}

function narrativeInvolvesLiving(narrative: Narrative, livingIds: ReadonlySet<string>): boolean {
  if (narrative.subject_person_id && livingIds.has(narrative.subject_person_id)) {
    return true;
  }
  for (const pid of narrative.person_ids) {
    if (livingIds.has(pid)) {
      return true;
    }
  }
  return false;
}

function mediaInvolvesLiving(item: MediaItem, livingIds: ReadonlySet<string>): boolean {
  for (const pid of getMediaPersonIds(item)) {
    if (livingIds.has(pid)) {
      return true;
    }
  }
  return false;
}

function collectPersonRelatedPlaceIds(
  events: readonly RawEvent[],
  personId: string,
  livingIds: ReadonlySet<string>,
  includeLiving: boolean
): Set<string> {
  const placeIds = new Set<string>();
  for (const ev of events) {
    if (!includeLiving && eventInvolvesLiving(ev, livingIds)) {
      continue;
    }
    if (!ev.participants.some((pt) => pt.person_id === personId)) {
      continue;
    }
    if (ev.place_id) {
      placeIds.add(ev.place_id);
    }
    if (ev.alternate_places) {
      for (const alt of ev.alternate_places) {
        if (alt.place_id) {
          placeIds.add(alt.place_id);
        }
      }
    }
  }
  return placeIds;
}

function collectPersonRelatedSourceIds(
  repo: LoadedLocalArchiveRepo,
  personId: string,
  livingIds: ReadonlySet<string>,
  includeLiving: boolean
): Set<string> {
  const sourceIds = new Set<string>();
  for (const ev of repo.events) {
    if (!includeLiving && eventInvolvesLiving(ev, livingIds)) {
      continue;
    }
    if (!ev.participants.some((pt) => pt.person_id === personId)) {
      continue;
    }
    for (const src of ev.sources) {
      sourceIds.add(src.source_id);
    }
  }
  for (const nar of repo.narratives) {
    if (!includeLiving && narrativeInvolvesLiving(nar, livingIds)) {
      continue;
    }
    if (nar.subject_person_id === personId || nar.person_ids.includes(personId)) {
      for (const sid of nar.source_ids) {
        sourceIds.add(sid);
      }
    }
  }
  for (const item of repo.media) {
    if (!includeLiving && mediaInvolvesLiving(item, livingIds)) {
      continue;
    }
    if (getMediaPersonIds(item).includes(personId) && item.source_id) {
      sourceIds.add(item.source_id);
    }
  }
  return sourceIds;
}

function matchesEntityKind(target: EntityQueryTarget, record: QueryEntityRecord, kindLower: string): boolean {
  if (target === 'places') {
    const place = record as Place;
    return place.place_type.toLowerCase() === kindLower;
  }
  if (target === 'events') {
    const ev = record as RawEvent;
    return (
      ev.event_kind.toLowerCase() === kindLower ||
      ev.scope.toLowerCase() === kindLower ||
      (ev.category ? ev.category.toLowerCase() === kindLower : false)
    );
  }
  if (target === 'narratives') {
    const nar = record as Narrative;
    return nar.kind ? nar.kind.toLowerCase() === kindLower : false;
  }
  if (target === 'sources') {
    const src = record as SourceRecord;
    return src.source_type.toLowerCase() === kindLower;
  }
  if (target === 'media') {
    const media = record as MediaItem;
    return media.kind.toLowerCase() === kindLower;
  }
  return true;
}

function formatTraversalTextReport(report: QueryEntitiesReport, traversal: KinshipTraversalSummary): string {
  const lines: string[] = [
    `Query people (${traversal.direction} of ${traversal.rootId}, depth<=${traversal.maxDepth}) ${report.repo}`,
    `Matched: ${report.count} ${report.count === 1 ? 'person' : 'people'} across ${traversal.generations.length} ${traversal.generations.length === 1 ? 'generation' : 'generations'}${traversal.truncatedByDepth ? ' (depth limit reached)' : ''}`,
  ];
  if (report.privacy.excludedLivingCount > 0) {
    lines.push(
      `Privacy fence: ${report.privacy.excludedLivingCount} living ${report.privacy.excludedLivingCount === 1 ? 'record' : 'records'} excluded (pass --include-living on a local private repo to include)`
    );
  }
  if (traversal.generations.length === 0) {
    lines.push('  (none)');
    return `${lines.join('\n')}\n`;
  }
  for (const group of traversal.generations) {
    lines.push('');
    lines.push(`${group.label} (${group.count}):`);
    for (const entry of group.entries) {
      const birth = entry.person.birth_edtf.trim() || '?';
      const death = entry.person.death_edtf.trim() || (entry.person.is_living ? 'living' : '?');
      const spouseSuffix =
        entry.spouses.length > 0
          ? `  m. ${entry.spouses.map((sp) => `${sp.full_name} (${sp.id})`).join('; ')}`
          : '';
      lines.push(`  - ${entry.person.full_name} (${entry.person.id}) [${birth} - ${death}]${spouseSuffix}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function formatQueryEntitiesTextReport(report: QueryEntitiesReport): string {
  if (report.traversal && !report.filters.fields) {
    return formatTraversalTextReport(report, report.traversal);
  }
  const columns =
    report.filters.fields ??
    (report.target === 'people' && report.privacy.includeLiving
      ? [...DEFAULT_COLUMNS.people, 'is_living']
      : DEFAULT_COLUMNS[report.target]);
  const lines: string[] = [`Query ${report.target} (${report.count}) ${report.repo}`];
  if (!report.privacy.includeLiving && report.privacy.excludedLivingCount > 0) {
    lines.push(
      `Privacy fence: ${report.privacy.excludedLivingCount} living ${report.privacy.excludedLivingCount === 1 ? 'record' : 'records'} excluded`
    );
  }
  lines.push(formatCompactTable(columns, report.items));
  return `${lines.join('\n')}\n`;
}

export async function runQueryCommand(options: QueryCommandOptions): Promise<QueryCommandResult> {
  validateQueryOptions(options);

  const repo = loadLocalArchiveRepoSync(options.repoDir, {
    requireConfig: false,
    includeYamlTexts: options.target === 'schema',
  });

  if (options.target === 'schema') {
    const schemaReport = inspectArchiveYamlSchema(repo.repoDir, repo.yamlTexts);
    const rendered = options.json
      ? `${JSON.stringify(schemaReport, null, 2)}\n`
      : formatSchemaTextReport(schemaReport);
    return { ...schemaReport, rendered };
  }

  const includeLiving = Boolean(options.includeLiving);
  const livingIds = buildLivingIds(repo);
  const peopleById = new Map<string, RawPerson>();
  for (const person of repo.people) {
    peopleById.set(person.id, person);
  }

  const matchRegex = options.match !== undefined ? compileMatchRegex(options.match) : null;
  const missingField = options.missing?.trim() || null;
  const kindFilter = options.kind?.trim() || null;
  const personFilter = options.person?.trim() || null;
  const fields = options.fields && options.fields.length > 0 ? [...options.fields] : null;

  if (personFilter) {
    assertPersonFilterAllowed(personFilter, peopleById, livingIds, includeLiving);
  }

  const filters: QueryAppliedFilters = {
    deceased: Boolean(options.deceased),
    living: Boolean(options.living),
    match: options.match?.trim() ?? null,
    kind: kindFilter,
    missing: missingField,
    person: personFilter,
    fields,
  };

  let excludedLivingCount = 0;
  let traversalSummary: KinshipTraversalSummary | undefined;
  let records: QueryEntityRecord[] = [];

  if (options.target === 'people') {
    const descendantsOf = options.descendantsOf?.trim();
    const ancestorsOf = options.ancestorsOf?.trim();
    if (descendantsOf || ancestorsOf) {
      const direction = descendantsOf ? 'descendants' : 'ancestors';
      const rootId = (descendantsOf ?? ancestorsOf) as string;
      const maxDepth = options.depth ?? DEFAULT_TRAVERSAL_DEPTH;
      const traversed = traverseKinship({
        direction,
        rootId,
        maxDepth,
        peopleById,
        kinship: repo.kinship,
        livingIds,
        includeLiving,
      });
      excludedLivingCount = traversed.summary.excludedLivingCount;

      const filteredEntries = traversed.entries.filter((entry) => {
        if (options.living && !livingIds.has(entry.person.id)) {
          return false;
        }
        if (options.deceased && livingIds.has(entry.person.id)) {
          return false;
        }
        if (matchRegex && !matchesRecordRegex(entry.person, matchRegex)) {
          return false;
        }
        if (missingField && !isFieldMissing(entry.person, missingField)) {
          return false;
        }
        return true;
      });

      const generations = buildGenerationGroups(direction, filteredEntries);
      traversalSummary = {
        ...traversed.summary,
        totalPeople: filteredEntries.length,
        generations,
      };
      records = filteredEntries.map((entry) => {
        const enriched: Record<string, unknown> = {
          ...entry.person,
          generation: entry.generation,
          via_id: entry.via_id,
          spouses: entry.spouses,
        };
        return fields ? projectRecordFields(enriched, fields) : enriched;
      });
    } else {
      const filteredPeople: RawPerson[] = [];
      for (const person of repo.people) {
        const isLiving = livingIds.has(person.id);
        if (!includeLiving && isLiving) {
          excludedLivingCount += 1;
          continue;
        }
        if (options.living && !isLiving) {
          continue;
        }
        if (options.deceased && isLiving) {
          continue;
        }
        if (matchRegex && !matchesRecordRegex(person, matchRegex)) {
          continue;
        }
        if (missingField && !isFieldMissing(person, missingField)) {
          continue;
        }
        filteredPeople.push(person);
      }
      filteredPeople.sort((a, b) => fastLocaleCompare(a.id, b.id));
      records = fields ? filteredPeople.map((person) => projectRecordFields(person, fields)) : filteredPeople;
    }
  } else {
    let candidates: Array<{ id: string } & QueryEntityRecord> = [];
    if (options.target === 'places') {
      const allowedPlaceIds = personFilter
        ? collectPersonRelatedPlaceIds(repo.events, personFilter, livingIds, includeLiving)
        : null;
      candidates = allowedPlaceIds
        ? repo.places.filter((place) => allowedPlaceIds.has(place.id))
        : [...repo.places];
    } else if (options.target === 'events') {
      for (const ev of repo.events) {
        if (!includeLiving && eventInvolvesLiving(ev, livingIds)) {
          excludedLivingCount += 1;
          continue;
        }
        if (personFilter && !ev.participants.some((pt) => pt.person_id === personFilter)) {
          continue;
        }
        candidates.push(ev);
      }
    } else if (options.target === 'narratives') {
      for (const nar of repo.narratives) {
        if (!includeLiving && narrativeInvolvesLiving(nar, livingIds)) {
          excludedLivingCount += 1;
          continue;
        }
        if (
          personFilter &&
          nar.subject_person_id !== personFilter &&
          !nar.person_ids.includes(personFilter)
        ) {
          continue;
        }
        candidates.push(nar);
      }
    } else if (options.target === 'sources') {
      const allowedSourceIds = personFilter
        ? collectPersonRelatedSourceIds(repo, personFilter, livingIds, includeLiving)
        : null;
      candidates = allowedSourceIds
        ? repo.sources.filter((src) => allowedSourceIds.has(src.id))
        : [...repo.sources];
    } else if (options.target === 'media') {
      for (const item of repo.media) {
        if (!includeLiving && mediaInvolvesLiving(item, livingIds)) {
          excludedLivingCount += 1;
          continue;
        }
        if (personFilter && !getMediaPersonIds(item).includes(personFilter)) {
          continue;
        }
        candidates.push(item);
      }
    }

    const kindLower = kindFilter ? kindFilter.toLowerCase() : null;
    const matched = candidates.filter((record) => {
      if (kindLower && !matchesEntityKind(options.target as EntityQueryTarget, record, kindLower)) {
        return false;
      }
      if (matchRegex && !matchesRecordRegex(record, matchRegex)) {
        return false;
      }
      if (missingField && !isFieldMissing(record, missingField)) {
        return false;
      }
      return true;
    });
    matched.sort((a, b) => fastLocaleCompare(a.id, b.id));
    records = fields ? matched.map((record) => projectRecordFields(record, fields)) : matched;
  }

  const report: QueryEntitiesReport = {
    ok: true,
    target: options.target,
    repo: repo.repoDir,
    privacy: {
      includeLiving,
      excludedLivingCount,
    },
    filters,
    ...(traversalSummary ? { traversal: traversalSummary } : {}),
    count: records.length,
    items: records,
  };

  const rendered = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatQueryEntitiesTextReport(report);

  return { ...report, rendered };
}

export { parseFieldsCsv as parseQueryFieldsCsv };
