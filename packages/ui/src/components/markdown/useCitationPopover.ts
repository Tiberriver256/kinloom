import type { MediaItem, SourceRecord } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { InlineCitationPayload } from './archivalInlineRenderer.js';

const POPOVER_CLOSE_DELAY_MS = 150;

export interface ActiveCitationPopover {
  occurrenceKey: string;
  footnoteNumber: number;
  source: SourceRecord;
  media: MediaItem | null;
  mediaUrl: string | null;
  anchorEl: HTMLButtonElement;
  triggerMode: 'hover' | 'focus' | 'pinned';
}

export interface CitationPopoverController {
  popoverId: string;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  activePopover: ActiveCitationPopover | null;
  clearCloseTimer: () => void;
  closePopover: () => void;
  scheduleClose: (expectedKey?: string) => void;
  handleTriggerHover: (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => void;
  handleTriggerLeave: (occurrenceKey: string) => void;
  handleTriggerFocus: (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => void;
  handleTriggerBlur: (event: React.FocusEvent<HTMLButtonElement>) => void;
  handlePopoverBlur: (event: React.FocusEvent<HTMLDivElement>) => void;
  handleTriggerClick: (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => void;
}

export function useCitationPopover(): CitationPopoverController {
  const popoverId = useId();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [activePopover, setActivePopover] = useState<ActiveCitationPopover | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closePopover = useCallback(() => {
    clearCloseTimer();
    setActivePopover(null);
  }, [clearCloseTimer]);

  const scheduleClose = useCallback(
    (expectedKey?: string) => {
      clearCloseTimer();
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        setActivePopover((prev) => {
          if (!prev || prev.triggerMode === 'pinned') {
            return prev;
          }
          if (expectedKey && prev.occurrenceKey !== expectedKey) {
            return prev;
          }
          return null;
        });
      }, POPOVER_CLOSE_DELAY_MS);
    },
    [clearCloseTimer]
  );

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  useEffect(() => {
    if (!activePopover) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        const focusWasInside = Boolean(
          popoverRef.current && document.activeElement && popoverRef.current.contains(document.activeElement)
        );
        const anchor = activePopover.anchorEl;
        closePopover();
        if (focusWasInside) {
          anchor.focus();
        }
      }
    };
    const onOutsidePointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (activePopover.anchorEl.contains(target)) {
        return;
      }
      if (popoverRef.current?.contains(target)) {
        return;
      }
      closePopover();
    };

    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onOutsidePointerDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onOutsidePointerDown);
    };
  }, [activePopover, closePopover]);

  const handleTriggerHover = useCallback(
    (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => {
      clearCloseTimer();
      setActivePopover((prev) => ({
        ...payload,
        anchorEl,
        triggerMode:
          prev && prev.occurrenceKey === payload.occurrenceKey && prev.triggerMode === 'pinned'
            ? 'pinned'
            : 'hover',
      }));
    },
    [clearCloseTimer]
  );

  const handleTriggerLeave = useCallback(
    (occurrenceKey: string) => {
      scheduleClose(occurrenceKey);
    },
    [scheduleClose]
  );

  const handleTriggerFocus = useCallback(
    (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => {
      clearCloseTimer();
      setActivePopover((prev) => ({
        ...payload,
        anchorEl,
        triggerMode:
          prev && prev.occurrenceKey === payload.occurrenceKey && prev.triggerMode === 'pinned'
            ? 'pinned'
            : 'focus',
      }));
    },
    [clearCloseTimer]
  );

  const handleFocusLeavingSurface = useCallback(
    (relatedTarget: EventTarget | null) => {
      if (relatedTarget instanceof Node) {
        if (popoverRef.current?.contains(relatedTarget)) {
          return;
        }
        if (activePopover?.anchorEl.contains(relatedTarget)) {
          return;
        }
      }
      setActivePopover((prev) => (prev && prev.triggerMode === 'focus' ? null : prev));
    },
    [activePopover]
  );

  const handleTriggerBlur = useCallback(
    (event: React.FocusEvent<HTMLButtonElement>) => {
      handleFocusLeavingSurface(event.relatedTarget);
    },
    [handleFocusLeavingSurface]
  );

  const handlePopoverBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      handleFocusLeavingSurface(event.relatedTarget);
    },
    [handleFocusLeavingSurface]
  );

  const handleTriggerClick = useCallback(
    (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => {
      clearCloseTimer();
      setActivePopover((prev) => {
        if (prev && prev.occurrenceKey === payload.occurrenceKey && prev.triggerMode === 'pinned') {
          return null;
        }
        return {
          ...payload,
          anchorEl,
          triggerMode: 'pinned',
        };
      });
    },
    [clearCloseTimer]
  );

  return {
    popoverId,
    popoverRef,
    activePopover,
    clearCloseTimer,
    closePopover,
    scheduleClose,
    handleTriggerHover,
    handleTriggerLeave,
    handleTriggerFocus,
    handleTriggerBlur,
    handlePopoverBlur,
    handleTriggerClick,
  };
}
