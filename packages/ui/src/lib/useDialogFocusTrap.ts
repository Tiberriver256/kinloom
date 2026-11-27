import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

const activeDialogStack: HTMLElement[] = [];

function isElementVisible(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') {
    return false;
  }
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) {
    return false;
  }
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
  }
  return true;
}

export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const candidates = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
  const result: HTMLElement[] = [];
  for (const el of candidates) {
    if (el.classList.contains('lightbox-backdrop-close')) {
      continue;
    }
    if (el.tabIndex < 0) {
      continue;
    }
    if (!isElementVisible(el)) {
      continue;
    }
    result.push(el);
  }
  return result;
}

export interface UseDialogFocusTrapOptions {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly initialFocusRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Traps keyboard Tab/Shift+Tab focus inside an open overlay dialog, closes on Escape
 * only when topmost in the active dialog stack, sets initial focus on open, and restores
 * focus to the previously focused element on close.
 */
export function useDialogFocusTrap<T extends HTMLElement = HTMLDialogElement>({
  open,
  onClose,
  initialFocusRef,
}: UseDialogFocusTrapOptions): React.RefObject<T | null> {
  const containerRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || typeof document === 'undefined' || typeof window === 'undefined') {
      return undefined;
    }
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    activeDialogStack.push(container);

    const focusInitial = (): void => {
      const explicitTarget = initialFocusRef?.current;
      if (explicitTarget && container.contains(explicitTarget) && isElementVisible(explicitTarget)) {
        explicitTarget.focus();
        return;
      }
      const focusables = getFocusableElements(container);
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        if (!container.hasAttribute('tabindex')) {
          container.setAttribute('tabindex', '-1');
        }
        container.focus();
      }
    };

    focusInitial();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (activeDialogStack.at(-1) !== container) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key === 'Tab') {
        const focusables = getFocusableElements(container);
        if (focusables.length === 0) {
          event.preventDefault();
          container.focus();
          return;
        }
        const [first] = focusables;
        const last = focusables.at(-1) ?? first;
        const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        if (event.shiftKey) {
          if (!active || !container.contains(active) || active === first) {
            event.preventDefault();
            last.focus();
          }
        } else if (!active || !container.contains(active) || active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, true);

    return (): void => {
      window.removeEventListener('keydown', onKeyDown, true);
      const stackIdx = activeDialogStack.lastIndexOf(container);
      if (stackIdx !== -1) {
        activeDialogStack.splice(stackIdx, 1);
      }
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, [open, initialFocusRef]);

  return containerRef;
}
