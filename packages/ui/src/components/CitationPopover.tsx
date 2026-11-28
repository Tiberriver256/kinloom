import type { MediaItem, SourceRecord } from '@kinloom/core';
import { buildLibrarianCitation } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx.js';
import citationStyles from '../styles/Citations.module.css';
import markdownStyles from './ArchivalMarkdown.module.css';
import { ArchivalImage } from './Atoms.js';

const SAFE_EXTERNAL_URL_RE = /^https?:\/\//i;
const DESKTOP_MARGINALIA_BREAKPOINT = 1024;
const MIN_MARGINALIA_LANE_WIDTH = 220;

export interface PopoverAnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

export interface PopoverLaneRect {
  left: number;
  right: number;
  width: number;
}

export interface PopoverCoordinates {
  top: number;
  left: number;
  placement: 'above' | 'below' | 'marginalia';
  maxWidth: number;
}

export function measureStickyHeaderBottom(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return 0;
  }
  const headers = document.querySelectorAll<HTMLElement>('header');
  for (const header of headers) {
    const style = window.getComputedStyle(header);
    const rect = header.getBoundingClientRect();
    const isStickyOrFixed = style.position === 'sticky' || style.position === 'fixed';
    const isTopbarClass = typeof header.className === 'string' && header.className.includes('topbar');
    if ((isStickyOrFixed || isTopbarClass) && rect.bottom > 0 && rect.top <= 4) {
      return Math.ceil(rect.bottom);
    }
  }
  const cssVar = window.getComputedStyle(document.documentElement).getPropertyValue('--topbar-height').trim();
  const parsed = Number.parseFloat(cssVar);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.ceil(parsed);
  }
  return 0;
}

export function measureDesktopMarginaliaLane(anchorEl: HTMLElement): PopoverLaneRect | null {
  if (typeof window === 'undefined' || window.innerWidth < DESKTOP_MARGINALIA_BREAKPOINT) {
    return null;
  }
  const viewportWidth = window.innerWidth;
  const margin = 12;

  const row = anchorEl.closest<HTMLElement>('[class*="folio-marginalia-row"]');
  if (row) {
    const rail = row.querySelector<HTMLElement>(
      '[class*="folio-marginalia-rail"], [class*="folio-marginalia-rail-empty"]'
    );
    if (rail) {
      const rect = rail.getBoundingClientRect();
      if (rect.width >= 180 && rect.left < viewportWidth - margin) {
        return {
          left: rect.left,
          right: Math.min(rect.right, viewportWidth - margin),
          width: Math.min(rect.width, viewportWidth - margin - rect.left),
        };
      }
    }
  }

  const proseContainer = anchorEl.closest<HTMLElement>(
    '[class*="folio-marginalia-main"], [class*="person-biography-entry"], [class*="archival-markdown"]'
  );
  if (proseContainer) {
    const rect = proseContainer.getBoundingClientRect();
    const laneLeft = rect.right + 16;
    const laneWidth = viewportWidth - margin - laneLeft;
    if (rect.width > 0 && laneWidth >= MIN_MARGINALIA_LANE_WIDTH) {
      return {
        left: laneLeft,
        right: viewportWidth - margin,
        width: laneWidth,
      };
    }
  }

  return null;
}

