import { CORE_SCHEMA, load as loadJsYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  KinshipEdgeSchema,
  MediaItemSchema,
  NarrativeSchema,
  PlaceSchema,
  parseEventsYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  RawEventSchema,
  RawPersonSchema,
  SourceRecordSchema,
  stringifyYaml,
} from './index.js';

describe('fastEntities owned-input, stripping, and rejection parity with Zod', () => {
  it('strips unknown extra keys via Zod fallback while reusing canonical owned objects cleanly', () => {
    const peopleWithExtra = stringifyYaml([
      {
        id: 'per_alder_extra',
        slug: 'arthur-alder',
        full_name: 'Arthur Alder',
        given_name: 'Arthur',
        surname: 'Alder',
        alt_names: ['Art Alder'],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1850',
        death_edtf: '1920',
        portrait_url: null,
        extra_unrecognized_field: 'strip_me',
      },
    ]);
    expect(parsePeopleYaml(peopleWithExtra)).toEqual(
      RawPersonSchema.array().parse(loadJsYaml(peopleWithExtra, { schema: CORE_SCHEMA }))
    );

    const eventsWithExtra = stringifyYaml([
      {
        id: 'evt_alder_extra',
        title: 'Census',
        scope: 'personal',
        event_kind: 'point_event',
        edtf_date: '1880',
        place_id: null,
        summary: 'Note',
        participants: [{ person_id: 'per_alder_extra', role: 'head', extra_pt: 1 }],
        sources: [{ source_id: 'src_1', confidence: 'high', claimed_date: 1880, extra_src: 1 }],
        extra_evt: true,
      },
    ]);
    expect(parseEventsYaml(eventsWithExtra)).toEqual(
      RawEventSchema.array().parse(loadJsYaml(eventsWithExtra, { schema: CORE_SCHEMA }))
    );

    const placesWithExtra = stringifyYaml([
      {
        id: 'plc_alder',
        slug: 'alder-town',
        name: 'Alder',
        full_name: 'Alder, MI',
        place_type: 'town',
        parent_id: null,
        lat: 42.8,
        lng: -85.8,
        extra_plc: 'strip',
      },
    ]);
    expect(parsePlacesYaml(placesWithExtra)).toEqual(
      PlaceSchema.array().parse(loadJsYaml(placesWithExtra, { schema: CORE_SCHEMA }))
    );

    const sourcesWithExtra = stringifyYaml([
      {
        id: 'src_alder',
        citation: 'Alder Register',
        source_type: 'vital',
        extra_src: 'strip',
      },
    ]);
    expect(parseSourcesYaml(sourcesWithExtra)).toEqual(
      SourceRecordSchema.array().parse(loadJsYaml(sourcesWithExtra, { schema: CORE_SCHEMA }))
    );

    const kinshipWithExtra = stringifyYaml([
      {
        from: 'per_alder_1',
        to: 'per_mercer_2',
        relation: 'spouse',
        extra_kin: 'strip',
      },
    ]);
    expect(parseKinshipYaml(kinshipWithExtra)).toEqual(
      KinshipEdgeSchema.array().parse(loadJsYaml(kinshipWithExtra, { schema: CORE_SCHEMA }))
    );

    const mediaWithExtra = stringifyYaml([
      {
        id: 'med_alder',
        kind: 'portrait',
        file: 'media/a.jpg',
        caption: 'Arthur',
        extra_med: 'strip',
      },
    ]);
    expect(parseMediaYaml(mediaWithExtra)).toEqual(
      MediaItemSchema.array().parse(loadJsYaml(mediaWithExtra, { schema: CORE_SCHEMA }))
    );

    const narrativesWithExtra = stringifyYaml([
      {
        id: 'nar_alder',
        slug: 'arthur-bio',
        title: 'Arthur Bio',
        body_md: 'Text',
        person_ids: ['per_alder_extra'],
        place_ids: ['plc_alder'],
        event_ids: ['evt_alder_extra'],
        source_ids: ['src_alder'],
        extra_nar: 'strip',
      },
    ]);
    expect(parseNarrativesYaml(narrativesWithExtra)).toEqual(
      NarrativeSchema.array().parse(loadJsYaml(narrativesWithExtra, { schema: CORE_SCHEMA }))
    );
  });

  it('rejects malformed optional fields across all 7 entity YAML parsers identically to Zod schemas', () => {
    const basePerson = {
      id: 'per_1',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
    };
    for (const badPatch of [
      { sex: 12 },
      { is_living: 'yes' },
      { lineage_group: 99 },
      { birth_edtf: { bad: true } },
      { portrait_url: 42 },
      { gedcom_xref: 42 },
      { branch: 42 },
      { thumb_url: 42 },
      { has_primary_source: 'yes' },
      { extensions: 'not-obj' },
      { pronunciation: { phonetic: '' } },
    ]) {
      expect(() => parsePeopleYaml(stringifyYaml([{ ...basePerson, ...badPatch }]))).toThrow();
    }

    const baseEvent = {
      id: 'evt_1',
      title: 'Event',
      scope: 'personal',
      event_kind: 'point_event',
    };
    for (const badPatch of [
      { edtf_date: { bad: true } },
      { place_id: 42 },
      { summary: 42 },
      { category: 42 },
      { place_precision: 42 },
      { severity_rank: 'high' },
      { source_url: 42 },
      { photo_url: 42 },
      { photo_placeholder_caption: 42 },
      { has_primary_source: 'yes' },
      { extensions: [] },
      { alternate_dates: 'bad' },
      { alternate_dates: [{ edtf_date: '1900', source_id: '' }] },
      { alternate_dates: [{ edtf_date: { bad: 1 }, source_id: 's1' }] },
      { alternate_dates: [{ edtf_date: '1900', source_id: 's1', note: 42 }] },
      { participants: 'bad' },
      { sources: 'bad' },
      { sources: [{ source_id: 's1', confidence: 'high', claimed_date: { bad: 1 } }] },
      { sources: [{ source_id: 's1', confidence: 'high', citation_detail: 42 }] },
      { sources: [{ source_id: 's1', confidence: 'high', scan_url: 42 }] },
      { sources: [{ source_id: 's1', confidence: 'high', scan_title: 42 }] },
    ]) {
      expect(() => parseEventsYaml(stringifyYaml([{ ...baseEvent, ...badPatch }]))).toThrow();
    }

    const basePlace = {
      id: 'plc_1',
      slug: 'alder',
      name: 'Alder',
      full_name: 'Alder, MI',
      place_type: 'town',
      parent_id: null,
      lat: 42,
      lng: -85,
    };
    for (const badPatch of [
      { summary: 42 },
      { photo_url: 42 },
      { photo_caption: 42 },
      { has_primary_source: 1 },
      { extensions: [] },
      { pronunciation: { ipa: 42 } },
    ]) {
      expect(() => parsePlacesYaml(stringifyYaml([{ ...basePlace, ...badPatch }]))).toThrow();
    }

    const baseSource = {
      id: 'src_1',
      citation: 'Alder Register',
      source_type: 'vital',
    };
    for (const badPatch of [
      { gedcom_xref: 42 },
      { author: 42 },
      { publisher: 42 },
      { repository: 42 },
      { url: 42 },
      { has_primary_source: 'bad' },
    ]) {
      expect(() => parseSourcesYaml(stringifyYaml([{ ...baseSource, ...badPatch }]))).toThrow();
    }

    expect(() =>
      parseKinshipYaml(stringifyYaml([{ from: 'per_1', to: 'per_2', relation: 'spouse', family_xref: 42 }]))
    ).toThrow();

    const baseMedia = {
      id: 'med_1',
      kind: 'portrait',
      file: 'media/a.jpg',
      caption: 'Caption',
    };
    for (const badPatch of [
      { date_edtf: { bad: 1 } },
      { source_id: 42 },
      { page: 1.5 },
      { person_id: 42 },
      { person_slug: 42 },
      { person_name: 42 },
      { event_id: 42 },
      { thumb_file: 42 },
      { provenance: 42 },
      { duration_seconds: -5 },
      { mime_type: '' },
      { poster_url: '' },
      { transcript_url: '' },
      { has_primary_source: 'bad' },
      { extensions: [] },
    ]) {
      expect(() => parseMediaYaml(stringifyYaml([{ ...baseMedia, ...badPatch }]))).toThrow();
    }

    const baseNarrative = {
      id: 'nar_1',
      slug: 'bio',
      title: 'Title',
      body_md: 'Body',
    };
    for (const badPatch of [
      { kind: 'novel' },
      { subject_person_id: '' },
      { summary: 42 },
      { date_edtf: { bad: 1 } },
      { updated_at: 42 },
      { has_primary_source: 'yes' },
      { extensions: [] },
    ]) {
      expect(() => parseNarrativesYaml(stringifyYaml([{ ...baseNarrative, ...badPatch }]))).toThrow();
    }
  });
});

