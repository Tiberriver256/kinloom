import fs from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type KinloomSiteConfig,
  type KinshipEdge,
  type Place,
  parseKinloomConfig,
  type RawEvent,
  type RawPerson,
  serializeKinloomConfigYaml,
  serializePeopleYaml,
  serializePlacesYaml,
} from '@kinloom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { CliValidationError } from '../../errors.js';
import type { ExecutedPluginCheckResult } from '../../plugins.js';
import {
  runCemetery as runFagCemetery,
  runGet as runFagGet,
  runPlace as runFagPlace,
  runSearch as runFagSearch,
  runUrl as runFagUrl,
} from '../records/clients/findagrave/commands.js';
import {
  firstPlaceName,
  fmtCemetery,
  formatCemeteriesText,
  formatMemorialsLines,
  formatPlacesText,
  formatSearchText,
  primaryName,
} from '../records/clients/findagrave/formatters.js';
import {
  cachedGqlQuery,
  fetchPhotoBytes,
  loadOrFetchCemeteryById,
  loadOrFetchMemorialsWithHits,
  photoCacheFresh,
  runGraphqlQuery,
} from '../records/clients/findagrave/transport.js';
import { runFindagraveCommand } from '../records/clients/findagrave.js';
import {
  defaultBrowserGetRecords,
  defaultBrowserSearchMany,
} from '../records/clients/nara/browserFallback.js';
import {
  runDownload as runNaraDownload,
  runGet as runNaraGet,
  runSearch as runNaraSearch,
  runUrl as runNaraUrl,
} from '../records/clients/nara/catalogCommands.js';
import {
  apiGetJson,
  apiSearchOne,
  fetchFollowingRedirects,
  loadOrFetchFullRecordsWithHits,
  parseRetryAfterSeconds,
} from '../records/clients/nara/catalogTransport.js';
import {
  census1950FetchJpeg,
  parseCensus1950ImageSource,
  resolveCensus1950ImageOutput,
  storeCensus1950Image,
  validateCensus1950ImagePath,
} from '../records/clients/nara/census1950.js';
import { runCensus1950, runCensus1950Image } from '../records/clients/nara/censusCommands.js';
import {
  buildSearchPayload,
  extractRecord,
  formatRecordText,
  projectRecord,
} from '../records/clients/nara/queryAndRecords.js';
import {
  runCheck as runAudioCheck,
  runExtract as runAudioExtract,
  runList as runAudioList,
  runSynth as runAudioSynth,
  runTranscribe as runAudioTranscribe,
} from '../records/clients/narrativeAudio/commands.js';
import {
  defaultExecFile as audioDefaultExecFile,
  findExecutableOnPath,
  resolveCloudTtsHeaders,
  synthesizeWithGemini,
  transcribeAudioFile,
} from '../records/clients/narrativeAudio/synthesis.js';
import { runCursiveCliOcr, runCursiveGeminiOcr, runPrintedOcr } from '../records/clients/ocr/engines.js';
import {
  parseTesseractTsv,
  readImageDimensions,
  readJpegDimensions,
  readTiffDimensions,
} from '../records/clients/ocr/imageAndTsv.js';
import { expandBatchInputs, runOcrBatchCommand } from '../records/clients/ocr/pipeline.js';
import {
  createDefaultExecFile,
  resolveExecutable,
  runSubprocessWithTimeout,
} from '../records/clients/ocr/subprocess.js';
import { OcrTimeoutError } from '../records/clients/ocr/types.js';
import {
  buildGridSvg,
  extractBand,
  loadRgbFromFile,
  mapChannelsToMode,
  resolveOutputAlias,
  saveArchivalImage,
} from '../records/clients/prepScan/imageOps.js';
import { cmdPdfGrep, cmdPdfPages, renderOrLoadPdfPage } from '../records/clients/prepScan/pdfCommands.js';
import {
  cmdCrop,
  cmdGrid,
  cmdInfo,
  cmdJoin,
  cmdPreview,
  cmdRotate,
} from '../records/clients/prepScan/rasterCommands.js';
import { cmdSheetStrip, cmdStitch } from '../records/clients/prepScan/sheetAndStitchCommands.js';
import type { OptionalBrowser, OptionalBrowserPage } from '../records/runtime/browser.js';
import { createSyntheticPng } from '../records/runtime/image.js';
import { JPEG_MAGIC } from '../records/runtime/primitives.js';
import {
  createRecordContext,
  type RecordCommandContext,
  RecordRuntimeError,
} from '../records/runtime/types.js';
import { runChronologyCheck } from './audit/chronology.js';
import { runAuditHygieneRegressionCheck } from './audit/hygiene.js';
import { runPrivacyAndStyleScan } from './audit/privacyStyle.js';
import { runAuditCommand } from './audit.js';
import { resolveAncestryContext } from './context/ancestry.js';
import {
  buildSanitizedKinshipEdges,
  collectPersonEventsAndReferences,
  collectPersonMedia,
  collectPersonNarratives,
  collectReferencedPlacesAndSources,
  collectRelativeArchiveMedia,
  resolveImmediateKinship,
  scanTargetAndUnknownYearEvents,
} from './context/graph.js';
import { type LivingPrivacyState, type LooseYamlRecord, REDACTED_RELATIVE_LABEL } from './context/types.js';
import { formatIntegrateBatchTextReport } from './integrateBatch/report.js';
import type { IntegrateBatchCommandResult, IntegrateBatchItemResult } from './integrateBatch/types.js';
import { evaluateMigrationStatus, parseMigrationSchemaRequirements } from './migrate/sqlParser.js';
import { runPronounceDeduplicateCommand } from './pronounce/deduplicate.js';
import { rankPronounceSources, runPronounceLookupCommand } from './pronounce/lookup.js';
import {
  buildForvoLookupUrl,
  buildYouGlishLookupUrl,
  queryForvoPronunciations,
  queryMediaWikiPronunciations,
} from './pronounce/lookupProviders.js';
import { extractMediaWikiPronunciations, formatWikiSourceLabel } from './pronounce/mediaWiki.js';
import type { PronounceAudioHit, PronounceSourceHit } from './pronounce/types.js';
import { runPronunciationAuditCheck, runPronunciationVerifyCheck } from './pronunciation-checks.js';
import { runIntegrateCommand } from './shared/integrateEngine/execute.js';
import {
  applyKinshipRemovals,
  expandRemoveKinshipTargets,
  mergeKinshipPatch,
  parseRemoveKinshipEntries,
} from './shared/integrateEngine/kinship.js';
import { applyPeoplePatch } from './shared/integrateEngine/people.js';
import { runPronounceAuditCommand } from './shared/pronunciation/audit.js';
import {
  evaluatePersonOverrideRedundancy,
  extractPromotableTokenFromPerson,
} from './shared/pronunciation/deduplicateRules.js';
import { loadArchivePronunciationLexicon } from './shared/pronunciation/lexiconLoader.js';
import {
  collectKinshipAddRemoveConflicts,
  collectMediaFileCollisions,
  collectPersonSlugCollisions,
  collectSharedEvents,
  collectSharedMediaIds,
  collectSharedPeople,
  collectSharedSourceIds,
} from './shared/stagedOverlaps/detectors.js';
import type { ParsedPackage } from './shared/stagedOverlaps/types.js';
import { buildDeceasedQueue, formatStatusTextReport, runStatusCommand, type StatusReport } from './status.js';
import { formatSyncReport } from './sync/report.js';
import type { SyncCommandResult } from './sync/types.js';
import { runSyncCommand } from './sync.js';
import {
  computePercentile,
  formatTelemetryTable,
  measureCommand,
  recordTelemetryEvent,
  runTelemetryReportCommand,
  summarizeTelemetryEvents,
} from './telemetry.js';
import {
  getMarriageSpouseIds,
  hasAdoptivePersonTag,
  isAdoptionEvent,
  normalizeSex,
  personLabel,
} from './treeHygiene/classifiers.js';
import { diffTreeHygieneWarnings, formatAuditHygieneWarningMessage } from './treeHygiene/diff.js';
import type { TreeHygieneWarning } from './treeHygiene/types.js';
import { collectVerifyDiagnostics, formatVerifyTextReport } from './verify/report.js';
import type { VerifyCommandResult } from './verify/types.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix = 'kinloom-branch-b-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env['FORVO_API_KEY'];
  delete process.env['KINLOOM_PRONOUNCE_CACHE_DIR'];
  delete process.env['KINLOOM_TELEMETRY_FILE'];
  delete process.env['KINLOOM_TELEMETRY_PARENT'];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

const VALID_JPEG = Buffer.concat([JPEG_MAGIC, Buffer.from([0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])]);

function makeCapturedContext(
  overrides: { [K in keyof RecordCommandContext]?: RecordCommandContext[K] | undefined } = {}
): {
  ctx: RecordCommandContext;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    sleepFn: async () => {},
    fetchImpl: async () => {
      throw new Error('Unexpected fetch call');
    },
    ...overrides,
  });
  return { ctx, stdout, stderr };
}

function makeSiteConfig(
  overrides: Partial<Parameters<typeof parseKinloomConfig>[0]> = {}
): KinloomSiteConfig {
  return parseKinloomConfig({
    site: {
      title: 'Alder Harbor Archive',
      shortName: 'Alder',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER_ARCHIVE',
      baseUrl: 'https://alder.example.test',
    },
    privacy: {
      livingCutoffYears: 110,
      referenceYear: 2026,
    },
    ...overrides,
  });
}

function makePerson(overrides: Partial<RawPerson> & { id: string }): RawPerson {
  return {
    slug: overrides.id,
    full_name: 'Clara Alder',
    given_name: 'Clara',
    surname: 'Alder',
    alt_names: [],
    sex: 'F',
    birth_edtf: '1875-03-10',
    death_edtf: '1948-11-04',
    is_living: false,
    lineage_group: 'paternal',
    portrait_url: null,
    ...overrides,
  };
}

