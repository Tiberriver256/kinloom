import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type KinloomSiteConfig,
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  type Place,
  parseKinloomConfigYaml,
  type RawEvent,
  type RawPerson,
  type SourceRecord,
  serializeEventsYaml,
  serializeKinloomConfigYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from '@kinloom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../cli.js';
import { CliValidationError, EXIT_OK, EXIT_USAGE } from '../../errors.js';
import {
  compileMatchRegex,
  formatCellValue,
  formatCompactTable,
  formatGenerationLabel,
  formatSchemaTextReport,
  getNestedFieldValue,
  inspectArchiveYamlSchema,
  isFieldMissing,
  matchesRecordRegex,
  type OpsIo,
  parseFieldsCsv,
  parseQueryTarget,
  type QueryEntitiesReport,
  type QuerySchemaReport,
  runQueryCommand,
} from './index.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function createCaptureIo(): { io: OpsIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

function makeConfig(): KinloomSiteConfig {
  return parseKinloomConfigYaml(
    serializeKinloomConfigYaml({
      schemaVersion: 1,
      site: {
        title: 'Cedar Valley Archive',
        familyName: 'Cedar',
        gedcomSourceName: 'CEDAR_ARCHIVE',
        footerCredit: 'Built with Kinloom',
      },
      theme: { accent: '#7A4612' },
      defaultBranchId: 'cedar',
      branches: [
        {
          id: 'cedar',
          label: 'Cedar Line',
          surnames: ['Cedar', 'Oak'],
          lineageGroups: ['ancestor', 'descendant', 'extended'],
          supportsDirectMode: true,
        },
      ],
      lineageSections: [],
      featuredKinshipPairs: [],
      migrationEras: [],
      mapDefaults: {
        centerLat: 42.9,
        centerLng: -85.8,
        zoom: 6,
        minSpanDeg: 1.0,
      },
      privacy: {
        livingCutoffYears: 101,
        referenceYear: 2026,
        privateModeShowsBirthYear: true,
        stripLivingPortraits: true,
        stripLivingResidenceSpans: true,
        markGedcomLivingConfidential: true,
      },
      pronunciations: {},
    })
  );
}

