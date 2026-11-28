import type {
  PronunciationAudioGenerator,
  PronunciationAudioResult,
  PronunciationPhonemeMode,
} from '@kinloom/core';
import { z } from 'zod';

export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';
export const DEFAULT_GEMINI_TTS_VOICE = 'Charon';
export const DEFAULT_OPENAI_TTS_MODEL = 'kokoro';
export const DEFAULT_OPENAI_TTS_VOICE = 'alloy';
export const CLOUD_TTS_SYNTHESIZE_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
export const DEFAULT_CHIRP3_HD_LANGUAGE = 'en-US';
export const DEFAULT_CHIRP3_HD_VOICE = 'en-US-Chirp3-HD-Charon';

export interface GeminiPronunciationAudioGeneratorOptions {
  apiKey: string;
  model?: string;
  defaultVoice?: string;
  fetchFn?: typeof fetch | undefined;
}

export interface OpenAiSpeechPronunciationGeneratorOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  model?: string;
  defaultVoice?: string;
  fetchFn?: typeof fetch | undefined;
}

export interface Chirp3HdPronunciationAudioGeneratorOptions {
  apiKey: string;
  gcpProjectId?: string | undefined;
  defaultVoice?: string;
  defaultLanguageCode?: string;
  endpointUrl?: string;
  fetchFn?: typeof fetch | undefined;
}

const GeminiInlineDataSchema = z.object({
  mimeType: z.string().optional(),
  data: z.string().optional(),
});

const GeminiContentPartSchema = z.object({
  inlineData: GeminiInlineDataSchema.optional(),
});

const GeminiCandidateSchema = z.object({
  content: z
    .object({
      parts: z.array(GeminiContentPartSchema).optional(),
    })
    .optional(),
});

const GeminiGenerateContentResponseSchema = z.object({
  candidates: z.array(GeminiCandidateSchema).optional(),
  error: z
    .object({
      message: z.string().optional(),
      code: z.number().optional(),
    })
    .optional(),
});

const CloudTtsSynthesizeResponseSchema = z.object({
  audioContent: z.string().min(1),
});

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function isRiffWav(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x41 && // A
    bytes[10] === 0x56 && // V
    bytes[11] === 0x45 // E
  );
}