function makePlace(overrides: Partial<Place> & { id: string }): Place {
  return {
    slug: overrides.id,
    name: 'Cedar Harbor',
    full_name: 'Cedar Harbor, Birch County, Maine, USA',
    lat: 44.3,
    lng: -68.9,
    place_type: 'town',
    parent_id: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<RawEvent> & { id: string }): RawEvent {
  return {
    title: 'Census in Cedar Harbor',
    scope: 'personal',
    event_kind: 'point_event',
    edtf_date: '1910-04-15',
    place_id: null,
    summary: 'Clara Alder resided in Cedar Harbor.',
    participants: [],
    sources: [],
    ...overrides,
  };
}

function makePrivacyState(overrides: Partial<LivingPrivacyState> = {}): LivingPrivacyState {
  return {
    livingIds: new Set<string>(['per_living_birch']),
    livingAncestryPids: new Set<string>(['90001']),
    livingNamePattern: /\bSam Birch\b/gi,
    privacy: { livingCutoffYears: 110, referenceYear: 2026 },
    ...overrides,
  };
}

describe('ops/context/graph.ts branch coverage', () => {
  it('resolves immediate kinship across parent/child/spouse directions and malformed edges', () => {
    const kinshipBlocks = [
      '- from: per_clara_alder\n  to: per_child_mercer\n  relation: parent',
      '- from: per_child_birch\n  to: per_clara_alder\n  relation: child',
      '- from: per_parent_cedar\n  to: per_clara_alder\n  relation: parent',
      '- from: per_spouse_harbor\n  to: per_clara_alder\n  relation: spouse',
      '- from: per_clara_alder\n  to: per_spouse_two\n  relation: spouse',
      '- from: per_clara_alder\n  to: per_unknown_rel\n  relation: cousin',
      '- from: 123\n  to: 456\n  relation: parent\n  note: per_clara_alder',
      '- from: per_parent_cedar\n  to: 999\n  relation: parent',
      '- from: 888\n  to: per_parent_cedar\n  relation: child',
      '- from: per_sibling_cedar\n  to: per_parent_cedar\n  relation: child',
    ];

    const res = resolveImmediateKinship(kinshipBlocks, 'per_clara_alder', true);
    expect([...res.relativeIds.parentIds]).toEqual(['per_parent_cedar']);
    expect([...res.relativeIds.childIds].sort()).toEqual(['per_child_birch', 'per_child_mercer']);
    expect([...res.relativeIds.spouseIds].sort()).toEqual(['per_spouse_harbor', 'per_spouse_two']);
    expect([...res.relativeIds.siblingIds]).toEqual(['per_sibling_cedar']);
  });

  it('scans target and unknown-year events with missing and quoted dates', () => {
    const eventBlocks = [
      '- id: evt_no_date\n  title: Mention\n  participants:\n    - person_id: per_nodate_mercer\n      role: subject',
      '- id: evt_quoted\n  edtf_date: "1892-05"\n  participants:\n    - person_id: per_nodate_mercer\n      role: subject',
      '- id: evt_other\n  edtf_date: 1900\n  participants:\n    - person_id: per_clara_alder\n      role: subject',
    ];
    const parsedPeople: LooseYamlRecord[] = [
      { id: 'per_nodate_mercer', is_living: false, birth_edtf: '', death_edtf: '' },
      { id: 42 },
    ];

    const res = scanTargetAndUnknownYearEvents(eventBlocks, 'per_clara_alder', parsedPeople);
    expect(res.rawPersonEvents).toHaveLength(1);
    expect(res.unknownYearEventsByPerson.get('per_nodate_mercer')).toEqual([
      { edtf_date: '' },
      { edtf_date: '1892-05' },
    ]);
  });

  it('sanitizes kinship edges with living endpoints, non-string fields, and optional family_xref', () => {
    const edges: LooseYamlRecord[] = [
      { from: 'per_living_birch', to: 'per_clara_alder', relation: 'parent', family_xref: 'F10' },
      { from: 'per_clara_alder', to: 77, relation: 88 },
      { from: 99, to: 'per_clara_alder' },
    ];
    const sanitized = buildSanitizedKinshipEdges(edges, 'per_clara_alder', new Set(['per_living_birch']));
    expect(sanitized).toEqual([
      { from: REDACTED_RELATIVE_LABEL, to: 'per_clara_alder', relation: 'parent', family_xref: 'F10' },
      { from: 'per_clara_alder', to: '', relation: '' },
      { from: '', to: 'per_clara_alder', relation: '' },
    ]);
  });

  it('collects person events, references, media, narratives, places, sources, and relative archive media edge cases', () => {
    const privacyState = makePrivacyState();
    const rawEvents: LooseYamlRecord[] = [
      {
        id: 'evt_living_num_date',
        edtf_date: 1995,
        place_id: 'plc_harbor',
        photo_url: '/media/private.jpg',
        participants: [
          { person_id: 'per_clara_alder', role: 'mother' },
          { person_id: 'per_living_birch', role: 'child' },
        ],
        sources: [{ source_id: 'src_valid' }, { source_id: '' }, 'invalid'],
      },
      {
        id: 'evt_living_bad_date',
        edtf_date: 'not-a-year',
        participants: [{ person_id: 'per_living_birch', role: 'child' }],
      },
      {
        // missing string id, missing participants, missing place_id, missing sources
        title: 'Undated note',
      },
      {
        id: 'evt_deceased_no_place',
        edtf_date: '1900',
        place_id: '',
        participants: [{ person_id: 'per_clara_alder', role: 'subject' }],
      },
    ];
    const targetPerson: LooseYamlRecord = {
      id: 'per_clara_alder',
      extensions: {
        sources: ['src_ext_str', { source_id: 'src_ext_obj' }, { other: 1 }],
      },
    };
    const evRes = collectPersonEventsAndReferences(rawEvents, targetPerson, privacyState);
    expect(evRes.events[0]!['edtf_date']!).toBe('1995');
    expect(evRes.events[0]!['place_id']!).toBeNull();
    expect(evRes.events[1]!['edtf_date']!).toBe('');
    expect(evRes.referencedSourceIds.has('src_valid')).toBe(true);
    expect(evRes.referencedSourceIds.has('src_ext_str')).toBe(true);
    expect(evRes.referencedSourceIds.has('src_ext_obj')).toBe(true);
    expect(evRes.referencedPlaceIds.size).toBe(0);

    const mediaRes = collectPersonMedia({
      mediaBlocks: [
        '- id: med_multi\n  person_ids:\n    - per_clara_alder\n    - ""\n    - 123\n  file: /media/a.jpg',
      ],
      personId: 'per_clara_alder',
      personEventIds: evRes.personEventIds,
      referencedSourceIds: evRes.referencedSourceIds,
      privacyState,
    });
    expect(mediaRes).toHaveLength(1);

    const narRes = collectPersonNarratives({
      narrativeBlocks: [
        '- id: nar_no_arrays\n  subject_person_id: per_clara_alder\n  title: Bio',
        '- id: nar_with_arrays\n  subject_person_id: per_clara_alder\n  source_ids:\n    - src_nar\n    - ""\n  place_ids:\n    - plc_nar\n    - ""\n  person_ids:\n    - per_clara_alder\n    - per_living_birch',
      ],
      personId: 'per_clara_alder',
      referencedPlaceIds: evRes.referencedPlaceIds,
      referencedSourceIds: evRes.referencedSourceIds,
      privacyState,
    });
    expect(narRes).toHaveLength(2);
    expect(narRes[1]!['person_ids']!).toEqual(['per_clara_alder', REDACTED_RELATIVE_LABEL]);

    const refs = collectReferencedPlacesAndSources({
      placeBlocks: ['- id: plc_b\n  name: Birch', '- id: plc_a\n  name: Alder'],
      sourceBlocks: ['- id: src_b\n  citation: B', '- id: src_a\n  citation: A'],
      referencedPlaceIds: new Set(['plc_b', 'plc_a']),
      referencedSourceIds: new Set(['src_b', 'src_a']),
      livingNamePattern: privacyState.livingNamePattern,
    });
    expect(refs.places.map((p) => p['id'])).toEqual(['plc_a', 'plc_b']);
    expect(refs.sources.map((s) => s['id'])).toEqual(['src_a', 'src_b']);

    // Relative archive media: exercise relation ranking & tie-breaking + non-string caption
    const peopleById = new Map<string, LooseYamlRecord>([
      ['per_parent_a', { id: 'per_parent_a', is_living: false, death_edtf: '1930' }],
      ['per_parent_b', { id: 'per_parent_b', is_living: false, death_edtf: '1931' }],
      ['per_sibling_z', { id: 'per_sibling_z', is_living: false, death_edtf: '1960' }],
    ]);
    const relMedia = collectRelativeArchiveMedia({
      includeFamily: true,
      relativeIds: {
        parentIds: new Set(['per_parent_b', 'per_parent_a']),
        spouseIds: new Set(),
        childIds: new Set(),
        siblingIds: new Set(['per_sibling_z']),
      },
      peopleById,
      privacyState,
      mediaBlocks: [
        '- id: med_rel_rank\n  person_ids:\n    - per_sibling_z\n    - per_parent_b\n    - per_parent_a\n  event_id: evt_no_id\n  file: /media/rel.jpg\n  caption: 42',
      ],
      eventBlocks: ['- title: No ID event'],
      ownMediaIds: new Set(),
    });
    expect(relMedia).toEqual([
      {
        id: 'med_rel_rank',
        file: '/media/rel.jpg',
        caption: '',
        relation: 'parent',
        relativeId: 'per_parent_a',
      },
    ]);
  });
});

describe('ops/context/ancestry.ts branch coverage', () => {
  it('handles missing ancestryDir, non-record JSON, name index collisions, and fallback fields', async () => {
    const tmp = await makeTempDir();
    const missingRes = await resolveAncestryContext({
      ancestryDir: path.join(tmp, 'does-not-exist'),
      targetPerson: { id: 'per_alder', full_name: 'Clara Alder' },
      relativeIds: { parentIds: new Set(), spouseIds: new Set(), childIds: new Set(), siblingIds: new Set() },
      includeFamily: true,
      peopleById: new Map(),
      privacyState: makePrivacyState(),
    });
    expect(missingRes.ancestry).toBeNull();
    expect(missingRes.relativeRecordImages).toEqual([]);

    const ancestryDir = path.join(tmp, 'ancestry');
    const imagesDir = path.join(ancestryDir, 'record_images');
    await mkdir(imagesDir, { recursive: true });

    // Local image file + record_images files
    const localImg = path.join(tmp, 'local_scan.jpg');
    await writeFile(localImg, VALID_JPEG);
    await writeFile(path.join(imagesDir, '101001_unmapped.jpg'), VALID_JPEG);
    await writeFile(path.join(imagesDir, '202002_relimg.jpg'), VALID_JPEG);

    // Non-record JSON for direct xref match
    await writeFile(path.join(ancestryDir, '777007.json'), JSON.stringify(['not', 'an', 'object']));
    // File without fullName + duplicate fullName files for name index
    await writeFile(path.join(ancestryDir, 'no_name.json'), JSON.stringify({ personDbId: '999001' }));
    await writeFile(
      path.join(ancestryDir, 'a_dup.json'),
      JSON.stringify({
        fullName: 'Clara Alder',
        personCard: { FullName: 'Clara Card' },
      })
    );
    await writeFile(
      path.join(ancestryDir, 'b_dup.json'),
      JSON.stringify({
        fullName: 'Clara Alder',
      })
    );
    // File matching target via xref 101001 with missing personDbId, Title-only fact, missing Place, missing LifeRange, missing fullName (uses card.FullName), missing bytes/RecordImageId
    await writeFile(
      path.join(ancestryDir, '101001.json'),
      JSON.stringify({
        personCard: { FullName: 'Clara Card Alder' },
        facts: [
          { Title: 'Residence', FactTargetPerson: { FullName: 'Arthur Alder', Id: 50 } },
          { Date: '1890' },
        ],
        sources: [
          { Detail: 'Sheet 4', RecordImageId: 555 },
          { Title: 'Census 1900', RecordImageId: 556 },
        ],
        recordImages: [{ local: 123 }, { local: localImg }],
      })
    );
    // Relative match without personDbId (falls back to basename 202002) and non-record source + duplicate RecordImageId
    await writeFile(
      path.join(ancestryDir, '202002.json'),
      JSON.stringify({
        sources: [
          'bad',
          { Title: 'Deed', RecordImageId: 'relimg' },
          { Title: 'Deed Dup', RecordImageId: 'relimg' },
        ],
        recordImages: [{ local: localImg }],
      })
    );

    const peopleById = new Map<string, LooseYamlRecord>([
      [
        'per_rel_202',
        {
          id: 'per_rel_202',
          full_name: 'Arthur Alder',
          gedcom_xref: '@I202002@',
          is_living: false,
          death_edtf: '1935',
        },
      ],
      [
        'per_rel_nomatch',
        {
          id: 'per_rel_nomatch',
          full_name: 'Unknown Mercer',
          gedcom_xref: '@I303003@',
          is_living: false,
          death_edtf: '1920',
        },
      ],
    ]);

    const res = await resolveAncestryContext({
      ancestryDir,
      targetPerson: { id: 'per_clara', full_name: 'Clara Alder', gedcom_xref: '@I101001@' },
      relativeIds: {
        parentIds: new Set(['per_rel_202', 'per_rel_nomatch']),
        spouseIds: new Set(),
        childIds: new Set(),
        siblingIds: new Set(),
      },
      includeFamily: true,
      peopleById,
      privacyState: makePrivacyState(),
    });
    expect(res.ancestry).not.toBeNull();
    if (res.ancestry && !res.ancestry.redacted) {
      expect(res.ancestry.personDbId).toBe('101001');
      expect(res.ancestry.fullName).toBe('Clara Card Alder');
      expect(res.ancestry.facts.map((f) => f.type)).toEqual(['Residence', 'Fact']);
      expect(res.ancestry.facts[0]!.targetPerson?.lifeRange).toBeNull();
      expect(res.ancestry.sources[0]!.title).toBe('');
      expect(res.ancestry.sources[0]!.recordImageId).toBe('555');
      expect(res.ancestry.recordImages.length).toBe(2);
      expect(
        res.ancestry.recordImages.some((i) => i.recordImageId === null && i.bytes === VALID_JPEG.length)
      ).toBe(true);
      expect(
        res.ancestry.recordImages.some((i) => i.recordImageId === 'unmapped' && i.sourceTitle === null)
      ).toBe(true);
    }
    expect(
      res.relativeRecordImages.some((r) => r.recordImageId === 'relimg' && r.sourceTitle === 'Deed')
    ).toBe(true);

    // Also test fullName match resolving to a non-record JSON (falls through to null) and missing card.FullName
    await writeFile(path.join(ancestryDir, 'non_rec_name.json'), '"fullName": "Birch Array"');
    await writeFile(path.join(ancestryDir, '404004.json'), JSON.stringify({ personCard: {} }));
    const resNullName = await resolveAncestryContext({
      ancestryDir,
      targetPerson: { id: 'per_no_name', full_name: 'Birch Array', gedcom_xref: '@I404004@' },
      relativeIds: { parentIds: new Set(), spouseIds: new Set(), childIds: new Set(), siblingIds: new Set() },
      includeFamily: false,
      peopleById: new Map(),
      privacyState: makePrivacyState(),
    });
    if (resNullName.ancestry && !resNullName.ancestry.redacted) {
      expect(resNullName.ancestry.fullName).toBeNull();
    }

    const resArrayXref = await resolveAncestryContext({
      ancestryDir,
      targetPerson: { id: 'per_arr', full_name: 'Clara Alder', gedcom_xref: '@I777007@' },
      relativeIds: { parentIds: new Set(), spouseIds: new Set(), childIds: new Set(), siblingIds: new Set() },
      includeFamily: false,
      peopleById: new Map(),
      privacyState: makePrivacyState(),
    });
    expect(resArrayXref.ancestry?.matchMode).toBe('fullName');
  });
});

describe('ops/pronounce (lookupProviders, mediaWiki, lookup, deduplicate, audit, lexiconLoader, checks)', () => {
  it('covers URL builders, MediaWiki & Forvo providers, and template parsing edge cases', async () => {
    expect(buildForvoLookupUrl('Alder', null)).toBe('https://forvo.com/word/alder/');
    expect(buildForvoLookupUrl('Alder', 'nl')).toBe('https://forvo.com/word/alder/#nl');
    expect(buildYouGlishLookupUrl('Alder', null, 'us')).toBe(
      'https://youglish.com/pronounce/Alder/english/us'
    );
    expect(buildYouGlishLookupUrl('Alder', 'zz', 'uk')).toBe(
      'https://youglish.com/pronounce/Alder/english/uk'
    );
    expect(buildYouGlishLookupUrl('Alder', 'de', 'us')).toBe('https://youglish.com/pronounce/Alder/german');

    expect(
      formatWikiSourceLabel({ host: 'en.wiktionary.org', project: 'wiktionary', wikiLang: 'en' }, null)
    ).toBe('Wiktionary (English IPA)');

    // MediaWiki template edge cases
    const wt = [
      '{{unclosed|foo',
      '{{|emptyname}}',
      '{{IPA|xx|dup.ogg}}',
      '{{IPA|xx|dup.ogg}}',
      '{{IPA|/ˈɑldər/}}',
      '{{IPA-all|all_audio.ogg|/ˈɑldər/}}',
      '{{IPA-de|/ˈaldɐ/}}',
      '{{pron|/ˈmɜrsər/}}',
      '{{pron|/ˈmɜrsər/|fr}}',
      '{{audio|de|de_clip.ogg}}',
      '{{audio|en_clip.ogg}}',
      '{{audio-de|de_clip2.ogg}}',
      '{{fr-audio|fr_clip.ogg}}',
    ].join(' ');
    const exEn = extractMediaWikiPronunciations(wt, { targetLang: 'en' });
    expect(exEn.ipa).toContain('/ˈɑldər/');
    expect(exEn.audioFiles.some((a) => a.filename === 'en_clip.ogg')).toBe(true);
    expect(exEn.audioFiles.some((a) => a.filename === 'all_audio.ogg' && a.language === 'en')).toBe(true);

    const exNullTarget = extractMediaWikiPronunciations(
      '{{IPA-all|no_lang_audio.ogg}} {{IPA|xx|x_audio.ogg}}',
      {
        targetLang: null,
        wikiLang: 'invalid-lang-code-xyz',
      }
    );
    expect(
      exNullTarget.audioFiles.some((a) => a.filename === 'no_lang_audio.ogg' && a.language === undefined)
    ).toBe(true);

    const exFr = extractMediaWikiPronunciations(wt, { targetLang: 'fr', wikiLang: 'en' });
    expect(exFr.audioFiles.some((a) => a.filename === 'fr_clip.ogg')).toBe(true);
    expect(exFr.audioFiles.some((a) => a.filename === 'en_clip.ogg')).toBe(false);

    // queryMediaWikiPronunciations: missing query/pages, legacy rev.content, empty wikitext, no IPA/audio, audio without language
    const mwSources: PronounceSourceHit[] = [];
    const mwAudio = new Map<string, PronounceAudioHit>();
    const mwIpa = new Set<string>();
    let mwCall = 0;
    const mwFetch: typeof fetch = async () => {
      mwCall += 1;
      if (mwCall === 1) {
        return new Response(
          JSON.stringify({
            query: {
              pages: [
                { title: 'EmptyRev', revisions: [{}] },
                { title: 'NoPron', revisions: [{ content: 'Just plain prose.' }] },
                { title: 'LegacyAudio', revisions: [{ content: '{{IPA-all|alder_legacy.ogg}}' }] },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    await queryMediaWikiPronunciations({
      term: 'Alder',
      normalizedLang: null,
      fetchImpl: mwFetch,
      timeoutMs: 1000,
      sleepFn: async () => {},
      allIpa: mwIpa,
      audioByFilename: mwAudio,
      sources: mwSources,
    });
    expect(mwSources).toHaveLength(1);
    expect(mwAudio.get('alder_legacy.ogg')?.language).toBeUndefined();

    // queryForvoPronunciations: ogg-only, missing id/votes/code/username/country, duplicate filename, singular vs plural, empty items
    const forvoAudio = new Map<string, PronounceAudioHit>();
    const forvoSources: PronounceSourceHit[] = [];
    forvoAudio.set('forvo-alder-1.ogg', {
      filename: 'forvo-alder-1.ogg',
      commons_file: 'forvo-alder-1.ogg',
      url: 'https://audio.example.test/existing.ogg',
      source_url: 'https://forvo.com/word/alder/',
    });
    await queryForvoPronunciations({
      term: 'Alder',
      normalizedLang: null,
      forvoApiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            items: [
              { id: 1, pathogg: 'https://audio.example.test/1.ogg' },
              { pathogg: 'https://audio.example.test/2.ogg', num_positive_votes: 5 },
              { id: 3 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      timeoutMs: 1000,
      sleepFn: async () => {},
      audioByFilename: forvoAudio,
      sources: forvoSources,
    });
    expect(forvoSources[0]!.label).toContain('2 native speaker recordings');
    expect(forvoAudio.has('forvo-alder-1.ogg')).toBe(true);
    expect(forvoAudio.has('forvo-alder-1.ogg')).toBe(true);

    // Single recording + no items
    const forvoSourcesSingle: PronounceSourceHit[] = [];
    await queryForvoPronunciations({
      term: 'Birch',
      normalizedLang: 'de',
      forvoApiKey: 'test-key',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            items: [
              { id: 9, pathmp3: 'https://audio.example.test/9.mp3', username: 'speakerA', country: 'DE' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      timeoutMs: 1000,
      sleepFn: async () => {},
      audioByFilename: new Map(),
      sources: forvoSourcesSingle,
    });
    expect(forvoSourcesSingle[0]!.label).toBe('Forvo (1 native speaker recording)');

    const forvoSourcesEmpty: PronounceSourceHit[] = [];
    await queryForvoPronunciations({
      term: 'Cedar',
      normalizedLang: null,
      forvoApiKey: 'test-key',
      fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
      timeoutMs: 1000,
      sleepFn: async () => {},
      audioByFilename: new Map(),
      sources: forvoSourcesEmpty,
    });
    expect(forvoSourcesEmpty[0]!.status).toBe('no_match');
  });

  it('covers rankPronounceSources tie-breakers and runPronounceLookupCommand validation/cache/format branches', async () => {
    const tmp = await makeTempDir();
    const baseHit = (overrides: Partial<PronounceSourceHit>): PronounceSourceHit => ({
      provider: 'wiktionary',
      tier: 'native_speaker',
      status: 'verified',
      site: 'en.wiktionary.org',
      title: 'Alder',
      url: 'https://en.wiktionary.org/wiki/Alder',
      label: 'Wiktionary',
      ipa: [],
      audio_files: [],
      ...overrides,
    });
    const ranked = rankPronounceSources([
      baseHit({ title: 'no-audio-no-ipa' }),
      baseHit({ title: 'ipa-only', ipa: ['/ˈɑldər/'] }),
      baseHit({ title: 'audio-only', audio_files: ['alder.ogg'] }),
    ]);
    expect(ranked.map((r) => r.title)).toEqual(['audio-only', 'ipa-only', 'no-audio-no-ipa']);

    await expect(runPronounceLookupCommand({ term: '   ', cacheDir: tmp })).rejects.toThrow(
      CliValidationError
    );
    await expect(runPronounceLookupCommand({ term: 'Alder', lang: '1234', cacheDir: tmp })).rejects.toThrow(
      CliValidationError
    );

    // Audio-only verified source (no IPA) + cache hit in text and JSON modes
    const res1 = await runPronounceLookupCommand({
      term: 'Alder',
      cacheDir: tmp,
      sleepFn: async () => {},
      fetchImpl: async (input) => {
        const hostname = new URL(String(input)).hostname;
        if (hostname === 'en.wiktionary.org') {
          return new Response(
            JSON.stringify({
              query: {
                pages: [
                  { title: 'Alder', revisions: [{ slots: { main: { content: '{{audio|alder.ogg}}' } } }] },
                ],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ query: { pages: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect(res1.verified).toBe(true);
    expect(res1.ipa).toEqual([]);
    expect(res1.source_url).toContain('en.wiktionary.org');
    expect(res1.rendered).toContain('Native audio (1):');

    const resCachedText = await runPronounceLookupCommand({ term: 'Alder', cacheDir: tmp, json: false });
    expect(resCachedText.cache_hit).toBe(true);
    expect(resCachedText.rendered).toContain('cache_hit=true');

    const resCachedJson = await runPronounceLookupCommand({ term: 'Alder', cacheDir: tmp, json: true });
    expect(resCachedJson.cache_hit).toBe(true);
    expect(JSON.parse(resCachedJson.rendered).cache_hit).toBe(true);
  });

  it('covers loadArchivePronunciationLexicon, pronunciation-checks, audit, and deduplicate edge cases', async () => {
    const tmp = await makeTempDir();
    await mkdir(path.join(tmp, 'data'), { recursive: true });
    await writeFile(
      path.join(tmp, 'data', 'pronunciations.yaml'),
      [
        'Alder:',
        '  phonetic: AWL-der',
        '  source_label: Synthetic Guide',
        'BadScalar: "just a string"',
        'BadArr:',
        '  - one',
        'BadSchema:',
        '  variants: "not-an-array"',
      ].join('\n'),
      'utf8'
    );
    const loaded = loadArchivePronunciationLexicon(tmp, { Mercer: { phonetic: 'MER-ser' } });
    expect(loaded['Alder']?.phonetic).toBe('AWL-der');
    expect(loaded['Mercer']?.phonetic).toBe('MER-ser');
    expect(loaded['BadScalar']).toBeUndefined();
    expect(loaded['BadSchema']).toBeUndefined();

    // Array top-level YAML and malformed YAML both fall back cleanly
    await writeFile(path.join(tmp, 'data', 'pronunciations.yaml'), '- item1\n- item2\n', 'utf8');
    expect(loadArchivePronunciationLexicon(tmp)).toEqual({});
    await writeFile(path.join(tmp, 'data', 'pronunciations.yaml'), ':::invalid: [yaml', 'utf8');
    expect(loadArchivePronunciationLexicon(tmp)).toEqual({});

    // runPronunciationAuditCheck edge cases
    const auditRes = runPronunciationAuditCheck({
      repoDir: tmp,
      packageDir: tmp,
      dossierText: '',
      mergedPeople: [],
      personId: 'per_no_target',
      siteConfig: null,
      livePeople: [],
      targetPerson: null,
      patch: {
        person_updates: {
          given_names: 'Owen',
          surname: 'Birch',
          birth_edtf: '1850',
          death_edtf: '1920',
          pronunciation: {
            variants: [
              { label: 'local', ipa: '/ˈoʊən/' },
              { label: 'audio', audio_url: 'https://example.test/a.ogg' },
              { label: 'noteOnly', note: 'spoken softly' },
              { label: 'badPhonetic', phonetic: 'ˈoʊən' },
            ],
          },
        },
        people: [
          { id: 'per_empty_name', birth_edtf: '1850', death_edtf: '1910', pronunciation: 'invalid-schema' },
          { id: 'per_partial', full_name: 'Alder Zxyq', birth_edtf: '1850', death_edtf: '1910' },
        ],
        places: [
          {
            id: '',
            name: 'Zxyqville',
            full_name: '',
            pronunciation: { phonetic: 'ˈzɪk-vil' },
          },
          { id: 'plc_missing', name: 'Harbor', full_name: '' },
        ],
      },
    });
    expect(auditRes.warnings.some((w) => w.includes('IPA symbol(s)'))).toBe(true);
    expect(auditRes.warnings.some((w) => w.includes("place 'Zxyqville'"))).toBe(true);
    expect(auditRes.warnings.some((w) => w.includes('plc_missing'))).toBe(true);

    // runPronounceAuditCommand validation errors + missing yaml files + Unknown surname + place pronunciation + verify check
    expect(() => runPronounceAuditCommand({ repoDir: path.join(tmp, 'nope') })).toThrow(CliValidationError);
    expect(() => runPronounceAuditCommand({ repoDir: tmp })).toThrow(CliValidationError);

    const siteCfg = makeSiteConfig({
      pronunciations: {
        Alder: { phonetic: 'AWL-der', source_label: 'Guide' },
        'Cedar Harbor': { ipa: '/ˈsiːdər ˈhɑrbər/', source_label: 'Guide' },
      },
    });
    await writeFile(path.join(tmp, 'kinloom.config.yaml'), serializeKinloomConfigYaml(siteCfg), 'utf8');
    // Without people.yaml / places.yaml
    const emptyAudit = runPronounceAuditCommand({ repoDir: tmp });
    expect(emptyAudit.summary.deceasedTotal).toBe(0);

    await writeFile(
      path.join(tmp, 'data', 'people.yaml'),
      serializePeopleYaml([
        makePerson({ id: 'per_u1', full_name: 'Clara Unknown', given_name: 'Clara', surname: 'Unknown' }),
        makePerson({ id: 'per_m1', full_name: 'Zara Birch', given_name: 'Zara', surname: 'Birch' }),
        makePerson({ id: 'per_m2', full_name: 'Zara Birch', given_name: 'Zara', surname: 'Birch' }),
        makePerson({ id: 'per_p1', full_name: 'Clara Alder', given_name: 'Clara', surname: 'Alder' }),
        makePerson({ id: 'per_p2', full_name: 'Clara Alder', given_name: 'Clara', surname: 'Alder' }),
        makePerson({
          id: 'per_kept',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          pronunciation: {
            phonetic: 'KLAIR-ah AWL-der',
            note: 'local custom stress',
            source_label: 'Family',
          },
        }),
        makePerson({
          id: 'per_liv',
          full_name: 'Living',
          given_name: 'Living',
          surname: 'Alder',
          is_living: true,
          birth_edtf: '1995',
          death_edtf: '',
        }),
      ]),
      'utf8'
    );
    await writeFile(
      path.join(tmp, 'data', 'places.yaml'),
      serializePlacesYaml([
        makePlace({
          id: 'plc_cedar',
          name: 'Cedar Harbor',
          full_name: 'Cedar Harbor, Maine',
          pronunciation: { phonetic: 'SEE-der HAR-ber', source_label: 'Guide' },
        }),
      ]),
      'utf8'
    );
    const fullAudit = runPronounceAuditCommand({ repoDir: tmp });
    expect(fullAudit.summary.placesCovered).toBe(1);
    expect(fullAudit.coverage_gaps.people_partial.length).toBeGreaterThanOrEqual(2);

    const verifyPron = runPronunciationVerifyCheck({
      repoDir: tmp,
      dataDir: path.join(tmp, 'data'),
      strictHygiene: false,
      strictPronunciation: false,
      siteConfig: siteCfg,
      people: [],
      places: [],
      events: [],
      sources: [],
      kinship: [],
      media: [],
      narratives: [],
    });
    expect(verifyPron.warnings.some((w) => w.includes('partial pronunciation coverage'))).toBe(true);

    const dedupeRes = runPronounceDeduplicateCommand({ repoDir: tmp, promoteTokens: true });
    expect(dedupeRes.rendered).toContain('Kept per-person overrides');
  });
});

describe('ops/audit (privacyStyle, hygiene, chronology) branch coverage', () => {
  it('covers privacyStyle caps, missing ids, anonymous events, non-record arrays, and dateContext fallbacks', () => {
    const ssnList = Array.from({ length: 27 }, (_, i) => `123-45-${String(1000 + i)}`).join(' ');
    const phoneList = Array.from({ length: 27 }, (_, i) => `212-555-${String(1000 + i)}`).join(' ');
    const res = runPrivacyAndStyleScan(
      `${ssnList} ${phoneList}`,
      {
        top_str: 'plain note',
        remove_event_ids: ['evt_live_1', '', 42],
        people: [
          'not-a-record',
          { id: 'per_dec', death_edtf: '', note: 'no inline death' },
          { id: '', note: 'no id' },
        ],
        events: ['not-a-record', { edtf_date: '1905', summary: 'anonymous event' }],
        media: ['not-a-record', { event_id: 'evt_missing', caption: 'scan' }, { caption: 'no event' }],
        sources: ['not-a-record', { id: 'src_unknown', citation: 'cite' }, { citation: 'no id' }],
        narratives: ['not-a-record', { subject_person_id: 123, body_md: 'prose' }],
      },
      [{ id: 'per_liv', full_name: 'Sam Birch', is_living: true }, { full_name: 'No Id' }],
      [{ id: 'per_dec', full_name: 'Clara Alder', death_edtf: '1940' }, { full_name: 'No Id Dec' }],
      {
        liveEvents: [{ id: 'evt_live_1', edtf_date: '1910' }, { edtf_date: '1911' }],
      }
    );
    expect(res.ssnHits).toHaveLength(25);
    expect(res.phoneHits).toHaveLength(25);
    expect(res.ok).toBe(false);
  });

  it('covers hygiene regression conversion fallbacks, duplicate participants, and kinship/event updates', () => {
    const warnings = runAuditHygieneRegressionCheck({
      personId: 'per_clara',
      livePeople: [
        {
          id: 'per_clara',
          full_name: '',
          portrait_url: '/media/clara.jpg',
          birth_edtf: '1880',
          death_edtf: '1950',
          extensions: { note: 'old' },
        },
      ],
      liveEvents: [
        {
          id: 'evt_marr',
          title: 'Marriage',
          category: 'marriage',
          edtf_date: '1900',
          participants: [
            { person_id: 'per_clara', role: 'bride' },
            { person_id: 123, role: 'ignored' },
          ],
        },
      ],
      liveKinship: [
        { from: 'per_p1', to: 'per_clara', relation: 'parent', family_xref: null },
        { from: 11, to: 22, relation: 33 },
      ],
      patch: {
        person_updates: {
          birth_date: '1881',
          death_date: '1951',
        },
        events: [
          {
            id: 'evt_marr',
            category: null,
            participants: [
              { person_id: 'per_clara', role: 'bride' },
              { person_id: 'per_clara', role: 'bride' },
            ],
          },
          {
            id: 'evt_new_birth',
            title: 'Birth of Clara',
            edtf_date: '1881',
            category: 'birth',
            participants: [{ person_id: 'per_clara', role: 'subject' }],
          },
        ],
        remove_event_ids: ['', 99, 'evt_nonexistent'],
        remove_kinship: [
          { from: 'per_p1', to: 'per_clara', relation: 'parent', symmetric: false },
          { from: 1, to: 2, relation: 3 },
        ],
        kinship: [
          { from: 'per_p2', to: 'per_clara', relation: 'parent', family_xref: null },
          { from: 4, to: 5, relation: 6 },
        ],
      },
    });
    expect(Array.isArray(warnings)).toBe(true);
  });

  it('covers chronology age calculation before birthday and missing metadata fallbacks', () => {
    const res = runChronologyCheck(
      null,
      {
        person_updates: { birth_date: '1880-06-15', death_date: '1950-06-15' },
        events: [
          {
            id: 'evt_before_month',
            title: 'Marriage Early',
            edtf_date: '1894-03-01',
            participants: [{ person_id: '', role: 'subject' }],
          },
          {
            id: 'evt_before_day',
            title: 'Marriage Day Before',
            edtf_date: '1894-06-10',
            participants: 'not-array',
          },
          { title: 'No ID event', edtf_date: '1900-07-01' },
        ],
        remove_event_ids: [123, ''],
      },
      [{ title: 'Live no ID', edtf_date: '1890' }]
    );
    expect(res.birth_edtf).toBe('1880-06-15');
    expect(res.death_edtf).toBe('1950-06-15');

    const resNoDates = runChronologyCheck(null, {}, []);
    expect(resNoDates.birth_edtf).toBeNull();
    expect(resNoDates.death_edtf).toBeNull();
  });
});

describe('ops/status.ts and ops/telemetry.ts branch coverage', () => {
  it('covers status sorting tie-breakers, end-of-line filtering, missing config, and all truncation labels', async () => {
    const tmp = await makeTempDir();
    const p1 = makePerson({ id: 'per_a', full_name: 'Alice Alder', birth_edtf: '', death_edtf: '' });
    const p2 = makePerson({ id: 'per_b', full_name: 'Bram Alder', birth_edtf: '1850', death_edtf: '' });
    const p3 = makePerson({ id: 'per_c', full_name: 'Cora Alder', birth_edtf: '1850', death_edtf: '' });
    const child = makePerson({
      id: 'per_child',
      full_name: 'Dora Alder',
      birth_edtf: '1880',
      death_edtf: '1950',
    });
    const kinship: KinshipEdge[] = [
      { from: 'per_a', to: 'per_child', relation: 'parent' },
      { from: 'per_b', to: 'per_child', relation: 'parent' },
      { from: 'per_c', to: 'per_child', relation: 'parent' },
    ];

    const eolSparsest = buildDeceasedQueue({
      repoDir: tmp,
      people: [p1, p2, p3, child],
      events: [],
      media: [],
      narratives: [],
      kinship,
      sort: 'sparsest',
      endOfLine: true,
    });
    expect(eolSparsest.map((i) => i.id)).toEqual(['per_b', 'per_c', 'per_a']);

    const eolRichest = buildDeceasedQueue({
      repoDir: tmp,
      people: [p3, p2, p1],
      events: [],
      media: [],
      narratives: [],
      kinship,
      sort: 'richest',
      endOfLine: true,
    });
    expect(eolRichest.map((i) => i.id)).toEqual(['per_b', 'per_c', 'per_a']);

    const eolChron = buildDeceasedQueue({
      repoDir: tmp,
      people: [p3, p2, p1],
      events: [],
      media: [],
      narratives: [],
      kinship,
      sort: 'chronological',
      endOfLine: true,
    });
    expect(eolChron.map((i) => i.id)).toEqual(['per_b', 'per_c', 'per_a']);

    const eolNoKinship = buildDeceasedQueue({
      repoDir: tmp,
      people: [p1],
      events: [],
      media: [],
      narratives: [],
      endOfLine: true,
    });
    expect(eolNoKinship).toEqual([]);

    const baseReport: StatusReport = {
      repo: tmp,
      sort: 'sparsest',
      endOfLine: false,
      endOfLineCount: 3,
      missingBiography: false,
      people: { total: 3, deceased: 3, living: 0 },
      events: 0,
      places: 0,
      zeroCoordPlaces: 0,
      sources: 0,
      media: 0,
      narratives: 0,
      biographies: { complete: 0, missing: 3, totalDeceased: 3 },
      queue: { done_live: 0, staged: 0, pending: 3 },
      deceased: eolSparsest,
    };

    expect(formatStatusTextReport(baseReport, { filter: 'done_live' })).toContain('(none)');
    expect(
      formatStatusTextReport(baseReport, {
        limit: 1,
        endOfLine: true,
        missingBiography: true,
        filter: 'pending',
      })
    ).toContain('more end-of-line missing-biography pending');
    expect(
      formatStatusTextReport(baseReport, { limit: 1, endOfLine: true, missingBiography: true })
    ).toContain('more end-of-line missing-biography');
    expect(
      formatStatusTextReport(baseReport, {
        limit: 1,
        endOfLine: false,
        missingBiography: true,
        filter: 'pending',
      })
    ).toContain('more missing-biography pending');
    expect(
      formatStatusTextReport(baseReport, { limit: 1, endOfLine: false, missingBiography: true })
    ).toContain('more missing-biography');
    expect(
      formatStatusTextReport(baseReport, {
        limit: 1,
        endOfLine: true,
        missingBiography: false,
        filter: 'pending',
      })
    ).toContain('more end-of-line pending');
    expect(
      formatStatusTextReport(baseReport, { limit: 1, endOfLine: true, missingBiography: false })
    ).toContain('more end-of-line');
    expect(formatStatusTextReport(baseReport, { limit: 1 })).toContain('more pending');

    // runStatusCommand without kinloom.config.yaml
    await mkdir(path.join(tmp, 'data'), { recursive: true });
    await writeFile(path.join(tmp, 'data', 'people.yaml'), serializePeopleYaml([p2]), 'utf8');
    const cmdRes = await runStatusCommand({ repoDir: tmp });
    expect(cmdRes.people.total).toBe(1);
  });

  it('covers telemetry parsing fallbacks, percentile empty, summarize tie-breaks, empty table, and non-ENOENT error', async () => {
    const tmp = await makeTempDir();
    const logFile = path.join(tmp, 'calls.jsonl');

    recordTelemetryEvent({ subcmd: 'status', exit_code: 1.5 }, { filePath: logFile, force: true });
    await measureCommand({ subcmd: 'verify', filePath: logFile, force: true }, async () => 'ok');
    await measureCommand(
      { subcmd: 'verify', filePath: logFile, force: true, extractResultMeta: () => ({ cacheHit: true }) },
      async () => 'ok'
    );
    await expect(
      measureCommand({ subcmd: 'fail-bad-code', filePath: logFile, force: true }, async () => {
        throw Object.assign(new Error('boom'), { exitCode: -3 });
      })
    ).rejects.toThrow('boom');

    expect(computePercentile([], 50)).toBe(0);
    expect(formatTelemetryTable([], { filePath: logFile, sinceHours: null, totalEvents: 0 })).toContain(
      '(no telemetry events recorded)'
    );

    const rows = summarizeTelemetryEvents([
      {
        ts: '',
        cmd: 'kinloom',
        subcmd: '',
        person_id: null,
        duration_ms: 10,
        cache_hit: null,
        exit_code: 0,
        bytes_out: 0,
      },
      {
        ts: '',
        cmd: '',
        subcmd: '',
        person_id: null,
        duration_ms: 10,
        cache_hit: null,
        exit_code: 0,
        bytes_out: 0,
      },
      {
        ts: '',
        cmd: 'kinloom',
        subcmd: 'alpha',
        person_id: null,
        duration_ms: 10,
        cache_hit: null,
        exit_code: 0,
        bytes_out: 0,
      },
      {
        ts: '',
        cmd: 'kinloom',
        subcmd: 'alpha',
        person_id: null,
        duration_ms: 0,
        cache_hit: null,
        exit_code: 0,
        bytes_out: 0,
      },
    ]);
    expect(rows.map((r) => r.subcmd)).toEqual(['alpha', 'kinloom', 'unknown']);

    await writeFile(
      logFile,
      [
        '[]',
        'null',
        '{not valid json',
        JSON.stringify({ ts: 1, cmd: 2, subcmd: 3, duration_ms: 'bad', exit_code: 2.5, bytes_out: 'bad' }),
      ].join('\n'),
      'utf8'
    );
    const report = await runTelemetryReportCommand({ filePath: logFile });
    expect(report.skippedLines).toBe(3);
    expect(report.totalEvents).toBe(1);
    expect(report.rendered).toContain('Telemetry (1 events)');

    // Reading a directory throws EISDIR (non-ENOENT)
    await expect(runTelemetryReportCommand({ filePath: tmp })).rejects.toThrow();
  });
});

describe('ops reports and treeHygiene (verify/report, sync/report, integrateBatch/report, diff, classifiers)', () => {
  it('covers verify/report collectVerifyDiagnostics and formatVerifyTextReport across >30 truncations and strict modes', () => {
    const manyHygiene: TreeHygieneWarning[] = Array.from({ length: 32 }, (_, i) => ({
      category: 'placeholder_event',
      message: `Placeholder event ${i}`,
      personIds: [`per_${i}`],
      eventIds: [`evt_${i}`],
    }));
    const manyPluginWarnings = Array.from({ length: 32 }, (_, i) => `Plugin warn ${i}`);
    const pronCheck: ExecutedPluginCheckResult = {
      pluginId: 'core',
      id: 'pronunciation',
      name: 'Pronunciation',
      ok: true,
      strictOk: false,
      durationMs: 5,
      errors: [],
      warnings: ['missing pron'],
      strictFailures: ['strict pron fail'],
      details: {},
    };
    const pluginChecks: ExecutedPluginCheckResult[] = [
      {
        pluginId: 'p1',
        id: 'c1',
        name: 'Check 1',
        ok: false,
        strictOk: false,
        durationMs: 2,
        errors: ['err1'],
        warnings: [],
        strictFailures: ['strict1'],
        details: {},
      },
      {
        pluginId: 'p2',
        id: 'c2',
        name: 'Check 2',
        ok: true,
        strictOk: false,
        durationMs: 3,
        errors: [],
        warnings: manyPluginWarnings,
        strictFailures: [],
        details: {},
      },
      {
        pluginId: 'p3',
        id: 'c3',
        name: 'Check 3',
        ok: true,
        strictOk: true,
        durationMs: 1,
        errors: [],
        warnings: [],
        strictFailures: [],
        details: {},
      },
    ];
    const diag = collectVerifyDiagnostics({
      citations: { ok: false, narrativesChecked: 1, errors: ['bad cite'] },
      places: { ok: false, placesChecked: 1, invalidPlaces: [{ id: 'plc_0', reason: 'zero' }] },
      ssn: { ok: false, filesScanned: 1, hits: [{ file: 'a.yaml', line: 1, match: '000-00-0000' }] },
      compile: {
        ok: false,
        privateCounts: {
          people: 1,
          living_redacted: 0,
          events: 1,
          residence_spans: 0,
          places: 1,
          sources: 1,
          media: 0,
          narratives: 0,
        },
        publicCounts: {
          people: 1,
          living_redacted: 0,
          events: 1,
          residence_spans: 0,
          places: 1,
          sources: 1,
          media: 0,
          narratives: 0,
        },
        privateReviewFlags: ['f1'],
        publicReviewFlags: ['f2'],
        privateLivingLeaks: ['l1'],
        publicLivingLeaks: ['l2'],
        duplicateResidenceSpans: ['d1'],
      },
      media: {
        ok: false,
        mediaLayout: 'media',
        checkedCount: 1,
        missingFiles: [{ id: 'med_1', file: '/media/x.jpg', expectedPath: '/tmp/x.jpg', reason: 'missing' }],
        duplicateFiles: [{ file: '/media/d.jpg', mediaIds: ['m1', 'm2'] }],
      },
      livingNames: { ok: false, hits: [{ location: 'bio', match: 'Sam Birch' }] },
      hygiene: {
        warnings: manyHygiene,
        counts: {
          duplicate_vital_event: 0,
          child_marriage: 0,
          parent_child_chronology: 0,
          excess_parents: 0,
          placeholder_event: 32,
        },
      },
      pronunciation: pronCheck,
      pluginDiscoveryWarnings: ['disc warn'],
      pluginChecks,
      strictHygiene: true,
      strictPronunciation: true,
    });
    expect(diag.errors.length).toBeGreaterThan(30);
    expect(diag.warnings.length).toBeGreaterThan(60);

    const reportObj: Omit<VerifyCommandResult, 'rendered'> = {
      ok: false,
      repo: '/tmp/repo',
      duration_ms: 12,
      strictHygiene: true,
      strictPronunciation: true,
      checks: {
        citations: { ok: false, narrativesChecked: 1, errors: ['bad cite'] },
        places: { ok: false, placesChecked: 1, invalidPlaces: [] },
        ssn: { ok: false, filesScanned: 1, hits: [] },
        compile: {
          ok: false,
          privateCounts: {
            people: 1,
            living_redacted: 0,
            events: 1,
            residence_spans: 0,
            places: 1,
            sources: 1,
            media: 0,
            narratives: 0,
          },
          publicCounts: {
            people: 1,
            living_redacted: 0,
            events: 1,
            residence_spans: 0,
            places: 1,
            sources: 1,
            media: 0,
            narratives: 0,
          },
          privateReviewFlags: [],
          publicReviewFlags: [],
          privateLivingLeaks: [],
          publicLivingLeaks: [],
          duplicateResidenceSpans: [],
        },
        media: { ok: true, mediaLayout: 'media', checkedCount: 0, missingFiles: [], duplicateFiles: [] },
        livingNames: { ok: false, hits: [] },
        pronunciation: pronCheck,
      },
      pluginChecks,
      hygiene: {
        warnings: manyHygiene,
        counts: {
          duplicate_vital_event: 0,
          child_marriage: 0,
          parent_child_chronology: 0,
          excess_parents: 0,
          placeholder_event: 32,
        },
      },
      warnings: diag.warnings,
      errors: diag.errors,
    };
    const txt = formatVerifyTextReport(reportObj);
    expect(txt).toContain('more error(s).');
    expect(txt).toContain('more warning(s).');
    expect(txt).toContain('8. Pronunciation: FAIL');

    // Non-strict WARN branches + failing pronunciation.ok === false
    const txtWarn = formatVerifyTextReport({
      ...reportObj,
      strictHygiene: false,
      strictPronunciation: false,
      checks: { ...reportObj.checks, pronunciation: { ...pronCheck, ok: false, errors: ['leak'] } },
      hygiene: {
        warnings: [],
        counts: {
          duplicate_vital_event: 0,
          child_marriage: 0,
          parent_child_chronology: 0,
          excess_parents: 0,
          placeholder_event: 0,
        },
      },
      warnings: [],
      errors: [],
    });
    expect(txtWarn).toContain('7. Tree hygiene: PASS');
    expect(txtWarn).toContain('8. Pronunciation: FAIL');

    const txtPronWarn = formatVerifyTextReport({
      ...reportObj,
      strictHygiene: false,
      strictPronunciation: false,
      hygiene: {
        warnings: manyHygiene.slice(0, 1),
        counts: {
          duplicate_vital_event: 0,
          child_marriage: 0,
          parent_child_chronology: 0,
          excess_parents: 0,
          placeholder_event: 1,
        },
      },
      warnings: ['[placeholder_event] p', '[pronunciation] w'],
      errors: [],
    });
    expect(txtPronWarn).toContain('7. Tree hygiene: WARN');
    expect(txtPronWarn).toContain('8. Pronunciation: WARN');
  });

  it('covers sync/report formatSyncReport across dry-run, live, verification failures, and optional sections', () => {
    const dryReport: Omit<SyncCommandResult, 'rendered'> = {
      repoDir: '/tmp/repo',
      baseUrl: 'https://alder.example.test',
      dbName: 'alder-db',
      r2Bucket: 'alder-media',
      dryRun: true,
      selectedTypes: ['person'],
      remoteHeadBefore: 4,
      remoteEtagBefore: null,
      countsByType: {
        person: { local: 2, remote: 1, create: 1, update: 0, delete: 0, unchanged: 1, skippedLiving: 1 },
      },
      totalPatches: 1,
      chunkSize: 50,
      plannedBatches: 1,
      changedSamples: [{ action: 'create', entity_type: 'person', entity_id: 'per_alder' }],
      filteredOutLivingMedia: 0,
      media: { checkedRemoteCount: 0, plannedUploads: [], uploadedKeys: [], concurrency: 4 },
      batchesSubmitted: [],
      recompile: null,
      liveVerification: null,
      cleanup: null,
    };
    const dryTxt = formatSyncReport(dryReport);
    expect(dryTxt).toContain('DRY RUN');
    expect(dryTxt).toContain('etag=none');
    expect(dryTxt).toContain('skipped_living=1');

    const liveTxt = formatSyncReport({
      ...dryReport,
      dryRun: false,
      remoteEtagBefore: 'etag-1',
      changedSamples: [],
      media: {
        checkedRemoteCount: 2,
        plannedUploads: ['a'],
        uploadedKeys: ['a'],
        concurrency: 4,
      },
      batchesSubmitted: [{ batch_id: 'b1', patchCount: 1, head_revision_id: 5, etag: 'etag-2' }],
      recompile: { httpStatus: 200, etag: null, maxRevisionId: 5, counts: null },
      liveVerification: {
        ok: false,
        bundleStatus: null,
        bundleRevision: null,
        expectedRevision: null,
        mediaChecked: 2,
        mediaFailed: 1,
        failures: [
          { target: 'media', url: 'https://alder.example.test/m.jpg', status: 404, reason: 'not found' },
        ],
      },
      cleanup: { deletedTokenIds: ['t1'], remainingTmpCount: 0, backupTokenLabel: 'backup', backupCount: 1 },
    });
    expect(liveTxt).toContain('LIVE SYNC');
    expect(liveTxt).toContain('Live verification [FAIL]');
    expect(liveTxt).toContain('VERIFY FAIL [media]');

    const passLvTxt = formatSyncReport({
      ...dryReport,
      dryRun: false,
      liveVerification: {
        ok: true,
        bundleStatus: 200,
        bundleRevision: 5,
        expectedRevision: 5,
        mediaChecked: 1,
        mediaFailed: 0,
        failures: [],
      },
    });
    expect(passLvTxt).toContain('Live verification [PASS]');
  });

  it('covers integrateBatch/report dryRun, drifted skips, receipts, and removed counts', () => {
    const item: IntegrateBatchItemResult = {
      ok: true,
      dryRun: true,
      repo: '/tmp/repo',
      personId: 'per_alder',
      packageDir: '/tmp/pkg',
      mediaLayout: 'media',
      counts: {
        personUpdated: false,
        people: { added: 0, updated: 0, unchanged: 1 },
        events: { added: 1, updated: 0, unchanged: 0 },
        places: { added: 0, updated: 0, unchanged: 0 },
        sources: { added: 1, updated: 0, unchanged: 0 },
        media: { added: 1, updated: 0, unchanged: 0 },
        kinship: { added: 0, updated: 0, unchanged: 0 },
        narratives: { added: 0, updated: 0, unchanged: 0 },
      },
      removedEventIds: ['evt_old'],
      removedSourceIds: ['src_old'],
      removedMediaIds: ['med_old'],
      removedKinshipCount: 1,
      removedKinship: [],
      removedEvents: 1,
      removedMedia: 1,
      inlineCitationCount: 2,
      stagedScans: [],
      wouldWriteYamlFiles: [],
      writtenYamlFiles: [],
      validation: {
        privateCounts: {
          people: 1,
          living_redacted: 0,
          events: 1,
          residence_spans: 0,
          places: 1,
          sources: 1,
        },
        publicCounts: { people: 1, living_redacted: 0, events: 1, residence_spans: 0, places: 1, sources: 1 },
        privateReviewFlags: 0,
        publicReviewFlags: 0,
        livingLeaks: 0,
      },
    };
    const report: Omit<IntegrateBatchCommandResult, 'rendered'> = {
      mode: 'batch',
      ok: true,
      dryRun: true,
      repo: '/tmp/repo',
      requested: ['per_alder'],
      integrated: ['per_alder'],
      skippedAlreadyIntegrated: [],
      skippedDrifted: ['per_drifted'],
      markedIntegrated: ['per_marked'],
      preFlightOverlaps: {
        hasBlockingConflicts: false,
        blocking: {
          differingScanCollisions: 0,
          conflictingMediaFileCollisions: 0,
          conflictingPersonOverlaps: 0,
          conflictingPersonSlugCollisions: 0,
          liveMediaFileCollisions: 0,
          kinshipAddRemoveConflicts: 0,
        },
        overlaps: {
          scanFileCollisions: [],
          mediaFileCollisions: [],
          sharedMediaIds: [],
          sharedSourceIds: [],
          sharedEventOverlaps: [],
          sharedPersonOverlaps: [],
          personSlugCollisions: [],
          liveMediaFileCollisions: [],
          kinshipAddRemoveConflicts: [],
        },
      },
      results: [item],
      totals: {
        personUpdated: 0,
        people: { added: 0, updated: 0, unchanged: 1 },
        events: { added: 1, updated: 0, unchanged: 0 },
        places: { added: 0, updated: 0, unchanged: 0 },
        sources: { added: 1, updated: 0, unchanged: 0 },
        media: { added: 1, updated: 0, unchanged: 0 },
        kinship: { added: 0, updated: 0, unchanged: 0 },
        narratives: { added: 0, updated: 0, unchanged: 0 },
        removedSources: 1,
        removedEvents: 1,
        removedMedia: 1,
        removedKinship: 1,
        inlineCitations: 2,
        stagedScans: 0,
      },
      wouldWriteYamlFiles: [],
      writtenYamlFiles: [],
    };
    const rendered = formatIntegrateBatchTextReport(report);
    expect(rendered).toContain('Batch integrate dry-run OK');
    expect(rendered).toContain('drifted legacy skipped');
    expect(rendered).toContain('Recorded receipts (1): per_marked');
    expect(rendered).toContain('events=+1/~0/-1');
    expect(rendered).toContain('kinship=+0/~0/-1');
  });

  it('covers treeHygiene/diff and treeHygiene/classifiers edge branches', () => {
    const pre: TreeHygieneWarning[] = [
      { category: 'duplicate_vital_event', message: 'dup', personIds: ['per_a'] },
      { category: 'excess_parents', message: 'excess', personIds: ['per_child', 'per_p1', 'per_p2'] },
      { category: 'child_marriage', message: 'cm', personIds: ['per_a'], eventIds: ['evt_m1'] },
      {
        category: 'parent_child_chronology',
        message: 'Child was born after mother died.',
        personIds: ['per_c', 'per_m'],
      },
      { category: 'placeholder_event', message: 'ph', personIds: ['per_z'], eventIds: ['evt_ph'] },
    ];
    const post: TreeHygieneWarning[] = [
      { category: 'duplicate_vital_event', message: 'dup no events', personIds: ['per_a'] },
      { category: 'duplicate_vital_event', message: 'dup new', personIds: ['per_a'], eventIds: ['evt_b1'] },
      { category: 'excess_parents', message: 'excess empty', personIds: [] },
      { category: 'excess_parents', message: 'excess diff child', personIds: ['per_other', 'per_p1'] },
      { category: 'child_marriage', message: 'cm', personIds: ['per_a'] },
      {
        category: 'parent_child_chronology',
        message: 'Child was born after mother died.',
        personIds: ['per_c', 'per_m'],
      },
      { category: 'placeholder_event', message: 'ph', personIds: ['per_other'], eventIds: ['evt_ph'] },
      { category: 'placeholder_event', message: 'ph2', personIds: ['per_other'] },
    ];
    const diffed = diffTreeHygieneWarnings({
      preWarnings: pre,
      postWarnings: post,
      touchedPersonIds: new Set(['per_a', 'per_c', 'per_other']),
      touchedEventIds: new Set(['evt_ph', 'evt_b1']),
    });
    expect(diffed.some((w) => w.message === 'dup no events')).toBe(true);
    expect(diffed.some((w) => w.message === 'dup new')).toBe(true);
    expect(diffed.some((w) => w.category === 'parent_child_chronology')).toBe(false);
    expect(formatAuditHygieneWarningMessage(pre[3]!)).toContain('parent-child chronology anomaly');

    expect(hasAdoptivePersonTag(undefined)).toBe(false);
    expect(hasAdoptivePersonTag(makePerson({ id: 'p1', extensions: { adoptive_link: true } }))).toBe(true);
    expect(hasAdoptivePersonTag(makePerson({ id: 'p2', extensions: { adoptive_flag: 'yes' } }))).toBe(true);
    expect(
      hasAdoptivePersonTag(
        makePerson({ id: 'p3', extensions: { adoptive_flag: 'false', note: 'adopted in 1900' } })
      )
    ).toBe(true);
    expect(hasAdoptivePersonTag(makePerson({ id: 'p4', extensions: { adoptive_flag: '' } }))).toBe(false);
    expect(isAdoptionEvent(makeEvent({ id: 'e1', title: 'Adoption of Clara' }))).toBe(true);
    expect(
      getMarriageSpouseIds(
        makeEvent({
          id: 'e2',
          participants: [
            { person_id: 'per_a', role: 'neighbor' },
            { person_id: 'per_b', role: 'bride' },
          ],
        })
      )
    ).toEqual(['per_b']);
    expect(personLabel('per_missing', new Map())).toBe('per_missing');
    expect(normalizeSex(undefined)).toBe('U');
    expect(normalizeSex(makePerson({ id: 'p5', sex: 'M' }))).toBe('M');
  });
});

interface FakeResponseEvent {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  json(): Promise<unknown>;
}

interface FakeBrowserPage extends OptionalBrowserPage {
  on(event: string, listener: (resp: FakeResponseEvent) => void): void;
  removeListener(event: string, listener: (resp: FakeResponseEvent) => void): void;
  emitResponse(resp: FakeResponseEvent): void;
}

function makeFakeBrowser(options: {
  readonly onGoto: (url: string, page: FakeBrowserPage) => Promise<void> | void;
  readonly waitForFunctionImpl?: (
    fn: string,
    arg?: unknown,
    opts?: { timeout?: number | undefined }
  ) => Promise<unknown>;
  readonly omitWaitForTimeout?: boolean;
  readonly evaluateResult?: unknown;
}): OptionalBrowser {
  const listeners = new Set<(resp: FakeResponseEvent) => void>();
  const page: FakeBrowserPage = {
    on(event, listener) {
      if (event === 'response') {
        listeners.add(listener);
      }
    },
    removeListener(event, listener) {
      if (event === 'response') {
        listeners.delete(listener);
      }
    },
    emitResponse(resp) {
      for (const listener of [...listeners]) {
        listener(resp);
      }
    },
    async goto(url) {
      await options.onGoto(url, page);
    },
    async content() {
      return '<html><body>National Archives Identifier</body></html>';
    },
    async evaluate<T>(): Promise<T> {
      return options.evaluateResult as T;
    },
    async close() {},
    ...(options.waitForFunctionImpl ? { waitForFunction: options.waitForFunctionImpl } : {}),
    ...(options.omitWaitForTimeout
      ? {}
      : {
          async waitForTimeout() {},
        }),
  };

  return {
    async newContext() {
      return {
        async newPage() {
          return page;
        },
        async close() {},
      };
    },
    async close() {},
  };
}

describe('records/clients/nara (browserFallback, queryAndRecords, censusCommands, catalogCommands, catalogTransport)', () => {
  it('covers defaultBrowserSearchMany and defaultBrowserGetRecords fallback and error branches', async () => {
    let clock = 1_000_000;
    const { ctx } = makeCapturedContext({ nowMs: () => clock });

    // Search: non-JSON response, missing content-type, non-plain-record JSON, captured body without hits array -> DOM scrape returning non-array and array with query=null and query='Alder'
    const browser1 = makeFakeBrowser({
      evaluateResult: 'not-an-array',
      onGoto: (_url, page) => {
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/records/search?q=alder',
          status: () => 200,
          headers: () => ({}),
          json: async () => ({}),
        });
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/records/search?q=alder',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => ['not-record'],
        });
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/records/search?q=alder',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => ({ hits: 'not-object' }),
        });
      },
      waitForFunctionImpl: async () => {
        throw new Error('wait timed out softly');
      },
    });
    const res1 = await defaultBrowserSearchMany(
      [
        ['Alder', 'https://catalog.archives.gov/search?q=Alder'],
        [null, 'https://catalog.archives.gov/search'],
      ],
      ctx,
      5000,
      { launcher: async () => browser1 }
    );
    expect(res1).toHaveLength(2);
    expect(res1[0]!.query).toBe('Alder');
    expect(res1[0]!.results).toEqual([]);
    expect(res1[1]!.query).toBeUndefined();

    // Search: waitForFunction throws when remainingMs <= 0 -> rethrown
    const browserTimeout = makeFakeBrowser({
      onGoto: () => {},
      waitForFunctionImpl: async () => {
        clock += 10_000;
        throw new Error('deadline exceeded');
      },
    });
    await expect(
      defaultBrowserSearchMany([['Alder', 'https://catalog.archives.gov/search?q=Alder']], ctx, 500, {
        launcher: async () => browserTimeout,
      })
    ).rejects.toThrow('deadline exceeded');

    // GetRecords: missing content-type, non-record payload, empty hits, contributions non-array + non-record + transcription field + empty transcription, omitWaitForTimeout -> ctx.sleepFn
    const browserGet = makeFakeBrowser({
      omitWaitForTimeout: true,
      onGoto: (_url, page) => {
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/records/search?naId_is=12345',
          status: () => 200,
          headers: () => ({}),
          json: async () => ({}),
        });
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/records/search?naId_is=12345',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => ['bad-payload'],
        });
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/records/search?naId_is=12345',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => ({ hits: { hits: [] } }),
        });
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/records/search?naId_is=12345',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => ({
            hits: {
              hits: [{ _source: { record: { naId: 12345, title: 'Harbor Ledger' } } }],
            },
          }),
        });
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/contributions/targetNaId/12345',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => 'not-an-array',
        });
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/contributions/targetNaId/12345',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => [
            'not-a-record',
            { contributionType: 'transcription', transcription: 'Line one of Harbor Ledger.' },
            { contributionType: 'transcription', text: '' },
            { contributionType: 'tag', text: 'harbor' },
          ],
        });
      },
      waitForFunctionImpl: async () => {
        throw new Error('soft wait failure');
      },
    });
    const recs = await defaultBrowserGetRecords(
      ['12345'],
      { includeObjects: false, includeText: true, pageSpec: null, timeoutMs: 2000 },
      ctx,
      { launcher: async () => browserGet }
    );
    expect(recs[0]!.transcriptions).toEqual(['Line one of Harbor Ledger.']);

    // GetRecords: waitForFunction fails after deadline exhausted -> rethrows
    const browserGetTimeout = makeFakeBrowser({
      onGoto: () => {},
      waitForFunctionImpl: async () => {
        clock += 10_000;
        throw new Error('get deadline exceeded');
      },
    });
    await expect(
      defaultBrowserGetRecords(
        ['12345'],
        { includeObjects: false, includeText: false, pageSpec: null, timeoutMs: 500 },
        ctx,
        { launcher: async () => browserGetTimeout }
      )
    ).rejects.toThrow('get deadline exceeded');

    // GetRecords: includeText with contributions having zero non-empty transcriptions
    const browserGetEmptyTrans = makeFakeBrowser({
      onGoto: (_url, page) => {
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/records/search?naId_is=67890',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => ({
            body: { hits: { hits: [{ _source: { record: { naId: 67890, title: 'Birch Roll' } } }] } },
          }),
        });
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/contributions/targetNaId/67890',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => [{ contributionType: 'transcription', text: '' }],
        });
      },
    });
    const recs2 = await defaultBrowserGetRecords(
      ['67890'],
      { includeObjects: false, includeText: true, pageSpec: null },
      ctx,
      { launcher: async () => browserGetEmptyTrans }
    );
    expect(recs2[0]!.transcriptions).toBeUndefined();
  });

  it('covers queryAndRecords extractRecord, buildSearchPayload, projectRecord, and formatRecordText edge cases', () => {
    const emptyRec = extractRecord('not-a-record');
    expect(emptyRec).toEqual({ naId: '', title: '', url: '' });

    const directRec = extractRecord(
      {
        naId: 5001,
        title: 'Cedar Muster',
        productionDateArray: [{ logicalDate: '1863' }, { noDate: true }, 'bad'],
        microformPublications: [{ identifier: '', title: null }],
        physicalOccurrences: [
          { referenceUnits: [{ name: 'Unit A' }, { name: 'Unit B' }] },
          { referenceUnits: 'bad' },
        ],
        digitalObjects: [
          { objectUrl: 'https://s3.amazonaws.com/NARAprodstorage/a.jpg', otherExtractedText: 'Alt OCR' },
          { objectId: null, objectUrl: 42 },
        ],
      },
      { includeObjects: true, includeText: true }
    );
    expect(directRec.location).toEqual(['Unit A', 'Unit B']);
    expect(directRec.objects?.[1]).toEqual({ page: 2, filename: '', url: '' });
    expect(directRec.extractedText).toEqual([{ page: 1, filename: '', text: 'Alt OCR' }]);

    const noTextRec = extractRecord(
      { naId: 5002, title: 'Empty OCR', digitalObjects: [{ objectFilename: 'p1.jpg' }] },
      { includeText: true }
    );
    expect(noTextRec.extractedText).toBeUndefined();

    const searchStrTotal = buildSearchPayload(null, 'https://catalog.archives.gov/search', {
      hits: { total: '42', hits: [] },
    });
    expect(searchStrTotal.total).toBe(42);
    const searchMissingHits = buildSearchPayload('Alder', 'https://catalog.archives.gov/search', {});
    expect(searchMissingHits.total).toBe(0);

    // projectRecord with undefined objectCount, empty total with extractedText, and filtered-out extractedText
    const proj1 = projectRecord(
      {
        naId: '5001',
        url: 'https://catalog.archives.gov/id/5001',
        objects: [{ page: 1, filename: 'p1.jpg', url: 'https://example.test/p1.jpg' }],
        extractedText: [{ page: 1, filename: 'p1.jpg', text: 'hello' }],
      },
      { includeObjects: true, includeText: true, pageSpec: '1' }
    );
    expect(proj1.objects).toHaveLength(1);
    const projZeroTotal = projectRecord(
      {
        naId: '5001',
        url: 'https://catalog.archives.gov/id/5001',
        extractedText: [{ page: 1, filename: 'p1.jpg', text: 'hello' }],
      },
      { includeText: true }
    );
    expect(projZeroTotal.extractedText).toHaveLength(1);
    const projNoMatchText = projectRecord(
      {
        naId: '5001',
        url: 'https://catalog.archives.gov/id/5001',
        objectCount: 2,
        extractedText: [{ page: 2, filename: 'p2.jpg', text: 'page2' }],
      },
      { includeText: true, pageSpec: '1' }
    );
    expect(projNoMatchText.extractedText).toBeUndefined();

    const txt = formatRecordText({
      naId: '5001',
      url: 'https://catalog.archives.gov/id/5001',
      access: 'Unrestricted',
      location: ['Unit A', 'Unit B'],
    });
    expect(txt).toContain('Access/Use: Unrestricted / ?');
    expect(txt).toContain('Location: Unit A; Unit B');
    expect(
      formatRecordText({ naId: '5002', url: 'https://catalog.archives.gov/id/5002', use: 'Open' })
    ).toContain('Access/Use: ? / Open');
  });

  it('covers censusCommands, catalogCommands, and catalogTransport edge branches', async () => {
    const tmp = await makeTempDir();
    // census1950 with sparse payload, non-record row, state-without-abbr, missing fields, person without row
    const { ctx: cCtx, stdout: cOut } = makeCapturedContext({
      cwd: tmp,
      env: { KINLOOM_NARA_CACHE_DIR: path.join(tmp, 'cache') },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                state: 'Maine',
                names: ['not-a-person', { name: 'Clara Alder' }, { row: '12', name: 'Arthur Alder' }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    });
    await runCensus1950(['--state', 'ME'], cCtx);
    expect(cOut.join('\n')).toContain('1950 Census population schedules: 0 hit(s)');
    expect(cOut.join('\n')).toContain('  Clara Alder');

    // census1950 JSON mode with null defaults
    const { ctx: cJsonCtx, stdout: cJsonOut } = makeCapturedContext({
      cwd: tmp,
      env: { KINLOOM_NARA_CACHE_DIR: path.join(tmp, 'xdg-c2') },
      fetchImpl: async () =>
        new Response(JSON.stringify({ results: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await runCensus1950(['--state', 'ME', '--json', '--refresh'], cJsonCtx);
    expect(JSON.parse(cJsonOut.join(''))).toMatchObject({ total: null, page: null, size: null, results: [] });

    // census1950-image text output downloaded then cached, plus --json single
    const imgPath = '1950census/43290879-Maine/43290879-Maine-000100/43290879-Maine-000100-0005.jpg';
    const { ctx: imgCtx, stdout: imgOut } = makeCapturedContext({
      cwd: tmp,
      env: { KINLOOM_NARA_CACHE_DIR: path.join(tmp, 'img-cache') },
      fetchImpl: async () =>
        new Response(VALID_JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    });
    await runCensus1950Image([imgPath], imgCtx);
    expect(imgOut[0]).toContain('Downloaded:');
    await runCensus1950Image([imgPath], imgCtx);
    expect(imgOut[1]).toContain('Cached:');
    await runCensus1950Image([imgPath, '--json'], imgCtx);
    expect(JSON.parse(imgOut[2]!).cache_hit).toBe(true);

    // catalogCommands: runUrl without query, runSearch without query & empty browser slot, runGet defaults, runDownload errors & default dir
    const { ctx: catCtx, stdout: catOut } = makeCapturedContext({
      cwd: tmp,
      env: { KINLOOM_NARA_CACHE_DIR: path.join(tmp, 'cat-cache') },
    });
    expect(runNaraUrl([], catCtx).exitCode).toBe(0);
    await runNaraSearch(['--rg', '29'], catCtx, {
      browserSearchMany: async () => [
        {
          searchUrl: 'https://catalog.archives.gov/search?rg=29',
          total: 1,
          results: [{ naId: '9001', url: 'https://catalog.archives.gov/id/9001' }],
        },
      ],
    });
    expect(catOut.join('\n')).toContain('NAID 9001 ():');

    await runNaraGet(['9001'], catCtx, {
      browserGetRecords: async () => [
        { naId: '9001', url: 'https://catalog.archives.gov/id/9001', title: 'Birch Roll' },
      ],
    });

    // runDownload: missing fullRec from browserGetRecords, no matching digital objects with missing title, unsafe relative --out, and default targetDir with --cache-ttl-hours
    await expect(runNaraDownload(['9002'], catCtx, { browserGetRecords: async () => [] })).rejects.toThrow(
      RecordRuntimeError
    );
    await expect(
      runNaraDownload(['9003'], catCtx, {
        browserGetRecords: async () => [{ naId: '9003', url: 'https://catalog.archives.gov/id/9003' }],
      })
    ).rejects.toThrow('has no matching digital objects');
    await expect(
      runNaraDownload(['9004', '--out', '../escape', '--cache-ttl-hours', '2'], catCtx, {
        browserGetRecords: async () => [
          {
            naId: '9004',
            url: 'https://catalog.archives.gov/id/9004',
            objects: [
              { page: 1, filename: 'p1.jpg', url: 'https://s3.amazonaws.com/NARAprodstorage/p1.jpg' },
            ],
          },
        ],
      })
    ).rejects.toThrow('Unsafe output directory');

    // catalogTransport edge cases
    expect(
      parseRetryAfterSeconds(new Headers({ 'retry-after': 'not-a-date' }), () => 1000, 10)
    ).toBeUndefined();
    expect(
      parseRetryAfterSeconds(new Headers({ 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' }), () => 0, 10)
    ).toBe(10);

    const validatedUrls: string[] = [];
    let hopCount = 0;
    const redirResp = await fetchFollowingRedirects('https://catalog.archives.gov/start', {
      headers: {},
      timeoutMs: 1000,
      validateUrl: (u) => {
        validatedUrls.push(u);
        return u;
      },
      fetchImpl: async (u) => {
        hopCount += 1;
        if (hopCount === 1) {
          const r = new Response('', { status: 302, headers: { location: '/next' } });
          Object.defineProperty(r, 'url', { value: String(u) });
          return r;
        }
        return new Response('ok', { status: 200 });
      },
    });
    expect(redirResp.status).toBe(200);
    expect(validatedUrls).toContain('https://catalog.archives.gov/next');

    // apiGetJson: non-Error throw, missing content-type, array JSON vs primitive JSON
    const transportCtx = makeCapturedContext({
      fetchImpl: async () => {
        throw 'string-net-error';
      },
    }).ctx;
    await expect(apiGetJson('https://catalog.archives.gov/api', 'key', transportCtx)).rejects.toThrow(
      'string-net-error'
    );

    const primCtx = makeCapturedContext({
      fetchImpl: async () =>
        new Response('123', { status: 200, headers: { 'content-type': 'application/json' } }),
    }).ctx;
    await expect(apiGetJson('https://catalog.archives.gov/api', 'key', primCtx)).rejects.toThrow(
      'got number'
    );

    const noCtCtx = makeCapturedContext({
      fetchImpl: async () => new Response('{}', { status: 200 }),
    }).ctx;
    await expect(apiGetJson('https://catalog.archives.gov/api', 'key', noCtCtx)).rejects.toThrow();

    // apiSearchOne: non-WAF error rethrows; query=null on WAF returns null; WAF retry throwing non-WAF rethrows
    const emptyFilter = { levels: [], recordGroups: [], online: false, page: 1, limit: 10 };
    const err500Ctx = makeCapturedContext({
      fetchImpl: async () => new Response('boom', { status: 400 }),
    }).ctx;
    await expect(apiSearchOne('Alder', 'key', emptyFilter, err500Ctx)).rejects.toThrow();

    const wafNullQueryCtx = makeCapturedContext({
      fetchImpl: async () =>
        new Response('<html>waf</html>', { status: 403, headers: { 'content-type': 'text/html' } }),
    }).ctx;
    const [wafEntry] = await apiSearchOne(null, 'key', emptyFilter, wafNullQueryCtx);
    expect(wafEntry).toBeNull();

    let wafRetryCall = 0;
    const wafThen400Ctx = makeCapturedContext({
      fetchImpl: async () => {
        wafRetryCall += 1;
        if (wafRetryCall === 1) {
          return new Response('<html>waf</html>', { status: 403, headers: { 'content-type': 'text/html' } });
        }
        return new Response('bad request', { status: 400 });
      },
    }).ctx;
    await expect(apiSearchOne('"Clara Alder"', 'key', emptyFilter, wafThen400Ctx)).rejects.toThrow();

    // loadOrFetchFullRecordsWithHits: API non-WAF error rethrows; API empty hits without body wrapper returns Not found
    await expect(
      loadOrFetchFullRecordsWithHits(
        ['12345'],
        {
          apiKey: 'key',
          forceBrowser: false,
          includeText: false,
          refresh: true,
          cacheRoot: path.join(tmp, 'tr-c'),
        },
        err500Ctx,
        {}
      )
    ).rejects.toThrow();

    const emptyApiCtx = makeCapturedContext({
      fetchImpl: async () =>
        new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }),
    }).ctx;
    const [nfRecs] = await loadOrFetchFullRecordsWithHits(
      ['12345'],
      {
        apiKey: 'key',
        forceBrowser: false,
        includeText: false,
        refresh: true,
        cacheRoot: path.join(tmp, 'tr-c2'),
      },
      emptyApiCtx,
      {}
    );
    expect(nfRecs[0]!.error).toBe('Not found');
  });
});

describe('records/clients/findagrave (formatters, transport, commands) branch coverage', () => {
  it('covers formatters defensive fallbacks across memorial, cemetery, and place formatters', () => {
    expect(primaryName({ name: ['not-a-record'] })).toBe('');
    expect(firstPlaceName({ names: 'not-array' })).toBe('');
    expect(firstPlaceName({ names: [{ name: 123 }] })).toBe('');
    expect(fmtCemetery({ names: [{ name: 456 }] })).toBe('');

    expect(formatSearchText(undefined, [{}])).toContain(' memorials');

    const lines = formatMemorialsLines(
      [
        {
          cemetery: { names: [{ name: 'Cedar Grove' }] },
          photos: 'not-a-record',
          isVeteran: false,
          hasGravePhoto: false,
          relationships: ['not-a-record', { memorial: 'not-a-record' }],
          dateCreated: '2020-01-01',
        },
        {
          id: '10',
          photos: { photos: ['bad-item', {}] },
        },
        {
          id: '11',
          photos: { photos: [] },
        },
      ],
      { full: false, photos: true }
    );
    expect(lines.join('\n')).toContain('Cemetery: Cedar Grove ()');
    expect(lines.join('\n')).toContain('Veteran: no | Grave photo: no | Photos: ');
    expect(lines.join('\n')).toContain('Created: 2020-01-01 | Modified: ');
    expect(lines.join('\n')).toContain('    |  | ');

    expect(
      formatCemeteriesText(undefined, [
        { names: 'bad' },
        { names: [{ name: 'Birch Hill' }, 'bad', { name: 99 }] },
      ])
    ).toContain('Birch Hill |  memorials');

    expect(formatPlacesText({})).toBe(' places');
    expect(
      formatPlacesText({ total: 1, locations: ['bad', { names: 'bad' }, { names: [{ name: 5 }] }] })
    ).toContain(' |  | ');
  });

  it('covers transport photoCacheFresh, runGraphqlQuery, fetchPhotoBytes, and cache refresh/empty branches', async () => {
    const tmp = await makeTempDir();
    // Expired photo cache + .type sidecar is a directory
    const photoFile = path.join(tmp, 'photo.bin');
    await writeFile(photoFile, Buffer.from('non-magic-bytes'));
    await mkdir(`${photoFile}.type`, { recursive: true });
    expect(photoCacheFresh(photoFile, 24, () => Date.now())).toBe(false);
    expect(photoCacheFresh(photoFile, 1, () => Date.now() + 7_200_000)).toBe(false);

    // runGraphqlQuery: redirect without location, non-Error fetch failure, missing content-type, GraphQL errors with non-record & missing message, missing data
    const { ctx: noLocCtx } = makeCapturedContext({
      fetchImpl: async () => new Response('', { status: 302 }),
    });
    await expect(runGraphqlQuery(noLocCtx, 'query {}', {})).rejects.toThrow('HTTP 302');

    const { ctx: strErrCtx } = makeCapturedContext({
      fetchImpl: async () => {
        throw 'string-gql-fail';
      },
    });
    await expect(runGraphqlQuery(strErrCtx, 'query {}', {})).rejects.toThrow('string-gql-fail');

    const { ctx: gqlErrCtx } = makeCapturedContext({
      fetchImpl: async () => new Response(JSON.stringify({ errors: [{}, 'raw-error'] }), { status: 200 }),
    });
    await expect(runGraphqlQuery(gqlErrCtx, 'query {}', {})).rejects.toThrow('GraphQL error: raw-error');

    const { ctx: emptyDataCtx } = makeCapturedContext({
      fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    expect(await runGraphqlQuery(emptyDataCtx, 'query {}', {})).toEqual({});

    // fetchPhotoBytes: resp.url validation, redirect without location, content-encoding gzip vs identity vs 0 length, non-Error throw
    const photoUrl = 'https://images.findagrave.com/photos/alder.jpg';
    const { ctx: pCtx1 } = makeCapturedContext({
      fetchImpl: async () => {
        const r = new Response(VALID_JPEG, {
          status: 200,
          headers: { 'content-length': '0', 'content-encoding': 'identity', 'content-type': 'image/jpeg' },
        });
        Object.defineProperty(r, 'url', { value: photoUrl });
        return r;
      },
    });
    expect((await fetchPhotoBytes(pCtx1, photoUrl)).content.length).toBe(VALID_JPEG.length);

    const { ctx: pCtxGzip } = makeCapturedContext({
      fetchImpl: async () =>
        new Response(VALID_JPEG, {
          status: 200,
          headers: { 'content-length': '99999', 'content-encoding': 'gzip' },
        }),
    });
    expect((await fetchPhotoBytes(pCtxGzip, photoUrl)).content.length).toBe(VALID_JPEG.length);

    const { ctx: pCtxNoLoc } = makeCapturedContext({
      fetchImpl: async () => new Response('', { status: 302 }),
    });
    await expect(fetchPhotoBytes(pCtxNoLoc, photoUrl)).rejects.toThrow('HTTP 302');

    const { ctx: pCtxStrErr } = makeCapturedContext({
      fetchImpl: async () => {
        throw 'photo-net-str';
      },
    });
    await expect(fetchPhotoBytes(pCtxStrErr, photoUrl)).rejects.toThrow('photo-net-str');

    // cachedGqlQuery with refresh: true; loadOrFetchMemorialsWithHits with non-array & missing id; loadOrFetchCemeteryById with empty cemeteries
    const cacheOpts = { cacheRoot: path.join(tmp, 'fag-cache'), ttlHours: 24, refresh: true };
    const cq = await cachedGqlQuery(emptyDataCtx, 'search', { q: 'alder' }, 'query {}', {}, cacheOpts);
    expect(cq.cacheHit).toBe(false);

    const { ctx: memWeirdCtx } = makeCapturedContext({
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: { memorialsById: [{ name: [] }] } }), { status: 200 }),
    });
    const mRes = await loadOrFetchMemorialsWithHits(memWeirdCtx, ['101'], cacheOpts);
    expect(mRes.memorials).toEqual([]);
    expect((await loadOrFetchMemorialsWithHits(emptyDataCtx, ['101'], cacheOpts)).memorials).toEqual([]);

    const cRes = await loadOrFetchCemeteryById(emptyDataCtx, '202', cacheOpts);
    expect(cRes.result['cemeteries']).toEqual([]);
  });

  it('covers findagrave/commands default options, empty payloads, and bare URL generation', async () => {
    const tmp = await makeTempDir();
    const { ctx, stdout } = makeCapturedContext({
      cwd: tmp,
      env: {
        KINLOOM_FINDAGRAVE_CACHE_DIR: path.join(tmp, 'fg-cmd'),
        FINDAGRAVE_CACHE_DIR: path.join(tmp, 'fg-cmd'),
      },
      fetchImpl: async () => new Response(JSON.stringify({ data: {} }), { status: 200 }),
    });

    await runFagSearch(['--first-name', 'Clara', '--birth-year', '1875', '--year-range', '2'], ctx);
    expect(stdout.at(-1)).toContain('memorials');

    const getRes = await runFagGet(['101'], ctx);
    expect(getRes.bytesOut).toBe(0);

    await runFagCemetery(['--name', 'Cedar Grove'], ctx);
    await runFagCemetery(['202'], ctx);
    await runFagPlace(['Cedar Harbor'], ctx);

    runFagUrl([], ctx);
    expect(stdout.at(-1)).toBe('https://www.findagrave.com/memorial/search');

    const helpRes = await runFindagraveCommand(['url', '--help'], ctx);
    expect(helpRes.exitCode).toBe(0);
  });
});

describe('records/clients/prepScan (pdfCommands, rasterCommands, sheetAndStitchCommands) branch coverage', () => {
  it('covers pdfCommands extractExecErrorDetails variants, pdfinfo edge cases, and cmdPdfGrep validation/zero-width regex', async () => {
    const tmp = await makeTempDir();
    const pdfPath = path.join(tmp, 'doc.pdf');
    await writeFile(pdfPath, '%PDF-1.4\n%synthetic\n', 'ascii');
    const pngBytes = await createSyntheticPng(80, 60, { r: 220, g: 220, b: 220 });

    // Non-object error, string stderr, Buffer stdout, string stdout, message-only object with no code
    const errorsToTest: unknown[] = [
      'raw-string-error',
      { stderr: 'string stderr detail', code: 2 },
      { stdout: Buffer.from('buffer stdout detail') },
      { stdout: 'string stdout detail', code: 3 },
      { message: 'only message detail' },
    ];
    for (const errObj of errorsToTest) {
      const { ctx } = makeCapturedContext({
        cwd: tmp,
        env: { KINLOOM_OCR_CACHE_DIR: path.join(tmp, 'pdf-err-cache') },
        execFileImpl: async () => {
          throw errObj;
        },
      });
      await expect(
        renderOrLoadPdfPage(pdfPath, 'sha', 1, 150, 'jpg', path.join(tmp, 'pdf-err-cache'), true, ctx)
      ).rejects.toThrow(RecordRuntimeError);
    }

    // cmdPdfPages with defaults, pdfinfo returning no match & Pages: 0
    for (const pdfInfoOut of ['Title: Sample\n', 'Pages: 0\n']) {
      const outDir = path.join(tmp, `pdf-out-${pdfInfoOut.length}`);
      const { ctx } = makeCapturedContext({
        cwd: tmp,
        env: { KINLOOM_OCR_CACHE_DIR: path.join(tmp, `pdf-cache-${pdfInfoOut.length}`) },
        execFileImpl: async (cmd, args) => {
          if (cmd === 'pdfinfo') {
            return { stdout: Buffer.from(pdfInfoOut), stderr: Buffer.alloc(0) };
          }
          const prefix = args[args.length - 1];
          await writeFile(`${prefix}-1.jpg`, pngBytes);
          return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        },
      });
      const res = await cmdPdfPages([pdfPath, '--pages', '1', '--out-dir', outDir], ctx);
      expect(res.exitCode).toBe(0);
    }

    // cmdPdfGrep: invalid limit/context, invalid regex, zero-width regex reaching EOL, non-trailing-\f output, pdftotext failure without code
    const { ctx: grepCtx, stdout: grepOut } = makeCapturedContext({
      cwd: tmp,
      env: { KINLOOM_OCR_CACHE_DIR: path.join(tmp, 'grep-cache') },
      execFileImpl: async () => ({
        stdout: Buffer.from('Alder Harbor\nBirch'),
        stderr: Buffer.alloc(0),
      }),
    });
    await expect(cmdPdfGrep([pdfPath, '--pattern', 'Alder', '--limit', '0'], grepCtx)).rejects.toThrow(
      CliValidationError
    );
    await expect(cmdPdfGrep([pdfPath, '--pattern', '['], grepCtx)).rejects.toThrow(CliValidationError);

    const zeroWidthRes = await cmdPdfGrep([pdfPath, '--pattern', '^'], grepCtx);
    expect(zeroWidthRes.exitCode).toBe(1);
    expect(grepOut.join('\n')).toContain('0 match(es)');

    const { ctx: grepErrCtx } = makeCapturedContext({
      cwd: tmp,
      env: { XDG_CACHE_HOME: path.join(tmp, 'xdg-grep-err') },
      execFileImpl: async () => {
        throw { stderr: 'pdftotext broke' };
      },
    });
    await expect(cmdPdfGrep([pdfPath, '--pattern', 'Alder', '--refresh'], grepErrCtx)).rejects.toThrow(
      'pdftotext failed (exit 1)'
    );
  });

  it('covers rasterCommands and sheetAndStitchCommands defaults, stem collisions, corrupt info, and partial labels', async () => {
    const tmp = await makeTempDir();
    const dirA = path.join(tmp, 'a');
    const dirB = path.join(tmp, 'b');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    const imgA = path.join(dirA, 'scan.png');
    const imgB = path.join(dirB, 'scan.png');
    const corrupt = path.join(tmp, 'corrupt.png');
    const pngSmall = await createSyntheticPng(120, 80, { r: 200, g: 210, b: 220 });
    const pngWide = await createSyntheticPng(200, 80, { r: 180, g: 190, b: 200 });
    await writeFile(imgA, pngSmall);
    await writeFile(imgB, pngWide);
    await writeFile(corrupt, 'not-an-image');

    const { ctx, stderr } = makeCapturedContext({
      cwd: tmp,
      env: { KINLOOM_OCR_CACHE_DIR: path.join(tmp, 'ps-cache') },
    });

    // cmdPreview with colliding stems and default maxWidth/maxKb
    const prevRes = await cmdPreview([imgA, imgB, '--out-dir', path.join(tmp, 'previews')], ctx);
    expect(prevRes.exitCode).toBe(0);

    // cmdCrop, cmdRotate, cmdGrid (wide > maxWidth and narrow <= maxWidth), cmdJoin with defaults
    expect((await cmdCrop([imgA, path.join(tmp, 'crop.jpg')], ctx)).exitCode).toBe(0);
    expect((await cmdRotate([imgA, path.join(tmp, 'rot.jpg'), '--angle', '90'], ctx)).exitCode).toBe(0);
    expect((await cmdGrid([imgB, path.join(tmp, 'grid1.jpg'), '--max-width', '100'], ctx)).exitCode).toBe(0);
    expect((await cmdGrid([imgA, path.join(tmp, 'grid2.jpg')], ctx)).exitCode).toBe(0);
    expect((await cmdJoin([imgA, imgB, '--out', path.join(tmp, 'join.jpg')], ctx)).exitCode).toBe(0);

    // cmdInfo on corrupt image
    const infoErr = await cmdInfo([corrupt], ctx);
    expect(infoErr.exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('cannot read image');

    // cmdSheetStrip with defaults, one valid + one missing source in text mode (emits warning)
    const stripRes = await cmdSheetStrip(
      [imgA, path.join(tmp, 'missing.png'), '--out', path.join(tmp, 'strip.jpg')],
      ctx
    );
    expect(stripRes.exitCode).toBe(0);
    expect(stderr.join('\n')).toContain('warning:');

    // cmdStitch with defaults, fewer labels than boxes (horizontal & vertical), --max-width only & --max-kb only
    expect(
      (
        await cmdStitch(
          [
            imgB,
            path.join(tmp, 'stitch_v.jpg'),
            '--box',
            '0,0,100,40',
            '--box',
            '0,40,120,80',
            '--labels',
            'HeaderOnly',
            '--max-width',
            '100',
          ],
          ctx
        )
      ).exitCode
    ).toBe(0);
    expect(
      (
        await cmdStitch(
          [
            imgB,
            path.join(tmp, 'stitch_h.jpg'),
            '--direction',
            'horizontal',
            '--box',
            '0,0,80,40',
            '--box',
            '80,0,160,80',
            '--labels',
            'LeftOnly',
            '--max-kb',
            '120',
          ],
          ctx
        )
      ).exitCode
    ).toBe(0);
  });
});

describe('records/clients/narrativeAudio (synthesis, commands) branch coverage', () => {
  it('covers synthesis defaultExecFile, findExecutableOnPath, resolveCloudTtsHeaders, synthesizeWithGemini, and transcribeAudioFile edge cases', async () => {
    const tmp = await makeTempDir();
    // Real defaultExecFile success & failure using process.execPath
    const okExec = await audioDefaultExecFile(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(okExec.stdout.toString('utf8')).toBe('hi');
    await expect(
      audioDefaultExecFile(process.execPath, ['-e', 'process.stderr.write("err"); process.exit(2)'])
    ).rejects.toThrow();

    expect(findExecutableOnPath('nonexistent-kinloom-bin-xyz', {})).toBeNull();

    // resolveCloudTtsHeaders: Error instance, non-Error throw, and '(unset)' project
    const { ctx: errInstCtx } = makeCapturedContext({
      execFileImpl: async () => {
        throw new Error('gcloud auth expired');
      },
    });
    await expect(resolveCloudTtsHeaders(undefined, undefined, errInstCtx)).rejects.toThrow(
      'gcloud auth expired'
    );

    const { ctx: nonErrCtx } = makeCapturedContext({
      execFileImpl: async () => {
        throw 'not-an-error';
      },
    });
    await expect(resolveCloudTtsHeaders(undefined, undefined, nonErrCtx)).rejects.toThrow(
      'run gcloud auth login'
    );

    const { ctx: unsetProjCtx } = makeCapturedContext({
      execFileImpl: async (_cmd, args) => {
        if (args[0] === 'auth') {
          return { stdout: Buffer.from('tok-123\n'), stderr: Buffer.alloc(0) };
        }
        return { stdout: Buffer.from('(unset)\n'), stderr: Buffer.alloc(0) };
      },
    });
    const hdrs = await resolveCloudTtsHeaders(undefined, undefined, unsetProjCtx);
    expect(hdrs).toEqual({ Authorization: 'Bearer tok-123' });

    // synthesizeWithGemini: non-array candidates throws; raw PCM without rate & without usageMetadata
    const { ctx: badCandCtx } = makeCapturedContext({
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: async () => new Response(JSON.stringify({ candidates: 'bad' }), { status: 200 }),
    });
    await expect(
      synthesizeWithGemini({
        chunks: [{ text: 'Hello Alder', voice: 'Charon', pauseBefore: 0, isNotes: false }],
        model: 'gemini-tts',
        keyFile: undefined,
        ctx: badCandCtx,
      })
    ).rejects.toThrow('missing inline audio data');

    const pcmB64 = Buffer.alloc(480).toString('base64');
    const { ctx: rawPcmCtx } = makeCapturedContext({
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { data: pcmB64, mimeType: 'audio/L16' } }] } }],
          }),
          { status: 200 }
        ),
    });
    const synthOut = await synthesizeWithGemini({
      chunks: [{ text: 'Hello Alder', voice: 'Charon', pauseBefore: 0, isNotes: false }],
      model: 'gemini-tts',
      keyFile: undefined,
      ctx: rawPcmCtx,
    });
    expect(synthOut.sampleRate).toBe(24000);
    expect(synthOut.usageStr).toBe('0 tokens');

    // transcribeAudioFile: missing/malformed candidates/content/parts/text
    const audioFile = path.join(tmp, 'clip.mp3');
    await writeFile(audioFile, Buffer.from('ID3-synthetic'));
    const { ctx: trCtx } = makeCapturedContext({
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: ['bad', { text: 123 }, { text: 'Spoken Alder' }] } }],
          }),
          { status: 200 }
        ),
    });
    expect(
      await transcribeAudioFile({ audioPath: audioFile, model: 'gemini', keyFile: undefined, ctx: trCtx })
    ).toBe('Spoken Alder');
    const { ctx: trEmptyCtx } = makeCapturedContext({
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    expect(
      await transcribeAudioFile({
        audioPath: audioFile,
        model: 'gemini',
        keyFile: undefined,
        ctx: trEmptyCtx,
      })
    ).toBe('');
  });

  it('covers narrativeAudio/commands help flags, list/extract/check/synth/transcribe defaults and missing ffmpeg', async () => {
    const tmp = await makeTempDir();
    const { ctx, stdout } = makeCapturedContext({ cwd: tmp });

    expect(runAudioList(['--help'], ctx).exitCode).toBe(0);
    expect(runAudioExtract(['--help'], ctx).exitCode).toBe(0);
    expect(runAudioCheck(['--help'], ctx).exitCode).toBe(0);
    expect((await runAudioSynth(['--help'], ctx)).exitCode).toBe(0);
    expect((await runAudioTranscribe(['--help'], ctx)).exitCode).toBe(0);

    const narYaml = path.join(tmp, 'narratives.yaml');
    await writeFile(
      narYaml,
      ['- id: nar_b', '  kind: biography', '- id: nar_a', '  kind: biography'].join('\n'),
      'utf8'
    );
    expect(runAudioList([narYaml], ctx).exitCode).toBe(0);
    expect(stdout.at(-1)).toContain('nar_a');
    expect(runAudioList([narYaml, '--kind', 'essay'], ctx).bytesOut).toBe(0);

    expect(runAudioExtract([narYaml, 'nar_a'], ctx).exitCode).toBe(0);
    expect(stdout.at(-1)).toContain('SLUG: nar_a');

    const scriptPath = path.join(tmp, 'clara.script.txt');
    await writeFile(scriptPath, 'Clara Alder lived near Cedar Harbor.', 'utf8');
    expect(runAudioCheck([scriptPath], ctx).exitCode).toBe(1);

    // runSynth without ffmpeg on PATH (execFileImpl undefined, empty PATH)
    const { ctx: noFfmpegCtx } = makeCapturedContext({ cwd: tmp, env: { PATH: '' } });
    await expect(runAudioSynth([scriptPath], noFfmpegCtx)).rejects.toThrow('ffmpeg not found on PATH');

    // runSynth with default --out, --voice, --notes-voice, --section-pause, --notes-pause, --bitrate, --model
    const pcmB64 = Buffer.alloc(480).toString('base64');
    const { ctx: synthCtx } = makeCapturedContext({
      cwd: tmp,
      env: { GEMINI_API_KEY: 'test-key', NARRATIVE_AUDIO_BACKEND: 'gemini' },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ inlineData: { data: pcmB64, mimeType: 'audio/L16;rate=24000' } }] } },
            ],
          }),
          { status: 200 }
        ),
      execFileImpl: async (_cmd, args) => {
        const outMp3 = args[args.length - 1]!;
        await writeFile(outMp3, Buffer.from('mp3-bytes'));
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      },
    });
    const sRes = await runAudioSynth([scriptPath], synthCtx);
    expect(sRes.exitCode).toBe(0);

    // runTranscribe with default --model and default --out
    const mp3Path = path.join(tmp, 'clara.mp3');
    await writeFile(mp3Path, Buffer.from('mp3-bytes'));
    const { ctx: trCmdCtx } = makeCapturedContext({
      cwd: tmp,
      env: { GEMINI_API_KEY: 'test-key' },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: '[00:00] Clara Alder.' }] } }] }),
          { status: 200 }
        ),
    });
    const tRes = await runAudioTranscribe([mp3Path], trCmdCtx);
    expect(tRes.exitCode).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'clara.transcript.md'))).toBe(true);
  });
});

