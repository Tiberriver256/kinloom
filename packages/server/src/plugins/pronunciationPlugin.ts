import type {
  KinloomServerPluginStatusContext,
  PluginSettingScalarValue,
  PluginSettingsSchema,
  PronunciationPhonemeMode,
} from '@kinloom/core';
import type { KinloomServerPlugin } from '../http/pluginLifecycle.js';
import {
  DEFAULT_PRONUNCIATION_RUNTIME_CONFIG,
  loadPersistedPronunciationConfig,
  PRONUNCIATION_PLUGIN_ID,
  type PronunciationFallbackBackend,
  type PronunciationPluginRuntimeConfig,
  type PronunciationTtsBackend,
  parsePronunciationRuntimeConfig,
  resolveActivePronunciationGeneratorLabel,
} from '../services/pronunciationRuntime.js';
import { KINLOOM_SERVER_VERSION } from '../version.js';

export {
  PRONUNCIATION_PLUGIN_ID,
  type PronunciationFallbackBackend,
  type PronunciationPhonemeMode,
  type PronunciationPluginRuntimeConfig,
  type PronunciationTtsBackend,
};

export interface PronunciationPluginOptions {
  readonly defaultPrimaryBackend?: PronunciationTtsBackend;
  readonly defaultFallbackBackend?: PronunciationFallbackBackend;
  readonly defaultOpenAiBaseUrl?: string;
  readonly defaultModel?: string;
  readonly defaultVoice?: string;
  readonly defaultChirpVoice?: string;
  readonly defaultGcpProjectId?: string;
  readonly defaultPhonemeMode?: PronunciationPhonemeMode;
  readonly defaultAutoGenerateOnSave?: boolean;
}

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
            defaultValue:
              options.defaultPrimaryBackend ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.primaryBackend,
            helpText: 'Primary text-to-speech provider used when synthesizing pronunciation audio.',
            options: [
              { value: 'gemini', label: 'Google Gemini TTS' },
              { value: 'chirp3-hd', label: 'Google Cloud Chirp 3 HD TTS' },
              { value: 'openai-speech', label: 'OpenAI-Compatible Speech API' },
              { value: 'disabled', label: 'Disabled (Lexicon Text Only)' },
            ],
          },
          {
            key: 'fallback_backend',
            label: 'Fallback TTS Backend',
            type: 'select',
            required: true,
            defaultValue:
              options.defaultFallbackBackend ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.fallbackBackend,
            helpText: 'Optional secondary backend tried if the primary provider is unavailable.',
            options: [
              { value: 'none', label: 'None' },
              { value: 'gemini', label: 'Google Gemini TTS' },
              { value: 'chirp3-hd', label: 'Google Cloud Chirp 3 HD TTS' },
              { value: 'openai-speech', label: 'OpenAI-Compatible Speech API' },
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
            defaultValue: options.defaultOpenAiBaseUrl ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.openAiBaseUrl,
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
            defaultValue: options.defaultModel ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.defaultModel,
            minLength: 2,
            maxLength: 120,
            helpText: 'Model identifier passed to the active TTS backend.',
          },
          {
            key: 'default_voice',
            label: 'Default Voice',
            type: 'string',
            required: true,
            defaultValue: options.defaultVoice ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.defaultVoice,
            minLength: 1,
            maxLength: 80,
            helpText: 'Speaker voice used when an entity entry does not specify a custom voice.',
          },
          {
            key: 'chirp_voice',
            label: 'Chirp 3 HD Default Voice',
            type: 'string',
            defaultValue: options.defaultChirpVoice ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.chirpVoice,
            placeholder: 'en-US-Chirp3-HD-Charon',
            maxLength: 80,
            helpText:
              'Google Cloud Chirp 3 HD voice name or speaker (for example, en-US-Chirp3-HD-Charon or Charon).',
          },
          {
            key: 'gcp_project_id',
            label: 'Google Cloud Quota Project ID',
            type: 'string',
            defaultValue: options.defaultGcpProjectId ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.gcpProjectId,
            placeholder: 'optional-gcp-project-id',
            maxLength: 120,
            helpText:
              'Optional GCP project ID sent via x-goog-user-project when calling Google Cloud Text-to-Speech.',
          },
          {
            key: 'phoneme_mode',
            label: 'Phoneme Mode',
            type: 'select',
            required: true,
            defaultValue: options.defaultPhonemeMode ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.phonemeMode,
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
            defaultValue:
              options.defaultAutoGenerateOnSave ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.autoGenerateOnSave,
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
            key: 'google_cloud_tts_api_key',
            label: 'Google Cloud TTS API Key',
            type: 'secret',
            placeholder: 'Enter Google Cloud TTS API key',
            minLength: 8,
            maxLength: 512,
            helpText: 'Write-only API key for Google Cloud Text-to-Speech (Chirp 3 HD).',
          },
          {
            key: 'openai_api_key',
            label: 'OpenAI-Compatible API Key',
            type: 'secret',
            placeholder: 'Enter OpenAI-compatible API key',
            minLength: 8,
            maxLength: 512,
            helpText: 'Write-only bearer token for OpenAI-compatible speech endpoints.',
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
const PRONUNCIATION_DOCS = {
  id: 'docs-pronunciation',
  title: 'Pronunciation & TTS',
  summary: 'Canonical surname/place pronunciation lexicon and neural text-to-speech audio generation.',
  sections: [
    {
      id: 'lexicon',
      heading: 'Pronunciation Lexicon & Audio Cache',
      markdown:
        'Stores IPA and phonetic spellings for family surnames and historic place names. Generated audio clips are content-addressed in R2 to avoid redundant synthesis calls.',
    },
    {
      id: 'tts-providers',
      heading: 'Configuring TTS Providers',
      markdown:
        'Select primary and optional fallback TTS backends (Google Gemini TTS, Google Cloud Chirp 3 HD TTS, or OpenAI-compatible speech) and configure write-only provider credentials in **Plugins & Integrations**. Secret keys are never returned to the browser.',
    },
  ],
} as const;

export function createPronunciationPlugin(
  options: PronunciationPluginOptions = {}
): KinloomServerPlugin & { readonly getRuntimeConfig: () => PronunciationPluginRuntimeConfig } {
  const settingsSchema = buildPronunciationSettingsSchema(options);

  const initialConfig: PronunciationPluginRuntimeConfig = {
    primaryBackend: options.defaultPrimaryBackend ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.primaryBackend,
    fallbackBackend: options.defaultFallbackBackend ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.fallbackBackend,
    openAiBaseUrl: options.defaultOpenAiBaseUrl ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.openAiBaseUrl,
    defaultModel: options.defaultModel ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.defaultModel,
    defaultVoice: options.defaultVoice ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.defaultVoice,
    chirpVoice: options.defaultChirpVoice ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.chirpVoice,
    gcpProjectId: options.defaultGcpProjectId ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.gcpProjectId,
    phonemeMode: options.defaultPhonemeMode ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.phonemeMode,
    autoGenerateOnSave:
      options.defaultAutoGenerateOnSave ?? DEFAULT_PRONUNCIATION_RUNTIME_CONFIG.autoGenerateOnSave,
  };

  let runtimeConfig: PronunciationPluginRuntimeConfig = { ...initialConfig };

  return {
    id: PRONUNCIATION_PLUGIN_ID,
    name: 'Pronunciation & TTS',
    documentation: PRONUNCIATION_DOCS,
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
    getStatus: async (ctx?: KinloomServerPluginStatusContext) => {
      const { config } = await loadPersistedPronunciationConfig(
        ctx?.ports.pluginSettingsStore,
        runtimeConfig
      );
      runtimeConfig = config;
      return {
        status: config.primaryBackend === 'disabled' ? 'disabled' : 'active',
        detail: `primary=${config.primaryBackend}, phoneme=${config.phonemeMode}`,
      };
    },
    getReadonlySettings: (ctx): Readonly<Record<string, PluginSettingScalarValue>> => {
      const effectiveConfig = parsePronunciationRuntimeConfig(ctx.values, initialConfig);
      const configuredProviders: string[] = [];
      if (ctx.configuredSecrets.gemini_api_key) {
        configuredProviders.push('gemini');
      }
      if (ctx.configuredSecrets.google_cloud_tts_api_key) {
        configuredProviders.push('chirp3-hd');
      }
      if (ctx.configuredSecrets.openai_api_key) {
        configuredProviders.push('openai-speech');
      }
      const activeGenerator = resolveActivePronunciationGeneratorLabel({
        config: effectiveConfig,
        configuredSecrets: ctx.configuredSecrets,
        injectedGenerator: ctx.ports.pronunciationGenerator,
        envDefaults: ctx.ports.pronunciationEnv,
      });
      return {
        active_generator: activeGenerator,
        lexicon_store: ctx.ports.pronunciationLexiconStore
          ? (ctx.ports.pronunciationLexiconStore.adapterKind ?? 'custom')
          : 'none',
        configured_credentials:
          configuredProviders.length > 0 ? configuredProviders.join(', ') : 'none stored',
      };
    },
    onSettingsUpdated: (event) => {
      runtimeConfig = parsePronunciationRuntimeConfig(event.values, initialConfig);
    },
  };
}
