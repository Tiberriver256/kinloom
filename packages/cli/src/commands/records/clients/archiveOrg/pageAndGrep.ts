import { CliValidationError } from '../../../../errors.js';
import { RecordRuntimeError } from '../../runtime/types.js';
import {
  DEFAULT_FIELDS,
  type GrepHit,
  itemUrl,
  PAGE_BATCH_LIMIT,
  type PageIndex,
  pageDetailsUrl,
  pageImageUrl,
} from './types.js';

function resolveSegmentPage(
  segIdx: number,
  pageIndex: PageIndex
): readonly [number | null, number | null, string | null] {
  const mode = pageIndex.segment_mode || 'scandata';
  if (mode === 'flat') {
    return [null, null, null];
  }
  const key = String(segIdx);
  if (mode === 'bookreader') {
    const b2s = pageIndex.bookreader_to_scandata ?? {};
    const b2p = pageIndex.bookreader_to_printed ?? {};
    const scandataLeaf = Object.hasOwn(b2s, key) ? (b2s[key] ?? null) : null;
    const printed = Object.hasOwn(b2p, key) ? (b2p[key] ?? null) : null;
    return [segIdx, scandataLeaf, printed];
  }
  const s2b = pageIndex.scandata_to_bookreader ?? {};
  const s2p = pageIndex.scandata_to_printed ?? {};
  let brN: number | null = Object.hasOwn(s2b, key) ? (s2b[key] ?? null) : null;
  if (brN === null && Object.keys(s2b).length === 0) {
    brN = segIdx;
  }
  const printed = Object.hasOwn(s2p, key) ? (s2p[key] ?? null) : null;
  return [brN, segIdx, printed];
}

function extractSnippet(
  pageText: string,
  matchStart: number,
  matchEnd: number,
  contextChars: number
): string {
  const half = Math.max(20, Math.floor(contextChars / 2));
  const start = Math.max(0, matchStart - half);
  const end = Math.min(pageText.length, matchEnd + half);
  const raw = pageText.slice(start, end);
  let cleaned = raw.trim().replace(/\s+/g, ' ');
  if (start > 0) {
    cleaned = `...${cleaned}`;
  }
  if (end < pageText.length) {
    cleaned = `${cleaned}...`;
  }
  return cleaned;
}

function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\r') {
      if (i + 1 < text.length && text[i + 1] === '\n') {
        i += 1;
      }
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (ch === '\n') {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

export function grepCachedItem(
  identifier: string,
  djvuText: string,
  pageIndex: PageIndex,
  pattern: string,
  ignoreCase: boolean,
  options: { readonly contextChars: number; readonly limit: number }
): readonly [GrepHit[], number] {
  const testRegex = new RegExp(pattern, ignoreCase ? 'i' : '');
  const iterRegex = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
  const hits: GrepHit[] = [];
  let totalMatches = 0;
  const pages = djvuText.split('\x0c');

  for (let segIdx = 0; segIdx < pages.length; segIdx += 1) {
    const pageText = pages[segIdx];
    if (!pageText || !testRegex.test(pageText)) {
      continue;
    }
    let offset = 0;
    for (const line of splitLinesKeepEnds(pageText)) {
      iterRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = iterRegex.exec(line)) !== null) {
        if (match[0].length === 0) {
          if (iterRegex.lastIndex >= line.length) {
            break;
          }
          iterRegex.lastIndex += 1;
          continue;
        }
        totalMatches += 1;
        if (hits.length < options.limit) {
          const [leafN, scandataLeaf, printedPage] = resolveSegmentPage(segIdx, pageIndex);
          const mStart = offset + match.index;
          const mEnd = mStart + match[0].length;
          hits.push({
            identifier,
            leaf: leafN,
            scandata_leaf: scandataLeaf,
            printed_page: printedPage,
            match: match[0],
            snippet: extractSnippet(pageText, mStart, mEnd, options.contextChars),
            image_url: leafN !== null ? pageImageUrl(identifier, leafN, { scale: 2 }) : null,
            details_url: leafN !== null ? pageDetailsUrl(identifier, leafN) : itemUrl(identifier),
          });
        }
      }
      offset += line.length;
    }
  }

  return [hits, totalMatches];
}

