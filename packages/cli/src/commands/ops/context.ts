import fs from 'node:fs';
import path from 'node:path';
import { type PrivacyConfig, parseKinloomConfigYaml, resolvePersonPronunciation } from '@kinloom/core';
import { CliValidationError } from '../../errors.js';
import { resolveAncestryContext } from './context/ancestry.js';
import { formatPersonContextMarkdown, renderPersonContext } from './context/formatter.js';
import {
  buildRelativesSummary,
  buildSanitizedKinshipEdges,
  collectPersonEventsAndReferences,
  collectPersonMedia,
  collectPersonNarratives,
  collectReferencedPlacesAndSources,
  collectRelativeArchiveMedia,
  resolveImmediateKinship,
  scanTargetAndUnknownYearEvents,
} from './context/graph.js';
import { buildLivingPrivacyState, scrubDeep, selectPeopleBlocksForContext } from './context/privacy.js';
import type {
  ContextCommandOptions,
  ContextCommandResult,
  LooseYamlRecord,
  PersonContextPayload,
} from './context/types.js';
import {
  asNonEmptyString,
  extractYamlBlockId,
  isPlainRecord,
  loadArchiveYamlBlocks,
  parseMatchingYamlBlocks,
  splitTopLevelYamlList,
} from './context/yamlScanner.js';

const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;

export {
  type ContextAncestryFact,
  type ContextAncestrySource,
  type ContextAncestrySummary,
  type ContextCommandOptions,
  type ContextCommandResult,
  type ContextKinshipEdge,
  type ContextRecordImage,
  type ContextRelativeArchiveMedia,
  type ContextRelativeEntry,
  type ContextRelativeListItem,
  type ContextRelativeRecordImage,
  type ContextRelativeRelation,
  type PersonContextPayload,
  REDACTED_RELATIVE_LABEL,
} from './context/types.js';
export { CONTEXT_HELP } from './help.js';
export { extractYamlBlockId, formatPersonContextMarkdown, parseMatchingYamlBlocks, splitTopLevelYamlList };

