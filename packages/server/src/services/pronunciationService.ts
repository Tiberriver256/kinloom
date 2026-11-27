import {
  type Clock,
  type EntityReadStore,
  type KinloomSiteConfig,
  type MediaStore,
  mergePronunciationLexicons,
  type Pronunciation,
  type PronunciationAudioGenerator,
  type PronunciationLexiconStore,
  parseEntityPayload,
  resolveEffectiveLiving,
} from '@kinloom/core';
import { KinloomHttpError } from '../errors.js';
import { generateAndStorePronunciationAudio, type StoredPronunciationAudio } from './pronunciationHelper.js';

export interface PronunciationServiceDeps {
  readonly repository: Pick<EntityReadStore, 'getEntity'>;
  readonly mediaStore: MediaStore;
  readonly clock: Clock;
  readonly siteConfig: KinloomSiteConfig;
  readonly pronunciationGenerator?: PronunciationAudioGenerator;
  readonly pronunciationLexiconStore?: PronunciationLexiconStore;
}

export interface GenerateEntityPronunciationInput {
  readonly entityType: 'person' | 'place';
  readonly entityId: string;
  readonly text?: string;
  readonly phonetic?: string;
  readonly ipa?: string;
  readonly language?: string;
  readonly voice?: string;
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
  private readonly pronunciationGenerator?: PronunciationAudioGenerator;
  private readonly pronunciationLexiconStore?: PronunciationLexiconStore;

  constructor(deps: PronunciationServiceDeps) {
    this.repository = deps.repository;
    this.mediaStore = deps.mediaStore;
    this.clock = deps.clock;
    this.siteConfig = deps.siteConfig;
    this.pronunciationGenerator = deps.pronunciationGenerator;
    this.pronunciationLexiconStore = deps.pronunciationLexiconStore;
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

    if (!this.pronunciationGenerator) {
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

    return generateAndStorePronunciationAudio({
      generator: this.pronunciationGenerator,
      mediaStore: this.mediaStore,
      entityType: input.entityType,
      text,
      phonetic: input.phonetic,
      ipa: input.ipa,
      language: input.language,
      voice: input.voice,
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
    if (this.pronunciationGenerator) {
      try {
        const stored = await generateAndStorePronunciationAudio({
          generator: this.pronunciationGenerator,
          mediaStore: this.mediaStore,
          entityType: 'person',
          text: term,
          phonetic: nextEntry.phonetic,
          ipa: nextEntry.ipa,
          language: nextEntry.language,
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
