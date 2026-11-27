import type { ArchiveEvent, MediaItem, Person, Place, Pronunciation, SourceRecord } from '@kinloom/core';
import { extractNarrativeCitations } from '@kinloom/core';
import type React from 'react';
import { useMemo } from 'react';
import { useOptionalArchiveData } from '../context/ArchiveDataContext.js';
import { cx } from '../lib/cx.js';
import markdownStyles from './ArchivalMarkdown.module.css';
import { CitationPopover } from './CitationPopover.js';
import {
  defaultResolveMediaUrl,
  type InlineCitationRenderContext,
  renderInlineMarkdownNodes,
} from './markdown/archivalInlineRenderer.js';
import {
  buildEntityRenderContext,
  type InlineEntityRenderContext,
  parseMarkdownBlocks,
} from './markdown/archivalMarkdownParser.js';
import { useCitationPopover } from './markdown/useCitationPopover.js';
import { hasPronunciationContent } from './PronunciationBadge.js';

export { formatNarrativeDateSpan, parseMarkdownBlocks } from './markdown/archivalMarkdownParser.js';

export interface ArchivalMarkdownProps {
  markdown: string;
  className?: string;
  sourcesById?: ReadonlyMap<string, SourceRecord>;
  mediaItems?: readonly MediaItem[];
  events?: readonly ArchiveEvent[];
  subjectPersonId?: string;
  peopleById?: ReadonlyMap<string, Person>;
  placesById?: ReadonlyMap<string, Place>;
  pronunciations?: Readonly<Record<string, Pronunciation>>;
  linkedPersonIds?: readonly string[];
  linkedPlaceIds?: readonly string[];
  baseUrl?: string;
  onInspectSource?: (sourceId: string) => void;
  onOpenMedia?: (media: MediaItem) => void;
  resolveMediaUrl?: (media: MediaItem) => string | null;
}

export const ArchivalMarkdown: React.FC<ArchivalMarkdownProps> = ({
  markdown,
  className,
  sourcesById,
  mediaItems,
  events,
  subjectPersonId,
  peopleById,
  placesById,
  pronunciations: pronunciationsProp,
  linkedPersonIds,
  linkedPlaceIds,
  baseUrl,
  onInspectSource,
  onOpenMedia,
  resolveMediaUrl,
}) => {
  const archiveData = useOptionalArchiveData();
  const effectivePronunciations = pronunciationsProp ?? archiveData?.pronunciations;
  const blocks = useMemo(() => parseMarkdownBlocks(markdown), [markdown]);
  const extractedCitations = useMemo(
    () => (sourcesById ? extractNarrativeCitations(markdown, { knownSourceIds: sourcesById }) : null),
    [markdown, sourcesById]
  );

  const {
    popoverId,
    popoverRef,
    activePopover,
    clearCloseTimer,
    closePopover,
    scheduleClose,
    handleTriggerHover,
    handleTriggerLeave,
    handleTriggerFocus,
    handleTriggerBlur,
    handlePopoverBlur,
    handleTriggerClick,
  } = useCitationPopover();

  const citationCtx: InlineCitationRenderContext | undefined = useMemo(() => {
    if (!sourcesById || !extractedCitations) {
      return undefined;
    }
    return {
      sourcesById,
      numberBySourceId: extractedCitations.numberBySourceId,
      mediaItems,
      events,
      subjectPersonId,
      resolveMediaUrl: resolveMediaUrl ?? defaultResolveMediaUrl,
      activeKey: activePopover?.occurrenceKey ?? null,
      popoverId,
      onTriggerHover: handleTriggerHover,
      onTriggerLeave: handleTriggerLeave,
      onTriggerFocus: handleTriggerFocus,
      onTriggerBlur: handleTriggerBlur,
      onTriggerClick: handleTriggerClick,
    };
  }, [
    sourcesById,
    extractedCitations,
    mediaItems,
    events,
    subjectPersonId,
    resolveMediaUrl,
    activePopover?.occurrenceKey,
    popoverId,
    handleTriggerHover,
    handleTriggerLeave,
    handleTriggerFocus,
    handleTriggerBlur,
    handleTriggerClick,
  ]);

  const entityCtx: InlineEntityRenderContext | undefined = useMemo(
    () =>
      buildEntityRenderContext({
        peopleById,
        placesById,
        pronunciations: effectivePronunciations,
        linkedPersonIds,
        linkedPlaceIds,
        subjectPersonId,
        baseUrl,
        hasPronunciation: hasPronunciationContent,
      }),
    [
      peopleById,
      placesById,
      effectivePronunciations,
      linkedPersonIds,
      linkedPlaceIds,
      subjectPersonId,
      baseUrl,
    ]
  );

  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className={cx(markdownStyles, className ? `archival-markdown ${className}` : 'archival-markdown')}>
      {blocks.map((block, idx) => {
        const blockKey = `b-${idx}`;
        switch (block.kind) {
          case 'heading':
            return block.level === 3 ? (
              <h4 key={blockKey} className={cx(markdownStyles, 'archival-md-heading')}>
                {renderInlineMarkdownNodes(block.text, blockKey, citationCtx)}
              </h4>
            ) : (
              <h5 key={blockKey} className={cx(markdownStyles, 'archival-md-subheading')}>
                {renderInlineMarkdownNodes(block.text, blockKey, citationCtx)}
              </h5>
            );
          case 'blockquote':
            return (
              <blockquote key={blockKey} className={cx(markdownStyles, 'archival-md-quote')}>
                {renderInlineMarkdownNodes(block.text, blockKey, citationCtx, entityCtx, new Set())}
              </blockquote>
            );
          case 'list':
            return block.ordered ? (
              <ol key={blockKey} className={cx(markdownStyles, 'archival-md-list')}>
                {block.items.map((item, itemIdx) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: markdown list items have no stable ID beyond block+index
                  <li key={`${blockKey}-li-${itemIdx}`}>
                    {renderInlineMarkdownNodes(
                      item,
                      `${blockKey}-li-${itemIdx}`,
                      citationCtx,
                      entityCtx,
                      new Set()
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={blockKey} className={cx(markdownStyles, 'archival-md-list')}>
                {block.items.map((item, itemIdx) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: markdown list items have no stable ID beyond block+index
                  <li key={`${blockKey}-li-${itemIdx}`}>
                    {renderInlineMarkdownNodes(
                      item,
                      `${blockKey}-li-${itemIdx}`,
                      citationCtx,
                      entityCtx,
                      new Set()
                    )}
                  </li>
                ))}
              </ul>
            );
          case 'paragraph':
            return (
              <p key={blockKey} className={cx(markdownStyles, 'archival-md-p')}>
                {renderInlineMarkdownNodes(block.text, blockKey, citationCtx, entityCtx, new Set())}
              </p>
            );
          default: {
            const _exhaustive: never = block;
            return _exhaustive;
          }
        }
      })}

      {activePopover && (
        <CitationPopover
          id={popoverId}
          footnoteNumber={activePopover.footnoteNumber}
          source={activePopover.source}
          media={activePopover.media}
          mediaUrl={activePopover.mediaUrl}
          anchorEl={activePopover.anchorEl}
          popoverRef={popoverRef}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={() => {
            scheduleClose(activePopover.occurrenceKey);
          }}
          onBlur={handlePopoverBlur}
          onClose={closePopover}
          onInspectSource={onInspectSource}
          onOpenMedia={onOpenMedia}
        />
      )}
    </div>
  );
};
