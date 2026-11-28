import type { PluginSettingScalarValue, PluginSettingsSchema } from '@kinloom/core';
import type { KinloomServerPlugin } from '../http/pluginLifecycle.js';
import { KINLOOM_SERVER_VERSION } from '../version.js';

export const PRONUNCIATION_PLUGIN_ID = 'kinloom-pronunciation';

export type PronunciationTtsBackend = 'gemini' | 'openai-speech' | 'chirp3-hd' | 'disabled';
export type PronunciationFallbackBackend = 'none' | 'gemini' | 'openai-speech' | 'chirp3-hd';
export type PronunciationPhonemeMode = 'ipa' | 'arpabet' | 'plain';

export interface PronunciationPluginOptions {
  readonly defaultPrimaryBackend?: PronunciationTtsBackend;
  readonly defaultFallbackBackend?: PronunciationFallbackBackend;
  readonly defaultOpenAiBaseUrl?: string;
  readonly defaultModel?: string;
  readonly defaultVoice?: string;
  readonly defaultPhonemeMode?: PronunciationPhonemeMode;
  readonly defaultAutoGenerateOnSave?: boolean;
}

export interface PronunciationPluginRuntimeConfig {
  readonly primaryBackend: PronunciationTtsBackend;
  readonly fallbackBackend: PronunciationFallbackBackend;
  readonly openAiBaseUrl: string;
  readonly defaultModel: string;
  readonly defaultVoice: string;
  readonly phonemeMode: PronunciationPhonemeMode;
  readonly autoGenerateOnSave: boolean;
}

const VALID_PRIMARY_BACKENDS = new Set<PronunciationTtsBackend>([
  'gemini',
  'openai-speech',
  'chirp3-hd',
  'disabled',
]);

const VALID_FALLBACK_BACKENDS = new Set<PronunciationFallbackBackend>([
  'none',
  'gemini',
  'openai-speech',
  'chirp3-hd',
]);

const VALID_PHONEME_MODES = new Set<PronunciationPhonemeMode>(['ipa', 'arpabet', 'plain']);

