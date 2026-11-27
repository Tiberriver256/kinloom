import { describe, expect, it, vi } from 'vitest';
import {
  buildPronunciationPrompt,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_VOICE,
  GeminiPronunciationAudioGenerator,
  wrapPcmAsWav,
} from './geminiPronunciationGenerator.js';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
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
    const [url, init] = mockFetch.mock.calls[0];
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
    expect(sentBody.contents[0].parts[0].text).toBe('Pronounce "Thomas Mercer" as TOM-us MER-ser.');
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

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-custom-tts:generateContent'
    );
    const sentBody = JSON.parse(String(init?.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
      generationConfig: {
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
      };
    };
    expect(sentBody.contents[0].parts[0].text).toBe(
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
});
