import type { KinshipEdge } from '@kinloom/core';
import { collectLiveMediaCollisions } from '../live-media-collisions.js';
import {
  type AuditBatchPerson,
  type AuditBatchSummary,
  type AuditOverlaps,
  EVENT_DIFF_FIELDS,
  type KinshipAddRemoveConflict,
  type MediaFileCollision,
  type MediaFileCollisionEntry,
  type OverlapBlockingCounts,
  type ParsedPackage,
  PERSON_DIFF_FIELDS,
  type PersonSlugCollision,
  type PersonSlugCollisionEntry,
  type ScanCollisionPackage,
  type ScanFileCollision,
  type SharedEventOverlap,
  type SharedMediaId,
  type SharedPersonOverlap,
  type SharedSourceId,
  type StagedEventRow,
  type StagedPersonRow,
  type StagedScanFileEntry,
} from './types.js';

function comparePersonId(a: { person_id: string }, b: { person_id: string }): number {
  return a.person_id.localeCompare(b.person_id);
}

function uniquePersonCount(personIds: readonly string[]): number {
  return new Set(personIds).size;
}

export function collectScanCollisions(scanEntries: readonly StagedScanFileEntry[]): ScanFileCollision[] {
  const grouped = new Map<string, ScanCollisionPackage[]>();
  for (const entry of scanEntries) {
    const row: ScanCollisionPackage = {
      person_id: entry.person_id,
      bytes: entry.bytes,
      width: entry.width,
      height: entry.height,
      sha256: entry.sha256,
    };
    const rows = grouped.get(entry.basename) ?? [];
    rows.push(row);
    grouped.set(entry.basename, rows);
  }

  const collisions: ScanFileCollision[] = [];
  for (const [basename, rows] of grouped) {
    if (uniquePersonCount(rows.map((row) => row.person_id)) < 2) {
      continue;
    }
    const packagesForFile = rows.toSorted(comparePersonId);
    const firstHash = packagesForFile[0]?.sha256 ?? '';
    collisions.push({
      basename,
      bytesIdentical: packagesForFile.every((row) => row.sha256 === firstHash),
      packages: packagesForFile,
    });
  }
  return collisions.toSorted((a, b) => a.basename.localeCompare(b.basename));
}

export function collectMediaFileCollisions(packages: readonly ParsedPackage[]): MediaFileCollision[] {
  const grouped = new Map<string, MediaFileCollisionEntry[]>();
  for (const staged of packages) {
    for (const item of staged.media) {
      if (!item.normalizedFile) {
        continue;
      }
      const rows = grouped.get(item.normalizedFile) ?? [];
      rows.push({
        person_id: staged.personId,
        media_id: item.id,
        file: item.file,
      });
      grouped.set(item.normalizedFile, rows);
    }
  }
  const collisions: MediaFileCollision[] = [];
  for (const [file, entries] of grouped) {
    if (uniquePersonCount(entries.map((entry) => entry.person_id)) < 2) {
      continue;
    }
    const sorted = entries.toSorted(
      (a, b) => a.person_id.localeCompare(b.person_id) || a.media_id.localeCompare(b.media_id)
    );
    const mediaIds = new Set(sorted.map((entry) => entry.media_id));
    collisions.push({
      file,
      mediaIdsConflict: mediaIds.size > 1,
      entries: sorted,
    });
  }
  return collisions.toSorted((a, b) => a.file.localeCompare(b.file));
}

export function collectSharedMediaIds(packages: readonly ParsedPackage[]): SharedMediaId[] {
  const grouped = new Map<string, Array<{ person_id: string; file: string }>>();
  for (const staged of packages) {
    const seenInPackage = new Set<string>();
    for (const item of staged.media) {
      if (seenInPackage.has(item.id)) {
        continue;
      }
      seenInPackage.add(item.id);
      const rows = grouped.get(item.id) ?? [];
      rows.push({ person_id: staged.personId, file: item.file });
      grouped.set(item.id, rows);
    }
  }
  const shared: SharedMediaId[] = [];
  for (const [id, rows] of grouped) {
    if (uniquePersonCount(rows.map((row) => row.person_id)) < 2) {
      continue;
    }
    shared.push({ id, packages: rows.toSorted(comparePersonId) });
  }
  return shared.toSorted((a, b) => a.id.localeCompare(b.id));
}

export function collectSharedSourceIds(packages: readonly ParsedPackage[]): SharedSourceId[] {
  const grouped = new Map<string, string[]>();
  for (const staged of packages) {
    const seenInPackage = new Set<string>();
    for (const source of staged.sources) {
      if (seenInPackage.has(source.id)) {
        continue;
      }
      seenInPackage.add(source.id);
      const rows = grouped.get(source.id) ?? [];
      rows.push(staged.personId);
      grouped.set(source.id, rows);
    }
  }
  const shared: SharedSourceId[] = [];
  for (const [id, personIds] of grouped) {
    const unique = [...new Set(personIds)].sort((a, b) => a.localeCompare(b));
    if (unique.length < 2) {
      continue;
    }
    shared.push({ id, person_ids: unique });
  }
  return shared.toSorted((a, b) => a.id.localeCompare(b.id));
}