export function computeCitationPopoverPosition(params: {
  anchorRect: PopoverAnchorRect;
  popoverSize: { width: number; height: number };
  viewport: { width: number; height: number };
  margin?: number;
  gap?: number;
  headerBottom?: number;
  marginaliaLane?: PopoverLaneRect | null;
  preferRightLane?: boolean;
}): PopoverCoordinates {
  const margin = params.margin ?? 12;
  const gap = params.gap ?? 8;
  const headerBottom = Math.max(0, params.headerBottom ?? 0);
  const minTop = Math.max(margin, Math.ceil(headerBottom) + margin);

  const maxWidth = Math.min(340, Math.max(220, params.viewport.width - margin * 2));
  const effectiveWidth = Math.min(
    params.popoverSize.width > 0 ? params.popoverSize.width : maxWidth,
    maxWidth
  );
  const effectiveHeight = params.popoverSize.height > 0 ? params.popoverSize.height : 200;
  const maxLeft = Math.max(margin, params.viewport.width - effectiveWidth - margin);
  const maxTop = Math.max(minTop, params.viewport.height - effectiveHeight - margin);

  if (params.viewport.width >= DESKTOP_MARGINALIA_BREAKPOINT) {
    const lane = params.marginaliaLane;
    if (lane && params.viewport.width - lane.left - margin >= MIN_MARGINALIA_LANE_WIDTH) {
      const laneMaxWidth = Math.min(maxWidth, Math.max(220, params.viewport.width - lane.left - margin));
      const laneEffectiveWidth = Math.min(effectiveWidth, laneMaxWidth);
      const laneMaxLeft = Math.max(margin, params.viewport.width - laneEffectiveWidth - margin);
      const left = Math.round(Math.max(margin, Math.min(lane.left, laneMaxLeft)));
      const rawTop = params.anchorRect.top - 8;
      const top = Math.round(Math.max(minTop, Math.min(rawTop, maxTop)));
      return {
        top,
        left,
        placement: 'marginalia',
        maxWidth: Math.round(laneMaxWidth),
      };
    }

    if (params.preferRightLane) {
      const rightLaneLeft = Math.max(margin, params.viewport.width - effectiveWidth - margin);
      if (rightLaneLeft >= params.anchorRect.right + 16) {
        const rawTop = params.anchorRect.top - 8;
        const top = Math.round(Math.max(minTop, Math.min(rawTop, maxTop)));
        return {
          top,
          left: Math.round(rightLaneLeft),
          placement: 'marginalia',
          maxWidth: Math.round(maxWidth),
        };
      }
    }
  }

  const idealLeft = params.anchorRect.left + params.anchorRect.width / 2 - effectiveWidth / 2;
  const left = Math.round(Math.max(margin, Math.min(idealLeft, maxLeft)));

  const spaceBelow = params.viewport.height - params.anchorRect.bottom - gap - margin;
  const spaceAbove = params.anchorRect.top - gap - minTop;

  let placement: 'above' | 'below';
  let rawTop: number;
  if (spaceBelow >= effectiveHeight || spaceBelow >= spaceAbove) {
    placement = 'below';
    rawTop = params.anchorRect.bottom + gap;
  } else {
    placement = 'above';
    rawTop = params.anchorRect.top - gap - effectiveHeight;
  }

  const top = Math.round(Math.max(minTop, Math.min(rawTop, maxTop)));

  return {
    top,
    left,
    placement,
    maxWidth: Math.round(maxWidth),
  };
}

