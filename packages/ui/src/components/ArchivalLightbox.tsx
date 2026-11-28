import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cx } from '../lib/cx.js';
import {
  clampLightboxPan,
  formatLightboxZoomPercent,
  LIGHTBOX_MAX_ZOOM,
  LIGHTBOX_MIN_ZOOM,
  LIGHTBOX_PAN_KEY_STEP_PX,
  type LightboxPanOffset,
  stepLightboxIndex,
  stepLightboxZoom,
} from '../lib/lightboxModel.js';
import styles from './ArchivalLightbox.module.css';
import { ArchivalImage } from './Atoms.js';

export interface ArchivalLightboxItem {
  readonly id: string;
  readonly url: string;
  readonly alt: string;
  readonly caption: string;
  readonly meta?: string;
}

export interface ArchivalLightboxProps {
  readonly items: readonly ArchivalLightboxItem[];
  readonly activeIndex: number | null;
  readonly onClose: () => void;
  readonly onChangeIndex: (nextIndex: number) => void;
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly originPan: LightboxPanOffset;
}

function isPointerOutsideRect(clientX: number, clientY: number, rect: DOMRect): boolean {
  return clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom;
}

const ZERO_PAN: LightboxPanOffset = { x: 0, y: 0 };

interface LightboxTransformState {
  readonly itemId: string | null;
  readonly zoom: number;
  readonly pan: LightboxPanOffset;
}

/**
 * Accessible top-layer archival image lightbox built on the native `<dialog>` element
 * with 1x-4x zoom, pointer/keyboard pan, multi-photo navigation, and light-dismiss support.
 */