describe('fastEntities additional required-field, pronunciation, and nested-array parity with Zod', () => {
  it('matches Zod parse or rejection across malformed nested arrays, pronunciation objects, and required identifiers', () => {
    const assertParity = (
      yamlText: string,
      fastFn: (text: string) => unknown,
      zodParse: (val: unknown) => unknown
    ) => {
      const raw = loadJsYaml(yamlText, { schema: CORE_SCHEMA });
      let zodOk = false;
      let zodVal: unknown;
      try {
        zodVal = zodParse(raw);
        zodOk = true;
      } catch {
        zodOk = false;
      }
      if (zodOk) {
        expect(fastFn(yamlText)).toEqual(zodVal);
      } else {
        expect(() => fastFn(yamlText)).toThrow();
      }
    };

    const basePerson = {
      id: 'per_1',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
    };
    for (const patch of [
      { id: '' },
      { slug: '' },
      { full_name: '' },
      { given_name: 42 },
      { surname: 42 },
      { alt_names: 'not-array' },
      { death_edtf: { bad: 1 } },
      { pronunciation: 'AL-der' },
      { pronunciation: { phonetic: 'AL-der', ipa: 42 } },
      { pronunciation: { phonetic: 'AL-der', source_label: 42 } },
      { pronunciation: { phonetic: 'AL-der', audio_url: 42 } },
      { pronunciation: { phonetic: 'AL-der', variants: 'bad' } },
      { pronunciation: { phonetic: 'AL-der', variants: [null] } },
      { pronunciation: { phonetic: 'AL-der', variants: [{ label: '', phonetic: 'AL-der' }] } },
    ]) {
      assertParity(stringifyYaml([{ ...basePerson, ...patch }]), parsePeopleYaml, (v) =>
        RawPersonSchema.array().parse(v)
      );
    }

    const baseEvent = { id: 'evt_1', title: 'Event', scope: 'personal', event_kind: 'point_event' };
    for (const patch of [
      { title: '' },
      { scope: 'invalid' },
      { event_kind: 'invalid' },
      { participants: [{ person_id: '', role: 'head' }] },
      { participants: [{ person_id: 'per_1', role: '' }] },
      { sources: [{ source_id: '', confidence: 'high' }] },
      { alternate_places: 'bad' },
      { alternate_places: [{ place_name: '', source_id: 'src_1' }] },
    ]) {
      assertParity(stringifyYaml([{ ...baseEvent, ...patch }]), parseEventsYaml, (v) =>
        RawEventSchema.array().parse(v)
      );
    }

    const basePlace = {
      id: 'plc_1',
      slug: 'alder',
      name: 'Alder',
      full_name: 'Alder, MI',
      place_type: 'town',
      parent_id: null,
      lat: 42,
      lng: -85,
    };
    for (const patch of [
      { id: '' },
      { slug: '' },
      { name: '' },
      { full_name: '' },
      { place_type: 'galaxy' },
      { parent_id: 42 },
      { lat: 'north' },
      { lng: 250 },
      { historical_names: 'bad' },
      { historical_names: [{ name: '' }] },
    ]) {
      assertParity(stringifyYaml([{ ...basePlace, ...patch }]), parsePlacesYaml, (v) =>
        PlaceSchema.array().parse(v)
      );
    }

    const baseSource = { id: 'src_1', citation: 'Alder Register', source_type: 'vital' };
    for (const patch of [{ id: '' }, { citation: '' }, { source_type: '' }]) {
      assertParity(stringifyYaml([{ ...baseSource, ...patch }]), parseSourcesYaml, (v) =>
        SourceRecordSchema.array().parse(v)
      );
    }

    for (const patch of [{ from: '' }, { to: '' }]) {
      assertParity(
        stringifyYaml([{ from: 'per_1', to: 'per_2', relation: 'spouse', ...patch }]),
        parseKinshipYaml,
        (v) => KinshipEdgeSchema.array().parse(v)
      );
    }

    const baseMedia = { id: 'med_1', kind: 'portrait', file: 'media/a.jpg', caption: 'Caption' };
    for (const patch of [{ id: '' }, { file: '' }, { caption: 42 }, { person_ids: 'bad' }, { page: 0 }]) {
      assertParity(stringifyYaml([{ ...baseMedia, ...patch }]), parseMediaYaml, (v) =>
        MediaItemSchema.array().parse(v)
      );
    }

    const baseNarrative = { id: 'nar_1', slug: 'bio', title: 'Title', body_md: 'Body' };
    for (const patch of [
      { id: '' },
      { slug: '' },
      { title: '' },
      { body_md: 42 },
      { person_ids: 'bad' },
      { place_ids: [42] },
      { event_ids: [42] },
      { source_ids: [42] },
    ]) {
      assertParity(stringifyYaml([{ ...baseNarrative, ...patch }]), parseNarrativesYaml, (v) =>
        NarrativeSchema.array().parse(v)
      );
    }
  });
});
