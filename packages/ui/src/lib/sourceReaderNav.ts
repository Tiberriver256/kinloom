export function readerNextPage(pageIdx: number, pageCount: number): number {
  if (pageCount <= 0) {
    return 0;
  }
  return Math.min(pageCount - 1, pageIdx + 1);
}

export function readerPrevPage(pageIdx: number): number {
  return Math.max(0, pageIdx - 1);
}

export function resolveReaderPageIndex(pages: readonly { page: number }[], requestedPage?: number): number {
  if (requestedPage === undefined) {
    return 0;
  }
  const idx = pages.findIndex((p) => p.page === requestedPage);
  return idx === -1 ? 0 : idx;
}
