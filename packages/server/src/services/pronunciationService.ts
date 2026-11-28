import {
  type Clock,
  type EntityReadStore,
  type KinloomSiteConfig,
  type MediaStore,
  mergePronunciationLexicons,
  type PluginSettingsStore,
  type Pronunciation,
  type PronunciationAudioGenerator,
  type PronunciationEnvDefaults,
  type PronunciationLexiconStore,
  parseEntityPayload,
  resolveEffectiveLiving,
} from '@kinloom/core';
import { KinloomHttpError } from '../errors.js';
import { generateAndStorePronunciationAudio, type StoredPronunciationAudio } from './pronunciationHelper.js';
import {
  resolveConfiguredDefaultVoice,
  resolveEffectivePronunciationRuntime,
} from './pronunciationRuntime.js';

export interface PronunciationServiceDeps {
  readonly repository: Pick<EntityReadStore, 'getEntity'>;
  readonly mediaStore: MediaStore;
  readonly clock: Clock;
  readonly siteConfig: KinloomSiteConfig;
  readonly pronunciationGenerator?: PronunciationAudioGenerator | undefined;
  readonly pronunciationEnv?: PronunciationEnvDefaults | undefined;
  readonly pronunciationLexiconStore?: PronunciationLexiconStore | undefined;
  readonly pluginSettingsStore?: PluginSettingsStore | undefined;
}

export interface GenerateEntityPronunciationInput {
  readonly entityType: 'person' | 'place';
  readonly entityId: string;
  readonly text?: string | undefined;
  readonly phonetic?: string | undefined;
  readonly ipa?: string | undefined;
  readonly language?: string | undefined;
  readonly voice?: string | undefined;
}

export interface UpsertLexiconTermInput {
  readonly term: string;
  readonly entry: Pronunciation;
  readonly updatedBy: string;
}

export class PronunciationService {
  private readonly repository: Pick<EntityReadStore, 'getEntity'>;
  private readonly mediaStore: MediaStore;
  private readonly clock: Clock;
  private readonly siteConfig: KinloomSiteConfig;
  private readonly pronunciationGenerator?: PronunciationAudioGenerator | undefined;
  private readonly pronunciationEnv?: PronunciationEnvDefaults | undefined;
  private readonly pronunciationLexiconStore?: PronunciationLexiconStore | undefined;
  private readonly pluginSettingsStore?: PluginSettingsStore | undefined;

  constructor(deps: PronunciationServiceDeps) {
    this.repository = deps.repository;
    this.mediaStore = deps.mediaStore;
    this.clock = deps.clock;
    this.siteConfig = deps.siteConfig;
    this.pronunciationGenerator = deps.pronunciationGenerator;
    this.pronunciationEnv = deps.pronunciationEnv;
    this.pronunciationLexiconStore = deps.pronunciationLexiconStore;
    this.pluginSettingsStore = deps.pluginSettingsStore;
  }

  async loadMergedPronunciations(): Promise<Record<string, Pronunciation>> {
    const staticLexicon = this.siteConfig.pronunciations ?? {};
    const dynamicLexicon = this.pronunciationLexiconStore ? await this.pronunciationLexiconStore.list() : {};
    return mergePronunciationLexicons(staticLexicon, dynamicLexicon);
  }

