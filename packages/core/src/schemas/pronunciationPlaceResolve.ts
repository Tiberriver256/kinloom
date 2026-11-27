import {
  getPlaceQualifierSegments,
  isBareLexiconEntryCompatibleWithPlace,
  splitPlaceSegments,
} from './pronunciationGeo.js';
import { mergePronunciationEntry } from './pronunciationPhonetics.js';
import type { Pronunciation } from './pronunciationSchema.js';

interface QualifiedPlaceLexiconCandidate {
  readonly keyLen: number;
  readonly qualifiersLower: readonly string[];
  readonly entry: Pronunciation;
}

interface PreindexedPlaceLexicon {
  readonly byLowerKey: ReadonlyMap<string, Pronunciation>;
  readonly qualifiedByNameLower: ReadonlyMap<string, readonly QualifiedPlaceLexiconCandidate[]>;
}

const placeLexiconIndexCache = new WeakMap<Readonly<Record<string, Pronunciation>>, PreindexedPlaceLexicon>();

function getPreindexedPlaceLexicon(lexicon: Readonly<Record<string, Pronunciation>>): PreindexedPlaceLexicon {
  let cached = placeLexiconIndexCache.get(lexicon);
  if (cached) {
    return cached;
  }
  const byLowerKey = new Map<string, Pronunciation>();
  const qualifiedByNameLower = new Map<string, QualifiedPlaceLexiconCandidate[]>();

  for (const key of Object.keys(lexicon)) {
    const entry = lexicon[key];
    const lower = key.toLowerCase();
    if (!byLowerKey.has(lower)) {
      byLowerKey.set(lower, entry);
    }
    if (key.includes(',')) {
      const keySegments = splitPlaceSegments(key);
      if (keySegments.length >= 2) {
        const firstLower = keySegments[0].toLowerCase();
        const qualifiersLower = keySegments.slice(1).map((s) => s.toLowerCase());
        let bucket = qualifiedByNameLower.get(firstLower);
        if (!bucket) {
          bucket = [];
          qualifiedByNameLower.set(firstLower, bucket);
        }
        bucket.push({ keyLen: key.length, qualifiersLower, entry });
      }
    }
  }

  cached = { byLowerKey, qualifiedByNameLower };
  placeLexiconIndexCache.set(lexicon, cached);
  return cached;
}

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
    if (idKey && Object.hasOwn(lexicon, idKey)) {
      shared = lexicon[idKey];
    }

    const index = shared ? null : getPreindexedPlaceLexicon(lexicon);
    const fullNameKey = place.full_name?.trim();
    if (!shared && fullNameKey && index) {
      shared = Object.hasOwn(lexicon, fullNameKey)
        ? lexicon[fullNameKey]
        : index.byLowerKey.get(fullNameKey.toLowerCase());
    }

    const nameKey = place.name?.trim();
    if (!shared && nameKey && fullNameKey && index) {
      const nameLower = nameKey.toLowerCase();
      const qualifiedCandidates = index.qualifiedByNameLower.get(nameLower);
      if (qualifiedCandidates && qualifiedCandidates.length > 0) {
        const qualifierSegments = getPlaceQualifierSegments(place).map((s) => s.toLowerCase());
        const qualifierJoined = qualifierSegments.join(', ');
        let bestQualified: QualifiedPlaceLexiconCandidate | null = null;

        for (let i = 0; i < qualifiedCandidates.length; i += 1) {
          const cand = qualifiedCandidates[i];
          const allMatch = cand.qualifiersLower.every(
            (q) => qualifierSegments.includes(q) || (q.length >= 3 && qualifierJoined.includes(q))
          );
          if (allMatch && (!bestQualified || cand.keyLen > bestQualified.keyLen)) {
            bestQualified = cand;
          }
        }
        if (bestQualified) {
          shared = bestQualified.entry;
        }
      }
    }

    if (!shared && nameKey && index) {
      const bareEntry = Object.hasOwn(lexicon, nameKey)
        ? lexicon[nameKey]
        : index.byLowerKey.get(nameKey.toLowerCase());
      if (bareEntry && isBareLexiconEntryCompatibleWithPlace(bareEntry, place)) {
        shared = bareEntry;
      }
    }
  }

  const own = place.pronunciation ?? undefined;
  return mergePronunciationEntry(shared, own);
}
