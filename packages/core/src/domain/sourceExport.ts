import type { ReadingDocument } from '../schemas/entities.js';

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) {
    return '';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${Math.round(kb)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === 45) {
    end -= 1;
  }
  return value.slice(start, end);
}

export function buildSourceTextFilename(doc: ReadingDocument): string {
  const slug = trimDashes(doc.title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'));
  return `${slug || doc.source_id}.txt`;
}

export function buildFullSourceText(doc: ReadingDocument): string {
  const header = [doc.title, `Author: ${doc.author}`, `Pages: ${doc.pages.length}`, ''];
  const sections = doc.pages.map((page) => `=== ${page.label} ===\n\n${page.text.trim()}`);
  return `${header.join('\n')}\n${sections.join('\n\n')}\n`;
}

export function buildAllSourcesText(docs: readonly ReadingDocument[]): string {
  const divider = '\n\n========================================================================\n\n';
  return `${docs.map((doc) => buildFullSourceText(doc).trim()).join(divider)}\n`;
}
