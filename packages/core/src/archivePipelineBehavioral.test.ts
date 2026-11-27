import { describe, expect, it } from 'vitest';
import { compileArchive } from './compileArchive.js';
import { asBatchId, asRevisionId, asSha256Hex, entityLookupCompositeKey } from './contracts.js';
import {
  applyCitationCleanings,
  cleanAlternateNote,
  cleanEventSummaryProse,
  cleanSourceCitationTitle,
  inferSourceRepository,
  redactSensitiveCitationDetail,
  UNVERIFIED_TREE_SOURCE_ID,
} from './gedcom/citations.js';
import { sliceGedcom } from './gedcom/slice.js';
import { applyEntityPatch, computeEntityDiff } from './revisions.js';
import { parseKinloomConfig } from './schemas/config.js';
import type {
  ArchiveEvent,
  NarrativeEnrichment,
  Place,
  RawEvent,
  RawPerson,
  SourceRecord,
} from './schemas/entities.js';
import { validateArchive } from './validateArchive.js';
import {
  parseNarrativeEnrichmentsYaml,
  parseYaml,
  serializeEventsYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
  yamlStr,
} from './yaml.js';

const SITE_CONFIG = parseKinloomConfig({
  site: {
    title: 'Alder Pipeline Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_PIPELINE',
  },
  defaultBranchId: 'alder_main',
  branches: [{ id: 'alder_main', label: 'Alder Main' }],
});

describe('Branded contract value constructors', () => {
  it('validates RevisionId, BatchId, Sha256Hex, and composite keys', () => {
    expect(asRevisionId(0)).toBe(0);
    expect(asRevisionId(42)).toBe(42);
    expect(() => asRevisionId(-1)).toThrow(RangeError);
    expect(() => asRevisionId(1.5)).toThrow(RangeError);

    expect(asBatchId('  batch_01  ')).toBe('batch_01');
    expect(() => asBatchId('   ')).toThrow(RangeError);

    const validHash = 'A'.repeat(64);
    expect(asSha256Hex(validHash)).toBe('a'.repeat(64));
    expect(() => asSha256Hex('not-a-sha')).toThrow(RangeError);

    expect(entityLookupCompositeKey('person', 'per_1')).toBe('person:per_1');
  });
});

describe('validateArchive referential integrity checks', () => {
  it('reports every class of dangling cross-entity reference and passes when all links resolve', () => {
    const valid = validateArchive({
      people: [{ id: 'per_1' }, { id: 'per_2' }],
      places: [{ id: 'plc_1' }],
      sources: [{ id: 'src_1' }],
      events: [
        {
          id: 'evt_1',
          place_id: 'plc_1',
          participants: [{ person_id: 'per_1', role: 'subject' }],
          sources: [{ source_id: 'src_1', confidence: 'high' }],
        },
      ],
      kinship: [{ from: 'per_1', to: 'per_2', relation: 'spouse' }],
      media: [{ id: 'med_1', person_id: 'per_1', event_id: 'evt_1', source_id: 'src_1' }],
      narratives: [
        {
          id: 'nar_1',
          kind: 'biography',
          subject_person_id: 'per_1',
          person_ids: ['per_1'],
          place_ids: ['plc_1'],
          event_ids: ['evt_1'],
          source_ids: ['src_1'],
          body_md: 'Documented life [^src_1].',
        },
      ],
    });
    expect(valid.ok).toBe(true);
    expect(valid.errors).toEqual([]);

    const broken = validateArchive({
      people: [{ id: 'per_1' }],
      places: [{ id: 'plc_1' }],
      sources: [{ id: 'src_1' }],
      events: [
        {
          id: 'evt_bad',
          place_id: 'plc_missing',
          participants: [{ person_id: 'per_missing', role: 'subject' }],
          sources: [{ source_id: 'src_missing', confidence: 'high' }],
        },
      ],
      kinship: [{ from: 'per_bad_from', to: 'per_bad_to', relation: 'parent' }],
      media: [{ id: 'med_bad', person_id: 'per_bad_m', event_id: 'evt_missing', source_id: 'src_bad_m' }],
      narratives: [
        {
          id: 'nar_bad_subject',
          kind: 'biography',
          subject_person_id: 'per_missing_subj',
          person_ids: ['per_missing_list'],
          place_ids: ['plc_missing_n'],
          event_ids: ['evt_missing_n'],
          source_ids: ['src_missing_n'],
          body_md: 'Broken citation [^src_missing_inline].',
        },
        {
          id: 'nar_bio_mismatch',
          kind: 'biography',
          subject_person_id: 'per_1',
          person_ids: ['per_missing_other'],
          place_ids: [],
          event_ids: [],
          source_ids: [],
        },
      ],
    });
    expect(broken.ok).toBe(false);
    expect(broken.errors.some((e) => e.includes('plc_missing'))).toBe(true);
    expect(broken.errors.some((e) => e.includes('per_missing'))).toBe(true);
    expect(broken.errors.some((e) => e.includes('src_missing'))).toBe(true);
    expect(broken.errors.some((e) => e.includes('per_bad_from'))).toBe(true);
    expect(broken.errors.some((e) => e.includes('per_bad_to'))).toBe(true);
    expect(broken.errors.some((e) => e.includes('med_bad'))).toBe(true);
    expect(broken.errors.some((e) => e.includes('per_missing_subj'))).toBe(true);
    expect(broken.errors.some((e) => e.includes('not listed in person_ids'))).toBe(true);
  });
});

