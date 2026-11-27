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

const DIFFERENTIAL_SEED = 20261127;
const FIXED_GENERATED_AT = '2026-11-26T00:00:00.000Z';

interface MutableArchiveState {
  people: RawPerson[];
  events: RawEvent[];
  places: Place[];
  sources: SourceRecord[];
  kinship: KinshipEdge[];
  media: MediaItem[];
  narratives: Narrative[];
}

const SITE_CONFIG = parseKinloomConfig({
  site: {
    title: 'Alder Creek Differential Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_CREEK_ARCHIVE',
  },
  defaultBranchId: 'alder_main',
  branches: [
    {
      id: 'alder_main',
      label: 'Alder Main',
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

function createInitialState(): MutableArchiveState {
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
        slug: 'ohio',
        name: 'Ohio',
        full_name: 'Ohio, USA',
        place_type: 'state',
        parent_id: 'plc_usa',
        lat: 40.4,
        lng: -82.9,
      },
      {
        id: 'plc_riverdale',
        slug: 'riverdale',
        name: 'Riverdale',
        full_name: 'Riverdale, Ohio, USA',
        place_type: 'town',
        parent_id: 'plc_ohio',
        lat: 40.1,
        lng: -83.1,
      },
    ],
    sources: [
      { id: 'src_1880', citation: '1880 Federal Census, Cedar County', source_type: 'census' },
      { id: 'src_1900', citation: '1900 Federal Census, Cedar County', source_type: 'census' },
    ],
    people: [
      {
        id: 'per_henry',
        slug: 'henry-alder',
        full_name: 'Henry Alder',
        given_name: 'Henry',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        branch: 'alder_main',
        birth_edtf: '1855-03-10',
        death_edtf: '1932-11-04',
        portrait_url: null,
      },
      {
        id: 'per_clara',
        slug: 'clara-mercer',
        full_name: 'Clara Mercer',
        given_name: 'Clara',
        surname: 'Mercer',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'ancestor',
        branch: 'mercer_side',
        birth_edtf: '1859-08-22',
        death_edtf: '1941-02-17',
        portrait_url: null,
      },
      {
        id: 'per_sam',
        slug: 'sam-alder',
        full_name: 'Sam Alder',
        given_name: 'Sam',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: true,
        lineage_group: 'descendant',
        branch: 'alder_main',
        birth_edtf: '1988-06-14',
        death_edtf: '',
        portrait_url: '/media/sam.jpg',
      },
    ],
    events: [
      {
        id: 'evt_1880_census',
        title: '1880 Census in Riverdale',
        scope: 'family',
        event_kind: 'residence_anchor',
        edtf_date: '1880-06-01',
        place_id: 'plc_riverdale',
        summary: 'Henry Alder and Clara Mercer enumerated in Riverdale.',
        participants: [
          { person_id: 'per_henry', role: 'head' },
          { person_id: 'per_clara', role: 'spouse' },
        ],
        sources: [{ source_id: 'src_1880', confidence: 'high' }],
      },
    ],
    kinship: [{ from: 'per_henry', to: 'per_clara', relation: 'spouse' }],
    media: [
      {
        id: 'med_henry_scan',
        kind: 'document_scan',
        person_id: 'per_henry',
        event_id: 'evt_1880_census',
        file: '/media/henry-1880.jpg',
        caption: '1880 Census Scan',
      },
    ],
    narratives: [
      {
        id: 'nar_henry_bio',
        slug: 'henry-alder-bio',
        kind: 'biography',
        subject_person_id: 'per_henry',
        title: 'Henry Alder in Riverdale',
        summary: 'Short biography of Henry Alder.',
        person_ids: ['per_henry'],
        place_ids: ['plc_riverdale'],
        event_ids: ['evt_1880_census'],
        source_ids: ['src_1880'],
        body_md: 'Henry Alder settled in Riverdale.',
      },
    ],
  };
}

function applyMutation(state: MutableArchiveState, m: BundlePatchMutation): MutableArchiveState {
  const next: MutableArchiveState = structuredClone(state);
  const upsert = <T extends { id: string }>(arr: T[], item: T): T[] => {
    const idx = arr.findIndex((x) => x.id === item.id);
    if (idx >= 0) {
      arr[idx] = item;
      return arr;
    }
    arr.push(item);
    return arr;
  };

  if (m.entity_type === 'person') {
    if (m.action === 'delete' || !m.after_json) {
      next.people = next.people.filter((p) => p.id !== m.entity_id);
    } else {
      upsert(next.people, m.after_json as unknown as RawPerson);
    }
  } else if (m.entity_type === 'event') {
    if (m.action === 'delete' || !m.after_json) {
      next.events = next.events.filter((e) => e.id !== m.entity_id);
    } else {
      upsert(next.events, m.after_json as unknown as RawEvent);
    }
  } else if (m.entity_type === 'place') {
    if (m.action === 'delete' || !m.after_json) {
      next.places = next.places.filter((p) => p.id !== m.entity_id);
    } else {
      upsert(next.places, m.after_json as unknown as Place);
    }
  } else if (m.entity_type === 'source') {
    if (m.action === 'delete' || !m.after_json) {
      next.sources = next.sources.filter((s) => s.id !== m.entity_id);
    } else {
      upsert(next.sources, m.after_json as unknown as SourceRecord);
    }
  } else if (m.entity_type === 'media') {
    if (m.action === 'delete' || !m.after_json) {
      next.media = next.media.filter((x) => x.id !== m.entity_id);
    } else {
      upsert(next.media, m.after_json as unknown as MediaItem);
    }
  } else if (m.entity_type === 'narrative') {
    if (m.action === 'delete' || !m.after_json) {
      next.narratives = next.narratives.filter((n) => n.id !== m.entity_id);
    } else {
      upsert(next.narratives, m.after_json as unknown as Narrative);
    }
  } else if (m.entity_type === 'kinship_edge') {
    if (m.action === 'delete' || !m.after_json) {
      next.kinship = next.kinship.filter((k) => deriveKinshipEdgeId(k) !== m.entity_id);
    } else {
      const edge = m.after_json as unknown as KinshipEdge;
      const edgeId = deriveKinshipEdgeId(edge);
      const idx = next.kinship.findIndex((k) => deriveKinshipEdgeId(k) === edgeId);
      if (idx >= 0) {
        next.kinship[idx] = edge;
      } else {
        next.kinship.push(edge);
      }
    }
  }
  return next;
}

type StepSpec =
  | { kind: 'upsert_person'; slot: number; isLiving: boolean; birthYear: number }
  | { kind: 'upsert_event'; slot: number; year: number; includeLiving: boolean }
  | { kind: 'delete_event'; slot: number }
  | { kind: 'upsert_place'; slot: number }
  | { kind: 'upsert_source'; slot: number }
  | { kind: 'upsert_media'; slot: number; onLiving: boolean }
  | { kind: 'upsert_narrative'; slot: number; onLiving: boolean }
  | { kind: 'upsert_kinship'; slot: number };

const stepArb: fc.Arbitrary<StepSpec> = fc.oneof(
  fc.record({
    kind: fc.constant('upsert_person' as const),
    slot: fc.integer({ min: 1, max: 3 }),
    isLiving: fc.boolean(),
    birthYear: fc.integer({ min: 1840, max: 1998 }),
  }),
  fc.record({
    kind: fc.constant('upsert_event' as const),
    slot: fc.integer({ min: 1, max: 3 }),
    year: fc.integer({ min: 1860, max: 1945 }),
    includeLiving: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('delete_event' as const),
    slot: fc.integer({ min: 1, max: 3 }),
  }),
  fc.record({
    kind: fc.constant('upsert_place' as const),
    slot: fc.integer({ min: 1, max: 2 }),
  }),
  fc.record({
    kind: fc.constant('upsert_source' as const),
    slot: fc.integer({ min: 1, max: 2 }),
  }),
  fc.record({
    kind: fc.constant('upsert_media' as const),
    slot: fc.integer({ min: 1, max: 2 }),
    onLiving: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('upsert_narrative' as const),
    slot: fc.integer({ min: 1, max: 2 }),
    onLiving: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('upsert_kinship' as const),
    slot: fc.integer({ min: 1, max: 2 }),
  })
);

function buildMutation(step: StepSpec, state: MutableArchiveState, revisionId: number): BundlePatchMutation {
  switch (step.kind) {
    case 'upsert_person': {
      const id = `per_seq_${step.slot}`;
      const exists = state.people.some((p) => p.id === id);
      const isLiving = step.isLiving || step.birthYear > 1925;
      const payload: RawPerson = {
        id,
        slug: `seq-${step.slot}`,
        full_name: `Relative${step.slot} Alder`,
        given_name: `Relative${step.slot}`,
        surname: 'Alder',
        alt_names: [],
        sex: step.slot % 2 === 0 ? 'F' : 'M',
        is_living: isLiving,
        lineage_group: 'descendant',
        branch: 'alder_main',
        birth_edtf: `${step.birthYear}-05-10`,
        death_edtf: isLiving ? '' : `${Math.min(step.birthYear + 60, 1985)}`,
        portrait_url: null,
      };
      return {
        revision_id: revisionId,
        entity_type: 'person',
        entity_id: id,
        action: exists ? 'update' : 'create',
        after_json: payload as unknown as EntityPayload,
      };
    }
    case 'upsert_event': {
      const id = `evt_seq_${step.slot}`;
      const exists = state.events.some((e) => e.id === id);
      const participants = [{ person_id: 'per_henry', role: 'participant' }];
      if (step.includeLiving) {
        participants.push({ person_id: 'per_sam', role: 'participant' });
      }
      const payload: RawEvent = {
        id,
        title: `Milestone ${step.slot} (${step.year})`,
        scope: 'family',
        event_kind: step.slot % 2 === 0 ? 'residence_anchor' : 'point_event',
        edtf_date: `${step.year}-07-04`,
        place_id: 'plc_riverdale',
        summary: `Family milestone ${step.slot}.`,
        participants,
        sources: [{ source_id: 'src_1900', confidence: 'high' }],
      };
      return {
        revision_id: revisionId,
        entity_type: 'event',
        entity_id: id,
        action: exists ? 'update' : 'create',
        after_json: payload as unknown as EntityPayload,
      };
    }
    case 'delete_event': {
      const id = `evt_seq_${step.slot}`;
      return {
        revision_id: revisionId,
        entity_type: 'event',
        entity_id: id,
        action: 'delete',
        after_json: null,
      };
    }
    case 'upsert_place': {
      const id = `plc_seq_${step.slot}`;
      const exists = state.places.some((p) => p.id === id);
      const payload: Place = {
        id,
        slug: `town-${step.slot}`,
        name: `Town${step.slot}`,
        full_name: `Town${step.slot}, Ohio, USA`,
        place_type: 'town',
        parent_id: 'plc_ohio',
        lat: 40.1 + step.slot * 0.1,
        lng: -83.1 - step.slot * 0.1,
      };
      return {
        revision_id: revisionId,
        entity_type: 'place',
        entity_id: id,
        action: exists ? 'update' : 'create',
        after_json: payload as unknown as EntityPayload,
      };
    }
    case 'upsert_source': {
      const id = `src_seq_${step.slot}`;
      const exists = state.sources.some((s) => s.id === id);
      const payload: SourceRecord = {
        id,
        citation: `County Ledger ${1900 + step.slot}`,
        source_type: 'vital_record',
      };
      return {
        revision_id: revisionId,
        entity_type: 'source',
        entity_id: id,
        action: exists ? 'update' : 'create',
        after_json: payload as unknown as EntityPayload,
      };
    }
    case 'upsert_media': {
      const id = `med_seq_${step.slot}`;
      const exists = state.media.some((m) => m.id === id);
      const payload: MediaItem = {
        id,
        kind: 'document_scan',
        person_id: step.onLiving ? 'per_sam' : 'per_henry',
        file: `/media/seq-${step.slot}.jpg`,
        caption: `Scan ${step.slot}`,
      };
      return {
        revision_id: revisionId,
        entity_type: 'media',
        entity_id: id,
        action: exists ? 'update' : 'create',
        after_json: payload as unknown as EntityPayload,
      };
    }
    case 'upsert_narrative': {
      const id = `nar_seq_${step.slot}`;
      const exists = state.narratives.some((n) => n.id === id);
      const targetPerson = step.onLiving ? 'per_sam' : 'per_clara';
      const payload: Narrative = {
        id,
        slug: `seq-story-${step.slot}`,
        kind: 'family_story',
        subject_person_id: targetPerson,
        title: `Story ${step.slot}`,
        summary: `Summary ${step.slot}`,
        person_ids: [targetPerson],
        place_ids: ['plc_riverdale'],
        event_ids: [],
        source_ids: ['src_1880'],
        body_md: `Body ${step.slot}`,
      };
      return {
        revision_id: revisionId,
        entity_type: 'narrative',
        entity_id: id,
        action: exists ? 'update' : 'create',
        after_json: payload as unknown as EntityPayload,
      };
    }
    case 'upsert_kinship': {
      const edge: KinshipEdge =
        step.slot === 1
          ? { from: 'per_henry', to: 'per_sam', relation: 'parent' }
          : { from: 'per_clara', to: 'per_sam', relation: 'parent' };
      const id = deriveKinshipEdgeId(edge);
      const exists = state.kinship.some((k) => deriveKinshipEdgeId(k) === id);
      return {
        revision_id: revisionId,
        entity_type: 'kinship_edge',
        entity_id: id,
        action: exists ? 'update' : 'create',
        after_json: edge as unknown as EntityPayload,
      };
    }
  }
}

describe('Differential: chained & batched patchCompiledBundle() vs full compileArchive()', () => {
  it('matches full compileArchive() identically across multi-step seeded mutation sequences in both modes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<BuildMode>('public', 'private'),
        fc.array(stepArb, { minLength: 2, maxLength: 6 }),
        (mode, steps) => {
          let state = createInitialState();
          const initialBundle = compileArchive({
            ...state,
            siteConfig: SITE_CONFIG,
            mode,
            generatedAt: FIXED_GENERATED_AT,
            maxRevisionId: 10,
          }).bundle;

          let chainedBundle = initialBundle;
          const allMutations: BundlePatchMutation[] = [];

          for (const [idx, step] of steps.entries()) {
            const revId = 11 + idx;
            const mutation = buildMutation(step, state, revId);
            allMutations.push(mutation);
            state = applyMutation(state, mutation);
            chainedBundle = patchCompiledBundle(chainedBundle, [mutation], SITE_CONFIG, mode, {
              generatedAt: FIXED_GENERATED_AT,
            });
          }

          const batchedBundle = patchCompiledBundle(initialBundle, allMutations, SITE_CONFIG, mode, {
            generatedAt: FIXED_GENERATED_AT,
          });

          const expectedFull = compileArchive({
            ...state,
            siteConfig: SITE_CONFIG,
            mode,
            generatedAt: FIXED_GENERATED_AT,
            maxRevisionId: 10 + steps.length,
          }).bundle;

          expect(chainedBundle).toEqual(expectedFull);
          expect(batchedBundle).toEqual(expectedFull);
        }
      ),
      { seed: DIFFERENTIAL_SEED, numRuns: 100 }
    );
  });
});
