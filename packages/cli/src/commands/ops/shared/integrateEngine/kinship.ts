import { type KinshipEdge, KinshipEdgeSchema } from '@kinloom/core';
import { CliValidationError } from '../../../../errors.js';
import { canonicalJsonStringify, isPlainObject } from './primitives.js';
import {
  type RemovedKinshipEdge,
  type RemoveKinshipEntry,
  type RemoveKinshipTarget,
  SAFE_PERSON_ID_RE,
  type UpsertCounts,
} from './types.js';

const ALLOWED_REMOVE_KINSHIP_KEYS = new Set(['from', 'to', 'relation', 'family_xref', 'symmetric']);

const RECIPROCAL_KINSHIP_RELATION: Record<KinshipEdge['relation'], KinshipEdge['relation']> = {
  parent: 'child',
  child: 'parent',
  spouse: 'spouse',
};

function isKinshipRelationValue(value: unknown): value is KinshipEdge['relation'] {
  return value === 'parent' || value === 'child' || value === 'spouse';
}

export function getReciprocalKinshipRelation(relation: KinshipEdge['relation']): KinshipEdge['relation'] {
  return RECIPROCAL_KINSHIP_RELATION[relation];
}

export function parseRemoveKinshipEntries(raw: unknown, label: string): RemoveKinshipEntry[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new CliValidationError(`${label} must be an array.`);
  }
  const entries: RemoveKinshipEntry[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const itemLabel = `${label}[${i}]`;
    const item = raw[i];
    if (!isPlainObject(item)) {
      throw new CliValidationError(`${itemLabel} must be a JSON object.`);
    }
    for (const key of Object.keys(item)) {
      if (!ALLOWED_REMOVE_KINSHIP_KEYS.has(key)) {
        throw new CliValidationError(`Unknown key '${key}' in ${itemLabel}.`);
      }
    }
    if (
      typeof item['from'] !== 'string' ||
      item['from'].length === 0 ||
      item['from'] !== item['from'].trim() ||
      !SAFE_PERSON_ID_RE.test(item['from'])
    ) {
      throw new CliValidationError(
        `${itemLabel}.from has invalid person_id '${String(item['from'])}'. Only ASCII letters, digits, _, and - are allowed.`
      );
    }
    if (
      typeof item['to'] !== 'string' ||
      item['to'].length === 0 ||
      item['to'] !== item['to'].trim() ||
      !SAFE_PERSON_ID_RE.test(item['to'])
    ) {
      throw new CliValidationError(
        `${itemLabel}.to has invalid person_id '${String(item['to'])}'. Only ASCII letters, digits, _, and - are allowed.`
      );
    }
    if (!isKinshipRelationValue(item['relation'])) {
      throw new CliValidationError(
        `${itemLabel}.relation must be 'parent', 'child', or 'spouse', got '${String(item['relation'])}'.`
      );
    }
    let familyXref: string | undefined;
    if (item['family_xref'] !== undefined) {
      if (typeof item['family_xref'] !== 'string' || item['family_xref'].trim().length === 0) {
        throw new CliValidationError(`${itemLabel}.family_xref must be a non-empty string when provided.`);
      }
      familyXref = item['family_xref'].trim();
    }
    let symmetric = true;
    if (item['symmetric'] !== undefined) {
      if (typeof item['symmetric'] !== 'boolean') {
        throw new CliValidationError(`${itemLabel}.symmetric must be a boolean when provided.`);
      }
      symmetric = item['symmetric'];
    }
    entries.push({
      from: item['from'],
      to: item['to'],
      relation: item['relation'],
      ...(familyXref !== undefined ? { family_xref: familyXref } : {}),
      symmetric,
    });
  }
  return entries;
}

export function expandRemoveKinshipTargets(entries: readonly RemoveKinshipEntry[]): RemoveKinshipTarget[] {
  const targets: RemoveKinshipTarget[] = [];
  const seen = new Set<string>();
  const pushTarget = (target: RemoveKinshipTarget): void => {
    const key = `${target.from}|${target.to}|${target.relation}|${target.family_xref ?? '*'}`;
    if (!seen.has(key)) {
      seen.add(key);
      targets.push(target);
    }
  };
  for (const entry of entries) {
    const xrefPart = entry.family_xref !== undefined ? { family_xref: entry.family_xref } : {};
    pushTarget({
      from: entry.from,
      to: entry.to,
      relation: entry.relation,
      ...xrefPart,
    });
    if (entry.symmetric) {
      pushTarget({
        from: entry.to,
        to: entry.from,
        relation: getReciprocalKinshipRelation(entry.relation),
        ...xrefPart,
      });
    }
  }
  return targets;
}

function matchesRemoveKinshipTarget(edge: KinshipEdge, target: RemoveKinshipTarget): boolean {
  if (edge.from !== target.from || edge.to !== target.to || edge.relation !== target.relation) {
    return false;
  }
  if (target.family_xref !== undefined) {
    return edge.family_xref === target.family_xref;
  }
  return true;
}

