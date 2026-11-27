import { applyPatchMutation } from './patch/entityMutators.js';
import {
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
    return {
      ...previousBundle,
      meta: {
        ...previousBundle.meta,
        build_mode: mode,
        generated_at: options?.generatedAt ?? previousBundle.meta.generated_at,
        ...(maxRevisionId !== undefined ? { max_revision_id: maxRevisionId } : {}),
      },
      ...(pronunciationLexicon ? { pronunciations: structuredClone(pronunciationLexicon) } : {}),
    };
  }

  const state = createPatchWorkingState(previousBundle, siteConfig, mode, options);

  for (const mutation of mutations) {
    applyPatchMutation(state, mutation);
  }

  reconcileNewlyLivingEntities(state);
  reconcileAffectedMedia(state);
  reconcilePlaceAncestorsAndSpans(state);
  reconcilePersonAndEventDerivedStats(state);
  reconcileResidenceSpans(state);

  const livingRedactedCount = state.getLivingRedactedCount();
  const sortedUncitedKeys = [...state.uncitedKeys].toSorted();

  return {
    meta: {
      ...(previousBundle.meta.version ? { version: previousBundle.meta.version } : {}),
      build_mode: mode,
      generated_at: options?.generatedAt ?? previousBundle.meta.generated_at,
      ...(maxRevisionId !== undefined ? { max_revision_id: maxRevisionId } : {}),
      ...(sortedUncitedKeys.length > 0 ? { uncited_entity_keys: sortedUncitedKeys } : {}),
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
    ...(pronunciationLexicon ? { pronunciations: structuredClone(pronunciationLexicon) } : {}),
  };
}
