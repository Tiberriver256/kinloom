import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileArchive } from './compileArchive.js';
import { computeTreeLayout, TREE_NODE_W } from './domain/treeLayout.js';
import {
  daysSinceEpoch,
  edtfSortKey,
  edtfToBounds,
  edtfYear,
  formatEdtfDisplay,
  lastDayOfMonth,
  toJulianDayNumber,
} from './edtf.js';
import { buildFilteredGedcom7, escapeGedcomValue, formatEdtfToGedcomDate } from './gedcom/export.js';
import { parseGedcomText, unescapeGedcomValue } from './gedcom/parse.js';
import { applyPrivacyFilter, redactSinglePerson } from './privacy.js';
import { parseKinloomConfig } from './schemas/config.js';
import {
  findIpaGlyphsInPhonetic,
  hasIpaGlyphsInPhonetic,
  type KinshipEdge,
  type MediaItem,
  mergePronunciationLexicons,
  type Narrative,
  type Person,
  type Place,
  type Pronunciation,
  type RawEvent,
  type RawPerson,
  resolvePersonPronunciation,
  resolvePlacePronunciation,
  type SourceRecord,
  tokenizePersonName,
} from './schemas/entities.js';
import {
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  serializeEventsYaml,
  serializeKinloomConfigYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from './yaml.js';

const FIXED_SEED = 20261126;

const TEST_SITE_CONFIG = parseKinloomConfig({
  site: {
    title: 'Alder Valley Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_VALLEY_ARCHIVE',
  },
  defaultBranchId: 'alder_main',
  branches: [
    {
      id: 'alder_main',
      label: 'Alder Main',
      surnames: ['Alder'],
      lineageGroups: ['ancestor', 'pivot_ancestor', 'descendant'],
    },
    {
      id: 'mercer_side',
      label: 'Mercer Side',
      surnames: ['Mercer'],
      lineageGroups: ['spouse_line'],
    },
  ],
  privacy: {
    livingCutoffYears: 101,
    referenceYear: 2026,
    privateModeShowsBirthYear: true,
    stripLivingPortraits: true,
    stripLivingResidenceSpans: true,
    markGedcomLivingConfidential: true,
  },
});

const safeWordArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{2,10}$/);
const safeIdArb = fc.stringMatching(/^[a-z][a-z0-9_]{2,12}$/);

const validDateTripleArb = fc
  .record({
    year: fc.integer({ min: 1600, max: 2099 }),
    month: fc.integer({ min: 1, max: 12 }),
    daySeed: fc.integer({ min: 1, max: 31 }),
  })
  .map(({ year, month, daySeed }) => {
    const maxDay = lastDayOfMonth(year, month);
    const day = Math.min(daySeed, maxDay);
    return { year, month, day };
  });

function formatYmd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

