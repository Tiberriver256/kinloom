import { describe, expect, it, vi } from 'vitest';
import type { ArchiveBundle, Place, RawPerson } from '@kinloom/core';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import type { PronunciationAudioGenerator } from '../ports.js';
import { createKinloomServer } from './router.js';
import { signSessionToken } from './session.js';
import {
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  createSyntheticSiteConfig,
} from '../testing/adapterContractSuite.js';

const ORIGIN = 'https://mercer.example.test';
const SECRET = 'kinloom-pronunciation-test-secret-2026-abcdef123456';

async function createUserCookie(
  ports: ReturnType<typeof createInMemoryServerPorts>,
  user: { email: string; display_name: string; role: 'admin' | 'editor' }
): Promise<string> {
  await ports.repository.upsertUser({
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    added_by: 'seed',
    added_at: ports.clock.nowIso(),
    last_login_at: ports.clock.nowIso(),
  });
  const token = await signSessionToken({
    secret: SECRET,
    clock: ports.clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email: user.email,
      display_name: user.display_name,
      role: user.role,
    },
  });
  return `__Host-kinloom_session=${token}`;
}

function makeFakeWavBytes(tag: string): Uint8Array {
  const payload = new TextEncoder().encode(`RIFF-FAKE-WAV-${tag}`);
  return payload;
}

