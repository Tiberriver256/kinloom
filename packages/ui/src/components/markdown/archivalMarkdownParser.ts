import type { Person, Place, Pronunciation } from '@kinloom/core';
import { resolvePlacePronunciation } from '@kinloom/core';

export type MarkdownBlock =
  | { kind: 'heading'; level: 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'blockquote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

export type AutoEntityTarget =
  | { kind: 'person'; key: string; person: Person }
  | { kind: 'place'; key: string; place: Place };

export interface InlineEntityRenderContext {
  peopleById?: ReadonlyMap<string, Person> | undefined;
  placesById?: ReadonlyMap<string, Place> | undefined;
  pronunciations?: Readonly<Record<string, Pronunciation>> | undefined;
  baseUrl?: string | undefined;
  autoRegex: RegExp | null;
  autoTargetsByText: ReadonlyMap<string, AutoEntityTarget>;
}

const SAFE_LINK_PATTERN = /^(https?:\/\/|\/(?!\/))/i;

const INLINE_MARKDOWN_TOKEN_TEMPLATE =
  /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[\^([A-Za-z0-9._:-]+)(?:\|([A-Za-z0-9._:-]+))?\]|\[\[(person|place):([A-Za-z0-9._:-]+)(?:\|([^\]]+))?\]\]|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*|(?<!\w)_([^_]+)_(?!\w))/g;

export function createInlineMarkdownTokenRegex(): RegExp {
  return new RegExp(INLINE_MARKDOWN_TOKEN_TEMPLATE.source, 'g');
}

export function isSafeLinkHref(href: string): boolean {
  return SAFE_LINK_PATTERN.test(href.trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildEntityRenderContext(params: {
  peopleById?: ReadonlyMap<string, Person> | undefined;
  placesById?: ReadonlyMap<string, Place> | undefined;
  pronunciations?: Readonly<Record<string, Pronunciation>> | undefined;
  linkedPersonIds?: readonly string[] | undefined;
  linkedPlaceIds?: readonly string[] | undefined;
  subjectPersonId?: string | undefined;
  baseUrl?: string | undefined;
  hasPronunciation: (entry: Pronunciation | null) => boolean;
}): InlineEntityRenderContext | undefined {
  const {
    peopleById,
    placesById,
    pronunciations,
    linkedPersonIds,
    linkedPlaceIds,
    subjectPersonId,
    baseUrl,
    hasPronunciation,
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
      if (hasPronunciation(resolvePlacePronunciation(place, pronunciations))) {
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

export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i] ?? '';
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      const level = headingMatch[1].length <= 2 ? 3 : 4;
      blocks.push({ kind: 'heading', level, text: headingMatch[2].trim() });
      i += 1;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        quoteLines.push((lines[i] ?? '').trim().replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ kind: 'blockquote', text: quoteLines.join(' ').trim() });
      continue;
    }

    const unorderedMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (unorderedMatch) {
      const items: string[] = [];
      while (i < lines.length) {
        const itemMatch = /^[-*]\s+(.+)$/.exec((lines[i] ?? '').trim());
        if (!itemMatch || !itemMatch[1]) {
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
        const itemMatch = /^\d+\.\s+(.+)$/.exec((lines[i] ?? '').trim());
        if (!itemMatch || !itemMatch[1]) {
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
      const line = (lines[i] ?? '').trim();
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