describe('EDTF property-based invariants (deterministic seed)', () => {
  it('lastDayOfMonth obeys Gregorian leap-year rules across all years and months', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1583, max: 2400 }), fc.integer({ min: 1, max: 12 }), (year, month) => {
        const last = lastDayOfMonth(year, month);
        expect(last).toBeGreaterThanOrEqual(28);
        expect(last).toBeLessThanOrEqual(31);
        if (month === 2) {
          const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
          expect(last).toBe(isLeap ? 29 : 28);
        } else if ([4, 6, 9, 11].includes(month)) {
          expect(last).toBe(30);
        } else {
          expect(last).toBe(31);
        }
      }),
      { seed: FIXED_SEED, numRuns: 200 }
    );
  });

  it('toJulianDayNumber and daysSinceEpoch are strictly monotonic with calendar ordering', () => {
    fc.assert(
      fc.property(validDateTripleArb, validDateTripleArb, (a, b) => {
        const jdnA = toJulianDayNumber(a.year, a.month, a.day);
        const jdnB = toJulianDayNumber(b.year, b.month, b.day);
        const cmp = a.year - b.year || a.month - b.month || a.day - b.day;
        if (cmp < 0) {
          expect(jdnA).toBeLessThan(jdnB);
          expect(daysSinceEpoch(a.year, a.month, a.day)).toBeLessThan(daysSinceEpoch(b.year, b.month, b.day));
        } else if (cmp > 0) {
          expect(jdnA).toBeGreaterThan(jdnB);
          expect(daysSinceEpoch(a.year, a.month, a.day)).toBeGreaterThan(
            daysSinceEpoch(b.year, b.month, b.day)
          );
        } else {
          expect(jdnA).toBe(jdnB);
          expect(daysSinceEpoch(a.year, a.month, a.day)).toBe(daysSinceEpoch(b.year, b.month, b.day));
        }
      }),
      { seed: FIXED_SEED + 1, numRuns: 250 }
    );
  });

  it('edtfToBounds, edtfYear, edtfSortKey, and formatEdtfDisplay preserve ordering and never throw', () => {
    const qualifierArb = fc.constantFrom('', '~', '?', '%');
    const edtfArb = fc.oneof(
      fc
        .tuple(fc.integer({ min: 1650, max: 2050 }), qualifierArb)
        .map(([y, q]) => ({ raw: `${y}${q}`, expectedYear: y })),
      fc
        .tuple(fc.integer({ min: 1650, max: 2050 }), fc.integer({ min: 1, max: 12 }), qualifierArb)
        .map(([y, m, q]) => ({
          raw: `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}${q}`,
          expectedYear: y,
        })),
      fc.tuple(validDateTripleArb, qualifierArb).map(([d, q]) => ({
        raw: `${formatYmd(d.year, d.month, d.day)}${q}`,
        expectedYear: d.year,
      })),
      fc.tuple(validDateTripleArb, validDateTripleArb).map(([a, b]) => {
        const [first, second] =
          toJulianDayNumber(a.year, a.month, a.day) <= toJulianDayNumber(b.year, b.month, b.day)
            ? [a, b]
            : [b, a];
        return {
          raw: `${formatYmd(first.year, first.month, first.day)}/${formatYmd(second.year, second.month, second.day)}`,
          expectedYear: first.year,
        };
      })
    );

    fc.assert(
      fc.property(edtfArb, ({ raw, expectedYear }) => {
        const bounds = edtfToBounds(raw);
        expect(bounds).not.toBeNull();
        if (bounds) {
          expect(bounds[0]).toBeLessThanOrEqual(bounds[1]);
        }
        expect(edtfYear(raw)).toBe(expectedYear);
        const display = formatEdtfDisplay(raw);
        expect(display.length).toBeGreaterThan(0);
        const gedcom = formatEdtfToGedcomDate(raw);
        expect(gedcom.length).toBeGreaterThan(0);
      }),
      { seed: FIXED_SEED + 2, numRuns: 200 }
    );

    fc.assert(
      fc.property(validDateTripleArb, validDateTripleArb, (a, b) => {
        const keyA = edtfSortKey(formatYmd(a.year, a.month, a.day));
        const keyB = edtfSortKey(formatYmd(b.year, b.month, b.day));
        const jdnA = toJulianDayNumber(a.year, a.month, a.day);
        const jdnB = toJulianDayNumber(b.year, b.month, b.day);
        if (jdnA < jdnB) {
          expect(keyA).toBeLessThan(keyB);
        } else if (jdnA > jdnB) {
          expect(keyA).toBeGreaterThan(keyB);
        } else {
          expect(keyA).toBe(keyB);
        }
      }),
      { seed: FIXED_SEED + 3, numRuns: 200 }
    );
  });
});

