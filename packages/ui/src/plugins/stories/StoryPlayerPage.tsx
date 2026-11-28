import type { DocumentaryStory, MapStory, ScrollStory, SpecialtyStory, StoryCitation } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArchivalEmptyState } from '../../components/ArchivalPrimitives.js';
import { ExplorerTopBar } from '../../components/ExplorerTopBar.js';
import { KinloomFooter } from '../../components/KinloomFooter.js';
import { cx } from '../../lib/cx.js';
import {
  clampBeatIndex,
  formatStoryDurationLabel,
  formatStoryFormatLabel,
  projectMapStops,
  resolveActiveWordIndex,
  resolveDocumentaryBeatAtTime,
} from '../../lib/storiesModel.js';
import styles from './Stories.module.css';
import { useStoriesPlugin } from './StoriesContext.js';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false
  );
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    mq.addEventListener?.('change', onChange);
    return (): void => {
      mq.removeEventListener?.('change', onChange);
    };
  }, []);
  return reduced;
}

const BeatCitationPills: React.FC<{
  readonly citationIds: readonly string[];
  readonly citationsById: ReadonlyMap<string, StoryCitation>;
}> = ({ citationIds, citationsById }) => {
  const resolved = citationIds
    .map((id) => citationsById.get(id))
    .filter((c): c is StoryCitation => c !== undefined);
  if (resolved.length === 0) {
    return null;
  }
  return (
    <div className={cx(styles, 'beat-citation-row')}>
      {resolved.map((c) => (
        <span key={c.id} className={cx(styles, 'beat-citation-pill')}>
          {c.label}
        </span>
      ))}
    </div>
  );
};

