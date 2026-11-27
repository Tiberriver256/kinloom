import type { ArchiveBundle } from '@kinloom/core';
import type { TreeLineageMode, TreeViewSurface } from '../../lib/archivalTreeModel.js';
import { isRedactedLivingPlaceholder, resolveInitialTreePreferences } from '../../lib/archivalTreeModel.js';
import type { CanvasTransform } from '../../lib/treeGestures.js';

export const INITIAL_TREE_TRANSFORM: CanvasTransform = {
  pan: { x: 40, y: 40 },
  zoom: 0.85,
};

export function readInitialTreePreferences(searchParams: URLSearchParams): {
  readonly surface: TreeViewSurface;
  readonly mode: TreeLineageMode;
} {
  const width = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const fallback = resolveInitialTreePreferences(width);
  const surfaceParam = searchParams.get('surface');
  const modeParam = searchParams.get('mode');
  const surface: TreeViewSurface =
    surfaceParam === 'diagram' || surfaceParam === 'roll' ? surfaceParam : fallback.surface;
  const mode: TreeLineageMode = modeParam === 'spine' || modeParam === 'full' ? modeParam : fallback.mode;
  return { surface, mode };
}

export function computeTreeBranchCounts(
  bundle: ArchiveBundle | null,
  defaultBranchId: string
): Record<string, number> {
  const counts: Record<string, number> = { all: 0 };
  if (!bundle) {
    return counts;
  }
  for (const p of bundle.people) {
    if (isRedactedLivingPlaceholder(p)) {
      continue;
    }
    counts.all += 1;
    const b = p.branch || defaultBranchId;
    counts[b] = (counts[b] || 0) + 1;
  }
  return counts;
}