describe('Privacy redaction invariants across arbitrary graph topologies', () => {
  const randomGraphArb = fc.integer({ min: 2, max: 10 }).chain((count) =>
    fc.record({
      count: fc.constant(count),
      livingFlags: fc.array(fc.boolean(), { minLength: count, maxLength: count }),
      birthYears: fc.array(fc.integer({ min: 1820, max: 2015 }), { minLength: count, maxLength: count }),
      edges: fc.array(
        fc.record({
          fromIdx: fc.integer({ min: 0, max: count - 1 }),
          toIdx: fc.integer({ min: 0, max: count - 1 }),
          relation: fc.constantFrom<'parent' | 'child' | 'spouse'>('parent', 'child', 'spouse'),
        }),
        { minLength: 0, maxLength: count * 2 }
      ),
      eventSpecs: fc.array(
        fc.record({
          participantIndices: fc.uniqueArray(fc.integer({ min: 0, max: count - 1 }), {
            minLength: 1,
            maxLength: Math.min(3, count),
          }),
          mentionLivingIdx: fc.integer({ min: 0, max: count - 1 }),
          year: fc.integer({ min: 1850, max: 2024 }),
          kind: fc.constantFrom<'point_event' | 'residence_anchor'>('point_event', 'residence_anchor'),
        }),
        { minLength: 1, maxLength: 12 }
      ),
    })
  );

  it('never leaks living names, birth dates, portraits, residence spans, media, or narratives in public mode', () => {
    fc.assert(
      fc.property(randomGraphArb, ({ count, livingFlags, birthYears, edges, eventSpecs }) => {
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
          {
            id: 'src_vital',
            citation: 'Cedar County Vital Register',
            source_type: 'vital_record',
          },
        ];

        const people: RawPerson[] = Array.from({ length: count }, (_, idx) => {
          const isLiving = livingFlags[idx] || birthYears[idx] > 1925;
          const uniqueToken = `Zylph${idx}Alder`;
          return {
            id: `per_${idx}`,
            slug: `person-${idx}`,
            full_name: `${uniqueToken} Person${idx}`,
            given_name: uniqueToken,
            surname: `Person${idx}`,
            alt_names: [`AltZylph${idx}`],
            sex: idx % 2 === 0 ? 'M' : 'F',
            is_living: isLiving,
            lineage_group: idx === 0 ? 'ancestor' : 'descendant',
            branch: 'alder_main',
            birth_edtf: `${birthYears[idx]}-04-12`,
            death_edtf: isLiving ? '' : `${Math.min(birthYears[idx] + 65, 1990)}`,
            portrait_url: `/media/portrait-${idx}.jpg`,
            thumb_url: `/media/thumb-${idx}.jpg`,
            pronunciation: { phonetic: `ZILF-${idx}` },
          };
        });

        const livingPeople = people.filter((p) => p.is_living);
        const livingIds = new Set(livingPeople.map((p) => p.id));
        const livingTokens = livingPeople.flatMap((p) => [p.full_name, ...p.alt_names]);

        const kinship: KinshipEdge[] = [];
        const edgeKeys = new Set<string>();
        for (const e of edges) {
          if (e.fromIdx === e.toIdx) continue;
          const key = `${e.fromIdx}:${e.toIdx}:${e.relation}`;
          if (edgeKeys.has(key)) continue;
          edgeKeys.add(key);
          kinship.push({
            from: `per_${e.fromIdx}`,
            to: `per_${e.toIdx}`,
            relation: e.relation,
          });
        }

        const events: RawEvent[] = eventSpecs.map((spec, idx) => {
          const mentioned = people[spec.mentionLivingIdx];
          return {
            id: `evt_${idx}`,
            title: `Gathering for ${mentioned.full_name}`,
            scope: 'family',
            event_kind: spec.kind,
            edtf_date: `${spec.year}-06-15`,
            place_id: 'plc_riverdale',
            summary: `Recorded with ${mentioned.full_name} (${mentioned.alt_names[0]}).`,
            photo_url: `/media/event-${idx}.jpg`,
            participants: spec.participantIndices.map((pi) => ({
              person_id: `per_${pi}`,
              role: 'participant',
            })),
            sources: [{ source_id: 'src_vital', confidence: 'high' }],
          };
        });

        const media: MediaItem[] = people.map((p, idx) => ({
          id: `med_${idx}`,
          kind: 'portrait',
          person_id: p.id,
          person_ids: [p.id],
          event_id: events[idx % events.length]?.id ?? null,
          file: `/media/photo-${idx}.jpg`,
          caption: `Portrait of ${p.full_name}`,
        }));

        const narratives: Narrative[] = people.map((p, idx) => ({
          id: `nar_${idx}`,
          slug: `story-${idx}`,
          kind: 'biography',
          subject_person_id: p.id,
          title: `Biography of ${p.full_name}`,
          summary: `Life notes for ${p.full_name}`,
          person_ids: [p.id],
          place_ids: ['plc_riverdale'],
          event_ids: [],
          source_ids: ['src_vital'],
          body_md: `Detailed story mentioning ${p.full_name}.`,
        }));

        const { bundle } = compileArchive({
          people,
          events,
          places,
          sources,
          kinship,
          media,
          narratives,
          siteConfig: TEST_SITE_CONFIG,
          mode: 'public',
          generatedAt: '2026-11-26T00:00:00.000Z',
        });

        // 1. Every living person is completely redacted
        for (const bp of bundle.people) {
          if (livingIds.has(bp.id)) {
            expect(bp.is_living).toBe(true);
            expect(bp.full_name).toBe('Living');
            expect(bp.given_name).toBe('Living');
            expect(bp.surname).toBe('');
            expect(bp.alt_names).toEqual([]);
            expect(bp.birth_edtf).toBe('');
            expect(bp.death_edtf).toBe('');
            expect(bp.birth_year).toBeNull();
            expect(bp.portrait_url).toBeNull();
            expect(bp.thumb_url).toBeNull();
            expect(bp.pronunciation).toBeUndefined();
          }
        }

        // 2. No living-only event survives; no living-participant event retains place/photo or living names
        for (const ev of bundle.events) {
          if (ev.participants.length > 0) {
            const allLiving = ev.participants.every((pt) => livingIds.has(pt.person_id));
            expect(allLiving).toBe(false);
          }
          const anyLiving = ev.participants.some((pt) => livingIds.has(pt.person_id));
          if (anyLiving) {
            expect(ev.place_id).toBeNull();
            expect(ev.photo_url).toBeUndefined();
            for (const token of livingTokens) {
              expect(ev.title).not.toContain(token);
              expect(ev.summary).not.toContain(token);
            }
          }
        }

        // 3. No living person has residence spans
        for (const span of bundle.residence_spans) {
          expect(livingIds.has(span.person_id)).toBe(false);
        }

        // 4. No media references a living person directly
        for (const m of bundle.media ?? []) {
          if (m.person_id) {
            expect(livingIds.has(m.person_id)).toBe(false);
          }
          for (const pid of m.person_ids ?? []) {
            expect(livingIds.has(pid)).toBe(false);
          }
        }

        // 5. No narrative targets or lists a living person
        for (const n of bundle.narratives ?? []) {
          if (n.subject_person_id) {
            expect(livingIds.has(n.subject_person_id)).toBe(false);
          }
          for (const pid of n.person_ids) {
            expect(livingIds.has(pid)).toBe(false);
          }
        }
      }),
      { seed: FIXED_SEED + 10, numRuns: 75 }
    );
  });

  it('redactSinglePerson and applyPrivacyFilter never leak living portraits in either mode', () => {
    fc.assert(
      fc.property(
        safeWordArb,
        safeWordArb,
        fc.integer({ min: 1940, max: 2020 }),
        fc.constantFrom<'public' | 'private'>('public', 'private'),
        (given, sur, birthYear, mode) => {
          const person: RawPerson = {
            id: 'per_living_1',
            slug: 'living-1',
            full_name: `${given} ${sur}`,
            given_name: given,
            surname: sur,
            alt_names: [`${given} Alt`],
            sex: 'U',
            is_living: true,
            lineage_group: 'descendant',
            branch: 'alder_main',
            birth_edtf: `${birthYear}-07-20`,
            death_edtf: '',
            portrait_url: '/media/secret.jpg',
            thumb_url: '/media/secret-thumb.jpg',
            pronunciation: { phonetic: 'TEST' },
          };

          const redacted = redactSinglePerson(person, mode, { privacy: TEST_SITE_CONFIG.privacy });
          expect(redacted.portrait_url).toBeNull();
          expect(redacted.thumb_url).toBeNull();
          expect(redacted.pronunciation).toBeUndefined();
          if (mode === 'public') {
            expect(redacted.full_name).toBe('Living');
            expect(redacted.birth_edtf).toBe('');
          } else {
            expect(redacted.birth_edtf).toBe(String(birthYear));
          }

          const filtered = applyPrivacyFilter([person], [], [], mode, { privacy: TEST_SITE_CONFIG.privacy });
          expect(filtered.people[0].portrait_url).toBeNull();
          expect(filtered.residenceSpans).toEqual([]);
        }
      ),
      { seed: FIXED_SEED + 11, numRuns: 100 }
    );
  });
});

