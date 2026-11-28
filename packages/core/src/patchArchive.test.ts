import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileArchive } from './compileArchive.js';
import { type BundlePatchMutation, patchCompiledBundle } from './patchArchive.js';
import { parseKinloomConfig } from './schemas/config.js';
import type {
  BuildMode,
  KinshipEdge,
  MediaItem,
  Narrative,
  Place,
  RawEvent,
  RawPerson,
  SourceRecord,
} from './schemas/entities.js';
import { deriveKinshipEdgeId, type EntityPayload } from './schemas/revisions.js';

interface SyntheticArchiveState {
  people: RawPerson[];
  events: RawEvent[];
  places: Place[];
  sources: SourceRecord[];
  kinship: KinshipEdge[];
  media: MediaItem[];
  narratives: Narrative[];
}

const TEST_CONFIG = parseKinloomConfig({
  site: {
    title: 'Cedar Valley Archive',
    familyName: 'Alder',
    gedcomSourceName: 'CEDAR_VALLEY_ARCHIVE',
  },
  defaultBranchId: 'alder_main',
  branches: [
    {
      id: 'alder_main',
      label: 'Alder Lineage',
      surnames: ['Alder'],
      lineageGroups: ['ancestor', 'descendant'],
    },
    { id: 'mercer_side', label: 'Mercer Side', surnames: ['Mercer'] },
  ],
  privacy: {
    livingCutoffYears: 101,
    referenceYear: 2026,
    privateModeShowsBirthYear: true,
    stripLivingPortraits: true,
    stripLivingResidenceSpans: true,
  },
});

const FIXED_GENERATED_AT = '2026-11-24T00:00:00.000Z';