  async generateEntityPronunciation(
    input: GenerateEntityPronunciationInput
  ): Promise<StoredPronunciationAudio> {
    const entityRow = await this.repository.getEntity(input.entityType, input.entityId);
    if (entityRow === null || entityRow.deleted_at !== null || 'edge' in entityRow) {
      throw new KinloomHttpError(
        404,
        'NOT_FOUND',
        `Entity ${input.entityType}/${input.entityId} was not found.`
      );
    }

    let defaultText = '';
    if (input.entityType === 'person') {
      const parsedPerson = parseEntityPayload('person', entityRow.data);
      if (resolveEffectiveLiving(parsedPerson, this.siteConfig.privacy, this.clock.currentYear())) {
        throw new KinloomHttpError(
          422,
          'LIVING_PRIVACY_VIOLATION',
          `Cannot generate pronunciation audio for living person '${input.entityId}'.`
        );
      }
      defaultText = parsedPerson.full_name.trim();
    } else {
      const parsedPlace = parseEntityPayload('place', entityRow.data);
      defaultText = (parsedPlace.name || parsedPlace.full_name).trim();
    }

    const runtime = await resolveEffectivePronunciationRuntime({
      pluginSettingsStore: this.pluginSettingsStore,
      injectedGenerator: this.pronunciationGenerator,
      envDefaults: this.pronunciationEnv,
    });

    if (runtime.kind === 'disabled') {
      throw new KinloomHttpError(
        503,
        'PRONUNCIATION_DISABLED',
        'Pronunciation audio generation is disabled in Admin Plugin Settings.'
      );
    }

    if (runtime.kind !== 'ready') {
      throw new KinloomHttpError(
        503,
        'PRONUNCIATION_UNAVAILABLE',
        'Pronunciation audio generation is not configured on this server.'
      );
    }

    const text = input.text?.trim() || defaultText;
    if (!text) {
      throw new KinloomHttpError(
        400,
        'VALIDATION_ERROR',
        'Pronunciation text is required when entity name is empty.'
      );
    }

    const effectiveVoice =
      input.voice?.trim() ||
      (runtime.hasStoredSettings ? resolveConfiguredDefaultVoice(runtime.config) : undefined);

    return generateAndStorePronunciationAudio({
      generator: runtime.generator,
      mediaStore: this.mediaStore,
      entityType: input.entityType,
      text,
      phonetic: input.phonetic,
      ipa: input.ipa,
      language: input.language,
      voice: effectiveVoice,
      ...(runtime.hasStoredSettings ? { phonemeMode: runtime.config.phonemeMode } : {}),
    });
  }

  async upsertLexiconTerm(input: UpsertLexiconTermInput): Promise<{
    term: string;
    pronunciation: Pronunciation | null;
    pronunciations: Record<string, Pronunciation>;
  }> {
    const term = input.term.trim();
    if (!term) {
      throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Pronunciation term is required.');
    }

    if (!this.pronunciationLexiconStore) {
      throw new KinloomHttpError(
        503,
        'PRONUNCIATION_STORE_UNAVAILABLE',
        'Pronunciation lexicon persistence is not configured on this server.'
      );
    }

    const { entry } = input;
    const isEmpty =
      !entry.phonetic &&
      !entry.ipa &&
      !entry.language &&
      !entry.note &&
      !entry.audio_url &&
      !entry.source_url &&
      !entry.source_label &&
      !entry.region &&
      (!entry.variants || entry.variants.length === 0);

    if (isEmpty) {
      await this.pronunciationLexiconStore.delete(term);
      const pronunciations = await this.loadMergedPronunciations();
      return { term, pronunciation: null, pronunciations };
    }

    const nextEntry: Pronunciation = { ...entry };
    const runtime = await resolveEffectivePronunciationRuntime({
      pluginSettingsStore: this.pluginSettingsStore,
      injectedGenerator: this.pronunciationGenerator,
      envDefaults: this.pronunciationEnv,
    });
    if (runtime.kind === 'ready' && runtime.config.autoGenerateOnSave) {
      try {
        const stored = await generateAndStorePronunciationAudio({
          generator: runtime.generator,
          mediaStore: this.mediaStore,
          entityType: 'person',
          text: term,
          phonetic: nextEntry.phonetic,
          ipa: nextEntry.ipa,
          language: nextEntry.language,
          ...(runtime.hasStoredSettings
            ? {
                voice: resolveConfiguredDefaultVoice(runtime.config),
                phonemeMode: runtime.config.phonemeMode,
              }
            : {}),
        });
        nextEntry.audio_url = stored.audio_url;
      } catch {
        // Degrade gracefully when TTS is unavailable so lexicon text still saves
      }
    }

    const pronunciation = await this.pronunciationLexiconStore.upsert(
      term,
      nextEntry,
      input.updatedBy,
      this.clock.nowIso()
    );
    const pronunciations = await this.loadMergedPronunciations();
    return { term, pronunciation, pronunciations };
  }
}