describe('compileArchive enrichments, overrides, household details, and media overlays', () => {
  it('applies narrative enrichment overrides, appends events, enriches ancestry households, and merges media overlays', () => {
    const places: Place[] = [
      {
        id: 'plc_riverdale',
        slug: 'riverdale',
        name: 'Riverdale',
        full_name: 'Riverdale, Ohio, USA',
        place_type: 'town',
        parent_id: null,
        lat: 40.1,
        lng: -83.1,
      },
    ];
    const sources: SourceRecord[] = [
      { id: 'src_1880', citation: '1880 Federal Census', source_type: 'census' },
      { id: 'src_enr', citation: 'County Deed Book', source_type: 'vital_record' },
    ];
    const people: RawPerson[] = [
      {
        id: 'per_henry',
        slug: 'henry-alder',
        gedcom_xref: '@I100@',
        full_name: 'Henry Alder',
        given_name: 'Henry',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        branch: 'alder_main',
        birth_edtf: '1850',
        death_edtf: '1925',
        portrait_url: null,
      },
    ];
    const events: RawEvent[] = [
      {
        id: 'evt_res_1880',
        title: '1880 Residence',
        scope: 'family',
        event_kind: 'residence_anchor',
        edtf_date: '1880',
        place_id: 'plc_riverdale',
        summary: 'Archival residence record places Henry Alder in Riverdale',
        participants: [{ person_id: 'per_henry', role: 'head' }],
        sources: [{ source_id: 'src_1880', confidence: 'high' }],
      },
    ];
    const enrichments: NarrativeEnrichment[] = [
      {
        override_event_id: 'evt_res_1880',
        title: '1880 Riverdale Homestead',
        category: 'homestead',
        severity_rank: 6,
        photo_url: '/media/homestead.jpg',
        photo_placeholder_caption: 'Riverdale farmstead',
        sources: [{ source_id: 'src_enr', confidence: 'high' }],
        alternate_dates: [{ edtf_date: '1880-06', source_id: 'src_enr', note: 'June enumeration' }],
        alternate_places: [{ place_name: 'Riverdale Twp', source_id: 'src_enr', note: 'Township' }],
        fact_conflicts: [
          { claim: 'Farmer vs Carpenter', source_id: 'src_enr', note: 'Deed lists carpenter' },
        ],
      },
      {
        override_event_id: 'evt_nonexistent',
        title: 'Ignored',
      },
      {
        id: 'evt_enr_added',
        title: '1885 Barn Raising',
        scope: 'family',
        event_kind: 'point_event',
        edtf_date: '1885',
        place_id: 'plc_riverdale',
        summary: 'Neighbors raised the timber barn.',
        participants: [{ person_id: 'per_henry', role: 'subject' }],
        sources: [{ source_id: 'src_enr', confidence: 'high' }],
      },
    ];

    const result = compileArchive({
      people,
      events,
      places,
      sources,
      kinship: [],
      enrichments,
      contextEvents: [
        {
          id: 'evt_ctx_1880',
          title: 'Regional Railroad Expansion',
          scope: 'state',
          event_kind: 'point_event',
          edtf_date: '1880',
          place_id: 'plc_riverdale',
          summary: 'Rail line reached Cedar County.',
          participants: [],
          sources: [{ source_id: 'src_ctx', confidence: 'high' }],
        },
      ],
      contextSources: [
        { id: 'src_ctx', citation: 'Ohio Rail Chronicle', source_type: 'historical_reference' },
      ],
      ancestryPeople: [
        {
          personId: '100:extra',
          events: [
            { type: 'Residence', date: '1880', description: 'Marital Status: Married; Head of House' },
          ],
        },
      ],
      compiledMediaOverlay: {
        media: [
          {
            id: 'med_overlay_1',
            kind: 'portrait',
            person_id: 'per_henry',
            file: '/media/henry-overlay.jpg',
            caption: 'Overlay portrait',
          },
          {
            id: 'med_missing_file',
            kind: 'portrait',
            person_id: 'per_henry',
            file: '/media/missing.jpg',
            caption: 'Missing file filtered out',
          },
        ],
        people: [{ id: 'per_henry', portrait_url: '/media/henry-overlay.jpg' }],
        events: [{ id: 'evt_enr_added', photo_url: '/media/barn.jpg' }],
      },
      mediaExists: (fileUrl) => fileUrl !== '/media/missing.jpg',
      resolveThumbUrl: (url) => (url ? url.replace('.jpg', '-thumb.jpg') : undefined),
      siteConfig: SITE_CONFIG,
      mode: 'private',
      generatedAt: '2026-11-26T00:00:00.000Z',
    });

    expect(result.enrichedHouseholdCount).toBe(1);
    const updated = result.bundle.events.find((e) => e.id === 'evt_res_1880');
    expect(updated?.title).toBe('1880 Riverdale Homestead');
    expect(updated?.summary).toContain('Head of House');
    expect(updated?.sources.length).toBe(2);
    expect(result.bundle.events.some((e) => e.id === 'evt_enr_added')).toBe(true);
    expect(result.bundle.events.some((e) => e.id === 'evt_ctx_1880')).toBe(true);

    const henry = result.bundle.people.find((p) => p.id === 'per_henry');
    expect(henry?.portrait_url).toBe('/media/henry-overlay.jpg');
    expect(henry?.thumb_url).toBe('/media/henry-overlay-thumb.jpg');
    expect(result.bundle.media?.some((m) => m.id === 'med_missing_file')).toBe(false);
  });
});

