export interface AnchorYearCandidate {
  readonly year: number;
  readonly label: string;
  readonly locatedCount: number;
  readonly aliveCount: number;
}

export interface DesktopAnchorPartition<T extends AnchorYearCandidate> {
  readonly primaryAnchors: readonly T[];
  readonly overflowAnchors: readonly T[];
}

export const DESKTOP_PRIMARY_ANCHOR_CAP = 7;

/**
 * Splits milestone anchor years into a compact primary strip (capped at 6–7
 * highest-coverage years, always keeping the active year visible) and a
 * chronological overflow list for progressive disclosure.
 */
export function partitionDesktopAnchors<T extends AnchorYearCandidate>(
  anchors: readonly T[],
  activeYear: number,
  maxPrimary = DESKTOP_PRIMARY_ANCHOR_CAP
): DesktopAnchorPartition<T> {
  const cap = Math.max(1, maxPrimary);
  if (anchors.length <= cap) {
    return {
      primaryAnchors: anchors,
      overflowAnchors: [],
    };
  }

  const rankedIndices = anchors
    .map((anchor, index) => ({ anchor, index }))
    .toSorted((a, b) => {
      if (a.anchor.year === activeYear) {
        return -1;
      }
      if (b.anchor.year === activeYear) {
        return 1;
      }
      if (b.anchor.locatedCount !== a.anchor.locatedCount) {
        return b.anchor.locatedCount - a.anchor.locatedCount;
      }
      if (b.anchor.aliveCount !== a.anchor.aliveCount) {
        return b.anchor.aliveCount - a.anchor.aliveCount;
      }
      return b.anchor.year - a.anchor.year;
    });

  const primaryIndexSet = new Set(rankedIndices.slice(0, cap).map((entry) => entry.index));
  const primaryAnchors: T[] = [];
  const overflowAnchors: T[] = [];

  for (const [i, anchor] of anchors.entries()) {
    if (primaryIndexSet.has(i)) {
      primaryAnchors.push(anchor);
    } else {
      overflowAnchors.push(anchor);
    }
  }

  return { primaryAnchors, overflowAnchors };
}