function parseMimeParamInt(mimeType: string, key: string, fallback: number): number {
  const match = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*(\\d+)`, 'i').exec(mimeType);
  if (!match) {
    return fallback;
  }
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Wraps raw signed 16-bit little-endian PCM bytes in a minimal 44-byte RIFF/WAVE header.
 */
export function wrapPcmAsWav(
  pcmBytes: Uint8Array,
  sampleRate = 24000,
  numChannels = 1,
  bitsPerSample = 16
): Uint8Array {
  const dataLength = pcmBytes.byteLength;
  const wav = new Uint8Array(44 + dataLength);
  const view = new DataView(wav.buffer);

  wav[0] = 0x52;
  wav[1] = 0x49;
  wav[2] = 0x46;
  wav[3] = 0x46;
  view.setUint32(4, 36 + dataLength, true);
  wav[8] = 0x57;
  wav[9] = 0x41;
  wav[10] = 0x56;
  wav[11] = 0x45;

  wav[12] = 0x66;
  wav[13] = 0x6d;
  wav[14] = 0x74;
  wav[15] = 0x20;
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  view.setUint32(28, byteRate, true);
  const blockAlign = numChannels * (bitsPerSample / 8);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  wav[36] = 0x64;
  wav[37] = 0x61;
  wav[38] = 0x74;
  wav[39] = 0x61;
  view.setUint32(40, dataLength, true);
  wav.set(pcmBytes, 44);

  return wav;
}

const LANGUAGE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  nl: 'Dutch',
  sv: 'Swedish',
  fi: 'Finnish',
  pl: 'Polish',
  de: 'German',
  fr: 'French',
  it: 'Italian',
  es: 'Spanish',
  no: 'Norwegian',
  nb: 'Norwegian',
  nn: 'Norwegian',
  da: 'Danish',
  en: 'English',
  'en-us': 'American English',
  'en-gb': 'British English',
};

const CHIRP_BCP47_DEFAULTS: Readonly<Record<string, string>> = {
  en: 'en-US',
  nl: 'nl-NL',
  sv: 'sv-SE',
  fi: 'fi-FI',
  pl: 'pl-PL',
  de: 'de-DE',
  fr: 'fr-FR',
  it: 'it-IT',
  es: 'es-ES',
  no: 'nb-NO',
  nb: 'nb-NO',
  nn: 'nb-NO',
  da: 'da-DK',
};

function formatLanguageDirective(language: string): string {
  const trimmed = language.trim();
  const lower = trimmed.toLowerCase();
  const baseLang = lower.split(/[-_]/)[0] ?? '';
  const display = LANGUAGE_DISPLAY_NAMES[lower] ?? LANGUAGE_DISPLAY_NAMES[baseLang];
  return display ? `${display} (${trimmed})` : trimmed;
}

function trimEdgeSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(start, end);
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function normalizeChirpLanguageCode(language: string | undefined, fallback: string): string {
  const trimmed = language?.trim();
  if (!trimmed) {
    return fallback;
  }
  const normalized = trimmed.replaceAll('_', '-');
  const lower = normalized.toLowerCase();
  const directDefault = CHIRP_BCP47_DEFAULTS[lower];
  if (directDefault) {
    return directDefault;
  }
  const [langPart, regionPart] = normalized.split('-').filter((part) => part.length > 0);
  if (langPart && regionPart) {
    return `${langPart.toLowerCase()}-${regionPart.toUpperCase()}`;
  }
  return fallback;
}

function extractLanguageCodeFromChirpVoice(voice: string): string | null {
  const match = /^([a-z]{2,3})-([a-z]{2})-/i.exec(voice.trim());
  if (!match || !match[1] || !match[2]) {
    return null;
  }
  return `${match[1].toLowerCase()}-${match[2].toUpperCase()}`;
}

export function resolveChirp3HdVoiceName(voice: string, languageCode: string): string {
  const trimmed = voice.trim();
  if (!trimmed) {
    return `${languageCode}-Chirp3-HD-Charon`;
  }
  if (trimmed.includes('-')) {
    return trimmed;
  }
  return `${languageCode}-Chirp3-HD-${trimmed}`;
}

export function buildPronunciationPrompt(params: {
  text: string;
  phonetic?: string;
  ipa?: string;
  language?: string;
  phonemeMode?: PronunciationPhonemeMode;
}): string {
  const mode: PronunciationPhonemeMode = params.phonemeMode ?? 'ipa';
  const text = params.text.trim();
  const rawIpa = params.ipa?.trim();
  const strippedIpa = rawIpa ? trimEdgeSlashes(rawIpa).trim() : '';
  const ipa = mode === 'plain' ? '' : strippedIpa ? `/${strippedIpa}/` : '';
  const phonetic = params.phonetic?.trim() ?? '';
  const language = params.language?.trim() ?? '';

  if (!text) {
    if (mode === 'arpabet' && phonetic) {
      const cue = ipa ? `ARPAbet ${phonetic} (IPA: ${ipa})` : `ARPAbet ${phonetic}`;
      return language ? `Pronounce in ${formatLanguageDirective(language)} as ${cue}.` : cue;
    }
    if (ipa && phonetic) {
      return language
        ? `Pronounce in ${formatLanguageDirective(language)} as ${ipa} (guide: ${phonetic}).`
        : `${ipa} (guide: ${phonetic})`;
    }
    if (ipa) {
      return language ? `Pronounce in ${formatLanguageDirective(language)} as ${ipa}.` : ipa;
    }
    if (phonetic) {
      return language ? `Pronounce in ${formatLanguageDirective(language)} as ${phonetic}.` : phonetic;
    }
    return '';
  }

  if (!ipa && !phonetic && !language) {
    return text;
  }

  const parts: string[] = [`Pronounce "${text}"`];
  if (language) {
    parts.push(`in ${formatLanguageDirective(language)}`);
  }
  if (mode === 'arpabet') {
    if (phonetic && ipa) {
      parts.push(`as ARPAbet ${phonetic} (IPA: ${ipa})`);
    } else if (phonetic) {
      parts.push(`as ARPAbet ${phonetic}`);
    } else if (ipa) {
      parts.push(`as ${ipa}`);
    }
  } else if (ipa && phonetic) {
    parts.push(`as ${ipa} (guide: ${phonetic})`);
  } else if (ipa) {
    parts.push(`as ${ipa}`);
  } else if (phonetic) {
    parts.push(`as ${phonetic}`);
  }
  return `${parts.join(' ')}.`;
}

export class GeminiPronunciationAudioGenerator implements PronunciationAudioGenerator {
  readonly adapterKind = 'gemini-tts';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly defaultVoice: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: GeminiPronunciationAudioGeneratorOptions) {
    if (!options.apiKey?.trim()) {
      throw new Error('GeminiPronunciationAudioGenerator requires a non-empty apiKey.');
    }
    this.apiKey = options.apiKey.trim();
    this.model = options.model?.trim() || DEFAULT_GEMINI_TTS_MODEL;
    this.defaultVoice = options.defaultVoice?.trim() || DEFAULT_GEMINI_TTS_VOICE;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async generate(params: {
    text: string;
    phonetic?: string;
    ipa?: string;
    language?: string;
    voice?: string;
    phonemeMode?: PronunciationPhonemeMode;
  }): Promise<PronunciationAudioResult> {
    const promptText = buildPronunciationPrompt(params);
    if (!promptText) {
      throw new Error('Pronunciation text must not be empty.');
    }

    const voiceName = params.voice?.trim() || this.defaultVoice;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;

    const response = await this.fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: promptText }],
          },
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Gemini TTS request failed with HTTP ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const rawPayload: unknown = await response.json();
    const parsedPayload = GeminiGenerateContentResponseSchema.safeParse(rawPayload);
    if (!parsedPayload.success) {
      throw new Error('Gemini TTS response did not match expected generateContent JSON schema.');
    }
    const payload = parsedPayload.data;
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const audioPart = parts.find(
      (part) => typeof part.inlineData?.data === 'string' && part.inlineData.data.length > 0
    );
    if (!audioPart?.inlineData?.data) {
      throw new Error('Gemini TTS response did not contain inline audio data.');
    }

    const mimeType = audioPart.inlineData.mimeType ?? 'audio/L16;codec=pcm;rate=24000';
    const rawBytes = decodeBase64ToBytes(audioPart.inlineData.data);
    const normalizedMime = mimeType.toLowerCase();

    let wavBytes: Uint8Array;
    if (normalizedMime.includes('audio/wav') || isRiffWav(rawBytes)) {
      wavBytes = rawBytes;
    } else {
      const sampleRate = parseMimeParamInt(mimeType, 'rate', 24000);
      const channels = parseMimeParamInt(mimeType, 'channels', 1);
      wavBytes = wrapPcmAsWav(rawBytes, sampleRate, channels, 16);
    }

    return {
      bytes: wavBytes,
      contentType: 'audio/wav',
      ext: 'wav',
    };
  }
}

export class Chirp3HdPronunciationAudioGenerator implements PronunciationAudioGenerator {
  readonly adapterKind = 'chirp3-hd';
  private readonly apiKey: string;
  private readonly gcpProjectId: string | null;
  private readonly defaultVoice: string;
  private readonly defaultLanguageCode: string;
  private readonly endpointUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: Chirp3HdPronunciationAudioGeneratorOptions) {
    if (!options.apiKey?.trim()) {
      throw new Error('Chirp3HdPronunciationAudioGenerator requires a non-empty apiKey.');
    }
    this.apiKey = options.apiKey.trim();
    const trimmedProject = options.gcpProjectId?.trim() ?? '';
    this.gcpProjectId = trimmedProject.length > 0 ? trimmedProject : null;
    this.defaultLanguageCode = normalizeChirpLanguageCode(
      options.defaultLanguageCode,
      DEFAULT_CHIRP3_HD_LANGUAGE
    );
    this.defaultVoice = options.defaultVoice?.trim() || DEFAULT_CHIRP3_HD_VOICE;
    this.endpointUrl = options.endpointUrl?.trim() || CLOUD_TTS_SYNTHESIZE_ENDPOINT;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async generate(params: {
    text: string;
    phonetic?: string;
    ipa?: string;
    language?: string;
    voice?: string;
    phonemeMode?: PronunciationPhonemeMode;
  }): Promise<PronunciationAudioResult> {
    const mode: PronunciationPhonemeMode = params.phonemeMode ?? 'ipa';
    const text = params.text.trim();
    const phonetic = params.phonetic?.trim() ?? '';
    const rawIpa = params.ipa?.trim() ?? '';
    const strippedIpa = rawIpa ? trimEdgeSlashes(rawIpa).trim() : '';

    let spokenText = text;
    let customPronunciations:
      | {
          pronunciations: Array<{
            phrase: string;
            phoneticEncoding: 'PHONETIC_ENCODING_IPA';
            pronunciation: string;
          }>;
        }
      | undefined;

    if (mode === 'plain') {
      spokenText = phonetic || text;
    } else if (strippedIpa && text) {
      spokenText = text;
      customPronunciations = {
        pronunciations: [
          {
            phrase: text,
            phoneticEncoding: 'PHONETIC_ENCODING_IPA',
            pronunciation: strippedIpa,
          },
        ],
      };
    } else {
      spokenText = phonetic || text;
    }

    if (!spokenText) {
      throw new Error('Pronunciation text must not be empty.');
    }

    const rawVoice = params.voice?.trim() || this.defaultVoice;
    const requestedLanguage = params.language?.trim();
    const inferredVoiceLanguage = extractLanguageCodeFromChirpVoice(rawVoice);
    const languageCode = requestedLanguage
      ? normalizeChirpLanguageCode(requestedLanguage, this.defaultLanguageCode)
      : (inferredVoiceLanguage ?? this.defaultLanguageCode);
    const voiceName = resolveChirp3HdVoiceName(rawVoice, languageCode);
    const effectiveLanguageCode = extractLanguageCodeFromChirpVoice(voiceName) ?? languageCode;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey,
    };
    if (this.gcpProjectId) {
      headers['x-goog-user-project'] = this.gcpProjectId;
    }

    const inputPayload: Record<string, unknown> = { text: spokenText };
    if (customPronunciations) {
      inputPayload['customPronunciations'] = customPronunciations;
    }

    const response = await this.fetchFn(this.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: inputPayload,
        voice: {
          languageCode: effectiveLanguageCode,
          name: voiceName,
        },
        audioConfig: {
          audioEncoding: 'LINEAR16',
          sampleRateHertz: 24000,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Google Cloud Chirp 3 HD TTS request failed with HTTP ${response.status}: ${errorText.slice(0, 200)}`
      );
    }

    const rawPayload: unknown = await response.json();
    const parsedPayload = CloudTtsSynthesizeResponseSchema.safeParse(rawPayload);
    if (!parsedPayload.success) {
      throw new Error('Google Cloud Chirp 3 HD TTS response did not contain audioContent.');
    }

    const rawBytes = decodeBase64ToBytes(parsedPayload.data.audioContent);
    const wavBytes = isRiffWav(rawBytes) ? rawBytes : wrapPcmAsWav(rawBytes, 24000, 1, 16);

    return {
      bytes: wavBytes,
      contentType: 'audio/wav',
      ext: 'wav',
    };
  }
}

