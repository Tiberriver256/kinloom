const trustedArchiveBundles = new WeakSet<object>();

export function markTrustedArchiveBundle(bundle: object): void {
  trustedArchiveBundles.add(bundle);
}

export function isTrustedArchiveBundle(value: unknown): boolean {
  return typeof value === 'object' && value !== null && trustedArchiveBundles.has(value);
}

/**
 * Fast locale-equivalent comparator for ASCII identifiers and labels.
 * When the first differing code unit is both ASCII lowercase `[a-z]` or both ASCII digits `[0-9]`
 * (and not followed by a non-ASCII combining mark), UCA primary collation order matches code-unit order.
 * Falls back to `a.localeCompare(b)` on case differences, punctuation, or non-ASCII characters.
 */
export function fastLocaleCompare(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const lenA = a.length;
  const lenB = b.length;
  const minLen = Math.min(lenA, lenB);
  for (let i = 0; i < minLen; i += 1) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca === cb) {
      if (ca >= 128) {
        return a.localeCompare(b);
      }
      continue;
    }
    const bothLowerAlpha = ca >= 97 && ca <= 122 && cb >= 97 && cb <= 122;
    const bothDigits = ca >= 48 && ca <= 57 && cb >= 48 && cb <= 57;
    if (bothLowerAlpha || bothDigits) {
      const nextA = i + 1 < lenA ? a.charCodeAt(i + 1) : 0;
      const nextB = i + 1 < lenB ? b.charCodeAt(i + 1) : 0;
      if (nextA < 128 && nextB < 128) {
        return ca < cb ? -1 : 1;
      }
    }
    return a.localeCompare(b);
  }
  // One string is an exact ASCII prefix of the other.
  return lenA < lenB ? -1 : 1;
}
