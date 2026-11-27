import type { ArchiveBundle, MediaItem, Narrative, Person, Place, SourceRecord } from '@kinloom/core';
import { formatPublicCitation, orderNarrativeSources } from '@kinloom/core';
import type React from 'react';
import { ArchivalMarkdown, formatNarrativeDateSpan } from '../../components/ArchivalMarkdown.js';
import { cx } from '../../lib/cx.js';
import { PluginSlot } from '../../plugins/PluginContext.js';
import narrativeStyles from './PersonNarratives.module.css';

export interface PersonNarrativesSectionProps {
  readonly variant: 'biography' | 'familyStories';
  readonly sectionId: string;
  readonly heading: string;
  readonly narratives: readonly Narrative[];
  readonly showAll: boolean;
  readonly onToggleShowAll: () => void;
  readonly expandedNarrativeIds: ReadonlySet<string>;
  readonly expandedSourceNarrativeIds: ReadonlySet<string>;
  readonly onToggleNarrativeBody: (narrativeId: string) => void;
  readonly onToggleNarrativeSources: (narrativeId: string) => void;
  readonly person: Person;
  readonly bundle: ArchiveBundle;
  readonly peopleById: ReadonlyMap<string, Person>;
  readonly placesById: ReadonlyMap<string, Place>;
  readonly sourcesById: ReadonlyMap<string, SourceRecord>;
  readonly baseUrl?: string;
  readonly uiStyles: Readonly<Record<string, string>>;
  readonly onInspectSource: (sourceId: string) => void;
  readonly onOpenMedia: (media: MediaItem) => void;
  readonly resolveMediaUrl: (media: MediaItem) => string | null;
}

