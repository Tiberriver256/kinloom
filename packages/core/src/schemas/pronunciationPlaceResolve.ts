import {
  getPlaceQualifierSegments,
  isBareLexiconEntryCompatibleWithPlace,
  splitPlaceSegments,
} from './pronunciationGeo.js';
import { mergePronunciationEntry } from './pronunciationPhonetics.js';
import type { Pronunciation } from './pronunciationSchema.js';

/**
 * Resolve a place's effective pronunciation in strict specificity order:
 * 1. Explicit `place.pronunciation` on the place record itself
 * 2. `lexicon[place.id]` (exact place ID key)
 * 3. `lexicon[place.full_name]` (case-insensitive qualified name, including matching
 *    qualified keys such as "Zeeland, Michigan" for "Zeeland, Ottawa County, Michigan, United States")
 * 4. Bare `lexicon[place.name]` only when region, `match_full_name_contains`, and language
 *    do not conflict with the place's country/region scope.
 */
export function resolvePlacePronunciation(
  place: {
    readonly id?: string;
    readonly name?: string;
    readonly full_name?: string;
    readonly pronunciation?: Pronunciation | null;
  },
  lexicon?: Readonly<Record<string, Pronunciation>> | null
): Pronunciation | null {
  let shared: Pronunciation | undefined;

  if (lexicon) {
    const idKey = place.id?.trim();
    if (idKey && lexicon[idKey]) {
      shared = lexicon[idKey];
    }

    const fullNameKey = place.full_name?.trim();
    if (!shared && fullNameKey) {
      shared =
        lexicon[fullNameKey] ??
        Object.entries(lexicon).find(([k]) => k.toLowerCase() === fullNameKey.toLowerCase())?.[1];
    }

    const nameKey = place.name?.trim();
    if (!shared && nameKey && fullNameKey) {
      const nameLower = nameKey.toLowerCase();
      const qualifierSegments = getPlaceQualifierSegments(place).map((s) => s.toLowerCase());
      const qualifierJoined = qualifierSegments.join(', ');
      let bestQualified: { readonly keyLen: number; readonly entry: Pronunciation } | null = null;

      for (const [key, entry] of Object.entries(lexicon)) {
        const keySegments = splitPlaceSegments(key);
        if (keySegments.length < 2 || keySegments[0].toLowerCase() !== nameLower) {
          continue;
        }
        const keyQualifiers = keySegments.slice(1).map((s) => s.toLowerCase());
        const allMatch = keyQualifiers.every(
          (q) => qualifierSegments.includes(q) || (q.length >= 3 && qualifierJoined.includes(q))
        );
        if (allMatch && (!bestQualified || key.length > bestQualified.keyLen)) {
          bestQualified = { keyLen: key.length, entry };
        }
      }
      if (bestQualified) {
        shared = bestQualified.entry;
      }
    }

    if (!shared && nameKey) {
      const bareEntry =
        lexicon[nameKey] ??
        Object.entries(lexicon).find(([k]) => k.toLowerCase() === nameKey.toLowerCase())?.[1];
      if (bareEntry && isBareLexiconEntryCompatibleWithPlace(bareEntry, place)) {
        shared = bareEntry;
      }
    }
  }

  const own = place.pronunciation ?? undefined;
  return mergePronunciationEntry(shared, own);
}
