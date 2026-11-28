import { CORE_SCHEMA, load as loadYaml } from 'js-yaml';

const BAIL = Symbol('YAML_BAIL');
type BailOr<T> = T | typeof BAIL;

function atI32(buf: Int32Array, index: number): number {
  return buf[index] ?? 0;
}

const CORE_READER_KEYWORDS = new Set([
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

// Pre-internalized canonical Kinloom YAML mapping keys grouped by length to avoid
// allocating 30,000+ sliced key strings and dynamic V8 property key internalizations.
const KNOWN_YAML_KEYS = [
  'id',
  'to',
  'sex',
  'lat',
  'lng',
  'url',
  'ipa',
  'slug',
  'name',
  'from',
  'role',
  'kind',
  'file',
  'page',
  'note',
  'site',
  'wiki',
  'title',
  'scope',
  'brand',
  'theme',
  'branch',
  'author',
  'region',
  'accent',
  'surname',
  'summary',
  'sources',
  'body_md',
  'privacy',
  'plugins',
  'alt_names',
  'is_living',
  'edtf_date',
  'place_id',
  'citation',
  'relation',
  'language',
  'phonetic',
  'variants',
  'surnames',
  'full_name',
  'person_id',
  'source_id',
  'parent_id',
  'photo_url',
  'thumb_url',
  'date_edtf',
  'place_ids',
  'event_ids',
  'publisher',
  'event_id',
  'scan_url',
  'audio_url',
  'given_name',
  'birth_edtf',
  'death_edtf',
  'event_kind',
  'place_type',
  'confidence',
  'provenance',
  'person_ids',
  'source_ids',
  'repository',
  'updated_at',
  'extensions',
  'thumb_file',
  'poster_url',
  'scan_title',
  'source_url',
  'gedcom_xref',
  'family_xref',
  'source_type',
  'person_slug',
  'person_name',
  'portrait_url',
  'claimed_date',
  'source_label',
  'lineage_group',
  'severity_rank',
  'pronunciation',
  'photo_caption',
  'participants',
  'category',
  'mime_type',
  'pronunciations',
  'transcript_url',
  'citation_detail',
  'place_precision',
  'alternate_dates',
  'alternate_places',
  'historical_names',
  'duration_seconds',
  'subject_person_id',
  'has_primary_source',
  'photo_placeholder_caption',
] as const;

const KNOWN_KEYS_BY_LEN: readonly (readonly string[])[] = (() => {
  const buckets: string[][] = Array.from({ length: 28 }, () => []);
  for (const key of KNOWN_YAML_KEYS) {
    buckets[key.length]?.push(key);
  }
  return buckets;
})();

function internYamlKeySpan(text: string, start: number, end: number): string {
  const len = end - start;
  const bucket = len >= 2 ? KNOWN_KEYS_BY_LEN[len] : undefined;
  if (bucket && bucket.length > 0) {
    const c0 = text.charCodeAt(start);
    const cLast = text.charCodeAt(end - 1);
    for (const cand of bucket) {
      if (cand.charCodeAt(0) !== c0 || cand.charCodeAt(len - 1) !== cLast) {
        continue;
      }
      let match = true;
      for (let k = 1; k < len - 1; k += 1) {
        if (text.charCodeAt(start + k) !== cand.charCodeAt(k)) {
          match = false;
          break;
        }
      }
      if (match) {
        return cand;
      }
    }
  }
  return text.slice(start, end);
}

const HEX_RE = /^0x[0-9a-fA-F]+$/;
const OCT_RE = /^0o[0-7]+$/;
const FLOAT_RE = /^[+-]?(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?\d+[eE][+-]?\d+$/;

// Flat reusable line span buffer: triples of (indent, start, end)
let sharedSpanBuf: Int32Array = new Int32Array(32768 * 3);
let splitKeyOut = '';
let splitRestStartOut = 0;
let splitRestEndOut = 0;

function ensureSpanCapacity(lineIdx: number): Int32Array {
  const needed = (lineIdx + 1) * 3;
  if (needed <= sharedSpanBuf.length) {
    return sharedSpanBuf;
  }
  const next: Int32Array = new Int32Array(Math.max(needed, sharedSpanBuf.length * 2));
  next.set(sharedSpanBuf);
  sharedSpanBuf = next;
  return next;
}

function matchKeywordSpan(text: string, start: number, len: number): 0 | 1 | 2 | 3 {
  // 0 = none, 1 = null, 2 = true, 3 = false
  const c0 = text.charCodeAt(start);
  if (len === 1 && c0 === 126) {
    return 1; // ~
  }
  if (len === 4) {
    if (c0 === 110 || c0 === 78) {
      const s = text.slice(start, start + 4);
      if (s === 'null' || s === 'Null' || s === 'NULL') {
        return 1;
      }
    } else if (c0 === 116 || c0 === 84) {
      const s = text.slice(start, start + 4);
      if (s === 'true' || s === 'True' || s === 'TRUE') {
        return 2;
      }
    }
  } else if (len === 5 && (c0 === 102 || c0 === 70)) {
    const s = text.slice(start, start + 5);
    if (s === 'false' || s === 'False' || s === 'FALSE') {
      return 3;
    }
  }
  return 0;
}

function parseBlockScalarSpan(text: string, start: number, end: number): BailOr<unknown> {
  const len = end - start;
  if (len === 0) {
    return null;
  }
  const first = text.charCodeAt(start);

  if (first === 34) {
    if (len < 2 || text.charCodeAt(end - 1) !== 34) {
      return BAIL;
    }
    let hasEscape = false;
    for (let i = start + 1; i < end - 1; i += 1) {
      const c = text.charCodeAt(i);
      if (c === 92) {
        hasEscape = true;
        break;
      }
      if (c === 34 || c < 32) {
        return BAIL;
      }
    }
    if (!hasEscape) {
      return text.slice(start + 1, end - 1);
    }
    try {
      return JSON.parse(text.slice(start, end));
    } catch {
      return BAIL;
    }
  }

  if (
    first === 39 || // '
    first === 124 || // |
    first === 62 || // >
    first === 38 || // &
    first === 42 || // *
    first === 33 || // !
    first === 37 || // %
    first === 64 || // @
    first === 96 || // `
    first === 63 // ?
  ) {
    return BAIL;
  }

  if (first === 91) {
    return len === 2 && text.charCodeAt(start + 1) === 93 ? [] : BAIL;
  }
  if (first === 123) {
    return len === 2 && text.charCodeAt(start + 1) === 125 ? {} : BAIL;
  }

  const numStart = (first >= 48 && first <= 57) || first === 43 || first === 45 || first === 46;
  let allSignedDigits = numStart && first !== 46;
  let hasNumSpecial = first === 46;
  const digitStart = first === 43 || first === 45 ? start + 1 : start;
  if (digitStart >= end) {
    allSignedDigits = false;
  }

  for (let i = start; i < end; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 9) {
      return BAIL;
    }
    if (c === 35 && i > start && text.charCodeAt(i - 1) === 32) {
      return BAIL;
    }
    if (c === 58 && (i + 1 === end || text.charCodeAt(i + 1) === 32)) {
      return BAIL;
    }
    if (allSignedDigits && i >= digitStart && (c < 48 || c > 57)) {
      allSignedDigits = false;
    }
    if (numStart && (c === 46 || c === 101 || c === 69 || c === 120 || c === 88 || c === 111 || c === 79)) {
      hasNumSpecial = true;
    }
  }

  if (len <= 5) {
    const kw = matchKeywordSpan(text, start, len);
    if (kw === 1) {
      return null;
    }
    if (kw === 2) {
      return true;
    }
    if (kw === 3) {
      return false;
    }
  }

  if (allSignedDigits) {
    const dLen = end - digitStart;
    if (dLen === 1 || text.charCodeAt(digitStart) !== 48) {
      if (dLen <= 15) {
        let acc = 0;
        for (let i = digitStart; i < end; i += 1) {
          acc = acc * 10 + (text.charCodeAt(i) - 48);
        }
        if (acc === 0) {
          return 0;
        }
        return first === 45 ? -acc : acc;
      }
      const rawInt = text.slice(start, end);
      const parsed = Number(rawInt);
      return Number.isSafeInteger(parsed) ? parsed : BAIL;
    }
  }

  if (numStart && (hasNumSpecial || len <= 5)) {
    const raw = text.slice(start, end);
    if (FLOAT_RE.test(raw)) {
      const num = Number(raw);
      return num === 0 ? 0 : num;
    }
    if (HEX_RE.test(raw) || OCT_RE.test(raw)) {
      return BAIL;
    }
    if ((first === 46 || first === 43 || first === 45) && CORE_READER_KEYWORDS.has(raw)) {
      return BAIL;
    }
    return raw;
  }

  return text.slice(start, end);
}

function trySplitKeySpan(text: string, start: number, end: number): boolean {
  if (start >= end) {
    return false;
  }
  const first = text.charCodeAt(start);
  if (first === 34) {
    let i = start + 1;
    let hasEscape = false;
    while (i < end) {
      const c = text.charCodeAt(i);
      if (c === 92) {
        hasEscape = true;
        i += 2;
        continue;
      }
      if (c === 34) {
        break;
      }
      i += 1;
    }
    if (i >= end || i + 1 >= end || text.charCodeAt(i + 1) !== 58) {
      return false;
    }
    let restStart = i + 2;
    if (restStart < end && text.charCodeAt(restStart) !== 32) {
      return false;
    }
    while (restStart < end && text.charCodeAt(restStart) === 32) {
      restStart += 1;
    }
    if (!hasEscape) {
      splitKeyOut = internYamlKeySpan(text, start + 1, i);
    } else {
      try {
        splitKeyOut = JSON.parse(text.slice(start, i + 1)) as string;
      } catch {
        return false;
      }
    }
    splitRestStartOut = restStart;
    splitRestEndOut = end;
    return true;
  }

  if (
    first === 39 || // '
    first === 91 || // [
    first === 123 || // {
    first === 63 || // ?
    first === 38 || // &
    first === 42 || // *
    first === 33 // !
  ) {
    return false;
  }

  let colonIdx = -1;
  for (let i = start; i < end; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 9) {
      return false;
    }
    if (c === 58 && (i + 1 === end || text.charCodeAt(i + 1) === 32)) {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx <= start) {
    return false;
  }

  let keyEnd = colonIdx;
  while (keyEnd > start && text.charCodeAt(keyEnd - 1) === 32) {
    keyEnd -= 1;
  }
  if (keyEnd <= start) {
    return false;
  }
  if (keyEnd - start === 2 && text.charCodeAt(start) === 60 && text.charCodeAt(start + 1) === 60) {
    return false; // '<<'
  }
  const key = internYamlKeySpan(text, start, keyEnd);

  let restStart = colonIdx + 1;
  while (restStart < end && text.charCodeAt(restStart) === 32) {
    restStart += 1;
  }
  splitKeyOut = key;
  splitRestStartOut = restStart;
  splitRestEndOut = end;
  return true;
}

function isSequenceLine(text: string, start: number, end: number): boolean {
  if (text.charCodeAt(start) !== 45) {
    return false;
  }
  return end === start + 1 || text.charCodeAt(start + 1) === 32;
}

function tokenizeLineSpans(rawText: string): number {
  const len = rawText.length;
  let pos = 0;
  if (len > 0 && rawText.charCodeAt(0) === 0xfeff) {
    pos = 1;
  }

  let count = 0;
  let buf: Int32Array = sharedSpanBuf;

  while (pos < len) {
    let lineEnd = rawText.indexOf('\n', pos);
    if (lineEnd === -1) {
      lineEnd = len;
    }
    let trimEnd = lineEnd;
    if (trimEnd > pos && rawText.charCodeAt(trimEnd - 1) === 13) {
      trimEnd -= 1;
    }

    let indent = 0;
    let cur = pos;
    while (cur < trimEnd) {
      const c = rawText.charCodeAt(cur);
      if (c === 32) {
        indent += 1;
        cur += 1;
      } else if (c === 9) {
        return -1;
      } else {
        break;
      }
    }

    while (trimEnd > cur && rawText.charCodeAt(trimEnd - 1) === 32) {
      trimEnd -= 1;
    }

    if (cur < trimEnd && rawText.charCodeAt(cur) !== 35) {
      if (indent === 0) {
        const c0 = rawText.charCodeAt(cur);
        if (c0 === 37) {
          return -1; // %
        }
        const spanLen = trimEnd - cur;
        if (
          (c0 === 45 &&
            spanLen >= 3 &&
            rawText.charCodeAt(cur + 1) === 45 &&
            rawText.charCodeAt(cur + 2) === 45 &&
            (spanLen === 3 || rawText.charCodeAt(cur + 3) === 32)) ||
          (c0 === 46 &&
            spanLen >= 3 &&
            rawText.charCodeAt(cur + 1) === 46 &&
            rawText.charCodeAt(cur + 2) === 46 &&
            (spanLen === 3 || rawText.charCodeAt(cur + 3) === 32))
        ) {
          return -1;
        }
      }
      buf = ensureSpanCapacity(count);
      const base = count * 3;
      buf[base] = indent;
      buf[base + 1] = cur;
      buf[base + 2] = trimEnd;
      count += 1;
    }

    pos = lineEnd + 1;
  }

  return count;
}

function parseNodeSpanAt(
  text: string,
  buf: Int32Array,
  lineCount: number,
  cursor: { idx: number },
  expectedIndent: number
): BailOr<unknown> {
  if (cursor.idx >= lineCount) {
    return null;
  }
  const base = cursor.idx * 3;
  if (atI32(buf, base) !== expectedIndent) {
    return BAIL;
  }
  if (isSequenceLine(text, atI32(buf, base + 1), atI32(buf, base + 2))) {
    return parseSequenceSpanAt(text, buf, lineCount, cursor, expectedIndent);
  }
  return parseMappingSpanAt(text, buf, lineCount, cursor, expectedIndent, null, 0, 0);
}

function parseMappingEntryValueSpan(
  text: string,
  buf: Int32Array,
  lineCount: number,
  cursor: { idx: number },
  parentIndent: number,
  restStart: number,
  restEnd: number
): BailOr<unknown> {
  if (restStart < restEnd) {
    return parseBlockScalarSpan(text, restStart, restEnd);
  }
  if (cursor.idx >= lineCount) {
    return null;
  }
  const childIndent = atI32(buf, cursor.idx * 3);
  if (childIndent <= parentIndent) {
    return null;
  }
  return parseNodeSpanAt(text, buf, lineCount, cursor, childIndent);
}

function parseMappingSpanAt(
  text: string,
  buf: Int32Array,
  lineCount: number,
  cursor: { idx: number },
  mapIndent: number,
  initKey: string | null,
  initRestStart: number,
  initRestEnd: number
): BailOr<Record<string, unknown>> {
  const obj: Record<string, unknown> = {};

  if (initKey !== null) {
    if (initKey === '__proto__' || Object.hasOwn(obj, initKey)) {
      return BAIL;
    }
    const val = parseMappingEntryValueSpan(
      text,
      buf,
      lineCount,
      cursor,
      mapIndent,
      initRestStart,
      initRestEnd
    );
    if (val === BAIL) {
      return BAIL;
    }
    obj[initKey] = val;
  }

  while (cursor.idx < lineCount) {
    const base = cursor.idx * 3;
    const indent = atI32(buf, base);
    if (indent < mapIndent) {
      break;
    }
    if (indent > mapIndent) {
      return BAIL;
    }
    const start = atI32(buf, base + 1);
    const end = atI32(buf, base + 2);
    if (isSequenceLine(text, start, end)) {
      break;
    }
    if (!trySplitKeySpan(text, start, end)) {
      return BAIL;
    }
    const key = splitKeyOut;
    const restStart = splitRestStartOut;
    const restEnd = splitRestEndOut;
    if (key === '__proto__' || Object.hasOwn(obj, key)) {
      return BAIL;
    }
    cursor.idx += 1;
    const val = parseMappingEntryValueSpan(text, buf, lineCount, cursor, mapIndent, restStart, restEnd);
    if (val === BAIL) {
      return BAIL;
    }
    obj[key] = val;
  }

  return obj;
}

function parseSequenceSpanAt(
  text: string,
  buf: Int32Array,
  lineCount: number,
  cursor: { idx: number },
  seqIndent: number
): BailOr<unknown[]> {
  const arr: unknown[] = [];

  while (cursor.idx < lineCount) {
    const base = cursor.idx * 3;
    const indent = atI32(buf, base);
    if (indent < seqIndent) {
      break;
    }
    if (indent > seqIndent) {
      return BAIL;
    }
    const start = atI32(buf, base + 1);
    const end = atI32(buf, base + 2);
    if (!isSequenceLine(text, start, end)) {
      break;
    }

    cursor.idx += 1;
    if (end === start + 1) {
      const nextIndent = atI32(buf, cursor.idx * 3);
      if (cursor.idx >= lineCount || nextIndent <= seqIndent) {
        arr.push(null);
      } else {
        const nested = parseNodeSpanAt(text, buf, lineCount, cursor, nextIndent);
        if (nested === BAIL) {
          return BAIL;
        }
        arr.push(nested);
      }
      continue;
    }

    let afterDashStart = start + 2;
    if (text.charCodeAt(afterDashStart) !== 34 || text.indexOf('":', afterDashStart) < end) {
      if (trySplitKeySpan(text, afterDashStart, end)) {
        const key = splitKeyOut;
        const restStart = splitRestStartOut;
        const restEnd = splitRestEndOut;
        const mapped = parseMappingSpanAt(text, buf, lineCount, cursor, indent + 2, key, restStart, restEnd);
        if (mapped === BAIL) {
          return BAIL;
        }
        arr.push(mapped);
        continue;
      }
    }

    while (afterDashStart < end && text.charCodeAt(afterDashStart) === 32) {
      afterDashStart += 1;
    }
    const scalar = parseBlockScalarSpan(text, afterDashStart, end);
    if (scalar === BAIL) {
      return BAIL;
    }
    if (cursor.idx < lineCount && atI32(buf, cursor.idx * 3) > seqIndent) {
      return BAIL;
    }
    arr.push(scalar);
  }

  return arr;
}

export function parseYamlFast(text: string): unknown {
  const lineCount = tokenizeLineSpans(text);
  if (lineCount >= 0) {
    if (lineCount === 0) {
      return null;
    }
    const buf = sharedSpanBuf;
    const indent0 = atI32(buf, 0);
    if (lineCount === 1 && indent0 === 0) {
      const s0 = atI32(buf, 1);
      const e0 = atI32(buf, 2);
      const len = e0 - s0;
      if (len === 2) {
        const c0 = text.charCodeAt(s0);
        const c1 = text.charCodeAt(s0 + 1);
        if (c0 === 91 && c1 === 93) {
          return [];
        }
        if (c0 === 123 && c1 === 125) {
          return {};
        }
      }
      if (!isSequenceLine(text, s0, e0) && !trySplitKeySpan(text, s0, e0)) {
        const singleScalar = parseBlockScalarSpan(text, s0, e0);
        if (singleScalar !== BAIL) {
          return singleScalar;
        }
      }
    }
    const cursor = { idx: 0 };
    const parsed = parseNodeSpanAt(text, buf, lineCount, cursor, indent0);
    if (parsed !== BAIL && cursor.idx === lineCount) {
      return parsed;
    }
  }
  return loadYaml(text, { schema: CORE_SCHEMA }) ?? null;
}