export function resolvePrintedPageToLeaf(
  pageIndex: PageIndex,
  printedPage: string
): readonly [number, number | null] {
  const target = printedPage.trim();
  const p2b = pageIndex.printed_to_bookreader ?? {};
  const b2s = pageIndex.bookreader_to_scandata ?? {};
  if (Object.hasOwn(p2b, target)) {
    const brN = Number(p2b[target]);
    const scLeaf = Object.hasOwn(b2s, String(brN)) ? (b2s[String(brN)] ?? null) : null;
    return [brN, scLeaf];
  }
  const p2bCi = pageIndex.printed_to_bookreader_ci ?? {};
  const lower = target.toLowerCase();
  if (Object.hasOwn(p2bCi, lower)) {
    const brN = Number(p2bCi[lower]);
    const scLeaf = Object.hasOwn(b2s, String(brN)) ? (b2s[String(brN)] ?? null) : null;
    return [brN, scLeaf];
  }
  const p2s = pageIndex.printed_to_scandata ?? {};
  if (Object.hasOwn(p2s, target)) {
    const scLeaf = Number(p2s[target]);
    return [scLeaf, scLeaf];
  }
  const samplePages = Object.keys(p2b);
  const hint =
    samplePages.length > 0
      ? ` (known printed pages: ${samplePages[0]}..${samplePages[samplePages.length - 1]}, total ${samplePages.length})`
      : ' (no printed page numbers in scandata.xml)';
  throw new RecordRuntimeError(`Printed page '${printedPage}' not found in page_index.json${hint}`);
}

export function describeLeaf(
  pageIndex: PageIndex,
  leafN: number
): {
  leaf: number;
  scandata_leaf: number | null;
  printed_page: string | null;
} {
  const key = String(leafN);
  const b2s = pageIndex.bookreader_to_scandata ?? {};
  const b2p = pageIndex.bookreader_to_printed ?? {};
  return {
    leaf: leafN,
    scandata_leaf: Object.hasOwn(b2s, key) ? (b2s[key] ?? null) : null,
    printed_page: Object.hasOwn(b2p, key) ? (b2p[key] ?? null) : null,
  };
}

export function validateLeafInIndex(pageIndex: PageIndex, leafN: number): void {
  if (leafN < 0) {
    throw new RecordRuntimeError(`Leaf index must be >= 0, got ${leafN}.`);
  }
  const accessCount = Number(pageIndex.access_leaf_count || 0);
  if (accessCount > 0 && leafN >= accessCount) {
    throw new RecordRuntimeError(
      `Leaf n${leafN} is out of range (item has ${accessCount} BookReader leaves: n0..n${accessCount - 1}).`
    );
  }
}

export function leafFromScandataLeaf(pageIndex: PageIndex, scandataLeaf: number): number {
  const s2b = pageIndex.scandata_to_bookreader ?? {};
  const key = String(scandataLeaf);
  if (Object.hasOwn(s2b, key)) {
    return Number(s2b[key]);
  }
  if (Object.keys(s2b).length === 0) {
    throw new RecordRuntimeError(
      `Scandata leaf ${scandataLeaf} cannot be resolved (no scandata.xml mapping cached).`
    );
  }
  throw new RecordRuntimeError(
    `Scandata leaf ${scandataLeaf} is not an access leaf (deleted or unknown) in page_index.json.`
  );
}

export function segmentForLeaf(
  pageIndex: PageIndex,
  leafN: number,
  scandataLeaf: number | null
): number | null {
  const mode = pageIndex.segment_mode || 'scandata';
  if (mode === 'flat') {
    return null;
  }
  if (mode === 'bookreader') {
    return leafN;
  }
  if (scandataLeaf !== null) {
    return scandataLeaf;
  }
  if (Object.keys(pageIndex.scandata_to_bookreader ?? {}).length === 0) {
    return leafN;
  }
  return null;
}