describe('GEDCOM citation sanitization & repository inference behavior', () => {
  it('redacts SSNs, infers repositories across record families, and cleans legacy GEDCOM prose', () => {
    expect(redactSensitiveCitationDetail('')).toBe('');
    expect(redactSensitiveCitationDetail('Number: 123-45-6789; Claim file 44')).toBe('Claim file 44');
    expect(redactSensitiveCitationDetail('SSN 123-45-6789 on card')).toBe('SSN [SSN redacted] on card');

    expect(cleanSourceCitationTitle('1880 Census (Ancestry GEDCOM @S12@)')).toBe('1880 Census');

    expect(inferSourceRepository('1880 Federal Census')).toContain('NARA');
    expect(inferSourceRepository('Find a Grave Index')).toBe('Find A Grave');
    expect(inferSourceRepository('Social Security Death Index')).toContain('Social Security');
    expect(inferSourceRepository('World War I Draft Registration')).toContain('NARA');
    expect(inferSourceRepository('General Land Office Records')).toContain('Bureau of Land Management');
    expect(inferSourceRepository('Newspapers.com Obituary')).toContain('Newspapers.com');
    expect(inferSourceRepository('Texas, Marriage Index')).toContain('Texas');
    expect(inferSourceRepository('California, Death Index')).toContain('California');
    expect(inferSourceRepository('Virginia, Marriage Registers')).toContain('Virginia');
    expect(inferSourceRepository('Church of England Parish Records')).toContain('Church of England');
    expect(inferSourceRepository('Custom Book', 'Ancestry.com', 'Valley Press')).toBe('Valley Press');
    expect(inferSourceRepository('Custom Book', 'County Archive')).toBe('County Archive');
    expect(inferSourceRepository('Unknown Collection')).toContain('Archival Record Collection');

    expect(
      cleanEventSummaryProse(
        'Henry recorded marriage on 1875 according to the Ancestry GEDCOM (@S1@). Note: 1 conflicting GEDCOM entry recorded.'
      )
    ).toBe('Henry married in 1875. Note: 1 alternate record entry preserved.');
    expect(
      cleanEventSummaryProse('Clara was died on 4 mar 1932. Note: 2 conflicting GEDCOM entries recorded.')
    ).toBe('Clara died on 4 Mar 1932. Note: 2 alternate record entries preserved.');
    expect(cleanEventSummaryProse('Arthur was born on Abt. 1878 and died on 1950.')).toBe(
      'Arthur was born about 1878 and died in 1950.'
    );
    expect(cleanAlternateNote('GEDCOM alternate date: 1879 (GEDCOM @S4@) from GEDCOM entry')).toBe(
      'Alternate date: 1879 from archival entry'
    );

    const ev: ArchiveEvent = {
      id: 'evt_clean',
      title: 'Marriage',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1875',
      display_date: '1875',
      year: 1875,
      time_min: 0,
      time_max: 0,
      place_id: null,
      place_ancestors: [],
      summary: 'Recorded marriage on 1875 (GEDCOM @S9@)',
      participants: [],
      sources: [
        { source_id: 'src_legacy', confidence: 'low', citation_detail: 'Number: 111-22-3333; Page 2' },
      ],
      alternate_dates: [{ edtf_date: '1876', source_id: 'src_legacy', note: 'GEDCOM alternate date: 1876' }],
      alternate_places: [
        { place_name: 'Ohio', source_id: 'src_legacy', note: 'GEDCOM alternate place: Ohio' },
      ],
      fact_conflicts: [{ claim: 'Date', source_id: 'src_legacy', note: 'GEDCOM entry' }],
    };
    const srcs: SourceRecord[] = [
      { id: 'src_legacy', citation: 'Legacy (Ancestry GEDCOM @S9@)', source_type: 'compiled_tree' },
    ];
    applyCitationCleanings([ev], srcs, new Set(['src_legacy']));
    expect(ev.sources[0].source_id).toBe(UNVERIFIED_TREE_SOURCE_ID);
    expect(ev.sources[0].citation_detail).toBe('Page 2');
    expect(ev.alternate_dates?.[0].source_id).toBe(UNVERIFIED_TREE_SOURCE_ID);
    expect(ev.alternate_places?.[0].source_id).toBe(UNVERIFIED_TREE_SOURCE_ID);
    expect(ev.fact_conflicts?.[0].source_id).toBe(UNVERIFIED_TREE_SOURCE_ID);
    expect(srcs[0].citation).toBe('Legacy');
  });
});

