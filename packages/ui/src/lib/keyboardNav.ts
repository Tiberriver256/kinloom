import type React from 'react';

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function scrollBehaviorForMotion(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

/**
 * Shared WAI-ARIA tablist keyboard navigation (ArrowRight, ArrowLeft, Home, End).
 * Selects the target tab and moves DOM focus to the corresponding `[role="tab"]` button.
 */
export function handleTablistKeyDown<T extends string>(
  event: React.KeyboardEvent<HTMLElement>,
  items: readonly T[],
  active: T,
  onSelect: (next: T) => void,
): void {
  if (items.length === 0) {
    return;
  }
  const currentIdx = Math.max(0, items.indexOf(active));
  let nextIdx: number | null = null;

  if (event.key === 'ArrowRight') {
    nextIdx = (currentIdx + 1) % items.length;
  } else if (event.key === 'ArrowLeft') {
    nextIdx = (currentIdx - 1 + items.length) % items.length;
  } else if (event.key === 'Home') {
    nextIdx = 0;
  } else if (event.key === 'End') {
    nextIdx = items.length - 1;
  }

  if (nextIdx === null) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const nextItem = items[nextIdx];
  onSelect(nextItem);

  const tabs = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
  tabs[nextIdx]?.focus();
}
