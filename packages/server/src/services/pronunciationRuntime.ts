import type {
  PluginSettingScalarValue,
  PluginSettingsStore,
  PronunciationAudioGenerator,
  PronunciationAudioResult,
  PronunciationEnvDefaults,
  PronunciationPhonemeMode,
} from '@kinloom/core';
import {
  Chirp3HdPronunciationAudioGenerator,
  DEFAULT_CHIRP3_HD_VOICE,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_VOICE,
  GeminiPronunciationAudioGenerator,
  OpenAiSpeechPronunciationGenerator,
} from './pronunciationGenerators.js';

export const PRONUNCIATION_PLUGIN_ID = 'kinloom-pronunciation';

export type PronunciationTtsBackend = 'gemini' | 'chirp3-hd' | 'openai-speech' | 'disabled';
export type PronunciationFallbackBackend = 'none' | 'gemini' | 'chirp3-hd' | 'openai-speech';

export interface PronunciationPluginRuntimeConfig {
  readonly primaryBackend: PronunciationTtsBackend;
  readonly fallbackBackend: PronunciationFallbackBackend;
  readonly openAiBaseUrl: string;
  readonly defaultModel: string;
  readonly defaultVoice: string;
  readonly chirpVoice: string;
  readonly gcpProjectId: string;
  readonly phonemeMode: PronunciationPhonemeMode;
  readonly autoGenerateOnSave: boolean;
}

export const DEFAULT_PRONUNCIATION_RUNTIME_CONFIG: PronunciationPluginRuntimeConfig = {
  primaryBackend: 'gemini',
  fallbackBackend: 'none',
  openAiBaseUrl: '',
  defaultModel: DEFAULT_GEMINI_TTS_MODEL,
  defaultVoice: DEFAULT_GEMINI_TTS_VOICE,
  chirpVoice: DEFAULT_CHIRP3_HD_VOICE,
  gcpProjectId: '',
  phonemeMode: 'ipa',
  autoGenerateOnSave: true,
};

const VALID_PRIMARY_BACKENDS = new Set<PronunciationTtsBackend>([
  'gemini',
  'chirp3-hd',
  'openai-speech',
  'disabled',
]);
const VALID_FALLBACK_BACKENDS = new Set<PronunciationFallbackBackend>([
  'none',
  'gemini',
  'chirp3-hd',
  'openai-speech',
]);
const VALID_PHONEME_MODES = new Set<PronunciationPhonemeMode>(['ipa', 'arpabet', 'plain']);

export function parsePronunciationRuntimeConfig(
  values: Readonly<Record<string, PluginSettingScalarValue>>,
  fallback: PronunciationPluginRuntimeConfig = DEFAULT_PRONUNCIATION_RUNTIME_CONFIG
): PronunciationPluginRuntimeConfig {
  const rawPrimary = values['primary_backend'];
  const rawFallback = values['fallback_backend'];
  const rawPhoneme = values['phoneme_mode'];
  return {
    primaryBackend:
      typeof rawPrimary === 'string' && VALID_PRIMARY_BACKENDS.has(rawPrimary as PronunciationTtsBackend)
        ? (rawPrimary as PronunciationTtsBackend)
        : fallback.primaryBackend,
    fallbackBackend:
      typeof rawFallback === 'string' &&
      VALID_FALLBACK_BACKENDS.has(rawFallback as PronunciationFallbackBackend)
        ? (rawFallback as PronunciationFallbackBackend)
        : fallback.fallbackBackend,
    openAiBaseUrl:
      typeof values['openai_base_url'] === 'string' ? values['openai_base_url'].trim() : fallback.openAiBaseUrl,
    defaultModel:
      typeof values['default_model'] === 'string' && values['default_model'].trim().length > 0
        ? values['default_model'].trim()
        : fallback.defaultModel,
    defaultVoice:
      typeof values['default_voice'] === 'string' && values['default_voice'].trim().length > 0
        ? values['default_voice'].trim()
        : fallback.defaultVoice,
    chirpVoice:
      typeof values['chirp_voice'] === 'string' && values['chirp_voice'].trim().length > 0
        ? values['chirp_voice'].trim()
        : fallback.chirpVoice,
    gcpProjectId:
      typeof values['gcp_project_id'] === 'string' ? values['gcp_project_id'].trim() : fallback.gcpProjectId,
    phonemeMode:
      typeof rawPhoneme === 'string' && VALID_PHONEME_MODES.has(rawPhoneme as PronunciationPhonemeMode)
        ? (rawPhoneme as PronunciationPhonemeMode)
        : fallback.phonemeMode,
    autoGenerateOnSave:
      typeof values['auto_generate_on_save'] === 'boolean'
        ? values['auto_generate_on_save']
        : fallback.autoGenerateOnSave,
  };
}

