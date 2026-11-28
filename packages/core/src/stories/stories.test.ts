import { describe, expect, it } from 'vitest';
import type { DocumentaryStory, MapStory, ScrollStory } from '../schemas/stories.js';
import { buildStorySummary, compileStoryHtml, computeStoryDurationMs } from './compileStory.js';
import { validateStoryBundle } from './validateStory.js';

function makeDocumentaryStory(overrides: Partial<DocumentaryStory> = {}): DocumentaryStory {
  return {
    schemaVersion: 1,
    id: 'story-ada-doc',
    slug: 'ada-analytical-engine',
    personId: 'person-ada',
    personName: 'Ada Lovelace',
    title: "Ada's Analytical Engine",
    subtitle: 'Notes on the first algorithm',
    summary: 'A short documentary tracing the 1843 notes.',
    format: 'documentary',
    aspectRatio: '16:9',
    audio: {
      asset: 'assets/narration.mp3',
      durationMs: 12000,
      wordTimestamps: [
        { word: 'In', startMs: 0, endMs: 250 },
        { word: '1843', startMs: 250, endMs: 700 },
      ],
    },
    citations: [
      {
        id: 'c1',
        label: 'Taylor Scientific Memoirs (1843)',
        sourceId: 'src-1843',
        url: 'https://archive.example/memoirs-1843',
        detail: 'Note G, pp. 691-731',
      },
    ],
    beats: [
      {
        id: 'b1',
        title: 'The Translation',
        startMs: 0,
        durationMs: 6000,
        dateLabel: '1843',
        placeLabel: 'London',
        narration: 'Ada translated Menabrea and appended seven extensive notes.',
        caption: '1843: Notes published in Scientific Memoirs.',
        media: { asset: 'assets/note-g.png', alt: 'Note G table', caption: 'Bernoulli table' },
        citationIds: ['c1'],
        wordTimestamps: [
          { word: 'Ada', startMs: 0, endMs: 300 },
          { word: 'translated', startMs: 300, endMs: 900 },
        ],
      },
      {
        id: 'b2',
        title: 'Beyond Numbers',
        startMs: 6000,
        durationMs: 6000,
        narration: 'She envisioned engines composing music and symbolic art.',
        caption: 'Symbolic computing vision.',
        citationIds: ['c1'],
      },
    ],
    ...overrides,
  };
}

function makeScrollStory(overrides: Partial<ScrollStory> = {}): ScrollStory {
  return {
    schemaVersion: 1,
    id: 'story-ada-scroll',
    slug: 'ada-letters',
    personId: 'person-ada',
    title: 'Letters to Babbage',
    summary: 'Scrollytelling chapter through primary correspondence.',
    format: 'scroll',
    citations: [{ id: 'c1', label: 'Bodleian MS 1843' }],
    beats: [
      {
        id: 's1',
        key: 'opening',
        title: 'First Meeting',
        dateLabel: '1833',
        placeLabel: 'London',
        body: 'In June 1833 she viewed the Difference Engine prototype.',
        caption: 'Prototype demonstration.',
        pullQuote: 'I want to put in something about Bernoulli’s numbers.',
        media: { asset: 'https://archive.example/engine.jpg', alt: 'Difference engine' },
        citationIds: ['c1'],
      },
      {
        id: 's2',
        key: 'notes',
        title: 'Note G',
        body: 'The final note formalized a stepped algorithm.',
        caption: 'Diagram of operations.',
        citationIds: ['c1'],
      },
    ],
    ...overrides,
  };
}