describe('GEDCOM 7 export / parse round-trip invariants', () => {
  it('escapeGedcomValue and unescapeGedcomValue round-trip arbitrary strings containing @', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 80 }), (input) => {
        const escaped = escapeGedcomValue(input);
        expect(unescapeGedcomValue(escaped)).toBe(input.trim());
      }),
      { seed: FIXED_SEED + 20, numRuns: 200 }
    );
  });

  it('buildFilteredGedcom7 -> parseGedcom preserves names, counts, and RESN CONFIDENTIAL for living people', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            given: safeWordArb,
            surname: safeWordArb,
            sex: fc.constantFrom<'M' | 'F' | 'U'>('M', 'F', 'U'),
            isLiving: fc.boolean(),
            birthYear: fc.integer({ min: 1840, max: 1995 }),
          }),
          { minLength: 1, maxLength: 8 }
        ),
        (specs) => {
          const places: Place[] = [
            {
              id: 'plc_1',
              slug: 'oakton',
              name: 'Oakton',
              full_name: 'Oakton, Ohio, USA',
              place_type: 'town',
              parent_id: null,
              lat: 40.1,
              lng: -83.1,
            },
          ];
          const sources: SourceRecord[] = [
            { id: 'src_1', citation: 'County Register 1900', source_type: 'vital_record' },
          ];
          const people: RawPerson[] = specs.map((s, idx) => {
            const living = s.isLiving || s.birthYear > 1925;
            return {
              id: `per_${idx}`,
              slug: `p-${idx}`,
              full_name: `${s.given} ${s.surname}`,
              given_name: s.given,
              surname: s.surname,
              alt_names: [],
              sex: s.sex,
              is_living: living,
              lineage_group: 'ancestor',
              branch: 'alder_main',
              birth_edtf: `${s.birthYear}`,
              death_edtf: living ? '' : `${Math.min(s.birthYear + 60, 1985)}`,
              portrait_url: null,
            };
          });

          const { bundle } = compileArchive({
            people,
            events: [],
            places,
            sources,
            kinship: [],
            siteConfig: TEST_SITE_CONFIG,
            mode: 'private',
            generatedAt: '2026-11-26T00:00:00.000Z',
          });

          const gedcomText = buildFilteredGedcom7({
            people: bundle.people,
            bundle,
            placesById: new Map(bundle.places.map((p) => [p.id, p])),
            sourcesById: new Map(bundle.sources.map((s) => [s.id, s])),
            siteConfig: TEST_SITE_CONFIG,
            exportDate: new Date('2026-11-26T00:00:00.000Z'),
          });

          const parsed = parseGedcomText(gedcomText);
          expect(parsed.indis.size).toBe(bundle.people.length);

          for (const [idx, person] of bundle.people.entries()) {
            const indi = parsed.indis.get(`@I${idx + 1}@`);
            expect(indi).toBeDefined();
            expect(indi?.givenName).toBe(person.given_name);
            expect(indi?.surname).toBe(person.surname);
            if (person.is_living) {
              expect(indi?.resn).toBe('CONFIDENTIAL');
            } else {
              expect(indi?.resn).toBeUndefined();
            }
          }
        }
      ),
      { seed: FIXED_SEED + 21, numRuns: 60 }
    );
  });
});

