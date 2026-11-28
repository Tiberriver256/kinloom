import type {
  DocumentaryStory,
  MapStop,
  StoryFormat,
  StoryManifestEntry,
  StoryWordTimestamp,
} from '@kinloom/core';

export const DEFAULT_STORIES_ROUTE_BASE = '/stories';

export type StoryFormatFilter = 'all' | StoryFormat;

export function formatStoryFormatLabel(format: StoryFormat): string {
  switch (format) {
    case 'documentary':
      return 'Documentary';
    case 'scroll':
      return 'Scroll Story';
    case 'map':
      return 'Journey Map';
  }
}

export function formatStoryDurationLabel(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) {
    return '';
  }
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

export function filterStorySummaries(
  stories: readonly StoryManifestEntry[],
  options: { readonly format?: StoryFormatFilter; readonly personId?: string | undefined } = {}
): readonly StoryManifestEntry[] {
  const format = options.format ?? 'all';
  const personId = options.personId?.trim();
  return stories.filter((story) => {
    if (format !== 'all' && story.format !== format) {
      return false;
    }
    if (personId && story.personId !== personId) {
      return false;
    }
    return true;
  });
}

export function clampBeatIndex(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  if (index < 0) {
    return 0;
  }
  if (index >= count) {
    return count - 1;
  }
  return index;
}

export function resolveDocumentaryBeatAtTime(story: DocumentaryStory, timeMs: number): number {
  if (story.beats.length === 0) {
    return 0;
  }
  const clamped = Math.max(0, timeMs);
  for (const [i, beat] of story.beats.entries()) {
    if (clamped < beat.startMs + beat.durationMs) {
      return i;
    }
  }
  return story.beats.length - 1;
}

export function resolveActiveWordIndex(
  words: readonly StoryWordTimestamp[] | undefined,
  timeMs: number
): number {
  if (!words || words.length === 0) {
    return -1;
  }
  for (const [i, w] of words.entries()) {
    if (timeMs >= w.startMs && timeMs <= w.endMs) {
      return i;
    }
  }
  return -1;
}

export interface ProjectedMapStop {
  readonly stop: MapStop;
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Projects geographic coordinates for a MapStory onto an SVG viewport with safe padding.
 */
export function projectMapStops(
  stops: readonly MapStop[],
  width = 640,
  height = 360,
  padding = 48
): readonly ProjectedMapStop[] {
  if (stops.length === 0) {
    return [];
  }
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  for (const stop of stops) {
    if (stop.coordinates.lat < minLat) minLat = stop.coordinates.lat;
    if (stop.coordinates.lat > maxLat) maxLat = stop.coordinates.lat;
    if (stop.coordinates.lng < minLng) minLng = stop.coordinates.lng;
    if (stop.coordinates.lng > maxLng) maxLng = stop.coordinates.lng;
  }

  const innerW = Math.max(1, width - padding * 2);
  const innerH = Math.max(1, height - padding * 2);
  const spanLng = maxLng - minLng;
  const spanLat = maxLat - minLat;

  return stops.map((stop, index) => {
    const nx = spanLng > 1e-6 ? (stop.coordinates.lng - minLng) / spanLng : 0.5;
    const ny = spanLat > 1e-6 ? 1 - (stop.coordinates.lat - minLat) / spanLat : 0.5;
    return {
      stop,
      index,
      x: Math.round((padding + nx * innerW) * 10) / 10,
      y: Math.round((padding + ny * innerH) * 10) / 10,
    };
  });
}
