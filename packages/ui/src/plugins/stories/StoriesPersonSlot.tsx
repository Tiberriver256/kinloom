import type { Person, StoryManifestEntry } from '@kinloom/core';
import type React from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArchivalSection } from '../../components/ArchivalLayout.js';
import { cx } from '../../lib/cx.js';
import { formatStoryDurationLabel, formatStoryFormatLabel } from '../../lib/storiesModel.js';
import styles from './Stories.module.css';
import { useStoriesPlugin } from './StoriesContext.js';

export interface StoriesPersonSlotProps {
  readonly person: Person;
}

/**
 * PersonPage `personDetail` slot rendering a compact "Specialty Stories" shelf for an individual.
 * Hides cleanly (`null`) when the individual is living or has zero published stories.
 */
export const StoriesPersonSlot: React.FC<StoriesPersonSlotProps> = ({ person }) => {
  const { client, basePath } = useStoriesPlugin();
  const [stories, setStories] = useState<readonly StoryManifestEntry[]>([]);
  const isLiving = person.is_living || person.full_name === 'Living';

  useEffect(() => {
    if (isLiving) {
      setStories([]);
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    void client
      .listStories({ personId: person.id, signal: controller.signal })
      .then((items) => {
        if (!cancelled) {
          setStories(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStories([]);
        }
      });
    return (): void => {
      cancelled = true;
      controller.abort();
    };
  }, [client, person.id, isLiving]);

  if (isLiving || stories.length === 0) {
    return null;
  }

  return (
    <ArchivalSection aria-labelledby="person-specialty-stories-heading">
      <div className={cx(styles, 'story-slot-header')}>
        <h2 id="person-specialty-stories-heading" className={cx(styles, 'story-slot-heading')}>
          Specialty Stories
        </h2>
        <Link to={basePath} className={cx(styles, 'story-slot-all-link')}>
          Browse all stories →
        </Link>
      </div>
      <div className={cx(styles, 'story-slot-grid')}>
        {stories.map((story) => {
          const duration = formatStoryDurationLabel(story.durationMs);
          const metaParts = [
            `${story.beatCount} ${story.beatCount === 1 ? 'beat' : 'beats'}`,
            duration || undefined,
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
              <span className={cx(styles, 'story-card-cta')}>Launch story →</span>
            </Link>
          );
        })}
      </div>
    </ArchivalSection>
  );
};