describe('YAML parse / serialize deterministic round-trip invariants', () => {
  const safeTextArb = fc.stringMatching(/^[A-Za-z0-9 ,.:;'\-()]{1,40}$/);

  it('round-trips and idempotently serializes all 7 YAML entity types and kinloom.config.yaml', () => {
    fc.assert(
      fc.property(safeIdArb, safeWordArb, safeWordArb, safeTextArb, (id, given, sur, text) => {
        const people: RawPerson[] = [
          {
            id: `per_${id}`,
            slug: `slug-${id}`,
            full_name: `${given} ${sur}`,
            given_name: given,
            surname: sur,
            alt_names: [`${given} Alt`],
            sex: 'F',
            is_living: false,
            lineage_group: 'ancestor',
            branch: 'alder_main',
            birth_edtf: '1880-05-01',
            death_edtf: '1952',
            portrait_url: null,
          },
        ];
        const yPeople1 = serializePeopleYaml(people, { sortById: true });
        const parsedPeople = parsePeopleYaml(yPeople1);
        expect(parsedPeople).toEqual(people);
        expect(serializePeopleYaml(parsedPeople, { sortById: true })).toBe(yPeople1);

        const places: Place[] = [
          {
            id: `plc_${id}`,
            slug: `plc-${id}`,
            name: given,
            full_name: `${given}, Ohio, USA`,
            place_type: 'town',
            parent_id: null,
            lat: 40.25,
            lng: -83.15,
            summary: text.trim() || 'Town summary',
          },
        ];
        const yPlaces1 = serializePlacesYaml(places, { sortById: true });
        const parsedPlaces = parsePlacesYaml(yPlaces1);
        expect(parsedPlaces).toEqual(places);
        expect(serializePlacesYaml(parsedPlaces, { sortById: true })).toBe(yPlaces1);

        const sources: SourceRecord[] = [
          {
            id: `src_${id}`,
            citation: text.trim() || 'Archival Source',
            source_type: 'census',
          },
        ];
        const ySources1 = serializeSourcesYaml(sources, { sortById: true });
        const parsedSources = parseSourcesYaml(ySources1);
        expect(parsedSources).toEqual(sources);
        expect(serializeSourcesYaml(parsedSources, { sortById: true })).toBe(ySources1);

        const events: RawEvent[] = [
          {
            id: `evt_${id}`,
            title: text.trim() || 'Census record',
            scope: 'personal',
            event_kind: 'point_event',
            edtf_date: '1900',
            place_id: `plc_${id}`,
            summary: text.trim() || 'Event summary',
            participants: [{ person_id: `per_${id}`, role: 'subject' }],
            sources: [{ source_id: `src_${id}`, confidence: 'high' }],
          },
        ];
        const yEvents1 = serializeEventsYaml(events, { sortById: true });
        const parsedEvents = parseEventsYaml(yEvents1);
        expect(parsedEvents).toEqual(events);
        expect(serializeEventsYaml(parsedEvents, { sortById: true })).toBe(yEvents1);

        const kinship: KinshipEdge[] = [{ from: `per_${id}`, to: `per_other_${id}`, relation: 'parent' }];
        const yKin1 = serializeKinshipYaml(kinship, { sortDeterministic: true });
        const parsedKin = parseKinshipYaml(yKin1);
        expect(parsedKin).toEqual(kinship);
        expect(serializeKinshipYaml(parsedKin, { sortDeterministic: true })).toBe(yKin1);

        const media: MediaItem[] = [
          {
            id: `med_${id}`,
            kind: 'document_scan',
            person_id: `per_${id}`,
            file: `/media/${id}.jpg`,
            caption: text.trim() || 'Scan',
          },
        ];
        const yMedia1 = serializeMediaYaml(media, { sortById: true });
        const parsedMedia = parseMediaYaml(yMedia1);
        expect(parsedMedia).toEqual(media);
        expect(serializeMediaYaml(parsedMedia, { sortById: true })).toBe(yMedia1);

        const narratives: Narrative[] = [
          {
            id: `nar_${id}`,
            slug: `nar-${id}`,
            kind: 'biography',
            subject_person_id: `per_${id}`,
            title: text.trim() || 'Biography',
            summary: text.trim() || 'Summary',
            person_ids: [`per_${id}`],
            place_ids: [`plc_${id}`],
            event_ids: [`evt_${id}`],
            source_ids: [`src_${id}`],
            body_md: `Paragraph about ${given} ${sur}.`,
          },
        ];
        const yNar1 = serializeNarrativesYaml(narratives, { sortById: true });
        const parsedNar = parseNarrativesYaml(yNar1);
        expect(parsedNar).toEqual(narratives);
        expect(serializeNarrativesYaml(parsedNar, { sortById: true })).toBe(yNar1);

        const yCfg1 = serializeKinloomConfigYaml(TEST_SITE_CONFIG);
        const parsedCfg = parseKinloomConfigYaml(yCfg1);
        expect(parsedCfg).toEqual(TEST_SITE_CONFIG);
        expect(serializeKinloomConfigYaml(parsedCfg)).toBe(yCfg1);
      }),
      { seed: FIXED_SEED + 30, numRuns: 80 }
    );
  });
});

describe('Pronunciation composition & disambiguation invariants', () => {
  const tokenWordArb = fc.stringMatching(/^[A-Z][a-z]{3,9}$/);

  it('living people always resolve to null regardless of lexicon or explicit override', () => {
    fc.assert(
      fc.property(tokenWordArb, tokenWordArb, (given, surname) => {
        const lexicon: Record<string, Pronunciation> = {
          [given]: { phonetic: `${given.toUpperCase()}-1` },
          [surname]: { phonetic: `${surname.toUpperCase()}-2` },
        };
        const resolved = resolvePersonPronunciation(
          {
            id: 'per_living',
            is_living: true,
            full_name: `${given} ${surname}`,
            given_name: given,
            surname,
            pronunciation: { phonetic: 'EXPLICIT' },
          },
          lexicon
        );
        expect(resolved).toBeNull();
      }),
      { seed: FIXED_SEED + 40, numRuns: 100 }
    );
  });

  it('composes full-name pronunciations when all tokens exist and falls back to surname otherwise', () => {
    fc.assert(
      fc.property(
        tokenWordArb,
        tokenWordArb.filter((s) => s.length >= 4),
        (given, surname) => {
          fc.pre(given.toLowerCase() !== surname.toLowerCase());
          const fullLexicon: Record<string, Pronunciation> = {
            [given]: { phonetic: `GIV-${given.toUpperCase()}` },
            [surname]: { phonetic: `SUR-${surname.toUpperCase()}` },
          };
          const person = {
            id: 'per_1',
            is_living: false,
            full_name: `${given} ${surname}`,
            given_name: given,
            surname,
          };

          const tokens = tokenizePersonName(person);
          expect(tokens).toEqual([given, surname]);

          const full = resolvePersonPronunciation(person, fullLexicon);
          expect(full?.coverage).toBe('full');
          expect(full?.resolvedFrom).toBe('composed');
          expect(full?.phonetic).toContain(`GIV-${given.toUpperCase()}`);
          expect(full?.phonetic).toContain(`SUR-${surname.toUpperCase()}`);

          // Explicit person override always takes precedence
          const explicit = resolvePersonPronunciation(
            { ...person, pronunciation: { phonetic: 'CUSTOM-OVERRIDE' } },
            fullLexicon
          );
          expect(explicit?.resolvedFrom).toBe('person');
          expect(explicit?.phonetic).toBe('CUSTOM-OVERRIDE');

          // Surname-only fallback when given name is absent from lexicon
          const surnameOnly = resolvePersonPronunciation(person, {
            [surname]: { phonetic: `SUR-${surname.toUpperCase()}` },
          });
          expect(surnameOnly?.coverage).toBe('surname');
          expect(surnameOnly?.resolvedFrom).toBe('lexicon_surname');
          expect(surnameOnly?.matchedPart).toBe(surname);
        }
      ),
      { seed: FIXED_SEED + 41, numRuns: 100 }
    );
  });

  it('mergePronunciationLexicons deduplicates case-insensitively with override precedence and disambiguates qualified places', () => {
    fc.assert(
      fc.property(tokenWordArb, tokenWordArb, (city, state) => {
        fc.pre(city.toLowerCase() !== state.toLowerCase());
        const merged = mergePronunciationLexicons(
          { [city.toLowerCase()]: { phonetic: 'BASE' } },
          { [city]: { phonetic: 'OVERRIDE' } }
        );
        const lowerKeys = Object.keys(merged).map((k) => k.toLowerCase());
        expect(new Set(lowerKeys).size).toBe(lowerKeys.length);
        expect(merged[city]?.phonetic).toBe('OVERRIDE');

        // Qualified place key wins over bare place key
        const placeLexicon: Record<string, Pronunciation> = {
          [city]: { phonetic: 'BARE-CITY' },
          [`${city}, ${state}`]: { phonetic: 'QUALIFIED-CITY' },
        };
        const resolved = resolvePlacePronunciation(
          {
            id: 'plc_test',
            name: city,
            full_name: `${city}, Cedar County, ${state}, United States`,
          },
          placeLexicon
        );
        expect(resolved?.phonetic).toBe('QUALIFIED-CITY');
      }),
      { seed: FIXED_SEED + 42, numRuns: 80 }
    );
  });

  it('findIpaGlyphsInPhonetic and hasIpaGlyphsInPhonetic agree on plain ASCII vs IPA strings', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z \-']{1,24}$/), (asciiRespelling) => {
        expect(findIpaGlyphsInPhonetic(asciiRespelling)).toEqual([]);
        expect(hasIpaGlyphsInPhonetic(asciiRespelling)).toBe(false);
        expect(hasIpaGlyphsInPhonetic(`${asciiRespelling} ə`)).toBe(true);
      }),
      { seed: FIXED_SEED + 43, numRuns: 80 }
    );
  });
});

