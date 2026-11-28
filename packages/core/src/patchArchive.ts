import { clonePronunciationLexiconFast } from './compileArchive.js';
import { markTrustedArchiveBundle } from './fastCompare.js';
import { applyPatchMutation } from './patch/entityMutators.js';
import {
  attachBundleIndexMemo,
  type BundlePatchMutation,
  createPatchWorkingState,
  type PatchCompiledBundleOptions,
} from './patch/patchState.js';
import {
  reconcileAffectedMedia,
  reconcileNewlyLivingEntities,
  reconcilePersonAndEventDerivedStats,
  reconcilePlaceAncestorsAndSpans,
  reconcileResidenceSpans,
} from './patch/reconcilers.js';
import type { KinloomSiteConfig } from './schemas/config.js';
import type { ArchiveBundle, BuildMode } from './schemas/entities.js';

export type { BundlePatchMutation, PatchCompiledBundleOptions } from './patch/patchState.js';

/**
 * Incrementally patch a compiled ArchiveBundle in O(affected_people) instead of recompiling the entire archive.
 * Pure function: never mutates `previousBundle` or its nested records.
 */
export function patchCompiledBundle(
  previousBundle: ArchiveBundle,
  mutations: readonly BundlePatchMutation[],
  siteConfig: KinloomSiteConfig,
  mode: BuildMode,
  options?: PatchCompiledBundleOptions
): ArchiveBundle {
  let maxRevisionId = previousBundle.meta.max_revision_id;
  for (const m of mutations) {
    if (m.revision_id !== undefined) {
      maxRevisionId = maxRevisionId === undefined ? m.revision_id : Math.max(maxRevisionId, m.revision_id);
    }
  }

  const pronunciationLexicon =
    siteConfig.pronunciations && Object.keys(siteConfig.pronunciations).length > 0
      ? siteConfig.pronunciations
      : previousBundle.pronunciations && Object.keys(previousBundle.pronunciations).length > 0
        ? previousBundle.pronunciations
        : undefined;

  if (mutations.length === 0) {
    const unchanged: ArchiveBundle = {
      ...previousBundle,
      meta: {
        ...previousBundle.meta,
        build_mode: mode,
        generated_at: options?.generatedAt ?? previousBundle.meta.generated_at,
        ...(maxRevisionId !== undefined ? { max_revision_id: maxRevisionId } : {}),
      },
      ...(pronunciationLexicon
        ? { pronunciations: clonePronunciationLexiconFast(pronunciationLexicon) }
        : {}),
    };
    markTrustedArchiveBundle(unchanged);
    return unchanged;
  }

  const state = createPatchWorkingState(previousBundle, siteConfig, mode, options);

  // Pre-scan whether any media mutation exists in the batch so person/event updates know if media changed!
  for (const m of mutations) {
    if (m.entity_type === 'media') {
      state.mediaMutated = true;
      break;
    }
  }

  for (const m of mutations) {
    applyPatchMutation(state, m);
  }

  reconcileNewlyLivingEntities(state);
  reconcileAffectedMedia(state);
  reconcilePlaceAncestorsAndSpans(state);
  reconcilePersonAndEventDerivedStats(state);
  reconcileResidenceSpans(state);

  const livingRedactedCount = state.getLivingRedactedCount();
  const sortedUncitedKeys = state.hasUncitedChanges()
    ? [...state.uncitedKeys].toSorted()
    : previousBundle.meta.uncited_entity_keys;

  const patched: ArchiveBundle = {
    meta: {
      ...(previousBundle.meta.version ? { version: previousBundle.meta.version } : {}),
      build_mode: mode,
      generated_at: options?.generatedAt ?? previousBundle.meta.generated_at,
      ...(maxRevisionId !== undefined ? { max_revision_id: maxRevisionId } : {}),
      ...(sortedUncitedKeys && sortedUncitedKeys.length > 0
        ? { uncited_entity_keys: sortedUncitedKeys }
        : {}),
      counts: {
        people: state.people.length,
        living_redacted: livingRedactedCount,
        events: state.events.length,
        residence_spans: state.residenceSpans.length,
        places: state.places.length,
        sources: state.sources.length,
        media: state.media.length,
        ...(state.narratives !== undefined ? { narratives: state.narratives.length } : {}),
      },
    },
    media: state.media,
    people: state.people,
    events: state.events,
    residence_spans: state.residenceSpans,
    places: state.places,
    place_ancestors: state.placeAncestors,
    kinship: state.kinship,
    sources: state.sources,
    ...(state.narratives !== undefined ? { narratives: state.narratives } : {}),
    ...(pronunciationLexicon ? { pronunciations: clonePronunciationLexiconFast(pronunciationLexicon) } : {}),
  };

  attachBundleIndexMemo(patched, state.buildDerivedMemo());
  markTrustedArchiveBundle(patched);
  return patched;
}