export function parsePrintedRange(pageIndex: PageIndex, spec: string): number[] {
  const cleaned = spec.trim();
  if (!cleaned) {
    throw new RecordRuntimeError('Empty --pages range.');
  }
  const parts = cleaned.split(',').map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    throw new RecordRuntimeError(
      `Invalid --pages range '${spec}'; expected labels or ranges like 12-14 or 12,14.`
    );
  }
  const leaves: number[] = [];
  const seen = new Set<number>();
  for (const part of parts) {
    let resolvedSingle: number | undefined;
    try {
      const [leaf] = resolvePrintedPageToLeaf(pageIndex, part);
      resolvedSingle = leaf;
    } catch {
      resolvedSingle = undefined;
    }

    let chunk: number[];
    if (resolvedSingle !== undefined) {
      chunk = [resolvedSingle];
    } else if (!part.includes('-')) {
      const [leaf] = resolvePrintedPageToLeaf(pageIndex, part);
      chunk = [leaf];
    } else {
      const dashIdx = part.indexOf('-');
      const startLabel = part.slice(0, dashIdx);
      const endLabel = part.slice(dashIdx + 1);
      if (!startLabel.trim() || !endLabel.trim()) {
        throw new RecordRuntimeError(`Invalid --pages range '${spec}'; expected <p1>-<p2>.`);
      }
      const [startLeaf] = resolvePrintedPageToLeaf(pageIndex, startLabel);
      const [endLeaf] = resolvePrintedPageToLeaf(pageIndex, endLabel);
      if (endLeaf < startLeaf) {
        throw new RecordRuntimeError(
          `Invalid --pages range '${spec}': printed page '${endLabel.trim()}' (n${endLeaf}) precedes '${startLabel.trim()}' (n${startLeaf}).`
        );
      }
      chunk = Array.from({ length: endLeaf - startLeaf + 1 }, (_, i) => startLeaf + i);
    }

    for (const leaf of chunk) {
      if (!seen.has(leaf)) {
        seen.add(leaf);
        leaves.push(leaf);
      }
    }
  }
  return leaves;
}

export function parseLeafSpec(spec: string): number[] {
  const leaves: number[] = [];
  const seen = new Set<number>();
  const parts = spec.split(',').map((part) => part.trim());
  if (!spec.trim() || parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new CliValidationError(
      'Invalid --leaves value. Use integers or inclusive ranges like 120-123,130.'
    );
  }
  for (const part of parts) {
    const rangeMatch = /^[nN]?(\d+)\s*-\s*[nN]?(\d+)$/.exec(part);
    let chunk: number[];
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1] ?? '', 10);
      const end = Number.parseInt(rangeMatch[2] ?? '', 10);
      if (end < start) {
        throw new CliValidationError(`Invalid --leaves range '${part}': ${end} precedes ${start}.`);
      }
      if (end - start + 1 > PAGE_BATCH_LIMIT) {
        throw new CliValidationError(
          `--leaves asks for more than ${PAGE_BATCH_LIMIT} pages. Split the request into batches of ${PAGE_BATCH_LIMIT} or fewer.`
        );
      }
      chunk = Array.from({ length: end - start + 1 }, (_, i) => start + i);
    } else if (/^[nN]?\d+$/.test(part)) {
      const num = Number.parseInt(part[0] === 'n' || part[0] === 'N' ? part.slice(1) : part, 10);
      chunk = [num];
    } else {
      throw new CliValidationError(
        `Invalid --leaves token '${part}'. Use integers or inclusive ranges like 120-123,130.`
      );
    }
    for (const leaf of chunk) {
      if (!seen.has(leaf)) {
        seen.add(leaf);
        leaves.push(leaf);
        if (leaves.length > PAGE_BATCH_LIMIT) {
          throw new CliValidationError(
            `--leaves asks for more than ${PAGE_BATCH_LIMIT} pages. Split the request into batches of ${PAGE_BATCH_LIMIT} or fewer.`
          );
        }
      }
    }
  }
  return leaves;
}