async function createRichFixtureRepo(options?: { omitConfig?: boolean }): Promise<string> {
  const repoDir = await makeTempDir('kinloom-query-fixture-');
  const dataDir = path.join(repoDir, 'data');
  await mkdir(dataDir, { recursive: true });

  if (!options?.omitConfig) {
    await writeFile(
      path.join(repoDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(makeConfig()),
      'utf8'
    );
  }

  const people: RawPerson[] = [
    {
      id: 'p_gen0',
      slug: 'henry-cedar',
      full_name: 'Henry Cedar',
      given_name: 'Henry',
      surname: 'Cedar',
      alt_names: ['Hank Cedar'],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1820-03-10',
      death_edtf: '1895-11-02',
      portrait_url: '/media/henry.jpg',
      pronunciation: {
        phonetic: 'HEN-ree SEE-der',
        ipa: '/ˈhɛnri ˈsiːdər/',
        source_label: 'Fixture',
      },
    },
    {
      id: 'p_gen0_spouse',
      slug: 'clara-oak',
      full_name: 'Clara Oak',
      given_name: 'Clara',
      surname: 'Oak',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1824',
      death_edtf: '1901',
      portrait_url: null,
    },
    {
      id: 'p_gen1',
      slug: 'samuel-cedar',
      full_name: 'Samuel Cedar',
      given_name: 'Samuel',
      surname: 'Cedar',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1850',
      death_edtf: '1922',
      portrait_url: null,
    },
    {
      id: 'p_gen1_spouse',
      slug: 'martha-pine',
      full_name: 'Martha Pine',
      given_name: 'Martha',
      surname: 'Pine',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1853',
      death_edtf: '1930',
      portrait_url: null,
    },
    {
      id: 'p_gen2',
      slug: 'eleanor-cedar',
      full_name: 'Eleanor Cedar',
      given_name: 'Eleanor',
      surname: 'Cedar',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'descendant',
      birth_edtf: '1880',
      death_edtf: '1965',
      portrait_url: null,
    },
    {
      id: 'p_gen3',
      slug: 'arthur-cedar',
      full_name: 'Arthur Cedar',
      given_name: 'Arthur',
      surname: 'Cedar',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'descendant',
      birth_edtf: '1905',
      death_edtf: '1988',
      portrait_url: null,
    },
    {
      id: 'p_gen4',
      slug: 'walter-cedar',
      full_name: 'Walter Cedar',
      given_name: 'Walter',
      surname: 'Cedar',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'descendant',
      birth_edtf: '1928',
      death_edtf: '2012',
      portrait_url: null,
    },
    {
      id: 'p_living_flag',
      slug: 'jordan-cedar',
      full_name: 'Jordan Cedar',
      given_name: 'Jordan',
      surname: 'Cedar',
      alt_names: [],
      sex: 'M',
      is_living: true,
      lineage_group: 'descendant',
      birth_edtf: '1985-06-15',
      death_edtf: '',
      portrait_url: null,
    },
    {
      id: 'p_living_inferred',
      slug: 'avery-cedar',
      full_name: 'Avery Cedar',
      given_name: 'Avery',
      surname: 'Cedar',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'descendant',
      birth_edtf: '1992',
      death_edtf: '',
      portrait_url: null,
    },
    {
      id: 'p_living_spouse',
      slug: 'taylor-birch',
      full_name: 'Taylor Birch',
      given_name: 'Taylor',
      surname: 'Birch',
      alt_names: [],
      sex: 'F',
      is_living: true,
      lineage_group: 'extended',
      birth_edtf: '1986',
      death_edtf: '',
      portrait_url: null,
    },
  ];

  const kinship: KinshipEdge[] = [
    { from: 'p_gen0', to: 'p_gen0_spouse', relation: 'spouse' },
    { from: 'p_gen0', to: 'p_gen1', relation: 'parent' },
    { from: 'p_gen0_spouse', to: 'p_gen1', relation: 'parent' },
    { from: 'p_gen1', to: 'p_gen1_spouse', relation: 'spouse' },
    { from: 'p_gen2', to: 'p_gen1', relation: 'child' },
    { from: 'p_gen2', to: 'p_gen3', relation: 'parent' },
    { from: 'p_gen3', to: 'p_gen4', relation: 'parent' },
    // Living descendant + living spouse attached to deceased p_gen4
    { from: 'p_gen4', to: 'p_living_flag', relation: 'parent' },
    { from: 'p_gen4', to: 'p_living_spouse', relation: 'spouse' },
    { from: 'p_living_flag', to: 'p_living_inferred', relation: 'spouse' },
    // Dangling edge to nonexistent person to test defensive filtering
    { from: 'p_gen0', to: 'p_missing_ghost', relation: 'spouse' },
    { from: 'p_gen0', to: 'p_missing_child', relation: 'parent' },
  ];

  const places: Place[] = [
    {
      id: 'pl_holland',
      slug: 'holland-mi',
      name: 'Holland',
      full_name: 'Holland, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: 'pl_ottawa',
      lat: 42.7875,
      lng: -86.1089,
      summary: 'Lakeshore town settled in 1847.',
    },
    {
      id: 'pl_ottawa',
      slug: 'ottawa-county-mi',
      name: 'Ottawa County',
      full_name: 'Ottawa County, Michigan, USA',
      place_type: 'county',
      parent_id: null,
      lat: 42.96,
      lng: -85.99,
      summary: null,
    },
    {
      id: 'pl_farm',
      slug: 'cedar-homestead',
      name: 'Cedar Homestead',
      full_name: 'Cedar Homestead, Zeeland, Michigan, USA',
      place_type: 'homestead',
      parent_id: 'pl_ottawa',
      lat: 42.81,
      lng: -86.02,
      summary: 'Original 1850 timber-frame homestead.',
    },
  ];

  const sources: SourceRecord[] = [
    {
      id: 'src_census_1880',
      citation: '1880 U.S. Federal Census, Ottawa County, Michigan',
      author: 'U.S. Census Bureau',
      source_type: 'census',
      repository: 'NARA',
      url: 'https://example.org/census-1880',
    },
    {
      id: 'src_obituary',
      citation: 'Holland Sentinel Obituary for Henry Cedar, Nov 1895',
      author: null,
      source_type: 'newspaper',
      repository: 'Local Library',
      url: null,
    },
    {
      id: 'src_living_doc',
      citation: 'Modern Vital Record for Jordan Cedar',
      author: 'State Registry',
      source_type: 'vital_record',
      repository: null,
      url: null,
    },
  ];

  const events: RawEvent[] = [
    {
      id: 'ev_birth_henry',
      title: 'Birth of Henry Cedar',
      scope: 'personal',
      event_kind: 'point_event',
      category: 'vital',
      edtf_date: '1820-03-10',
      place_id: 'pl_holland',
      summary: 'Born near the Holland lakeshore.',
      participants: [{ person_id: 'p_gen0', role: 'principal' }],
      sources: [{ source_id: 'src_census_1880', confidence: 'high' }],
      alternate_places: [
        { place_name: 'Cedar Homestead', place_id: 'pl_farm', source_id: 'src_census_1880', note: '' },
      ],
    },
    {
      id: 'ev_res_samuel',
      title: '1880 Census Residence in Ottawa County',
      scope: 'family',
      event_kind: 'residence_anchor',
      category: 'census',
      edtf_date: '1880',
      place_id: 'pl_ottawa',
      summary: 'Resided with family on the farm.',
      participants: [
        { person_id: 'p_gen0', role: 'head' },
        { person_id: 'p_gen1', role: 'son' },
      ],
      sources: [{ source_id: 'src_census_1880', confidence: 'high' }],
    },
    {
      id: 'ev_living_grad',
      title: 'Graduation of Jordan Cedar',
      scope: 'personal',
      event_kind: 'point_event',
      category: 'education',
      edtf_date: '2007-05',
      place_id: 'pl_holland',
      summary: 'Living person event.',
      participants: [{ person_id: 'p_living_flag', role: 'principal' }],
      sources: [{ source_id: 'src_living_doc', confidence: 'high' }],
    },
  ];

  const narratives: Narrative[] = [
    {
      id: 'nar_henry_bio',
      slug: 'henry-cedar-biography',
      kind: 'biography',
      subject_person_id: 'p_gen0',
      title: 'Biography of Henry Cedar',
      summary: 'Life of pioneer carpenter Henry Cedar.',
      date_edtf: '1820/1895',
      person_ids: ['p_gen0', 'p_gen1'],
      place_ids: ['pl_holland'],
      event_ids: ['ev_birth_henry'],
      source_ids: ['src_obituary'],
      body_md: 'Henry Cedar built barns across Ottawa County.',
    },
    {
      id: 'nar_living_note',
      slug: 'jordan-notes',
      kind: 'research_note',
      subject_person_id: 'p_living_flag',
      title: 'Private Note for Jordan Cedar',
      summary: 'Should be hidden by privacy fence.',
      person_ids: ['p_living_flag'],
      place_ids: [],
      event_ids: [],
      source_ids: ['src_living_doc'],
      body_md: 'Private living research note.',
    },
    {
      id: 'nar_family_story',
      slug: 'cedar-mill-story',
      kind: 'family_story',
      title: 'The Cedar Sawmill Story',
      person_ids: ['p_gen1'],
      place_ids: ['pl_farm'],
      event_ids: [],
      source_ids: [],
      body_md: 'Samuel operated the sawmill near Zeeland.',
    },
  ];

  const media: MediaItem[] = [
    {
      id: 'med_henry_portrait',
      kind: 'portrait',
      source_id: 'src_obituary',
      person_id: 'p_gen0',
      file: 'media/henry.jpg',
      caption:
        'Studio portrait of Henry Cedar taken in Holland, Michigan around 1885 with a very long archival caption exceeding seventy two characters.',
      date_edtf: '1885',
    },
    {
      id: 'med_family_group',
      kind: 'family_photo',
      person_ids: ['p_gen1', 'p_gen2'],
      file: 'media/group.jpg',
      caption: 'Samuel and Eleanor at the homestead.',
    },
    {
      id: 'med_living_photo',
      kind: 'portrait',
      person_id: 'p_living_flag',
      file: 'media/jordan.jpg',
      caption: 'Living person portrait.',
    },
  ];

  await Promise.all([
    writeFile(path.join(dataDir, 'people.yaml'), serializePeopleYaml(people), 'utf8'),
    writeFile(path.join(dataDir, 'kinship.yaml'), serializeKinshipYaml(kinship), 'utf8'),
    writeFile(path.join(dataDir, 'places.yaml'), serializePlacesYaml(places), 'utf8'),
    writeFile(path.join(dataDir, 'sources.yaml'), serializeSourcesYaml(sources), 'utf8'),
    writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml(events), 'utf8'),
    writeFile(path.join(dataDir, 'narratives.yaml'), serializeNarrativesYaml(narratives), 'utf8'),
    writeFile(path.join(dataDir, 'media.yaml'), serializeMediaYaml(media), 'utf8'),
  ]);

  return repoDir;
}

