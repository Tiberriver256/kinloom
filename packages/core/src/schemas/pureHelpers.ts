/**
 * Zero-dependency pure schema helpers and static defaults so browser reader bundles
 * can import domain projections without pulling Zod schema definitions into initial load.
 */

export type PureEntityType = 'person' | 'event' | 'place' | 'source' | 'media' | 'narrative' | 'kinship_edge';

export type PureEntityPayload = Record<string, unknown>;

export interface PureMigrationEraConfig {
  id: string;
  label: string;
  description?: string;
  color?: string;
  minLat?: number;
  maxLat?: number;
  minLng?: number;
  maxLng?: number;
  startYear?: number;
  endYear?: number;
}

export interface PureAnchorYearConfig {
  year: number;
  label: string;
}

export const DEFAULT_MIGRATION_ERAS: readonly PureMigrationEraConfig[] = [
  { id: 'europe', label: 'Europe', minLng: -20 },
  { id: 'eastern', label: 'Eastern Seaboard', minLng: -82, maxLng: -20 },
  { id: 'interior', label: 'Interior Frontier', minLng: -108, maxLng: -82, minLat: 36.5 },
  { id: 'southern', label: 'Southern Plains', minLng: -108, maxLng: -82, maxLat: 36.5 },
  { id: 'western', label: 'Pacific West', maxLng: -108 },
];

export const DEFAULT_ANCHOR_YEARS: readonly PureAnchorYearConfig[] = [
  { year: 1620, label: '1620' },
  { year: 1665, label: '1665' },
  { year: 1715, label: '1715' },
  { year: 1776, label: '1776' },
  { year: 1850, label: '1850' },
  { year: 1880, label: '1880' },
  { year: 1900, label: '1900' },
  { year: 1910, label: '1910' },
  { year: 1920, label: '1920' },
  { year: 1930, label: '1930' },
  { year: 1940, label: '1940' },
  { year: 1955, label: '1955' },
];

export function resolveDefaultBranchId(
  config?: {
    readonly defaultBranchId?: string;
    readonly branches: readonly { readonly id: string }[];
  } | null
): string {
  if (!config) {
    return 'primary';
  }
  if (config.defaultBranchId) {
    return config.defaultBranchId;
  }
  if (config.branches.length > 0) {
    return config.branches[0].id;
  }
  return 'primary';
}

/**
 * Returns every person ID linked to a media item across both `person_ids` and legacy `person_id`.
 */
export function getMediaPersonIds(item: {
  readonly person_id?: string | null;
  readonly person_ids?: readonly string[];
}): string[] {
  const pids = item.person_ids;
  if (!pids || pids.length === 0) {
    return item.person_id ? [item.person_id] : [];
  }
  if (!item.person_id && pids.length === 1) {
    return pids[0] ? [pids[0]] : [];
  }
  if (item.person_id && pids.length === 1 && pids[0] === item.person_id) {
    return [item.person_id];
  }
  const ids = new Set<string>();
  if (item.person_id) {
    ids.add(item.person_id);
  }
  for (let i = 0; i < pids.length; i += 1) {
    const id = pids[i];
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

export const ENTITY_ID_PREFIX: Readonly<Record<Exclude<PureEntityType, 'kinship_edge'>, string>> = {
  person: 'per',
  event: 'evt',
  place: 'plc',
  source: 'src',
  media: 'med',
  narrative: 'nar',
};

export function buildEntityId(entityType: Exclude<PureEntityType, 'kinship_edge'>, suffix: string): string {
  return `${ENTITY_ID_PREFIX[entityType]}_${suffix}`;
}

export function toEntityPayload<T extends object>(entity: T): PureEntityPayload {
  return { ...(entity as PureEntityPayload) };
}

export function deriveKinshipEdgeId(edge: {
  readonly from: string;
  readonly relation: string;
  readonly to: string;
}): string {
  return `${edge.from}:${edge.relation}:${edge.to}`;
}
