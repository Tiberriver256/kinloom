import React from 'react';

type MarkdownBlock =
  | { kind: 'heading'; level: 3 | 4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'blockquote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

const SAFE_LINK_PATTERN = /^(https?:\/\/|\/(?!\/))/i;

function isSafeLinkHref(href: string): boolean {
  return SAFE_LINK_PATTERN.test(href.trim());
}

function parseInlineNodes(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRe =
    /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*|(?<!\w)_([^_]+)_(?!\w))/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null = tokenRe.exec(text);
  let tokenIdx = 0;

  while (match !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const key = `${keyPrefix}-${tokenIdx}`;
    tokenIdx += 1;

    if (match[2] !== undefined || match[3] !== undefined) {
      const content = match[2] ?? match[3] ?? '';
      nodes.push(<strong key={key}>{parseInlineNodes(content, key)}</strong>);
    } else if (match[4] !== undefined) {
      nodes.push(<code key={key}>{match[4]}</code>);
    } else if (match[5] !== undefined && match[6] !== undefined) {
      const label = match[5];
      const href = match[6].trim();
      if (isSafeLinkHref(href)) {
        const isExternal = /^https?:\/\//i.test(href);
        nodes.push(
          <a
            key={key}
            href={href}
            className="archival-md-link"
            target={isExternal ? '_blank' : undefined}
            rel={isExternal ? 'noopener noreferrer' : undefined}
          >
            {label}
          </a>,
        );
      } else {
        nodes.push(label);
      }
    } else if (match[7] !== undefined || match[8] !== undefined) {
      const content = match[7] ?? match[8] ?? '';
      nodes.push(<em key={key}>{parseInlineNodes(content, key)}</em>);
    } else {
      nodes.push(match[0]);
    }

    lastIndex = match.index + match[0].length;
    match = tokenRe.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
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
}

export const ArchivalMarkdown: React.FC<ArchivalMarkdownProps> = ({ markdown, className }) => {
  const blocks = parseMarkdownBlocks(markdown);
  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className={className ? `archival-markdown ${className}` : 'archival-markdown'}>
      {blocks.map((block, idx) => {
        const blockKey = `b-${idx}`;
        switch (block.kind) {
          case 'heading':
            return block.level === 3 ? (
              <h4 key={blockKey} className="archival-md-heading">
                {parseInlineNodes(block.text, blockKey)}
              </h4>
            ) : (
              <h5 key={blockKey} className="archival-md-subheading">
                {parseInlineNodes(block.text, blockKey)}
              </h5>
            );
          case 'blockquote':
            return (
              <blockquote key={blockKey} className="archival-md-quote">
                {parseInlineNodes(block.text, blockKey)}
              </blockquote>
            );
          case 'list':
            return block.ordered ? (
              <ol key={blockKey} className="archival-md-list">
                {block.items.map((item, itemIdx) => (
                  <li key={`${blockKey}-li-${itemIdx}`}>
                    {parseInlineNodes(item, `${blockKey}-li-${itemIdx}`)}
                  </li>
                ))}
              </ol>
            ) : (
              <ul key={blockKey} className="archival-md-list">
                {block.items.map((item, itemIdx) => (
                  <li key={`${blockKey}-li-${itemIdx}`}>
                    {parseInlineNodes(item, `${blockKey}-li-${itemIdx}`)}
                  </li>
                ))}
              </ul>
            );
          case 'paragraph':
            return (
              <p key={blockKey} className="archival-md-p">
                {parseInlineNodes(block.text, blockKey)}
              </p>
            );
          default: {
            const _exhaustive: never = block;
            return _exhaustive;
          }
        }
      })}
    </div>
  );
};
