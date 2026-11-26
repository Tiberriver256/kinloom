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
  maxChars = 13,
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