export const PersonNarrativesSection: React.FC<PersonNarrativesSectionProps> = ({
  variant,
  sectionId,
  heading,
  narratives,
  showAll,
  onToggleShowAll,
  expandedNarrativeIds,
  expandedSourceNarrativeIds,
  onToggleNarrativeBody,
  onToggleNarrativeSources,
  person,
  bundle,
  peopleById,
  placesById,
  sourcesById,
  baseUrl,
  uiStyles,
  onInspectSource,
  onOpenMedia,
  resolveMediaUrl,
}) => {
  if (narratives.length === 0) {
    return null;
  }

  const mergedStyles: Readonly<Record<string, string>> = { ...uiStyles, ...narrativeStyles };
  const isBiography = variant === 'biography';
  const collapsedLimit = isBiography ? 1 : 3;
  const visibleItems = showAll ? narratives : narratives.slice(0, collapsedLimit);
  const hiddenCount = narratives.length - collapsedLimit;

  return (
    <section
      id={sectionId}
      className={cx(
        mergedStyles,
        isBiography ? 'person-biography-section' : 'person-biography-section person-family-stories-section'
      )}
      aria-label={heading}
    >
      <div className={cx(mergedStyles, 'person-biography-header')}>
        <h2>{heading}</h2>
        {narratives.length > 1 && (
          <span className={cx(mergedStyles, 'person-biography-count')}>
            {narratives.length} {isBiography ? 'biographies' : 'stories'}
          </span>
        )}
      </div>

      <div className={cx(mergedStyles, 'person-biography-list')}>
        {visibleItems.map((narrative) => {
          const isLong = isBiography ? narrative.body_md.trim().length > 560 : true;
          const isExpanded = expandedNarrativeIds.has(narrative.id);
          const sourcesOpen = expandedSourceNarrativeIds.has(narrative.id);
          const dateLabel = formatNarrativeDateSpan(narrative.date_edtf);
          const orderedSources = orderNarrativeSources(
            narrative.body_md,
            narrative.source_ids ?? [],
            sourcesById
          );

          return (
            <article
              key={narrative.id}
              className={cx(
                mergedStyles,
                isBiography ? 'person-biography-entry' : 'person-biography-entry person-family-story-entry'
              )}
            >
              <div className={cx(mergedStyles, 'person-biography-entry-head')}>
                <h3>{narrative.title}</h3>
                {dateLabel && !narrative.title.includes(dateLabel) && (
                  <span className={cx(mergedStyles, 'person-biography-date')}>{dateLabel}</span>
                )}
              </div>

              {narrative.summary && (
                <p className={cx(mergedStyles, 'person-biography-summary')}>{narrative.summary}</p>
              )}

              <PluginSlot name="narrativeHeader" person={person} narrative={narrative} />

              {(isBiography || isExpanded) && (
                <div
                  className={cx(
                    mergedStyles,
                    isBiography
                      ? `person-biography-body ${isLong && !isExpanded ? 'is-collapsed' : ''}`
                      : 'person-biography-body'
                  )}
                >
                  <ArchivalMarkdown
                    markdown={narrative.body_md}
                    sourcesById={sourcesById}
                    mediaItems={bundle.media}
                    events={bundle.events}
                    subjectPersonId={person.id}
                    peopleById={peopleById}
                    placesById={placesById}
                    linkedPersonIds={narrative.person_ids}
                    linkedPlaceIds={narrative.place_ids}
                    baseUrl={baseUrl}
                    onInspectSource={onInspectSource}
                    onOpenMedia={onOpenMedia}
                    resolveMediaUrl={resolveMediaUrl}
                  />
                </div>
              )}

              {(!isBiography || isLong || orderedSources.length > 0) && (
                <div className={cx(mergedStyles, 'person-biography-actions print-hide')}>
                  {(!isBiography || isLong) && (
                    <button
                      type="button"
                      className={cx(mergedStyles, 'ink-inline-btn person-biography-toggle')}
                      aria-expanded={isExpanded}
                      onClick={() => {
                        onToggleNarrativeBody(narrative.id);
                      }}
                    >
                      {isBiography
                        ? isExpanded
                          ? 'Show less'
                          : 'Read full biography'
                        : isExpanded
                          ? 'Hide story'
                          : 'Read story'}
                    </button>
                  )}

                  {orderedSources.length > 0 && (
                    <button
                      type="button"
                      className={cx(mergedStyles, 'person-biography-sources-toggle')}
                      aria-expanded={sourcesOpen}
                      onClick={() => {
                        onToggleNarrativeSources(narrative.id);
                      }}
                    >
                      <span>Sources ({orderedSources.length})</span>
                      <span className={cx(mergedStyles, 'person-biography-chevron')} aria-hidden="true">
                        {sourcesOpen ? '▾' : '▸'}
                      </span>
                    </button>
                  )}
                </div>
              )}

              {orderedSources.length > 0 && (
                <div
                  className={cx(
                    mergedStyles,
                    `person-biography-sources${sourcesOpen ? '' : ' is-collapsed-screen'}`
                  )}
                >
                  <ul className={cx(mergedStyles, 'person-biography-source-list')}>
                    {orderedSources.map(({ source: src, footnoteNumber }) => (
                      <li key={src.id}>
                        <button
                          type="button"
                          className={cx(mergedStyles, 'person-biography-source-btn')}
                          onClick={() => {
                            onInspectSource(src.id);
                          }}
                        >
                          {footnoteNumber !== null && (
                            <span className={cx(mergedStyles, 'person-biography-source-num')}>
                              [{footnoteNumber}]
                            </span>
                          )}
                          <span className={cx(mergedStyles, 'person-biography-source-text')}>
                            {formatPublicCitation(src.citation)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {hiddenCount > 0 && (
        <div className={cx(mergedStyles, 'person-biography-more-wrap print-hide')}>
          <button
            type="button"
            className={cx(mergedStyles, 'pill-btn')}
            aria-expanded={showAll}
            onClick={onToggleShowAll}
          >
            {isBiography
              ? showAll
                ? 'Show fewer biographies'
                : `Read ${hiddenCount} more ${hiddenCount === 1 ? 'biography' : 'biographies'}`
              : showAll
                ? 'Show fewer family stories'
                : `Show ${hiddenCount} more family ${hiddenCount === 1 ? 'story' : 'stories'}`}
          </button>
        </div>
      )}
    </section>
  );
};
