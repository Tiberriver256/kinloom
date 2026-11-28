import type { ArchiveBundle, Place, PronunciationAudioGenerator, RawPerson } from '@kinloom/core';
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryServerPorts } from '../adapters/inMemory.js';
import { createPronunciationPlugin, PRONUNCIATION_PLUGIN_ID } from '../plugins/pronunciationPlugin.js';
import {
  buildPronunciationPrompt,
  Chirp3HdPronunciationAudioGenerator,
  CLOUD_TTS_SYNTHESIZE_ENDPOINT,
  DEFAULT_CHIRP3_HD_VOICE,
  GeminiPronunciationAudioGenerator,
  OpenAiSpeechPronunciationGenerator,
  resolveChirp3HdVoiceName,
  wrapPcmAsWav,
} from '../services/pronunciationGenerators.js';
import { computePronunciationPromptHash } from '../services/pronunciationHelper.js';
import {
  DEFAULT_PRONUNCIATION_RUNTIME_CONFIG,
  resolveActivePronunciationGeneratorLabel,
} from '../services/pronunciationRuntime.js';
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
    expect(putNewBody.pronunciations['Mercer']?.phonetic).toBe('MER-ser');
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
    expect(overrideBody.pronunciations['Mercer']!.phonetic).toBe('MUR-sur');
    expect(overrideBody.pronunciations['Mercer']!.ipa).toBe('ˈmɜːrsər');
    expect(overrideBody.pronunciations['Mercer']!.audio_url).toMatch(
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
    expect(clearMercerBody.pronunciations['Mercer']).toEqual({
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
    expect(clearSpringfieldBody.pronunciations['Springfield']).toBeUndefined();
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

  it('honors Admin Plugin Settings (D1/store gemini_api_key, openai-speech adapter, fallback, phoneme_mode, auto_generate_on_save, disabled)', async () => {
    // 1. Verify phonemeMode variations in buildPronunciationPrompt
    expect(
      buildPronunciationPrompt({
        text: 'Goes',
        ipa: 'ɣus',
        phonetic: 'HOOS',
        language: 'nl',
        phonemeMode: 'plain',
      })
    ).toBe('Pronounce "Goes" in Dutch (nl) as HOOS.');
    expect(
      buildPronunciationPrompt({
        text: 'Goes',
        ipa: 'ɣus',
        phonetic: 'HH UW S',
        language: 'nl',
        phonemeMode: 'arpabet',
      })
    ).toBe('Pronounce "Goes" in Dutch (nl) as ARPAbet HH UW S (IPA: /ɣus/).');
    expect(
      buildPronunciationPrompt({
        text: '',
        phonetic: 'HH UW S',
        phonemeMode: 'arpabet',
      })
    ).toBe('ARPAbet HH UW S');

    // 2. Verify OpenAiSpeechPronunciationGenerator directly (wav + mp3 + error handling)
    const openAiCalls: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    const openAiFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      openAiCalls.push({
        url,
        auth: headers.get('authorization'),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      if (url.includes('fail.example')) {
        return new Response('upstream error', { status: 502 });
      }
      if (url.includes('mp3.example')) {
        return new Response(new Uint8Array([0x49, 0x44, 0x33]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        });
      }
      return new Response(makeFakeWavBytes('openai-ok'), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    };

    const mp3Gen = new OpenAiSpeechPronunciationGenerator({
      baseUrl: 'https://mp3.example/v1/audio/speech',
      apiKey: 'sk-test-openai',
      model: 'tts-1',
      defaultVoice: 'nova',
      fetchFn: openAiFetch,
    });
    const mp3Audio = await mp3Gen.generate({ text: 'Mercer', phonetic: 'MER-ser', phonemeMode: 'plain' });
    expect(mp3Audio.ext).toBe('mp3');
    expect(mp3Audio.contentType).toBe('audio/mpeg');
    expect(openAiCalls[0]?.auth).toBe('Bearer sk-test-openai');

    const failGen = new OpenAiSpeechPronunciationGenerator({
      baseUrl: 'https://fail.example/v1',
      fetchFn: openAiFetch,
    });
    await expect(failGen.generate({ text: 'Mercer' })).rejects.toThrow(/HTTP 502/);

    // 3. Full server integration with NO injected generator and NO env key: saved Admin Plugin Settings drive TTS!
    const rawPcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    let binary = '';
    for (const b of rawPcm) {
      binary += String.fromCharCode(b);
    }
    const base64Pcm = btoa(binary);

    const observedFetchCalls: Array<{ url: string; headers: Headers; body: string }> = [];
    const runtimeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? '');
      observedFetchCalls.push({ url, headers, body });

      const { hostname } = new URL(url);
      if (hostname === 'fail-primary.example') {
        return new Response('primary down', { status: 503 });
      }
      if (hostname === 'generativelanguage.googleapis.com') {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/L16;codec=pcm;rate=24000',
                        data: base64Pcm,
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(makeFakeWavBytes('openai-runtime'), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    };

    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        pronunciationEnv: { fetchImpl: runtimeFetch },
        plugins: [createPronunciationPlugin()],
      },
      sessionSecret: SECRET,
    });

    const adminCookie = await createUserCookie(ports, {
      email: 'admin@example.test',
      display_name: 'Archive Admin',
      role: 'admin',
    });

    const mercer = createSyntheticHistoricalPerson({
      id: 'per_runtime_mercer',
      slug: 'runtime-mercer',
      full_name: 'Thomas Mercer',
      given_name: 'Thomas',
      surname: 'Mercer',
    });
    const seedRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          entity_id: mercer.id,
          data: mercer,
          summary: 'Seed Thomas Mercer',
          has_primary_source: true,
        }),
      })
    );
    expect(seedRes.status).toBe(201);

    // Save Gemini API key + default_voice + default_model + phoneme_mode='plain' in Admin Plugin Settings
    const saveGeminiRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          values: {
            primary_backend: 'gemini',
            fallback_backend: 'none',
            default_model: 'gemini-custom-tts',
            default_voice: 'Kore',
            phoneme_mode: 'plain',
            auto_generate_on_save: true,
          },
          secrets: {
            gemini_api_key: { action: 'set', value: 'AIzaSyRuntimeSettingsKey_12345' },
          },
        }),
      })
    );
    expect(saveGeminiRes.status).toBe(200);
    const saveGeminiJson = (await saveGeminiRes.json()) as {
      plugin: { readonly_values: { active_generator: string } };
    };
    expect(saveGeminiJson.plugin.readonly_values.active_generator).toBe('gemini-tts');

    // System diagnostics reflects active generator from stored secret too
    const diagRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/system`, { headers: { cookie: adminCookie } })
    );
    const diagJson = (await diagRes.json()) as {
      runtime: { adapters: { pronunciation_generator: string } };
    };
    expect(diagJson.runtime.adapters.pronunciation_generator).toBe('gemini-tts');

    // Generate uses stored D1 key, model, voice, and plain phonemeMode (IPA omitted!)
    const genRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          entity_type: 'person',
          entity_id: mercer.id,
          phonetic: 'TOM-us MER-ser',
          ipa: 'ˈmɜːrsər',
        }),
      })
    );
    expect(genRes.status).toBe(200);
    expect(observedFetchCalls).toHaveLength(1);
    expect(observedFetchCalls[0]?.url).toContain('gemini-custom-tts:generateContent');
    expect(observedFetchCalls[0]?.headers.get('x-goog-api-key')).toBe('AIzaSyRuntimeSettingsKey_12345');
    expect(observedFetchCalls[0]?.body).toContain('"voiceName":"Kore"');
    expect(observedFetchCalls[0]?.body).toContain('TOM-us MER-ser');
    expect(observedFetchCalls[0]?.body).not.toContain('ˈmɜːrsər');

    // Primary openai-speech fails -> falls back to gemini seamlessly
    await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          values: {
            primary_backend: 'openai-speech',
            fallback_backend: 'gemini',
            openai_base_url: 'https://fail-primary.example/v1',
          },
        }),
      })
    );
    observedFetchCalls.length = 0;
    const fallbackRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          entity_type: 'person',
          entity_id: mercer.id,
          text: 'Fallback Test Term',
        }),
      })
    );
    expect(fallbackRes.status).toBe(200);
    expect(observedFetchCalls).toHaveLength(2);
    expect(observedFetchCalls[0]?.url).toBe('https://fail-primary.example/v1/audio/speech');
    expect(observedFetchCalls[1]?.url).toContain('generativelanguage.googleapis.com');

    // auto_generate_on_save = false skips TTS in PUT /api/pronunciations/:term
    await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          values: {
            primary_backend: 'gemini',
            fallback_backend: 'none',
            auto_generate_on_save: false,
          },
        }),
      })
    );
    observedFetchCalls.length = 0;
    const noAutoRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciations/${encodeURIComponent('NoAutoTerm')}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ phonetic: 'NO-aw-toh' }),
      })
    );
    expect(noAutoRes.status).toBe(200);
    const noAutoJson = (await noAutoRes.json()) as { pronunciation: { audio_url?: string } };
    expect(noAutoJson.pronunciation.audio_url).toBeUndefined();
    expect(observedFetchCalls).toHaveLength(0);

    // primary_backend = 'disabled' returns 503 PRONUNCIATION_DISABLED and reports disabled status
    await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          values: { primary_backend: 'disabled', fallback_backend: 'none' },
        }),
      })
    );
    const disabledGenRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ entity_type: 'person', entity_id: mercer.id }),
      })
    );
    expect(disabledGenRes.status).toBe(503);
    expect(((await disabledGenRes.json()) as { error: { code: string } }).error.code).toBe(
      'PRONUNCIATION_DISABLED'
    );

    const disabledDiagRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/system`, { headers: { cookie: adminCookie } })
    );
    const disabledDiagJson = (await disabledDiagRes.json()) as {
      runtime: { adapters: { pronunciation_generator: string } };
      plugins: Array<{ id: string; status: string }>;
    };
    expect(disabledDiagJson.runtime.adapters.pronunciation_generator).toBe('disabled');
    expect(disabledDiagJson.plugins.find((p) => p.id === PRONUNCIATION_PLUGIN_ID)?.status).toBe('disabled');
  });

  it('exercises GeminiPronunciationAudioGenerator, OpenAiSpeechPronunciationGenerator, prompt branches, and runtime label resolver directly', async () => {
    // Prompt branches (empty text + ipa/phonetic/language/arpabet/plain)
    expect(buildPronunciationPrompt({ text: '', ipa: 'ɣus', phonetic: 'HOOS', language: 'nl' })).toBe(
      'Pronounce in Dutch (nl) as /ɣus/ (guide: HOOS).'
    );
    expect(buildPronunciationPrompt({ text: '', ipa: 'ɣus', phonetic: 'HOOS' })).toBe('/ɣus/ (guide: HOOS)');
    expect(buildPronunciationPrompt({ text: '', ipa: 'ɣus', language: 'nl' })).toBe(
      'Pronounce in Dutch (nl) as /ɣus/.'
    );
    expect(buildPronunciationPrompt({ text: '', ipa: 'ɣus' })).toBe('/ɣus/');
    expect(buildPronunciationPrompt({ text: '', phonetic: 'HOOS', language: 'nl' })).toBe(
      'Pronounce in Dutch (nl) as HOOS.'
    );
    expect(buildPronunciationPrompt({ text: '', phonetic: 'HOOS' })).toBe('HOOS');
    expect(buildPronunciationPrompt({ text: '' })).toBe('');
    expect(
      buildPronunciationPrompt({
        text: '',
        ipa: 'ɣus',
        phonetic: 'HH UW S',
        language: 'nl',
        phonemeMode: 'arpabet',
      })
    ).toBe('Pronounce in Dutch (nl) as ARPAbet HH UW S (IPA: /ɣus/).');
    expect(buildPronunciationPrompt({ text: 'Goes', phonetic: 'HH UW S', phonemeMode: 'arpabet' })).toBe(
      'Pronounce "Goes" as ARPAbet HH UW S.'
    );
    expect(buildPronunciationPrompt({ text: 'Goes', ipa: 'ɣus', phonemeMode: 'arpabet' })).toBe(
      'Pronounce "Goes" as /ɣus/.'
    );
    expect(buildPronunciationPrompt({ text: 'Goes', language: 'zz-custom' })).toBe(
      'Pronounce "Goes" in zz-custom.'
    );

    // Constructor & input guards
    expect(() => new GeminiPronunciationAudioGenerator({ apiKey: '   ' })).toThrow(/non-empty apiKey/);
    expect(() => new OpenAiSpeechPronunciationGenerator({ baseUrl: '   ' })).toThrow(/non-empty baseUrl/);

    const wavPassthrough = wrapPcmAsWav(new Uint8Array([1, 2, 3, 4]), 16000, 1, 16);
    let wavBinary = '';
    for (const b of wavPassthrough) {
      wavBinary += String.fromCharCode(b);
    }
    const wavB64 = btoa(wavBinary);

    const gemWav = new GeminiPronunciationAudioGenerator({
      apiKey: 'k-test',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wavB64 } }] } }],
          }),
          { status: 200 }
        ),
    });
    await expect(gemWav.generate({ text: '   ' })).rejects.toThrow(/must not be empty/);
    const passthroughResult = await gemWav.generate({ text: 'Alder', voice: 'Puck' });
    expect(passthroughResult.bytes).toEqual(wavPassthrough);

    const gemErr = new GeminiPronunciationAudioGenerator({
      apiKey: 'k-test',
      fetchFn: async () => new Response('rate limit', { status: 429 }),
    });
    await expect(gemErr.generate({ text: 'Alder' })).rejects.toThrow(/HTTP 429/);

    const gemBadSchema = new GeminiPronunciationAudioGenerator({
      apiKey: 'k-test',
      fetchFn: async () => new Response(JSON.stringify({ candidates: 'invalid' }), { status: 200 }),
    });
    await expect(gemBadSchema.generate({ text: 'Alder' })).rejects.toThrow(/JSON schema/);

    const gemEmptyParts = new GeminiPronunciationAudioGenerator({
      apiKey: 'k-test',
      fetchFn: async () =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] }), { status: 200 }),
    });
    await expect(gemEmptyParts.generate({ text: 'Alder' })).rejects.toThrow(/inline audio data/);

    const openAiEmpty = new OpenAiSpeechPronunciationGenerator({
      baseUrl: 'https://speech.example/v1',
      fetchFn: async () => new Response(new Uint8Array(0), { status: 200 }),
    });
    await expect(openAiEmpty.generate({ text: '  ' })).rejects.toThrow(/must not be empty/);
    await expect(openAiEmpty.generate({ text: 'Alder' })).rejects.toThrow(/empty audio body/);

    // Runtime label resolver branches
    expect(
      resolveActivePronunciationGeneratorLabel({
        config: { ...DEFAULT_PRONUNCIATION_RUNTIME_CONFIG, primaryBackend: 'disabled' },
        configuredSecrets: { gemini_api_key: true },
      })
    ).toBe('disabled');
    expect(
      resolveActivePronunciationGeneratorLabel({
        config: {
          ...DEFAULT_PRONUNCIATION_RUNTIME_CONFIG,
          primaryBackend: 'openai-speech',
          fallbackBackend: 'gemini',
          openAiBaseUrl: '',
        },
        configuredSecrets: {},
        injectedGenerator: {
          adapterKind: 'custom-tts',
          generate: async () => ({ bytes: new Uint8Array(), contentType: 'audio/wav', ext: 'wav' }),
        },
      })
    ).toBe('custom-tts');
    expect(
      resolveActivePronunciationGeneratorLabel({
        config: DEFAULT_PRONUNCIATION_RUNTIME_CONFIG,
        configuredSecrets: {},
      })
    ).toBe('none');
  });
  it('supports Google Cloud Chirp 3 HD primary backend and Gemini -> Chirp 3 HD failover on 429/503', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const calls: Array<{ url: string; apiKey: string | null; quotaProject: string | null; body: string }> =
      [];
    const rawPcm = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    let pcmBinary = '';
    for (const byte of rawPcm) {
      pcmBinary += String.fromCharCode(byte);
    }
    const pcmBase64 = btoa(pcmBinary);

    let geminiFailureStatus = 429;
    const failoverFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? '');
      calls.push({
        url,
        apiKey: headers.get('x-goog-api-key'),
        quotaProject: headers.get('x-goog-user-project'),
        body,
      });
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response('rate limit exceeded', { status: geminiFailureStatus });
      }
      if (url.includes('texttospeech.googleapis.com/v1/text:synthesize')) {
        return new Response(JSON.stringify({ audioContent: pcmBase64 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('unexpected url', { status: 500 });
    };

    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      sessionSecret: SECRET,
      ports: {
        ...ports,
        pronunciationEnv: { fetchImpl: failoverFetch },
        plugins: [createPronunciationPlugin()],
      },
    });

    const adminCookie = await createUserCookie(ports, {
      email: 'steward@example.test',
      display_name: 'Archive Steward',
      role: 'admin',
    });

    const alder = createSyntheticHistoricalPerson({
      id: 'per_elias_alder',
      slug: 'elias-alder',
      full_name: 'Elias Alder',
      given_name: 'Elias',
      surname: 'Alder',
    });
    const seedRes = await server.fetch(
      new Request(`${ORIGIN}/api/entities/person`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          entity_id: alder.id,
          data: alder,
          summary: 'Seed Elias Alder',
          has_primary_source: true,
        }),
      })
    );
    expect(seedRes.status).toBe(201);

    const cloudTtsKey = 'AIzaSyChirp3HdSecretKey_88776655';
    const saveRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          values: {
            primary_backend: 'gemini',
            fallback_backend: 'chirp3-hd',
            chirp_voice: 'en-US-Chirp3-HD-Kore',
            gcp_project_id: 'kinloom-tts-quota',
            phoneme_mode: 'ipa',
          },
          secrets: {
            gemini_api_key: { action: 'set', value: 'AIzaSyGeminiPrimaryKey_11223344' },
            google_cloud_tts_api_key: { action: 'set', value: cloudTtsKey },
          },
        }),
      })
    );
    expect(saveRes.status).toBe(200);
    const saveBody = await saveRes.text();
    expect(saveBody).not.toContain(cloudTtsKey);
    const parsedSave = JSON.parse(saveBody) as {
      plugin: {
        readonly_values: { active_generator: string; configured_credentials: string };
        secrets: { google_cloud_tts_api_key: { configured: boolean } };
      };
    };
    expect(parsedSave.plugin.readonly_values.active_generator).toBe('gemini-tts');
    expect(parsedSave.plugin.readonly_values.configured_credentials).toBe('gemini, chirp3-hd');
    expect(parsedSave.plugin.secrets.google_cloud_tts_api_key.configured).toBe(true);

    // Gemini returns 429 -> seamlessly fails over to Google Cloud Chirp 3 HD
    const failoverRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          entity_type: 'person',
          entity_id: alder.id,
          ipa: 'ɪˈlaɪəs ˈɔːldər',
          phonetic: 'ih-LY-us AWL-der',
        }),
      })
    );
    expect(failoverRes.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('generativelanguage.googleapis.com');
    expect(calls[1]?.url).toContain('texttospeech.googleapis.com/v1/text:synthesize');
    expect(calls[1]?.apiKey).toBe(cloudTtsKey);
    expect(calls[1]?.quotaProject).toBe('kinloom-tts-quota');
    expect(calls[1]?.body).toContain('PHONETIC_ENCODING_IPA');
    expect(calls[1]?.body).toContain('en-US-Chirp3-HD-Kore');

    // Gemini returns 503 -> also fails over to Chirp 3 HD
    geminiFailureStatus = 503;
    const failover503Res = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          entity_type: 'person',
          entity_id: alder.id,
          ipa: 'ɪˈlaɪəs ˈɔːldər',
          force: true,
        }),
      })
    );
    expect(failover503Res.status).toBe(200);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.url).toContain('texttospeech.googleapis.com/v1/text:synthesize');

    // Explicit per-entity voice override is preserved across Gemini -> Chirp 3 HD failover
    const failoverCustomVoiceRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          entity_type: 'person',
          entity_id: alder.id,
          voice: 'nl-NL-Chirp3-HD-Aoede',
          force: true,
        }),
      })
    );
    expect(failoverCustomVoiceRes.status).toBe(200);
    expect(calls[calls.length - 1]?.body).toContain('nl-NL-Chirp3-HD-Aoede');

    // Direct chirp3-hd primary backend with stored settings, then without key (503 unavailable)
    const switchChirpRes = await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          values: {
            primary_backend: 'chirp3-hd',
            fallback_backend: 'none',
            chirp_voice: 'en-US-Chirp3-HD-Charon',
          },
        }),
      })
    );
    expect(switchChirpRes.status).toBe(200);
    const directChirpRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          entity_type: 'person',
          entity_id: alder.id,
          force: true,
        }),
      })
    );
    expect(directChirpRes.status).toBe(200);
    expect(calls[calls.length - 1]?.url).toContain('texttospeech.googleapis.com/v1/text:synthesize');
    expect(calls[calls.length - 1]?.body).toContain('en-US-Chirp3-HD-Charon');

    // Clear google_cloud_tts_api_key -> chirp3-hd primary becomes unavailable (503)
    await server.fetch(
      new Request(`${ORIGIN}/api/admin/plugin-settings/${PRONUNCIATION_PLUGIN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({
          secrets: { google_cloud_tts_api_key: { action: 'clear' } },
        }),
      })
    );
    const missingKeyRes = await server.fetch(
      new Request(`${ORIGIN}/api/pronunciation/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: adminCookie },
        body: JSON.stringify({ entity_type: 'person', entity_id: alder.id, force: true }),
      })
    );
    expect(missingKeyRes.status).toBe(503);

    // Direct chirp3-hd primary backend + label resolver coverage
    expect(
      resolveActivePronunciationGeneratorLabel({
        config: { ...DEFAULT_PRONUNCIATION_RUNTIME_CONFIG, primaryBackend: 'chirp3-hd' },
        configuredSecrets: { google_cloud_tts_api_key: true },
      })
    ).toBe('chirp3-hd');
    expect(
      resolveActivePronunciationGeneratorLabel({
        config: { ...DEFAULT_PRONUNCIATION_RUNTIME_CONFIG, primaryBackend: 'chirp3-hd' },
        configuredSecrets: {},
        envDefaults: { googleCloudTtsApiKey: 'env-cloud-tts-key' },
      })
    ).toBe('chirp3-hd');
    expect(
      resolveActivePronunciationGeneratorLabel({
        config: { ...DEFAULT_PRONUNCIATION_RUNTIME_CONFIG, primaryBackend: 'chirp3-hd' },
        configuredSecrets: {},
      })
    ).toBe('none');
  });

  it('exercises Chirp3HdPronunciationAudioGenerator direct unit paths (IPA, plain, arpabet, WAV passthrough, voice/language normalization, errors)', async () => {
    expect(() => new Chirp3HdPronunciationAudioGenerator({ apiKey: '   ' })).toThrow(/non-empty apiKey/);
    expect(resolveChirp3HdVoiceName('  ', 'en-US')).toBe('en-US-Chirp3-HD-Charon');
    expect(resolveChirp3HdVoiceName('Kore', 'nl-NL')).toBe('nl-NL-Chirp3-HD-Kore');
    expect(resolveChirp3HdVoiceName('fr-FR-Chirp3-HD-Aoede', 'en-US')).toBe('fr-FR-Chirp3-HD-Aoede');

    const rawPcm = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const existingWav = wrapPcmAsWav(rawPcm, 24000, 1, 16);
    const toB64 = (bytes: Uint8Array) => {
      let s = '';
      for (const b of bytes) {
        s += String.fromCharCode(b);
      }
      return btoa(s);
    };

    const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> =
      [];
    let returnWav = false;
    const mockFetch: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ audioContent: toB64(returnWav ? existingWav : rawPcm) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const gen = new Chirp3HdPronunciationAudioGenerator({
      apiKey: 'test-chirp-key',
      gcpProjectId: 'proj-alpha',
      defaultVoice: 'Charon',
      fetchFn: mockFetch,
    });

    // 1. IPA with short language code 'nl' -> nl-NL-Chirp3-HD-Charon + PCM wrapped to WAV
    const ipaRes = await gen.generate({
      text: 'Goes',
      ipa: '/ɣus/',
      phonetic: 'HOOS',
      language: 'nl',
      phonemeMode: 'ipa',
    });
    expect(ipaRes.bytes.byteLength).toBe(44 + rawPcm.byteLength);
    expect(requests[0]?.url).toBe(CLOUD_TTS_SYNTHESIZE_ENDPOINT);
    expect(requests[0]?.headers['x-goog-user-project']).toBe('proj-alpha');
    expect(requests[0]?.body['voice']).toEqual({ languageCode: 'nl-NL', name: 'nl-NL-Chirp3-HD-Charon' });

    // 2. Plain mode with phonetic + RIFF WAV passthrough + full voice name language extraction
    returnWav = true;
    const plainRes = await gen.generate({
      text: 'Thomas Mercer',
      phonetic: 'TOM-us MER-ser',
      voice: 'en-GB-Chirp3-HD-Kore',
      phonemeMode: 'plain',
    });
    expect(plainRes.bytes).toEqual(existingWav);
    expect(requests[1]?.body['input']).toEqual({ text: 'TOM-us MER-ser' });
    expect(requests[1]?.body['voice']).toEqual({ languageCode: 'en-GB', name: 'en-GB-Chirp3-HD-Kore' });

    // 3. Plain mode without phonetic, unrecognized single-part language, non-BCP47 voice, custom endpoint
    const genCustom = new Chirp3HdPronunciationAudioGenerator({
      apiKey: 'test-chirp-key',
      defaultLanguageCode: 'en_us',
      defaultVoice: 'Chirp3-HD-Puck',
      endpointUrl: 'https://tts-custom.example.test/v1/text:synthesize',
      fetchFn: mockFetch,
    });
    await genCustom.generate({ text: 'Alder', language: 'xx', phonemeMode: 'plain' });
    await genCustom.generate({ text: 'Bramwell', phonetic: 'BRAM-wel', phonemeMode: 'arpabet' });
    expect(requests[2]?.url).toBe('https://tts-custom.example.test/v1/text:synthesize');
    expect(requests[2]?.headers['x-goog-user-project']).toBeUndefined();
    expect(requests[2]?.body['voice']).toEqual({ languageCode: 'en-US', name: 'Chirp3-HD-Puck' });
    expect(requests[3]?.body['input']).toEqual({ text: 'BRAM-wel' });
    expect(DEFAULT_CHIRP3_HD_VOICE).toBe('en-US-Chirp3-HD-Charon');

    // 4. Error paths: empty text, HTTP 429, malformed JSON
    await expect(gen.generate({ text: '   ' })).rejects.toThrow(/must not be empty/);
    const errGen = new Chirp3HdPronunciationAudioGenerator({
      apiKey: 'test-chirp-key',
      fetchFn: async () => new Response('quota exceeded', { status: 429 }),
    });
    await expect(errGen.generate({ text: 'Alder' })).rejects.toThrow(/HTTP 429/);

    const badGen = new Chirp3HdPronunciationAudioGenerator({
      apiKey: 'test-chirp-key',
      fetchFn: async () => new Response(JSON.stringify({ audioContent: '' }), { status: 200 }),
    });
    await expect(badGen.generate({ text: 'Alder' })).rejects.toThrow(/did not contain audioContent/);
  });
});
