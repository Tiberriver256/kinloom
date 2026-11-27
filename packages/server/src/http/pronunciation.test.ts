import type { ArchiveBundle, Place, PronunciationAudioGenerator, RawPerson } from '@kinloom/core';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import { computePronunciationPromptHash } from '../services/pronunciationHelper.js';
import {
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  createSyntheticSiteConfig,
} from '../testing/adapterContractSuite.js';
import { createKinloomServer } from './router.js';
import { signSessionToken } from './session.js';

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
    expect(genPersonBody.audio_url).toMatch(/^\/media\/pronunciation-[a-f0-9]{16}\.wav$/);
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
    expect(genPlaceBody.audio_url).toMatch(/^\/media\/pronunciation-[a-f0-9]{16}\.wav$/);

    // Deduplication: generating the exact same phonetic prompt again reuses R2 clip with 0 extra TTS calls
    const callCountBefore = generateSpy.mock.calls.length;
    const dedupRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          entity_type: 'person',
          entity_id: mercer.id,
          phonetic: 'tom-us mer-ser',
        }),
      })
    );
    expect(dedupRes.status).toBe(200);
    const dedupBody = (await dedupRes.json()) as { audio_url: string };
    expect(dedupBody.audio_url).toBe(genPersonBody.audio_url);
    expect(generateSpy).toHaveBeenCalledTimes(callCountBefore);
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
    expect(firstAudioUrl).toMatch(/^\/media\/pronunciation-[a-f0-9]{16}\.wav$/);
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Confirm bundle cache also has the generated audio_url
    const bundleRes1 = await server.fetch(
      new Request(`${ORIGIN}/api/bundle`, { headers: { cookie: editorCookie } })
    );
    const bundle1 = (await bundleRes1.json()) as ArchiveBundle;
    expect(bundle1.people.find((p) => p.id === lincoln.id)?.pronunciation?.audio_url).toBe(firstAudioUrl);

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
    expect(secondAudioUrl).toMatch(/^\/media\/pronunciation-[a-f0-9]{16}\.wav$/);
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