function buildBaseState(): SyntheticArchiveState {
  return {
    places: [
      {
        id: 'plc_usa',
        slug: 'usa',
        name: 'USA',
        full_name: 'USA',
        place_type: 'country',
        parent_id: null,
        lat: 39.8,
        lng: -98.5,
      },
      {
        id: 'plc_ohio',
        slug: 'ohio-usa',
        name: 'Ohio',
        full_name: 'Ohio, USA',
        place_type: 'state',
        parent_id: 'plc_usa',
        lat: 40.4,
        lng: -82.9,
      },
      {
        id: 'plc_cedar_county',
        slug: 'cedar-county-ohio',
        name: 'Cedar County',
        full_name: 'Cedar County, Ohio, USA',
        place_type: 'county',
        parent_id: 'plc_ohio',
        lat: 40.1,
        lng: -83.1,
      },
      {
        id: 'plc_riverdale',
        slug: 'riverdale-ohio',
        name: 'Riverdale',
        full_name: 'Riverdale, Cedar County, Ohio, USA',
        place_type: 'town',
        parent_id: 'plc_cedar_county',
        lat: 40.1,
        lng: -83.1,
      },
      {
        id: 'plc_oakton',
        slug: 'oakton-ohio',
        name: 'Oakton',
        full_name: 'Oakton, Cedar County, Ohio, USA',
        place_type: 'town',
        parent_id: 'plc_cedar_county',
        lat: 40.15,
        lng: -83.12,
      },
      {
        id: 'plc_westport',
        slug: 'westport-oregon',
        name: 'Westport',
        full_name: 'Westport, Oregon, USA',
        place_type: 'town',
        parent_id: 'plc_usa',
        lat: 45.5,
        lng: -122.6,
      },
    ],
    people: [
      {
        id: 'per_arthur',
        slug: 'arthur-alder',
        full_name: 'Arthur Alder',
        given_name: 'Arthur',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1850-03-14',
        death_edtf: '1922-11-02',
        portrait_url: null,
      },
      {
        id: 'per_clara',
        slug: 'clara-mercer',
        full_name: 'Clara Mercer',
        given_name: 'Clara',
        surname: 'Mercer',
        alt_names: ['Clara Alder'],
        sex: 'F',
        is_living: false,
        lineage_group: 'descendant_spouse',
        birth_edtf: '1854-07-19',
        death_edtf: '1930-01-12',
        portrait_url: null,
      },
      {
        id: 'per_henry',
        slug: 'henry-alder',
        full_name: 'Henry Alder',
        given_name: 'Henry',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'descendant',
        birth_edtf: '1878-05-09',
        death_edtf: '1948-08-22',
        portrait_url: null,
      },
      {
        id: 'per_elena',
        slug: 'elena-alder',
        full_name: 'Elena Alder',
        given_name: 'Elena',
        surname: 'Alder',
        alt_names: [],
        sex: 'F',
        is_living: true,
        lineage_group: 'descendant',
        birth_edtf: '1984-06-21',
        death_edtf: '',
        portrait_url: null,
      },
    ],
    events: [
      {
        id: 'evt_arthur_1880',
        title: 'Arthur Alder resided in Riverdale',
        scope: 'personal',
        event_kind: 'residence_anchor',
        category: 'homestead',
        edtf_date: '1880',
        place_id: 'plc_riverdale',
        summary: 'Enumerated in 1880 census.',
        severity_rank: 4,
        participants: [{ person_id: 'per_arthur', role: 'resident' }],
        sources: [{ source_id: 'src_1880', confidence: 'high' }],
      },
      {
        id: 'evt_arthur_1890',
        title: 'Arthur Alder resided in Oakton',
        scope: 'personal',
        event_kind: 'residence_anchor',
        category: 'homestead',
        edtf_date: '1890',
        place_id: 'plc_oakton',
        summary: 'Listed in 1890 directory.',
        severity_rank: 4,
        participants: [{ person_id: 'per_arthur', role: 'resident' }],
        sources: [{ source_id: 'src_1880', confidence: 'high' }],
      },
      {
        id: 'evt_clara_1885',
        title: 'Clara Mercer resided in Riverdale',
        scope: 'personal',
        event_kind: 'residence_anchor',
        category: 'homestead',
        edtf_date: '1885',
        place_id: 'plc_riverdale',
        summary: 'County tax list.',
        severity_rank: 3,
        participants: [{ person_id: 'per_clara', role: 'resident' }],
        sources: [],
      },
      {
        id: 'evt_clara_1895',
        title: 'Clara Mercer resided in Riverdale',
        scope: 'personal',
        event_kind: 'residence_anchor',
        category: 'homestead',
        edtf_date: '1895',
        place_id: 'plc_riverdale',
        summary: 'Town directory.',
        severity_rank: 3,
        participants: [{ person_id: 'per_clara', role: 'resident' }],
        sources: [],
      },
      {
        id: 'evt_elena_birth',
        title: 'Birth of Elena Alder',
        scope: 'personal',
        event_kind: 'point_event',
        category: 'life_milestone',
        edtf_date: '1984-06-21',
        place_id: 'plc_riverdale',
        summary: 'Born in Riverdale.',
        severity_rank: 5,
        participants: [{ person_id: 'per_elena', role: 'birth_subject' }],
        sources: [],
      },
    ],
    sources: [
      {
        id: 'src_1880',
        citation: '1880 Federal Census (Ancestry GEDCOM @S1@)',
        source_type: 'census',
        repository: 'NARA',
      },
    ],
    kinship: [
      { from: 'per_arthur', to: 'per_clara', relation: 'spouse', family_xref: '@F1@' },
      { from: 'per_arthur', to: 'per_henry', relation: 'parent', family_xref: '@F1@' },
    ],
    media: [
      {
        id: 'med_arthur_portrait',
        kind: 'portrait',
        person_id: 'per_arthur',
        file: '/media/arthur.jpg',
        caption: 'Arthur Alder studio portrait',
      },
      {
        id: 'med_joint_stone',
        kind: 'headstone',
        person_ids: ['per_arthur', 'per_clara'],
        event_id: 'evt_arthur_1890',
        file: '/media/stone.jpg',
        caption: 'Family monument',
      },
    ],
    narratives: [
      {
        id: 'nar_settlement',
        slug: 'cedar-valley-settlement',
        title: 'Cedar Valley Settlement',
        body_md: 'Settled along Cedar Creek in the 1870s.',
        person_ids: ['per_arthur', 'per_clara'],
        place_ids: ['plc_riverdale'],
        event_ids: ['evt_arthur_1880'],
        source_ids: ['src_1880'],
      },
    ],
  };
}

