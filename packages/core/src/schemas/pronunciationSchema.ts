import { z } from 'zod';

export const PronunciationVariantSchema = z.object({
  label: z.string().min(1),
  phonetic: z.string().min(1).optional(),
  ipa: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  audio_url: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  source_url: z.string().min(1).optional(),
  source_label: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
});

export type PronunciationVariant = z.infer<typeof PronunciationVariantSchema>;

export const PronunciationSchema = z.object({
  phonetic: z.string().min(1).optional(),
  ipa: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  audio_url: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  source_url: z.string().min(1).optional(),
  source_label: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  match_full_name_contains: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  variants: z.array(PronunciationVariantSchema).optional(),
});

export type Pronunciation = z.infer<typeof PronunciationSchema>;

export type PronunciationCoverage = 'full' | 'partial' | 'surname';

export type PronunciationResolutionSource =
  | 'person'
  | 'lexicon_id'
  | 'lexicon_full_name'
  | 'composed'
  | 'lexicon_surname';

export interface ResolvedPersonPronunciation extends Pronunciation {
  readonly coverage: PronunciationCoverage;
  readonly matchedPart?: string;
  readonly resolvedFrom?: PronunciationResolutionSource;
  readonly missingParts?: readonly string[];
  readonly token_audio_urls?: readonly string[];
}

export type PersonPronunciationTokenRole = 'given' | 'middle' | 'surname' | 'suffix';

export interface InspectedPersonPronunciationToken {
  readonly kind: 'token' | 'initial' | 'decoration';
  readonly role: PersonPronunciationTokenRole;
  readonly text: string;
  readonly lexiconKey: string | null;
  readonly entry: Pronunciation | null;
  readonly joinWithHyphen?: boolean;
}

export interface PersonPronunciationInspection {
  readonly tokens: readonly InspectedPersonPronunciationToken[];
  readonly composed: ResolvedPersonPronunciation | null;
  readonly missingParts: readonly string[];
  readonly allTokensResolved: boolean;
  readonly hasAnySharedToken: boolean;
}
