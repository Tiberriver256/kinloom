export interface TimelineCardMetric {
  id: string;
  top: number;
  bottom: number;
}

export interface PickActiveOptions {
  anchorY: number;
  scrollY: number;
  maxScrollY: number;
  edgeThresholdPx?: number;
}

export function pickActiveTimelineEventId(
  cards: readonly TimelineCardMetric[],
  options: PickActiveOptions
): string | null {
  if (cards.length === 0) {
    return null;
  }
  if (cards.length === 1) {
    return cards[0].id;
  }

  const edgeThreshold = options.edgeThresholdPx ?? 8;

  if (options.scrollY <= edgeThreshold) {
    return cards[0].id;
  }

  if (options.maxScrollY > edgeThreshold && options.scrollY >= options.maxScrollY - edgeThreshold) {
    return cards.at(-1)?.id ?? cards[0].id;
  }

  for (const card of cards) {
    if (card.top <= options.anchorY && card.bottom >= options.anchorY) {
      return card.id;
    }
  }

  let lastPassed: TimelineCardMetric | null = null;
  for (const card of cards) {
    if (card.top <= options.anchorY) {
      lastPassed = card;
    } else {
      break;
    }
  }

  return lastPassed ? lastPassed.id : cards[0].id;
}

export function shouldRunInitialEventScroll(params: {
  navKey: string;
  completedNavKey: string | null;
  targetEventId: string | null;
  eventIds: readonly string[];
}): boolean {
  const { navKey, completedNavKey, targetEventId, eventIds } = params;
  if (!targetEventId) {
    return false;
  }
  if (completedNavKey === navKey) {
    return false;
  }
  if (eventIds.length === 0) {
    return false;
  }
  if (eventIds[0] === targetEventId) {
    return false;
  }
  return eventIds.includes(targetEventId);
}

export function buildEventQueryUrl(currentHref: string, eventId: string): string | null {
  try {
    const url = new URL(currentHref);
    if (url.searchParams.get('event') === eventId) {
      return null;
    }
    url.searchParams.set('event', eventId);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
