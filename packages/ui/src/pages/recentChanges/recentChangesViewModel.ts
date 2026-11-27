import type { ArchiveBundle, AuthorType, RevisionRecord } from '@kinloom/core';

export type AuthorFilter = 'all' | AuthorType;

export type PendingRevertConfirm =
  | { readonly kind: 'revision'; readonly rev: RevisionRecord }
  | { readonly kind: 'batch'; readonly batchId: string; readonly count: number };

export interface FeedGroup {
  readonly key: string;
  readonly batchId: string | null;
  readonly revisions: RevisionRecord[];
}

export interface ResolvedEntityLink {
  readonly label: string;
  readonly to: string | null;
}

export function buildEntityLinkMap(bundle: ArchiveBundle | null): Map<string, ResolvedEntityLink> {
  const map = new Map<string, ResolvedEntityLink>();
  if (!bundle) {
    return map;
  }
  for (const p of bundle.people) {
    map.set(`person:${p.id}`, { label: p.full_name, to: `/person/${p.slug}` });
  }
  for (const pl of bundle.places) {
    map.set(`place:${pl.id}`, { label: pl.full_name || pl.name, to: `/place/${pl.slug}` });
  }
  for (const src of bundle.sources) {
    map.set(`source:${src.id}`, {
      label: src.citation,
      to: `/evidence?tab=citations&source=${encodeURIComponent(src.id)}`,
    });
  }
  return map;
}

export function groupRevisionsByBatch(revisions: readonly RevisionRecord[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  const batchMap = new Map<string, FeedGroup>();

  for (const rev of revisions) {
    if (rev.batch_id) {
      const existing = batchMap.get(rev.batch_id);
      if (existing) {
        existing.revisions.push(rev);
      } else {
        const group: FeedGroup = {
          key: `batch:${rev.batch_id}`,
          batchId: rev.batch_id,
          revisions: [rev],
        };
        batchMap.set(rev.batch_id, group);
        groups.push(group);
      }
    } else {
      groups.push({
        key: `rev:${rev.revision_id}`,
        batchId: null,
        revisions: [rev],
      });
    }
  }
  return groups;
}