export function parsePrintedPageSpec(spec: string): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();
  const parts = spec.split(',').map((part) => part.trim());
  if (!spec.trim() || parts.length === 0 || parts.some((part) => part.length === 0)) {
    throw new CliValidationError(
      'Invalid --printed-pages value. Use printed labels or inclusive integer ranges like 670-674,707.'
    );
  }
  for (const part of parts) {
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    let chunk: string[];
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1] ?? '', 10);
      const end = Number.parseInt(rangeMatch[2] ?? '', 10);
      if (end < start) {
        throw new CliValidationError(`Invalid --printed-pages range '${part}': ${end} precedes ${start}.`);
      }
      if (end - start + 1 > PAGE_BATCH_LIMIT) {
        throw new CliValidationError(
          `--printed-pages asks for more than ${PAGE_BATCH_LIMIT} pages. Split the request into batches of ${PAGE_BATCH_LIMIT} or fewer.`
        );
      }
      chunk = Array.from({ length: end - start + 1 }, (_, i) => String(start + i));
    } else {
      chunk = [part];
    }
    for (const label of chunk) {
      if (!seen.has(label)) {
        seen.add(label);
        labels.push(label);
        if (labels.length > PAGE_BATCH_LIMIT) {
          throw new CliValidationError(
            `--printed-pages asks for more than ${PAGE_BATCH_LIMIT} pages. Split the request into batches of ${PAGE_BATCH_LIMIT} or fewer.`
          );
        }
      }
    }
  }
  return labels;
}

export function pageSuffixAndUrl(
  identifier: string,
  leaf: number,
  scale: number | undefined,
  width: number | undefined
): readonly [string, string] {
  if (scale !== undefined) {
    return [`s${scale}`, pageImageUrl(identifier, leaf, { scale })];
  }
  const chosenWidth = width !== undefined ? width : 2400;
  return [`w${chosenWidth}`, pageImageUrl(identifier, leaf, { width: chosenWidth })];
}

export function resolveSearchQuery(
  queryParts: readonly string[],
  queryFlag: string | undefined,
  options: { readonly mediatype?: string | undefined; readonly collections?: readonly string[] } = {}
): string {
  const posText = queryParts
    .filter((p) => p.length > 0)
    .join(' ')
    .trim();
  const flagText = (queryFlag ?? '').trim();
  if (posText && flagText) {
    throw new CliValidationError('Pass either a positional query or --query/-q, not both.');
  }
  const base = flagText || posText;
  const clauses: string[] = [];
  if (base) {
    clauses.push(base);
  }
  if (options.mediatype?.trim()) {
    clauses.push(`mediatype:(${options.mediatype.trim()})`);
  }
  const flatCollections: string[] = [];
  for (const item of options.collections ?? []) {
    for (const part of item.split(',')) {
      const cleaned = part.trim();
      if (cleaned) {
        flatCollections.push(cleaned);
      }
    }
  }
  if (flatCollections.length === 1) {
    clauses.push(`collection:(${flatCollections[0]})`);
  } else if (flatCollections.length > 1) {
    clauses.push(`collection:(${flatCollections.join(' OR ')})`);
  }
  if (clauses.length === 0) {
    throw new CliValidationError('Pass a search query (or --collection / --mediatype).');
  }
  return clauses.join(' AND ');
}

export function flattenFields(rawFields: readonly string[]): string[] {
  const fields: string[] = [];
  for (const item of rawFields) {
    for (const part of item.split(',')) {
      const cleaned = part.trim();
      if (cleaned && !fields.includes(cleaned)) {
        fields.push(cleaned);
      }
    }
  }
  return fields.length > 0 ? fields : [...DEFAULT_FIELDS];
}
