import { CliValidationError } from '../../../errors.js';
import {
  buildLookupCachePath,
  DEFAULT_TIMEOUT_MS,
  defaultSleep,
  getPronounceCacheDir,
  readLookupCache,
  writeLookupCache,
} from './lookupCache.js';
import {
  buildForvoLookupUrl,
  buildManualLookupSources,
  buildYouGlishLookupUrl,
  queryForvoPronunciations,
  queryMediaWikiPronunciations,
} from './lookupProviders.js';
import {
  PRONOUNCE_TIER_RANK,
  type PronounceAudioHit,
  type PronounceLookupOptions,
  type PronounceLookupResult,
  type PronounceSourceHit,
  type PronounceSourceTier,
} from './types.js';

export { buildForvoLookupUrl, buildManualLookupSources, buildYouGlishLookupUrl, getPronounceCacheDir };

export function rankPronounceSources(sources: readonly PronounceSourceHit[]): PronounceSourceHit[] {
  return [...sources].toSorted((a, b) => {
    const aVerified = a.status === 'verified' ? 0 : 1;
    const bVerified = b.status === 'verified' ? 0 : 1;
    if (aVerified !== bVerified) {
      return aVerified - bVerified;
    }
    const tierDiff = PRONOUNCE_TIER_RANK[a.tier] - PRONOUNCE_TIER_RANK[b.tier];
    if (tierDiff !== 0) {
      return tierDiff;
    }
    const aHasAudio = a.audio_files.length > 0 ? 0 : 1;
    const bHasAudio = b.audio_files.length > 0 ? 0 : 1;
    if (aHasAudio !== bHasAudio) {
      return aHasAudio - bHasAudio;
    }
    const aHasIpa = a.ipa.length > 0 ? 0 : 1;
    const bHasIpa = b.ipa.length > 0 ? 0 : 1;
    if (aHasIpa !== bHasIpa) {
      return aHasIpa - bHasIpa;
    }
    return 0;
  });
}

export function evaluatePronounceCorroboration(sources: readonly PronounceSourceHit[]): {
  corroborated: boolean;
  sourceCount: number;
  highestTier: PronounceSourceTier | null;
  native_speaker_verified: boolean;
  verification_note: string | null;
} {
  const verifiedSources = sources.filter((s) => s.status === 'verified');
  const independentProviders = new Set(verifiedSources.map((s) => s.provider));
  const sourceCount = independentProviders.size;
  const corroborated = sourceCount >= 2;

  let highestTier: PronounceSourceTier | null = null;
  for (const src of verifiedSources) {
    if (highestTier === null || PRONOUNCE_TIER_RANK[src.tier] < PRONOUNCE_TIER_RANK[highestTier]) {
      highestTier = src.tier;
    }
  }

  const nativeSpeakerVerified = verifiedSources.some((s) => s.tier === 'native_speaker');

  let verificationNote: string | null = null;
  if (verifiedSources.length === 0) {
    verificationNote =
      'No automated upstream IPA or native-speaker recording matched; verify across at least two manual lookup sources before recording in the lexicon.';
  } else if (highestTier === 'automated') {
    verificationNote =
      'Only automated/generated previews matched; never rely on automated voices alone for local or historical exceptions—verify with a native speaker source.';
  } else if (!nativeSpeakerVerified) {
    verificationNote =
      'No Tier 1 native-speaker audio/lexicon match yet; cross-check with Forvo, YouGlish, or Wiktionary before finalizing.';
  } else if (!corroborated) {
    verificationNote =
      'Matched in 1 independent database; cross-check a second independent source (e.g. Forvo, YouGlish, VOA, or Wikipedia) to confirm regional usage.';
  }

  return {
    corroborated,
    sourceCount,
    highestTier,
    native_speaker_verified: nativeSpeakerVerified,
    verification_note: verificationNote,
  };
}

function formatLookupText(result: Omit<PronounceLookupResult, 'rendered'>): string {
  const lines: string[] = [];
  lines.push(
    `Pronunciation lookup: ${result.term}${result.lang ? ` [${result.lang}]` : ''} (verified=${result.verified}, corroborated=${result.corroborated}, sources=${result.sourceCount}, highest_tier=${result.highestTier ?? 'none'}, cache_hit=${result.cache_hit})`
  );
  if (result.verified) {
    if (result.ipa.length > 0) {
      lines.push(`  IPA: ${result.ipa.join(', ')}`);
    }
    if (result.source_label || result.source_url) {
      lines.push(
        `  Primary source: ${result.source_label ?? 'Wikimedia'}${result.source_url ? ` (${result.source_url})` : ''}`
      );
    }
    if (result.audio_files.length > 0) {
      lines.push(`  Native audio (${result.audio_files.length}):`);
      for (const audio of result.audio_files) {
        lines.push(`    - ${audio.filename}: ${audio.url}`);
      }
    }
  } else {
    lines.push('  No verified IPA found on automated sources (never fabricating IPA).');
    if (result.audio_files.length > 0) {
      lines.push(`  Native audio (${result.audio_files.length}):`);
      for (const audio of result.audio_files) {
        lines.push(`    - ${audio.filename}: ${audio.url}`);
      }
    }
  }
  if (result.verification_note) {
    lines.push(`  Note: ${result.verification_note}`);
  }
  const manualSources = result.sources.filter(
    (s) => s.status === 'manual_lookup' || s.status === 'requires_api_key'
  );
  if (manualSources.length > 0) {
    lines.push(`  Cross-check links (${manualSources.length}):`);
    for (const src of manualSources) {
      lines.push(`    - [${src.tier} / ${src.status}] ${src.label}: ${src.url}`);
    }
  }
  return lines.join('\n');
}

