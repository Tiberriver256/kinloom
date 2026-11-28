import type {
  ArchiveBundle,
  EntityPayload,
  EntityType,
  RevisionRecord,
  StewardReviewStamp,
} from '@kinloom/core';
import { computeEntityDiff } from '@kinloom/core';
import { formatFieldLabel } from '../../lib/revisionFieldFormat.js';
import type { FeedGroup, ResolvedEntityLink } from './recentChangesViewModel.js';

const ENTITY_SINGULAR_LABELS: Readonly<Record<EntityType, string>> = {
  person: 'person',
  event: 'event',
  place: 'place',
  source: 'source',
  media: 'photo or document',
  narrative: 'narrative',
  kinship_edge: 'family link',
};

const ENTITY_PLURAL_LABELS: Readonly<Record<EntityType, string>> = {
  person: 'people',
  event: 'events',
  place: 'places',
  source: 'sources',
  media: 'photos & documents',
  narrative: 'narratives',
  kinship_edge: 'family links',
};

const MILESTONE_KEYWORD_RE = /\b(census|birth|born|death|died|burial|marriage|married|residence|draft)\b/gi;

const MILESTONE_CANONICAL_MAP: Readonly<Record<string, string>> = {
  census: 'census',
  birth: 'birth',
  born: 'birth',
  death: 'death',
  died: 'death',
  burial: 'burial',
  marriage: 'marriage',
  married: 'marriage',
  residence: 'residence',
  draft: 'draft',
};

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'in', 'at', 'on', 'for', 'to', 'and', 'us', 'u', 's']);

function pickPayloadString(payload: EntityPayload | null, keys: readonly string[]): string | null {
  if (!payload) {
    return null;
  }
  for (const key of keys) {
    const val = payload[key];
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed.length > 0 && trimmed !== 'Living') {
        return trimmed;
      }
    }
  }
  return null;
}

function resolvePrimaryParticipantName(
  payload: EntityPayload | null,
  entityLinkByKey: ReadonlyMap<string, ResolvedEntityLink>
): string | null {
  if (!payload || !Array.isArray(payload['participants'])) {
    return null;
  }
  for (const raw of payload['participants']) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      continue;
    }
    const personId = (raw as Record<string, unknown>)['person_id'];
    if (typeof personId !== 'string') {
      continue;
    }
    const resolved = entityLinkByKey.get(`person:${personId}`);
    if (resolved?.label && resolved.label !== 'Living') {
      return resolved.label;
    }
  }
  return null;
}

/**
 * Resolve a human-readable display name for the target entity of a revision.
 */
export function resolveRevisionEntityName(
  rev: RevisionRecord,
  entityLinkByKey: ReadonlyMap<string, ResolvedEntityLink>
): string {
  const fromMap = entityLinkByKey.get(`${rev.entity_type}:${rev.entity_id}`);
  if (fromMap?.label) {
    return fromMap.label;
  }
  const payload = rev.after_json ?? rev.before_json;
  const fromPayload = pickPayloadString(payload, ['full_name', 'title', 'name', 'citation', 'caption']);
  if (fromPayload) {
    return fromPayload;
  }
  return `${ENTITY_SINGULAR_LABELS[rev.entity_type]} (${rev.entity_id})`;
}

