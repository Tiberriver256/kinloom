import type { StoryManifestEntry } from '@kinloom/core';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArchivalEmptyState } from '../../components/ArchivalPrimitives.js';
import { ExplorerTopBar } from '../../components/ExplorerTopBar.js';
import { KinloomFooter } from '../../components/KinloomFooter.js';
import { cx } from '../../lib/cx.js';
import {
  filterStorySummaries,
  formatStoryDurationLabel,
  formatStoryFormatLabel,
  type StoryFormatFilter,
} from '../../lib/storiesModel.js';
import styles from './Stories.module.css';
import { useStoriesPlugin } from './StoriesContext.js';

const FORMAT_FILTERS: readonly { readonly value: StoryFormatFilter; readonly label: string }[] = [
  { value: 'all', label: 'All Formats' },
  { value: 'documentary', label: 'Documentary' },
  { value: 'scroll', label: 'Scroll Story' },
  { value: 'map', label: 'Journey Map' },
];

export const StoriesIndexPage: React.FC = () => {
  const { client, basePath, pageTitle, pageDescription } = useStoriesPlugin();
  const [stories, setStories] = useState<readonly StoryManifestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFormat, setActiveFormat] = useState<StoryFormatFilter>('all');

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    void client
      .listStories({ signal: controller.signal })
      .then((items) => {
        if (!cancelled) {
          setStories(items);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStories([]);
          setLoading(false);
        }
      });
    return (): void => {
      cancelled = true;
      controller.abort();
    };
  }, [client]);

  const filtered = useMemo(
    () => filterStorySummaries(stories, { format: activeFormat }),
    [stories, activeFormat]
  );

  return (
    <div>
      <ExplorerTopBar />
      <main className={cx(styles, 'stories-page')}>
        <header className={cx(styles, 'stories-header')}>
          <h1 className={cx(styles, 'stories-title')}>{pageTitle}</h1>
          <p className={cx(styles, 'stories-subtitle')}>{pageDescription}</p>
        </header>

        <div className={cx(styles, 'stories-filter-row')} role="group" aria-label="Filter stories by format">
          {FORMAT_FILTERS.map((item) => {
            const active = activeFormat === item.value;
            return (
              <button
                key={item.value}
                type="button"
                aria-pressed={active}
                onClick={() => setActiveFormat(item.value)}
                className={cx(
                  styles,
                  active ? 'stories-filter-btn stories-filter-btn-active' : 'stories-filter-btn'
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        {loading ? (
          <p className={cx(styles, 'stories-subtitle')}>Loading specialty stories…</p>
        ) : filtered.length === 0 ? (
          <ArchivalEmptyState
            title="No specialty stories found"
            description={
              activeFormat === 'all'
                ? 'Publish a documentary, scroll chapter, or journey map with `kinloom stories publish` to display it here.'
                : `No ${formatStoryFormatLabel(activeFormat)} stories have been published yet.`
            }
          />
        ) : (
          <div className={cx(styles, 'story-slot-grid')}>
            {filtered.map((story) => {
              const duration = formatStoryDurationLabel(story.durationMs);
              const metaParts = [
                `${story.beatCount} ${story.beatCount === 1 ? 'beat' : 'beats'}`,
                duration || undefined,
                `${story.citationCount} ${story.citationCount === 1 ? 'source' : 'sources'}`,
              ].filter(Boolean);
              return (
                <Link
                  key={story.id}
                  to={`${basePath}/${encodeURIComponent(story.slug)}`}
                  className={cx(styles, 'story-card')}
                >
                  <span className={cx(styles, 'story-card-top')}>
                    <span className={cx(styles, 'story-format-badge')}>
                      {formatStoryFormatLabel(story.format)}
                    </span>
                    <span className={cx(styles, 'story-meta')}>{metaParts.join(' · ')}</span>
                  </span>
                  <span className={cx(styles, 'story-card-title')}>{story.title}</span>
                  <p className={cx(styles, 'story-card-summary')}>{story.summary}</p>
                  <span className={cx(styles, 'story-card-cta')}>
                    {story.personName ? `About ${story.personName} · Open →` : 'Open story →'}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </main>
      <KinloomFooter />
    </div>
  );
};
