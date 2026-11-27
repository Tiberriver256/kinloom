import { type Narrative, NarrativeSchema, type Place, type RawEvent, type RawPerson } from '@kinloom/core';
import {
  isPlainRecord,
  type MediaDedupeCitationRewrite,
  type MediaDedupeExtensionRewrite,
  type ParsedNarrativeEnrichmentsList,
} from './types.js';

const SCAN_MARKDOWN_CITATIONS_RE =
  /```[\s\S]*?```|`[^`\n]+`|\[\^([A-Za-z0-9._:-]+)(?:\|([A-Za-z0-9._:-]+))?\]/g;

export function countInlineMediaReferences(narratives: readonly Narrative[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const narrative of narratives) {
    const scanner = new RegExp(SCAN_MARKDOWN_CITATIONS_RE.source, 'g');
    let match: RegExpExecArray | null = scanner.exec(narrative.body_md);
    while (match !== null) {
      const mediaId = match[2];
      if (mediaId) {
        counts.set(mediaId, (counts.get(mediaId) ?? 0) + 1);
      }
      match = scanner.exec(narrative.body_md);
    }
  }
  return counts;
}

export function collectExtensionMediaCounts(value: unknown, counts: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectExtensionMediaCounts(item, counts);
    }
    return;
  }
  if (!isPlainRecord(value)) {
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    if ((key === 'media_ids' || key === 'media_refs') && Array.isArray(val)) {
      for (const entry of val) {
        if (typeof entry === 'string' && entry.trim().length > 0) {
          counts.set(entry, (counts.get(entry) ?? 0) + 1);
        }
      }
    } else if (typeof val === 'object' && val !== null) {
      collectExtensionMediaCounts(val, counts);
    }
  }
}

export function collectArchiveMediaReferenceCounts(input: {
  narratives: readonly Narrative[];
  people: readonly RawPerson[];
  places: readonly Place[];
  events: readonly RawEvent[];
  enrichments: ParsedNarrativeEnrichmentsList;
}): Map<string, number> {
  const refCounts = countInlineMediaReferences(input.narratives);
  for (const p of input.people) {
    if (p.extensions) {
      collectExtensionMediaCounts(p.extensions, refCounts);
    }
  }
  for (const pl of input.places) {
    if (pl.extensions) {
      collectExtensionMediaCounts(pl.extensions, refCounts);
    }
  }
  for (const ev of input.events) {
    if (ev.extensions) {
      collectExtensionMediaCounts(ev.extensions, refCounts);
    }
  }
  for (const nar of input.narratives) {
    if (nar.extensions) {
      collectExtensionMediaCounts(nar.extensions, refCounts);
    }
  }
  for (const enr of input.enrichments) {
    if ('extensions' in enr && enr.extensions) {
      collectExtensionMediaCounts(enr.extensions, refCounts);
    }
  }
  return refCounts;
}

export function rewriteNarrativeMediaCitations(
  markdown: string,
  retiredToCanonical: ReadonlyMap<string, string>,
  narrativeId: string
): { bodyMd: string; rewrites: MediaDedupeCitationRewrite[] } {
  const rewrites: MediaDedupeCitationRewrite[] = [];
  const scanner = new RegExp(SCAN_MARKDOWN_CITATIONS_RE.source, 'g');
  const bodyMd = markdown.replace(scanner, (fullMatch, sourceId?: string, mediaId?: string) => {
    if (!sourceId || !mediaId) {
      return fullMatch;
    }
    const replacement = retiredToCanonical.get(mediaId);
    if (!replacement || replacement === mediaId) {
      return fullMatch;
    }
    rewrites.push({
      narrativeId,
      sourceId,
      fromMediaId: mediaId,
      toMediaId: replacement,
    });
    return `[^${sourceId}|${replacement}]`;
  });
  return { bodyMd, rewrites };
}

export function rewriteMediaRefsInExtensionsObject(
  obj: unknown,
  retiredToCanonical: ReadonlyMap<string, string>,
  file: string,
  entityId: string,
  prefix: string,
  rewrites: MediaDedupeExtensionRewrite[]
): boolean {
  if (Array.isArray(obj)) {
    let changed = false;
    for (let i = 0; i < obj.length; i += 1) {
      if (
        rewriteMediaRefsInExtensionsObject(
          obj[i],
          retiredToCanonical,
          file,
          entityId,
          `${prefix}[${i}]`,
          rewrites
        )
      ) {
        changed = true;
      }
    }
    return changed;
  }
  if (!isPlainRecord(obj)) {
    return false;
  }
  let changed = false;
  for (const [key, val] of Object.entries(obj)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if ((key === 'media_ids' || key === 'media_refs') && Array.isArray(val)) {
      const nextArr: unknown[] = [];
      const seenStrings = new Set<string>();
      let arrayChanged = false;
      for (const entry of val) {
        if (typeof entry === 'string') {
          const replacement = retiredToCanonical.get(entry);
          const effective = replacement ?? entry;
          if (replacement && replacement !== entry) {
            arrayChanged = true;
            rewrites.push({
              file,
              entityId,
              fieldPath,
              fromMediaId: entry,
              toMediaId: replacement,
            });
          }
          if (!seenStrings.has(effective)) {
            seenStrings.add(effective);
            nextArr.push(effective);
          } else {
            arrayChanged = true;
          }
        } else {
          nextArr.push(entry);
        }
      }
      if (arrayChanged) {
        obj[key] = nextArr;
        changed = true;
      }
    } else if (typeof val === 'object' && val !== null) {
      if (rewriteMediaRefsInExtensionsObject(val, retiredToCanonical, file, entityId, fieldPath, rewrites)) {
        changed = true;
      }
    }
  }
  return changed;
}

export interface RewrittenArchiveEntities {
  nextNarratives: Narrative[];
  nextPeople: RawPerson[];
  nextPlaces: Place[];
  nextEvents: RawEvent[];
  citationRewrites: MediaDedupeCitationRewrite[];
  extensionRewrites: MediaDedupeExtensionRewrite[];
  narrativesChanged: boolean;
  peopleChanged: boolean;
  placesChanged: boolean;
  eventsChanged: boolean;
}

export function applyMediaReferenceRewrites(input: {
  narratives: readonly Narrative[];
  people: readonly RawPerson[];
  places: readonly Place[];
  events: readonly RawEvent[];
  retiredToCanonical: ReadonlyMap<string, string>;
}): RewrittenArchiveEntities {
  const citationRewrites: MediaDedupeCitationRewrite[] = [];
  const extensionRewrites: MediaDedupeExtensionRewrite[] = [];

  const nextNarratives = input.narratives.map((nar) => {
    const cloned = structuredClone(nar);
    const { bodyMd, rewrites } = rewriteNarrativeMediaCitations(
      cloned.body_md,
      input.retiredToCanonical,
      cloned.id
    );
    if (rewrites.length > 0) {
      cloned.body_md = bodyMd;
      citationRewrites.push(...rewrites);
    }
    if (cloned.extensions) {
      rewriteMediaRefsInExtensionsObject(
        cloned.extensions,
        input.retiredToCanonical,
        'narratives.yaml',
        cloned.id,
        'extensions',
        extensionRewrites
      );
    }
    return NarrativeSchema.parse(cloned);
  });

  const nextPeople = input.people.map((p) => structuredClone(p));
  let peopleChanged = false;
  for (const p of nextPeople) {
    if (
      p.extensions &&
      rewriteMediaRefsInExtensionsObject(
        p.extensions,
        input.retiredToCanonical,
        'people.yaml',
        p.id,
        'extensions',
        extensionRewrites
      )
    ) {
      peopleChanged = true;
    }
  }

  const nextPlaces = input.places.map((pl) => structuredClone(pl));
  let placesChanged = false;
  for (const pl of nextPlaces) {
    if (
      pl.extensions &&
      rewriteMediaRefsInExtensionsObject(
        pl.extensions,
        input.retiredToCanonical,
        'places.yaml',
        pl.id,
        'extensions',
        extensionRewrites
      )
    ) {
      placesChanged = true;
    }
  }

  const nextEvents = input.events.map((ev) => structuredClone(ev));
  let eventsChanged = false;
  for (const ev of nextEvents) {
    if (
      ev.extensions &&
      rewriteMediaRefsInExtensionsObject(
        ev.extensions,
        input.retiredToCanonical,
        'events.yaml',
        ev.id,
        'extensions',
        extensionRewrites
      )
    ) {
      eventsChanged = true;
    }
  }

  const narrativesChanged =
    citationRewrites.length > 0 || extensionRewrites.some((rw) => rw.file === 'narratives.yaml');

  return {
    nextNarratives,
    nextPeople,
    nextPlaces,
    nextEvents,
    citationRewrites,
    extensionRewrites,
    narrativesChanged,
    peopleChanged,
    placesChanged,
    eventsChanged,
  };
}
