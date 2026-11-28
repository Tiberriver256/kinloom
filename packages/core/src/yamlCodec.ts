import { stringify as stringifyYamlRaw } from 'yaml';
import { fastLocaleCompare } from './fastCompare.js';

export { parseYamlFast } from './yamlReader.js';

const rankMapCache = new WeakMap<readonly string[], ReadonlyMap<string, number>>();
const INDENTS: string[] = Array.from({ length: 32 }, (_, i) => '  '.repeat(i));

function getIndent(depth: number): string {
  return INDENTS[depth] ?? '  '.repeat(depth);
}

export function getRankMap(order?: readonly string[]): ReadonlyMap<string, number> | undefined {
  if (!order || order.length === 0) {
    return undefined;
  }
  let cached = rankMapCache.get(order);
  if (!cached) {
    const map = new Map<string, number>();
    order.forEach((key, i) => {
      map.set(key, i);
    });
    cached = map;
    rankMapCache.set(order, cached);
  }
  return cached;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const CORE_KEYWORDS = new Set([
  'null',
  'Null',
  'NULL',
  '~',
  'true',
  'True',
  'TRUE',
  'false',
  'False',
  'FALSE',
  '.nan',
  '.NaN',
  '.NAN',
  '.inf',
  '.Inf',
  '.INF',
  '+.inf',
  '+.Inf',
  '+.INF',
  '-.inf',
  '-.Inf',
  '-.INF',
]);

// Match YAML 1.2 Core Schema numeric tokens (plus underscore/hex/octal/binary forms) on the full scalar,
// leaving prose strings like "1890 Cedar County Directory Listing" unquoted just like `yaml` stringify.
const NUMERIC_LIKE_RE =
  /^(?:[-+]?(?:[0-9][0-9_]*|[0-9_]*\.[0-9_]+|[0-9_]+\.)(?:[eE][-+]?[0-9]+)?|0[xXoObB][0-9a-fA-F_]+)$/;

function isSafeUnquotedString(val: string, maxLen: number): boolean {
  const len = val.length;
  if (len === 0 || len > maxLen) {
    return false;
  }
  const first = val.charCodeAt(0);
  if (
    CORE_KEYWORDS.has(val) ||
    (((first >= 48 && first <= 57) || first === 43 || first === 45 || first === 46) &&
      NUMERIC_LIKE_RE.test(val))
  ) {
    return false;
  }
  const last = val.charCodeAt(len - 1);
  if (
    first <= 32 ||
    last <= 32 ||
    first === 45 || // -
    first === 63 || // ?
    first === 58 || // :
    first === 33 || // !
    first === 38 || // &
    first === 42 || // *
    first === 37 || // %
    first === 64 || // @
    first === 96 || // `
    first === 124 || // |
    first === 62 || // >
    first === 39 || // '
    first === 34 || // "
    first === 91 || // [
    first === 93 || // ]
    first === 123 || // {
    first === 125 || // }
    first === 44 || // ,
    first === 35 // #
  ) {
    return false;
  }
  for (let i = 0; i < len; i += 1) {
    const c = val.charCodeAt(i);
    if (
      c < 32 ||
      c === 127 ||
      c === 58 || // :
      c === 35 || // #
      c === 91 || // [
      c === 93 || // ]
      c === 123 || // {
      c === 125 || // }
      c === 34 || // "
      c === 92 || // \
      (c >= 0xd800 && c <= 0xdfff)
    ) {
      return false;
    }
  }
  return true;
}

const SAFE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function formatYamlKey(key: string): string {
  if (SAFE_KEY_RE.test(key) && !CORE_KEYWORDS.has(key)) {
    return key;
  }
  return JSON.stringify(key);
}

function formatYamlScalar(val: string | number | boolean | null, maxPlainLen: number): string | null {
  if (val === null) {
    return 'null';
  }
  if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || Object.is(val, -0)) {
      return null;
    }
    return String(val);
  }
  if (isSafeUnquotedString(val, maxPlainLen)) {
    return val;
  }
  return JSON.stringify(val);
}

function getSortedDefinedKeys(obj: Record<string, unknown>, rankMap?: ReadonlyMap<string, number>): string[] {
  const keys: string[] = [];
  for (const k of Object.keys(obj)) {
    if (obj[k] !== undefined) {
      keys.push(k);
    }
  }
  if (keys.length <= 1) {
    return keys;
  }
  if (rankMap) {
    keys.sort((a, b) => {
      const ra = rankMap.get(a);
      const rb = rankMap.get(b);
      if (ra !== undefined && rb !== undefined) {
        return ra - rb;
      }
      if (ra !== undefined) {
        return -1;
      }
      if (rb !== undefined) {
        return 1;
      }
      return fastLocaleCompare(a, b);
    });
  } else {
    keys.sort(fastLocaleCompare);
  }
  return keys;
}

