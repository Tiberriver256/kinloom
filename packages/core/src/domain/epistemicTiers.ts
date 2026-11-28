import { UNVERIFIED_TREE_SOURCE_ID } from '../gedcom/citations.js';
import type { ConfidenceTier, EventSourceRef, SourceRecord } from '../schemas/entities.js';
import { classifySourceTier } from './citations.js';

export type EpistemicTier = 'cited' | 'inferred' | 'open_question';

export interface EpistemicTierDescriptor {
  readonly tier: EpistemicTier;
  readonly label: string;
  readonly shortLabel: string;
  readonly marginRuleStyle: 'solid' | 'dashed' | 'dotted';
  readonly glyphKind: 'check' | 'nib' | 'fork';
  readonly readerDescription: string;
}

export const EPISTEMIC_TIER_ORDER: readonly EpistemicTier[] = ['cited', 'inferred', 'open_question'];

export const EPISTEMIC_TIER_CATALOG: Readonly<Record<EpistemicTier, EpistemicTierDescriptor>> = {
  cited: {
    tier: 'cited',
    label: 'Cited',
    shortLabel: 'Cited',
    marginRuleStyle: 'solid',
    glyphKind: 'check',
    readerDescription:
      'Supported by a contemporary primary or published historical record (such as a census, vital register, or county history).',
  },
  inferred: {
    tier: 'inferred',
    label: 'Family memory / Inferred',
    shortLabel: 'Family memory',
    marginRuleStyle: 'dashed',
    glyphKind: 'nib',
    readerDescription:
      'Recorded from family memoir or oral tradition, or inferred from neighboring dated records without an exact-year primary citation.',
  },
  open_question: {
    tier: 'open_question',
    label: 'Discrepancy / Open question',
    shortLabel: 'Open question',
    marginRuleStyle: 'dotted',
    glyphKind: 'fork',
    readerDescription:
      'Sources disagree on a date, place, or fact, or placement rests on a broad estimate (> 6 years). Conflicting claims are preserved side by side.',
  },
};

export type EpistemicTierInput =
  | {
      readonly kind: 'time_entry';
      readonly tier: ConfidenceTier | 'Unlocated';
      readonly hasConflict?: boolean;
      readonly conflictCount?: number;
    }
  | {
      readonly kind: 'event';
      readonly sources?: readonly Pick<EventSourceRef, 'source_id'>[];
      readonly hasPrimarySource?: boolean;
      readonly alternateDatesCount?: number;
      readonly alternatePlacesCount?: number;
      readonly factConflictsCount?: number;
      readonly sourcesById?: ReadonlyMap<string, SourceRecord>;
    }
  | {
      readonly kind: 'record';
      readonly hasPrimarySource?: boolean;
      readonly sourceIds?: readonly string[];
      readonly sourcesById?: ReadonlyMap<string, SourceRecord>;
      readonly hasConflict?: boolean;
      readonly conflictCount?: number;
    };

export interface ResolvedEpistemicTier {
  readonly tier: EpistemicTier;
  readonly descriptor: EpistemicTierDescriptor;
  readonly compactLabel: string;
  readonly conflictCount: number;
}

function hasPrimaryOrPublishedSource(
  sourceIds: readonly string[],
  sourcesById?: ReadonlyMap<string, SourceRecord>
): boolean {
  for (const id of sourceIds) {
    if (!id || id === UNVERIFIED_TREE_SOURCE_ID) {
      continue;
    }
    if (!sourcesById) {
      return true;
    }
    const tier = classifySourceTier(sourcesById.get(id));
    if (tier === 'primary' || tier === 'published') {
      return true;
    }
  }
  return false;
}

function makeResolved(tier: EpistemicTier, compactLabel: string, conflictCount = 0): ResolvedEpistemicTier {
  return {
    tier,
    descriptor: EPISTEMIC_TIER_CATALOG[tier],
    compactLabel,
    conflictCount,
  };
}

/**
 * Map surface-specific confidence or citation evidence onto the unified 3-tier reader vocabulary.
 */
export function resolveEpistemicTier(input: EpistemicTierInput): ResolvedEpistemicTier {
  switch (input.kind) {
    case 'time_entry': {
      const conflicts = Math.max(0, input.conflictCount ?? 0);
      if (input.hasConflict || conflicts > 0) {
        return makeResolved(
          'open_question',
          conflicts > 0 ? `Discrepancy (${conflicts})` : 'Discrepancy',
          conflicts
        );
      }
      if (input.tier === 'Confirmed') {
        return makeResolved('cited', 'Cited');
      }
      if (input.tier === 'Inferred') {
        return makeResolved('inferred', 'Inferred');
      }
      return makeResolved('open_question', 'Open question · approx.');
    }
    case 'event': {
      const conflicts =
        Math.max(0, input.alternateDatesCount ?? 0) +
        Math.max(0, input.alternatePlacesCount ?? 0) +
        Math.max(0, input.factConflictsCount ?? 0);
      if (conflicts > 0) {
        return makeResolved('open_question', `Discrepancy (${conflicts})`, conflicts);
      }
      const sourceIds = (input.sources ?? []).map((s) => s.source_id);
      if (sourceIds.length > 0 && hasPrimaryOrPublishedSource(sourceIds, input.sourcesById)) {
        return makeResolved('cited', 'Cited');
      }
      if (sourceIds.length === 0 && input.hasPrimarySource === true) {
        return makeResolved('cited', 'Cited');
      }
      return makeResolved('inferred', 'Family memory');
    }
    case 'record': {
      const conflicts = Math.max(0, input.conflictCount ?? 0);
      if (input.hasConflict || conflicts > 0) {
        return makeResolved(
          'open_question',
          conflicts > 0 ? `Discrepancy (${conflicts})` : 'Discrepancy',
          conflicts
        );
      }
      if (input.sourceIds && input.sourceIds.length > 0) {
        if (hasPrimaryOrPublishedSource(input.sourceIds, input.sourcesById)) {
          return makeResolved('cited', 'Cited');
        }
        return makeResolved('inferred', 'Family memory');
      }
      if (input.hasPrimarySource === true) {
        return makeResolved('cited', 'Cited');
      }
      return makeResolved('inferred', 'Family memory');
    }
    default: {
      const _exhaustive: never = input;
      return _exhaustive;
    }
  }
}