export interface CitationPopoverProps {
  id: string;
  footnoteNumber: number;
  source: SourceRecord;
  media: MediaItem | null;
  mediaUrl: string | null;
  anchorEl: HTMLElement;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onBlur: (event: React.FocusEvent<HTMLDivElement>) => void;
  onClose: () => void;
  onInspectSource?: ((sourceId: string) => void) | undefined;
  onOpenMedia?: ((media: MediaItem) => void) | undefined;
}

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export const CitationPopover: React.FC<CitationPopoverProps> = ({
  id,
  footnoteNumber,
  source,
  media,
  mediaUrl,
  anchorEl,
  popoverRef,
  onMouseEnter,
  onMouseLeave,
  onBlur,
  onClose,
  onInspectSource,
  onOpenMedia,
}) => {
  const [coords, setCoords] = useState<PopoverCoordinates>(() =>
    computeCitationPopoverPosition({
      anchorRect: anchorEl.getBoundingClientRect(),
      popoverSize: { width: 320, height: 200 },
      viewport: {
        width: typeof window !== 'undefined' ? window.innerWidth : 1024,
        height: typeof window !== 'undefined' ? window.innerHeight : 768,
      },
      headerBottom: measureStickyHeaderBottom(),
      marginaliaLane: measureDesktopMarginaliaLane(anchorEl),
      preferRightLane: true,
    })
  );
  const [imageFailed, setImageFailed] = useState(false);
  const prevMediaUrlRef = useRef<string | null>(mediaUrl);

  if (prevMediaUrlRef.current !== mediaUrl) {
    prevMediaUrlRef.current = mediaUrl;
    if (imageFailed) {
      setImageFailed(false);
    }
  }

  const reposition = useCallback(() => {
    const anchorRect = anchorEl.getBoundingClientRect();
    const popRect = popoverRef.current?.getBoundingClientRect();
    setCoords(
      computeCitationPopoverPosition({
        anchorRect,
        popoverSize: {
          width: popRect?.width ?? 320,
          height: popRect?.height ?? 200,
        },
        viewport: {
          width: window.innerWidth || 1024,
          height: window.innerHeight || 768,
        },
        headerBottom: measureStickyHeaderBottom(),
        marginaliaLane: measureDesktopMarginaliaLane(anchorEl),
        preferRightLane: true,
      })
    );
  }, [anchorEl, popoverRef]);

  useIsoLayoutEffect(() => {
    reposition();
  }, [reposition, source.id, mediaUrl, imageFailed]);

  useEffect(() => {
    window.addEventListener('scroll', reposition, { capture: true, passive: true });
    window.addEventListener('resize', reposition, { passive: true });
    return (): void => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [reposition]);

  const citation = buildLibrarianCitation(source);
  const safeExternalUrl = citation.url && SAFE_EXTERNAL_URL_RE.test(citation.url) ? citation.url : null;
  const trimmedMediaUrl = mediaUrl?.trim() || null;
  const showMediaPreview = Boolean(media && trimmedMediaUrl && !imageFailed);

  const card = (
    <div
      ref={popoverRef}
      id={id}
      role="dialog"
      aria-label={`Source citation ${footnoteNumber}`}
      className={cx(markdownStyles, `citation-popover is-${coords.placement} print-hide`)}
      style={{
        top: coords.top,
        left: coords.left,
        maxWidth: coords.maxWidth,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onBlur={onBlur}
    >
      <div className={cx(markdownStyles, 'citation-popover-header')}>
        <div className={cx(markdownStyles, 'citation-popover-header-meta')}>
          <span className={cx(markdownStyles, 'citation-popover-num')}>[{footnoteNumber}]</span>
          <span className={cx(citationStyles, `evidence-tier-badge tier-${citation.tier}`)}>
            {citation.tierLabel}
          </span>
        </div>
        <button
          type="button"
          className={cx(markdownStyles, 'citation-popover-close')}
          aria-label="Close citation preview"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <p className={cx(markdownStyles, 'citation-popover-body')}>{citation.title}</p>

      {(citation.repository || safeExternalUrl) && (
        <div className={cx(markdownStyles, 'citation-popover-meta')}>
          {citation.repository && <span>{citation.repository}</span>}
          {safeExternalUrl && (
            <a
              href={safeExternalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(markdownStyles, 'citation-popover-ext-link')}
            >
              {citation.urlHost || 'External archive'} ↗
            </a>
          )}
        </div>
      )}

      {showMediaPreview && media && trimmedMediaUrl && (
        <div className={cx(markdownStyles, 'citation-popover-media-wrap')}>
          {onOpenMedia ? (
            <button
              type="button"
              className={cx(markdownStyles, 'citation-popover-media-btn')}
              aria-label={`Open full archival scan: ${media.caption}`}
              onClick={() => {
                onClose();
                onOpenMedia(media);
              }}
            >
              <span className={cx(markdownStyles, 'citation-popover-media-frame')}>
                <ArchivalImage
                  src={trimmedMediaUrl}
                  alt={media.caption}
                  frameClassName={cx(markdownStyles, 'citation-popover-media-image-frame')}
                  className={cx(markdownStyles, 'citation-popover-media-img')}
                  frameStyle={{ width: '100%' }}
                  loading="eager"
                  fallback={null}
                  onLoad={reposition}
                  onError={() => {
                    setImageFailed(true);
                  }}
                />
              </span>
              <span className={cx(markdownStyles, 'citation-popover-media-caption')}>{media.caption}</span>
            </button>
          ) : (
            <figure className={cx(markdownStyles, 'citation-popover-media-figure')}>
              <div className={cx(markdownStyles, 'citation-popover-media-frame')}>
                <ArchivalImage
                  src={trimmedMediaUrl}
                  alt={media.caption}
                  frameClassName={cx(markdownStyles, 'citation-popover-media-image-frame')}
                  className={cx(markdownStyles, 'citation-popover-media-img')}
                  frameStyle={{ width: '100%' }}
                  loading="eager"
                  fallback={null}
                  onLoad={reposition}
                  onError={() => {
                    setImageFailed(true);
                  }}
                />
              </div>
              <figcaption className={cx(markdownStyles, 'citation-popover-media-caption')}>
                {media.caption}
              </figcaption>
            </figure>
          )}
        </div>
      )}

      {onInspectSource && (
        <div className={cx(markdownStyles, 'citation-popover-footer')}>
          <button
            type="button"
            className={cx(markdownStyles, 'citation-popover-inspect-btn')}
            onClick={() => {
              onClose();
              onInspectSource(source.id);
            }}
          >
            Inspect full source
          </button>
        </div>
      )}
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(card, document.body);
  }
  return card;
};
