import type { ArchiveEvent, MediaItem, Person, Place, Pronunciation, SourceRecord } from '@kinloom/core';
import {
  extractNarrativeCitations,
  formatPublicCitation,
  resolveCitationMedia,
  resolvePlacePronunciation,
} from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useOptionalArchiveData } from '../context/ArchiveDataContext.js';
import { cx } from '../lib/cx.js';
import cssMod0 from '../pages/PersonPage.module.css';
import { resolveAssetUrl } from './Atoms.js';
import { CitationPopover } from './CitationPopover.js';
import { InlineEntityMention } from './InlineEntityMention.js';
import { hasPronunciationContent } from './PronunciationBadge.js';

const uiStyles = cssMod0;

type MarkdownBlock =
  | { kind: 'heading'; level: 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'blockquote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

const SAFE_LINK_PATTERN = /^(https?:\/\/|\/(?!\/))/i;
const POPOVER_CLOSE_DELAY_MS = 150;

function isSafeLinkHref(href: string): boolean {
  return SAFE_LINK_PATTERN.test(href.trim());
}

interface ActiveCitationPopover {
  occurrenceKey: string;
  footnoteNumber: number;
  source: SourceRecord;
  media: MediaItem | null;
  mediaUrl: string | null;
  anchorEl: HTMLButtonElement;
  triggerMode: 'hover' | 'focus' | 'pinned';
}

interface InlineCitationPayload {
  occurrenceKey: string;
  footnoteNumber: number;
  source: SourceRecord;
  media: MediaItem | null;
  mediaUrl: string | null;
}

interface InlineCitationRenderContext {
  sourcesById?: ReadonlyMap<string, SourceRecord>;
  numberBySourceId: ReadonlyMap<string, number>;
  mediaItems?: readonly MediaItem[];
  events?: readonly ArchiveEvent[];
  subjectPersonId?: string;
  resolveMediaUrl: (media: MediaItem) => string | null;
  activeKey: string | null;
  popoverId: string;
  onTriggerHover: (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => void;
  onTriggerLeave: (occurrenceKey: string) => void;
  onTriggerFocus: (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => void;
  onTriggerBlur: (event: React.FocusEvent<HTMLButtonElement>) => void;
  onTriggerClick: (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => void;
}

type AutoEntityTarget =
  | { kind: 'person'; key: string; person: Person }
  | { kind: 'place'; key: string; place: Place };

interface InlineEntityRenderContext {
  peopleById?: ReadonlyMap<string, Person>;
  placesById?: ReadonlyMap<string, Place>;
  pronunciations?: Readonly<Record<string, Pronunciation>>;
  baseUrl?: string;
  autoRegex: RegExp | null;
  autoTargetsByText: ReadonlyMap<string, AutoEntityTarget>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildEntityRenderContext(params: {
  peopleById?: ReadonlyMap<string, Person>;
  placesById?: ReadonlyMap<string, Place>;
  pronunciations?: Readonly<Record<string, Pronunciation>>;
  linkedPersonIds?: readonly string[];
  linkedPlaceIds?: readonly string[];
  subjectPersonId?: string;
  baseUrl?: string;
}): InlineEntityRenderContext | undefined {
  const {
    peopleById,
    placesById,
    pronunciations,
    linkedPersonIds,
    linkedPlaceIds,
    subjectPersonId,
    baseUrl,
  } = params;
  if (!peopleById && !placesById) {
    return undefined;
  }

  const candidates: { text: string; target: AutoEntityTarget }[] = [];
  const seenText = new Set<string>();

  const addCandidate = (rawText: string | undefined, target: AutoEntityTarget): void => {
    const trimmed = rawText?.trim();
    if (!trimmed || trimmed.length < 2) {
      return;
    }
    if (seenText.has(trimmed)) {
      return;
    }
    seenText.add(trimmed);
    candidates.push({ text: trimmed, target });
  };

  if (placesById) {
    const candidatePlaceIds = new Set<string>(linkedPlaceIds ?? []);
    for (const [id, place] of placesById) {
      if (hasPronunciationContent(resolvePlacePronunciation(place, pronunciations))) {
        candidatePlaceIds.add(id);
      }
    }
    for (const id of candidatePlaceIds) {
      const place = placesById.get(id);
      if (!place) {
        continue;
      }
      const target: AutoEntityTarget = { kind: 'place', key: `place:${place.id}`, place };
      addCandidate(place.full_name, target);
      addCandidate(place.name, target);
    }
  }

  if (peopleById && linkedPersonIds) {
    for (const id of linkedPersonIds) {
      if (subjectPersonId && id === subjectPersonId) {
        continue;
      }
      const person = peopleById.get(id);
      if (!person || person.is_living || person.full_name === 'Living') {
        continue;
      }
      const target: AutoEntityTarget = { kind: 'person', key: `person:${person.id}`, person };
      addCandidate(person.full_name, target);
    }
  }

  candidates.sort((a, b) => b.text.length - a.text.length);

  const autoTargetsByText = new Map<string, AutoEntityTarget>();
  for (const item of candidates) {
    autoTargetsByText.set(item.text, item.target);
  }

  const autoRegex =
    candidates.length > 0
      ? new RegExp(
          `(?<![\\p{L}\\p{N}_])(${candidates.map((c) => escapeRegExp(c.text)).join('|')})(?![\\p{L}\\p{N}_])`,
          'gu'
        )
      : null;

  return {
    peopleById,
    placesById,
    pronunciations,
    baseUrl,
    autoRegex,
    autoTargetsByText,
  };
}

function renderPlainProseWithEntities(
  slice: string,
  keyPrefix: string,
  entityCtx?: InlineEntityRenderContext,
  seenAutoEntities?: Set<string>
): React.ReactNode[] {
  if (!slice || !entityCtx?.autoRegex) {
    return slice ? [slice] : [];
  }

  const out: React.ReactNode[] = [];
  const regex = new RegExp(entityCtx.autoRegex.source, 'gu');
  let lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(slice);
  let matchIdx = 0;

  while (match !== null) {
    if (match.index > lastIndex) {
      out.push(slice.slice(lastIndex, match.index));
    }
    const matchedText = match[1];
    const target = entityCtx.autoTargetsByText.get(matchedText);
    if (target && !seenAutoEntities?.has(target.key)) {
      seenAutoEntities?.add(target.key);
      const key = `${keyPrefix}-ae-${matchIdx}`;
      matchIdx += 1;
      if (target.kind === 'person') {
        out.push(
          <InlineEntityMention
            key={key}
            kind="person"
            person={target.person}
            displayText={matchedText}
            baseUrl={entityCtx.baseUrl}
            pronunciations={entityCtx.pronunciations}
          />
        );
      } else {
        out.push(
          <InlineEntityMention
            key={key}
            kind="place"
            place={target.place}
            displayText={matchedText}
            baseUrl={entityCtx.baseUrl}
            pronunciations={entityCtx.pronunciations}
          />
        );
      }
    } else {
      out.push(match[0]);
    }

    lastIndex = match.index + match[0].length;
    match = regex.exec(slice);
  }

  if (lastIndex < slice.length) {
    out.push(slice.slice(lastIndex));
  }

  return out;
}

function defaultResolveMediaUrl(media: MediaItem): string | null {
  const resolved = resolveAssetUrl(media.thumb_file || media.file);
  return resolved || null;
}

function parseInlineNodes(
  text: string,
  keyPrefix: string,
  citationCtx?: InlineCitationRenderContext,
  entityCtx?: InlineEntityRenderContext,
  seenAutoEntities?: Set<string>
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe =
    /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[\^([A-Za-z0-9._:-]+)(?:\|([A-Za-z0-9._:-]+))?\]|\[\[(person|place):([A-Za-z0-9._:-]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*|(?<!\w)_([^_]+)_(?!\w))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null = tokenRe.exec(text);
  let tokenIdx = 0;

  while (match !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        ...renderPlainProseWithEntities(
          text.slice(lastIndex, match.index),
          `${keyPrefix}-p-${tokenIdx}`,
          entityCtx,
          seenAutoEntities
        )
      );
    }

    const key = `${keyPrefix}-${tokenIdx}`;
    tokenIdx += 1;

    if (match[2] !== undefined || match[3] !== undefined) {
      const content = match[2] ?? match[3] ?? '';
      nodes.push(
        <strong key={key}>{parseInlineNodes(content, key, citationCtx, entityCtx, seenAutoEntities)}</strong>
      );
    } else if (match[4] !== undefined) {
      nodes.push(<code key={key}>{match[4]}</code>);
    } else if (match[5] !== undefined) {
      const sourceId = match[5];
      const explicitMediaId = match[6] ?? null;
      const source = citationCtx?.sourcesById?.get(sourceId);
      const footnoteNumber = citationCtx?.numberBySourceId.get(sourceId);

      if (citationCtx && source && footnoteNumber !== undefined) {
        const media = resolveCitationMedia(
          sourceId,
          explicitMediaId,
          citationCtx.mediaItems,
          citationCtx.subjectPersonId,
          citationCtx.events
        );
        const mediaUrl = media ? citationCtx.resolveMediaUrl(media) : null;
        const payload: InlineCitationPayload = {
          occurrenceKey: key,
          footnoteNumber,
          source,
          media,
          mediaUrl,
        };
        const isActive = citationCtx.activeKey === key;

        nodes.push(
          <sup key={key} className={cx(uiStyles, 'archival-footnote-sup')}>
            <button
              type="button"
              className={cx(uiStyles, `archival-footnote-ref${isActive ? ' is-active' : ''}`)}
              aria-label={`Source citation ${footnoteNumber}: ${formatPublicCitation(source.citation)}`}
              aria-expanded={isActive}
              aria-controls={isActive ? citationCtx.popoverId : undefined}
              aria-haspopup="dialog"
              onMouseEnter={(e) => {
                citationCtx.onTriggerHover(payload, e.currentTarget);
              }}
              onMouseLeave={() => {
                citationCtx.onTriggerLeave(key);
              }}
              onFocus={(e) => {
                citationCtx.onTriggerFocus(payload, e.currentTarget);
              }}
              onBlur={(e) => {
                citationCtx.onTriggerBlur(e);
              }}
              onClick={(e) => {
                e.stopPropagation();
                citationCtx.onTriggerClick(payload, e.currentTarget);
              }}
            >
              [{footnoteNumber}]
            </button>
          </sup>
        );
      }
      // Unresolved citation tokens are omitted so raw syntax never appears to readers.
    } else if (match[7] !== undefined && match[8] !== undefined) {
      const entityKind = match[7] as 'person' | 'place';
      const entityId = match[8];
      const explicitLabel = match[9]?.trim() || undefined;

      if (entityKind === 'person') {
        const person = entityCtx?.peopleById?.get(entityId);
        if (person) {
          if (person.is_living || person.full_name === 'Living') {
            nodes.push('Living');
          } else {
            seenAutoEntities?.add(`person:${person.id}`);
            nodes.push(
              <InlineEntityMention
                key={key}
                kind="person"
                person={person}
                displayText={explicitLabel ?? person.full_name}
                baseUrl={entityCtx?.baseUrl}
                pronunciations={entityCtx?.pronunciations}
              />
            );
          }
        } else {
          nodes.push(explicitLabel ?? entityId);
        }
      } else {
        const place = entityCtx?.placesById?.get(entityId);
        if (place) {
          seenAutoEntities?.add(`place:${place.id}`);
          nodes.push(
            <InlineEntityMention
              key={key}
              kind="place"
              place={place}
              displayText={explicitLabel ?? place.name}
              baseUrl={entityCtx?.baseUrl}
              pronunciations={entityCtx?.pronunciations}
            />
          );
        } else {
          nodes.push(explicitLabel ?? entityId);
        }
      }
    } else if (match[10] !== undefined && match[11] !== undefined) {
      const label = match[10];
      const href = match[11].trim();
      if (isSafeLinkHref(href)) {
        const isExternal = /^https?:\/\//i.test(href);
        nodes.push(
          <a
            key={key}
            href={href}
            className={cx(uiStyles, 'archival-md-link')}
            target={isExternal ? '_blank' : undefined}
            rel={isExternal ? 'noopener noreferrer' : undefined}
          >
            {label}
          </a>
        );
      } else {
        nodes.push(label);
      }
    } else if (match[12] !== undefined || match[13] !== undefined) {
      const content = match[12] ?? match[13] ?? '';
      nodes.push(
        <em key={key}>{parseInlineNodes(content, key, citationCtx, entityCtx, seenAutoEntities)}</em>
      );
    } else {
      nodes.push(match[0]);
    }

    lastIndex = match.index + match[0].length;
    match = tokenRe.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(
      ...renderPlainProseWithEntities(text.slice(lastIndex), `${keyPrefix}-tail`, entityCtx, seenAutoEntities)
    );
  }

  return nodes;
}

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length <= 2 ? 3 : 4;
      blocks.push({ kind: 'heading', level, text: headingMatch[2].trim() });
      i += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'blockquote', text: quoteLines.join(' ').trim() });
      continue;
    }

    const unorderedMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (unorderedMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const itemMatch = /^[-*]\s+(.+)$/.exec(lines[i].trim());
        if (!itemMatch) {
          break;
        }
        items.push(itemMatch[1].trim());
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: false, items });
      continue;
    }

    const orderedMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (orderedMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const itemMatch = /^\d+\.\s+(.+)$/.exec(lines[i].trim());
        if (!itemMatch) {
          break;
        }
        items.push(itemMatch[1].trim());
        i += 1;
      }
      blocks.push({ kind: 'list', ordered: true, items });
      continue;
    }

    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const line = lines[i].trim();
      if (
        !line ||
        /^(#{1,6})\s+/.test(line) ||
        line.startsWith('>') ||
        /^[-*]\s+/.test(line) ||
        /^\d+\.\s+/.test(line)
      ) {
        break;
      }
      paragraphLines.push(line);
      i += 1;
    }
    if (paragraphLines.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraphLines.join(' ') });
    }
  }

  return blocks;
}