describe('Shared pronunciation lexicon endpoints (GET /api/pronunciations, PUT /api/pronunciations/:term)', () => {
  it('merges static config with persisted overrides, auto-generates deduplicated audio, and deletes overrides when cleared', async () => {
    const baseConfig = createSyntheticSiteConfig();
    const siteConfig = {
      ...baseConfig,
      pronunciations: {
        Mercer: { phonetic: 'MER-ser', language: 'en-US' },
        Alder: { phonetic: 'AWL-der', language: 'en-US' },
      },
    };
    const ports = createInMemoryServerPorts(siteConfig);
    let shouldFailTts = false;

    const generateSpy = vi.fn(async (params: Parameters<PronunciationAudioGenerator['generate']>[0]) => {
      if (shouldFailTts) {
        throw new Error('Upstream TTS temporarily down');
      }
      return {
        bytes: makeFakeWavBytes(`lexicon|${params.text}|${params.phonetic ?? ''}|${params.ipa ?? ''}`),
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

    // 1. Unauthenticated GET in private mode -> 401
    const unauthGetRes = await server.fetch(new Request(`${ORIGIN}/api/pronunciations`));
    expect(unauthGetRes.status).toBe(401);

    // 2. Authenticated GET returns static siteConfig pronunciations initially
    const initialGetRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciations`, {
        headers: { cookie: editorCookie },
      })
    );
    expect(initialGetRes.status).toBe(200);
    const initialBody = (await initialGetRes.json()) as {
      pronunciations: Record<string, { phonetic?: string; ipa?: string; audio_url?: string }>;
    };
    expect(initialBody.pronunciations).toEqual({
      Mercer: { phonetic: 'MER-ser', language: 'en-US' },
      Alder: { phonetic: 'AWL-der', language: 'en-US' },
    });

    // 3. Unauthenticated PUT -> 401; CSRF mismatch -> 403
    const unauthPutRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciations/Springfield`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ phonetic: 'SPRING-feeld' }),
      })
    );
    expect(unauthPutRes.status).toBe(401);

    const csrfPutRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciations/Springfield`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin: 'https://evil.example.test',
          cookie: editorCookie,
        },
        body: JSON.stringify({ phonetic: 'SPRING-feeld' }),
      })
    );
    expect(csrfPutRes.status).toBe(403);

    // 4. PUT new term -> upserts + auto-generates audio and returns merged lexicon
    const putNewRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciations/${encodeURIComponent('New Salem')}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          phonetic: 'NOO SAY-lum',
          language: 'en-US',
          note: 'Historic Illinois village',
        }),
      })
    );
    expect(putNewRes.status).toBe(200);
    const putNewBody = (await putNewRes.json()) as {
      term: string;
      pronunciation: { phonetic?: string; language?: string; note?: string; audio_url?: string } | null;
      pronunciations: Record<string, { phonetic?: string; audio_url?: string }>;
    };
    expect(putNewBody.term).toBe('New Salem');
    expect(putNewBody.pronunciation?.phonetic).toBe('NOO SAY-lum');
    expect(putNewBody.pronunciation?.note).toBe('Historic Illinois village');
    expect(putNewBody.pronunciation?.audio_url).toMatch(/^\/media\/pronunciation-[a-f0-9]{16}\.wav$/);
    expect(putNewBody.pronunciations['New Salem']?.audio_url).toBe(putNewBody.pronunciation?.audio_url);
    expect(putNewBody.pronunciations.Mercer?.phonetic).toBe('MER-ser');
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // 5. PUT same phonetic again (different casing) -> deduplicates R2 audio with 0 extra TTS calls
    const putDedupRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciations/${encodeURIComponent('New Salem')}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          phonetic: 'noo say-lum',
          language: 'en-US',
          note: 'Updated note',
        }),
      })
    );
    expect(putDedupRes.status).toBe(200);
    const putDedupBody = (await putDedupRes.json()) as {
      pronunciation: { audio_url?: string; note?: string };
    };
    expect(putDedupBody.pronunciation.audio_url).toBe(putNewBody.pronunciation?.audio_url);
    expect(putDedupBody.pronunciation.note).toBe('Updated note');
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // 6. PUT overriding a static config term (Mercer) -> dynamic override wins in merged lexicon
    const overrideRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciations/Mercer`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          phonetic: 'MUR-sur',
          ipa: 'ˈmɜːrsər',
          language: 'en-US',
        }),
      })
    );
    expect(overrideRes.status).toBe(200);
    const overrideBody = (await overrideRes.json()) as {
      term: string;
      pronunciation: { phonetic?: string; ipa?: string; audio_url?: string };
      pronunciations: Record<string, { phonetic?: string; ipa?: string; audio_url?: string }>;
    };
    expect(overrideBody.pronunciation.phonetic).toBe('MUR-sur');
    expect(overrideBody.pronunciations.Mercer.phonetic).toBe('MUR-sur');
    expect(overrideBody.pronunciations.Mercer.ipa).toBe('ˈmɜːrsər');
    expect(overrideBody.pronunciations.Mercer.audio_url).toMatch(
      /^\/media\/pronunciation-[a-f0-9]{16}\.wav$/
    );
    expect(generateSpy).toHaveBeenCalledTimes(2);

    // 7. Graceful degradation when TTS fails: text still persists
    shouldFailTts = true;
    const failTtsPutRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciations/Springfield`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({ phonetic: 'SPRING-feeld' }),
      })
    );
    expect(failTtsPutRes.status).toBe(200);
    const failTtsBody = (await failTtsPutRes.json()) as {
      pronunciation: { phonetic?: string; audio_url?: string };
    };
    expect(failTtsBody.pronunciation.phonetic).toBe('SPRING-feeld');
    expect(failTtsBody.pronunciation.audio_url).toBeUndefined();
    shouldFailTts = false;

    // 8. Clearing all fields deletes the override -> Mercer reverts to static config, Springfield disappears
    const clearMercerRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciations/Mercer`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({ phonetic: '   ', ipa: '', language: null, note: '' }),
      })
    );
    expect(clearMercerRes.status).toBe(200);
    const clearMercerBody = (await clearMercerRes.json()) as {
      term: string;
      pronunciation: null;
      pronunciations: Record<string, { phonetic?: string }>;
    };
    expect(clearMercerBody.term).toBe('Mercer');
    expect(clearMercerBody.pronunciation).toBeNull();
    expect(clearMercerBody.pronunciations.Mercer).toEqual({
      phonetic: 'MER-ser',
      language: 'en-US',
    });

    const clearSpringfieldRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciations/Springfield`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({}),
      })
    );
    expect(clearSpringfieldRes.status).toBe(200);
    const clearSpringfieldBody = (await clearSpringfieldRes.json()) as {
      pronunciation: null;
      pronunciations: Record<string, unknown>;
    };
    expect(clearSpringfieldBody.pronunciation).toBeNull();
    expect(clearSpringfieldBody.pronunciations.Springfield).toBeUndefined();
  });

  it('allows unauthenticated GET /api/pronunciations in public mode', async () => {
    const baseConfig = createSyntheticSiteConfig();
    const siteConfig = {
      ...baseConfig,
      pronunciations: {
        Alder: { phonetic: 'AWL-der' },
      },
    };
    const ports = createInMemoryServerPorts(siteConfig);
    await ports.pronunciationLexiconStore.upsert(
      'Springfield',
      { phonetic: 'SPRING-feeld' },
      'editor@example.test',
      ports.clock.nowIso()
    );

    const publicServer = createKinloomServer({
      siteConfig,
      mode: 'public',
      ports,
      sessionSecret: SECRET,
    });

    const res = await publicServer.fetch(new Request(`${ORIGIN}/api/pronunciations`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pronunciations: Record<string, { phonetic?: string }>;
    };
    expect(body.pronunciations).toEqual({
      Alder: { phonetic: 'AWL-der' },
      Springfield: { phonetic: 'SPRING-feeld' },
    });
  });

  it('persists provenance and variants via PUT /api/pronunciations/:term and invalidates cache hash on text/phonetic/ipa/language/voice changes', async () => {
    const baseHash = await computePronunciationPromptHash({
      text: 'Goes',
      phonetic: 'HOOS',
      ipa: '/ɣus/',
      language: 'nl',
      voice: 'Charon',
    });
    const sameCaseHash = await computePronunciationPromptHash({
      text: 'goes',
      phonetic: 'hoos',
      ipa: 'ɣus',
      language: 'NL',
      voice: 'charon',
    });
    expect(sameCaseHash).toBe(baseHash);

    // Updating ANY of text, phonetic, ipa, language, or voice produces a distinct cache key
    expect(
      await computePronunciationPromptHash({
        text: 'Goes, Zeeland',
        phonetic: 'HOOS',
        ipa: '/ɣus/',
        language: 'nl',
        voice: 'Charon',
      })
    ).not.toBe(baseHash);
    expect(
      await computePronunciationPromptHash({
        text: 'Goes',
        phonetic: 'KHOOS',
        ipa: '/ɣus/',
        language: 'nl',
        voice: 'Charon',
      })
    ).not.toBe(baseHash);
    expect(
      await computePronunciationPromptHash({
        text: 'Goes',
        phonetic: 'HOOS',
        ipa: '/xuːs/',
        language: 'nl',
        voice: 'Charon',
      })
    ).not.toBe(baseHash);
    expect(
      await computePronunciationPromptHash({
        text: 'Goes',
        phonetic: 'HOOS',
        ipa: '/ɣus/',
        language: 'en-US',
        voice: 'Charon',
      })
    ).not.toBe(baseHash);
    expect(
      await computePronunciationPromptHash({
        text: 'Goes',
        phonetic: 'HOOS',
        ipa: '/ɣus/',
        language: 'nl',
        voice: 'Kore',
      })
    ).not.toBe(baseHash);

    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      ports,
      sessionSecret: SECRET,
    });
    const editorCookie = await createUserCookie(ports, {
      email: 'editor@example.test',
      display_name: 'Archive Editor',
      role: 'editor',
    });

    const putRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciations/${encodeURIComponent('Zeeland, Netherlands')}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: editorCookie },
        body: JSON.stringify({
          phonetic: 'ZAY-lahnt',
          ipa: '/ˈzeː.lɑnt/',
          language: 'nl',
          region: 'Netherlands',
          source_label: 'Wiktionary (Dutch IPA)',
          source_url: 'https://en.wiktionary.org/wiki/Zeeland',
          variants: [
            {
              label: 'West Michigan',
              phonetic: 'ZEE-lund',
              ipa: '/ˈziː.lənd/',
              language: 'en-US',
            },
          ],
        }),
      })
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as {
      pronunciation: {
        source_label?: string;
        source_url?: string;
        region?: string;
        variants?: Array<{ label: string }>;
      };
    };
    expect(putBody.pronunciation.source_label).toBe('Wiktionary (Dutch IPA)');
    expect(putBody.pronunciation.source_url).toBe('https://en.wiktionary.org/wiki/Zeeland');
    expect(putBody.pronunciation.region).toBe('Netherlands');
    expect(putBody.pronunciation.variants?.[0]?.label).toBe('West Michigan');
  });
});
