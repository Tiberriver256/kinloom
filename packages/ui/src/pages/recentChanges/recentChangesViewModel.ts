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
  const peopleById = new Map(bundle.people.map((p) => [p.id, p]));
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
  for (const ev of bundle.events) {
    const primaryPerson = ev.participants
      .map((pt) => peopleById.get(pt.person_id))
      .find((p) => p && p.full_name !== 'Living');
    map.set(`event:${ev.id}`, {
      label: ev.title || ev.id,
      to: primaryPerson ? `/person/${primaryPerson.slug}?event=${ev.id}` : null,
    });
  }
  for (const narrative of bundle.narratives ?? []) {
    const subject = narrative.person_ids
      .map((id) => peopleById.get(id))
      .find((p) => p && p.full_name !== 'Living');
    map.set(`narrative:${narrative.id}`, {
      label: narrative.title || narrative.id,
      to: subject ? `/person/${subject.slug}` : null,
    });
  }
  for (const item of bundle.media ?? []) {
    map.set(`media:${item.id}`, {
      label: item.caption || item.id,
      to: '/evidence?tab=media',
    });
  }
  return map;
}

export function isFeedGroupReviewed(group: FeedGroup): boolean {
  return group.revisions.length > 0 && group.revisions.every((rev) => Boolean(rev.review));
}

export function getEmptyRevisionFeedMessage(authorFilter: AuthorFilter, onlyUnreviewed: boolean): string {
  if (onlyUnreviewed) {
    if (authorFilter === 'all') {
      return 'Every recorded change has been marked reviewed by a steward.';
    }
    return 'No unreviewed changes match the active author tab.';
  }
  switch (authorFilter) {
    case 'all':
      return 'No archival changes have been recorded yet. Family edits and research batches will appear here once contributors update records.';
    case 'human':
      return 'No family editor revisions have been recorded yet.';
    case 'agent':
      return 'No research agent batches have been submitted yet.';
    case 'system_seed':
      return 'No initial archive seed revisions are recorded.';
    default: {
      const _exhaustive: never = authorFilter;
      return _exhaustive;
    }
  }
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