function makeMapStory(overrides: Partial<MapStory> = {}): MapStory {
  return {
    schemaVersion: 1,
    id: 'story-ada-map',
    slug: 'ada-journey-map',
    personId: 'person-ada',
    title: 'Places in Ada’s Life',
    summary: 'Chronological stops across England.',
    format: 'map',
    citations: [{ id: 'c1', label: 'Parish & Estate Registers' }],
    beats: [
      {
        id: 'm1',
        title: 'Birth in London',
        date: '1815-12-10',
        year: 1815,
        placeLabel: 'Piccadilly, London',
        coordinates: { lat: 51.509, lng: -0.141 },
        narrative: 'Born in London in December 1815.',
        caption: '1815: Piccadilly, London',
        citationIds: ['c1'],
      },
      {
        id: 'm2',
        title: 'Ockham Park',
        date: '1838',
        year: 1838,
        placeLabel: 'Ockham, Surrey',
        coordinates: { lat: 51.295, lng: -0.464 },
        narrative: 'Resided at Ockham Park during her mathematical studies.',
        caption: '1838: Ockham Park, Surrey',
        citationIds: ['c1'],
      },
    ],
    ...overrides,
  };
}

describe('validateStoryBundle', () => {
  it('accepts valid documentary, scroll, and map stories with zero errors', () => {
    const assets = new Set(['assets/narration.mp3', 'assets/note-g.png']);
    const docRes = validateStoryBundle(makeDocumentaryStory(), {
      existingAssets: assets,
      knownPersonIds: new Set(['person-ada']),
      knownSourceIds: new Set(['src-1843']),
    });
    expect(docRes.valid).toBe(true);
    expect(docRes.diagnostics).toEqual([]);

    expect(validateStoryBundle(makeScrollStory()).valid).toBe(true);
    expect(validateStoryBundle(makeMapStory()).valid).toBe(true);
  });

  it('rejects invalid schema payloads with SCHEMA_INVALID diagnostics', () => {
    const res = validateStoryBundle({ format: 'documentary', title: '' });
    expect(res.valid).toBe(false);
    expect(res.diagnostics.every((d) => d.code === 'SCHEMA_INVALID')).toBe(true);

    const rootBad = validateStoryBundle('not-an-object');
    expect(rootBad.valid).toBe(false);
    expect(rootBad.diagnostics[0]?.path).toBe('root');
  });

  it('reports person, citation, beat completeness, timing, and asset violations', () => {
    const badDoc = makeDocumentaryStory({
      audio: {
        asset: 'assets/missing.mp3',
        wordTimestamps: [
          { word: 'a', startMs: 500, endMs: 200 },
          { word: 'b', startMs: 100, endMs: 300 },
        ],
      },
      citations: [
        { id: 'c1', label: 'Source 1', sourceId: 'missing-src' },
        { id: 'c1', label: 'Duplicate Source' },
      ],
      beats: [
        {
          id: 'dup',
          title: 'First',
          startMs: 0,
          durationMs: 5000,
          narration: '   ',
          caption: '   ',
          media: { asset: 'assets/missing-img.png', alt: 'Missing' },
          citationIds: ['unknown-cite'],
        },
        {
          id: 'dup',
          title: 'Second',
          startMs: 3000,
          durationMs: 4000,
          narration: 'Valid narration',
          caption: 'Valid caption',
          citationIds: [],
        },
      ],
    });

    const res = validateStoryBundle(badDoc, {
      existingAssets: new Set<string>(),
      knownPersonIds: new Set(['other-person']),
      knownSourceIds: new Set(['known-src']),
    });

    expect(res.valid).toBe(false);
    const codes = new Set(res.diagnostics.map((d) => d.code));
    expect(codes.has('UNKNOWN_PERSON_ID')).toBe(true);
    expect(codes.has('DUPLICATE_CITATION_ID')).toBe(true);
    expect(codes.has('UNKNOWN_SOURCE_ID')).toBe(true);
    expect(codes.has('DUPLICATE_BEAT_ID')).toBe(true);
    expect(codes.has('EMPTY_CAPTION')).toBe(true);
    expect(codes.has('EMPTY_NARRATIVE')).toBe(true);
    expect(codes.has('UNKNOWN_CITATION_REF')).toBe(true);
    expect(codes.has('UNCITED_BEAT')).toBe(true);
    expect(codes.has('NON_MONOTONIC_TIMESTAMP')).toBe(true);
    expect(codes.has('NON_MONOTONIC_WORD_TIMESTAMP')).toBe(true);
    expect(codes.has('MISSING_ASSET')).toBe(true);
  });

  it('catches duplicate scroll keys and non-monotonic map stop years', () => {
    const badScroll = makeScrollStory({
      beats: [
        {
          id: 's1',
          key: 'same-key',
          title: 'One',
          body: 'Body 1',
          caption: 'Cap 1',
          citationIds: ['c1'],
        },
        {
          id: 's2',
          key: 'same-key',
          title: 'Two',
          body: 'Body 2',
          caption: 'Cap 2',
          citationIds: ['c1'],
        },
      ],
    });
    const scrollRes = validateStoryBundle(badScroll);
    expect(scrollRes.valid).toBe(false);
    expect(scrollRes.diagnostics.some((d) => d.code === 'DUPLICATE_SCROLL_KEY')).toBe(true);

    const badMap = makeMapStory({
      beats: [
        {
          id: 'm1',
          title: 'Later',
          date: '1850',
          year: 1850,
          placeLabel: 'London',
          coordinates: { lat: 51.5, lng: -0.1 },
          narrative: 'Later event',
          caption: '1850',
          citationIds: ['c1'],
        },
        {
          id: 'm2',
          title: 'Earlier',
          date: '1820',
          year: 1820,
          placeLabel: 'London',
          coordinates: { lat: 51.5, lng: -0.1 },
          narrative: 'Earlier event',
          caption: '1820',
          citationIds: ['c1'],
        },
      ],
    });
    const mapRes = validateStoryBundle(badMap);
    expect(mapRes.valid).toBe(false);
    expect(mapRes.diagnostics.some((d) => d.code === 'NON_MONOTONIC_DATE')).toBe(true);
  });
});

