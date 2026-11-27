interface WordTokenPrefilter {
  readonly caseInsensitive: boolean;
  readonly minLen: number;
  readonly bloomBits: Uint8Array;
  readonly wordHashes: ReadonlySet<number>;
}

const prefilters = new WeakMap<RegExp, WordTokenPrefilter>();

function isAsciiWordCode(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
}

function hashAsciiWordSpan(text: string, start: number, end: number, caseInsensitive: boolean): number {
  let h = 0x811c9dc5;
  for (let i = start; i < end; i += 1) {
    let c = text.charCodeAt(i);
    if (caseInsensitive && c >= 65 && c <= 90) {
      c |= 32;
    }
    h ^= c;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Attach a zero-false-negative first-word FNV-1a Bloom + hash-set prefilter to a compiled
 * word-bounded alternation RegExp `/(?<![\p{L}\p{N}_])(?:...)(?![\p{L}\p{N}_])/u`.
 *
 * Every registered name must begin with >= 2 ASCII word characters (`[A-Za-z0-9_]`) followed by
 * either end-of-string or an ASCII non-word character (`< 128`). On pure-ASCII input texts, any
 * RegExp match must begin at an exact maximal ASCII word token matching one of those first words.
 * Texts containing any non-ASCII code point (`>= 128`) conservatively return `true`.
 */
export function registerPatternPrefilter(
  pattern: RegExp,
  names: readonly string[],
  caseInsensitive: boolean
): void {
  if (names.length === 0) {
    return;
  }

  let minLen = Infinity;
  const bloomBits = new Uint8Array(512); // 4096 bits
  const wordHashes = new Set<number>();

  for (let i = 0; i < names.length; i += 1) {
    const s = names[i];
    if (s.length < 2 || !isAsciiWordCode(s.charCodeAt(0))) {
      return;
    }
    let wEnd = 1;
    while (wEnd < s.length && isAsciiWordCode(s.charCodeAt(wEnd))) {
      wEnd += 1;
    }
    if (wEnd < 2 || (wEnd < s.length && s.charCodeAt(wEnd) >= 128)) {
      return;
    }
    if (s.length < minLen) {
      minLen = s.length;
    }
    const h = hashAsciiWordSpan(s, 0, wEnd, caseInsensitive);
    wordHashes.add(h);
    const bit1 = h & 4095;
    const bit2 = (h >>> 12) & 4095;
    bloomBits[bit1 >>> 3] |= 1 << (bit1 & 7);
    bloomBits[bit2 >>> 3] |= 1 << (bit2 & 7);
  }

  prefilters.set(pattern, {
    caseInsensitive,
    minLen,
    bloomBits,
    wordHashes,
  });
}

/**
 * Returns `false` only when `text` is guaranteed NOT to match `pattern`.
 */
export function mayMatchPattern(pattern: RegExp, text: string): boolean {
  const pf = prefilters.get(pattern);
  if (!pf) {
    return true;
  }
  const len = text.length;
  if (len < pf.minLen) {
    return false;
  }

  const { caseInsensitive, bloomBits, wordHashes } = pf;
  let hasCandidate = false;
  let i = 0;

  while (i < len) {
    const c = text.charCodeAt(i);
    if (c >= 128) {
      return true;
    }
    if (isAsciiWordCode(c)) {
      let h = 0x811c9dc5;
      let ch = c;
      if (caseInsensitive && ch >= 65 && ch <= 90) {
        ch |= 32;
      }
      h ^= ch;
      h = Math.imul(h, 0x01000193);

      let j = i + 1;
      let tokLen = 1;
      while (j < len) {
        const nc = text.charCodeAt(j);
        if (nc >= 128) {
          return true;
        }
        if (!isAsciiWordCode(nc)) {
          break;
        }
        let folded = nc;
        if (caseInsensitive && folded >= 65 && folded <= 90) {
          folded |= 32;
        }
        h ^= folded;
        h = Math.imul(h, 0x01000193);
        j += 1;
        tokLen += 1;
      }

      if (!hasCandidate && tokLen >= 2) {
        const uh = h >>> 0;
        const bit1 = uh & 4095;
        if ((bloomBits[bit1 >>> 3] & (1 << (bit1 & 7))) !== 0) {
          const bit2 = (uh >>> 12) & 4095;
          if ((bloomBits[bit2 >>> 3] & (1 << (bit2 & 7))) !== 0 && wordHashes.has(uh)) {
            hasCandidate = true;
          }
        }
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }

  return hasCandidate;
}