export function formatNarrativeDateSpan(dateSpan?: string | null): string | null {
  if (!dateSpan) {
    return null;
  }
  const trimmed = dateSpan.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replaceAll('/', '–').replaceAll('~', '');
}

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

  const popoverId = useId();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [activePopover, setActivePopover] = useState<ActiveCitationPopover | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closePopover = useCallback(() => {
    clearCloseTimer();
    setActivePopover(null);
  }, [clearCloseTimer]);

  const scheduleClose = useCallback(
    (expectedKey?: string) => {
      clearCloseTimer();
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null;
        setActivePopover((prev) => {
          if (!prev || prev.triggerMode === 'pinned') {
            return prev;
          }
          if (expectedKey && prev.occurrenceKey !== expectedKey) {
            return prev;
          }
          return null;
        });
      }, POPOVER_CLOSE_DELAY_MS);
    },
    [clearCloseTimer]
  );

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  useEffect(() => {
    if (!activePopover) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        const focusWasInside = Boolean(
          popoverRef.current && document.activeElement && popoverRef.current.contains(document.activeElement)
        );
        const anchor = activePopover.anchorEl;
        closePopover();
        if (focusWasInside) {
          anchor.focus();
        }
      }
    };
    const onOutsidePointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (activePopover.anchorEl.contains(target)) {
        return;
      }
      if (popoverRef.current?.contains(target)) {
        return;
      }
      closePopover();
    };

    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onOutsidePointerDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onOutsidePointerDown);
    };
  }, [activePopover, closePopover]);

  const handleTriggerHover = useCallback(
    (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => {
      clearCloseTimer();
      setActivePopover((prev) => ({
        ...payload,
        anchorEl,
        triggerMode:
          prev && prev.occurrenceKey === payload.occurrenceKey && prev.triggerMode === 'pinned'
            ? 'pinned'
            : 'hover',
      }));
    },
    [clearCloseTimer]
  );

  const handleTriggerLeave = useCallback(
    (occurrenceKey: string) => {
      scheduleClose(occurrenceKey);
    },
    [scheduleClose]
  );

  const handleTriggerFocus = useCallback(
    (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => {
      clearCloseTimer();
      setActivePopover((prev) => ({
        ...payload,
        anchorEl,
        triggerMode:
          prev && prev.occurrenceKey === payload.occurrenceKey && prev.triggerMode === 'pinned'
            ? 'pinned'
            : 'focus',
      }));
    },
    [clearCloseTimer]
  );

  const handleFocusLeavingSurface = useCallback(
    (relatedTarget: EventTarget | null) => {
      if (relatedTarget instanceof Node) {
        if (popoverRef.current?.contains(relatedTarget)) {
          return;
        }
        if (activePopover?.anchorEl.contains(relatedTarget)) {
          return;
        }
      }
      setActivePopover((prev) => (prev && prev.triggerMode === 'focus' ? null : prev));
    },
    [activePopover]
  );

  const handleTriggerBlur = useCallback(
    (event: React.FocusEvent<HTMLButtonElement>) => {
      handleFocusLeavingSurface(event.relatedTarget);
    },
    [handleFocusLeavingSurface]
  );

  const handlePopoverBlur = useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      handleFocusLeavingSurface(event.relatedTarget);
    },
    [handleFocusLeavingSurface]
  );

  const handleTriggerClick = useCallback(
    (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => {
      clearCloseTimer();
      setActivePopover((prev) => {
        if (prev && prev.occurrenceKey === payload.occurrenceKey && prev.triggerMode === 'pinned') {
          return null;
        }
        return {
          ...payload,
          anchorEl,
          triggerMode: 'pinned',
        };
      });
    },
    [clearCloseTimer]
  );

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
    <div className={cx(uiStyles, className ? `archival-markdown ${className}` : 'archival-markdown')}>
      {blocks.map((block, idx) => {
        const blockKey = `b-${idx}`;
        switch (block.kind) {
          case 'heading':
            return block.level === 3 ? (
              <h4 key={blockKey} className={cx(uiStyles, 'archival-md-heading')}>
                {parseInlineNodes(block.text, blockKey, citationCtx)}
              </h4>
            ) : (
              <h5 key={blockKey} className={cx(uiStyles, 'archival-md-subheading')}>
                {parseInlineNodes(block.text, blockKey, citationCtx)}
              </h5>
            );
          case 'blockquote':
            return (
              <blockquote key={blockKey} className={cx(uiStyles, 'archival-md-quote')}>
                {parseInlineNodes(block.text, blockKey, citationCtx, entityCtx, new Set())}
              </blockquote>
            );
          case 'list':
            return block.ordered ? (
              <ol key={blockKey} className={cx(uiStyles, 'archival-md-list')}>
                {block.items.map((item, itemIdx) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: markdown list items have no stable ID beyond block+index
                  <li key={`${blockKey}-li-${itemIdx}`}>
                    {parseInlineNodes(item, `${blockKey}-li-${itemIdx}`, citationCtx, entityCtx, new Set())}
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={blockKey} className={cx(uiStyles, 'archival-md-list')}>
                {block.items.map((item, itemIdx) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: markdown list items have no stable ID beyond block+index
                  <li key={`${blockKey}-li-${itemIdx}`}>
                    {parseInlineNodes(item, `${blockKey}-li-${itemIdx}`, citationCtx, entityCtx, new Set())}
                  </li>
                ))}
              </ul>
            );
          case 'paragraph':
            return (
              <p key={blockKey} className={cx(uiStyles, 'archival-md-p')}>
                {parseInlineNodes(block.text, blockKey, citationCtx, entityCtx, new Set())}
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