describe('Pronunciation audio generation endpoint and auto-regeneration', () => {
  it('handles POST /api/pronunciation/generate auth, 503 unavailable, 422 living block, and media storage', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const portsWithoutGenerator = createInMemoryServerPorts(siteConfig);
    const serverNoGen = createKinloomServer({
      siteConfig,
      ports: portsWithoutGenerator,
      sessionSecret: SECRET,
    });

    const editorCookieNoGen = await createUserCookie(portsWithoutGenerator, {
      email: 'editor@example.test',
      display_name: 'Archive Editor',
      role: 'editor',
    });

    const mercer = createSyntheticHistoricalPerson({
      id: 'per_thomas_mercer',
      slug: 'thomas-mercer',
      full_name: 'Thomas Mercer',
      given_name: 'Thomas',
      surname: 'Mercer',
    });
    const livingPerson = createSyntheticLivingPerson({
      id: 'per_clara_mercer',
      slug: 'clara-mercer',
      full_name: 'Clara Mercer',
      given_name: 'Clara',
      surname: 'Mercer',
    });

    // Seed entities
    for (const person of [mercer, livingPerson]) {
      const res = await serverNoGen.fetch(
        new Request(`${ORIGIN}/api/entities/person`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookieNoGen },
          body: JSON.stringify({
            entity_id: person.id,
            data: person,
            summary: `Create ${person.full_name}`,
            has_primary_source: true,
          }),
        })
      );
      expect(res.status).toBe(201);
    }

    // Unauthenticated caller -> 401
    const unauthRes = await serverNoGen.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ entity_type: 'person', entity_id: mercer.id }),
      })
    );
    expect(unauthRes.status).toBe(401);

    // Unconfigured generator -> 503 PRONUNCIATION_UNAVAILABLE
    const unavailableRes = await serverNoGen.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookieNoGen },
        body: JSON.stringify({ entity_type: 'person', entity_id: mercer.id }),
      })
    );
    expect(unavailableRes.status).toBe(503);
    const unavailableBody = (await unavailableRes.json()) as { error: { code: string } };
    expect(unavailableBody.error.code).toBe('PRONUNCIATION_UNAVAILABLE');

    // Now test with a configured generator
    const generateSpy = vi.fn(async (params: Parameters<PronunciationAudioGenerator['generate']>[0]) => ({
      bytes: makeFakeWavBytes(`${params.text}|${params.phonetic ?? ''}|${params.ipa ?? ''}`),
      contentType: 'audio/wav',
      ext: 'wav' as const,
    }));

    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        pronunciationGenerator: { generate: generateSpy },
      },
      sessionSecret: SECRET,
    });

    const editorCookie = await createUserCookie(ports, {
      email: 'editor@example.test',
      display_name: 'Archive Editor',
      role: 'editor',
    });

    // Seed historical person, living person, and place
    await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          entity_id: mercer.id,
          data: mercer,
          summary: 'Create Thomas Mercer',
          has_primary_source: true,
        }),
      })
    );
    await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          entity_id: livingPerson.id,
          data: livingPerson,
          summary: 'Create living Clara Mercer',
          has_primary_source: false,
        }),
      })
    );

    const springfield: Place = {
      id: 'plc_springfield',
      slug: 'springfield-illinois',
      name: 'Springfield',
      full_name: 'Springfield, Sangamon County, Illinois',
      place_type: 'town',
      parent_id: null,
      lat: 39.7817,
      lng: -89.6501,
    };
    const createPlaceRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/place`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          entity_id: springfield.id,
          data: springfield,
          summary: 'Create Springfield place',
          has_primary_source: true,
        }),
      })
    );
    expect(createPlaceRes.status).toBe(201);

    // Living person -> 422 LIVING_PRIVACY_VIOLATION
    const livingRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          entity_type: 'person',
          entity_id: livingPerson.id,
          phonetic: 'KLAIR-uh MER-ser',
        }),
      })
    );
    expect(livingRes.status).toBe(422);
    const livingErr = (await livingRes.json()) as { error: { code: string } };
    expect(livingErr.error.code).toBe('LIVING_PRIVACY_VIOLATION');
    expect(generateSpy).not.toHaveBeenCalled();

    // Historical person -> 200 and stored in mediaStore
    const genPersonRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          entity_type: 'person',
          entity_id: mercer.id,
          phonetic: 'TOM-us MER-ser',
        }),
      })
    );
    expect(genPersonRes.status).toBe(200);
    const genPersonBody = (await genPersonRes.json()) as {
      audio_url: string;
      content_type: string;
      size_bytes: number;
    };
    expect(genPersonBody.audio_url).toMatch(/^\/media\/pronunciation-person-[a-f0-9]{16}\.wav$/);
    expect(genPersonBody.content_type).toBe('audio/wav');
    expect(genPersonBody.size_bytes).toBeGreaterThan(0);
    expect(generateSpy).toHaveBeenCalledWith({
      text: 'Thomas Mercer',
      phonetic: 'TOM-us MER-ser',
      ipa: undefined,
      language: undefined,
      voice: undefined,
    });

    // Verify generated audio is served via GET /media/...
    const audioGetRes = await server.fetch(
      new Request(`${ORIGIN}${genPersonBody.audio_url}`, {
        headers: { cookie: editorCookie },
      })
    );
    expect(audioGetRes.status).toBe(200);
    expect(audioGetRes.headers.get('content-type')).toBe('audio/wav');

    // Place -> 200
    const genPlaceRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          entity_type: 'place',
          entity_id: springfield.id,
          ipa: 'ˈsprɪŋfiːld',
        }),
      })
    );
    expect(genPlaceRes.status).toBe(200);
    const genPlaceBody = (await genPlaceRes.json()) as { audio_url: string };
    expect(genPlaceBody.audio_url).toMatch(/^\/media\/pronunciation-place-[a-f0-9]{16}\.wav$/);
  });

  it('auto-regenerates pronunciation audio on create/update when phonetic changes and degrades gracefully on error', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    let shouldFail = false;

    const generateSpy = vi.fn(async (params: Parameters<PronunciationAudioGenerator['generate']>[0]) => {
      if (shouldFail) {
        throw new Error('Upstream TTS unavailable');
      }
      return {
        bytes: makeFakeWavBytes(`${params.text}|${params.phonetic ?? ''}|${params.ipa ?? ''}`),
        contentType: 'audio/wav',
        ext: 'wav' as const,
      };
    });

    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        pronunciationGenerator: { generate: generateSpy },
      },
      sessionSecret: SECRET,
    });

    const editorCookie = await createUserCookie(ports, {
      email: 'editor@example.test',
      display_name: 'Archive Editor',
      role: 'editor',
    });

    const lincoln = createSyntheticHistoricalPerson({
      id: 'per_abraham_lincoln',
      slug: 'abraham-lincoln',
      full_name: 'Abraham Lincoln',
      given_name: 'Abraham',
      surname: 'Lincoln',
      pronunciation: {
        phonetic: 'AY-bruh-ham LINK-un',
        language: 'en-US',
      },
    });

    // 1. Create with pronunciation and no audio_url -> auto-generates audio before persisting
    const createRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          entity_id: lincoln.id,
          data: lincoln,
          summary: 'Create Abraham Lincoln with pronunciation',
          has_primary_source: true,
        }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      entity: RawPerson;
      revision: { revision_id: number };
    };
    const firstAudioUrl = created.entity.pronunciation?.audio_url;
    expect(firstAudioUrl).toMatch(/^\/media\/pronunciation-person-[a-f0-9]{16}\.wav$/);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Confirm bundle cache also has the generated audio_url
    const bundleRes1 = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, { headers: { cookie: editorCookie } })
    );
    const bundle1 = (await bundleRes1.json()) as ArchiveBundle;
    expect(bundle1.people.find((p) => p.id === lincoln.id)?.pronunciation?.audio_url).toBe(
      firstAudioUrl
    );

    // 2. Edit unrelated field (alt_names) without changing pronunciation or name -> no TTS call
    const unrelatedRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person/${lincoln.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          expected_parent_revision_id: created.revision.revision_id,
          data: { ...created.entity, alt_names: ['Honest Abe'] },
          summary: 'Add nickname without changing pronunciation',
          has_primary_source: true,
        }),
      })
    );
    expect(unrelatedRes.status).toBe(200);
    const afterUnrelated = (await unrelatedRes.json()) as {
      entity: RawPerson;
      revision: { revision_id: number };
    };
    expect(afterUnrelated.entity.pronunciation?.audio_url).toBe(firstAudioUrl);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // 3. Edit pronunciation.phonetic -> auto-regenerates audio_url to a new clip
    const editPronRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person/${lincoln.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          expected_parent_revision_id: afterUnrelated.revision.revision_id,
          data: {
            ...afterUnrelated.entity,
            pronunciation: {
              ...afterUnrelated.entity.pronunciation,
              phonetic: 'AY-bruh-ham LING-kun',
            },
          },
          summary: 'Refine phonetic pronunciation',
          has_primary_source: true,
        }),
      })
    );
    expect(editPronRes.status).toBe(200);
    const afterEditPron = (await editPronRes.json()) as {
      entity: RawPerson;
      revision: { revision_id: number };
    };
    const secondAudioUrl = afterEditPron.entity.pronunciation?.audio_url;
    expect(secondAudioUrl).toMatch(/^\/media\/pronunciation-person-[a-f0-9]{16}\.wav$/);
    expect(secondAudioUrl).not.toBe(firstAudioUrl);
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // 4. If TTS throws during updateEntity, metadata save still succeeds gracefully
    shouldFail = true;
    const failTtsRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person/${lincoln.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          expected_parent_revision_id: afterEditPron.revision.revision_id,
          data: {
            ...afterEditPron.entity,
            pronunciation: {
              ...afterEditPron.entity.pronunciation,
              phonetic: 'AY-bruh-ham LING-kuhn',
            },
          },
          summary: 'Update phonetic while TTS is down',
          has_primary_source: true,
        }),
      })
    );
    expect(failTtsRes.status).toBe(200);
    const afterFailTts = (await failTtsRes.json()) as { entity: RawPerson };
    expect(afterFailTts.entity.pronunciation?.phonetic).toBe('AY-bruh-ham LING-kuhn');
    expect(afterFailTts.entity.pronunciation?.audio_url).toBe(secondAudioUrl);
    expect(generateSpy).toHaveBeenCalledTimes(3);
  });
});