describe('GEDCOM slicing behavioral contract', () => {
  it('slices ancestors, siblings, descendants, spouses, and normalizes maiden names with living detection', () => {
    const sampleGedcom = [
      '0 HEAD',
      '1 GEDC',
      '2 VERS 7.0',
      '0 @S1@ SOUR',
      '1 TITL 1880 Federal Census (Ancestry GEDCOM @S1@)',
      '0 @I1@ INDI',
      '1 NAME William /Alder/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 12 MAR 1830',
      '2 PLAC Riverdale, Cedar County, Ohio, USA',
      '1 DEAT',
      '2 DATE 1901',
      '1 FAMS @F1@',
      '0 @I2@ INDI',
      '1 NAME Mary /Mercer/',
      '1 NAME Mary /Alder/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE ABT 1834',
      '1 DEAT',
      '2 DATE 1910',
      '1 FAMS @F1@',
      '0 @I3@ INDI',
      '1 NAME Henry /Alder/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1855',
      '2 PLAC Riverdale, Cedar County, Ohio, USA',
      '2 SOUR @S1@',
      '3 PAGE Sheet 4A',
      '1 DEAT',
      '2 DATE 1930',
      '1 FAMC @F1@',
      '1 FAMS @F2@',
      '0 @I4@ INDI',
      '1 NAME Clara /Bates/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE 1859',
      '1 DEAT',
      '2 DATE 1938',
      '1 FAMS @F2@',
      '0 @I5@ INDI',
      '1 NAME Sam /Alder/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1988',
      '1 FAMC @F2@',
      '0 @F1@ FAM',
      '1 HUSB @I1@',
      '1 WIFE @I2@',
      '1 CHIL @I3@',
      '1 MARR',
      '2 DATE 1854',
      '2 PLAC Riverdale, Cedar County, Ohio, USA',
      '0 @F2@ FAM',
      '1 HUSB @I3@',
      '1 WIFE @I4@',
      '1 CHIL @I5@',
      '0 TRLR',
    ].join('\n');

    const sliced = sliceGedcom(sampleGedcom, {
      rootName: 'Henry Alder',
      ancestorSurnames: ['Alder'],
      branchId: 'alder_main',
      referenceYear: 2026,
      knownPlaces: {
        'riverdale, cedar county, ohio, usa': { lat: 40.1, lng: -83.1, place_type: 'town' },
      },
    });

    expect(sliced.rootXref).toBe('@I3@');
    expect(sliced.people.some((p) => p.full_name === 'William Alder')).toBe(true);
    expect(sliced.people.some((p) => p.full_name === 'Mary Mercer')).toBe(true);
    const livingDesc = sliced.people.find((p) => p.given_name === 'Sam');
    expect(livingDesc?.is_living).toBe(true);
    expect(sliced.kinship.length).toBeGreaterThanOrEqual(4);
    expect(sliced.events.length).toBeGreaterThanOrEqual(4);
    expect(sliced.places.length).toBeGreaterThanOrEqual(1);
  });

  it('exercises applyEntityPatch illegal transitions, computeEntityDiff, and deterministic sorted YAML helpers', () => {
    // computeEntityDiff across null/null, nested object changes, additions, and removals
    expect(computeEntityDiff(null, null).hasChanges).toBe(false);
    const diff = computeEntityDiff(
      { id: 'per_1', full_name: 'Henry Alder', alt_names: ['H. Alder'], notes: 'Old', meta: { a: 1, b: 2 } },
      {
        id: 'per_1',
        full_name: 'Henry Alder Sr.',
        alt_names: ['H. Alder', 'Hank'],
        added: true,
        meta: { a: 1, b: 3 },
      }
    );
    expect(diff.hasChanges).toBe(true);
    expect(diff.addedCount).toBe(1);
    expect(diff.removedCount).toBe(1);
    expect(diff.changedCount).toBeGreaterThanOrEqual(3);

    // applyEntityPatch legal + illegal transitions
    const active = { data: { id: 'per_1', full_name: 'Henry Alder' }, deletedAt: null, revisionId: 2 };
    const deleted = {
      data: { id: 'per_1', full_name: 'Henry Alder' },
      deletedAt: '2026-01-01T00:00:00Z',
      revisionId: 3,
    };
    expect(() =>
      applyEntityPatch(active, {
        action: 'create',
        entity_type: 'person',
        entity_id: 'per_1',
        data: { id: 'per_1' },
      })
    ).toThrow(/already exists/i);
    expect(() =>
      applyEntityPatch(deleted, {
        action: 'create',
        entity_type: 'person',
        entity_id: 'per_1',
        data: { id: 'per_1' },
      })
    ).toThrow(/soft-deleted/i);
    expect(() =>
      applyEntityPatch(null, {
        action: 'update',
        merge: true,
        entity_type: 'person',
        entity_id: 'per_1',
        data: { id: 'per_1' },
      })
    ).toThrow(/does not exist/i);
    expect(() =>
      applyEntityPatch(active, {
        action: 'update',
        merge: true,
        entity_type: 'person',
        entity_id: 'per_1',
        parent_revision_id: 1,
        data: { id: 'per_1' },
      })
    ).toThrow(/conflict/i);
    expect(() =>
      applyEntityPatch(null, { action: 'delete', entity_type: 'person', entity_id: 'per_1' })
    ).toThrow(/does not exist/i);
    expect(() =>
      applyEntityPatch(active, {
        action: 'delete',
        entity_type: 'person',
        entity_id: 'per_1',
        parent_revision_id: 1,
      })
    ).toThrow(/conflict/i);
    expect(() =>
      applyEntityPatch(active, { action: 'restore', entity_type: 'person', entity_id: 'per_1' })
    ).toThrow(/not soft-deleted/i);
    expect(() =>
      applyEntityPatch(deleted, {
        action: 'restore',
        entity_type: 'person',
        entity_id: 'per_1',
        parent_revision_id: 1,
      })
    ).toThrow(/conflict/i);
    const restored = applyEntityPatch(deleted, {
      action: 'restore',
      entity_type: 'person',
      entity_id: 'per_1',
      parent_revision_id: 3,
      data: { full_name: 'Henry Alder Restored' },
    });
    expect(restored.after?.full_name).toBe('Henry Alder Restored');

    // YAML scalar helpers, empty parse, and deterministic sorted serializers
    expect(parseYaml('   ')).toBeNull();
    expect(yamlStr('plain')).toBe('plain');
    expect(yamlStr('needs: quote')).toBe('"needs: quote"');
    expect(yamlStr('')).toBe('""');
    expect(parseNarrativeEnrichmentsYaml('[]')).toEqual([]);
    expect(serializePeopleYaml([], { sortById: true })).toBe('[]\n');
    expect(serializeEventsYaml([], { sortById: true })).toBe('[]\n');
    expect(serializePlacesYaml([], { sortById: true })).toBe('[]\n');
    expect(serializeSourcesYaml([], { sortById: true })).toBe('[]\n');
    expect(serializeKinshipYaml([], { sortDeterministic: true })).toBe('[]\n');
    expect(serializeMediaYaml([], { sortById: true })).toBe('[]\n');
    expect(serializeNarrativesYaml([], { sortById: true })).toBe('[]\n');
  });
});
