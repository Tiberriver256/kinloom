import type { ArchiveEvent, MediaItem, Person, Place, Pronunciation, SourceRecord } from '@kinloom/core';
import { extractNarrativeCitations, resolveCitationMedia } from '@kinloom/core';
import type React from 'react';
import { useMemo, useState } from 'react';
import { useOptionalArchiveData } from '../context/ArchiveDataContext.js';
import { cx } from '../lib/cx.js';
import { type FolioMarginaliaCitation, partitionMarkdownBlockMarginalia } from '../lib/marginaliaModel.js';
import marginaliaStyles from '../styles/FolioMarginalia.module.css';
import markdownStyles from './ArchivalMarkdown.module.css';
import { CitationPopover } from './CitationPopover.js';
import { FolioMarginaliaRail } from './FolioMarginalia.js';
import {
  defaultResolveMediaUrl,
  type InlineCitationRenderContext,
  renderInlineMarkdownNodes,
} from './markdown/archivalInlineRenderer.js';
import {
  buildEntityRenderContext,
  type InlineEntityRenderContext,
  type MarkdownBlock,
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
  narrativeSourceIds?: readonly string[];
  readableSourceIds?: ReadonlySet<string>;
  marginaliaMode?: 'off' | 'folio';
  baseUrl?: string;
  onInspectSource?: (sourceId: string) => void;
  onReadSource?: (sourceId: string) => void;
  onOpenMedia?: (media: MediaItem) => void;
  resolveMediaUrl?: (media: MediaItem) => string | null;
}

const EMPTY_READABLE_IDS: ReadonlySet<string> = new Set();
const EMPTY_SOURCE_IDS: readonly string[] = [];

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
  narrativeSourceIds = EMPTY_SOURCE_IDS,
  readableSourceIds: readableSourceIdsProp,
  marginaliaMode = 'off',
  baseUrl,
  onInspectSource,
  onReadSource,
  onOpenMedia,
  resolveMediaUrl,
}) => {
  const archiveData = useOptionalArchiveData();
  const effectivePronunciations = pronunciationsProp ?? archiveData?.pronunciations;
  const effectiveReadableSourceIds =
    readableSourceIdsProp ?? archiveData?.readableSourceIds ?? EMPTY_READABLE_IDS;
  const [hoveredSourceId, setHoveredSourceId] = useState<string | null>(null);
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

  const highlightedSourceId = hoveredSourceId ?? activePopover?.source.id ?? null;

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
      highlightedSourceId,
      popoverId,
      onHoverSourceId: setHoveredSourceId,
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
    highlightedSourceId,
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

  const partitionedMarginalia = useMemo(() => {
    if (marginaliaMode !== 'folio' || !sourcesById || !extractedCitations) {
      return null;
    }
    const partitioned = partitionMarkdownBlockMarginalia({
      blocks,
      extractedCitations,
      narrativeSourceIds,
      sourcesById,
      readableSourceIds: effectiveReadableSourceIds,
      mediaItems,
      events,
      subjectPersonId,
      resolveScanUrl: resolveMediaUrl ?? defaultResolveMediaUrl,
    });
    const hasAnyCitations =
      partitioned.byBlockIndex.some((list) => list.length > 0) || partitioned.trailingCitations.length > 0;
    return hasAnyCitations ? partitioned : null;
  }, [
    marginaliaMode,
    sourcesById,
    extractedCitations,
    blocks,
    narrativeSourceIds,
    effectiveReadableSourceIds,
    mediaItems,
    events,
    subjectPersonId,
    resolveMediaUrl,
  ]);

  if (blocks.length === 0) {
    return null;
  }

  const renderBlockContent = (block: MarkdownBlock, blockKey: string): React.ReactNode => {
    switch (block.kind) {
      case 'heading':
        return block.level === 3 ? (
          <h4 className={cx(markdownStyles, 'archival-md-heading')}>
            {renderInlineMarkdownNodes(block.text, blockKey, citationCtx)}
          </h4>
        ) : (
          <h5 className={cx(markdownStyles, 'archival-md-subheading')}>
            {renderInlineMarkdownNodes(block.text, blockKey, citationCtx)}
          </h5>
        );
      case 'blockquote':
        return (
          <blockquote className={cx(markdownStyles, 'archival-md-quote')}>
            {renderInlineMarkdownNodes(block.text, blockKey, citationCtx, entityCtx, new Set())}
          </blockquote>
        );
      case 'list':
        return block.ordered ? (
          <ol className={cx(markdownStyles, 'archival-md-list')}>
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
          <ul className={cx(markdownStyles, 'archival-md-list')}>
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
          <p className={cx(markdownStyles, 'archival-md-p')}>
            {renderInlineMarkdownNodes(block.text, blockKey, citationCtx, entityCtx, new Set())}
          </p>
        );
      default: {
        const _exhaustive: never = block;
        return _exhaustive;
      }
    }
  };

  const handleOpenMarginaliaScan = onOpenMedia
    ? (item: FolioMarginaliaCitation): void => {
        const media = resolveCitationMedia(item.sourceId, null, mediaItems, subjectPersonId, events);
        if (media) {
          onOpenMedia(media);
        } else if (onInspectSource) {
          onInspectSource(item.sourceId);
        }
      }
    : undefined;

  return (
    <div className={cx(markdownStyles, className ? `archival-markdown ${className}` : 'archival-markdown')}>
      {blocks.map((block, idx) => {
        const blockKey = `b-${idx}`;
        const content = renderBlockContent(block, blockKey);
        if (!partitionedMarginalia) {
          return <div key={blockKey}>{content}</div>;
        }
        const isLastBlock = idx === blocks.length - 1;
        const rowCitations: readonly FolioMarginaliaCitation[] = isLastBlock
          ? [...(partitionedMarginalia.byBlockIndex[idx] ?? []), ...partitionedMarginalia.trailingCitations]
          : (partitionedMarginalia.byBlockIndex[idx] ?? []);

        return (
          <div key={blockKey} className={cx(marginaliaStyles, 'folio-marginalia-row')}>
            <div className={cx(marginaliaStyles, 'folio-marginalia-main')}>{content}</div>
            {rowCitations.length > 0 ? (
              <FolioMarginaliaRail
                items={rowCitations}
                ariaLabel={`Citations for paragraph ${idx + 1}`}
                highlightedSourceId={highlightedSourceId}
                onHoverSourceId={setHoveredSourceId}
                onInspectCitation={
                  onInspectSource
                    ? (item) => {
                        onInspectSource(item.sourceId);
                      }
                    : undefined
                }
                onReadSource={onReadSource}
                onOpenScan={handleOpenMarginaliaScan}
              />
            ) : (
              <div className={cx(marginaliaStyles, 'folio-marginalia-rail-empty')} aria-hidden="true" />
            )}
          </div>
        );
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
