import { describe, expect, it } from 'vitest';
import { compileArchive } from '../compileArchive.js';
import { parseKinloomConfig } from '../schemas/config.js';
import {
  MediaItemSchema,
  PlaceSchema,
  RawEventSchema,
  RawPersonSchema,
  SourceRecordSchema,
} from '../schemas/entities.js';
import { findSourceUsages, summarizeEventCitations } from './citations.js';
import { computeRadarForEvent } from './radarEngine.js';

const SITE_CONFIG = parseKinloomConfig({
  site: {
    title: 'Alder Valley Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_ARCHIVE',
  },
  defaultBranchId: 'alder_main',
  branches: [{ id: 'alder_main', label: 'Alder Main' }],
});

describe('radarEngine overflow & spatial matching + domain citations behavioral suite', () => {
  it('handles radar ring overflow (>8 co-present relatives), shared-county and same-parent spatial matches, and source usages', () => {
    const places = [
      {
        id: 'pl_us',
        slug: 'us',
        name: 'USA',
        full_name: 'USA',
        place_type: 'country' as const,
        parent_id: null,
        lat: 40,
        lng: -85,
      },
      {
        id: 'pl_mi',
        slug: 'mi',
        name: 'Michigan',
        full_name: 'Michigan, USA',
        place_type: 'state' as const,
        parent_id: 'pl_us',
        lat: 43,
        lng: -85,
      },
      {
        id: 'pl_ottawa',
        slug: 'ottawa',
        name: 'Ottawa County',
        full_name: 'Ottawa County, Michigan',
        place_type: 'county' as const,
        parent_id: 'pl_mi',
        lat: 42.96,
        lng: -85.99,
      },
      {
        id: 'pl_hudsonville',
        slug: 'hudsonville',
        name: 'Hudsonville',
        full_name: 'Hudsonville, Ottawa County, Michigan',
        place_type: 'town' as const,
        parent_id: 'pl_ottawa',
        lat: 42.87,
        lng: -85.86,
      },
      // Farther than 15 miles away, but shares Ottawa County parent_id
      {
        id: 'pl_grand_haven',
        slug: 'grand-haven',
        name: 'Grand Haven',
        full_name: 'Grand Haven, Ottawa County, Michigan',
        place_type: 'town' as const,
        parent_id: 'pl_ottawa',
        lat: 43.063,
        lng: -86.228,
      },
      // Distant unrelated town
      {
        id: 'pl_distant',
        slug: 'distant',
        name: 'Distant City',
        full_name: 'Distant City, USA',
        place_type: 'town' as const,
        parent_id: 'pl_us',
        lat: 34.05,
        lng: -118.24,
      },
    ].map((p) => PlaceSchema.parse(p));

    const people = [
      RawPersonSchema.parse({
        id: 'per_focus',
        slug: 'henry-alder',
        full_name: 'Henry Alder',
        given_name: 'Henry',
        surname: 'Alder',
        sex: 'M',
        birth_edtf: '1850',
        death_edtf: '1930',
        is_living: false,
      }),
      ...Array.from({ length: 11 }, (_, idx) =>
        RawPersonSchema.parse({
          id: `per_rel_${idx}`,
          slug: `relative-${idx}-alder`,
          full_name: `Relative ${idx} Alder`,
          given_name: `Relative ${idx}`,
          surname: 'Alder',
          sex: idx % 2 === 0 ? 'F' : 'M',
          birth_edtf: String(1855 + idx),
          death_edtf: '1935',
          is_living: false,
        })
      ),
    ];

    const sources = [
      SourceRecordSchema.parse({
        id: 'src_primary',
        title: '1880 United States Federal Census',
        citation: 'Archival citation.',
        source_type: 'census',
        repository: 'NARA',
      }),
      SourceRecordSchema.parse({
        id: 'src_published',
        title: 'History of Ottawa County',
        citation: 'Archival citation.',
        source_type: 'book',
        publisher: 'Lakeshore Press',
      }),
      SourceRecordSchema.parse({
        id: 'src_family',
        title: 'Alder Family Bible',
        citation: 'Archival citation.',
        source_type: 'family_record',
      }),
      SourceRecordSchema.parse({
        id: 'src_index',
        title: 'Michigan Marriage Index',
        citation: 'Archival citation.',
        source_type: 'index',
      }),
      SourceRecordSchema.parse({
        id: 'src_unverified',
        title: 'Unverified Family Tree',
        citation: 'Archival citation.',
        source_type: 'other',
      }),
    ];

    const events = [
      RawEventSchema.parse({
        id: 'evt_focus_1880',
        title: '1880 Census in Hudsonville',
        scope: 'family',
        event_kind: 'residence_anchor',
        edtf_date: '1880-06-01',
        place_id: 'pl_hudsonville',
        summary: 'Focus event.',
        participants: [
          { person_id: 'per_focus', role: 'head' },
          ...Array.from({ length: 6 }, (_, idx) => ({ person_id: `per_rel_${idx}`, role: 'household' })),
        ],
        sources: [{ source_id: 'src_primary', confidence: 'high', citation_detail: 'Sheet 4A' }],
      }),
      // Co-present relatives in Grand Haven (shared county, > 15 miles) -> triggers overflow (> 8 total)
      RawEventSchema.parse({
        id: 'evt_county_1880',
        title: '1880 Grand Haven Gathering',
        scope: 'family',
        event_kind: 'residence_anchor',
        edtf_date: '1880-06-01',
        place_id: 'pl_grand_haven',
        summary: 'County-level co-presence.',
        participants: Array.from({ length: 5 }, (_, idx) => ({
          person_id: `per_rel_${idx + 6}`,
          role: 'subject',
        })),
        sources: [{ source_id: 'src_primary', confidence: 'medium', citation_detail: 'Sheet 9B' }],
      }),
      // 10 local events to exercise localVisible + localOverflow (> 8)
      ...Array.from({ length: 10 }, (_, idx) =>
        RawEventSchema.parse({
          id: `evt_local_${idx}`,
          title: `Local Event ${idx}`,
          scope: 'local',
          event_kind: 'context_span',
          edtf_date: '1880-06-01',
          place_id: 'pl_hudsonville',
          summary: `Local context ${idx}.`,
          participants: [],
          sources: [],
        })
      ),
      // 10 macro events to exercise macroVisible + macroOverflow (> 8)
      ...Array.from({ length: 10 }, (_, idx) =>
        RawEventSchema.parse({
          id: `evt_macro_${idx}`,
          title: `National Event ${idx}`,
          scope: 'national',
          event_kind: 'context_span',
          edtf_date: '1880-06-01',
          place_id: 'pl_us',
          summary: `Macro context ${idx}.`,
          participants: [],
          sources: [],
        })
      ),
      // Distant event that should NOT match spatial proximity
      RawEventSchema.parse({
        id: 'evt_distant',
        title: 'Distant Event',
        scope: 'local',
        event_kind: 'context_span',
        edtf_date: '1880-06-01',
        place_id: 'pl_distant',
        summary: 'Far away.',
        participants: [],
        sources: [],
      }),
    ];

    const media = [
      MediaItemSchema.parse({
        id: 'med_census_scan',
        kind: 'record_scan',
        file: '/media/census-1880.jpg',
        source_id: 'src_primary',
        caption: '1880 Census Scan',
      }),
    ];

    const { bundle } = compileArchive(
      {
        siteConfig: SITE_CONFIG,
        people,
        events,
        places,
        sources,
        kinship: [{ from: 'per_focus', to: 'per_rel_0', relation: 'spouse' }],
        narratives: [],
        stories: [],
        media,
      },
      { mode: 'public', referenceYear: 2026 }
    );

    const peopleById = new Map(bundle.people.map((p) => [p.id, p]));
    const placesById = new Map(bundle.places.map((p) => [p.id, p]));
    const sourcesById = new Map(bundle.sources.map((s) => [s.id, s]));

    const activeEvent = bundle.events.find((e) => e.id === 'evt_focus_1880')!;
    const radar = computeRadarForEvent(bundle, activeEvent, 'per_focus', peopleById, placesById);

    // Ring cap is 8 -> 11 co-present relatives split across visible (8) and overflow (3)
    expect(radar.coPresenceVisible).toHaveLength(8);
    expect(radar.coPresenceOverflow.length).toBeGreaterThanOrEqual(3);
    expect(radar.localVisible).toHaveLength(8);
    expect(radar.localOverflow.length).toBeGreaterThanOrEqual(2);
    expect(radar.macroVisible).toHaveLength(8);
    expect(radar.macroOverflow.length).toBeGreaterThanOrEqual(2);
    expect(radar.localVisible.some((e) => e.id === 'evt_distant')).toBe(false);

    // summarizeEventCitations across all tiers + empty + unverified-only
    expect(summarizeEventCitations([], sourcesById).onlyUnverified).toBe(true);
    expect(summarizeEventCitations([{ source_id: 'src_nonexistent' }], sourcesById).onlyUnverified).toBe(
      true
    );
    const mixedSummary = summarizeEventCitations(
      [
        { source_id: 'src_primary' },
        { source_id: 'src_published' },
        { source_id: 'src_family' },
        { source_id: 'src_index' },
        { source_id: 'src_nonexistent' },
      ],
      sourcesById
    );
    expect(mixedSummary.onlyUnverified).toBe(false);
    expect(mixedSummary.primaryCount).toBe(1);
    expect(mixedSummary.label).toContain('Primary');
    expect(mixedSummary.label).toContain('Index');
    expect(mixedSummary.label).toContain('Uncited');

    // findSourceUsages returns matching events and linked media, and handles null bundle gracefully
    expect(findSourceUsages('src_primary', null)).toEqual({ usages: [], linkedMedia: [] });
    const usageResult = findSourceUsages('src_primary', bundle);
    expect(usageResult.usages).toHaveLength(2);
    expect(usageResult.usages[0].primaryPersonName).toBeTruthy();
    expect(usageResult.linkedMedia).toHaveLength(1);
    expect(usageResult.linkedMedia[0].id).toBe('med_census_scan');
  });
});