function emitMappingLines(
  obj: Record<string, unknown>,
  depth: number,
  firstLinePrefix: string | null,
  rankMap: ReadonlyMap<string, number> | undefined,
  maxPlainLen: number,
  lines: string[]
): boolean {
  const keys = getSortedDefinedKeys(obj, rankMap);
  if (keys.length === 0) {
    lines.push(firstLinePrefix !== null ? `${firstLinePrefix}{}` : `${getIndent(depth)}{}`);
    return true;
  }

  const baseIndent = getIndent(depth);
  let isFirst = true;
  for (const k of keys) {
    const v = obj[k];
    const prefix = isFirst && firstLinePrefix !== null ? firstLinePrefix : baseIndent;
    isFirst = false;
    const formattedKey = formatYamlKey(k);

    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const scalar = formatYamlScalar(v, maxPlainLen);
      if (scalar === null) {
        return false;
      }
      lines.push(`${prefix}${formattedKey}: ${scalar}`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${prefix}${formattedKey}: []`);
      } else {
        lines.push(`${prefix}${formattedKey}:`);
        if (!emitSequenceLines(v, depth + 1, undefined, maxPlainLen, lines)) {
          return false;
        }
      }
    } else if (isPlainObject(v)) {
      const subKeys = getSortedDefinedKeys(v, undefined);
      if (subKeys.length === 0) {
        lines.push(`${prefix}${formattedKey}: {}`);
      } else {
        lines.push(`${prefix}${formattedKey}:`);
        if (!emitMappingLines(v, depth + 1, null, undefined, maxPlainLen, lines)) {
          return false;
        }
      }
    } else {
      return false;
    }
  }
  return true;
}

function emitSequenceLines(
  arr: readonly unknown[],
  depth: number,
  itemRankMap: ReadonlyMap<string, number> | undefined,
  maxPlainLen: number,
  lines: string[]
): boolean {
  if (arr.length === 0) {
    lines.push(`${getIndent(depth)}[]`);
    return true;
  }
  const indent = getIndent(depth);
  const itemPrefix = `${indent}- `;

  for (const item of arr) {
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      const scalar = formatYamlScalar(item, maxPlainLen);
      if (scalar === null) {
        return false;
      }
      lines.push(`${itemPrefix}${scalar}`);
    } else if (isPlainObject(item)) {
      if (!emitMappingLines(item, depth + 1, itemPrefix, itemRankMap, maxPlainLen, lines)) {
        return false;
      }
    } else if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${itemPrefix}[]`);
      } else {
        lines.push(`${indent}-`);
        if (!emitSequenceLines(item, depth + 1, undefined, maxPlainLen, lines)) {
          return false;
        }
      }
    } else {
      return false;
    }
  }
  return true;
}

function canonicalizeFallback(value: unknown, rankMap?: ReadonlyMap<string, number>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeFallback(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const keys = getSortedDefinedKeys(value, rankMap);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = canonicalizeFallback(value[k]);
  }
  return out;
}

export function emitCanonicalYaml(
  value: unknown,
  options?: { preferredKeyOrder?: readonly string[] | undefined; lineWidth?: number | undefined }
): string {
  const lineWidth = options?.lineWidth ?? 110;
  const maxPlainLen = Math.max(40, lineWidth - 16);
  const rankMap = getRankMap(options?.preferredKeyOrder);
  const lines: string[] = [];

  if (Array.isArray(value)) {
    if (emitSequenceLines(value, 0, rankMap, maxPlainLen, lines)) {
      return `${lines.join('\n')}\n`;
    }
  } else if (isPlainObject(value)) {
    if (emitMappingLines(value, 0, null, rankMap, maxPlainLen, lines)) {
      return `${lines.join('\n')}\n`;
    }
  } else if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    const scalar = formatYamlScalar(value, maxPlainLen);
    if (scalar !== null) {
      return `${scalar}\n`;
    }
  }

  const canonical = Array.isArray(value)
    ? value.map((item) => canonicalizeFallback(item, rankMap))
    : canonicalizeFallback(value, rankMap);
  return stringifyYamlRaw(canonical, {
    lineWidth,
    minContentWidth: 20,
    singleQuote: false,
  });
}
