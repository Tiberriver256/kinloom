import { expect, it } from 'vitest';
import {
  CONTRACT_TEST_ORIGIN,
  createSyntheticHistoricalPerson,
  seedAdminCookie,
  type WithContractHarness,
} from './harness.js';

export function registerMediaContractTests(withHarness: WithContractHarness): void {
  it('deduplicates media by SHA-256 and streams HTTP 206 Partial Content byte ranges', async () => {
    await withHarness(async ({ ports, server }) => {
      const cookie = await seedAdminCookie(ports);
      const person = createSyntheticHistoricalPerson();
      await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: CONTRACT_TEST_ORIGIN,
            cookie,
          },
          body: JSON.stringify({
            entity_id: person.id,
            data: person,
            summary: 'Add Arthur for media test',
            has_primary_source: true,
          }),
        })
      );

      const videoBytes = new TextEncoder().encode('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');

      const uploadOnce = async (id: string): Promise<{ url: string }> => {
        const form = new FormData();
        form.append('file', new File([videoBytes], 'story.mp4', { type: 'video/mp4' }));
        form.append(
          'metadata',
          JSON.stringify({
            id,
            kind: 'video_story',
            person_ids: [person.id],
            caption: 'Arthur oral history clip',
            duration_seconds: 42,
          })
        );
        form.append('summary', 'Upload video story clip');
        const res = await server.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/media/upload`, {
            method: 'POST',
            headers: { origin: CONTRACT_TEST_ORIGIN, cookie },
            body: form,
          })
        );
        expect(res.status).toBe(201);
        return (await res.json()) as { url: string };
      };

      const first = await uploadOnce('med_clip_1');
      const second = await uploadOnce('med_clip_2');
      expect(first.url).toBe(second.url);

      const fullRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}${first.url}`, { headers: { cookie } })
      );
      expect(fullRes.status).toBe(200);
      expect(fullRes.headers.get('accept-ranges')).toBe('bytes');
      expect(fullRes.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      expect(await fullRes.text()).toBe('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');

      const rangeRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}${first.url}`, {
          headers: { cookie, range: 'bytes=10-19' },
        })
      );
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('content-range')).toBe(`bytes 10-19/${videoBytes.byteLength}`);
      expect(rangeRes.headers.get('content-length')).toBe('10');
      expect(await rangeRes.text()).toBe('ABCDEFGHIJ');

      const openEndedRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}${first.url}`, {
          headers: { cookie, range: 'bytes=30-' },
        })
      );
      expect(openEndedRes.status).toBe(206);
      expect(openEndedRes.headers.get('content-range')).toBe(`bytes 30-35/${videoBytes.byteLength}`);
      expect(await openEndedRes.text()).toBe('UVWXYZ');

      const suffixRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}${first.url}`, {
          headers: { cookie, range: 'bytes=-6' },
        })
      );
      expect(suffixRes.status).toBe(206);
      expect(suffixRes.headers.get('content-range')).toBe(`bytes 30-35/${videoBytes.byteLength}`);
      expect(await suffixRes.text()).toBe('UVWXYZ');

      const badRangeRes = await server.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}${first.url}`, {
          headers: { cookie, range: 'bytes=999-1005' },
        })
      );
      expect(badRangeRes.status).toBe(416);
    });
  });
}