function applyMutationToRawState(
  state: SyntheticArchiveState,
  mutation: BundlePatchMutation
): SyntheticArchiveState {
  const next = structuredClone(state);
  const { entity_type, entity_id, after_json } = mutation;

  const upsertOrDelete = <T extends { id: string }>(arr: T[], payload: EntityPayload | null): void => {
    const idx = arr.findIndex((item) => item.id === entity_id);
    if (payload === null) {
      if (idx !== -1) {
        arr.splice(idx, 1);
      }
      return;
    }
    const record = structuredClone(payload) as unknown as T;
    if (idx !== -1) {
      arr[idx] = record;
    } else {
      arr.push(record);
    }
  };

  switch (entity_type) {
    case 'person':
      upsertOrDelete(next.people, after_json);
      break;
    case 'event':
      upsertOrDelete(next.events, after_json);
      break;
    case 'place':
      upsertOrDelete(next.places, after_json);
      break;
    case 'source':
      upsertOrDelete(next.sources, after_json);
      break;
    case 'media':
      upsertOrDelete(next.media, after_json);
      break;
    case 'narrative':
      upsertOrDelete(next.narratives, after_json);
      break;
    case 'kinship_edge': {
      const idx = next.kinship.findIndex((e) => deriveKinshipEdgeId(e) === entity_id);
      if (after_json === null) {
        if (idx !== -1) {
          next.kinship.splice(idx, 1);
        }
      } else {
        const edge = structuredClone(after_json) as unknown as KinshipEdge;
        if (idx !== -1) {
          next.kinship[idx] = edge;
        } else {
          next.kinship.push(edge);
        }
      }
      break;
    }
  }
  return next;
}

function compileState(state: SyntheticArchiveState, mode: BuildMode, maxRevisionId: number) {
  return compileArchive({
    people: state.people,
    events: state.events,
    places: state.places,
    sources: state.sources,
    kinship: state.kinship,
    media: state.media,
    narratives: state.narratives,
    siteConfig: TEST_CONFIG,
    mode,
    generatedAt: FIXED_GENERATED_AT,
    maxRevisionId,
  }).bundle;
}