describe('records/clients/ocr (imageAndTsv, subprocess, pipeline) branch coverage', () => {
  it('covers imageAndTsv dimension parsers and sparse TSV headers', () => {
    // JPEG ending with 0xff padding hitting pos >= n
    expect(readJpegDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xff]))).toBeNull();

    // TIFF with fieldType 4 (LONG), unsupported fieldType 9, and count 0
    const tiffLong = Buffer.alloc(8 + 2 + 12 * 3);
    tiffLong.write('II', 0, 'ascii');
    tiffLong.writeUInt16LE(42, 2);
    tiffLong.writeUInt32LE(8, 4);
    tiffLong.writeUInt16LE(3, 8);
    // Entry 0: tag 256, fieldType 9 (ignored), count 1
    tiffLong.writeUInt16LE(256, 10);
    tiffLong.writeUInt16LE(9, 12);
    tiffLong.writeUInt32LE(1, 14);
    // Entry 1: tag 256, fieldType 4 (LONG), count 1, val 320
    tiffLong.writeUInt16LE(256, 22);
    tiffLong.writeUInt16LE(4, 24);
    tiffLong.writeUInt32LE(1, 26);
    tiffLong.writeUInt32LE(320, 30);
    // Entry 2: tag 257, fieldType 4 (LONG), count 1, val 240
    tiffLong.writeUInt16LE(257, 34);
    tiffLong.writeUInt16LE(4, 36);
    tiffLong.writeUInt32LE(1, 38);
    tiffLong.writeUInt32LE(240, 42);
    expect(readTiffDimensions(tiffLong)).toEqual([320, 240]);

    // Zero-dimension PNG, GIF, BMP, short WebP, zero-dim VP8 WebP
    const pngZero = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngZero, 0);
    expect(readImageDimensions(pngZero)).toBeNull();

    const gifZero = Buffer.alloc(10);
    gifZero.write('GIF89a', 0, 'ascii');
    expect(readImageDimensions(gifZero)).toBeNull();

    const bmpZero = Buffer.alloc(26);
    bmpZero[0] = 0x42;
    bmpZero[1] = 0x4d;
    expect(readImageDimensions(bmpZero)).toBeNull();

    const webpShort = Buffer.from('RIFF1234WEBPshort', 'ascii');
    expect(readImageDimensions(webpShort)).toBeNull();

    const webpVp8Zero = Buffer.alloc(30);
    webpVp8Zero.write('RIFF', 0, 'ascii');
    webpVp8Zero.write('WEBP', 8, 'ascii');
    webpVp8Zero.write('VP8 ', 12, 'ascii');
    webpVp8Zero[23] = 0x9d;
    webpVp8Zero[24] = 0x01;
    webpVp8Zero[25] = 0x2a;
    expect(readImageDimensions(webpVp8Zero)).toBeNull();

    // parseTesseractTsv with minimal header missing optional columns & short row using raw[c] ?? ''
    const parsed = parseTesseractTsv(['level\ttext\tleft', '5\tAlder'].join('\n'));
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]!.text).toBe('Alder');
    expect(parsed.lines[0]!.conf).toBe(-1);
  });

  it('covers subprocess resolveExecutable, createDefaultExecFile, and runSubprocessWithTimeout paths', async () => {
    const tmp = await makeTempDir();
    // Directory path with separator -> isFile() is false -> null
    expect(resolveExecutable(tmp, {})).toBeNull();
    expect(resolveExecutable('nonexistent-ocr-bin-xyz', {})).toBeNull();

    const defExec = createDefaultExecFile();
    const okOut = await defExec(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(okOut.stdout.toString('utf8')).toBe('ok');
    await expect(defExec(process.execPath, ['-e', 'process.exit(1)'])).rejects.toThrow();

    // runSubprocessWithTimeout with execFileImpl: SIGTERM timeout, numeric code with string stdout/stderr, numeric code with undefined streams
    await expect(
      runSubprocessWithTimeout({
        bin: 'tesseract',
        args: [],
        env: {},
        timeoutSeconds: 1,
        fileForError: 'page.png',
        timeoutLabel: 'tesseract',
        execFileImpl: async () => {
          throw { signal: 'SIGTERM' };
        },
      })
    ).rejects.toThrow(OcrTimeoutError);

    const codeOut = await runSubprocessWithTimeout({
      bin: 'tesseract',
      args: [],
      env: {},
      timeoutSeconds: 1,
      fileForError: 'page.png',
      timeoutLabel: 'tesseract',
      execFileImpl: async () => {
        throw { code: 2, stdout: 'out-str', stderr: 'err-str' };
      },
    });
    expect(codeOut).toEqual({ exitCode: 2, stdout: 'out-str', stderr: 'err-str' });

    const codeEmpty = await runSubprocessWithTimeout({
      bin: 'tesseract',
      args: [],
      env: {},
      timeoutSeconds: 1,
      fileForError: 'page.png',
      timeoutLabel: 'tesseract',
      execFileImpl: async () => {
        throw { code: 3 };
      },
    });
    expect(codeEmpty).toEqual({ exitCode: 3, stdout: '', stderr: '' });

    // Real spawn path: success + stderr, and real timeout triggering SIGTERM
    const spawnOk = await runSubprocessWithTimeout({
      bin: process.execPath,
      args: ['-e', 'process.stdout.write("A"); process.stderr.write("B")'],
      env: process.env,
      timeoutSeconds: 5,
      fileForError: 'page.png',
      timeoutLabel: 'node',
    });
    expect(spawnOk).toEqual({ exitCode: 0, stdout: 'A', stderr: 'B' });

    await expect(
      runSubprocessWithTimeout({
        bin: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10000)'],
        env: process.env,
        timeoutSeconds: 0.05,
        fileForError: 'page.png',
        timeoutLabel: 'node',
      })
    ).rejects.toThrow(OcrTimeoutError);
  });

  it('covers ocr/pipeline expandBatchInputs and runOcrBatchCommand text/grep/error branches', async () => {
    const tmp = await makeTempDir();
    const sub = path.join(tmp, 'sub');
    await mkdir(sub, { recursive: true });
    const img1 = path.join(sub, 'folio1.png');
    const badImg = path.join(sub, 'empty.png');
    const txtFile = path.join(sub, 'readme.txt');
    const pngBytes = await createSyntheticPng(60, 40, { r: 240, g: 240, b: 240 });
    await writeFile(img1, pngBytes);
    await writeFile(badImg, Buffer.alloc(0));
    await writeFile(txtFile, 'ignored');

    const viaGlob = expandBatchInputs(['sub/*.png'], tmp);
    expect(viaGlob).toHaveLength(2);
    const viaRelFile = expandBatchInputs(['sub/folio1.png'], tmp);
    expect(viaRelFile).toHaveLength(1);

    // runOcrBatchCommand: text mode with --grep (case-sensitive), one ok file + one invalid file + one erroring file
    const img2 = path.join(sub, 'folio2.png');
    await writeFile(img2, await createSyntheticPng(64, 40, { r: 230, g: 230, b: 230 }));
    const { ctx, stdout } = makeCapturedContext({
      cwd: tmp,
      env: { ...process.env, KINLOOM_OCR_CACHE_DIR: path.join(tmp, 'ocr-cache') },
      execFileImpl: async (_bin, args) => {
        const joined = args.join(' ');
        if (joined.includes('--version')) {
          return { stdout: Buffer.from('tesseract 5.3.0\n'), stderr: Buffer.alloc(0) };
        }
        if (args[0]!.includes('folio2')) {
          throw 'non-error-ocr-crash';
        }
        return { stdout: Buffer.from('Clara Alder\nCedar Harbor\n'), stderr: Buffer.alloc(0) };
      },
    });
    const batchRes = await runOcrBatchCommand(
      [img1, badImg, img2, '--mode', 'printed', '--grep', 'Alder'],
      ctx
    );
    expect(batchRes.exitCode).toBe(1);
    const output = stdout.join('\n');
    expect(output).toContain("Grep 'Alder': 1 match(es)");
    expect(output).toContain('[FAILED]');
  });
});

