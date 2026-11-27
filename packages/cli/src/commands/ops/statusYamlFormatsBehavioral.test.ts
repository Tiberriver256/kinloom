import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  KinloomSiteConfigSchema,
  type RawEvent,
  type RawPerson,
  type ResidenceSpan,
  type SourceRecord,
  serializeEventsYaml,
  serializeKinloomConfigYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { runStatusCommand } from './status.js';

function makeSiteConfigYaml(): string {
  return serializeKinloomConfigYaml(
    KinloomSiteConfigSchema.parse({
      site: {
        title: 'Alder Family Archive',
        familyName: 'Alder',
        gedcomSourceName: 'ALDER_GEDCOM',
      },
      privacy: { referenceYear: 2026 },
    })
  );
}

const SAMPLE_PEOPLE: RawPerson[] = [
  {
    id: 'per_arthur_alder',
    slug: 'arthur-alder-1860',
    full_name: 'Arthur Alder',
    given_name: 'Arthur',
    surname: 'Alder',
    alt_names: [],
    sex: 'M',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: '1860',
    death_edtf: '1932',
    portrait_url: null,
  },
  {
    id: 'per_clara_mercer',
    slug: 'clara-mercer-1864',
    full_name: 'Clara Mercer',
    given_name: 'Clara',
    surname: 'Mercer',
    alt_names: [],
    sex: 'F',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: '1864',
    death_edtf: '1940',
    portrait_url: null,
  },
];

const SAMPLE_SOURCES: SourceRecord[] = [
  {
    id: 'src_1880_census',
    citation: '1880 Federal Census',
    source_type: 'census',
  },
  {
    id: 'src_1900_deed',
    citation: '1900 County Deed Book',
    source_type: 'land_record',
  },
];

const SAMPLE_EVENTS: RawEvent[] = [
  {
    id: 'evt_1880_household',
    title: 'Household Enumeration',
    scope: 'family',
    event_kind: 'residence_anchor',
    edtf_date: '1880',
    place_id: null,
    summary: 'Arthur and Clara enumerated together.',
    participants: [
      { person_id: 'per_arthur_alder', role: 'head' },
      { person_id: 'per_arthur_alder', role: 'witness' },
      { person_id: 'per_clara_mercer', role: 'spouse' },
    ],
    sources: [
      { source_id: 'src_1880_census', confidence: 'high' },
      { source_id: 'src_1900_deed', confidence: 'medium' },
    ],
  },
  {
    id: 'evt_1895_town',
    title: 'Town Hall Dedication',
    scope: 'local',
    event_kind: 'point_event',
    edtf_date: '1895',
    place_id: null,
    summary: 'Community event with no individual participants.',
    participants: [],
    sources: [],
  },
  {
    id: 'evt_1910_solo',
    title: 'Land Patent Recorded',
    scope: 'personal',
    event_kind: 'point_event',
    edtf_date: '1910',
    place_id: null,
    summary: 'Solo deed entry.',
    participants: [{ person_id: 'per_arthur_alder', role: 'grantee' }],
    sources: [{ source_id: 'src_1900_deed', confidence: 'high' }],
  },
];

