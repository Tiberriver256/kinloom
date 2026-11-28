import { describe, expect, it, vi } from 'vitest';
import {
  buildPronunciationPrompt,
  Chirp3HdPronunciationAudioGenerator,
  CLOUD_TTS_SYNTHESIZE_ENDPOINT,
  DEFAULT_CHIRP3_HD_VOICE,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_VOICE,
  GeminiPronunciationAudioGenerator,
  resolveChirp3HdVoiceName,
  wrapPcmAsWav,
} from './geminiPronunciationGenerator.js';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe('GeminiPronunciationAudioGenerator', () => {
  it('includes language and native orthography alongside IPA and phonetic in buildPronunciationPrompt', () => {
    expect(
      buildPronunciationPrompt({
        text: 'Goes',
        phonetic: 'HOOS',
        ipa: 'ɣus',
        language: 'nl',
      })
    ).toBe('Pronounce "Goes" in Dutch (nl) as /ɣus/ (guide: HOOS).');

    expect(
      buildPronunciationPrompt({
        text: 'Thomas Mercer',
        phonetic: 'TOM-us MER-ser',
        ipa: 'ˈmɜːrsər',
      })
    ).toBe('Pronounce "Thomas Mercer" as /ˈmɜːrsər/ (guide: TOM-us MER-ser).');

    expect(
      buildPronunciationPrompt({
        text: 'Thomas Mercer',
        ipa: '/ˈmɜːrsər/',
      })
    ).toBe('Pronounce "Thomas Mercer" as /ˈmɜːrsər/.');

    expect(
      buildPronunciationPrompt({
        text: 'Thomas Mercer',
        phonetic: 'TOM-us MER-ser',
      })
    ).toBe('Pronounce "Thomas Mercer" as TOM-us MER-ser.');

    expect(
      buildPronunciationPrompt({
        text: 'Goes',
        language: 'nl',
      })
    ).toBe('Pronounce "Goes" in Dutch (nl).');

    expect(
      buildPronunciationPrompt({
        text: 'New Salem',
      })
    ).toBe('New Salem');
  });

  it('calls Gemini TTS generateContent with AUDIO modality and wraps raw L16 PCM in a 44-byte RIFF WAV header', async () => {
    const rawPcm = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const mockFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'audio/L16;codec=pcm;rate=24000',
                      data: bytesToBase64(rawPcm),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const generator = new GeminiPronunciationAudioGenerator({
      apiKey: 'test-gemini-key',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await generator.generate({
      text: 'Thomas Mercer',
      phonetic: 'TOM-us MER-ser',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_TTS_MODEL}:generateContent`
    );
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['x-goog-api-key']).toBe('test-gemini-key');

    const sentBody = JSON.parse(String(init?.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig: {
        responseModalities: string[];
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
      };
    };
    expect(sentBody.contents[0]!.parts[0]!.text).toBe('Pronounce "Thomas Mercer" as TOM-us MER-ser.');
    expect(sentBody.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(sentBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      DEFAULT_GEMINI_TTS_VOICE
    );

    expect(result.contentType).toBe('audio/wav');
    expect(result.ext).toBe('wav');
    expect(result.bytes.byteLength).toBe(44 + rawPcm.byteLength);

    // Verify RIFF/WAVE header fields
    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
    expect(String.fromCharCode(...result.bytes.slice(0, 4))).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + rawPcm.byteLength);
    expect(String.fromCharCode(...result.bytes.slice(8, 12))).toBe('WAVE');
    expect(String.fromCharCode(...result.bytes.slice(12, 16))).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(String.fromCharCode(...result.bytes.slice(36, 40))).toBe('data');
    expect(view.getUint32(40, true)).toBe(rawPcm.byteLength);
    expect(result.bytes.slice(44)).toEqual(rawPcm);
  });

  it('passes through audio/wav inlineData without double-wrapping', async () => {
    const existingWav = wrapPcmAsWav(new Uint8Array([0x10, 0x20, 0x30, 0x40]), 24000);
    const mockFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'audio/wav',
                      data: bytesToBase64(existingWav),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const generator = new GeminiPronunciationAudioGenerator({
      apiKey: 'test-gemini-key',
      model: 'gemini-custom-tts',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await generator.generate({
      text: 'Springfield',
      ipa: 'ˈsprɪŋfiːld',
      language: 'en-US',
      voice: 'Kore',
    });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-custom-tts:generateContent'
    );
    const sentBody = JSON.parse(String(init?.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig: {
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
      };
    };
    expect(sentBody.contents[0]!.parts[0]!.text).toBe(
      'Pronounce "Springfield" in American English (en-US) as /ˈsprɪŋfiːld/.'
    );
    expect(sentBody.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(result.bytes).toEqual(existingWav);
    expect(result.contentType).toBe('audio/wav');
    expect(result.ext).toBe('wav');
  });

  it('throws when Gemini TTS returns an HTTP error or omits audio inlineData', async () => {
    const failFetch = vi.fn(async () => new Response('quota exceeded', { status: 429 }));
    const genFail = new GeminiPronunciationAudioGenerator({
      apiKey: 'test-gemini-key',
      fetchFn: failFetch as unknown as typeof fetch,
    });
    await expect(genFail.generate({ text: 'New Salem' })).rejects.toThrow(/HTTP 429/);

    const emptyFetch = vi.fn(
      async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] }), { status: 200 })
    );
    const genEmpty = new GeminiPronunciationAudioGenerator({
      apiKey: 'test-gemini-key',
      fetchFn: emptyFetch as unknown as typeof fetch,
    });
    await expect(genEmpty.generate({ text: 'New Salem' })).rejects.toThrow(
      /did not contain inline audio data/
    );
  });

  it('rejects malformed Gemini JSON responses via Zod schema validation while ignoring extra metadata fields', async () => {
    for (const malformed of [
      null,
      [],
      { candidates: 'not-an-array' },
      { candidates: [{ content: { parts: [{ inlineData: { data: 12345 } }] } }] },
    ]) {
      const badFetch = vi.fn(
        async () =>
          new Response(JSON.stringify(malformed), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      );
      const generator = new GeminiPronunciationAudioGenerator({
        apiKey: 'test-gemini-key',
        fetchFn: badFetch as unknown as typeof fetch,
      });
      await expect(generator.generate({ text: 'New Salem' })).rejects.toThrow(/JSON schema/);
    }

    const rawPcm = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const extraFieldsFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            modelVersion: 'gemini-3.8-flash-tts',
            usageMetadata: { totalTokenCount: 42 },
            candidates: [
              {
                finishReason: 'STOP',
                content: {
                  role: 'model',
                  parts: [
                    { text: 'ignored-note' },
                    {
                      inlineData: {
                        mimeType: 'audio/L16;codec=pcm;rate=24000',
                        data: bytesToBase64(rawPcm),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    const generator = new GeminiPronunciationAudioGenerator({
      apiKey: 'test-gemini-key',
      fetchFn: extraFieldsFetch as unknown as typeof fetch,
    });
    const audio = await generator.generate({ text: 'New Salem' });
    expect(audio.contentType).toBe('audio/wav');
    expect(audio.bytes.slice(44)).toEqual(rawPcm);
  });
});

describe('Chirp3HdPronunciationAudioGenerator', () => {
  it('calls Cloud TTS text:synthesize with x-goog-api-key, x-goog-user-project, IPA customPronunciations, and wraps LINEAR16 PCM as WAV', async () => {
    const rawPcm = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]);
    const mockFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ audioContent: bytesToBase64(rawPcm) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const generator = new Chirp3HdPronunciationAudioGenerator({
      apiKey: 'test-cloud-tts-key',
      gcpProjectId: 'kinloom-archive-prod',
      defaultVoice: 'Charon',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    const result = await generator.generate({
      text: 'Goes',
      ipa: '/ɣus/',
      phonetic: 'HOOS',
      language: 'nl',
      phonemeMode: 'ipa',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe(CLOUD_TTS_SYNTHESIZE_ENDPOINT);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.['x-goog-api-key']).toBe('test-cloud-tts-key');
    expect(headers?.['x-goog-user-project']).toBe('kinloom-archive-prod');

    const sentBody = JSON.parse(String(init?.body)) as {
      input: {
        text: string;
        customPronunciations?: {
          pronunciations: Array<{ phrase: string; phoneticEncoding: string; pronunciation: string }>;
        };
      };
      voice: { languageCode: string; name: string };
      audioConfig: { audioEncoding: string; sampleRateHertz: number };
    };
    expect(sentBody.input.text).toBe('Goes');
    expect(sentBody.input.customPronunciations?.pronunciations).toEqual([
      {
        phrase: 'Goes',
        phoneticEncoding: 'PHONETIC_ENCODING_IPA',
        pronunciation: 'ɣus',
      },
    ]);
    expect(sentBody.voice).toEqual({
      languageCode: 'nl-NL',
      name: 'nl-NL-Chirp3-HD-Charon',
    });
    expect(sentBody.audioConfig).toEqual({
      audioEncoding: 'LINEAR16',
      sampleRateHertz: 24000,
    });

    expect(result.contentType).toBe('audio/wav');
    expect(result.ext).toBe('wav');
    expect(result.bytes.byteLength).toBe(44 + rawPcm.byteLength);
    expect(String.fromCharCode(...result.bytes.slice(0, 4))).toBe('RIFF');
    expect(result.bytes.slice(44)).toEqual(rawPcm);
  });

  it('passes through RIFF WAV audioContent, supports plain/arpabet modes, and resolves full voice language codes', async () => {
    const existingWav = wrapPcmAsWav(new Uint8Array([0x0a, 0x0b, 0x0c, 0x0d]), 24000);
    const sentPayloads: Array<{
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];
    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      sentPayloads.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ audioContent: bytesToBase64(existingWav) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const generator = new Chirp3HdPronunciationAudioGenerator({
      apiKey: 'test-cloud-tts-key',
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    // Plain mode omits customPronunciations and speaks phonetic respelling
    const plainRes = await generator.generate({
      text: 'Thomas Mercer',
      phonetic: 'TOM-us MER-ser',
      ipa: 'ˈmɜːrsər',
      voice: 'en-GB-Chirp3-HD-Kore',
      phonemeMode: 'plain',
    });
    expect(plainRes.bytes).toEqual(existingWav);
    expect(sentPayloads[0]?.headers['x-goog-user-project']).toBeUndefined();
    expect(sentPayloads[0]?.body['input']).toEqual({ text: 'TOM-us MER-ser' });
    expect(sentPayloads[0]?.body['voice']).toEqual({
      languageCode: 'en-GB',
      name: 'en-GB-Chirp3-HD-Kore',
    });

    // ARPAbet without IPA falls back to phonetic respelling; default voice uses en-US
    await generator.generate({
      text: 'Bramwell',
      phonetic: 'BRAM-wel',
      language: 'en_us',
      phonemeMode: 'arpabet',
    });
    expect(sentPayloads[1]?.body['input']).toEqual({ text: 'BRAM-wel' });
    expect(sentPayloads[1]?.body['voice']).toEqual({
      languageCode: 'en-US',
      name: DEFAULT_CHIRP3_HD_VOICE,
    });

    expect(resolveChirp3HdVoiceName('   ', 'en-US')).toBe('en-US-Chirp3-HD-Charon');
    expect(resolveChirp3HdVoiceName('Kore', 'de-DE')).toBe('de-DE-Chirp3-HD-Kore');
    expect(resolveChirp3HdVoiceName('fr-FR-Chirp3-HD-Aoede', 'en-US')).toBe('fr-FR-Chirp3-HD-Aoede');
  });

  it('rejects empty apiKey, empty text, HTTP errors, and malformed responses', async () => {
    expect(() => new Chirp3HdPronunciationAudioGenerator({ apiKey: '   ' })).toThrow(/non-empty apiKey/);

    const failFetch = vi.fn(async () => new Response('service unavailable', { status: 503 }));
    const genFail = new Chirp3HdPronunciationAudioGenerator({
      apiKey: 'test-cloud-tts-key',
      fetchFn: failFetch as unknown as typeof fetch,
    });
    await expect(genFail.generate({ text: '   ' })).rejects.toThrow(/must not be empty/);
    await expect(genFail.generate({ text: 'New Salem' })).rejects.toThrow(/HTTP 503/);

    const badJsonFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ audioContent: '' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const genBad = new Chirp3HdPronunciationAudioGenerator({
      apiKey: 'test-cloud-tts-key',
      fetchFn: badJsonFetch as unknown as typeof fetch,
    });
    await expect(genBad.generate({ text: 'New Salem' })).rejects.toThrow(/did not contain audioContent/);

    // Unrecognized single-part language, non-BCP47 hyphenated voice, custom endpoint, plain without phonetic, and default phonemeMode
    const rawPcm2 = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const customBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const customFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      customBodies.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ audioContent: bytesToBase64(rawPcm2) }), { status: 200 });
    });
    const genCustom = new Chirp3HdPronunciationAudioGenerator({
      apiKey: 'test-cloud-tts-key',
      defaultLanguageCode: 'en_gb',
      defaultVoice: 'Chirp3-HD-Puck',
      endpointUrl: 'https://tts-proxy.example.test/v1/text:synthesize',
      fetchFn: customFetch as unknown as typeof fetch,
    });
    await genCustom.generate({ text: 'Alder', language: 'xx' });
    await genCustom.generate({ text: 'Mercer', phonemeMode: 'plain' });
    expect(customBodies[0]?.url).toBe('https://tts-proxy.example.test/v1/text:synthesize');
    expect(customBodies[0]?.body['voice']).toEqual({ languageCode: 'en-GB', name: 'Chirp3-HD-Puck' });
    expect(customBodies[1]?.body['input']).toEqual({ text: 'Mercer' });
  });
});
