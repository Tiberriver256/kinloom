import { describe, expect, it } from 'vitest';
import {
  ArchivalMediaKindSchema,
  type AssetHandler,
  asRevisionId,
  asSha256Hex,
  type KinloomServerPlugin,
  type KinloomServerPluginContext,
  type KinloomServerPluginRoute,
  type KinloomServerPorts,
  KinloomSiteConfigSchema,
  type MediaByteRange,
  MediaItemSchema,
  type MediaStore,
  NarrativeSchema,
  PlaceSchema,
  RawEventSchema,
  RawPersonSchema,
  type StoredMediaObject,
} from './index.js';

const ZERO_SHA = asSha256Hex('0'.repeat(64));

describe('Extension & plugin seam schemas and contracts', () => {
  it('accepts video_story and audio_oral_history media items with streaming metadata and extensions', () => {
    expect(ArchivalMediaKindSchema.parse('video_story')).toBe('video_story');
    expect(ArchivalMediaKindSchema.parse('audio_oral_history')).toBe('audio_oral_history');

    const videoItem = MediaItemSchema.parse({
      id: 'med_video_01',
      kind: 'video_story',
      person_ids: ['per_abraham_lincoln'],
      file: '/media/story-springfield.mp4',
      caption: 'Oral history video about Eighth Street residence',
      mime_type: 'video/mp4',
      duration_seconds: 184.5,
      poster_url: '/media/story-springfield-poster.jpg',
      transcript_url: '/media/story-springfield.vtt',
      extensions: {
        chapters: [{ startSeconds: 0, title: 'Arrival in Springfield' }],
      },
    });

    expect(videoItem.kind).toBe('video_story');
    expect(videoItem.mime_type).toBe('video/mp4');
    expect(videoItem.duration_seconds).toBe(184.5);
    expect(videoItem.poster_url).toBe('/media/story-springfield-poster.jpg');
    expect(videoItem.transcript_url).toBe('/media/story-springfield.vtt');
    expect(videoItem.extensions).toEqual({
      chapters: [{ startSeconds: 0, title: 'Arrival in Springfield' }],
    });

    const audioItem = MediaItemSchema.parse({
      id: 'med_audio_01',
      kind: 'audio_oral_history',
      file: '/media/interview-1974.mp3',
      caption: 'Recorded 1974 homestead interview',
      mime_type: 'audio/mpeg',
      duration_seconds: 612,
      transcript_url: '/media/interview-1974.vtt',
    });

    expect(audioItem.kind).toBe('audio_oral_history');
    expect(audioItem.duration_seconds).toBe(612);
    expect(
      MediaItemSchema.safeParse({
        id: 'med_bad_duration',
        kind: 'video_story',
        file: '/media/bad.mp4',
        caption: 'Negative duration rejected',
        duration_seconds: -5,
      }).success
    ).toBe(false);
  });

  it('preserves optional extensions bags on entities and site config while populating Zod 4 defaults', () => {
    const person = RawPersonSchema.parse({
      id: 'per_01',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
      extensions: { featuredStoryId: 'story_01' },
    });
    expect(person.extensions).toEqual({ featuredStoryId: 'story_01' });

    const place = PlaceSchema.parse({
      id: 'plc_01',
      slug: 'springfield-il',
      name: 'Springfield',
      full_name: 'Springfield, Illinois',
      place_type: 'town',
      parent_id: null,
      lat: 39.7817,
      lng: -89.6501,
      extensions: { historicMarker: 'IL-1844' },
    });
    expect(place.extensions).toEqual({ historicMarker: 'IL-1844' });

    const event = RawEventSchema.parse({
      id: 'evt_01',
      title: 'Homestead deed recorded',
      scope: 'family',
      event_kind: 'point_event',
      extensions: { deedBook: 'Vol. 4, p. 112' },
    });
    expect(event.extensions).toEqual({ deedBook: 'Vol. 4, p. 112' });

    const narrative = NarrativeSchema.parse({
      id: 'nar_01',
      slug: 'winter-crossing',
      title: 'The Winter Crossing',
      body_md: 'Archival summary paragraph.',
      extensions: { layout: 'essay-wide' },
    });
    expect(narrative.extensions).toEqual({ layout: 'essay-wide' });

    const siteConfig = KinloomSiteConfigSchema.parse({
      site: {
        title: 'Alder Synthetic Archive',
        familyName: 'Alder',
        gedcomSourceName: 'ALDER_ARCHIVE',
      },
      extensions: {
        videoStoriesEnabled: true,
      },
    });
    expect(siteConfig.schemaVersion).toBe(1);
    expect(siteConfig.mapDefaults).toEqual({
      centerLat: 38.5,
      centerLng: -96,
      zoom: 4,
      minSpanDeg: 1.2,
    });
    expect(siteConfig.privacy.livingCutoffYears).toBe(101);
    expect(siteConfig.privacy.stripLivingPortraits).toBe(true);
    expect(siteConfig.extensions).toEqual({ videoStoriesEnabled: true });
  });

  it('supports HTTP 206 byte range requests on MediaStore and typed server plugin ports', async () => {
    const payload = new TextEncoder().encode('0123456789abcdef');
    const store: MediaStore = {
      async head(key) {
        return {
          exists: key === 'media/sample.mp4',
          sizeBytes: payload.byteLength,
          contentType: 'video/mp4',
        };
      },
      async put() {
        return;
      },
      async get(key, options?: { range?: MediaByteRange }): Promise<StoredMediaObject | null> {
        if (key !== 'media/sample.mp4') {
          return null;
        }
        const offset = options?.range?.offset ?? 0;
        const length = options?.range?.length ?? payload.byteLength - offset;
        const slice = payload.slice(offset, offset + length);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(slice);
            controller.close();
          },
        });
        return {
          key,
          contentType: 'video/mp4',
          sizeBytes: slice.byteLength,
          sha256: ZERO_SHA,
          body,
          range: options?.range
            ? { start: offset, end: offset + slice.byteLength - 1, total: payload.byteLength }
            : undefined,
        };
      },
    };

    const ranged = await store.get('media/sample.mp4', { range: { offset: 4, length: 6 } });
    expect(ranged).not.toBeNull();
    expect(ranged?.range).toEqual({ start: 4, end: 9, total: 16 });
    expect(ranged?.sizeBytes).toBe(6);

    const route: KinloomServerPluginRoute = {
      method: 'GET',
      pathPrefix: '/api/plugins/stories/',
      minRole: 'viewer',
      async handle(ctx: KinloomServerPluginContext) {
        return new Response(JSON.stringify({ site: ctx.siteConfig.site.familyName }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    };

    const committedHeadIds: number[] = [];
    const plugin: KinloomServerPlugin = {
      id: 'synthetic-video-stories',
      name: 'Synthetic Video Stories',
      routes: [route],
      async onRevisionCommitted(event) {
        committedHeadIds.push(event.headRevisionId);
      },
    };

    const assetHandler: AssetHandler = {
      async fetch() {
        return new Response('<html></html>', { status: 200 });
      },
    };

    await plugin.onRevisionCommitted?.({
      revisions: [],
      headRevisionId: asRevisionId(7),
    });
    expect(committedHeadIds).toEqual([7]);

    const portsShapeCheck = (ports: KinloomServerPorts): number => ports.plugins?.length ?? 0;
    expect(typeof portsShapeCheck).toBe('function');
    expect((await assetHandler.fetch(new Request('https://example.test/'))).status).toBe(200);
  });
});
