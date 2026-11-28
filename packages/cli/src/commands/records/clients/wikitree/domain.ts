import { CliValidationError } from '../../../../errors.js';
import { isPlainRecord, resolveEnvCacheTtlHours } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const DEFAULT_FIELDS = 'Id,Name,FirstName,LastNameAtBirth,BirthDate,DeathDate,BirthLocation';

const WIKITREE_URL_RE = /^https?:\/\/(?:www\.)?wikitree\.com\/wiki\/([^/?#]+)(?:[?#].*)?$/i;

export type WikiTreeRecord = Record<string, unknown>;

export interface WrappedWikiTreeData {
  readonly data: unknown[];
}

export function normalizeProfileKey(raw: string): string {
  const cleaned = raw.trim();
  const match = WIKITREE_URL_RE.exec(cleaned);
  return match?.[1] ?? cleaned;
}

export function resolveSearchName(
  queryParts: readonly string[],
  fullName: string | undefined,
  firstName: string | undefined,
  lastName: string | undefined
): readonly [string | undefined, string | undefined] {
  const posTokens = queryParts.flatMap((part) => part.trim().split(/\s+/)).filter((tok) => tok.length > 0);
  const nameTokens = (fullName ?? '')
    .trim()
    .split(/\s+/)
    .filter((tok) => tok.length > 0);

  if (posTokens.length > 0 && nameTokens.length > 0) {
    throw new CliValidationError('Pass either positional name arguments or --name, not both.');
  }
  const tokens = nameTokens.length > 0 ? nameTokens : posTokens;
  if (tokens.length === 0) {
    return [firstName, lastName];
  }
  if (firstName && lastName) {
    throw new CliValidationError('Pass either positional name / --name or --first/--last, not both.');
  }
  if (firstName && !lastName) {
    return [firstName, tokens.join(' ')];
  }
  if (lastName && !firstName) {
    return [tokens.join(' '), lastName];
  }
  if (tokens.length === 1) {
    return [undefined, tokens[0]];
  }
  return [tokens.slice(0, -1).join(' '), tokens[tokens.length - 1]];
}

export function checkStatus(data: readonly unknown[], label: string): WikiTreeRecord {
  if (data.length === 0 || !isPlainRecord(data[0])) {
    throw new RecordRuntimeError(`${label}: empty response from WikiTree API`);
  }
  const first = data[0];
  const status = first['status'] ?? 0;
  if (status !== 0 && status !== '') {
    throw new RecordRuntimeError(`${label}: ${String(status)}`);
  }
  return first;
}

export function isWrappedWikiTreeData(value: unknown): value is WrappedWikiTreeData {
  return isPlainRecord(value) && Array.isArray(value['data']);
}

export function jsonWithCacheHit(data: readonly unknown[], hit: boolean): unknown[] {
  if (data.length > 0 && isPlainRecord(data[0])) {
    return [{ ...data[0], cache_hit: hit }, ...data.slice(1)];
  }
  return [...data];
}

export function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_WIKITREE_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export function formatPersonLine(person: WikiTreeRecord): string {
  const name = String(person['Name'] ?? person['Id'] ?? '?');
  const first = String(person['FirstName'] ?? '');
  const last = String(person['LastNameAtBirth'] ?? person['LastNameCurrent'] ?? '');
  const rawBirth = String(person['BirthDate'] ?? '');
  const rawDeath = String(person['DeathDate'] ?? '');
  const birth = rawBirth === '' || rawBirth === '0000-00-00' ? '' : rawBirth;
  const death = rawDeath === '' || rawDeath === '0000-00-00' ? '' : rawDeath;
  const place = String(person['BirthLocation'] ?? '');
  let dates = birth ? `b. ${birth}` : 'b. ?';
  if (death) {
    dates += ` d. ${death}`;
  }
  let line = `${name}: ${first} ${last} (${dates})`;
  if (place) {
    line += `, born ${place}`;
  }
  return line.trim();
}

export function formatSearchText(first: WikiTreeRecord, cacheHit: boolean): string {
  const matches = Array.isArray(first['matches']) ? first['matches'].filter(isPlainRecord) : [];
  const total = typeof first['total'] === 'number' ? first['total'] : matches.length;
  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${total} match(es), showing ${matches.length}:${marker}`];
  for (const match of matches) {
    if ('Name' in match || 'FirstName' in match) {
      lines.push(formatPersonLine(match));
    } else {
      lines.push(
        `Id ${String(match['Id'] ?? '?')}: sparse match, run \`person ${String(match['Id'] ?? '?')}\` for details`
      );
    }
  }
  return lines.join('\n');
}

export function formatPersonText(
  first: WikiTreeRecord,
  key: string,
  bioFormat: string | undefined,
  cacheHit: boolean
): string {
  const profileRaw = first['person'] ?? first['profile'];
  if (!isPlainRecord(profileRaw)) {
    throw new RecordRuntimeError(`getPerson ${key}: no profile returned`);
  }
  const lines: string[] = [`${formatPersonLine(profileRaw)}${cacheHit ? ' [cache]' : ''}`];
  if (bioFormat && typeof profileRaw['Bio'] === 'string' && profileRaw['Bio'].length > 0) {
    lines.push(profileRaw['Bio']);
  }
  return lines.join('\n');
}

export function formatAncestorsText(
  first: WikiTreeRecord,
  key: string,
  depth: number,
  cacheHit: boolean
): string {
  const people = isPlainRecord(first['people']) ? first['people'] : {};
  const resultByKey = isPlainRecord(first['resultByKey']) ? first['resultByKey'] : {};
  const subject = isPlainRecord(resultByKey[key]) ? resultByKey[key] : {};
  const subjectId = String(subject['Id'] ?? '');
  const profiles: WikiTreeRecord[] = [];
  for (const [pid, person] of Object.entries(people)) {
    if (pid !== subjectId && isPlainRecord(person)) {
      profiles.push(person);
    }
  }
  profiles.sort((a, b) => {
    const bdA = String(a['BirthDate'] || '9999');
    const bdB = String(b['BirthDate'] || '9999');
    if (bdA !== bdB) return bdA.localeCompare(bdB);
    return String(a['Name'] || '').localeCompare(String(b['Name'] || ''));
  });

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `${profiles.length} ancestor(s) within ${depth} generation(s) of ${key}:${marker}`,
    ...profiles.map(formatPersonLine),
  ];
  return lines.join('\n');
}

export function formatBioText(first: WikiTreeRecord, cacheHit: boolean): string {
  const text = typeof first['bio'] === 'string' ? first['bio'] : '';
  return text ? text : `(no biography text returned)${cacheHit ? ' [cache]' : ''}`;
}
