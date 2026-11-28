import {
  type DocumentaryStory,
  type MapStory,
  type ScrollStory,
  type SpecialtyStory,
  SpecialtyStorySchema,
  type StoryWordTimestamp,
} from '../schemas/stories.js';

export type StoryDiagnosticSeverity = 'error' | 'warning';

export type StoryDiagnosticCode =
  | 'SCHEMA_INVALID'
  | 'UNKNOWN_PERSON_ID'
  | 'DUPLICATE_CITATION_ID'
  | 'UNKNOWN_SOURCE_ID'
  | 'DUPLICATE_BEAT_ID'
  | 'DUPLICATE_SCROLL_KEY'
  | 'EMPTY_CAPTION'
  | 'EMPTY_NARRATIVE'
  | 'UNKNOWN_CITATION_REF'
  | 'UNCITED_BEAT'
  | 'NON_MONOTONIC_TIMESTAMP'
  | 'NON_MONOTONIC_WORD_TIMESTAMP'
  | 'NON_MONOTONIC_DATE'
  | 'MISSING_ASSET';

export interface StoryValidationDiagnostic {
  readonly severity: StoryDiagnosticSeverity;
  readonly code: StoryDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ValidateStoryBundleOptions {
  /** Normalized relative asset paths present in the story workspace (e.g. `assets/portrait.jpg`). */
  readonly existingAssets?: ReadonlySet<string> | undefined;
  /** Known Kinloom archive person IDs for referential integrity checks. */
  readonly knownPersonIds?: ReadonlySet<string> | undefined;
  /** Known Kinloom archive source IDs for citation linkage checks. */
  readonly knownSourceIds?: ReadonlySet<string> | undefined;
}

export interface StoryValidationResult {
  readonly valid: boolean;
  readonly story?: SpecialtyStory;
  readonly diagnostics: readonly StoryValidationDiagnostic[];
}

function normalizeAssetPath(asset: string): string {
  return asset.replace(/^\.\//, '').replaceAll('\\', '/');
}

function isExternalAssetUrl(asset: string): boolean {
  return /^https?:\/\//i.test(asset) || asset.startsWith('data:');
}

function checkAssetExists(
  asset: string,
  pathStr: string,
  existingAssets: ReadonlySet<string> | undefined,
  diagnostics: StoryValidationDiagnostic[]
): void {
  if (!existingAssets || isExternalAssetUrl(asset)) {
    return;
  }
  const normalized = normalizeAssetPath(asset);
  if (!existingAssets.has(normalized)) {
    diagnostics.push({
      severity: 'error',
      code: 'MISSING_ASSET',
      path: pathStr,
      message: `Referenced asset '${asset}' was not found in the story workspace.`,
    });
  }
}

function validateWordTimestamps(
  words: readonly StoryWordTimestamp[] | undefined,
  basePath: string,
  diagnostics: StoryValidationDiagnostic[]
): void {
  if (!words || words.length === 0) {
    return;
  }
  let prevEnd = 0;
  for (const [i, word] of words.entries()) {
    if (word.endMs < word.startMs) {
      diagnostics.push({
        severity: 'error',
        code: 'NON_MONOTONIC_WORD_TIMESTAMP',
        path: `${basePath}[${i}]`,
        message: `Word '${word.word}' ends (${word.endMs}ms) before it starts (${word.startMs}ms).`,
      });
    }
    if (i > 0 && word.startMs < prevEnd) {
      diagnostics.push({
        severity: 'error',
        code: 'NON_MONOTONIC_WORD_TIMESTAMP',
        path: `${basePath}[${i}]`,
        message: `Word '${word.word}' starts (${word.startMs}ms) before previous word ended (${prevEnd}ms).`,
      });
    }
    prevEnd = word.endMs;
  }
}

function extractBeatProse(
  story: SpecialtyStory,
  index: number
): { readonly field: string; readonly text: string } {
  if (story.format === 'documentary') {
    return { field: 'narration', text: story.beats[index]?.narration ?? '' };
  }
  if (story.format === 'scroll') {
    return { field: 'body', text: story.beats[index]?.body ?? '' };
  }
  return { field: 'narrative', text: story.beats[index]?.narrative ?? '' };
}

function validateCommonBeats(
  story: SpecialtyStory,
  citationIds: ReadonlySet<string>,
  existingAssets: ReadonlySet<string> | undefined,
  diagnostics: StoryValidationDiagnostic[]
): void {
  const seenBeatIds = new Set<string>();
  for (const [i, beat] of story.beats.entries()) {
    const beatPath = `beats[${i}]`;

    if (seenBeatIds.has(beat.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'DUPLICATE_BEAT_ID',
        path: `${beatPath}.id`,
        message: `Duplicate beat ID '${beat.id}'.`,
      });
    } else {
      seenBeatIds.add(beat.id);
    }

    if (beat.caption.trim().length === 0) {
      diagnostics.push({
        severity: 'error',
        code: 'EMPTY_CAPTION',
        path: `${beatPath}.caption`,
        message: `Beat '${beat.id}' must include a non-empty caption.`,
      });
    }

    const prose = extractBeatProse(story, i);
    if (prose.text.trim().length === 0) {
      diagnostics.push({
        severity: 'error',
        code: 'EMPTY_NARRATIVE',
        path: `${beatPath}.${prose.field}`,
        message: `Beat '${beat.id}' must include non-empty ${prose.field} text.`,
      });
    }

    if (beat.citationIds.length === 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'UNCITED_BEAT',
        path: `${beatPath}.citationIds`,
        message: `Beat '${beat.id}' has no source citations attached.`,
      });
    }
    for (const [j, refId] of beat.citationIds.entries()) {
      if (!citationIds.has(refId)) {
        diagnostics.push({
          severity: 'error',
          code: 'UNKNOWN_CITATION_REF',
          path: `${beatPath}.citationIds[${j}]`,
          message: `Beat '${beat.id}' references unknown citation ID '${refId}'.`,
        });
      }
    }

