export interface RecentlyViewedItem {
  readonly kind: 'person' | 'place';
  readonly slug: string;
  readonly label: string;
  readonly meta?: string;
}

const STORAGE_KEY = 'kinloom:recently-viewed:v1';
const MAX_RECENTLY_VIEWED = 5;

function getSafeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return null;
    }
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readRecentlyViewed(): RecentlyViewedItem[] {
  const storage = getSafeStorage();
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const items: RecentlyViewedItem[] = [];
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry === 'object' &&
        (entry.kind === 'person' || entry.kind === 'place') &&
        typeof entry.slug === 'string' &&
        entry.slug.trim().length > 0 &&
        typeof entry.label === 'string' &&
        entry.label.trim().length > 0
      ) {
        items.push({
          kind: entry.kind,
          slug: entry.slug.trim(),
          label: entry.label.trim(),
          ...(typeof entry.meta === 'string' && entry.meta.trim() ? { meta: entry.meta.trim() } : {}),
        });
      }
      if (items.length >= MAX_RECENTLY_VIEWED) {
        break;
      }
    }
    return items;
  } catch {
    return [];
  }
}

export function recordRecentlyViewed(item: RecentlyViewedItem): RecentlyViewedItem[] {
  const slug = item.slug.trim();
  const label = item.label.trim();
  if (!slug || !label) {
    return readRecentlyViewed();
  }
  const existing = readRecentlyViewed().filter((entry) => !(entry.kind === item.kind && entry.slug === slug));
  const next: RecentlyViewedItem[] = [
    {
      kind: item.kind,
      slug,
      label,
      ...(item.meta?.trim() ? { meta: item.meta.trim() } : {}),
    },
    ...existing,
  ].slice(0, MAX_RECENTLY_VIEWED);

  const storage = getSafeStorage();
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore quota / private-browsing write failures
    }
  }
  return next;
}