function normalizeOpenAiSpeechEndpoint(rawBaseUrl: string): string {
  const trimmed = trimTrailingSlashes(rawBaseUrl.trim());
  if (!trimmed) {
    throw new Error('OpenAiSpeechPronunciationGenerator requires a non-empty baseUrl.');
  }
  if (/\/audio\/speech$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/audio/speech`;
}

export class OpenAiSpeechPronunciationGenerator implements PronunciationAudioGenerator {
  readonly adapterKind = 'openai-speech';
  private readonly endpointUrl: string;
  private readonly apiKey: string | null;
  private readonly model: string;
  private readonly defaultVoice: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenAiSpeechPronunciationGeneratorOptions) {
    this.endpointUrl = normalizeOpenAiSpeechEndpoint(options.baseUrl);
    const trimmedKey = options.apiKey?.trim() ?? '';
    this.apiKey = trimmedKey.length > 0 ? trimmedKey : null;
    this.model = options.model?.trim() || DEFAULT_OPENAI_TTS_MODEL;
    this.defaultVoice = options.defaultVoice?.trim() || DEFAULT_OPENAI_TTS_VOICE;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async generate(params: {
    text: string;
    phonetic?: string;
    ipa?: string;
    language?: string;
    voice?: string;
    phonemeMode?: PronunciationPhonemeMode;
  }): Promise<PronunciationAudioResult> {
    const inputText = buildPronunciationPrompt(params);
    if (!inputText) {
      throw new Error('Pronunciation text must not be empty.');
    }

    const voice = params.voice?.trim() || this.defaultVoice;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.apiKey) {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchFn(this.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.model,
        input: inputText,
        voice,
        response_format: 'wav',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `OpenAI-compatible speech request failed with HTTP ${response.status}: ${errorText.slice(0, 200)}`
      );
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error('OpenAI-compatible speech response returned an empty audio body.');
    }

    const rawMime = (response.headers.get('content-type') ?? '').toLowerCase();
    const isMp3 = rawMime.includes('audio/mpeg') || rawMime.includes('audio/mp3');
    return {
      bytes,
      contentType: isMp3 ? 'audio/mpeg' : 'audio/wav',
      ext: isMp3 ? 'mp3' : 'wav',
    };
  }
}