describe('kinloom query helpers & schema inspection', () => {
  it('validates targets, regex patterns, fields CSV, nested values, missing checks, and cell formatting', () => {
    expect(parseQueryTarget('PEOPLE')).toBe('people');
    expect(() => parseQueryTarget(undefined)).toThrow(CliValidationError);
    expect(() => parseQueryTarget('unknown_table')).toThrow(CliValidationError);

    expect(compileMatchRegex('cedar').test('Henry Cedar')).toBe(true);
    expect(() => compileMatchRegex('   ')).toThrow(CliValidationError);
    expect(() => compileMatchRegex('[unclosed')).toThrow(CliValidationError);

    expect(parseFieldsCsv(undefined)).toBeUndefined();
    expect(parseFieldsCsv('id, full_name, id, birth_edtf')).toEqual(['id', 'full_name', 'birth_edtf']);
    expect(() => parseFieldsCsv(' , , ')).toThrow(CliValidationError);

    const sample = {
      id: 'p1',
      nested: { ipa: '/test/', emptyObj: {}, emptyArr: [], blank: '   ' },
      num: 42,
      flag: true,
      tags: ['alpha', { k: 1 }],
    };
    expect(getNestedFieldValue(sample, 'nested.ipa')).toBe('/test/');
    expect(getNestedFieldValue(sample, '')).toBeUndefined();
    expect(getNestedFieldValue(sample, 'nested.missing')).toBeUndefined();
    expect(getNestedFieldValue(null, 'id')).toBeUndefined();

    expect(isFieldMissing(sample, 'nested.ipa')).toBe(false);
    expect(isFieldMissing(sample, 'nested.emptyObj')).toBe(true);
    expect(isFieldMissing(sample, 'nested.emptyArr')).toBe(true);
    expect(isFieldMissing(sample, 'nested.blank')).toBe(true);
    expect(isFieldMissing(sample, 'nonexistent')).toBe(true);
    expect(isFieldMissing(sample, 'num')).toBe(false);

    expect(matchesRecordRegex(sample, /42/i)).toBe(true);
    expect(matchesRecordRegex(sample, /true/i)).toBe(true);
    expect(matchesRecordRegex(sample, /alpha/i)).toBe(true);
    expect(matchesRecordRegex(sample, /not-there/i)).toBe(false);
    expect(matchesRecordRegex(null, /anything/i)).toBe(false);

    expect(formatCellValue(null)).toBe('-');
    expect(formatCellValue('   ')).toBe('-');
    expect(formatCellValue([])).toBe('-');
    expect(formatCellValue(123)).toBe('123');
    expect(formatCellValue(false)).toBe('false');
    expect(formatCellValue(['a', { x: 1 }])).toBe('a, {"x":1}');
    expect(formatCellValue({ x: 1 })).toBe('{"x":1}');
    expect(formatCellValue('x'.repeat(90)).endsWith('...')).toBe(true);

    expect(formatCompactTable(['id'], [])).toBe('  (none)');
    expect(formatGenerationLabel('descendants', 0)).toBe('Generation 0 (root)');
    expect(formatGenerationLabel('descendants', 1)).toBe('Generation 1 (children)');
    expect(formatGenerationLabel('descendants', 2)).toBe('Generation 2 (grandchildren)');
    expect(formatGenerationLabel('descendants', 3)).toBe('Generation 3 (great-grandchildren)');
    expect(formatGenerationLabel('descendants', 4)).toBe('Generation 4 (2x great-grandchildren)');
    expect(formatGenerationLabel('ancestors', 1)).toBe('Generation 1 (parents)');
    expect(formatGenerationLabel('ancestors', 2)).toBe('Generation 2 (grandparents)');
    expect(formatGenerationLabel('ancestors', 3)).toBe('Generation 3 (great-grandparents)');
    expect(formatGenerationLabel('ancestors', 4)).toBe('Generation 4 (2x great-grandparents)');
  });

  it('handles empty, object, and scalar YAML files in schema inspection', () => {
    const emptyReport = inspectArchiveYamlSchema('/tmp/empty', []);
    expect(emptyReport.totalFiles).toBe(0);
    expect(formatSchemaTextReport(emptyReport)).toContain('(no YAML files found under data/)');

    const mixedReport = inspectArchiveYamlSchema('/tmp/mixed', [
      { name: 'data/empty.yaml', content: '' },
      { name: 'data/meta.yaml', content: 'version: 1\nauthor: test\n' },
      { name: 'data/scalar.yaml', content: 'hello\n' },
      { name: 'data/list.yaml', content: '- id: a\n  tag: x\n- id: b\n' },
    ]);
    expect(mixedReport.totalFiles).toBe(4);
    expect(mixedReport.totalRecords).toBe(4);
    const listFile = mixedReport.files.find((f) => f.file === 'data/list.yaml');
    expect(listFile?.keys).toEqual([
      { key: 'id', count: 2, pct: 100 },
      { key: 'tag', count: 1, pct: 50 },
    ]);
    const text = formatSchemaTextReport(mixedReport);
    expect(text).toContain('data/empty.yaml (0 records):');
    expect(text).toContain('(no keys)');
    expect(text).toContain('data/meta.yaml (1 record):');
  });
});

