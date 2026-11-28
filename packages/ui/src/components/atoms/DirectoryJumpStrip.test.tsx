/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectoryJumpStrip, type DirectoryJumpStripItem } from './DirectoryJumpStrip.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

function mountEl(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

describe('DirectoryJumpStrip shared primitive (#85)', () => {
  it('tracks scroll-spy via IntersectionObserver, marks active aria-current="location", centers active link, and supports click lock + keyboard traversal', () => {
    const callbacks: Array<{
      cb: IntersectionObserverCallback;
      options?: IntersectionObserverInit | undefined;
      targets: Element[];
    }> = [];

    class MockIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = '';
      readonly scrollMargin = '';
      readonly thresholds = [0];
      private readonly record: {
        cb: IntersectionObserverCallback;
        options?: IntersectionObserverInit | undefined;
        targets: Element[];
      };

      constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.record = { cb, options, targets: [] };
        callbacks.push(this.record);
      }

      observe(target: Element): void {
        this.record.targets.push(target);
      }

      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }

    const originalIO = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = MockIntersectionObserver;
    const originalCssSupports = globalThis.CSS?.supports;
    if (globalThis.CSS) {
      globalThis.CSS.supports = () => false;
    }

    const scrollSpy = vi.fn();
    const originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrollSpy;

    const onSelectLiving = vi.fn();
    const items: DirectoryJumpStripItem[] = [
      { id: 'sec-1700s', label: '1700s', count: 12 },
      { id: 'sec-1800s', label: '1800–49', count: 18 },
      { id: 'sec-living', label: 'Living', count: 4, onSelect: onSelectLiving },
    ];

    try {
      const container = mountEl(
        <div>
          <DirectoryJumpStrip items={items} ariaLabel="Jump to era" showCounts={true} />
          <section id="sec-1700s" />
          <section id="sec-1800s" />
          <section id="sec-living" />
        </div>
      );

      const nav = container.querySelector('nav[aria-label="Jump to era"]');
      expect(nav).not.toBeNull();
      const links = [...container.querySelectorAll<HTMLAnchorElement>('nav a')];
      expect(links).toHaveLength(3);
      expect(links[0]?.getAttribute('aria-current')).toBe('location');
      expect(links[0]?.textContent).toBe('1700s (12)');

      // Trigger overflow edge-fade fallback observer (first observer)
      const fadeObserver = callbacks.find((c) => c.options?.root === nav);
      expect(fadeObserver).toBeDefined();
      act(() => {
        fadeObserver?.cb(
          [
            { target: links[0] as Element, intersectionRatio: 0.5 } as IntersectionObserverEntry,
            { target: links[2] as Element, intersectionRatio: 0.5 } as IntersectionObserverEntry,
          ],
          {} as IntersectionObserver
        );
      });
      expect(nav?.classList.contains('is-scrollable-start')).toBe(true);
      expect(nav?.classList.contains('is-scrollable-end')).toBe(true);

      // Trigger scroll-spy observer for sec-1800s
      const spyObserver = callbacks.find((c) => c.options?.root === undefined);
      expect(spyObserver).toBeDefined();
      const sec1800 = container.querySelector('#sec-1800s') as Element;
      act(() => {
        spyObserver?.cb(
          [{ target: sec1800, isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        );
      });
      expect(links[1]?.getAttribute('aria-current')).toBe('location');
      expect(links[0]?.getAttribute('aria-current')).toBeNull();
      expect(scrollSpy).toHaveBeenCalled();

      // Keyboard navigation: ArrowRight, ArrowLeft, End, Home
      links[0]?.focus();
      act(() => {
        links[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      });
      expect(document.activeElement).toBe(links[1]);
      act(() => {
        links[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      });
      expect(document.activeElement).toBe(links[2]);
      act(() => {
        links[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      });
      expect(document.activeElement).toBe(links[0]);
      act(() => {
        links[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      });
      expect(document.activeElement).toBe(links[2]);

      // Click activates immediately and invokes onSelect
      act(() => {
        links[2]?.click();
      });
      expect(links[2]?.getAttribute('aria-current')).toBe('location');
      expect(onSelectLiving).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.IntersectionObserver = originalIO;
      if (globalThis.CSS && originalCssSupports) {
        globalThis.CSS.supports = originalCssSupports;
      }
      Element.prototype.scrollIntoView = originalScrollIntoView;
    }
  });

  it('supports compact A–Z mode without counts, hides when empty, and preserves edge-fade CSS rules', () => {
    const empty = mountEl(<DirectoryJumpStrip items={[]} ariaLabel="Empty strip" />);
    expect(empty.innerHTML).toBe('');

    const container = mountEl(
      <DirectoryJumpStrip
        items={[
          { id: 'sec-a', label: 'A', count: 3, ariaLabel: 'Jump to letter A (3)' },
          { id: 'sec-b', label: 'B', count: 2, ariaLabel: 'Jump to letter B (2)' },
        ]}
        ariaLabel="Jump to surname letter"
        compact={true}
        showCounts={false}
      />
    );
    const nav = container.querySelector('nav');
    expect(nav?.classList.contains('is-az')).toBe(true);
    expect(container.querySelectorAll('a')[0]?.textContent).toBe('A');

    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(resolve(here, 'DirectoryJumpStrip.module.css'), 'utf8');
    expect(css).toContain('scrollbar-width: none;');
    expect(css).toContain('.jump-strip::-webkit-scrollbar');
    expect(css).toContain('@property --jump-fade-end');
    expect(css).toContain('animation-duration: auto, auto;');
    expect(css).toContain('animation-timeline: scroll(self inline);');
    expect(css).toContain('.jump-strip:not([data-overflowing="false"])');
  });

  it('remounts nav on view switch while preserving keyboard focus within the same view, and toggles data-overflowing across resizes (#103)', () => {
    const resizeCallbacks: ResizeObserverCallback[] = [];
    const disconnectSpy = vi.fn();
    class MockResizeObserver implements ResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        disconnectSpy();
      }
    }

    const originalRO = globalThis.ResizeObserver;
    const originalCss = globalThis.CSS;
    globalThis.ResizeObserver = MockResizeObserver;
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { supports: () => true },
    });

    const eraItems: DirectoryJumpStripItem[] = [
      { id: 'sec-1700s', label: '1700s', count: 12 },
      { id: 'sec-1800s', label: '1800–49', count: 18 },
    ];
    const azItems: DirectoryJumpStripItem[] = [
      { id: 'sec-b', label: 'B' },
      { id: 'sec-c', label: 'C' },
    ];

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    cleanups.push(() => {
      act(() => {
        root.unmount();
      });
      container.remove();
    });

    try {
      act(() => {
        root.render(<DirectoryJumpStrip items={eraItems} ariaLabel="Jump to era" compact={false} />);
      });
      const eraNav = container.querySelector('nav') as HTMLElement;
      expect(eraNav).not.toBeNull();
      expect(eraNav.dataset['overflowing']).toBe('false');

      let mockScrollWidth = 477;
      let mockClientWidth = 358;
      Object.defineProperty(eraNav, 'scrollWidth', { configurable: true, get: () => mockScrollWidth });
      Object.defineProperty(eraNav, 'clientWidth', { configurable: true, get: () => mockClientWidth });

      act(() => {
        resizeCallbacks.at(-1)?.([], {} as ResizeObserver);
      });
      expect(eraNav.dataset['overflowing']).toBe('true');

      // Re-rendering with the same view/items preserves the nav element and active keyboard focus.
      const firstLink = eraNav.querySelector('a') as HTMLAnchorElement;
      firstLink.focus();
      act(() => {
        root.render(<DirectoryJumpStrip items={eraItems} ariaLabel="Jump to era" compact={false} />);
      });
      expect(container.querySelector('nav')).toBe(eraNav);
      expect(document.activeElement).toBe(firstLink);

      // Resizing to desktop clears data-overflowing back to false.
      mockScrollWidth = 1128;
      mockClientWidth = 1128;
      act(() => {
        resizeCallbacks.at(-1)?.([], {} as ResizeObserver);
      });
      expect(eraNav.dataset['overflowing']).toBe('false');

      // Switching to A–Z mounts a fresh nav node and disconnects the prior ResizeObserver.
      act(() => {
        root.render(
          <DirectoryJumpStrip
            items={azItems}
            ariaLabel="Jump to surname letter"
            compact={true}
            showCounts={false}
          />
        );
      });
      const azNav = container.querySelector('nav') as HTMLElement;
      expect(azNav).not.toBe(eraNav);
      expect(azNav.dataset['overflowing']).toBe('false');
      expect(disconnectSpy).toHaveBeenCalledTimes(1);

      // Also verify graceful no-op when ResizeObserver is unavailable.
      Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: undefined });
      act(() => {
        root.render(<DirectoryJumpStrip items={eraItems} ariaLabel="Jump to era" compact={false} />);
      });
      expect(container.querySelector('nav')?.getAttribute('data-overflowing')).toBe('false');
    } finally {
      Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: originalRO });
      Object.defineProperty(globalThis, 'CSS', { configurable: true, value: originalCss });
    }
  });
});
