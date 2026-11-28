import type React from 'react';
import { useEffect } from 'react';

/**
 * Keeps CSS scroll-driven horizontal edge fades inactive whenever content stops overflowing
 * (preventing Blink from retaining a finished ScrollTimeline hold time across view switches or
 * viewport resizes, #103), and falls back to IntersectionObserver edge classes where
 * `animation-timeline: scroll()` is unsupported.
 */
export function useHorizontalScrollFade(
  scrollerRef: React.RefObject<HTMLElement | null>,
  depsKey: string
): void {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !depsKey) {
      return;
    }

    const supportsScrollTimeline =
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('animation-timeline', 'scroll()');

    if (supportsScrollTimeline) {
      const syncOverflow = (): void => {
        scroller.dataset['overflowing'] = scroller.scrollWidth > scroller.clientWidth + 1 ? 'true' : 'false';
      };
      syncOverflow();
      if (typeof ResizeObserver !== 'function') {
        return;
      }
      const resizeObserver = new ResizeObserver(syncOverflow);
      resizeObserver.observe(scroller);
      return () => {
        resizeObserver.disconnect();
      };
    }

    if (typeof IntersectionObserver !== 'function') {
      return;
    }

    const first = scroller.firstElementChild;
    const last = scroller.lastElementChild;
    if (!first || !last) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const hasOverflow = entry.intersectionRatio < 1;
          if (entry.target === first) {
            scroller.classList.toggle('is-scrollable-start', hasOverflow);
          }
          if (entry.target === last) {
            scroller.classList.toggle('is-scrollable-end', hasOverflow);
          }
        }
      },
      { root: scroller, threshold: 1, rootMargin: '1px' }
    );

    observer.observe(first);
    if (last !== first) {
      observer.observe(last);
    }

    return () => {
      observer.disconnect();
      scroller.classList.remove('is-scrollable-start', 'is-scrollable-end');
    };
  }, [scrollerRef, depsKey]);
}