function normalizedXref(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function applyKinshipRemovals(
  existingList: readonly KinshipEdge[],
  entries: readonly RemoveKinshipEntry[],
  incomingList?: readonly KinshipEdge[]
): { remaining: KinshipEdge[]; removed: RemovedKinshipEdge[] } {
  if (entries.length === 0) {
    return {
      remaining: [...existingList],
      removed: [],
    };
  }
  const targets = expandRemoveKinshipTargets(entries);
  const incomingByExactKey = new Set<string>();
  for (const edge of incomingList ?? []) {
    incomingByExactKey.add(
      `${edge.from}|${edge.to}|${edge.relation}|${normalizedXref(edge.family_xref) ?? ''}`
    );
  }
  const remaining: KinshipEdge[] = [];
  const removed: RemovedKinshipEdge[] = [];
  for (const edge of existingList) {
    const matched = targets.some((target) => matchesRemoveKinshipTarget(edge, target));
    if (!matched) {
      remaining.push(edge);
      continue;
    }
    const exactKey = `${edge.from}|${edge.to}|${edge.relation}|${normalizedXref(edge.family_xref) ?? ''}`;
    if (incomingByExactKey.has(exactKey)) {
      remaining.push(edge);
      continue;
    }
    const xref = normalizedXref(edge.family_xref);
    removed.push({
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      ...(xref !== null ? { family_xref: xref } : {}),
    });
  }
  return { remaining, removed };
}

function upsertKinship(
  existingList: readonly KinshipEdge[],
  incomingList: readonly KinshipEdge[]
): { items: KinshipEdge[]; counts: UpsertCounts } {
  const result = [...existingList];
  if (incomingList.length === 0) {
    return { items: result, counts: { added: 0, updated: 0, unchanged: 0 } };
  }
  const keyOf = (edge: KinshipEdge): string => `${edge.from}|${edge.to}|${edge.relation}`;
  const idxByKey = new Map<string, number>();
  for (let i = 0; i < result.length; i += 1) {
    const item = result[i];
    if (item !== undefined) idxByKey.set(keyOf(item), i);
  }
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const incoming of incomingList) {
    const key = keyOf(incoming);
    const existingIdx = idxByKey.get(key);
    if (existingIdx === undefined) {
      idxByKey.set(key, result.length);
      result.push(incoming);
      added += 1;
      continue;
    }
    const prev = result[existingIdx];
    if (prev === undefined) continue;
    const merged = KinshipEdgeSchema.parse({
      ...prev,
      ...incoming,
      family_xref: incoming.family_xref !== undefined ? incoming.family_xref : prev.family_xref,
    });
    if (canonicalJsonStringify(prev) === canonicalJsonStringify(merged)) {
      unchanged += 1;
    } else {
      result[existingIdx] = merged;
      updated += 1;
    }
  }

  return { items: result, counts: { added, updated, unchanged } };
}

function verifyKinshipSymmetryForRemovedPairs(
  finalKinship: readonly KinshipEdge[],
  removeEntries: readonly RemoveKinshipEntry[]
): void {
  if (removeEntries.length === 0) {
    return;
  }
  const edgeByDirectedKey = new Map<string, KinshipEdge>();
  for (const edge of finalKinship) {
    edgeByDirectedKey.set(`${edge.from}|${edge.to}|${edge.relation}`, edge);
  }
  const orphaned: string[] = [];
  const checked = new Set<string>();
  for (const entry of removeEntries) {
    const forwardKey = `${entry.from}|${entry.to}|${entry.relation}`;
    const reciprocalRelation = getReciprocalKinshipRelation(entry.relation);
    const reciprocalKey = `${entry.to}|${entry.from}|${reciprocalRelation}`;
    const pairKey =
      forwardKey < reciprocalKey ? `${forwardKey}<>${reciprocalKey}` : `${reciprocalKey}<>${forwardKey}`;
    if (checked.has(pairKey)) {
      continue;
    }
    checked.add(pairKey);
    const forwardEdge = edgeByDirectedKey.get(forwardKey);
    const reciprocalEdge = edgeByDirectedKey.get(reciprocalKey);
    if (Boolean(forwardEdge) === Boolean(reciprocalEdge)) {
      continue;
    }
    const surviving = forwardEdge ?? reciprocalEdge;
    if (!surviving) {
      continue;
    }
    const missingKey = forwardEdge ? reciprocalKey : forwardKey;
    const xrefLabel =
      typeof surviving.family_xref === 'string' && surviving.family_xref.length > 0
        ? ` [family_xref=${surviving.family_xref}]`
        : '';
    orphaned.push(
      `surviving '${surviving.from} -> ${surviving.to} (${surviving.relation})'${xrefLabel} is missing reciprocal '${missingKey.replaceAll('|', ' -> ')}'`
    );
  }
  if (orphaned.length > 0) {
    throw new CliValidationError(
      `Asymmetric kinship graph after remove_kinship: ${orphaned.join('; ')}. ` +
        `Use symmetric: true (default), omit family_xref if inverse edges differ, or remove both directions explicitly.`
    );
  }
}

export function mergeKinshipPatch(
  existingKinship: readonly KinshipEdge[],
  rawPatchKinship: readonly unknown[],
  removeKinship: readonly RemoveKinshipEntry[]
): {
  items: KinshipEdge[];
  counts: UpsertCounts;
  removed: RemovedKinshipEdge[];
  parsedPatchKinship: KinshipEdge[];
} {
  const parsedPatchKinship = rawPatchKinship.map((rawEdge) => KinshipEdgeSchema.parse(rawEdge));
  const kinshipRemovals = applyKinshipRemovals(existingKinship, removeKinship, parsedPatchKinship);
  const kinshipMerge = upsertKinship(kinshipRemovals.remaining, parsedPatchKinship);
  verifyKinshipSymmetryForRemovedPairs(kinshipMerge.items, removeKinship);
  return {
    items: kinshipMerge.items,
    counts: kinshipMerge.counts,
    removed: kinshipRemovals.removed,
    parsedPatchKinship,
  };
}