describe('kinloom query people & living privacy defaults', () => {
  it('defaults strictly to confirmed-deceased people and excludes explicit + inferred living records', async () => {
    const repoDir = await createRichFixtureRepo();
    const result = (await runQueryCommand({
      target: 'people',
      repoDir,
      json: true,
    })) as QueryEntitiesReport & { rendered: string };

    expect(result.ok).toBe(true);
    expect(result.privacy).toEqual({ includeLiving: false, excludedLivingCount: 3 });
    expect(result.count).toBe(7);
    const ids = result.items.map((item) => (item as RawPerson).id);
    expect(ids).not.toContain('p_living_flag');
    expect(ids).not.toContain('p_living_inferred');
    expect(ids).not.toContain('p_living_spouse');
    expect(result.rendered).not.toContain('Jordan Cedar');
    expect(result.rendered).not.toContain('Avery Cedar');
    expect(result.rendered).not.toContain('Taylor Birch');
  });

  it('rejects --living without --include-living and allows living queries with --include-living', async () => {
    const repoDir = await createRichFixtureRepo();

    await expect(runQueryCommand({ target: 'people', repoDir, living: true })).rejects.toThrow(
      /Privacy fence: `--living` requires explicit `--include-living`/
    );

    const livingOnly = (await runQueryCommand({
      target: 'people',
      repoDir,
      living: true,
      includeLiving: true,
    })) as QueryEntitiesReport & { rendered: string };
    expect(livingOnly.count).toBe(3);
    expect(livingOnly.items.map((p) => (p as RawPerson).id)).toEqual([
      'p_living_flag',
      'p_living_inferred',
      'p_living_spouse',
    ]);
    expect(livingOnly.rendered).toContain('is_living');
    expect(livingOnly.rendered).toContain('Jordan Cedar');

    const allPeople = (await runQueryCommand({
      target: 'people',
      repoDir,
      includeLiving: true,
    })) as QueryEntitiesReport & { rendered: string };
    expect(allPeople.count).toBe(10);

    const deceasedExplicit = (await runQueryCommand({
      target: 'people',
      repoDir,
      deceased: true,
      includeLiving: true,
    })) as QueryEntitiesReport & { rendered: string };
    expect(deceasedExplicit.count).toBe(7);
  });

  it('filters people with --match, --missing, and --fields projection', async () => {
    const repoDir = await createRichFixtureRepo();
    const res = (await runQueryCommand({
      target: 'people',
      repoDir,
      match: 'cedar',
      missing: 'pronunciation.ipa',
      fields: ['id', 'full_name', 'death_edtf'],
    })) as QueryEntitiesReport & { rendered: string };

    expect(res.count).toBe(4);
    expect(res.items.map((row) => (row as Record<string, unknown>)['id'])).toEqual([
      'p_gen1',
      'p_gen2',
      'p_gen3',
      'p_gen4',
    ]);
    expect(res.rendered).toContain('Privacy fence: 3 living records excluded');
    expect(res.rendered).toContain('Samuel Cedar');
    expect(res.rendered).not.toContain('Henry Cedar');
  });
});

