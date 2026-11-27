import type { Place } from '@kinloom/core';
import { LINEAGE_GROUP_LABELS } from './vocabulary.js';

const GENERIC_SUBDIVISION_RE = /^(Township|J Twp|Justice Precinct|District|Precinct|Ward)\b/i;
const SUFFIX_RE = /^(Jr\.?|Sr\.?|II|III|IV)$/i;

/** Format an internal lineage_group slug into a human-readable archival label. */
export function formatLineageGroupLabel(group: string): string {
  const mapped = LINEAGE_GROUP_LABELS[group];
  if (mapped) {
    return mapped;
  }
  return group
    .split('_')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

const WIDE_UPPER_RE = /^[MW]$/;
const NARROW_UPPER_RE = /^[IJ]$/;
const WIDE_LOWER_RE = /^[mw]$/;
const NARROW_LOWER_RE = /^[ijltfr]$/;
const PUNCT_SPACE_RE = /^[\s.,'’\-:;!]$/;

/**
 * Estimate bold serif advance width in pixels for SVG tree labels.
 * Calibrated conservatively against DejaVu Serif / Georgia / Newsreader bold glyphs.
 */
export function estimateTreeLabelWidthPx(text: string, fontSizePx = 11.5): number {
  let emSum = 0;
  for (const ch of text) {
    if (ch === '…') {
      emSum += 0.96;
    } else if (WIDE_UPPER_RE.test(ch)) {
      emSum += 1.06;
    } else if (NARROW_UPPER_RE.test(ch)) {
      emSum += 0.48;
    } else if (ch >= 'A' && ch <= 'Z') {
      emSum += 0.82;
    } else if (WIDE_LOWER_RE.test(ch)) {
      emSum += 0.9;
    } else if (NARROW_LOWER_RE.test(ch)) {
      emSum += 0.42;
    } else if (PUNCT_SPACE_RE.test(ch)) {
      emSum += 0.36;
    } else if (ch >= '0' && ch <= '9') {
      emSum += 0.68;
    } else {
      emSum += 0.64;
    }
  }
  return emSum * fontSizePx * 1.06;
}

/** Format a full name to fit cleanly inside a fixed SVG pixel width without clipping mid-glyph. */
export function fitTreeCardNameToWidth(fullName: string, maxWidthPx: number, fontSizePx = 11.5): string {
  const trimmed = fullName.trim();
  if (trimmed.length === 0 || estimateTreeLabelWidthPx(trimmed, fontSizePx) <= maxWidthPx) {
    return trimmed;
  }

  let candidate = trimmed;
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 3) {
    const hasSuffix = SUFFIX_RE.test(parts.at(-1) ?? '');
    const middleEnd = hasSuffix ? parts.length - 2 : parts.length - 1;
    if (middleEnd > 1) {
      const abbreviated = [
        parts[0],
        ...parts.slice(1, middleEnd).map((w) => `${w[0]}.`),
        ...parts.slice(middleEnd),
      ].join(' ');
      if (estimateTreeLabelWidthPx(abbreviated, fontSizePx) <= maxWidthPx) {
        return abbreviated;
      }
      candidate = abbreviated;
    }
  }

  const chars = [...candidate];
  while (chars.length > 1) {
    chars.pop();
    const attempt = `${chars.join('').trimEnd()}…`;
    if (estimateTreeLabelWidthPx(attempt, fontSizePx) <= maxWidthPx) {
      return attempt;
    }
  }
  return `${chars.join('')}…`;
}

/** Format a full name for fixed-width tree cards without clipping distinguishing suffixes. */
export function formatTreeCardName(fullName: string, maxChars = 20): string {
  const trimmed = fullName.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 3) {
    const hasSuffix = SUFFIX_RE.test(parts.at(-1) ?? '');
    const middleEnd = hasSuffix ? parts.length - 2 : parts.length - 1;
    if (middleEnd > 1) {
      const abbreviated = [
        parts[0],
        ...parts.slice(1, middleEnd).map((w) => `${w[0]}.`),
        ...parts.slice(middleEnd),
      ].join(' ');
      if (abbreviated.length <= maxChars + (hasSuffix ? 2 : 0)) {
        return abbreviated;
      }
    }
  }
  return `${trimmed.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Resolve generic census/precinct subdivisions to their parent county and format cleanly. */
export function formatTreeCardPlace(
  place: Place | undefined,
  placesById: Map<string, Place>,
  maxChars = 13
): string {
  if (!place) {
    return '';
  }
  let label = place.name;
  if (GENERIC_SUBDIVISION_RE.test(label) && place.parent_id) {
    const parent = placesById.get(place.parent_id);
    if (parent) {
      label = parent.name;
    }
  }
  label = label.replace(/\bCounty$/i, 'Co.').trim();
  if (label.length <= maxChars) {
    return label;
  }
  return `${label.slice(0, maxChars - 1).trimEnd()}…`;
}