export async function runContextCommand(options: ContextCommandOptions): Promise<ContextCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const personId = options.personId.trim();
  if (!personId) {
    throw new CliValidationError('Missing required option `--person <person_id>`.');
  }
  if (!SAFE_PERSON_ID_RE.test(personId)) {
    throw new CliValidationError(
      `Invalid person_id '${personId}'. Only ASCII letters, digits, _, and - are allowed.`
    );
  }

  const dataDir = path.join(repoDir, 'data');
  const peopleYamlPath = path.join(dataDir, 'people.yaml');
  if (!fs.existsSync(peopleYamlPath)) {
    throw new CliValidationError(`Archive data/people.yaml not found under ${repoDir}.`);
  }

  const rawAncestryDir =
    options.ancestryDir?.trim() || process.env['KINLOOM_ANCESTRY_FACTS_DIR']?.trim() || '';
  const ancestryDir = rawAncestryDir ? path.resolve(rawAncestryDir) : null;
  const includeFamily = options.includeFamily === true || options.full === true;

  const blocks = await loadArchiveYamlBlocks(repoDir, dataDir);
  const parsedConfig = blocks.configText ? parseKinloomConfigYaml(blocks.configText) : null;
  const privacy: Partial<PrivacyConfig> = parsedConfig?.privacy ?? {};
  const pronunciationLexicon = parsedConfig?.pronunciations;

  const { relevantKinship, relativeIds, allRelativeIds } = resolveImmediateKinship(
    blocks.kinshipBlocks,
    personId,
    includeFamily
  );

  const peopleBlocksToParse = selectPeopleBlocksForContext(blocks.peopleBlocks, personId, allRelativeIds);
  const parsedPeople = parseMatchingYamlBlocks(peopleBlocksToParse);
  const peopleById = new Map<string, LooseYamlRecord>();
  for (const person of parsedPeople) {
    if (typeof person['id'] === 'string') {
      peopleById.set(person['id'], person);
    }
  }

  const targetPerson = peopleById.get(personId);
  if (!targetPerson) {
    throw new CliValidationError(`Person '${personId}' not found in ${peopleYamlPath}.`);
  }

  const { rawPersonEvents, unknownYearEventsByPerson } = scanTargetAndUnknownYearEvents(
    blocks.eventBlocks,
    personId,
    parsedPeople
  );

  const privacyState = buildLivingPrivacyState({
    parsedPeople,
    personId,
    rawPersonEvents,
    unknownYearEventsByPerson,
    privacy,
  });

  if (privacyState.livingIds.has(personId)) {
    throw new CliValidationError(
      `Privacy fence: person '${personId}' is living and excluded from research context dumps.`
    );
  }

  const relatives = buildRelativesSummary(relativeIds, peopleById, privacyState);
  const {
    events: personEvents,
    personEventIds,
    referencedPlaceIds,
    referencedSourceIds,
  } = collectPersonEventsAndReferences(rawPersonEvents, targetPerson, privacyState);

  const personMedia = collectPersonMedia({
    mediaBlocks: blocks.mediaBlocks,
    personId,
    personEventIds,
    referencedSourceIds,
    privacyState,
  });

  const personNarratives = collectPersonNarratives({
    narrativeBlocks: blocks.narrativeBlocks,
    personId,
    referencedPlaceIds,
    referencedSourceIds,
    privacyState,
  });

  const { places: referencedPlaces, sources: referencedSources } = collectReferencedPlacesAndSources({
    placeBlocks: blocks.placeBlocks,
    sourceBlocks: blocks.sourceBlocks,
    referencedPlaceIds,
    referencedSourceIds,
    livingNamePattern: privacyState.livingNamePattern,
  });

  const sanitizedTargetPerson = scrubDeep(structuredClone(targetPerson), privacyState.livingNamePattern);

  const { ancestry, relativeRecordImages } = await resolveAncestryContext({
    ancestryDir,
    targetPerson,
    relativeIds,
    includeFamily,
    peopleById,
    privacyState,
  });

  const personKinship = buildSanitizedKinshipEdges(relevantKinship, personId, privacyState.livingIds);

  const resolvedPronunciation = resolvePersonPronunciation(
    {
      full_name: asNonEmptyString(sanitizedTargetPerson['full_name']),
      given_name: asNonEmptyString(sanitizedTargetPerson['given_name']),
      surname: asNonEmptyString(sanitizedTargetPerson['surname']),
      is_living: false,
      ...(isPlainRecord(sanitizedTargetPerson['pronunciation'])
        ? { pronunciation: sanitizedTargetPerson['pronunciation'] as never }
        : {}),
    },
    pronunciationLexicon
  );

  const ownMediaIds = new Set(
    personMedia
      .map((item) => (typeof item['id'] === 'string' ? item['id'] : ''))
      .filter((id) => id.length > 0)
  );
  const relativeArchiveMedia = collectRelativeArchiveMedia({
    includeFamily,
    relativeIds,
    peopleById,
    privacyState,
    mediaBlocks: blocks.mediaBlocks,
    eventBlocks: blocks.eventBlocks,
    ownMediaIds,
  });

  const context: PersonContextPayload = {
    repoDir,
    person: sanitizedTargetPerson,
    relatives,
    kinship: personKinship,
    pronunciation: resolvedPronunciation,
    events: personEvents,
    places: referencedPlaces,
    sources: referencedSources,
    media: personMedia,
    narratives: personNarratives,
    ancestry,
    relativeRecordImages,
    relativeArchiveMedia,
  };

  const rendered = renderPersonContext(context, Boolean(options.json));
  return {
    context,
    rendered,
    bytesOut: Buffer.byteLength(rendered, 'utf8'),
  };
}