describe('compileStoryHtml and buildStorySummary', () => {
  it('computes durations, builds manifest entries, and compiles escaped portable HTML for all formats', () => {
    const doc = makeDocumentaryStory({ title: 'Ada & <Engine>' });
    expect(computeStoryDurationMs(doc)).toBe(12000);
    const summary = buildStorySummary(doc, {
      bundlePath: 'ada-analytical-engine.story.json',
      publishedAt: '2026-11-28T00:00:00.000Z',
    });
    expect(summary.beatCount).toBe(2);
    expect(summary.durationMs).toBe(12000);
    expect(summary.citationCount).toBe(1);
    expect(summary.bundlePath).toBe('ada-analytical-engine.story.json');

    const defaultSummary = buildStorySummary(makeScrollStory());
    expect(defaultSummary.publishedAt).toBeTruthy();
    expect(defaultSummary.bundlePath).toBeUndefined();

    const docHtml = compileStoryHtml(doc);
    expect(docHtml).toContain('Ada &amp; &lt;Engine&gt;');
    expect(docHtml).toContain('data-story-format="documentary"');
    expect(docHtml).toContain('Sources &amp; Citations');
    expect(docHtml).toContain('id="kinloom-story-data"');

    const scroll = makeScrollStory();
    expect(computeStoryDurationMs(scroll)).toBe(24000);
    expect(compileStoryHtml(scroll)).toContain('data-story-format="scroll"');

    const map = makeMapStory({
      citations: [],
      beats: [
        {
          id: 'm1',
          title: 'London',
          date: '1815',
          year: 1815,
          placeLabel: 'London',
          coordinates: { lat: 51.5, lng: -0.1 },
          narrative: 'Born here.',
          caption: '1815 London',
          citationIds: ['missing'],
        },
      ],
    });
    const mapHtml = compileStoryHtml(map);
    expect(mapHtml).toContain('1815 · London');
    expect(mapHtml).not.toContain('Sources &amp; Citations');
  });
});