export function collectSharedEvents(packages: readonly ParsedPackage[]): SharedEventOverlap[] {
  const grouped = new Map<string, StagedEventRow[]>();
  for (const staged of packages) {
    const seenInPackage = new Set<string>();
    for (const event of staged.eventRows) {
      if (seenInPackage.has(event.id)) {
        continue;
      }
      seenInPackage.add(event.id);
      const rows = grouped.get(event.id) ?? [];
      rows.push(event);
      grouped.set(event.id, rows);
    }
  }
  const overlaps: SharedEventOverlap[] = [];
  for (const [id, rows] of grouped) {
    if (uniquePersonCount(rows.map((row) => row.person_id)) < 2) {
      continue;
    }
    const sorted = rows.toSorted(comparePersonId);
    const fieldDiffs = EVENT_DIFF_FIELDS.filter((field) => {
      const first = sorted[0]?.[field] ?? null;
      return sorted.some((row) => row[field] !== first);
    });
    overlaps.push({
      id,
      fieldDiffs: [...fieldDiffs],
      packages: sorted.map((row) => ({
        person_id: row.person_id,
        edtf_date: row.edtf_date,
        place_id: row.place_id,
        place_precision: row.place_precision,
        title: row.title,
      })),
    });
  }
  return overlaps.toSorted((a, b) => a.id.localeCompare(b.id));
}

export function collectSharedPeople(packages: readonly ParsedPackage[]): SharedPersonOverlap[] {
  const grouped = new Map<string, StagedPersonRow[]>();
  for (const staged of packages) {
    const seenInPackage = new Set<string>();
    for (const person of staged.stagedPeople) {
      if (seenInPackage.has(person.id)) {
        continue;
      }
      seenInPackage.add(person.id);
      const rows = grouped.get(person.id) ?? [];
      rows.push(person);
      grouped.set(person.id, rows);
    }
  }
  const overlaps: SharedPersonOverlap[] = [];
  for (const [id, rows] of grouped) {
    if (uniquePersonCount(rows.map((row) => row.person_id)) < 2) {
      continue;
    }
    const sorted = rows.toSorted(comparePersonId);
    const fieldDiffs = PERSON_DIFF_FIELDS.filter((field) => {
      const first = sorted[0]?.[field] ?? null;
      return sorted.some((row) => row[field] !== first);
    });
    overlaps.push({
      id,
      fieldDiffs: [...fieldDiffs],
      packages: sorted.map((row) => ({
        person_id: row.person_id,
        slug: row.slug,
        full_name: row.full_name,
        given_name: row.given_name,
        surname: row.surname,
        sex: row.sex,
        birth_edtf: row.birth_edtf,
        death_edtf: row.death_edtf,
        lineage_group: row.lineage_group,
        branch: row.branch,
      })),
    });
  }
  return overlaps.toSorted((a, b) => a.id.localeCompare(b.id));
}

export function collectPersonSlugCollisions(packages: readonly ParsedPackage[]): PersonSlugCollision[] {
  const grouped = new Map<string, PersonSlugCollisionEntry[]>();
  for (const staged of packages) {
    for (const person of staged.stagedPeople) {
      if (!person.slug) {
        continue;
      }
      const key = person.slug.toLowerCase();
      const rows = grouped.get(key) ?? [];
      rows.push({
        package_person_id: staged.personId,
        person_id: person.id,
        slug: person.slug,
      });
      grouped.set(key, rows);
    }
  }
  const collisions: PersonSlugCollision[] = [];
  for (const [slug, entries] of grouped) {
    if (uniquePersonCount(entries.map((entry) => entry.package_person_id)) < 2) {
      continue;
    }
    const sorted = entries.toSorted(
      (a, b) =>
        a.package_person_id.localeCompare(b.package_person_id) || a.person_id.localeCompare(b.person_id)
    );
    const personIds = new Set(sorted.map((entry) => entry.person_id));
    collisions.push({
      slug,
      personIdsConflict: personIds.size > 1,
      entries: sorted,
    });
  }
  return collisions.toSorted((a, b) => a.slug.localeCompare(b.slug));
}

export function collectKinshipAddRemoveConflicts(
  packages: readonly ParsedPackage[]
): KinshipAddRemoveConflict[] {
  const byEdgeKey = new Map<
    string,
    {
      from: string;
      to: string;
      relation: KinshipEdge['relation'];
      addedBy: Set<string>;
      removedBy: Set<string>;
    }
  >();

  for (const adder of packages) {
    for (const add of adder.kinshipAdds) {
      for (const remover of packages) {
        if (remover.personId === adder.personId) {
          continue;
        }
        const conflicts = remover.kinshipRemoves.some(
          (rem) =>
            rem.from === add.from &&
            rem.to === add.to &&
            rem.relation === add.relation &&
            (rem.family_xref === undefined || add.family_xref === null || add.family_xref === rem.family_xref)
        );
        if (!conflicts) {
          continue;
        }
        const key = `${add.from}|${add.to}|${add.relation}`;
        let entry = byEdgeKey.get(key);
        if (!entry) {
          entry = {
            from: add.from,
            to: add.to,
            relation: add.relation,
            addedBy: new Set<string>(),
            removedBy: new Set<string>(),
          };
          byEdgeKey.set(key, entry);
        }
        entry.addedBy.add(adder.personId);
        entry.removedBy.add(remover.personId);
      }
    }
  }

  return [...byEdgeKey.values()]
    .map((entry) => ({
      from: entry.from,
      to: entry.to,
      relation: entry.relation,
      addedBy: [...entry.addedBy].toSorted((a, b) => a.localeCompare(b)),
      removedBy: [...entry.removedBy].toSorted((a, b) => a.localeCompare(b)),
    }))
    .toSorted(
      (a, b) =>
        a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.relation.localeCompare(b.relation)
    );
}

