export function isSearchableQuery(query: string): boolean {
  return query.trim().length >= 2;
}

export function searchNavNext(activeIdx: number, resultCount: number): number {
  if (resultCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(0, resultCount - 1), activeIdx + 1);
}

export function searchNavPrev(activeIdx: number): number {
  return Math.max(0, activeIdx - 1);
}

export function searchNavReset(): number {
  return 0;
}