describe('runStatusCommand YAML formatting invariance', () => {
  it('produces identical status counts across canonical, multi-line indent, quoted/escaped, comment, and flow YAML representations', async () => {
    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kinloom-status-parity-'));
    try {
      const canonicalDir = path.join(tmpRoot, 'canonical');
      await mkdir(path.join(canonicalDir, 'data'), { recursive: true });
      await writeFile(path.join(canonicalDir, 'kinloom.config.yaml'), makeSiteConfigYaml(), 'utf8');
      await writeFile(
        path.join(canonicalDir, 'data', 'people.yaml'),
        serializePeopleYaml(SAMPLE_PEOPLE),
        'utf8'
      );
      await writeFile(
        path.join(canonicalDir, 'data', 'events.yaml'),
        serializeEventsYaml(SAMPLE_EVENTS),
        'utf8'
      );
      await writeFile(path.join(canonicalDir, 'data', 'places.yaml'), serializePlacesYaml([]), 'utf8');
      await writeFile(
        path.join(canonicalDir, 'data', 'sources.yaml'),
        serializeSourcesYaml(SAMPLE_SOURCES),
        'utf8'
      );
      await writeFile(
        path.join(canonicalDir, 'data', 'media.yaml'),
        serializeMediaYaml([
          {
            id: 'med_1',
            kind: 'portrait',
            person_id: 'per_arthur_alder',
            file: 'media/arthur.jpg',
            caption: 'Arthur Alder',
          },
        ]),
        'utf8'
      );
      await writeFile(
        path.join(canonicalDir, 'data', 'narratives.yaml'),
        serializeNarrativesYaml([]),
        'utf8'
      );

      const baseline = await runStatusCommand({ repoDir: canonicalDir, sort: 'sparsest' });

      const variantADir = path.join(tmpRoot, 'variant-a');
      await mkdir(path.join(variantADir, 'data'), { recursive: true });
      await writeFile(path.join(variantADir, 'kinloom.config.yaml'), makeSiteConfigYaml(), 'utf8');
      await writeFile(
        path.join(variantADir, 'data', 'people.yaml'),
        serializePeopleYaml(SAMPLE_PEOPLE),
        'utf8'
      );
      await writeFile(path.join(variantADir, 'data', 'places.yaml'), '[]\n', 'utf8');
      await writeFile(
        path.join(variantADir, 'data', 'media.yaml'),
        serializeMediaYaml([
          {
            id: 'med_1',
            kind: 'portrait',
            person_id: 'per_arthur_alder',
            file: 'media/arthur.jpg',
            caption: 'Arthur Alder',
          },
        ]),
        'utf8'
      );
      await writeFile(path.join(variantADir, 'data', 'narratives.yaml'), '[]\n', 'utf8');
      await writeFile(
        path.join(variantADir, 'data', 'sources.yaml'),
        [
          '\uFEFF# Comment header',
          '- id: "src_1880_census"',
          '  citation: "1880 Federal Census"',
          '  source_type: census',
          '- id: "src_1900\\u005fdeed"',
          '  citation: "1900 County Deed Book"',
          '  source_type: land_record',
        ].join('\r\n'),
        'utf8'
      );
      await writeFile(
        path.join(variantADir, 'data', 'events.yaml'),
        [
          '\uFEFF# Events with indent-2 id and indent-6 participant/source keys',
          '- title: Household Enumeration',
          '  id: "evt_1880\\u005fhousehold"',
          '  scope: family',
          '  event_kind: residence_anchor',
          '  edtf_date: "1880"',
          '  place_id: null',
          '  summary: Arthur and Clara enumerated together.',
          '  participants:',
          '    - role: head',
          '      person_id: "per_arthur_alder"',
          '    - role: witness',
          '      person_id: per_arthur_alder',
          '    - role: spouse',
          '      person_id: per_clara_mercer',
          '  sources:',
          '    - confidence: high',
          '      source_id: "src_1880_census"',
          '    - confidence: medium',
          '      source_id: src_1900_deed',
          '- id: evt_1895_town',
          '  title: Town Hall Dedication',
          '  scope: local',
          '  event_kind: point_event',
          '  edtf_date: "1895"',
          '  place_id: null',
          '  summary: Community event with no individual participants.',
          '  participants: []',
          '  sources: []',
          '- id: evt_1910_solo',
          '  title: Land Patent Recorded',
          '  scope: personal',
          '  event_kind: point_event',
          '  edtf_date: "1910"',
          '  place_id: null',
          '  summary: Solo deed entry.',
          '  participants:',
          '    - person_id: per_arthur_alder',
          '      role: grantee',
          '  sources:',
          '    - source_id: src_1900_deed',
          '      confidence: high',
        ].join('\r\n'),
        'utf8'
      );

      const resA = await runStatusCommand({ repoDir: variantADir, sort: 'sparsest' });
      expect(resA.events).toBe(baseline.events);
      expect(resA.sources).toBe(baseline.sources);
      expect(resA.deceased).toEqual(baseline.deceased);

      const variantBForms: Array<{ eventsYaml: string; sourcesYaml: string }> = [
        {
          eventsYaml: [
            "- id: 'evt_1880_household'",
            '  title: Household Enumeration',
            '  scope: family',
            '  event_kind: residence_anchor',
            '  edtf_date: "1880"',
            '  place_id: null',
            '  summary: |',
            '    Arthur and Clara enumerated together.',
            '  participants: [{ person_id: per_arthur_alder, role: head }, { person_id: per_arthur_alder, role: witness }, { person_id: per_clara_mercer, role: spouse }]',
            '  sources: [{ source_id: src_1880_census, confidence: high }, { source_id: src_1900_deed, confidence: medium }]',
            '- id: evt_1895_town # inline comment',
            '  title: Town Hall Dedication',
            '  scope: local',
            '  event_kind: point_event',
            '  participants: []',
            '  sources: []',
            '- id: evt_1910_solo',
            '  title: Land Patent Recorded',
            '  scope: personal',
            '  event_kind: point_event',
            '  participants:',
            '    - { person_id: per_arthur_alder, role: grantee }',
            '  sources:',
            '    - { source_id: src_1900_deed, confidence: high }',
          ].join('\n'),
          sourcesYaml: [
            "- citation: '1880 Federal Census'",
            "  id: 'src_1880_census'",
            '  source_type: census',
            '- id: src_1900_deed # inline comment',
            '  citation: 1900 County Deed Book',
            '  source_type: land_record',
          ].join('\n'),
        },
        {
          eventsYaml: JSON.stringify(SAMPLE_EVENTS),
          sourcesYaml: JSON.stringify(SAMPLE_SOURCES),
        },
      ];

      for (const form of variantBForms) {
        await writeFile(path.join(variantADir, 'data', 'events.yaml'), form.eventsYaml, 'utf8');
        await writeFile(path.join(variantADir, 'data', 'sources.yaml'), form.sourcesYaml, 'utf8');
        const resFallback = await runStatusCommand({ repoDir: variantADir, sort: 'richest' });
        const expectedRichest = await runStatusCommand({ repoDir: canonicalDir, sort: 'richest' });
        expect(resFallback.events).toBe(expectedRichest.events);
        expect(resFallback.sources).toBe(expectedRichest.sources);
        expect(resFallback.deceased).toEqual(expectedRichest.deceased);
      }

      await writeFile(path.join(variantADir, 'data', 'events.yaml'), '[]\n', 'utf8');
      await writeFile(path.join(variantADir, 'data', 'sources.yaml'), '[]\n', 'utf8');
      const emptyRes = await runStatusCommand({ repoDir: variantADir, sort: 'chronological' });
      expect(emptyRes.events).toBe(0);
      expect(emptyRes.sources).toBe(0);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('verify residence-span deduplication and living-name prefilter behavioral checks', () => {
  it('detects grouped and non-grouped duplicate residence spans and scans living names across narratives, media, sources, and events', async () => {
    const { compileArchive } = await import('@kinloom/core');
    const { findDuplicateResidenceSpans, scanPublicLivingNames } = await import('./verify/checks.js');

    const baseCompiled = compileArchive({
      mode: 'private',
      people: SAMPLE_PEOPLE,
      events: SAMPLE_EVENTS,
      places: [],
      sources: SAMPLE_SOURCES,
      kinship: [],
      media: [],
      narratives: [],
      siteConfig: KinloomSiteConfigSchema.parse({
        site: { title: 'Alder Family Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_GEDCOM' },
        privacy: { referenceYear: 2026 },
      }),
    });

    expect(findDuplicateResidenceSpans({ ...baseCompiled.bundle, residence_spans: [] }, 'public')).toEqual(
      []
    );

    const spanA: ResidenceSpan = {
      id: 'rsp_1',
      person_id: 'per_arthur_alder',
      place_id: 'plc_hudsonville',
      time_min: 1880,
      time_max: 1890,
      start_year: 1880,
      end_year: 1890,
      confidence_tier: 'Confirmed',
      from_event_id: 'evt_1880_household',
      to_event_id: 'evt_1910_solo',
    };
    const spanB: ResidenceSpan = {
      ...spanA,
      id: 'rsp_2',
      person_id: 'per_clara_mercer',
    };
    const interleavedSpans: ResidenceSpan[] = [
      spanA,
      { ...spanA, id: 'rsp_1_dup_tuple' },
      spanB,
      { ...spanA, id: 'rsp_1' },
      { ...spanB, id: 'rsp_3', time_min: 1891 },
      { ...spanB, id: 'rsp_4', time_min: 1891 },
    ];

    const dupes = findDuplicateResidenceSpans(
      { ...baseCompiled.bundle, residence_spans: interleavedSpans },
      'private'
    );
    expect(dupes).toContain('private:span:rsp_1_dup_tuple(per_arthur_alder@plc_hudsonville)');
    expect(dupes).toContain('private:id:rsp_1');
    expect(dupes).toContain('private:span:rsp_1(per_arthur_alder@plc_hudsonville)');
    expect(dupes).toContain('private:span:rsp_4(per_clara_mercer@plc_hudsonville)');

    const livingPerson: RawPerson = {
      id: 'per_devon_alder',
      slug: 'devon-alder-1992',
      full_name: 'Devon Alder',
      given_name: 'Devon',
      surname: 'Alder',
      alt_names: ['D. Alder'],
      sex: 'U',
      is_living: false,
      lineage_group: 'collateral',
      birth_edtf: '1992',
      death_edtf: '',
      portrait_url: null,
    };

    const scanHits = scanPublicLivingNames({
      people: [...SAMPLE_PEOPLE, livingPerson],
      events: [
        ...SAMPLE_EVENTS,
        {
          id: 'evt_undated_source_link',
          title: 'Undated Filing',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '',
          place_id: null,
          summary: 'No living name here.',
          participants: [{ person_id: 'per_arthur_alder', role: 'subject' }],
          sources: [{ source_id: 'src_1900_deed', confidence: 'low' }],
        },
        {
          id: 'evt_living_participant_skipped',
          title: 'Devon Alder Graduation',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '2014',
          place_id: null,
          summary: 'Devon Alder graduated.',
          participants: [{ person_id: 'per_devon_alder', role: 'graduate' }],
          sources: [],
        },
        {
          id: 'evt_leak_in_historical',
          title: 'Note mentioning Devon Alder',
          scope: 'family',
          event_kind: 'point_event',
          edtf_date: '2018',
          place_id: null,
          summary: 'Transcribed by Devon Alder.',
          participants: [{ person_id: 'per_arthur_alder', role: 'subject' }],
          sources: [],
        },
      ],
      sources: [
        {
          id: 'src_z_leak',
          citation: 'Interview with Devon Alder (2020)',
          source_type: 'oral_history',
        },
        ...SAMPLE_SOURCES,
      ],
      media: [
        {
          id: 'med_z_leak',
          kind: 'document_scan',
          event_id: 'evt_leak_in_historical',
          file: 'media/note.jpg',
          caption: 'Courtesy of Devon Alder',
          provenance: 'Donated by Devon Alder',
        },
      ],
      narratives: [],
      precomputedPublicNarratives: [
        {
          id: 'nar_z_leak',
          slug: 'alder-branch-notes',
          title: 'Notes from Devon Alder',
          summary: 'Compiled with Devon Alder',
          body_md: 'Oral history recorded by Devon Alder in Michigan.',
          subject_person_id: 'per_arthur_alder',
          person_ids: ['per_arthur_alder'],
          place_ids: [],
          event_ids: ['evt_leak_in_historical'],
          source_ids: [],
        },
      ],
      privacy: { referenceYear: 2026 },
    });

    expect(scanHits.ok).toBe(false);
    const locations = scanHits.hits.map((h) => h.location);
    expect(locations).toContain('narrative:nar_z_leak:title');
    expect(locations).toContain('narrative:nar_z_leak:summary');
    expect(locations).toContain('narrative:nar_z_leak:body_md');
    expect(locations).toContain('media:med_z_leak:caption');
    expect(locations).toContain('media:med_z_leak:provenance');
    expect(locations).toContain('source:src_z_leak:citation');
    expect(locations).toContain('event:evt_leak_in_historical:title');
    expect(locations).toContain('event:evt_leak_in_historical:summary');
    expect(locations).not.toContain('event:evt_living_participant_skipped:title');
  });
});

describe('status text formatting and tab/malformed YAML scanner fallbacks', () => {
  it('renders all filter/sort/endOfLine/missingBiography headings and falls back cleanly on tab-indented or untitled YAML', async () => {
    const { formatStatusTextReport, parseStatusSort } = await import('./status.js');
    expect(parseStatusSort(undefined)).toBe('sparsest');
    expect(() => parseStatusSort('invalid_mode')).toThrow();

    const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'kinloom-status-extra-'));
    try {
      await mkdir(path.join(tmpRoot, 'data'), { recursive: true });
      await mkdir(path.join(tmpRoot, 'research', 'people', 'per_clara_mercer'), { recursive: true });
      await writeFile(
        path.join(tmpRoot, 'research', 'people', 'per_clara_mercer', 'patch.json'),
        '{}',
        'utf8'
      );
      await writeFile(path.join(tmpRoot, 'kinloom.config.yaml'), makeSiteConfigYaml(), 'utf8');
      await writeFile(path.join(tmpRoot, 'data', 'people.yaml'), serializePeopleYaml(SAMPLE_PEOPLE), 'utf8');
      await writeFile(path.join(tmpRoot, 'data', 'places.yaml'), serializePlacesYaml([]), 'utf8');
      await writeFile(path.join(tmpRoot, 'data', 'media.yaml'), serializeMediaYaml([]), 'utf8');
      await writeFile(
        path.join(tmpRoot, 'data', 'narratives.yaml'),
        serializeNarrativesYaml([
          {
            id: 'nar_arthur_b',
            slug: 'arthur-bio-b',
            kind: 'biography',
            subject_person_id: 'per_arthur_alder',
            title: 'Arthur Bio B',
            body_md: 'Bio B',
            person_ids: ['per_arthur_alder'],
            place_ids: [],
            event_ids: [],
            source_ids: [],
          },
          {
            id: 'nar_arthur_a',
            slug: 'arthur-bio-a',
            kind: 'biography',
            subject_person_id: 'per_arthur_alder',
            title: 'Arthur Bio A',
            body_md: 'Bio A',
            person_ids: ['per_arthur_alder'],
            place_ids: [],
            event_ids: [],
            source_ids: [],
          },
        ]),
        'utf8'
      );
      await writeFile(path.join(tmpRoot, 'data', 'events.yaml'), serializeEventsYaml(SAMPLE_EVENTS), 'utf8');
      await writeFile(
        path.join(tmpRoot, 'data', 'sources.yaml'),
        serializeSourcesYaml(SAMPLE_SOURCES),
        'utf8'
      );

      const report = await runStatusCommand({
        repoDir: tmpRoot,
        sort: 'chronological',
        endOfLine: true,
        missingBiography: true,
      });
      expect(report.biographies.complete).toBe(1);
      expect(
        formatStatusTextReport(report, { endOfLine: false, missingBiography: true, filter: 'staged' })
      ).toContain('Missing biography staged');
      expect(formatStatusTextReport(report, { endOfLine: false, missingBiography: true })).toContain(
        'Missing biography'
      );
      expect(
        formatStatusTextReport(report, { endOfLine: true, missingBiography: false, filter: 'pending' })
      ).toContain('End-of-line pending');
      expect(formatStatusTextReport(report, { endOfLine: true, missingBiography: false })).toContain(
        'End-of-line ancestors'
      );
      expect(
        formatStatusTextReport(report, { endOfLine: false, missingBiography: false, filter: 'done_live' })
      ).toContain('Done live');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