describe('kinloom query bounded BFS kinship traversal', () => {
  it('traverses descendants with depth limit, generation grouping, spouse pairing, and living fence', async () => {
    const repoDir = await createRichFixtureRepo();

    const depth1 = (await runQueryCommand({
      target: 'people',
      repoDir,
      descendantsOf: 'p_gen0',
      depth: 1,
    })) as QueryEntitiesReport & { rendered: string };

    expect(depth1.traversal?.direction).toBe('descendants');
    expect(depth1.traversal?.rootId).toBe('p_gen0');
    expect(depth1.traversal?.maxDepth).toBe(1);
    expect(depth1.traversal?.truncatedByDepth).toBe(true);
    expect(depth1.traversal?.generations.map((g) => g.generation)).toEqual([0, 1]);
    expect(depth1.traversal?.generations[0]?.entries[0]?.spouses.map((s) => s.id)).toEqual(['p_gen0_spouse']);
    expect(depth1.traversal?.generations[1]?.entries[0]?.spouses.map((s) => s.id)).toEqual(['p_gen1_spouse']);
    expect(depth1.rendered).toContain('(depth limit reached)');
    expect(depth1.rendered).toContain('m. Clara Oak (p_gen0_spouse)');
    expect(depth1.rendered).toContain('m. Martha Pine (p_gen1_spouse)');

    // Full depth without --include-living excludes living child & living spouse of p_gen4
    const fullPrivate = (await runQueryCommand({
      target: 'people',
      repoDir,
      descendantsOf: 'p_gen0',
      depth: 6,
    })) as QueryEntitiesReport & { rendered: string };

    expect(fullPrivate.traversal?.truncatedByDepth).toBe(false);
    expect(fullPrivate.count).toBe(5);
    expect(fullPrivate.privacy.excludedLivingCount).toBe(2);
    expect(fullPrivate.rendered).toContain('Privacy fence: 2 living records excluded');
    expect(fullPrivate.rendered).not.toContain('Jordan Cedar');
    expect(fullPrivate.rendered).not.toContain('Taylor Birch');

    // Full depth WITH --include-living includes living child and living spouse
    const fullWithLiving = (await runQueryCommand({
      target: 'people',
      repoDir,
      descendantsOf: 'p_gen0',
      depth: 6,
      includeLiving: true,
      living: true,
      fields: ['id', 'full_name', 'generation'],
      json: true,
    })) as QueryEntitiesReport & { rendered: string };

    expect(fullWithLiving.count).toBe(1);
    expect(fullWithLiving.items[0]).toEqual({
      id: 'p_living_flag',
      full_name: 'Jordan Cedar',
      generation: 5,
    });
  });

  it('traverses ancestors upward and enforces living fence on living root', async () => {
    const repoDir = await createRichFixtureRepo();

    await expect(
      runQueryCommand({ target: 'people', repoDir, ancestorsOf: 'p_living_flag', depth: 2 })
    ).rejects.toThrow(/Privacy fence: person 'p_living_flag' is living/);

    await expect(
      runQueryCommand({ target: 'people', repoDir, ancestorsOf: 'p_nonexistent', depth: 2 })
    ).rejects.toThrow(/Person 'p_nonexistent' not found/);

    const ancestors = (await runQueryCommand({
      target: 'people',
      repoDir,
      ancestorsOf: 'p_gen4',
      depth: 4,
      json: true,
    })) as QueryEntitiesReport & { rendered: string };

    expect(ancestors.traversal?.direction).toBe('ancestors');
    expect(ancestors.traversal?.truncatedByDepth).toBe(false);
    expect(ancestors.traversal?.generations.map((g) => g.generation)).toEqual([0, 1, 2, 3, 4]);
    expect(ancestors.traversal?.generations[4]?.entries.map((e) => e.person.id)).toEqual([
      'p_gen0',
      'p_gen0_spouse',
    ]);

    // Filter traversal with --match that matches nothing -> empty generations text branch
    const emptyTrav = (await runQueryCommand({
      target: 'people',
      repoDir,
      ancestorsOf: 'p_gen4',
      depth: 2,
      match: 'zzz_no_match',
    })) as QueryEntitiesReport & { rendered: string };
    expect(emptyTrav.count).toBe(0);
    expect(emptyTrav.rendered).toContain('(none)');

    // Traversal with --deceased and --missing
    const missingDeathTrav = (await runQueryCommand({
      target: 'people',
      repoDir,
      ancestorsOf: 'p_living_flag',
      depth: 1,
      includeLiving: true,
      deceased: true,
      missing: 'portrait_url',
    })) as QueryEntitiesReport & { rendered: string };
    expect(missingDeathTrav.count).toBe(1);
    expect((missingDeathTrav.items[0] as Record<string, unknown>)['id']).toBe('p_gen4');
  });
});