function buildPronunciationSettingsSchema(options: PronunciationPluginOptions): PluginSettingsSchema {
  return {
    title: 'Pronunciation & TTS Settings',
    description:
      'Configure text-to-speech backends, phoneme guidance, and write-only provider API keys for archival name and place pronunciations.',
    sections: [
      {
        id: 'runtime_status',
        title: 'Active TTS Runtime',
        description:
          'Read-only status of the active pronunciation adapters and configured write-only credentials.',
        fields: [
          {
            key: 'active_generator',
            label: 'Active TTS Generator',
            type: 'readonly',
            defaultValue: 'none',
          },
          {
            key: 'lexicon_store',
            label: 'Pronunciation Lexicon Store',
            type: 'readonly',
            defaultValue: 'none',
          },
          {
            key: 'configured_credentials',
            label: 'Configured Provider Keys',
            type: 'readonly',
            defaultValue: 'none',
          },
        ],
      },
      {
        id: 'tts_routing',
        title: 'TTS Backend & Phonetics',
        description: 'Select primary and fallback synthesis providers, voice defaults, and phoneme notation.',
        fields: [
          {
            key: 'primary_backend',
            label: 'Primary TTS Backend',
            type: 'select',
            required: true,
            defaultValue: options.defaultPrimaryBackend ?? 'gemini',
            helpText: 'Primary text-to-speech provider used when synthesizing pronunciation audio.',
            options: [
              { value: 'gemini', label: 'Google Gemini TTS' },
              { value: 'openai-speech', label: 'OpenAI-Compatible Speech API' },
              { value: 'chirp3-hd', label: 'Google Cloud Chirp 3 HD' },
              { value: 'disabled', label: 'Disabled (Lexicon Text Only)' },
            ],
          },
          {
            key: 'fallback_backend',
            label: 'Fallback TTS Backend',
            type: 'select',
            required: true,
            defaultValue: options.defaultFallbackBackend ?? 'none',
            helpText: 'Optional secondary backend tried if the primary provider is unavailable.',
            options: [
              { value: 'none', label: 'None' },
              { value: 'gemini', label: 'Google Gemini TTS' },
              { value: 'openai-speech', label: 'OpenAI-Compatible Speech API' },
              { value: 'chirp3-hd', label: 'Google Cloud Chirp 3 HD' },
            ],
            validate: (val, all) => {
              if (typeof val === 'string' && val !== 'none' && val === all.primary_backend) {
                return 'Fallback TTS Backend must differ from Primary TTS Backend.';
              }
              return null;
            },
          },
          {
            key: 'openai_base_url',
            label: 'OpenAI-Compatible Endpoint URL',
            type: 'url',
            defaultValue: options.defaultOpenAiBaseUrl ?? '',
            placeholder: 'https://api.openai.com/v1',
            allowedProtocols: ['https:', 'http:'],
            helpText:
              'Optional base URL for an OpenAI-compatible speech endpoint (for example, Kokoro or a local GPU TTS proxy).',
            validate: (val, all) => {
              const usesOpenAi =
                all.primary_backend === 'openai-speech' || all.fallback_backend === 'openai-speech';
              if (usesOpenAi && (typeof val !== 'string' || val.trim().length === 0)) {
                return 'OpenAI-Compatible Endpoint URL is required when OpenAI-Compatible Speech API is selected.';
              }
              return null;
            },
          },
          {
            key: 'default_model',
            label: 'Default TTS Model',
            type: 'string',
            required: true,
            defaultValue: options.defaultModel ?? 'gemini-3.8-flash-tts',
            minLength: 2,
            maxLength: 120,
            helpText: 'Model identifier passed to the active TTS backend.',
          },
          {
            key: 'default_voice',
            label: 'Default Voice',
            type: 'string',
            required: true,
            defaultValue: options.defaultVoice ?? 'Charon',
            minLength: 1,
            maxLength: 80,
            helpText: 'Speaker voice used when an entity entry does not specify a custom voice.',
          },
          {
            key: 'phoneme_mode',
            label: 'Phoneme Mode',
            type: 'select',
            required: true,
            defaultValue: options.defaultPhonemeMode ?? 'ipa',
            helpText: 'Preferred phonetic hint representation sent to TTS prompts.',
            options: [
              { value: 'ipa', label: 'IPA (International Phonetic Alphabet)' },
              { value: 'arpabet', label: 'ARPAbet' },
              { value: 'plain', label: 'Plain phonetic respelling' },
            ],
          },
          {
            key: 'auto_generate_on_save',
            label: 'Auto-generate audio on lexicon save',
            type: 'boolean',
            defaultValue: options.defaultAutoGenerateOnSave ?? true,
            helpText: 'Synthesize audio clips automatically when an editor saves a shared lexicon term.',
          },
        ],
      },
      {
        id: 'provider_credentials',
        title: 'Provider API Keys (Write-Only)',
        description:
          'Credentials are stored isolated from non-secret settings, masked in Admin UI, and never returned in plain text.',
        fields: [
          {
            key: 'gemini_api_key',
            label: 'Gemini API Key',
            type: 'string',
            secret: true,
            placeholder: 'Enter Gemini API key',
            minLength: 8,
            maxLength: 512,
            helpText: 'Write-only API key for Google Gemini TTS.',
          },
          {
            key: 'openai_api_key',
            label: 'OpenAI-Compatible API Key',
            type: 'string',
            secret: true,
            placeholder: 'Enter OpenAI-compatible API key',
            minLength: 8,
            maxLength: 512,
            helpText: 'Write-only bearer token for OpenAI-compatible speech endpoints.',
          },
          {
            key: 'chirp3_api_key',
            label: 'Chirp 3 HD API Key',
            type: 'secret',
            placeholder: 'Enter Google Cloud Chirp 3 HD API key',
            minLength: 8,
            maxLength: 512,
            helpText: 'Write-only credential for Google Cloud Chirp 3 HD synthesis.',
          },
        ],
      },
    ],
  };
}

/**
 * First-class Kinloom server plugin exposing declarative Pronunciation & TTS settings
 * (backends, endpoints, voice/model, phoneme mode, and write-only masked API keys) in Admin Settings.
 */
