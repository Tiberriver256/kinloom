import type React from 'react';
import { cx, joinClasses } from '../lib/cx.js';
import layoutStyles from '../styles/Layout.module.css';
import atomStyles from './Atoms.module.css';
import mediaGalleryStyles from './MediaGallery.module.css';
import milestoneStyles from './MilestoneStoryCard.module.css';

export interface ArchivalPageShellProps extends React.HTMLAttributes<HTMLElement> {
  /** Use `'wide'` for 1180px folio/index pages and `'standard'` (default) for 1100px reading pages. */
  readonly variant?: 'standard' | 'wide';
}

export const ArchivalPageShell: React.FC<ArchivalPageShellProps> = ({
  variant = 'standard',
  id = 'main-content',
  className,
  children,
  ...rest
}) => (
  <main
    id={id}
    className={joinClasses(cx(layoutStyles, variant === 'wide' ? 'index-page' : 'place-page'), className)}
    {...rest}
  >
    {children}
  </main>
);

export type ArchivalBannerProps = React.HTMLAttributes<HTMLElement>;

export const ArchivalBanner: React.FC<ArchivalBannerProps> = ({ className, children, ...rest }) => (
  <section className={joinClasses(cx(layoutStyles, 'wire-banner'), className)} {...rest}>
    {children}
  </section>
);

export type ArchivalMetricsProps = React.HTMLAttributes<HTMLDivElement>;

export const ArchivalMetrics: React.FC<ArchivalMetricsProps> = ({ className, children, ...rest }) => (
  <div className={joinClasses(cx(atomStyles, 'folio-metrics'), className)} {...rest}>
    {children}
  </div>
);

export type ArchivalSectionProps = React.HTMLAttributes<HTMLElement>;

export const ArchivalSection: React.FC<ArchivalSectionProps> = ({ className, children, ...rest }) => (
  <section className={joinClasses(cx(layoutStyles, 'place-map-box'), className)} {...rest}>
    {children}
  </section>
);

export type ArchivalMediaGridProps = React.HTMLAttributes<HTMLDivElement>;

export const ArchivalMediaGrid: React.FC<ArchivalMediaGridProps> = ({ className, children, ...rest }) => (
  <div className={joinClasses(cx(mediaGalleryStyles, 'person-media-grid'), className)} {...rest}>
    {children}
  </div>
);

export type ArchivalStoryCardProps = React.HTMLAttributes<HTMLElement>;

export const ArchivalStoryCard: React.FC<ArchivalStoryCardProps> = ({ className, children, ...rest }) => (
  <article className={joinClasses(cx(milestoneStyles, 'story-card'), className)} {...rest}>
    {children}
  </article>
);