describe('ops Wave 2: integrateEngine (people, kinship, execute), stagedOverlaps, sqlParser, sync, audit, deduplicateRules', () => {
  it('covers integrateEngine/people edge cases: conflicting death dates, null date clears, bio fallback, non-array sources, privacy refusals', () => {
    const basePerson = makePerson({
      id: 'per_clara',
      slug: 'clara-alder',
      extensions: { sources: 'not-an-array' },
    });
    const privacy = { livingCutoffYears: 110 };

    // Conflicting death_edtf vs death_date throws
    expect(() =>
      applyPeoplePatch(
        [basePerson],
        {
          person_updates: { death_edtf: '1948', death_date: '1949' },
          people: [],
        },
        'per_clara',
        '/tmp/data',
        privacy
      )
    ).toThrow();

    // Clearing birth_edtf with null + bio fallback + sources merge when existing sources is non-array + patch.people updating existing without alt_names
    const merged = applyPeoplePatch(
      [basePerson],
      {
        person_updates: {
          birth_edtf: null,
          bio: 'Short bio of Clara Alder.',
          sources: ['src_1900'],
          extensions: { sources: ['src_ext'] },
        },
        people: [
          {
            id: 'per_clara',
            slug: 'clara-alder',
            full_name: 'Clara Alder',
            given_name: 'Clara',
            surname: 'Alder',
            sex: 'F',
            is_living: false,
            lineage_group: 'paternal',
            birth_edtf: '1875-03-10',
            death_edtf: '1948-11-04',
            portrait_url: null,
            extensions: { sources: ['src_people'] },
          },
        ],
      },
      'per_clara',
      '/tmp/data',
      privacy
    );
    expect(merged.mergedPeople[0]!.birth_edtf).toBe('');
    expect(merged.personUpdated).toBe(true);

    // Privacy refusal for living person missing id -> 'unknown'
    expect(() =>
      applyPeoplePatch(
        [basePerson],
        {
          person_updates: null,
          people: [{ is_living: true }],
        },
        'per_clara',
        '/tmp/data',
        privacy
      )
    ).toThrow('PRIVACY REFUSAL');

    // Schema error at root when patch.people item is invalid
    expect(() =>
      applyPeoplePatch(
        [basePerson],
        {
          person_updates: null,
          people: [{ id: 'per_bad', full_name: 123 }],
        },
        'per_clara',
        '/tmp/data',
        privacy
      )
    ).toThrow();
  });

  it('covers integrateEngine/kinship parsing, removals, upsert preservation, and symmetry verification', () => {
    expect(() => parseRemoveKinshipEntries(['not-an-object'], 'remove_kinship')).toThrow(CliValidationError);
    expect(() =>
      parseRemoveKinshipEntries([{ from: 'per_a', to: 'bad id!', relation: 'parent' }], 'remove_kinship')
    ).toThrow(CliValidationError);

    const dupTargets = expandRemoveKinshipTargets([
      { from: 'per_a', to: 'per_b', relation: 'spouse', symmetric: true },
      { from: 'per_b', to: 'per_a', relation: 'spouse', symmetric: true },
    ]);
    expect(dupTargets).toHaveLength(2);

    const existing: KinshipEdge[] = [
      { from: 'per_a', to: 'per_b', relation: 'parent', family_xref: 'F1' },
      { from: 'per_b', to: 'per_a', relation: 'child', family_xref: 'F1' },
    ];
    // applyKinshipRemovals without incomingList removes both
    const remNoIncoming = applyKinshipRemovals(existing, [
      { from: 'per_a', to: 'per_b', relation: 'parent', symmetric: true },
    ]);
    expect(remNoIncoming.remaining).toEqual([]);
    expect(remNoIncoming.removed).toHaveLength(2);

    // applyKinshipRemovals preserves exact incoming match
    const remWithIncoming = applyKinshipRemovals(
      existing,
      [{ from: 'per_a', to: 'per_b', relation: 'parent', symmetric: true }],
      [{ from: 'per_a', to: 'per_b', relation: 'parent', family_xref: 'F1' }]
    );
    expect(remWithIncoming.remaining).toHaveLength(1);

    // mergeKinshipPatch preserves existing family_xref when incoming omits it, and rejects asymmetric removal
    const keptXref = mergeKinshipPatch(existing, [{ from: 'per_a', to: 'per_b', relation: 'parent' }], []);
    expect(keptXref.items[0]!.family_xref).toBe('F1');

    expect(() =>
      mergeKinshipPatch(
        existing,
        [],
        [
          { from: 'per_a', to: 'per_b', relation: 'parent', symmetric: false },
          { from: 'per_a', to: 'per_b', relation: 'parent', symmetric: false },
        ]
      )
    ).toThrow('Asymmetric kinship graph');
  });

  it('covers integrateEngine/execute validation guards', async () => {
    const tmp = await makeTempDir();
    await expect(runIntegrateCommand({ repoDir: tmp, personId: '' })).rejects.toThrow(CliValidationError);
    await expect(runIntegrateCommand({ repoDir: tmp, personId: '../escape' })).rejects.toThrow(
      CliValidationError
    );
    await expect(
      runIntegrateCommand({ repoDir: path.join(tmp, 'missing-repo'), personId: 'per_alder' })
    ).rejects.toThrow(CliValidationError);
    await expect(
      runIntegrateCommand({
        repoDir: tmp,
        personId: 'per_alder',
        packageDir: path.join(tmp, 'patch.json'),
      })
    ).rejects.toThrow(CliValidationError);
    // Missing people.yaml
    await expect(runIntegrateCommand({ repoDir: tmp, personId: 'per_alder' })).rejects.toThrow();
    await mkdir(path.join(tmp, 'data'), { recursive: true });
    await writeFile(
      path.join(tmp, 'data', 'people.yaml'),
      serializePeopleYaml([makePerson({ id: 'per_alder' })]),
      'utf8'
    );
    // Missing kinloom.config.yaml
    await expect(runIntegrateCommand({ repoDir: tmp, personId: 'per_alder' })).rejects.toThrow();
    await writeFile(
      path.join(tmp, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(makeSiteConfig()),
      'utf8'
    );
    // Missing patch.json
    await expect(runIntegrateCommand({ repoDir: tmp, personId: 'per_alder' })).rejects.toThrow();
  });

  it('covers stagedOverlaps/detectors deduplication, empty slugs/files, and kinship xref conflict matching', () => {
    const pkg1: ParsedPackage = {
      personId: 'per_a',
      packageDir: '/tmp/a',
      media: [
        { id: 'med_empty', file: '', normalizedFile: '' },
        { id: 'med_1', file: '/media/shared.jpg', normalizedFile: '/media/shared.jpg' },
        { id: 'med_1', file: '/media/shared.jpg', normalizedFile: '/media/shared.jpg' },
      ],
      sources: [{ id: 'src_1' }, { id: 'src_1' }],
      eventRows: [
        {
          id: 'evt_1',
          person_id: 'per_a',
          edtf_date: '1900',
          place_id: null,
          place_precision: null,
          title: 'T1',
        },
        {
          id: 'evt_1',
          person_id: 'per_a',
          edtf_date: '1900',
          place_id: null,
          place_precision: null,
          title: 'T1',
        },
      ],
      stagedPeople: [
        {
          id: 'per_shared',
          person_id: 'per_a',
          slug: '',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          sex: 'F',
          birth_edtf: '1880',
          death_edtf: '1950',
          lineage_group: 'paternal',
          branch: null,
        },
        {
          id: 'per_shared',
          person_id: 'per_a',
          slug: 'clara-alder',
          full_name: 'Clara Alder',
          given_name: 'Clara',
          surname: 'Alder',
          sex: 'F',
          birth_edtf: '1880',
          death_edtf: '1950',
          lineage_group: 'paternal',
          branch: null,
        },
      ],
      kinshipAdds: [
        { from: 'per_x', to: 'per_y', relation: 'parent', family_xref: 'F1' },
        { from: 'per_x', to: 'per_y', relation: 'spouse', family_xref: null },
      ],
      kinshipRemoves: [],
    };
    const pkg2: ParsedPackage = {
      ...pkg1,
      personId: 'per_b',
      media: [{ id: 'med_2', file: '/media/shared.jpg', normalizedFile: '/media/shared.jpg' }],
      sources: [{ id: 'src_1' }],
      eventRows: [
        {
          id: 'evt_1',
          person_id: 'per_b',
          edtf_date: '1901',
          place_id: null,
          place_precision: null,
          title: 'T2',
        },
      ],
      stagedPeople: [
        {
          ...pkg1.stagedPeople[1]!,
          id: 'per_other',
          person_id: 'per_b',
          slug: 'clara-alder',
        },
        {
          ...pkg1.stagedPeople[1]!,
          id: 'per_shared',
          person_id: 'per_b',
          full_name: 'Clara Mercer',
        },
      ],
      kinshipAdds: [],
      kinshipRemoves: [
        { from: 'per_x', to: 'per_y', relation: 'parent', family_xref: 'F1' },
        { from: 'per_x', to: 'per_y', relation: 'spouse', family_xref: 'F2' },
      ],
    };

    expect(collectMediaFileCollisions([pkg1, pkg2])).toHaveLength(1);
    expect(collectSharedMediaIds([pkg1, pkg2])).toEqual([]);
    expect(collectSharedSourceIds([pkg1, pkg2])).toHaveLength(1);
    expect(collectSharedEvents([pkg1, pkg2])[0]!.fieldDiffs).toContain('edtf_date');
    expect(collectSharedPeople([pkg1, pkg2])[0]!.fieldDiffs).toContain('full_name');
    expect(collectPersonSlugCollisions([pkg1, pkg2])[0]!.personIdsConflict).toBe(true);
    expect(collectKinshipAddRemoveConflicts([pkg1, pkg2])).toHaveLength(2);
  });

  it('covers migrate/sqlParser quoted identifiers and evaluateMigrationStatus with existing indexes', () => {
    const sql = [
      'CREATE TABLE "quoted_tbl" (id TEXT);',
      'CREATE TABLE `tick_tbl` (id TEXT);',
      'CREATE TABLE [bracket_tbl] (id TEXT);',
      'CREATE TABLE "quoted_tbl" (id TEXT);',
      'CREATE INDEX "idx_q" ON "quoted_tbl" (id);',
      'CREATE INDEX `idx_t` ON `tick_tbl` (id);',
      'CREATE INDEX [idx_b] ON [bracket_tbl] (id);',
      'CREATE INDEX "idx_q" ON "quoted_tbl" (id);',
      'ALTER TABLE "quoted_tbl" ADD COLUMN "col_q" TEXT;',
      'ALTER TABLE `tick_tbl` ADD COLUMN `col_t` TEXT;',
      'ALTER TABLE [bracket_tbl] ADD COLUMN [col_b] TEXT;',
      ';',
    ].join('\n');
    const req = parseMigrationSchemaRequirements(sql);
    expect(req.createdTables).toEqual(['quoted_tbl', 'tick_tbl', 'bracket_tbl']);
    expect(req.createdIndexes).toEqual(['idx_q', 'idx_t', 'idx_b']);
    expect(req.addedColumns).toHaveLength(3);

    const status = evaluateMigrationStatus(
      {
        id: '0001_init.sql',
        number: 1,
        filePath: '/tmp/0001_init.sql',
        sql,
        requirements: req,
      },
      {
        tables: new Set(['quoted_tbl', 'tick_tbl', 'bracket_tbl']),
        columnsByTable: new Map([
          ['quoted_tbl', new Set(['id', 'col_q'])],
          ['tick_tbl', new Set(['id', 'col_t'])],
          ['bracket_tbl', new Set(['id', 'col_b'])],
        ]),
        indexes: new Set(['idx_q', 'idx_t', 'idx_b']),
        trackedMigrations: new Set<string>(),
      }
    );
    expect(status.status).toBe('applied');
  });

  it('covers sync.ts validation errors and audit.ts missing config/kinship & place/death edge cases', async () => {
    const tmp = await makeTempDir();
    await expect(runSyncCommand({ repoDir: tmp, concurrency: 0 })).rejects.toThrow(CliValidationError);
    await expect(runSyncCommand({ repoDir: tmp, chunkSize: 0 })).rejects.toThrow(CliValidationError);
    await expect(runSyncCommand({ repoDir: tmp, summary: 'ab' })).rejects.toThrow(CliValidationError);
    await expect(runSyncCommand({ repoDir: tmp, types: ['person'] })).rejects.toThrow();

    // audit.ts without kinloom.config.yaml and without kinship.yaml, with zero-coord places (lon fallback, missing id, non-record) and conflicting death_edtf/death_date
    const auditRepo = await makeTempDir();
    await mkdir(path.join(auditRepo, 'data'), { recursive: true });
    await mkdir(path.join(auditRepo, 'research', 'people', 'per_clara'), { recursive: true });
    await writeFile(
      path.join(auditRepo, 'data', 'people.yaml'),
      [
        '- id: per_clara',
        '  slug: clara-alder',
        '  full_name: Clara Alder',
        '  given_name: Clara',
        '  surname: Alder',
        '  sex: F',
        '  birth_edtf: "1880"',
        '  death_edtf: "1950"',
        '  is_living: false',
        '  lineage_group: paternal',
        '- full_name: No Id Person',
      ].join('\n'),
      'utf8'
    );
    await writeFile(path.join(auditRepo, 'data', 'events.yaml'), '[]\n', 'utf8');
    await writeFile(path.join(auditRepo, 'data', 'places.yaml'), '[]\n', 'utf8');
    await writeFile(path.join(auditRepo, 'data', 'sources.yaml'), '[]\n', 'utf8');
    await writeFile(path.join(auditRepo, 'data', 'media.yaml'), '[]\n', 'utf8');
    await writeFile(path.join(auditRepo, 'data', 'narratives.yaml'), '[]\n', 'utf8');
    await writeFile(
      path.join(auditRepo, 'research', 'people', 'per_clara', 'patch.json'),
      JSON.stringify({
        person_id: 'per_clara',
        person_updates: { death_edtf: '1950', death_date: '1951' },
        places: ['bad-place', { lat: 0, lon: 0 }, { id: 'plc_good', lat: 44.3, lon: -68.9 }],
      }),
      'utf8'
    );
    await writeFile(
      path.join(auditRepo, 'research', 'people', 'per_clara', 'dossier.md'),
      'Clara Alder lived.\n',
      'utf8'
    );
    const auditRes = await runAuditCommand({ repoDir: auditRepo, personId: 'per_clara' });
    expect(auditRes.zeroCoordinatePlaces).toContain('unknown');
  });

  it('covers pronunciation deduplicateRules edge branches', () => {
    const lexicon = {
      Clara: { phonetic: 'KLAIR-ah' },
      Alder: { ipa: '/ˈɑldər/' },
    };
    const pAudioVar = makePerson({
      id: 'per_v1',
      full_name: 'Clara Alder',
      given_name: 'Clara',
      surname: 'Alder',
      pronunciation: {
        variants: [{ label: 'audioOnly', audio_url: 'https://example.test/a.ogg' }],
      },
    });
    expect(evaluatePersonOverrideRedundancy(pAudioVar, lexicon)?.kind).toBe('keep');

    const pNoteVar = makePerson({
      id: 'per_v2',
      full_name: 'Clara Alder',
      given_name: 'Clara',
      surname: 'Alder',
      pronunciation: {
        variants: [{ label: 'noteOnly', note: 'local stress' }],
      },
    });
    expect(evaluatePersonOverrideRedundancy(pNoteVar, lexicon)?.kind).toBe('keep');

    // Force removes differing phonetic/IPA when coverage is full
    const fullLex = {
      Clara: { phonetic: 'KLAIR-ah' },
      Alder: { phonetic: 'AWL-der', ipa: '/ˈɑldər/' },
    };
    const pDiff = makePerson({
      id: 'per_v3',
      full_name: 'Clara Alder',
      given_name: 'Clara',
      surname: 'Alder',
      pronunciation: { phonetic: 'KLAIR-uh AWL-der', ipa: '/ˈklɛrə ˈɔldər/' },
    });
    expect(evaluatePersonOverrideRedundancy(pDiff, fullLex, true)?.kind).toBe('removable');
    expect(evaluatePersonOverrideRedundancy(pDiff, fullLex, false)?.kind).toBe('keep');

    // Differing IPA when shared IPA is missing
    const pIpaDiff = makePerson({
      id: 'per_v4',
      full_name: 'Clara',
      given_name: 'Clara',
      surname: '',
      pronunciation: { phonetic: 'KLAIR-ah', ipa: '/ˈklɛrə/' },
    });
    const ipaDecision = evaluatePersonOverrideRedundancy(
      pIpaDiff,
      { Clara: { phonetic: 'KLAIR-ah' } },
      false
    );
    expect(ipaDecision?.kind).toBe('keep');

    // extractPromotableTokenFromPerson preserving source_url and region
    const promo = extractPromotableTokenFromPerson(
      makePerson({
        id: 'per_promo',
        full_name: 'Clara Birch',
        given_name: 'Clara',
        surname: 'Birch',
        pronunciation: {
          phonetic: 'KLAIR-ah BURCH',
          ipa: '/ˈklɛrə ˈbɜrtʃ/',
          source_url: 'https://example.test/birch',
          region: 'US',
        },
      }),
      { Clara: { phonetic: 'KLAIR-ah', ipa: '/ˈklɛrə/' } }
    );
    expect(promo?.entry.source_url).toBe('https://example.test/birch');
    expect(promo?.entry.region).toBe('US');
  });
});

describe('records Wave 2: prepScan/imageOps, nara/census1950, ocr/engines branch coverage', () => {
  it('covers prepScan/imageOps resolveOutputAlias, saveArchivalImage webp, mapChannelsToMode, extractBand, buildGridSvg', async () => {
    const tmp = await makeTempDir();
    const { ctx } = makeCapturedContext({ cwd: tmp });
    const outJpg = path.join(tmp, 'same.jpg');
    expect(resolveOutputAlias('crop', outJpg, outJpg, ctx)).toBe(outJpg);

    const pngPath = path.join(tmp, 'sample.png');
    await writeFile(pngPath, await createSyntheticPng(80, 60, { r: 210, g: 210, b: 210 }));
    const loaded = await loadRgbFromFile(pngPath);

    const webpSaved = await saveArchivalImage(loaded, path.join(tmp, 'out.webp'), 85);
    expect(webpSaved.bytes).toBeGreaterThan(0);

    const leftNoRot = await extractBand(loaded, 'left', 25, false);
    expect(leftNoRot.width).toBe(20);
    expect(leftNoRot.height).toBe(60);

    expect(mapChannelsToMode(1, 'srgb')).toBe('L');
    expect(mapChannelsToMode(3, 'b-w')).toBe('L');
    expect(mapChannelsToMode(2, 'srgb')).toBe('LA');
    expect(mapChannelsToMode(4, 'cmyk')).toBe('CMYK');
    expect(mapChannelsToMode(4, 'srgb')).toBe('RGBA');

    const gridBuf = buildGridSvg(60, 60, 120, 120, 20);
    expect(gridBuf.toString('utf8')).toContain('<svg');
  });

  it('covers nara/census1950 validation, port rejection, stale/corrupt cache, and fetch edge cases', async () => {
    const tmp = await makeTempDir();
    expect(() => validateCensus1950ImagePath('1950census/bad\0.jpg')).toThrow(CliValidationError);
    expect(() => validateCensus1950ImagePath('1950census\\bad.jpg')).toThrow(CliValidationError);
    expect(() =>
      parseCensus1950ImageSource(
        'https://1950census.archives.gov:8443/iiif/2/1950census/a.jpg/full/max/0/default.jpg'
      )
    ).toThrow(CliValidationError);
    expect(() => resolveCensus1950ImageOutput('bad\0.jpg', '1950census/a.jpg', tmp)).toThrow(
      CliValidationError
    );

    const iiifUrl = 'https://1950census.archives.gov/iiif/2/1950census/a.jpg/full/max/0/default.jpg';
    // census1950FetchJpeg: missing content-type, content-length 0 with identity, content-encoding gzip, non-Error throw
    const { ctx: c1 } = makeCapturedContext({
      fetchImpl: async () =>
        new Response(VALID_JPEG, {
          status: 200,
          headers: { 'content-length': '0', 'content-encoding': 'identity' },
        }),
    });
    expect((await census1950FetchJpeg(iiifUrl, c1, 5)).length).toBe(VALID_JPEG.length);

    const { ctx: c2 } = makeCapturedContext({
      fetchImpl: async () =>
        new Response(VALID_JPEG, {
          status: 200,
          headers: { 'content-length': '9999', 'content-encoding': 'gzip' },
        }),
    });
    expect((await census1950FetchJpeg(iiifUrl, c2, 5)).length).toBe(VALID_JPEG.length);

    const { ctx: c3 } = makeCapturedContext({
      fetchImpl: async () => {
        throw 'string-census-net-err';
      },
    });
    await expect(census1950FetchJpeg(iiifUrl, c3, 5)).rejects.toThrow('string-census-net-err');

    // storeCensus1950Image: corrupt cached file (non-JPEG magic) triggers refetch
    const cacheRoot = path.join(tmp, 'c50-cache');
    const rec1 = await storeCensus1950Image(
      '1950census/a.jpg',
      { outPath: tmp, width: null, refresh: false, ttlHours: 24, timeoutSec: 5, cacheRoot },
      c1
    );
    expect(rec1.cache_hit).toBe(false);
    // Overwrite cached file with non-JPEG bytes so readCachedCensus1950Image rejects it
    const cachedFiles = fs
      .readdirSync(path.join(cacheRoot, 'census1950-images'))
      .filter((f) => f.endsWith('.jpg'));
    if (cachedFiles[0]) {
      await writeFile(path.join(cacheRoot, 'census1950-images', cachedFiles[0]), Buffer.from('not-jpeg'));
    }
    const rec2 = await storeCensus1950Image(
      '1950census/a.jpg',
      { outPath: tmp, width: null, refresh: false, ttlHours: 24, timeoutSec: 5, cacheRoot },
      c1
    );
    expect(rec2.cache_hit).toBe(false);
  });

  it('covers ocr/engines runPrintedOcr, runCursiveGeminiOcr, and runCursiveCliOcr edge branches', async () => {
    const tmp = await makeTempDir();
    const imgPath = path.join(tmp, 'page.png');
    const pngBytes = await createSyntheticPng(80, 60, { r: 240, g: 240, b: 240 });
    await writeFile(imgPath, pngBytes);

    // runPrintedOcr: non-zero exit with stdout-only detail
    const { ctx: tessCtx } = makeCapturedContext({
      execFileImpl: async () => {
        throw { code: 1, stdout: 'stdout error message', stderr: '' };
      },
    });
    await expect(
      runPrintedOcr({
        imgPath,
        rawBytes: pngBytes,
        psm: 6,
        timeoutSeconds: 5,
        tsv: false,
        workDir: tmp,
        maxDim: 0,
        ctx: tessCtx,
      })
    ).rejects.toThrow('stdout error message');

    // runCursiveGeminiOcr: candidate is non-record, parts non-record
    const { ctx: gemBadCand } = makeCapturedContext({
      fetchImpl: async () => new Response(JSON.stringify({ candidates: ['bad'] }), { status: 200 }),
    });
    await expect(
      runCursiveGeminiOcr({
        imgPath,
        rawBytes: pngBytes,
        effort: 'low',
        timeoutSeconds: 5,
        apiKey: 'k',
        ctx: gemBadCand,
      })
    ).rejects.toThrow('empty transcription');

    const { ctx: gemMixedParts } = makeCapturedContext({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: ['bad', { text: 42 }, { text: 'Alder Ledger' }] } }],
          }),
          { status: 200 }
        ),
    });
    const gemOk = await runCursiveGeminiOcr({
      imgPath,
      rawBytes: pngBytes,
      effort: 'low',
      timeoutSeconds: 5,
      apiKey: 'k',
      ctx: gemMixedParts,
    });
    expect(gemOk.text).toBe('Alder Ledger');

    // runCursiveCliOcr: non-zero exit with stdout-only, non-record JSON payload, missing response/usage
    const { ctx: cliFailCtx } = makeCapturedContext({
      execFileImpl: async () => {
        throw { code: 2, stdout: 'cli stdout fail', stderr: '' };
      },
    });
    await expect(
      runCursiveCliOcr({
        imgPath,
        rawBytes: pngBytes,
        effort: 'low',
        timeoutSeconds: 5,
        cacheDir: tmp,
        cliName: 'vision',
        cliBin: 'vision',
        ctx: cliFailCtx,
      })
    ).rejects.toThrow('cli stdout fail');

    const { ctx: cliArrCtx } = makeCapturedContext({
      execFileImpl: async () => ({ stdout: Buffer.from('[]'), stderr: Buffer.alloc(0) }),
    });
    await expect(
      runCursiveCliOcr({
        imgPath,
        rawBytes: pngBytes,
        effort: 'low',
        timeoutSeconds: 5,
        cacheDir: tmp,
        cliName: 'vision',
        cliBin: 'vision',
        ctx: cliArrCtx,
      })
    ).rejects.toThrow('status=unknown');

    const { ctx: cliEmptyRespCtx } = makeCapturedContext({
      execFileImpl: async () => ({
        stdout: Buffer.from(JSON.stringify({ status: 'SUCCESS', response: 123 })),
        stderr: Buffer.alloc(0),
      }),
    });
    await expect(
      runCursiveCliOcr({
        imgPath,
        rawBytes: pngBytes,
        effort: 'low',
        timeoutSeconds: 5,
        cacheDir: tmp,
        cliName: 'vision',
        cliBin: 'vision',
        ctx: cliEmptyRespCtx,
      })
    ).rejects.toThrow('empty transcription');

    const { ctx: cliNoUsageCtx } = makeCapturedContext({
      execFileImpl: async () => ({
        stdout: Buffer.from(JSON.stringify({ status: 'SUCCESS', response: 'Cedar Note' })),
        stderr: Buffer.alloc(0),
      }),
    });
    const cliOk = await runCursiveCliOcr({
      imgPath,
      rawBytes: pngBytes,
      effort: 'low',
      timeoutSeconds: 5,
      cacheDir: tmp,
      cliName: 'vision',
      cliBin: 'vision',
      ctx: cliNoUsageCtx,
    });
    expect(cliOk.text).toBe('Cedar Note');
  });
});
