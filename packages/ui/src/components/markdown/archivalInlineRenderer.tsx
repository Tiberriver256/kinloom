import type { ArchiveEvent, MediaItem, SourceRecord } from '@kinloom/core';
import { formatPublicCitation, resolveCitationMedia } from '@kinloom/core';
import type React from 'react';
import { cx } from '../../lib/cx.js';
import markdownStyles from '../ArchivalMarkdown.module.css';
import { resolveAssetUrl } from '../atoms/formatters.js';
import { InlineEntityMention } from '../InlineEntityMention.js';
import {
  createInlineMarkdownTokenRegex,
  type InlineEntityRenderContext,
  isSafeLinkHref,
} from './archivalMarkdownParser.js';

export interface InlineCitationPayload {
  occurrenceKey: string;
  footnoteNumber: number;
  source: SourceRecord;
  media: MediaItem | null;
  mediaUrl: string | null;
}

export interface InlineCitationRenderContext {
  sourcesById?: ReadonlyMap<string, SourceRecord>;
  numberBySourceId: ReadonlyMap<string, number>;
  mediaItems?: readonly MediaItem[];
  events?: readonly ArchiveEvent[];
  subjectPersonId?: string;
  resolveMediaUrl: (media: MediaItem) => string | null;
  activeKey: string | null;
  highlightedSourceId?: string | null;
  popoverId: string;
  onHoverSourceId?: (sourceId: string | null) => void;
  onTriggerHover: (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => void;
  onTriggerLeave: (occurrenceKey: string) => void;
  onTriggerFocus: (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => void;
  onTriggerBlur: (event: React.FocusEvent<HTMLButtonElement>) => void;
  onTriggerClick: (payload: InlineCitationPayload, anchorEl: HTMLButtonElement) => void;
}

export function defaultResolveMediaUrl(media: MediaItem): string | null {
  const resolved = resolveAssetUrl(media.thumb_file || media.file);
  return resolved || null;
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

export function renderInlineMarkdownNodes(
  text: string,
  keyPrefix: string,
  citationCtx?: InlineCitationRenderContext,
  entityCtx?: InlineEntityRenderContext,
  seenAutoEntities?: Set<string>
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe = createInlineMarkdownTokenRegex();

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
        <strong key={key}>
          {renderInlineMarkdownNodes(content, key, citationCtx, entityCtx, seenAutoEntities)}
        </strong>
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
        const isMarginaliaHighlighted =
          citationCtx.highlightedSourceId !== null &&
          citationCtx.highlightedSourceId !== undefined &&
          citationCtx.highlightedSourceId === sourceId;

        nodes.push(
          <sup key={key} className={cx(markdownStyles, 'archival-footnote-sup')}>
            <button
              type="button"
              data-citation-source-id={sourceId}
              className={cx(
                markdownStyles,
                `archival-footnote-ref${isActive ? ' is-active' : ''}${isMarginaliaHighlighted ? ' is-marginalia-highlighted' : ''}`
              )}
              aria-label={`Source citation ${footnoteNumber}: ${formatPublicCitation(source.citation)}`}
              aria-expanded={isActive}
              aria-controls={isActive ? citationCtx.popoverId : undefined}
              aria-haspopup="dialog"
              onMouseEnter={(e) => {
                citationCtx.onHoverSourceId?.(sourceId);
                citationCtx.onTriggerHover(payload, e.currentTarget);
              }}
              onMouseLeave={() => {
                citationCtx.onHoverSourceId?.(null);
                citationCtx.onTriggerLeave(key);
              }}
              onFocus={(e) => {
                citationCtx.onHoverSourceId?.(sourceId);
                citationCtx.onTriggerFocus(payload, e.currentTarget);
              }}
              onBlur={(e) => {
                citationCtx.onHoverSourceId?.(null);
                citationCtx.onTriggerBlur(e);
              }}
              onClick={(e) => {
                e.stopPropagation();
                citationCtx.onHoverSourceId?.(sourceId);
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
            className={cx(markdownStyles, 'archival-md-link')}
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
        <em key={key}>{renderInlineMarkdownNodes(content, key, citationCtx, entityCtx, seenAutoEntities)}</em>
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