function joinListPlainEnglish(items: readonly string[]): string {
  if (items.length === 0) {
    return '';
  }
  if (items.length === 1) {
    return items[0] ?? '';
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/**
 * Format a single revision as a plain-English headline suitable for family readers and stewards.
 */
export function formatRevisionHeadline(
  rev: RevisionRecord,
  entityLinkByKey: ReadonlyMap<string, ResolvedEntityLink>
): string {
  const targetName = resolveRevisionEntityName(rev, entityLinkByKey);
  const entityWord = ENTITY_SINGULAR_LABELS[rev.entity_type];

  switch (rev.action) {
    case 'create': {
      if (rev.entity_type === 'event') {
        const subjectName = resolvePrimaryParticipantName(rev.after_json, entityLinkByKey);
        if (subjectName && !targetName.toLowerCase().includes(subjectName.toLowerCase())) {
          return `Added event: ${targetName} for ${subjectName}`;
        }
      }
      return `Added ${entityWord}: ${targetName}`;
    }
    case 'update': {
      const diff = computeEntityDiff(rev.before_json, rev.after_json);
      const uniqueLabels: string[] = [];
      for (const field of diff.fields) {
        const label = formatFieldLabel(field.path).toLowerCase();
        if (!uniqueLabels.includes(label)) {
          uniqueLabels.push(label);
        }
      }
      if (uniqueLabels.length === 0) {
        return `Updated ${targetName}`;
      }
      if (uniqueLabels.length <= 3) {
        return `Updated ${joinListPlainEnglish(uniqueLabels)} for ${targetName}`;
      }
      const extraCount = uniqueLabels.length - 2;
      return `Updated ${uniqueLabels[0]}, ${uniqueLabels[1]}, and ${extraCount} other ${extraCount === 1 ? 'field' : 'fields'} for ${targetName}`;
    }
    case 'delete':
      return `Removed ${entityWord}: ${targetName}`;
    case 'restore':
      return `Restored ${entityWord}: ${targetName}`;
    case 'revert':
      return `Reverted an earlier edit on ${targetName}`;
    default: {
      const _exhaustive: never = rev.action;
      return _exhaustive;
    }
  }
}

export interface TouchedRecordLink {
  readonly key: string;
  readonly label: string;
  readonly to: string | null;
}

export interface BatchReportSummary {
  readonly headline: string;
  readonly touchedRecords: readonly TouchedRecordLink[];
  readonly totalTouchedCount: number;
  readonly batchReview: StewardReviewStamp | null;
}

/**
 * Aggregate a batch of revisions into a plain-English Research Field Report summary.
 */
export function formatBatchReportSummary(
  revisions: readonly RevisionRecord[],
  entityLinkByKey: ReadonlyMap<string, ResolvedEntityLink>
): BatchReportSummary {
  const counts = new Map<string, { entityType: EntityType; verb: string; count: number }>();
  const touchedByKey = new Map<string, { priority: number; record: TouchedRecordLink }>();

  for (const rev of revisions) {
    let verb = 'updated';
    if (rev.action === 'create') {
      verb = rev.entity_type === 'source' ? 'linked' : 'added';
    } else if (rev.action === 'delete') {
      verb = 'removed';
    } else if (rev.action === 'restore') {
      verb = 'restored';
    } else if (rev.action === 'revert') {
      verb = 'reverted';
    }
    const bucketKey = `${rev.entity_type}:${verb}`;
    const existing = counts.get(bucketKey);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(bucketKey, { entityType: rev.entity_type, verb, count: 1 });
    }

    const entityKey = `${rev.entity_type}:${rev.entity_id}`;
    if (!touchedByKey.has(entityKey)) {
      const resolved = entityLinkByKey.get(entityKey);
      const priority = rev.entity_type === 'person' ? 0 : rev.entity_type === 'place' ? 1 : 2;
      touchedByKey.set(entityKey, {
        priority,
        record: {
          key: entityKey,
          label: resolved?.label ?? resolveRevisionEntityName(rev, entityLinkByKey),
          to: resolved?.to ?? null,
        },
      });
    }
  }

  const phrases = [...counts.values()].map(({ entityType, verb, count }) => {
    const noun = count === 1 ? ENTITY_SINGULAR_LABELS[entityType] : ENTITY_PLURAL_LABELS[entityType];
    return `${count} ${noun} ${verb}`;
  });

  const headline =
    phrases.length > 0 ? `Research Field Report: ${phrases.join(', ')}` : 'Research Field Report: 0 changes';

  const sortedTouched = [...touchedByKey.values()]
    .toSorted((a, b) => a.priority - b.priority)
    .map((entry) => entry.record);

  const explicitBatchReview =
    revisions.find((r) => r.review && r.review.target_kind === 'batch')?.review ?? null;
  const allIndividuallyReviewed = revisions.length > 0 && revisions.every((r) => Boolean(r.review));
  const batchReview =
    explicitBatchReview ?? (allIndividuallyReviewed ? (revisions[0]?.review ?? null) : null);

  return {
    headline,
    touchedRecords: sortedTouched.slice(0, 4),
    totalTouchedCount: sortedTouched.length,
    batchReview,
  };
}

export interface DuplicateEventWarning {
  readonly key: string;
  readonly year: number;
  readonly personId: string;
  readonly personName: string;
  readonly personSlug: string | null;
  readonly firstEventId: string;
  readonly firstTitle: string;
  readonly secondEventId: string;
  readonly secondTitle: string;
}

interface CandidateEventRecord {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly year: number;
  readonly primaryPersonId: string;
}

function extractYearFromEdtf(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    return raw;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  const match = /^(\d{4})/.exec(raw.trim());
  return match ? Number(match[1]) : null;
}

function extractMilestoneStems(title: string): Set<string> {
  const stems = new Set<string>();
  MILESTONE_KEYWORD_RE.lastIndex = 0;
  let match = MILESTONE_KEYWORD_RE.exec(title);
  while (match !== null) {
    const mapped = match[1] ? MILESTONE_CANONICAL_MAP[match[1].toLowerCase()] : undefined;
    if (mapped) {
      stems.add(mapped);
    }
    match = MILESTONE_KEYWORD_RE.exec(title);
  }
  return stems;
}

function tokenizeTitle(title: string): Set<string> {
  const tokens = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function areLikelyDuplicateEvents(a: CandidateEventRecord, b: CandidateEventRecord): boolean {
  if (a.category.length > 0 && a.category === b.category) {
    return true;
  }
  const stemsA = extractMilestoneStems(a.title);
  const stemsB = extractMilestoneStems(b.title);
  for (const stem of stemsA) {
    if (stemsB.has(stem)) {
      return true;
    }
  }
  return jaccardSimilarity(tokenizeTitle(a.title), tokenizeTitle(b.title)) >= 0.6;
}

/**
 * Detect potential same-year duplicate events for a person and map warnings to the affected FeedGroups.
 */
export function detectDuplicateEventWarnings(
  groups: readonly FeedGroup[],
  bundle: ArchiveBundle | null
): Map<string, readonly DuplicateEventWarning[]> {
  const candidatesById = new Map<string, CandidateEventRecord>();
  const peopleById = new Map<string, { fullName: string; slug: string }>();

  if (bundle) {
    for (const p of bundle.people) {
      peopleById.set(p.id, { fullName: p.full_name, slug: p.slug });
    }
    for (const ev of bundle.events) {
      if (ev.scope !== 'personal' && ev.scope !== 'family') {
        continue;
      }
      const year = ev.year ?? extractYearFromEdtf(ev.edtf_date);
      const primaryPersonId = ev.participants[0]?.person_id;
      if (year === null || !primaryPersonId) {
        continue;
      }
      candidatesById.set(ev.id, {
        id: ev.id,
        title: ev.title || ev.id,
        category: (ev.category || '').trim().toLowerCase(),
        year,
        primaryPersonId,
      });
    }
  }

  for (const group of groups) {
    for (const rev of group.revisions) {
      if (rev.entity_type !== 'event' || (rev.action !== 'create' && rev.action !== 'update')) {
        continue;
      }
      if (candidatesById.has(rev.entity_id) || !rev.after_json) {
        continue;
      }
      const scope = rev.after_json['scope'];
      if (scope !== undefined && scope !== 'personal' && scope !== 'family') {
        continue;
      }
      const year = extractYearFromEdtf(rev.after_json['edtf_date'] ?? rev.after_json['year']);
      const participants = Array.isArray(rev.after_json['participants'])
        ? rev.after_json['participants']
        : [];
      const firstParticipant = participants[0];
      const primaryPersonId =
        typeof firstParticipant === 'object' &&
        firstParticipant !== null &&
        typeof (firstParticipant as Record<string, unknown>)['person_id'] === 'string'
          ? String((firstParticipant as Record<string, unknown>)['person_id'])
          : null;
      if (year === null || !primaryPersonId) {
        continue;
      }
      const title =
        typeof rev.after_json['title'] === 'string' && rev.after_json['title'].trim().length > 0
          ? rev.after_json['title'].trim()
          : rev.entity_id;
      const category =
        typeof rev.after_json['category'] === 'string' ? rev.after_json['category'].trim().toLowerCase() : '';
      candidatesById.set(rev.entity_id, {
        id: rev.entity_id,
        title,
        category,
        year,
        primaryPersonId,
      });
    }
  }

  const buckets = new Map<string, CandidateEventRecord[]>();
  for (const candidate of candidatesById.values()) {
    const bucketKey = `${candidate.primaryPersonId}:${candidate.year}`;
    const existing = buckets.get(bucketKey);
    if (existing) {
      existing.push(candidate);
    } else {
      buckets.set(bucketKey, [candidate]);
    }
  }

  const warningsByEventId = new Map<string, DuplicateEventWarning[]>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) {
      continue;
    }
    const sorted = bucket.toSorted((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const first = sorted[i];
        const second = sorted[j];
        if (!first || !second || !areLikelyDuplicateEvents(first, second)) {
          continue;
        }
        const person = peopleById.get(first.primaryPersonId);
        const warning: DuplicateEventWarning = {
          key: `${first.primaryPersonId}:${first.year}:${first.id}:${second.id}`,
          year: first.year,
          personId: first.primaryPersonId,
          personName: person?.fullName ?? first.primaryPersonId,
          personSlug: person?.slug ?? null,
          firstEventId: first.id,
          firstTitle: first.title,
          secondEventId: second.id,
          secondTitle: second.title,
        };
        for (const eventId of [first.id, second.id]) {
          const list = warningsByEventId.get(eventId);
          if (list) {
            list.push(warning);
          } else {
            warningsByEventId.set(eventId, [warning]);
          }
        }
      }
    }
  }

  const warningsByGroupKey = new Map<string, DuplicateEventWarning[]>();
  for (const group of groups) {
    const seen = new Set<string>();
    const attached: DuplicateEventWarning[] = [];
    for (const rev of group.revisions) {
      if (rev.entity_type !== 'event' || (rev.action !== 'create' && rev.action !== 'update')) {
        continue;
      }
      const list = warningsByEventId.get(rev.entity_id);
      if (!list) {
        continue;
      }
      for (const warning of list) {
        if (!seen.has(warning.key)) {
          seen.add(warning.key);
          attached.push(warning);
        }
      }
    }
    if (attached.length > 0) {
      warningsByGroupKey.set(group.key, attached);
    }
  }

  return warningsByGroupKey;
}
