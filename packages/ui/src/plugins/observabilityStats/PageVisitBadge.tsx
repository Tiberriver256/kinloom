import type React from 'react';
import { useEffect, useState } from 'react';
import { cx } from '../../lib/cx.js';
import { formatVisitBadgeLabel } from '../../lib/observabilityStatsModel.js';
import styles from './ObservabilityStats.module.css';
import { useObservabilityStatsContext } from './ObservabilityStatsContext.js';

export interface PageVisitBadgeProps {
  readonly entityKind: 'person' | 'place' | 'narrative';
  readonly entitySlug: string;
}

/**
 * Subtle archival metadata counter displaying aggregate page views when enabled by the archive admin.
 * Renders null when badges are disabled, while loading, or when the server omits counts (e.g. 404).
 */
export const PageVisitBadge: React.FC<PageVisitBadgeProps> = ({ entityKind, entitySlug }) => {
  const { client, showPublicBadges } = useObservabilityStatsContext();
  const [totalViews, setTotalViews] = useState<number | null>(null);

  useEffect(() => {
    if (!showPublicBadges || !entitySlug) {
      setTotalViews(null);
      return;
    }

    const controller = new AbortController();
    let active = true;

    void client
      .getPublicPageVisitCount({ kind: entityKind, slug: entitySlug }, { signal: controller.signal })
      .then((result) => {
        if (!active) {
          return;
        }
        setTotalViews(result ? result.total_views : null);
      })
      .catch(() => {
        if (active) {
          setTotalViews(null);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [client, showPublicBadges, entityKind, entitySlug]);

  if (!showPublicBadges || totalViews === null) {
    return null;
  }

  return (
    <span
      className={cx(styles, 'obs-visit-badge')}
      data-testid={`page-visit-badge-${entityKind}`}
      title={`Archive record views: ${formatVisitBadgeLabel(totalViews)}`}
    >
      <span className={cx(styles, 'obs-visit-badge-dot')} aria-hidden="true" />
      <span>{formatVisitBadgeLabel(totalViews)}</span>
    </span>
  );
};