    if (beat.media) {
      checkAssetExists(beat.media.asset, `${beatPath}.media.asset`, existingAssets, diagnostics);
    }
  }
}

function validateDocumentarySpecific(
  story: DocumentaryStory,
  existingAssets: ReadonlySet<string> | undefined,
  diagnostics: StoryValidationDiagnostic[]
): void {
  if (story.audio) {
    checkAssetExists(story.audio.asset, 'audio.asset', existingAssets, diagnostics);
    validateWordTimestamps(story.audio.wordTimestamps, 'audio.wordTimestamps', diagnostics);
  }
  let prevEndMs = 0;
  for (const [i, beat] of story.beats.entries()) {
    if (i > 0 && beat.startMs < prevEndMs) {
      diagnostics.push({
        severity: 'error',
        code: 'NON_MONOTONIC_TIMESTAMP',
        path: `beats[${i}].startMs`,
        message: `Beat '${beat.id}' starts at ${beat.startMs}ms, overlapping previous beat ending at ${prevEndMs}ms.`,
      });
    }
    validateWordTimestamps(beat.wordTimestamps, `beats[${i}].wordTimestamps`, diagnostics);
    prevEndMs = beat.startMs + beat.durationMs;
  }
}

function validateScrollSpecific(story: ScrollStory, diagnostics: StoryValidationDiagnostic[]): void {
  const seenKeys = new Set<string>();
  for (const [i, beat] of story.beats.entries()) {
    if (seenKeys.has(beat.key)) {
      diagnostics.push({
        severity: 'error',
        code: 'DUPLICATE_SCROLL_KEY',
        path: `beats[${i}].key`,
        message: `Duplicate scroll step key '${beat.key}'.`,
      });
    } else {
      seenKeys.add(beat.key);
    }
  }
}

function validateMapSpecific(story: MapStory, diagnostics: StoryValidationDiagnostic[]): void {
  let prevYear = Number.NEGATIVE_INFINITY;
  for (const [i, stop] of story.beats.entries()) {
    if (stop.year < prevYear) {
      diagnostics.push({
        severity: 'error',
        code: 'NON_MONOTONIC_DATE',
        path: `beats[${i}].year`,
        message: `Map stop '${stop.id}' year (${stop.year}) precedes previous stop year (${prevYear}).`,
      });
    }
    prevYear = stop.year;
  }
}

/**
 * Deterministically validates a Kinloom Specialty Story bundle against schema,
 * person/source linkage, beat completeness, citation references, monotonic timing/dates,
 * and referenced asset presence.
 */
export function validateStoryBundle(
  rawStory: unknown,
  options: ValidateStoryBundleOptions = {}
): StoryValidationResult {
  const parsed = SpecialtyStorySchema.safeParse(rawStory);
  if (!parsed.success) {
    const diagnostics: StoryValidationDiagnostic[] = parsed.error.issues.map((issue) => ({
      severity: 'error',
      code: 'SCHEMA_INVALID',
      path: issue.path.length > 0 ? issue.path.join('.') : 'root',
      message: issue.message,
    }));
    return { valid: false, diagnostics };
  }

  const story = parsed.data;
  const diagnostics: StoryValidationDiagnostic[] = [];

  if (options.knownPersonIds && !options.knownPersonIds.has(story.personId)) {
    diagnostics.push({
      severity: 'error',
      code: 'UNKNOWN_PERSON_ID',
      path: 'personId',
      message: `Person ID '${story.personId}' was not found in the archive.`,
    });
  }

  const citationIds = new Set<string>();
  for (const [i, citation] of story.citations.entries()) {
    if (citationIds.has(citation.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'DUPLICATE_CITATION_ID',
        path: `citations[${i}].id`,
        message: `Duplicate citation ID '${citation.id}'.`,
      });
    } else {
      citationIds.add(citation.id);
    }
    if (citation.sourceId && options.knownSourceIds && !options.knownSourceIds.has(citation.sourceId)) {
      diagnostics.push({
        severity: 'error',
        code: 'UNKNOWN_SOURCE_ID',
        path: `citations[${i}].sourceId`,
        message: `Citation '${citation.id}' references unknown archive source '${citation.sourceId}'.`,
      });
    }
  }

  validateCommonBeats(story, citationIds, options.existingAssets, diagnostics);

  if (story.format === 'documentary') {
    validateDocumentarySpecific(story, options.existingAssets, diagnostics);
  } else if (story.format === 'scroll') {
    validateScrollSpecific(story, diagnostics);
  } else {
    validateMapSpecific(story, diagnostics);
  }

  const hasErrors = diagnostics.some((d) => d.severity === 'error');
  return {
    valid: !hasErrors,
    story,
    diagnostics,
  };
}