describe('kinloom query places, events, narratives, sources, media, and schema', () => {
  it('queries places, events, narratives, sources, and media with --kind, --person, --match, --missing, and privacy fence', async () => {
    const repoDir = await createRichFixtureRepo();

    // Places: --kind + --missing + --person (including alternate_places!)
    const missingPlaceSummary = (await runQueryCommand({
      target: 'places',
      repoDir,
      kind: 'county',
      missing: 'summary',
    })) as QueryEntitiesReport & { rendered: string };
    expect(missingPlaceSummary.count).toBe(1);
    expect((missingPlaceSummary.items[0] as Place).id).toBe('pl_ottawa');

    const henryPlaces = (await runQueryCommand({
      target: 'places',
      repoDir,
      person: 'p_gen0',
      json: true,
    })) as QueryEntitiesReport;
    expect(henryPlaces.items.map((p) => (p as Place).id)).toEqual(['pl_farm', 'pl_holland', 'pl_ottawa']);

    // Events: excludes living event by default; matches event_kind, scope, or category
    const allPublicEvents = (await runQueryCommand({
      target: 'events',
      repoDir,
    })) as QueryEntitiesReport & { rendered: string };
    expect(allPublicEvents.count).toBe(2);
    expect(allPublicEvents.privacy.excludedLivingCount).toBe(1);
    expect(allPublicEvents.rendered).toContain('Privacy fence: 1 living record excluded');

    const censusEvents = (await runQueryCommand({
      target: 'events',
      repoDir,
      kind: 'residence_anchor',
      person: 'p_gen1',
    })) as QueryEntitiesReport;
    expect(censusEvents.count).toBe(1);
    expect((censusEvents.items[0] as RawEvent).id).toBe('ev_res_samuel');

    const vitalCategoryEvents = (await runQueryCommand({
      target: 'events',
      repoDir,
      kind: 'vital',
    })) as QueryEntitiesReport;
    expect(vitalCategoryEvents.count).toBe(1);
    expect((vitalCategoryEvents.items[0] as RawEvent).id).toBe('ev_birth_henry');

    // Living person filter blocked without --include-living, allowed with --include-living
    await expect(runQueryCommand({ target: 'events', repoDir, person: 'p_living_flag' })).rejects.toThrow(
      /Privacy fence: person 'p_living_flag' is living/
    );

    const livingEvents = (await runQueryCommand({
      target: 'events',
      repoDir,
      person: 'p_living_flag',
      includeLiving: true,
    })) as QueryEntitiesReport;
    expect(livingEvents.count).toBe(1);
    expect((livingEvents.items[0] as RawEvent).id).toBe('ev_living_grad');

    // Narratives: excludes living narrative by default; filters by kind and person
    const publicNarratives = (await runQueryCommand({
      target: 'narratives',
      repoDir,
    })) as QueryEntitiesReport;
    expect(publicNarratives.count).toBe(2);
    expect(publicNarratives.privacy.excludedLivingCount).toBe(1);

    const bioNarratives = (await runQueryCommand({
      target: 'narratives',
      repoDir,
      kind: 'biography',
      person: 'p_gen0',
      match: 'barns',
    })) as QueryEntitiesReport;
    expect(bioNarratives.count).toBe(1);
    expect((bioNarratives.items[0] as Narrative).id).toBe('nar_henry_bio');

    // Sources: filters by kind and person (collects from events, narratives, and media)
    const henrySources = (await runQueryCommand({
      target: 'sources',
      repoDir,
      person: 'p_gen0',
    })) as QueryEntitiesReport;
    expect(henrySources.items.map((s) => (s as SourceRecord).id)).toEqual([
      'src_census_1880',
      'src_obituary',
    ]);

    const newspaperSources = (await runQueryCommand({
      target: 'sources',
      repoDir,
      kind: 'newspaper',
      missing: 'url',
    })) as QueryEntitiesReport;
    expect(newspaperSources.count).toBe(1);
    expect((newspaperSources.items[0] as SourceRecord).id).toBe('src_obituary');

    // Media: excludes living media by default; filters by kind and person (person_id & person_ids)
    const publicMedia = (await runQueryCommand({
      target: 'media',
      repoDir,
    })) as QueryEntitiesReport & { rendered: string };
    expect(publicMedia.count).toBe(2);
    expect(publicMedia.privacy.excludedLivingCount).toBe(1);
    expect(publicMedia.rendered).toContain('...');

    const groupMedia = (await runQueryCommand({
      target: 'media',
      repoDir,
      kind: 'family_photo',
      person: 'p_gen2',
    })) as QueryEntitiesReport;
    expect(groupMedia.count).toBe(1);
    expect((groupMedia.items[0] as MediaItem).id).toBe('med_family_group');
  });

  it('inspects archive YAML schema counts and key frequencies (including repos without kinloom.config.yaml)', async () => {
    const repoDir = await createRichFixtureRepo({ omitConfig: true });
    const schema = (await runQueryCommand({
      target: 'schema',
      repoDir,
      json: true,
    })) as QuerySchemaReport & { rendered: string };

    expect(schema.ok).toBe(true);
    expect(schema.target).toBe('schema');
    expect(schema.totalFiles).toBe(7);
    const peopleFile = schema.files.find((f) => f.file === 'data/people.yaml');
    expect(peopleFile?.recordCount).toBe(10);
    expect(peopleFile?.keys.find((k) => k.key === 'full_name')).toEqual({
      key: 'full_name',
      count: 10,
      pct: 100,
    });
    expect(peopleFile?.keys.find((k) => k.key === 'pronunciation')).toEqual({
      key: 'pronunciation',
      count: 1,
      pct: 10,
    });

    const textSchema = (await runQueryCommand({
      target: 'schema',
      repoDir,
    })) as QuerySchemaReport & { rendered: string };
    expect(textSchema.rendered).toContain('data/people.yaml (10 records):');
    expect(textSchema.rendered).toContain('100.0%');
  });

  it('rejects invalid option combinations cleanly', async () => {
    const repoDir = await createRichFixtureRepo();

    await expect(
      runQueryCommand({ target: 'people', repoDir, descendantsOf: 'p_gen0', ancestorsOf: 'p_gen1' })
    ).rejects.toThrow(/Cannot combine `--descendants-of` and `--ancestors-of`/);

    await expect(
      runQueryCommand({ target: 'people', repoDir, deceased: true, living: true, includeLiving: true })
    ).rejects.toThrow(/Cannot combine `--deceased` and `--living`/);

    await expect(
      runQueryCommand({ target: 'people', repoDir, depth: -1, descendantsOf: 'p_gen0' })
    ).rejects.toThrow(/Option `--depth` must be a non-negative integer/);

    await expect(runQueryCommand({ target: 'people', repoDir, depth: 2 })).rejects.toThrow(
      /Option `--depth` can only be used with/
    );

    await expect(runQueryCommand({ target: 'places', repoDir, deceased: true })).rejects.toThrow(
      /only supported for `kinloom query people`/
    );

    await expect(runQueryCommand({ target: 'schema', repoDir, match: 'foo' })).rejects.toThrow(
      /`kinloom query schema` only accepts `--repo` and `--json`/
    );

    await expect(runQueryCommand({ target: 'people', repoDir, kind: 'biography' })).rejects.toThrow(
      /Options `--kind` and `--person` are not supported for `kinloom query people`/
    );

    await expect(runQueryCommand({ target: 'events', repoDir, person: 'p_does_not_exist' })).rejects.toThrow(
      /Person 'p_does_not_exist' not found/
    );
  });
});