export const ArchivalLightbox: React.FC<ArchivalLightboxProps> = ({
  items,
  activeIndex,
  onClose,
  onChangeIndex,
}) => {
  const headingId = useId();
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pressedOutsideRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const isOpen = activeIndex !== null && items.length > 0 && activeIndex >= 0 && activeIndex < items.length;
  const activeItem = isOpen ? items[activeIndex] : null;
  const activeItemId = activeItem?.id ?? null;

  const [transform, setTransform] = useState<LightboxTransformState>({
    itemId: null,
    zoom: LIGHTBOX_MIN_ZOOM,
    pan: ZERO_PAN,
  });
  const [isPanning, setIsPanning] = useState<boolean>(false);

  const zoom = transform.itemId === activeItemId ? transform.zoom : LIGHTBOX_MIN_ZOOM;
  const pan = transform.itemId === activeItemId ? transform.pan : ZERO_PAN;

  const measureStageSpan = useCallback((): number => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) {
      return 420;
    }
    return Math.max(rect.width, rect.height);
  }, []);

  const applyZoom = useCallback(
    (nextZoom: number) => {
      const span = measureStageSpan();
      setTransform((prev) => {
        const basePan = prev.itemId === activeItemId ? prev.pan : ZERO_PAN;
        return {
          itemId: activeItemId,
          zoom: nextZoom,
          pan: clampLightboxPan(basePan, nextZoom, span),
        };
      });
    },
    [activeItemId, measureStageSpan]
  );

  const applyPan = useCallback(
    (updater: (currentPan: LightboxPanOffset) => LightboxPanOffset) => {
      const span = measureStageSpan();
      setTransform((prev) => {
        const currentZoom = prev.itemId === activeItemId ? prev.zoom : LIGHTBOX_MIN_ZOOM;
        const currentPan = prev.itemId === activeItemId ? prev.pan : ZERO_PAN;
        return {
          itemId: activeItemId,
          zoom: currentZoom,
          pan: clampLightboxPan(updater(currentPan), currentZoom, span),
        };
      });
    },
    [activeItemId, measureStageSpan]
  );

  // Open/close native <dialog> via showModal() with graceful jsdom fallback.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return undefined;
    }

    if (isOpen) {
      dialog.setAttribute('closedby', 'any');
      if (!dialog.open) {
        if (typeof dialog.showModal === 'function') {
          dialog.showModal();
        } else {
          dialog.setAttribute('open', '');
        }
      }
      closeButtonRef.current?.focus();
    } else if (dialog.open) {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        dialog.removeAttribute('open');
      }
    }

    return undefined;
  }, [isOpen]);

  // Listen for native `close` and Safari light-dismiss fallback when `closedBy` is unsupported.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !isOpen) {
      return undefined;
    }

    const handleNativeClose = (): void => {
      dialog.returnValue = '';
      onCloseRef.current();
    };
    dialog.addEventListener('close', handleNativeClose);

    const supportsClosedBy =
      typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype;

    const handlePointerDownOutside = (event: PointerEvent): void => {
      if (event.target !== dialog) {
        pressedOutsideRef.current = false;
        return;
      }
      const rect = dialog.getBoundingClientRect();
      pressedOutsideRef.current =
        rect.width > 0 && rect.height > 0 && isPointerOutsideRect(event.clientX, event.clientY, rect);
    };

    const handlePointerUpOutside = (event: PointerEvent): void => {
      const rect = dialog.getBoundingClientRect();
      if (
        pressedOutsideRef.current &&
        event.target === dialog &&
        rect.width > 0 &&
        rect.height > 0 &&
        isPointerOutsideRect(event.clientX, event.clientY, rect)
      ) {
        pressedOutsideRef.current = false;
        if (typeof dialog.close === 'function' && dialog.open) {
          dialog.close();
        } else {
          onCloseRef.current();
        }
      } else {
        pressedOutsideRef.current = false;
      }
    };

    if (!supportsClosedBy) {
      dialog.addEventListener('pointerdown', handlePointerDownOutside);
      dialog.addEventListener('pointerup', handlePointerUpOutside);
    }

    return (): void => {
      dialog.removeEventListener('close', handleNativeClose);
      if (!supportsClosedBy) {
        dialog.removeEventListener('pointerdown', handlePointerDownOutside);
        dialog.removeEventListener('pointerup', handlePointerUpOutside);
      }
    };
  }, [isOpen]);

  const handleCloseButton = (): void => {
    const dialog = dialogRef.current;
    if (dialog && typeof dialog.close === 'function' && dialog.open) {
      dialog.close();
      return;
    }
    onClose();
  };

  const handlePrev = useCallback(() => {
    if (activeIndex === null || items.length <= 1) {
      return;
    }
    onChangeIndex(stepLightboxIndex(activeIndex, items.length, 'prev'));
  }, [activeIndex, items.length, onChangeIndex]);

  const handleNext = useCallback(() => {
    if (activeIndex === null || items.length <= 1) {
      return;
    }
    onChangeIndex(stepLightboxIndex(activeIndex, items.length, 'next'));
  }, [activeIndex, items.length, onChangeIndex]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>): void => {
    if (!isOpen) {
      return;
    }
    if (event.key === 'Escape') {
      // Native showModal handles Esc in real browsers; jsdom fallback closes cleanly.
      const dialog = dialogRef.current;
      if (dialog && typeof dialog.showModal !== 'function') {
        event.preventDefault();
        onClose();
      }
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      applyZoom(stepLightboxZoom(zoom, 'in'));
      return;
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      applyZoom(stepLightboxZoom(zoom, 'out'));
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      applyZoom(LIGHTBOX_MIN_ZOOM);
      return;
    }
    if (zoom > LIGHTBOX_MIN_ZOOM) {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        applyPan((prev) => ({ x: prev.x + LIGHTBOX_PAN_KEY_STEP_PX, y: prev.y }));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        applyPan((prev) => ({ x: prev.x - LIGHTBOX_PAN_KEY_STEP_PX, y: prev.y }));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        applyPan((prev) => ({ x: prev.x, y: prev.y + LIGHTBOX_PAN_KEY_STEP_PX }));
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        applyPan((prev) => ({ x: prev.x, y: prev.y - LIGHTBOX_PAN_KEY_STEP_PX }));
      }
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      handlePrev();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      handleNext();
    }
  };

  const handleStageWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    applyZoom(stepLightboxZoom(zoom, event.deltaY < 0 ? 'in' : 'out'));
  };

  const handleStagePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (zoom <= LIGHTBOX_MIN_ZOOM) {
      return;
    }
    if ((event.target as HTMLElement | null)?.closest('button')) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originPan: pan,
    };
    setIsPanning(true);
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handleStagePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    applyPan(() => ({ x: drag.originPan.x + dx, y: drag.originPan.y + dy }));
  };

  const handleStagePointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setIsPanning(false);
    }
  };

  if (!isOpen || !activeItem || activeIndex === null) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={headingId}
      className={cx(styles, 'archival-lightbox-dialog')}
      onKeyDown={handleKeyDown}
    >
      <header className={cx(styles, 'archival-lightbox-header')}>
        <div className={cx(styles, 'archival-lightbox-heading-group')}>
          <h1 id={headingId} className={cx(styles, 'archival-lightbox-title')}>
            {activeItem.caption || activeItem.alt}
          </h1>
          {items.length > 1 && (
            <span className={cx(styles, 'archival-lightbox-counter')}>
              {activeIndex + 1} / {items.length}
            </span>
          )}
        </div>

        <div className={cx(styles, 'archival-lightbox-toolbar')}>
          <button
            type="button"
            className={cx(styles, 'archival-lightbox-btn')}
            aria-label="Zoom out"
            disabled={zoom <= LIGHTBOX_MIN_ZOOM}
            onClick={() => {
              applyZoom(stepLightboxZoom(zoom, 'out'));
            }}
          >
            −
          </button>
          <span className={cx(styles, 'archival-lightbox-zoom-readout')} aria-live="polite">
            {formatLightboxZoomPercent(zoom)}
          </span>
          <button
            type="button"
            className={cx(styles, 'archival-lightbox-btn')}
            aria-label="Zoom in"
            disabled={zoom >= LIGHTBOX_MAX_ZOOM}
            onClick={() => {
              applyZoom(stepLightboxZoom(zoom, 'in'));
            }}
          >
            +
          </button>
          <button
            type="button"
            className={cx(styles, 'archival-lightbox-btn')}
            disabled={zoom === LIGHTBOX_MIN_ZOOM && pan.x === 0 && pan.y === 0}
            onClick={() => {
              applyZoom(LIGHTBOX_MIN_ZOOM);
            }}
          >
            Reset
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            className={cx(styles, 'archival-lightbox-btn')}
            onClick={handleCloseButton}
          >
            Close
          </button>
        </div>
      </header>

      <div
        ref={stageRef}
        className={cx(
          styles,
          isPanning
            ? 'archival-lightbox-stage archival-lightbox-stage-panning'
            : zoom > LIGHTBOX_MIN_ZOOM
              ? 'archival-lightbox-stage archival-lightbox-stage-pannable'
              : 'archival-lightbox-stage'
        )}
        onWheel={handleStageWheel}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handleStagePointerMove}
        onPointerUp={handleStagePointerEnd}
        onPointerCancel={handleStagePointerEnd}
      >
        {items.length > 1 && (
          <button
            type="button"
            className={cx(styles, 'archival-lightbox-nav archival-lightbox-nav-prev')}
            aria-label="Previous photo"
            onClick={handlePrev}
          >
            ←
          </button>
        )}

        <ArchivalImage
          src={activeItem.url}
          alt={activeItem.alt}
          loading="eager"
          allowOverflow
          draggable={false}
          fallbackCaption={activeItem.caption || activeItem.alt}
          className={cx(
            styles,
            isPanning ? 'archival-lightbox-image archival-lightbox-image-panning' : 'archival-lightbox-image'
          )}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          }}
        />

        {items.length > 1 && (
          <button
            type="button"
            className={cx(styles, 'archival-lightbox-nav archival-lightbox-nav-next')}
            aria-label="Next photo"
            onClick={handleNext}
          >
            →
          </button>
        )}
      </div>

      <footer className={cx(styles, 'archival-lightbox-footer')}>
        <div className={cx(styles, 'archival-lightbox-caption-row')}>
          <p className={cx(styles, 'archival-lightbox-caption')}>{activeItem.caption || activeItem.alt}</p>
          {activeItem.meta && <p className={cx(styles, 'archival-lightbox-meta')}>{activeItem.meta}</p>}
        </div>
        {items.length > 1 && (
          <nav className={cx(styles, 'archival-lightbox-thumbs')} aria-label="Recipe card thumbnails">
            {items.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                aria-label={`View photo ${idx + 1}: ${item.caption || item.alt}`}
                aria-current={idx === activeIndex ? 'true' : undefined}
                className={cx(styles, 'archival-lightbox-thumb-btn')}
                onClick={() => {
                  onChangeIndex(idx);
                }}
              >
                <ArchivalImage
                  src={item.url}
                  alt=""
                  frameClassName={cx(styles, 'archival-lightbox-thumb-img')}
                  className={cx(styles, 'archival-lightbox-thumb-img')}
                  loading="lazy"
                  fallbackCompact
                />
              </button>
            ))}
          </nav>
        )}
      </footer>
    </dialog>
  );
};