export async function runPronounceLookupCommand(
  options: PronounceLookupOptions
): Promise<PronounceLookupResult> {
  const term = options.term.trim();
  if (!term) {
    throw new CliValidationError('Missing required `<term>` argument for `kinloom pronounce lookup`.');
  }

  let normalizedLang: string | null = null;
  if (options.lang !== undefined && options.lang.trim().length > 0) {
    const raw = options.lang.trim().toLowerCase();
    const base = raw.split(/[-_]/)[0];
    if (!/^[a-z]{2,3}$/.test(base)) {
      throw new CliValidationError(
        `Invalid \`--lang\` '${options.lang}'. Expected an ISO language code such as nl, sv, fi, pl, de, or en.`
      );
    }
    normalizedLang = base;
  }

  const cacheDir = getPronounceCacheDir(options.cacheDir);
  const forvoApiKey = (options.forvoApiKey ?? process.env.FORVO_API_KEY)?.trim() || null;
  const normalizedRegion = options.region?.trim().toLowerCase() || null;
  const cachePath = buildLookupCachePath({
    cacheDir,
    term,
    normalizedLang,
    normalizedRegion,
    hasForvoKey: Boolean(forvoApiKey),
  });

  if (!options.refresh) {
    const cachedRaw = readLookupCache(cachePath);
    if (cachedRaw) {
      const resultBody: Omit<PronounceLookupResult, 'rendered'> = {
        ...cachedRaw,
        ok: true,
        cache_hit: true,
      };
      const rendered = options.json ? JSON.stringify(resultBody, null, 2) : formatLookupText(resultBody);
      return { ...resultBody, rendered };
    }
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleepFn = options.sleepFn ?? defaultSleep;

  const allIpa = new Set<string>();
  const audioByFilename = new Map<string, PronounceAudioHit>();
  const sources: PronounceSourceHit[] = [];

  let { primarySourceUrl, primarySourceLabel } = await queryMediaWikiPronunciations({
    term,
    normalizedLang,
    fetchImpl,
    timeoutMs,
    sleepFn,
    allIpa,
    audioByFilename,
    sources,
  });

  let forvoQueried = false;
  if (forvoApiKey) {
    forvoQueried = true;
    await queryForvoPronunciations({
      term,
      normalizedLang,
      forvoApiKey,
      fetchImpl,
      timeoutMs,
      sleepFn,
      audioByFilename,
      sources,
    });
  }

  sources.push(
    ...buildManualLookupSources(term, normalizedLang, {
      region: normalizedRegion,
      includeForvoManual: !forvoQueried,
    })
  );

  const rankedSources = rankPronounceSources(sources);
  const corroboration = evaluatePronounceCorroboration(rankedSources);

  const topVerifiedWithIpa = rankedSources.find((s) => s.status === 'verified' && s.ipa.length > 0);
  const topVerifiedAny = rankedSources.find((s) => s.status === 'verified');
  if (topVerifiedWithIpa) {
    primarySourceUrl = topVerifiedWithIpa.url;
    primarySourceLabel = topVerifiedWithIpa.label;
  } else if (!primarySourceUrl && topVerifiedAny) {
    primarySourceUrl = topVerifiedAny.url;
    primarySourceLabel = topVerifiedAny.label;
  }

  const ipaList = [...allIpa];
  const audioList = [...audioByFilename.values()];
  const fetchedAt = (options.nowIso ?? (() => new Date().toISOString()))();

  const payloadToCache: Omit<PronounceLookupResult, 'rendered' | 'cache_hit'> = {
    ok: true,
    term,
    lang: normalizedLang,
    verified: ipaList.length > 0 || corroboration.native_speaker_verified,
    corroborated: corroboration.corroborated,
    sourceCount: corroboration.sourceCount,
    highestTier: corroboration.highestTier,
    native_speaker_verified: corroboration.native_speaker_verified,
    verification_note: corroboration.verification_note,
    ipa: ipaList,
    primary_ipa: ipaList[0] ?? null,
    audio_files: audioList,
    source_url: primarySourceUrl,
    source_label: primarySourceLabel,
    sources: rankedSources,
    fetched_at: fetchedAt,
  };

  writeLookupCache(cachePath, payloadToCache);

  const resultBody: Omit<PronounceLookupResult, 'rendered'> = {
    ...payloadToCache,
    cache_hit: false,
  };
  const rendered = options.json ? JSON.stringify(resultBody, null, 2) : formatLookupText(resultBody);
  return { ...resultBody, rendered };
}