describe('kinloom query CLI dispatch via runCli', () => {
  it('supports help, people, traversal, schema, and returns exit code 2 on invalid CLI arguments', async () => {
    const repoDir = await createRichFixtureRepo();

    const helpCap = createCaptureIo();
    expect(await runCli(['query', '--help'], { io: helpCap.io })).toBe(EXIT_OK);
    expect(helpCap.stdout.join('\n')).toContain('Usage: kinloom query <target> [options]');

    const peopleCap = createCaptureIo();
    expect(
      await runCli(['query', 'people', '--repo', repoDir, '--fields', 'id,full_name', '--json'], {
        io: peopleCap.io,
      })
    ).toBe(EXIT_OK);
    const parsedPeople = JSON.parse(peopleCap.stdout.join('\n')) as QueryEntitiesReport;
    expect(parsedPeople.count).toBe(7);

    const travCap = createCaptureIo();
    expect(
      await runCli(['query', 'people', '--descendants-of', 'p_gen0', '--depth', '0', '--repo', repoDir], {
        io: travCap.io,
      })
    ).toBe(EXIT_OK);
    expect(travCap.stdout.join('\n')).toContain('Generation 0 (root) (1):');

    const schemaCap = createCaptureIo();
    expect(await runCli(['query', 'schema', '--repo', repoDir], { io: schemaCap.io })).toBe(EXIT_OK);
    expect(schemaCap.stdout.join('\n')).toContain('Files: 7');

    const badDepthCap = createCaptureIo();
    expect(
      await runCli(['query', 'people', '--descendants-of', 'p_gen0', '--depth', '-2', '--repo', repoDir], {
        io: badDepthCap.io,
      })
    ).toBe(EXIT_USAGE);
    expect(badDepthCap.stderr.join('\n')).toContain('non-negative integer');

    const missingTargetCap = createCaptureIo();
    expect(await runCli(['query'], { io: missingTargetCap.io })).toBe(EXIT_USAGE);
    expect(missingTargetCap.stderr.join('\n')).toContain('Missing query target');
  });
});
