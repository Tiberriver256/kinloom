import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { cx, joinClasses } from '../../lib/cx.js';
import imageStyles from './ArchivalImage.module.css';
import { resolveAssetUrl } from './formatters.js';

export type ArchivalImageStatus =
  | { readonly kind: 'empty' }
  | { readonly kind: 'loading'; readonly src: string }
  | { readonly kind: 'loaded'; readonly src: string }
  | { readonly kind: 'error'; readonly src: string };

type LoadOutcome =
  | { readonly kind: 'loaded'; readonly src: string }
  | { readonly kind: 'error'; readonly src: string };

export function useArchivalImageStatus(resolvedSrc: string): {
  readonly status: ArchivalImageStatus;
  readonly imgRef: React.RefObject<HTMLImageElement | null>;
  readonly markLoaded: () => void;
  readonly markError: () => void;
} {
  const [prevSrc, setPrevSrc] = useState(resolvedSrc);
  const [outcome, setOutcome] = useState<LoadOutcome | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  if (resolvedSrc !== prevSrc) {
    setPrevSrc(resolvedSrc);
    setOutcome(null);
  }

  let status: ArchivalImageStatus;
  if (!resolvedSrc) {
    status = { kind: 'empty' };
  } else if (outcome && outcome.src === resolvedSrc) {
    status = outcome;
  } else {
    status = { kind: 'loading', src: resolvedSrc };
  }

  useEffect(() => {
    if (!resolvedSrc) {
      return;
    }
    const el = imgRef.current;
    if (!el?.complete) {
      return;
    }
    if (el.naturalWidth > 0) {
      setOutcome((cur) =>
        cur?.kind === 'loaded' && cur.src === resolvedSrc ? cur : { kind: 'loaded', src: resolvedSrc }
      );
    } else {
      setOutcome((cur) =>
        cur?.kind === 'error' && cur.src === resolvedSrc ? cur : { kind: 'error', src: resolvedSrc }
      );
    }
  }, [resolvedSrc]);

  const markLoaded = (): void => {
    if (!resolvedSrc) {
      return;
    }
    setOutcome({ kind: 'loaded', src: resolvedSrc });
  };

  const markError = (): void => {
    if (!resolvedSrc) {
      return;
    }
    setOutcome({ kind: 'error', src: resolvedSrc });
  };

  return { status, imgRef, markLoaded, markError };
}

export interface ArchivalImageProps {
  readonly src: string | null | undefined;
  readonly alt: string;
  readonly baseUrl?: string;
  readonly frameClassName?: string;
  readonly frameStyle?: React.CSSProperties;
  readonly className?: string;
  readonly style?: React.CSSProperties;
  readonly loading?: 'eager' | 'lazy';
  readonly decoding?: 'async' | 'sync' | 'auto';
  readonly fetchPriority?: 'high' | 'low';
  readonly draggable?: boolean;
  readonly width?: number | string;
  readonly height?: number | string;
  readonly sizes?: string;
  readonly allowOverflow?: boolean;
  readonly fallbackCaption?: string;
  readonly fallbackCompact?: boolean;
  readonly fallback?: React.ReactNode;
  readonly onLoad?: React.ReactEventHandler<HTMLImageElement>;
  readonly onError?: React.ReactEventHandler<HTMLImageElement>;
}

const ArchivalPlateGlyph: React.FC<{ readonly compact?: boolean }> = ({ compact = false }) => (
  <svg
    className={cx(imageStyles, 'archival-image-fallback-glyph')}
    width={compact ? 18 : 26}
    height={compact ? 18 : 26}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M4.5 18l5.2-5.2a1.2 1.2 0 0 1 1.7 0l2.6 2.6 2-2a1.2 1.2 0 0 1 1.7 0L20 15.8" />
  </svg>
);

export const ArchivalImage: React.FC<ArchivalImageProps> = ({
  src,
  alt,
  baseUrl,
  frameClassName,
  frameStyle,
  className,
  style,
  loading = 'lazy',
  decoding = 'async',
  fetchPriority,
  draggable,
  width,
  height,
  sizes,
  allowOverflow = false,
  fallbackCaption,
  fallbackCompact = false,
  fallback,
  onLoad,
  onError,
}) => {
  const resolvedSrc = baseUrl !== undefined ? resolveAssetUrl(src, baseUrl) : (src?.trim() ?? '');
  const { status, imgRef, markLoaded, markError } = useArchivalImageStatus(resolvedSrc);

  if (status.kind === 'empty' || status.kind === 'error') {
    if (fallback !== undefined) {
      return <>{fallback}</>;
    }
    const labelText = fallbackCaption || 'Archival image unavailable';
    const fallbackClass = joinClasses(
      cx(imageStyles, fallbackCompact ? 'archival-image-fallback is-compact' : 'archival-image-fallback'),
      frameClassName
    );
    const fallbackContent = (
      <>
        <ArchivalPlateGlyph compact={fallbackCompact} />
        {!fallbackCompact && (
          <span className={cx(imageStyles, 'archival-image-fallback-label')}>{labelText}</span>
        )}
      </>
    );
    if (alt) {
      return (
        <span
          className={fallbackClass}
          style={frameStyle}
          data-image-status={status.kind}
          role="img"
          aria-label={alt}
        >
          {fallbackContent}
        </span>
      );
    }
    return (
      <span className={fallbackClass} style={frameStyle} data-image-status={status.kind} aria-hidden="true">
        {fallbackContent}
      </span>
    );
  }

  // Never combine fetchPriority="high" with loading="lazy".
  const effectiveLoading: 'eager' | 'lazy' = fetchPriority === 'high' ? 'eager' : loading;

  return (
    <span
      className={joinClasses(
        cx(imageStyles, allowOverflow ? 'archival-image-frame is-overflow-visible' : 'archival-image-frame'),
        frameClassName
      )}
      style={frameStyle}
      data-image-status={status.kind}
    >
      {status.kind === 'loading' && (
        <span className={cx(imageStyles, 'archival-image-loading-underlay')} aria-hidden="true">
          <ArchivalPlateGlyph compact={fallbackCompact} />
        </span>
      )}
      <img
        ref={imgRef}
        src={status.src}
        alt={alt}
        loading={effectiveLoading}
        decoding={decoding}
        fetchPriority={fetchPriority}
        draggable={draggable}
        width={width}
        height={height}
        sizes={sizes}
        style={style}
        className={joinClasses(
          cx(imageStyles, status.kind === 'loaded' ? 'archival-image-el is-loaded' : 'archival-image-el'),
          className
        )}
        onLoad={(event) => {
          markLoaded();
          onLoad?.(event);
        }}
        onError={(event) => {
          markError();
          onError?.(event);
        }}
      />
    </span>
  );
};
