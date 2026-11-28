import type React from 'react';
import { cx, joinClasses } from '../../lib/cx.js';
import { useArchivalImageStatus } from './ArchivalImage.js';
import { initialsOf, resolveAssetUrl } from './formatters.js';
import portraitStyles from './PersonPortrait.module.css';

export type PersonPortraitVariant = 'print' | 'circle';
export type PersonPortraitSize = 'xs' | 'sm' | 'md' | 'card' | 'lg';

export interface PersonPortraitProps {
  readonly name: string;
  readonly src?: string | null | undefined;
  readonly baseUrl?: string | undefined;
  /** Accessible alt text. Leave empty string when parent link/card already labels the person. */
  readonly alt?: string | undefined;
  readonly variant?: PersonPortraitVariant | undefined;
  readonly size?: PersonPortraitSize | undefined;
  readonly loading?: 'eager' | 'lazy' | undefined;
  readonly fetchPriority?: 'high' | 'low' | undefined;
  readonly selected?: boolean | undefined;
  readonly decorative?: boolean | undefined;
  readonly className?: string | undefined;
  readonly style?: React.CSSProperties | undefined;
  readonly imgClassName?: string | undefined;
  readonly onLoad?: React.ReactEventHandler<HTMLImageElement> | undefined;
  readonly onError?: React.ReactEventHandler<HTMLImageElement> | undefined;
}

export const PersonPortrait: React.FC<PersonPortraitProps> = ({
  name,
  src,
  baseUrl,
  alt = '',
  variant = 'print',
  size = 'md',
  loading = 'lazy',
  fetchPriority,
  selected = false,
  decorative = alt === '',
  className,
  style,
  imgClassName,
  onLoad,
  onError,
}) => {
  const resolvedSrc = baseUrl !== undefined ? resolveAssetUrl(src, baseUrl) : (src?.trim() ?? '');
  const { status, imgRef, markLoaded, markError } = useArchivalImageStatus(resolvedSrc);
  const initials = initialsOf(name);
  const effectiveLoading: 'eager' | 'lazy' = fetchPriority === 'high' ? 'eager' : loading;
  const showImage = status.kind === 'loading' || status.kind === 'loaded';

  const frameClasses = joinClasses(
    cx(portraitStyles, `person-portrait variant-${variant} size-${size}${selected ? ' is-selected' : ''}`),
    className
  );

  const innerContent = (
    <span className={cx(portraitStyles, 'person-portrait-inner')}>
      <span className={cx(portraitStyles, 'person-portrait-monogram')} aria-hidden="true">
        {initials}
      </span>
      {showImage && (
        <img
          ref={imgRef}
          src={status.src}
          alt={alt}
          loading={effectiveLoading}
          decoding="async"
          fetchPriority={fetchPriority}
          className={joinClasses(
            cx(
              portraitStyles,
              status.kind === 'loaded' ? 'person-portrait-img is-loaded' : 'person-portrait-img'
            ),
            imgClassName
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
      )}
    </span>
  );

  if (!decorative && !showImage && alt) {
    return (
      <span
        className={frameClasses}
        style={style}
        data-portrait-status={status.kind}
        role="img"
        aria-label={alt}
      >
        {innerContent}
      </span>
    );
  }

  return (
    <span
      className={frameClasses}
      style={style}
      data-portrait-status={status.kind}
      aria-hidden={decorative ? 'true' : undefined}
    >
      {innerContent}
    </span>
  );
};