const StoryCitationsFooter: React.FC<{ readonly citations: readonly StoryCitation[] }> = ({ citations }) => {
  if (citations.length === 0) {
    return null;
  }
  return (
    <section className={cx(styles, 'citations-panel')} aria-labelledby="story-citations-heading">
      <h2 id="story-citations-heading" className={cx(styles, 'citations-heading')}>
        Sources &amp; Citations
      </h2>
      <ol className={cx(styles, 'citations-list')}>
        {citations.map((c) => (
          <li key={c.id}>
            <strong>{c.label}</strong>
            {c.detail ? ` — ${c.detail}` : ''}
            {c.url ? (
              <>
                {' '}
                <a
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cx(styles, 'citation-link')}
                >
                  View source
                </a>
              </>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
};

const DocumentaryPlayer: React.FC<{
  readonly story: DocumentaryStory;
  readonly citationsById: ReadonlyMap<string, StoryCitation>;
}> = ({ story, citationsById }) => {
  const reducedMotion = usePrefersReducedMotion();
  const [beatIndex, setBeatIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [elapsedMs, setElapsedMs] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const activeBeat = story.beats[beatIndex] ?? story.beats[0];
  const isPortrait = story.aspectRatio === '9:16';

  const selectBeat = useCallback(
    (nextIndex: number) => {
      const clamped = clampBeatIndex(nextIndex, story.beats.length);
      setBeatIndex(clamped);
      const target = story.beats[clamped];
      if (target) {
        setElapsedMs(target.startMs);
        if (audioRef.current) {
          audioRef.current.currentTime = target.startMs / 1000;
        }
      }
    },
    [story.beats]
  );

  const togglePlay = useCallback(() => {
    setPlaying((prev) => {
      const next = !prev;
      if (audioRef.current) {
        if (next) {
          void audioRef.current.play().catch(() => {});
        } else {
          audioRef.current.pause();
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!playing || story.audio || !activeBeat) {
      return undefined;
    }
    const delay = reducedMotion ? Math.max(activeBeat.durationMs, 3000) : activeBeat.durationMs;
    const timer = window.setTimeout(() => {
      if (beatIndex < story.beats.length - 1) {
        selectBeat(beatIndex + 1);
      } else {
        setPlaying(false);
      }
    }, delay);
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [playing, beatIndex, activeBeat, story.beats.length, story.audio, reducedMotion, selectBeat]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (event.key === ' ' || event.code === 'Space') {
        event.preventDefault();
        togglePlay();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        selectBeat(beatIndex + 1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        selectBeat(beatIndex - 1);
      } else if (event.key.toLowerCase() === 'c') {
        event.preventDefault();
        setCaptionsVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [beatIndex, selectBeat, togglePlay]);

  if (!activeBeat) {
    return null;
  }

  const wordTimestamps = activeBeat.wordTimestamps ?? story.audio?.wordTimestamps;
  const activeWordIdx = resolveActiveWordIndex(wordTimestamps, elapsedMs);

  return (
    <div className={cx(styles, 'doc-stage-wrap')}>
      <section
        aria-label={`Documentary stage: ${activeBeat.title}`}
        className={cx(styles, isPortrait ? 'doc-stage doc-stage-portrait' : 'doc-stage')}
      >
        <div className={cx(styles, 'doc-stage-header')}>
          <span className={cx(styles, 'story-format-badge')}>
            Beat {beatIndex + 1} / {story.beats.length}
          </span>
          <span className={cx(styles, 'story-meta')}>
            {[activeBeat.dateLabel, activeBeat.placeLabel, formatStoryDurationLabel(activeBeat.durationMs)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>

        <div className={cx(styles, 'doc-stage-body')}>
          {activeBeat.media ? (
            <img
              src={activeBeat.media.asset}
              alt={activeBeat.media.alt}
              className={cx(styles, 'doc-stage-media')}
            />
          ) : null}
          <h2 className={cx(styles, 'doc-stage-beat-title')}>{activeBeat.title}</h2>
          <p className={cx(styles, 'doc-stage-narration')}>
            {wordTimestamps && wordTimestamps.length > 0
              ? wordTimestamps.map((w, idx) => (
                  <span
                    key={`${w.word}-${w.startMs}`}
                    className={idx === activeWordIdx ? cx(styles, 'doc-word-active') : undefined}
                  >
                    {w.word}
                    {idx < wordTimestamps.length - 1 ? ' ' : ''}
                  </span>
                ))
              : activeBeat.narration}
          </p>
          <BeatCitationPills citationIds={activeBeat.citationIds} citationsById={citationsById} />
        </div>

        {captionsVisible ? (
          <div className={cx(styles, 'doc-caption-bar')} role="status" aria-live="polite">
            {activeBeat.caption}
          </div>
        ) : null}
      </section>

      {story.audio ? (
        <audio
          ref={audioRef}
          src={story.audio.asset}
          onTimeUpdate={(e) => {
            const ms = Math.round(e.currentTarget.currentTime * 1000);
            setElapsedMs(ms);
            const nextIdx = resolveDocumentaryBeatAtTime(story, ms);
            if (nextIdx !== beatIndex) {
              setBeatIndex(nextIdx);
            }
          }}
          onEnded={() => setPlaying(false)}
        />
      ) : null}

      <div className={cx(styles, 'doc-controls')} role="toolbar" aria-label="Documentary playback controls">
        <button
          type="button"
          onClick={togglePlay}
          className={cx(styles, 'player-btn player-btn-primary')}
          aria-pressed={playing}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          onClick={() => selectBeat(beatIndex - 1)}
          disabled={beatIndex === 0}
          className={cx(styles, 'player-btn')}
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => selectBeat(beatIndex + 1)}
          disabled={beatIndex === story.beats.length - 1}
          className={cx(styles, 'player-btn')}
        >
          Next
        </button>
        <div className={cx(styles, 'doc-scrubber')} role="group" aria-label="Beat timeline">
          {story.beats.map((beat, idx) => (
            <button
              key={beat.id}
              type="button"
              onClick={() => selectBeat(idx)}
              aria-label={`Jump to beat ${idx + 1}: ${beat.title}`}
              aria-current={idx === beatIndex ? 'step' : undefined}
              className={cx(
                styles,
                idx === beatIndex ? 'doc-scrub-segment doc-scrub-segment-active' : 'doc-scrub-segment'
              )}
            >
              {idx + 1}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setCaptionsVisible((v) => !v)}
          aria-pressed={captionsVisible}
          className={cx(styles, 'player-btn')}
        >
          {captionsVisible ? 'Hide Captions' : 'Show Captions'}
        </button>
      </div>
    </div>
  );
};

const ScrollStoryPlayer: React.FC<{
  readonly story: ScrollStory;
  readonly citationsById: ReadonlyMap<string, StoryCitation>;
}> = ({ story, citationsById }) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const beatRefs = useRef<Array<HTMLElement | null>>([]);
  const activeBeat = story.beats[activeIndex] ?? story.beats[0];

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const idxAttr = entry.target.getAttribute('data-beat-index');
            const parsed = idxAttr ? Number.parseInt(idxAttr, 10) : Number.NaN;
            if (!Number.isNaN(parsed)) {
              setActiveIndex(clampBeatIndex(parsed, story.beats.length));
            }
          }
        }
      },
      { threshold: 0.5 }
    );
    for (const el of beatRefs.current) {
      if (el) {
        observer.observe(el);
      }
    }
    return (): void => {
      observer.disconnect();
    };
  }, [story.beats.length]);

  if (!activeBeat) {
    return null;
  }

  return (
    <div className={cx(styles, 'scroll-layout')}>
      <div className={cx(styles, 'scroll-column')}>
        {story.beats.map((beat, idx) => {
          const isActive = idx === activeIndex;
          return (
            <article
              key={beat.id}
              ref={(el) => {
                beatRefs.current[idx] = el;
              }}
              data-beat-index={idx}
              aria-current={isActive ? 'step' : undefined}
              className={cx(
                styles,
                isActive ? 'scroll-beat-card scroll-beat-card-active' : 'scroll-beat-card'
              )}
            >
              <div className={cx(styles, 'story-card-top')}>
                <span className={cx(styles, 'story-meta')}>
                  {[`Step ${idx + 1} / ${story.beats.length}`, beat.dateLabel, beat.placeLabel]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <button
                  type="button"
                  onClick={() => setActiveIndex(idx)}
                  onFocus={() => setActiveIndex(idx)}
                  aria-pressed={isActive}
                  className={cx(styles, 'player-btn')}
                >
                  {isActive ? 'Viewing' : 'Focus'}
                </button>
              </div>
              <h2 className={cx(styles, 'doc-stage-beat-title')}>{beat.title}</h2>
              <p className={cx(styles, 'story-card-summary')}>{beat.body}</p>
              {beat.pullQuote ? (
                <blockquote className={cx(styles, 'scroll-pullquote')}>{beat.pullQuote}</blockquote>
              ) : null}
              <BeatCitationPills citationIds={beat.citationIds} citationsById={citationsById} />
            </article>
          );
        })}
      </div>

      <aside className={cx(styles, 'scroll-sticky-stage')} aria-label="Synchronized visual stage">
        <span className={cx(styles, 'story-format-badge')}>
          Active Chapter · {activeIndex + 1} / {story.beats.length}
        </span>
        {activeBeat.media ? (
          <img
            src={activeBeat.media.asset}
            alt={activeBeat.media.alt}
            className={cx(styles, 'doc-stage-media')}
          />
        ) : null}
        <h3 className={cx(styles, 'story-card-title')}>{activeBeat.title}</h3>
        <div className={cx(styles, 'doc-caption-bar')}>{activeBeat.caption}</div>
      </aside>
    </div>
  );
};

const MapJourneyPlayer: React.FC<{
  readonly story: MapStory;
  readonly citationsById: ReadonlyMap<string, StoryCitation>;
}> = ({ story, citationsById }) => {
  const [stopIndex, setStopIndex] = useState(0);
  const projected = useMemo(() => projectMapStops(story.beats, 640, 360, 52), [story.beats]);
  const activeStop = story.beats[stopIndex] ?? story.beats[0];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setStopIndex((idx) => clampBeatIndex(idx + 1, story.beats.length));
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setStopIndex((idx) => clampBeatIndex(idx - 1, story.beats.length));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [story.beats.length]);

  if (!activeStop) {
    return null;
  }

  const pathPoints = projected.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <div className={cx(styles, 'map-layout')}>
      <div className={cx(styles, 'map-canvas-card')}>
        <svg
          viewBox="0 0 640 360"
          role="img"
          aria-label={`Chronological route map for ${story.title}`}
          className={cx(styles, 'map-svg')}
        >
          {projected.length > 1 ? (
            <polyline points={pathPoints} className={cx(styles, 'map-route-line')} />
          ) : null}
          {projected.map((pt) => {
            const active = pt.index === stopIndex;
            return (
              <g key={pt.stop.id}>
                <circle
                  cx={pt.x}
                  cy={pt.y}
                  r={active ? 10 : 7}
                  role="button"
                  tabIndex={0}
                  aria-label={`Stop ${pt.index + 1}: ${pt.stop.year} ${pt.stop.placeLabel}`}
                  className={cx(styles, active ? 'map-stop-pin map-stop-pin-active' : 'map-stop-pin')}
                  onClick={() => setStopIndex(pt.index)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setStopIndex(pt.index);
                    }
                  }}
                >
                  <title>{`${pt.stop.year}: ${pt.stop.placeLabel}`}</title>
                </circle>
                <text x={pt.x + 12} y={pt.y + 4} className={cx(styles, 'map-stop-label')}>
                  {pt.stop.year} · {pt.stop.placeLabel}
                </text>
              </g>
            );
          })}
        </svg>

        <div className={cx(styles, 'map-stepper')} role="group" aria-label="Chronological stops">
          <button
            type="button"
            disabled={stopIndex === 0}
            onClick={() => setStopIndex((i) => clampBeatIndex(i - 1, story.beats.length))}
            className={cx(styles, 'player-btn')}
          >
            Previous Stop
          </button>
          {story.beats.map((stop, idx) => (
            <button
              key={stop.id}
              type="button"
              onClick={() => setStopIndex(idx)}
              aria-current={idx === stopIndex ? 'step' : undefined}
              className={cx(styles, idx === stopIndex ? 'player-btn player-btn-primary' : 'player-btn')}
            >
              {stop.year}
            </button>
          ))}
          <button
            type="button"
            disabled={stopIndex === story.beats.length - 1}
            onClick={() => setStopIndex((i) => clampBeatIndex(i + 1, story.beats.length))}
            className={cx(styles, 'player-btn')}
          >
            Next Stop
          </button>
        </div>
      </div>

      <article className={cx(styles, 'map-detail-card')} aria-live="polite">
        <span className={cx(styles, 'story-format-badge')}>
          Stop {stopIndex + 1} / {story.beats.length} · {activeStop.date}
        </span>
        <h2 className={cx(styles, 'doc-stage-beat-title')}>{activeStop.title}</h2>
        <span className={cx(styles, 'story-meta')}>
          {activeStop.placeLabel} ({activeStop.coordinates.lat.toFixed(3)},{' '}
          {activeStop.coordinates.lng.toFixed(3)})
        </span>
        {activeStop.media ? (
          <img
            src={activeStop.media.asset}
            alt={activeStop.media.alt}
            className={cx(styles, 'doc-stage-media')}
          />
        ) : null}
        <p className={cx(styles, 'story-card-summary')}>{activeStop.narrative}</p>
        <div className={cx(styles, 'doc-caption-bar')}>{activeStop.caption}</div>
        <BeatCitationPills citationIds={activeStop.citationIds} citationsById={citationsById} />
      </article>
    </div>
  );
};

export const StoryPlayerPage: React.FC = () => {
  const { slug } = useParams<{ slug: string }>();
  const { client, basePath } = useStoriesPlugin();
  const [story, setStory] = useState<SpecialtyStory | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) {
      setStory(null);
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    void client
      .getStory(slug, { signal: controller.signal })
      .then((loaded) => {
        if (!cancelled) {
          setStory(loaded);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStory(null);
          setLoading(false);
        }
      });
    return (): void => {
      cancelled = true;
      controller.abort();
    };
  }, [client, slug]);

  const citationsById = useMemo(() => new Map((story?.citations ?? []).map((c) => [c.id, c])), [story]);

  return (
    <div>
      <ExplorerTopBar />
      <main className={cx(styles, 'player-shell')}>
        <div className={cx(styles, 'player-topbar')}>
          <Link to={basePath} className={cx(styles, 'player-back-link')}>
            ← All Specialty Stories
          </Link>
          {story ? (
            <span className={cx(styles, 'story-format-badge')}>{formatStoryFormatLabel(story.format)}</span>
          ) : null}
        </div>

        {loading ? (
          <p className={cx(styles, 'player-summary')}>Loading story…</p>
        ) : !story ? (
          <ArchivalEmptyState
            title="Story not found"
            description="The requested specialty story could not be located in this archive."
          />
        ) : (
          <>
            <header className={cx(styles, 'player-header')}>
              <h1 className={cx(styles, 'player-title')}>{story.title}</h1>
              <p className={cx(styles, 'player-summary')}>{story.summary}</p>
            </header>

            {story.format === 'documentary' ? (
              <DocumentaryPlayer story={story} citationsById={citationsById} />
            ) : story.format === 'scroll' ? (
              <ScrollStoryPlayer story={story} citationsById={citationsById} />
            ) : (
              <MapJourneyPlayer story={story} citationsById={citationsById} />
            )}

            <StoryCitationsFooter citations={story.citations} />
          </>
        )}
      </main>
      <KinloomFooter />
    </div>
  );
};