export function resolveActivePronunciationGeneratorLabel(params: {
  readonly config: PronunciationPluginRuntimeConfig;
  readonly configuredSecrets: Readonly<Record<string, boolean>>;
  readonly injectedGenerator?: PronunciationAudioGenerator | undefined;
  readonly envDefaults?: PronunciationEnvDefaults | undefined;
}): string {
  const { config, configuredSecrets, injectedGenerator, envDefaults } = params;
  if (config.primaryBackend === 'disabled') {
    return 'disabled';
  }

  const backends: Array<'gemini' | 'chirp3-hd' | 'openai-speech'> = [config.primaryBackend];
  if (config.fallbackBackend !== 'none' && config.fallbackBackend !== config.primaryBackend) {
    backends.push(config.fallbackBackend);
  }

  for (const backend of backends) {
    if (backend === 'gemini') {
      if (configuredSecrets['gemini_api_key'] || envDefaults?.geminiApiKey?.trim()) {
        return 'gemini-tts';
      }
      if (injectedGenerator) {
        return injectedGenerator.adapterKind ?? 'custom';
      }
    } else if (backend === 'chirp3-hd') {
      if (configuredSecrets['google_cloud_tts_api_key'] || envDefaults?.googleCloudTtsApiKey?.trim()) {
        return 'chirp3-hd';
      }
    } else if (backend === 'openai-speech') {
      if (config.openAiBaseUrl.trim().length > 0) {
        return 'openai-speech';
      }
    }
  }

  return injectedGenerator ? (injectedGenerator.adapterKind ?? 'custom') : 'none';
}

export function resolveConfiguredDefaultVoice(config: PronunciationPluginRuntimeConfig): string {
  return config.primaryBackend === 'chirp3-hd' ? config.chirpVoice : config.defaultVoice;
}

class FallbackPronunciationGenerator implements PronunciationAudioGenerator {
  readonly adapterKind: string;
  private readonly primary: PronunciationAudioGenerator;
  private readonly fallback: PronunciationAudioGenerator;
  private readonly primaryDefaultVoice?: string | undefined;

  constructor(
    primary: PronunciationAudioGenerator,
    fallback: PronunciationAudioGenerator,
    primaryDefaultVoice?: string
  ) {
    this.primary = primary;
    this.fallback = fallback;
    this.primaryDefaultVoice = primaryDefaultVoice;
    this.adapterKind = primary.adapterKind ?? 'custom';
  }

  async generate(
    params: Parameters<PronunciationAudioGenerator['generate']>[0]
  ): Promise<PronunciationAudioResult> {
    try {
      return await this.primary.generate(params);
    } catch {
      let fallbackParams = params;
      if (this.primaryDefaultVoice && params.voice === this.primaryDefaultVoice) {
        const { voice: _omittedVoice, ...rest } = params;
        fallbackParams = rest;
      }
      return this.fallback.generate(fallbackParams);
    }
  }
}

export type EffectivePronunciationRuntime =
  | {
      readonly kind: 'disabled';
      readonly config: PronunciationPluginRuntimeConfig;
      readonly hasStoredSettings: boolean;
      readonly activeGeneratorLabel: 'disabled';
    }
  | {
      readonly kind: 'unavailable';
      readonly config: PronunciationPluginRuntimeConfig;
      readonly hasStoredSettings: boolean;
      readonly activeGeneratorLabel: 'none';
    }
  | {
      readonly kind: 'ready';
      readonly config: PronunciationPluginRuntimeConfig;
      readonly hasStoredSettings: boolean;
      readonly generator: PronunciationAudioGenerator;
      readonly activeGeneratorLabel: string;
    };

export async function loadPersistedPronunciationConfig(
  pluginSettingsStore: PluginSettingsStore | undefined,
  fallback: PronunciationPluginRuntimeConfig = DEFAULT_PRONUNCIATION_RUNTIME_CONFIG
): Promise<{
  readonly config: PronunciationPluginRuntimeConfig;
  readonly hasStoredSettings: boolean;
}> {
  if (!pluginSettingsStore) {
    return { config: fallback, hasStoredSettings: false };
  }
  try {
    const stored = await pluginSettingsStore.getSettings(PRONUNCIATION_PLUGIN_ID);
    if (!stored) {
      return { config: fallback, hasStoredSettings: false };
    }
    return {
      config: parsePronunciationRuntimeConfig(stored.values, fallback),
      hasStoredSettings: true,
    };
  } catch {
    return { config: fallback, hasStoredSettings: false };
  }
}