describe('Tree layout invariants across arbitrary DAG family graphs', () => {
  const dagGraphArb = fc.integer({ min: 1, max: 16 }).chain((count) =>
    fc.record({
      count: fc.constant(count),
      // Edges only from smaller index (earlier generation) to larger index to guarantee acyclicity
      parentEdges: fc.array(
        fc
          .tuple(
            fc.integer({ min: 0, max: Math.max(0, count - 2) }),
            fc.integer({ min: 1, max: Math.max(1, count - 1) })
          )
          .filter(([a, b]) => a < b),
        { minLength: 0, maxLength: count * 2 }
      ),
      spousePairs: fc.array(
        fc
          .tuple(
            fc.integer({ min: 0, max: Math.max(0, count - 2) }),
            fc.integer({ min: 1, max: Math.max(1, count - 1) })
          )
          .filter(([a, b]) => a < b),
        { minLength: 0, maxLength: Math.floor(count / 2) }
      ),
    })
  );

  it('places every node with finite coordinates, positive bounds, and zero horizontal overlaps per row', () => {
    fc.assert(
      fc.property(dagGraphArb, ({ count, parentEdges, spousePairs }) => {
        const people: Person[] = Array.from({ length: count }, (_, idx) => ({
          id: `per_${idx}`,
          slug: `person-${idx}`,
          full_name: `Person ${idx} Alder`,
          given_name: `Person${idx}`,
          surname: 'Alder',
          alt_names: [],
          sex: idx % 2 === 0 ? 'M' : 'F',
          is_living: false,
          lineage_group: 'ancestor',
          branch: 'alder_main',
          birth_edtf: `${1820 + idx * 5}`,
          death_edtf: `${1885 + idx * 5}`,
          birth_year: 1820 + idx * 5,
          death_year: 1885 + idx * 5,
          portrait_url: null,
          thumb_url: null,
          event_count: 0,
          media_count: 0,
          primary_place_id: null,
        }));

        const kinship: KinshipEdge[] = [];
        const seen = new Set<string>();
        const parentCountByChild = new Map<number, number>();
        for (const [parentIdx, childIdx] of parentEdges) {
          if ((parentCountByChild.get(childIdx) ?? 0) >= 2) continue;
          const key = `p:${parentIdx}:${childIdx}`;
          if (seen.has(key)) continue;
          seen.add(key);
          parentCountByChild.set(childIdx, (parentCountByChild.get(childIdx) ?? 0) + 1);
          kinship.push({ from: `per_${parentIdx}`, to: `per_${childIdx}`, relation: 'parent' });
        }

        const married = new Set<number>();
        for (const [a, b] of spousePairs) {
          if (married.has(a) || married.has(b)) continue;
          if (seen.has(`p:${a}:${b}`)) continue;
          married.add(a);
          married.add(b);
          kinship.push({ from: `per_${a}`, to: `per_${b}`, relation: 'spouse' });
        }

        const layout = computeTreeLayout({
          people,
          kinship,
          branchFilter: 'all',
          defaultBranchId: 'alder_main',
          mode: 'full',
        });

        expect(layout.nodes.length).toBe(count);
        expect(layout.byId.size).toBe(count);
        expect(Number.isFinite(layout.bounds.minX)).toBe(true);
        expect(Number.isFinite(layout.bounds.maxX)).toBe(true);
        expect(Number.isFinite(layout.bounds.minY)).toBe(true);
        expect(Number.isFinite(layout.bounds.maxY)).toBe(true);
        expect(layout.bounds.maxX).toBeGreaterThan(layout.bounds.minX);
        expect(layout.bounds.maxY).toBeGreaterThan(layout.bounds.minY);

        const rows = new Map<number, number[]>();
        for (const node of layout.nodes) {
          expect(Number.isFinite(node.x)).toBe(true);
          expect(Number.isFinite(node.y)).toBe(true);
          expect(layout.byId.get(node.person.id)).toBeDefined();
          const rowKey = Math.round(node.y);
          const xs = rows.get(rowKey) ?? [];
          xs.push(node.x);
          rows.set(rowKey, xs);
        }

        // Verify zero horizontal node overlaps within any row
        for (const xs of rows.values()) {
          xs.sort((a, b) => a - b);
          for (let i = 1; i < xs.length; i += 1) {
            expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(TREE_NODE_W - 0.5);
          }
        }
      }),
      { seed: FIXED_SEED + 50, numRuns: 80 }
    );
  });
});