export function createEmptyAuditOverlaps(): AuditOverlaps {
  return {
    scanFileCollisions: [],
    mediaFileCollisions: [],
    sharedMediaIds: [],
    sharedSourceIds: [],
    sharedEventOverlaps: [],
    sharedPersonOverlaps: [],
    personSlugCollisions: [],
    liveMediaFileCollisions: [],
    kinshipAddRemoveConflicts: [],
  };
}

export function countBlockingOverlaps(overlaps: AuditOverlaps): OverlapBlockingCounts {
  return {
    differingScanCollisions: overlaps.scanFileCollisions.filter((row) => !row.bytesIdentical).length,
    conflictingMediaFileCollisions: overlaps.mediaFileCollisions.filter((row) => row.mediaIdsConflict).length,
    conflictingPersonOverlaps: overlaps.sharedPersonOverlaps.filter((row) => row.fieldDiffs.length > 0)
      .length,
    conflictingPersonSlugCollisions: overlaps.personSlugCollisions.filter((row) => row.personIdsConflict)
      .length,
    liveMediaFileCollisions: overlaps.liveMediaFileCollisions.length,
    kinshipAddRemoveConflicts: overlaps.kinshipAddRemoveConflicts.length,
  };
}

export function hasAnyBlockingOverlaps(blocking: OverlapBlockingCounts): boolean {
  return (
    blocking.differingScanCollisions > 0 ||
    blocking.conflictingMediaFileCollisions > 0 ||
    blocking.conflictingPersonOverlaps > 0 ||
    blocking.conflictingPersonSlugCollisions > 0 ||
    blocking.liveMediaFileCollisions > 0 ||
    blocking.kinshipAddRemoveConflicts > 0
  );
}

export function computeAuditOverlaps(input: {
  packages: readonly ParsedPackage[];
  scanEntries: readonly StagedScanFileEntry[];
  liveMedia: readonly { id: string; file: string }[];
}): AuditOverlaps {
  return {
    scanFileCollisions: collectScanCollisions(input.scanEntries),
    mediaFileCollisions: collectMediaFileCollisions(input.packages),
    sharedMediaIds: collectSharedMediaIds(input.packages),
    sharedSourceIds: collectSharedSourceIds(input.packages),
    sharedEventOverlaps: collectSharedEvents(input.packages),
    sharedPersonOverlaps: collectSharedPeople(input.packages),
    personSlugCollisions: collectPersonSlugCollisions(input.packages),
    liveMediaFileCollisions: collectLiveMediaCollisions(input.packages, input.liveMedia),
    kinshipAddRemoveConflicts: collectKinshipAddRemoveConflicts(input.packages),
  };
}

export function summarizeBatch(
  people: readonly AuditBatchPerson[],
  overlaps: AuditOverlaps
): AuditBatchSummary {
  return {
    people: people.length,
    passed: people.filter((person) => person.ok).length,
    failed: people.filter((person) => !person.ok).length,
    strictPassed: people.filter((person) => person.strictOk).length,
    scanFileCollisions: overlaps.scanFileCollisions.length,
    differingScanCollisions: overlaps.scanFileCollisions.filter((row) => !row.bytesIdentical).length,
    mediaFileCollisions: overlaps.mediaFileCollisions.length,
    conflictingMediaFileCollisions: overlaps.mediaFileCollisions.filter((row) => row.mediaIdsConflict).length,
    sharedMediaIds: overlaps.sharedMediaIds.length,
    sharedSourceIds: overlaps.sharedSourceIds.length,
    sharedEventOverlaps: overlaps.sharedEventOverlaps.length,
    sharedEventFieldDiffs: overlaps.sharedEventOverlaps.filter((row) => row.fieldDiffs.length > 0).length,
    sharedPersonOverlaps: overlaps.sharedPersonOverlaps.length,
    conflictingPersonOverlaps: overlaps.sharedPersonOverlaps.filter((row) => row.fieldDiffs.length > 0)
      .length,
    personSlugCollisions: overlaps.personSlugCollisions.length,
    conflictingPersonSlugCollisions: overlaps.personSlugCollisions.filter((row) => row.personIdsConflict)
      .length,
    liveMediaFileCollisions: overlaps.liveMediaFileCollisions.length,
    kinshipAddRemoveConflicts: overlaps.kinshipAddRemoveConflicts.length,
  };
}