export async function resolveEffectivePronunciationRuntime(params: {
  readonly pluginSettingsStore?: PluginSettingsStore | undefined;
  readonly injectedGenerator?: PronunciationAudioGenerator | undefined;
  readonly envDefaults?: PronunciationEnvDefaults | undefined;
  readonly fallbackConfig?: PronunciationPluginRuntimeConfig;
}): Promise<EffectivePronunciationRuntime> {
  const { config, hasStoredSettings } = await loadPersistedPronunciationConfig(
    params.pluginSettingsStore,
    params.fallbackConfig
  );

  if (config.primaryBackend === 'disabled') {
    return {
      kind: 'disabled',
      config,
      hasStoredSettings,
      activeGeneratorLabel: 'disabled',
    };
  }

  let storedGeminiKey: string | null = null;
  let storedCloudTtsKey: string | null = null;
  let storedOpenAiKey: string | null = null;
  if (params.pluginSettingsStore && typeof params.pluginSettingsStore.getSecretValue === 'function') {
    try {
      [storedGeminiKey, storedCloudTtsKey, storedOpenAiKey] = await Promise.all([
        params.pluginSettingsStore.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'gemini_api_key'),
        params.pluginSettingsStore.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'google_cloud_tts_api_key'),
        params.pluginSettingsStore.getSecretValue(PRONUNCIATION_PLUGIN_ID, 'openai_api_key'),
      ]);
    } catch {
      storedGeminiKey = null;
      storedCloudTtsKey = null;
      storedOpenAiKey = null;
    }
  }

  const effectiveGeminiKey = storedGeminiKey?.trim() || params.envDefaults?.geminiApiKey?.trim() || '';
  const effectiveGeminiModel =
    hasStoredSettings && config.defaultModel.trim().length > 0
      ? config.defaultModel.trim()
      : params.envDefaults?.geminiModel?.trim() || config.defaultModel;
  const effectiveCloudTtsKey =
    storedCloudTtsKey?.trim() || params.envDefaults?.googleCloudTtsApiKey?.trim() || '';
  const effectiveGcpProjectId = config.gcpProjectId.trim() || params.envDefaults?.gcpProjectId?.trim() || '';
  const effectiveChirpVoice =
    hasStoredSettings && config.chirpVoice.trim().length > 0
      ? config.chirpVoice.trim()
      : params.envDefaults?.chirpVoice?.trim() || config.chirpVoice;
  const fetchFn = params.envDefaults?.fetchImpl;

  function buildForBackend(
    backend: 'gemini' | 'chirp3-hd' | 'openai-speech'
  ): PronunciationAudioGenerator | null {
    if (backend === 'gemini') {
      if (effectiveGeminiKey) {
        return new GeminiPronunciationAudioGenerator({
          apiKey: effectiveGeminiKey,
          model: effectiveGeminiModel,
          defaultVoice: config.defaultVoice,
          fetchFn,
        });
      }
      if (params.injectedGenerator) {
        return params.injectedGenerator;
      }
      return null;
    }
    if (backend === 'chirp3-hd') {
      if (effectiveCloudTtsKey) {
        return new Chirp3HdPronunciationAudioGenerator({
          apiKey: effectiveCloudTtsKey,
          gcpProjectId: effectiveGcpProjectId || undefined,
          defaultVoice: effectiveChirpVoice,
          fetchFn,
        });
      }
      return null;
    }
    if (config.openAiBaseUrl.trim().length > 0) {
      return new OpenAiSpeechPronunciationGenerator({
        baseUrl: config.openAiBaseUrl,
        apiKey: storedOpenAiKey ?? undefined,
        model: config.defaultModel,
        defaultVoice: config.defaultVoice,
        fetchFn,
      });
    }
    return null;
  }

  const primaryGen = buildForBackend(config.primaryBackend);
  const fallbackGen =
    config.fallbackBackend !== 'none' && config.fallbackBackend !== config.primaryBackend
      ? buildForBackend(config.fallbackBackend)
      : null;

  if (primaryGen && fallbackGen) {
    return {
      kind: 'ready',
      config,
      hasStoredSettings,
      generator: new FallbackPronunciationGenerator(
        primaryGen,
        fallbackGen,
        resolveConfiguredDefaultVoice(config)
      ),
      activeGeneratorLabel: primaryGen.adapterKind ?? 'custom',
    };
  }
  const single = primaryGen ?? fallbackGen;
  if (single) {
    return {
      kind: 'ready',
      config,
      hasStoredSettings,
      generator: single,
      activeGeneratorLabel: single.adapterKind ?? 'custom',
    };
  }

  return {
    kind: 'unavailable',
    config,
    hasStoredSettings,
    activeGeneratorLabel: 'none',
  };
}
