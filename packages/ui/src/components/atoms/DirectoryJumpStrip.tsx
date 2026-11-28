import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../../lib/cx.js';
import styles from './DirectoryJumpStrip.module.css';

export interface DirectoryJumpStripItem {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
  readonly ariaLabel?: string;
  readonly title?: string;
  readonly onSelect?: () => void;
}

export interface DirectoryJumpStripProps {
  readonly items: readonly DirectoryJumpStripItem[];
  readonly ariaLabel: string;
  readonly compact?: boolean;
  readonly showCounts?: boolean;
}

const CLICK_SCROLL_LOCK_MS = 650;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export const DirectoryJumpStrip: React.FC<DirectoryJumpStripProps> = ({
  items,
  ariaLabel,
  compact = false,
  showCounts = true,
}) => {
  const navRef = useRef<HTMLElement | null>(null);
  const linkRefs = useRef<Map<string, HTMLAnchorElement>>(new Map());
  const clickLockUntilRef = useRef<number>(0);

  const itemIdsKey = useMemo(() => items.map((item) => item.id).join('|'), [items]);
  const navKey = `${compact ? 'az' : 'default'}:${itemIdsKey}`;
  const firstItemId = items[0]?.id ?? null;
  const lastItemId = items.at(-1)?.id ?? null;

  const [activeId, setActiveId] = useState<string | null>(firstItemId);

  useEffect(() => {
    setActiveId((current) => {
      if (current && items.some((item) => item.id === current)) {
        return current;
      }
      return firstItemId;
    });
  }, [items, firstItemId]);

  // Keep CSS scroll-driven fades inactive whenever content stops overflowing so Blink cannot
  // retain a finished ScrollTimeline hold time across view switches or viewport resizes, and
  // fall back to IntersectionObserver edge classes where scroll-driven animations lack support.
  useEffect(() => {
    const scroller = navRef.current;
    if (!scroller || !navKey || !firstItemId || !lastItemId) {
      return;
    }
    const supportsScrollTimeline =
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('animation-timeline', 'scroll()');
    if (supportsScrollTimeline) {
      const syncOverflow = (): void => {
        scroller.dataset.overflowing = scroller.scrollWidth > scroller.clientWidth + 1 ? 'true' : 'false';
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
  }, [navKey, firstItemId, lastItemId]);

  // Scroll-spy sync: observe rendered section containers and highlight the topmost visible section.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof IntersectionObserver !== 'function' || !itemIdsKey) {
      return;
    }
    const orderedIds = itemIdsKey.split('|').filter(Boolean);
    const targets: HTMLElement[] = [];
    for (const id of orderedIds) {
      const el = document.getElementById(id);
      if (el) {
        targets.push(el);
      }
    }
    if (targets.length === 0) {
      return;
    }

    const visibleIds = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const targetId = entry.target.id;
          if (!targetId) {
            continue;
          }
          if (entry.isIntersecting) {
            visibleIds.add(targetId);
          } else {
            visibleIds.delete(targetId);
          }
        }
        if (Date.now() < clickLockUntilRef.current) {
          return;
        }
        const firstVisible = orderedIds.find((id) => visibleIds.has(id));
        if (firstVisible) {
          setActiveId(firstVisible);
        }
      },
      {
        rootMargin: '-96px 0px -60% 0px',
        threshold: [0, 0.1, 0.5],
      }
    );

    for (const el of targets) {
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
    };
  }, [itemIdsKey]);

  // Keep the active jump link horizontally visible inside the sticky pocket.
  useEffect(() => {
    if (!activeId) {
      return;
    }
    const activeLink = linkRefs.current.get(activeId);
    if (!activeLink || typeof activeLink.scrollIntoView !== 'function') {
      return;
    }
    activeLink.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'nearest',
    });
  }, [activeId]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLAnchorElement>, index: number): void => {
    if (items.length <= 1) {
      return;
    }
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (index + 1) % items.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + items.length) % items.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    }
    if (nextIndex !== null) {
      event.preventDefault();
      const targetItem = items[nextIndex];
      if (targetItem) {
        linkRefs.current.get(targetItem.id)?.focus();
      }
    }
  };

  if (items.length === 0) {
    return null;
  }

  return (
    <div className={cx(styles, 'jump-strip-wrap')}>
      <nav
        key={navKey}
        ref={navRef}
        aria-label={ariaLabel}
        className={cx(styles, compact ? 'jump-strip is-az' : 'jump-strip')}
      >
        {items.map((item, index) => {
          const isActive = item.id === activeId;
          return (
            <a
              key={item.id}
              ref={(node) => {
                if (node) {
                  linkRefs.current.set(item.id, node);
                } else {
                  linkRefs.current.delete(item.id);
                }
              }}
              href={`#${item.id}`}
              className={cx(styles, isActive ? 'jump-link is-active' : 'jump-link')}
              aria-current={isActive ? 'location' : undefined}
              aria-label={item.ariaLabel}
              title={item.title}
              onKeyDown={(e) => {
                handleKeyDown(e, index);
              }}
              onClick={() => {
                clickLockUntilRef.current = Date.now() + CLICK_SCROLL_LOCK_MS;
                setActiveId(item.id);
                item.onSelect?.();
              }}
            >
              <span>{item.label}</span>
              {showCounts && item.count !== undefined && (
                <>
                  {' '}
                  <span className={cx(styles, 'jump-count')}>({item.count})</span>
                </>
              )}
            </a>
          );
        })}
      </nav>
    </div>
  );
};