export function createPronunciationPlugin(
  options: PronunciationPluginOptions = {}
): KinloomServerPlugin & { readonly getRuntimeConfig: () => PronunciationPluginRuntimeConfig } {
  const settingsSchema = buildPronunciationSettingsSchema(options);

  let runtimeConfig: PronunciationPluginRuntimeConfig = {
    primaryBackend: options.defaultPrimaryBackend ?? 'gemini',
    fallbackBackend: options.defaultFallbackBackend ?? 'none',
    openAiBaseUrl: options.defaultOpenAiBaseUrl ?? '',
    defaultModel: options.defaultModel ?? 'gemini-3.8-flash-tts',
    defaultVoice: options.defaultVoice ?? 'Charon',
    phonemeMode: options.defaultPhonemeMode ?? 'ipa',
    autoGenerateOnSave: options.defaultAutoGenerateOnSave ?? true,
  };

  return {
    id: PRONUNCIATION_PLUGIN_ID,
    name: 'Pronunciation & TTS',
    version: KINLOOM_SERVER_VERSION,
    changelog: [
      {
        version: '0.61.0',
        date: '2026-11-28',
        summary: 'Pronunciation lexicon management and write-only TTS secret settings.',
        changes: [
          { category: 'added', text: 'Pronunciation lexicon management and write-only TTS secret settings.' },
        ],
      },
    ],
    status: runtimeConfig.primaryBackend === 'disabled' ? 'disabled' : 'active',
    settingsSchema,
    getRuntimeConfig: () => ({ ...runtimeConfig }),
    getStatus: () => ({
      status: runtimeConfig.primaryBackend === 'disabled' ? 'disabled' : 'active',
      detail: `primary=${runtimeConfig.primaryBackend}, phoneme=${runtimeConfig.phonemeMode}`,
    }),
    getReadonlySettings: (ctx): Readonly<Record<string, PluginSettingScalarValue>> => {
      const configuredProviders: string[] = [];
      if (ctx.configuredSecrets.gemini_api_key) {
        configuredProviders.push('gemini');
      }
      if (ctx.configuredSecrets.openai_api_key) {
        configuredProviders.push('openai-speech');
      }
      if (ctx.configuredSecrets.chirp3_api_key) {
        configuredProviders.push('chirp3-hd');
      }
      return {
        active_generator: ctx.ports.pronunciationGenerator
          ? (ctx.ports.pronunciationGenerator.adapterKind ?? 'custom')
          : 'none',
        lexicon_store: ctx.ports.pronunciationLexiconStore
          ? (ctx.ports.pronunciationLexiconStore.adapterKind ?? 'custom')
          : 'none',
        configured_credentials:
          configuredProviders.length > 0 ? configuredProviders.join(', ') : 'none stored',
      };
    },
    onSettingsUpdated: (event) => {
      const nextPrimary = event.values.primary_backend;
      const nextFallback = event.values.fallback_backend;
      const nextPhoneme = event.values.phoneme_mode;
      runtimeConfig = {
        primaryBackend:
          typeof nextPrimary === 'string' &&
          VALID_PRIMARY_BACKENDS.has(nextPrimary as PronunciationTtsBackend)
            ? (nextPrimary as PronunciationTtsBackend)
            : runtimeConfig.primaryBackend,
        fallbackBackend:
          typeof nextFallback === 'string' &&
          VALID_FALLBACK_BACKENDS.has(nextFallback as PronunciationFallbackBackend)
            ? (nextFallback as PronunciationFallbackBackend)
            : runtimeConfig.fallbackBackend,
        openAiBaseUrl:
          typeof event.values.openai_base_url === 'string'
            ? event.values.openai_base_url
            : runtimeConfig.openAiBaseUrl,
        defaultModel:
          typeof event.values.default_model === 'string' && event.values.default_model.length > 0
            ? event.values.default_model
            : runtimeConfig.defaultModel,
        defaultVoice:
          typeof event.values.default_voice === 'string' && event.values.default_voice.length > 0
            ? event.values.default_voice
            : runtimeConfig.defaultVoice,
        phonemeMode:
          typeof nextPhoneme === 'string' && VALID_PHONEME_MODES.has(nextPhoneme as PronunciationPhonemeMode)
            ? (nextPhoneme as PronunciationPhonemeMode)
            : runtimeConfig.phonemeMode,
        autoGenerateOnSave:
          typeof event.values.auto_generate_on_save === 'boolean'
            ? event.values.auto_generate_on_save
            : runtimeConfig.autoGenerateOnSave,
      };
    },
  };
}
