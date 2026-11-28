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

export interface PopoverAnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

export interface PopoverCoordinates {
  top: number;
  left: number;
  placement: 'above' | 'below';
  maxWidth: number;
}

export function computeCitationPopoverPosition(params: {
  anchorRect: PopoverAnchorRect;
  popoverSize: { width: number; height: number };
  viewport: { width: number; height: number };
  margin?: number;
  gap?: number;
}): PopoverCoordinates {
  const margin = params.margin ?? 12;
  const gap = params.gap ?? 8;
  const maxWidth = Math.min(340, Math.max(220, params.viewport.width - margin * 2));
  const effectiveWidth = Math.min(
    params.popoverSize.width > 0 ? params.popoverSize.width : maxWidth,
    maxWidth
  );
  const effectiveHeight = params.popoverSize.height > 0 ? params.popoverSize.height : 200;

  const idealLeft = params.anchorRect.left + params.anchorRect.width / 2 - effectiveWidth / 2;
  const maxLeft = Math.max(margin, params.viewport.width - effectiveWidth - margin);
  const left = Math.round(Math.max(margin, Math.min(idealLeft, maxLeft)));

  const spaceBelow = params.viewport.height - params.anchorRect.bottom - gap - margin;
  const spaceAbove = params.anchorRect.top - gap - margin;

  let placement: 'above' | 'below';
  let rawTop: number;
  if (spaceBelow >= effectiveHeight || spaceBelow >= spaceAbove) {
    placement = 'below';
    rawTop = params.anchorRect.bottom + gap;
  } else {
    placement = 'above';
    rawTop = params.anchorRect.top - gap - effectiveHeight;
  }

  const maxTop = Math.max(margin, params.viewport.height - effectiveHeight - margin);
  const top = Math.round(Math.max(margin, Math.min(rawTop, maxTop)));

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
  onInspectSource?: (sourceId: string) => void;
  onOpenMedia?: (media: MediaItem) => void;
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
  const showMediaPreview = Boolean(media && mediaUrl && !imageFailed);

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

      {showMediaPreview && media && mediaUrl && (
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
                  src={mediaUrl}
                  alt={media.caption}
                  className={cx(markdownStyles, 'citation-popover-media-img')}
                  frameStyle={{ width: '100%' }}
                  loading="lazy"
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
                  src={mediaUrl}
                  alt={media.caption}
                  className={cx(markdownStyles, 'citation-popover-media-img')}
                  frameStyle={{ width: '100%' }}
                  loading="lazy"
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