describe('patchCompiledBundle differential equivalence', () => {
  it('property: patchCompiledBundle matches full compileArchive across all entity types, actions, and build modes', () => {
    const modeArb = fc.constantFrom<BuildMode>('private', 'public');
    const actionArb = fc.constantFrom<'create' | 'update' | 'delete' | 'restore' | 'revert'>(
      'create',
      'update',
      'delete',
      'restore',
      'revert'
    );
    const entityKindArb = fc.constantFrom<
      'person' | 'event' | 'place' | 'source' | 'media' | 'narrative' | 'kinship_edge'
    >('person', 'event', 'place', 'source', 'media', 'narrative', 'kinship_edge');

    fc.assert(
      fc.property(
        modeArb,
        entityKindArb,
        actionArb,
        fc.integer({ min: 1840, max: 1920 }),
        fc.boolean(),
        fc.constantFrom('plc_riverdale', 'plc_oakton', 'plc_westport'),
        (mode, entityType, action, year, hasPrimarySource, placeId) => {
          const base = buildBaseState();
          const initialBundle = compileState(base, mode, 10);
          const beforeSnapshot = structuredClone(initialBundle);

          let mutation: BundlePatchMutation;

          switch (entityType) {
            case 'person': {
              if (action === 'create' || action === 'restore') {
                const newPerson: RawPerson = {
                  id: 'per_new_martha',
                  slug: 'martha-alder',
                  full_name: 'Martha Alder',
                  given_name: 'Martha',
                  surname: 'Alder',
                  alt_names: [],
                  sex: 'F',
                  is_living: false,
                  lineage_group: 'descendant',
                  birth_edtf: `${year}-04-10`,
                  death_edtf: `${year + 60}-09-01`,
                  portrait_url: null,
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'person',
                  entity_id: newPerson.id,
                  action,
                  after_json: newPerson as unknown as EntityPayload,
                };
              } else if (action === 'delete') {
                mutation = {
                  revision_id: 11,
                  entity_type: 'person',
                  entity_id: 'per_henry',
                  action: 'delete',
                  after_json: null,
                };
              } else {
                const updated: RawPerson = {
                  ...base.people[1]!,
                  full_name: 'Clara E. Mercer',
                  birth_edtf: `${year}-07-19`,
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'person',
                  entity_id: updated.id,
                  action,
                  after_json: updated as unknown as EntityPayload,
                };
              }
              break;
            }

            case 'event': {
              if (action === 'create' || action === 'restore') {
                const newEvent: RawEvent = {
                  id: 'evt_new_resi',
                  title: 'Henry Alder resided in valley',
                  scope: 'personal',
                  event_kind: 'residence_anchor',
                  category: 'homestead',
                  edtf_date: String(year),
                  place_id: placeId,
                  summary: 'Recorded in local tax roll (GEDCOM @I9@).',
                  severity_rank: 4,
                  participants: [{ person_id: 'per_arthur', role: 'resident' }],
                  sources: [{ source_id: 'src_1880', confidence: 'high' }],
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'event',
                  entity_id: newEvent.id,
                  action,
                  after_json: newEvent as unknown as EntityPayload,
                };
              } else if (action === 'delete') {
                mutation = {
                  revision_id: 11,
                  entity_type: 'event',
                  entity_id: 'evt_arthur_1890',
                  action: 'delete',
                  after_json: null,
                };
              } else {
                const updated: RawEvent = {
                  ...base.events[0]!,
                  edtf_date: String(year),
                  place_id: placeId,
                  severity_rank: year % 5,
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'event',
                  entity_id: updated.id,
                  action,
                  after_json: updated as unknown as EntityPayload,
                };
              }
              break;
            }

            case 'place': {
              if (action === 'create' || action === 'restore') {
                const newPlace: Place = {
                  id: 'plc_millbrook',
                  slug: 'millbrook-ohio',
                  name: 'Millbrook',
                  full_name: 'Millbrook, Cedar County, Ohio, USA',
                  place_type: 'town',
                  parent_id: 'plc_cedar_county',
                  lat: 40.12,
                  lng: -83.11,
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'place',
                  entity_id: newPlace.id,
                  action,
                  after_json: newPlace as unknown as EntityPayload,
                };
              } else if (action === 'delete') {
                mutation = {
                  revision_id: 11,
                  entity_type: 'place',
                  entity_id: 'plc_oakton',
                  action: 'delete',
                  after_json: null,
                };
              } else {
                const updated: Place = {
                  ...base.places[4]!, // plc_oakton
                  lat: hasPrimarySource ? 40.15 : 44.0,
                  lng: hasPrimarySource ? -83.12 : -110.0,
                  parent_id: hasPrimarySource ? 'plc_cedar_county' : 'plc_usa',
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'place',
                  entity_id: updated.id,
                  action,
                  after_json: updated as unknown as EntityPayload,
                };
              }
              break;
            }

            case 'source': {
              if (action === 'create' || action === 'restore') {
                const newSource: SourceRecord = {
                  id: 'src_1890_dir',
                  citation: '1890 Cedar County Directory (Ancestry GEDCOM @S9@)',
                  source_type: 'directory',
                  repository: 'County Historical Society',
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'source',
                  entity_id: newSource.id,
                  action,
                  after_json: newSource as unknown as EntityPayload,
                };
              } else if (action === 'delete') {
                mutation = {
                  revision_id: 11,
                  entity_type: 'source',
                  entity_id: 'src_1880',
                  action: 'delete',
                  after_json: null,
                };
              } else {
                const updated: SourceRecord = {
                  ...base.sources[0]!,
                  citation: '1880 US Federal Census Revised (Ancestry GEDCOM @S1@)',
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'source',
                  entity_id: updated.id,
                  action,
                  after_json: updated as unknown as EntityPayload,
                };
              }
              break;
            }

            case 'media': {
              if (action === 'create' || action === 'restore') {
                const newMedia: MediaItem = {
                  id: 'med_clara_portrait',
                  kind: 'portrait',
                  person_id: 'per_clara',
                  file: '/media/clara-portrait.jpg',
                  caption: 'Clara Mercer portrait',
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'media',
                  entity_id: newMedia.id,
                  action,
                  after_json: newMedia as unknown as EntityPayload,
                };
              } else if (action === 'delete') {
                mutation = {
                  revision_id: 11,
                  entity_type: 'media',
                  entity_id: 'med_arthur_portrait',
                  action: 'delete',
                  after_json: null,
                };
              } else {
                const updated: MediaItem = {
                  ...base.media[1]!,
                  caption: 'Updated stone caption',
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'media',
                  entity_id: updated.id,
                  action,
                  after_json: updated as unknown as EntityPayload,
                };
              }
              break;
            }

            case 'narrative': {
              if (action === 'create' || action === 'restore') {
                const newNarrative: Narrative = {
                  id: 'nar_mill',
                  slug: 'cedar-mill',
                  title: 'Cedar Mill Story',
                  body_md: 'Mill built near the creek.',
                  person_ids: ['per_henry'],
                  place_ids: ['plc_oakton'],
                  event_ids: [],
                  source_ids: [],
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'narrative',
                  entity_id: newNarrative.id,
                  action,
                  after_json: newNarrative as unknown as EntityPayload,
                };
              } else if (action === 'delete') {
                mutation = {
                  revision_id: 11,
                  entity_type: 'narrative',
                  entity_id: 'nar_settlement',
                  action: 'delete',
                  after_json: null,
                };
              } else {
                const updated: Narrative = {
                  ...base.narratives[0]!,
                  title: 'Cedar Valley Settlement Revised',
                  has_primary_source: hasPrimarySource,
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'narrative',
                  entity_id: updated.id,
                  action,
                  after_json: updated as unknown as EntityPayload,
                };
              }
              break;
            }

            case 'kinship_edge': {
              if (action === 'create' || action === 'restore') {
                const edge: KinshipEdge = {
                  from: 'per_clara',
                  to: 'per_henry',
                  relation: 'parent',
                  family_xref: '@F1@',
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'kinship_edge',
                  entity_id: deriveKinshipEdgeId(edge),
                  action,
                  after_json: edge as unknown as EntityPayload,
                };
              } else if (action === 'delete') {
                mutation = {
                  revision_id: 11,
                  entity_type: 'kinship_edge',
                  entity_id: deriveKinshipEdgeId(base.kinship[1]!),
                  action: 'delete',
                  after_json: null,
                };
              } else {
                const updated: KinshipEdge = {
                  ...base.kinship[0]!,
                  family_xref: '@F99@',
                };
                mutation = {
                  revision_id: 11,
                  entity_type: 'kinship_edge',
                  entity_id: deriveKinshipEdgeId(updated),
                  action,
                  after_json: updated as unknown as EntityPayload,
                };
              }
              break;
            }
          }

          const patched = patchCompiledBundle(initialBundle, [mutation], TEST_CONFIG, mode, {
            generatedAt: FIXED_GENERATED_AT,
          });
          const nextState = applyMutationToRawState(base, mutation);
          const recompiled = compileState(nextState, mode, 11);

          // Pure: previousBundle is never mutated
          expect(initialBundle).toEqual(beforeSnapshot);
          // Exact equivalence against full recompile
          expect(patched).toEqual(recompiled);
        }
      ),
      { numRuns: 150 }
    );
  });

  it('handles flipping a deceased person to living by redacting events, dropping spans, and stripping media', () => {
    for (const mode of ['private', 'public'] as const) {
      const base = buildBaseState();
      const initial = compileState(base, mode, 5);
      const nowLiving: RawPerson = {
        ...base.people[0]!,
        is_living: true,
        birth_edtf: '1970-08-15',
        death_edtf: '',
      };
      const mutation: BundlePatchMutation = {
        revision_id: 6,
        entity_type: 'person',
        entity_id: nowLiving.id,
        action: 'update',
        after_json: nowLiving as unknown as EntityPayload,
      };
      const patched = patchCompiledBundle(initial, [mutation], TEST_CONFIG, mode, {
        generatedAt: FIXED_GENERATED_AT,
      });
      const expected = compileState(applyMutationToRawState(base, mutation), mode, 6);
      expect(patched).toEqual(expected);
    }
  });

  it('tracks uncited_entity_keys and max_revision_id across multi-mutation batches', () => {
    const base = buildBaseState();
    const initial = compileState(base, 'private', 20);
    expect(initial.meta.max_revision_id).toBe(20);
    expect(initial.meta.uncited_entity_keys).toBeUndefined();

    const uncitedEvent: RawEvent = {
      id: 'evt_memory_story',
      title: 'Family memory of barn raising',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1902',
      place_id: 'plc_riverdale',
      summary: 'Recalled by descendants.',
      participants: [{ person_id: 'per_henry', role: 'participant' }],
      sources: [],
      has_primary_source: false,
    };

    const patched1 = patchCompiledBundle(
      initial,
      [
        {
          revision_id: 21,
          entity_type: 'event',
          entity_id: uncitedEvent.id,
          action: 'create',
          after_json: uncitedEvent as unknown as EntityPayload,
          has_primary_source: false,
        },
      ],
      TEST_CONFIG,
      'private',
      { generatedAt: FIXED_GENERATED_AT }
    );

    expect(patched1.meta.max_revision_id).toBe(21);
    expect(patched1.meta.uncited_entity_keys).toEqual(['event:evt_memory_story']);

    const citedEvent: RawEvent = {
      ...uncitedEvent,
      sources: [{ source_id: 'src_1880', confidence: 'high' }],
      has_primary_source: true,
    };
    const patched2 = patchCompiledBundle(
      patched1,
      [
        {
          revision_id: 22,
          entity_type: 'event',
          entity_id: citedEvent.id,
          action: 'update',
          after_json: citedEvent as unknown as EntityPayload,
          has_primary_source: true,
        },
      ],
      TEST_CONFIG,
      'private',
      { generatedAt: FIXED_GENERATED_AT }
    );

    expect(patched2.meta.max_revision_id).toBe(22);
    expect(patched2.meta.uncited_entity_keys).toBeUndefined();
  });

  it('preserves siteConfig.pronunciations identically to compileArchive across non-empty patches and falls back to previousBundle.pronunciations', () => {
    const configWithPronunciations = parseKinloomConfig({
      ...TEST_CONFIG,
      pronunciations: {
        Alder: { phonetic: 'AWL-der', ipa: 'ˈɔːldər', language: 'en-US' },
        Mercer: { phonetic: 'MER-ser', ipa: 'ˈmɜːrsər', language: 'en-US' },
      },
    });
    const base = buildBaseState();
    const initial = compileArchive({
      people: base.people,
      events: base.events,
      places: base.places,
      sources: base.sources,
      kinship: base.kinship,
      media: base.media,
      narratives: base.narratives,
      siteConfig: configWithPronunciations,
      mode: 'private',
      generatedAt: FIXED_GENERATED_AT,
      maxRevisionId: 30,
    }).bundle;

    const updatedPerson: RawPerson = {
      ...base.people[0]!,
      full_name: 'Arthur J. Alder',
      has_primary_source: true,
    };
    const mutation: BundlePatchMutation = {
      revision_id: 31,
      entity_type: 'person',
      entity_id: updatedPerson.id,
      action: 'update',
      after_json: updatedPerson as unknown as EntityPayload,
      has_primary_source: true,
    };

    const patched = patchCompiledBundle(initial, [mutation], configWithPronunciations, 'private', {
      generatedAt: FIXED_GENERATED_AT,
    });
    const recompiled = compileArchive({
      people: applyMutationToRawState(base, mutation).people,
      events: base.events,
      places: base.places,
      sources: base.sources,
      kinship: base.kinship,
      media: base.media,
      narratives: base.narratives,
      siteConfig: configWithPronunciations,
      mode: 'private',
      generatedAt: FIXED_GENERATED_AT,
      maxRevisionId: 31,
    }).bundle;

    expect(patched).toEqual(recompiled);
    expect(patched.pronunciations).toEqual(configWithPronunciations.pronunciations);
    expect(patched.pronunciations).not.toBe(configWithPronunciations.pronunciations);
    expect(patched.pronunciations).not.toBe(initial.pronunciations);

    // Fallback: when siteConfig.pronunciations is absent, retain previousBundle.pronunciations cleanly
    const patchedFallback = patchCompiledBundle(initial, [mutation], TEST_CONFIG, 'private', {
      generatedAt: FIXED_GENERATED_AT,
    });
    expect(patchedFallback.pronunciations).toEqual(initial.pronunciations);
    expect(patchedFallback.pronunciations).not.toBe(initial.pronunciations);
  });
});
