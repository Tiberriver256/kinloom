import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  buildCommonsAudioUrl,
  buildWikiTargets,
  extractMediaWikiPronunciations,
  formatWikiSourceLabel,
  type MediaWikiQueryResponse,
} from './mediaWiki.js';
import {
  PRONOUNCE_TIER_RANK,
  type PronounceAudioHit,
  type PronounceLookupOptions,
  type PronounceLookupResult,
  type PronounceProviderId,
  type PronounceSourceHit,
  type PronounceSourceTier,
} from './types.js';

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'kinloom-pronounce');
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_FETCH_ATTEMPTS = 4;
const DEFAULT_USER_AGENT = 'KinloomCLI/1.0 (https://kinloom.org; archival pronunciation lookup)';

const YOUGLISH_LANG_SLUGS: Readonly<Record<string, string>> = {
  en: 'english',
  nl: 'dutch',
  sv: 'swedish',
  fi: 'finnish',
  pl: 'polish',
  de: 'german',
  fr: 'french',
  no: 'norwegian',
  da: 'danish',
  es: 'spanish',
  it: 'italian',
  pt: 'portuguese',
};

interface ForvoApiItem {
  id?: number;
  word?: string;
  pathmp3?: string;
  pathogg?: string;
  username?: string;
  country?: string;
  langname?: string;
  code?: string;
  num_positive_votes?: number;
}

interface ForvoApiResponse {
  items?: ForvoApiItem[];
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function getPronounceCacheDir(overrideDir?: string): string {
  const raw = overrideDir?.trim() || process.env.KINLOOM_PRONOUNCE_CACHE_DIR?.trim();
  return raw ? path.resolve(raw) : DEFAULT_CACHE_DIR;
}

function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`
  );
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function parseRetryAfterMs(headerValue: string | null, attempt: number): number {
  const fallbackMs = Math.min(4000, 300 * 2 ** (attempt - 1));
  if (!headerValue) {
    return fallbackMs;
  }
  const trimmed = headerValue.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.min(10_000, Math.max(0, Math.round(Number(trimmed) * 1000)));
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.min(10_000, Math.max(0, parsedDate - Date.now()));
  }
  return fallbackMs;
}

async function fetchJsonWithRetry(params: {
  url: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  sleepFn: (ms: number) => Promise<void>;
}): Promise<unknown | null> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, params.timeoutMs);
    try {
      const response = await params.fetchImpl(params.url, {
        headers: {
          accept: 'application/json',
          'user-agent': DEFAULT_USER_AGENT,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.status === 404) {
        return null;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_FETCH_ATTEMPTS) {
          const waitMs = parseRetryAfterMs(response.headers.get('retry-after'), attempt);
          await params.sleepFn(waitMs);
          continue;
        }
        throw new Error(`HTTP ${response.status} from ${params.url}`);
      }
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as unknown;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;
      if (attempt < MAX_FETCH_ATTEMPTS) {
        const waitMs = parseRetryAfterMs(null, attempt);
        await params.sleepFn(waitMs);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function buildForvoLookupUrl(term: string, lang: string | null): string {
  const base = `https://forvo.com/word/${encodeURIComponent(term.toLowerCase())}/`;
  return lang ? `${base}#${encodeURIComponent(lang)}` : base;
}

export function buildYouGlishLookupUrl(term: string, lang: string | null, region?: string | null): string {
  const langSlug = (lang && YOUGLISH_LANG_SLUGS[lang]) || 'english';
  const regionSlug = region?.trim().toLowerCase();
  const accentSuffix =
    langSlug === 'english' && regionSlug && ['us', 'uk', 'aus', 'can', 'ie', 'sco', 'nz'].includes(regionSlug)
      ? `/${regionSlug}`
      : '';
  return `https://youglish.com/pronounce/${encodeURIComponent(term)}/${langSlug}${accentSuffix}`;
}

export function buildManualLookupSources(
  term: string,
  lang: string | null,
  options?: { region?: string | null; includeForvoManual?: boolean }
): PronounceSourceHit[] {
  const encodedTerm = encodeURIComponent(term);
  const slugTerm = encodeURIComponent(term.toLowerCase().replaceAll(/\s+/g, '-'));
  const sources: PronounceSourceHit[] = [];

  if (options?.includeForvoManual !== false) {
    sources.push({
      provider: 'forvo',
      tier: 'native_speaker',
      status: 'requires_api_key',
      site: 'forvo.com',
      title: term,
      url: buildForvoLookupUrl(term, lang),
      label: 'Forvo (Native speaker audio)',
      ipa: [],
      audio_files: [],
      note: 'Set FORVO_API_KEY to query native-speaker recordings automatically, or open the direct Forvo URL.',
    });
  }

  sources.push({
    provider: 'youglish',
    tier: 'native_speaker',
    status: 'manual_lookup',
    site: 'youglish.com',
    title: term,
    url: buildYouGlishLookupUrl(term, lang, options?.region),
    label: 'YouGlish (Regional accent clips)',
    ipa: [],
    audio_files: [],
    note: 'Open in browser to hear native regional accent clips in real spoken context.',
  });

  sources.push({
    provider: 'voa',
    tier: 'broadcast_lexicon',
    status: 'manual_lookup',
    site: 'pronounce.voanews.com',
    title: term,
    url: `https://pronounce.voanews.com/search?q=${encodedTerm}`,
    label: 'VOA Pronunciation Guide (Broadcast lexicon)',
    ipa: [],
    audio_files: [],
    note: 'Broadcast pronunciation guide for international names and places.',
  });

  sources.push({
    provider: 'nameshouts',
    tier: 'community',
    status: 'manual_lookup',
    site: 'nameshouts.com',
    title: term,
    url: `https://www.nameshouts.com/names/${slugTerm}`,
    label: 'NameShouts (Name database)',
    ipa: [],
    audio_files: [],
    note: 'Secondary name database cross-check; prefer Tier 1 native-speaker audio when available.',
  });

  sources.push({
    provider: 'pronouncenames',
    tier: 'community',
    status: 'manual_lookup',
    site: 'pronouncenames.com',
    title: term,
    url: `https://www.pronouncenames.com/pronounce/${encodedTerm}`,
    label: 'Pronounce Names (Community database)',
    ipa: [],
    audio_files: [],
    note: 'Community-submitted name pronunciations; corroborate with a second independent source.',
  });

  sources.push({
    provider: 'howtopronounce',
    tier: 'community',
    status: 'manual_lookup',
    site: 'howtopronounce.com',
    title: term,
    url: `https://www.howtopronounce.com/${slugTerm}`,
    label: 'HowToPronounce (Community database)',
    ipa: [],
    audio_files: [],
    note: 'Community-submitted audio and phonetic hints; never rely on automated voices alone for local exceptions.',
  });

  return sources;
}

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

async function queryMediaWikiPronunciations(params: {
  term: string;
  normalizedLang: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  sleepFn: (ms: number) => Promise<void>;
  allIpa: Set<string>;
  audioByFilename: Map<string, PronounceAudioHit>;
  sources: PronounceSourceHit[];
}): Promise<{ primarySourceUrl: string | null; primarySourceLabel: string | null }> {
  let primarySourceUrl: string | null = null;
  let primarySourceLabel: string | null = null;

  for (const target of buildWikiTargets(params.normalizedLang)) {
    const apiUrl = new URL(`https://${target.host}/w/api.php`);
    apiUrl.searchParams.set('action', 'query');
    apiUrl.searchParams.set('prop', 'revisions');
    apiUrl.searchParams.set('rvprop', 'content');
    apiUrl.searchParams.set('rvslots', 'main');
    apiUrl.searchParams.set('redirects', '1');
    apiUrl.searchParams.set('format', 'json');
    apiUrl.searchParams.set('formatversion', '2');
    apiUrl.searchParams.set('titles', params.term);

    let payload: MediaWikiQueryResponse | null = null;
    try {
      payload = (await fetchJsonWithRetry({
        url: apiUrl.toString(),
        fetchImpl: params.fetchImpl,
        timeoutMs: params.timeoutMs,
        sleepFn: params.sleepFn,
      })) as MediaWikiQueryResponse | null;
    } catch {
      continue;
    }

    for (const page of payload?.query?.pages ?? []) {
      if (page.missing || !page.title) {
        continue;
      }
      const rev = page.revisions?.[0];
      const wikitext = rev?.slots?.main?.content ?? rev?.content ?? '';
      if (!wikitext) {
        continue;
      }

      const extracted = extractMediaWikiPronunciations(wikitext, {
        targetLang: params.normalizedLang,
        wikiLang: target.wikiLang,
      });

      if (extracted.ipa.length === 0 && extracted.audioFiles.length === 0) {
        continue;
      }

      const pageUrl = `https://${target.host}/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`;
      const label = formatWikiSourceLabel(target, params.normalizedLang);
      const provider: PronounceProviderId = target.project === 'wiktionary' ? 'wiktionary' : 'wikipedia';
      const tier: PronounceSourceTier =
        target.project === 'wiktionary' || extracted.audioFiles.length > 0
          ? 'native_speaker'
          : 'broadcast_lexicon';

      params.sources.push({
        provider,
        tier,
        status: 'verified',
        site: target.host,
        title: page.title,
        url: pageUrl,
        label,
        ipa: extracted.ipa,
        audio_files: extracted.audioFiles.map((a) => a.filename),
      });

      for (const ipaStr of extracted.ipa) {
        params.allIpa.add(ipaStr);
      }
      if (!primarySourceUrl && extracted.ipa.length > 0) {
        primarySourceUrl = pageUrl;
        primarySourceLabel = label;
      }

      for (const audio of extracted.audioFiles) {
        if (!params.audioByFilename.has(audio.filename)) {
          params.audioByFilename.set(audio.filename, {
            filename: audio.filename,
            commons_file: `File:${audio.filename}`,
            url: buildCommonsAudioUrl(audio.filename),
            ...(audio.language ? { language: audio.language } : {}),
            source_url: pageUrl,
          });
        }
      }
    }
  }

  return { primarySourceUrl, primarySourceLabel };
}

async function queryForvoPronunciations(params: {
  term: string;
  normalizedLang: string | null;
  forvoApiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  sleepFn: (ms: number) => Promise<void>;
  audioByFilename: Map<string, PronounceAudioHit>;
  sources: PronounceSourceHit[];
}): Promise<void> {
  const forvoPageUrl = buildForvoLookupUrl(params.term, params.normalizedLang);
  const forvoApiUrl =
    `https://apifree.forvo.com/key/${encodeURIComponent(params.forvoApiKey)}/format/json/action/word-pronunciations/word/${encodeURIComponent(params.term)}` +
    (params.normalizedLang ? `/language/${encodeURIComponent(params.normalizedLang)}` : '');
  try {
    const forvoPayload = (await fetchJsonWithRetry({
      url: forvoApiUrl,
      fetchImpl: params.fetchImpl,
      timeoutMs: params.timeoutMs,
      sleepFn: params.sleepFn,
    })) as ForvoApiResponse | null;
    const items = (forvoPayload?.items ?? [])
      .filter((item) => Boolean(item.pathmp3 || item.pathogg))
      .toSorted((a, b) => (b.num_positive_votes ?? 0) - (a.num_positive_votes ?? 0));

    if (items.length > 0) {
      const forvoAudioNames: string[] = [];
      for (let idx = 0; idx < items.length; idx += 1) {
        const item = items[idx];
        const audioUrl = item.pathmp3 || item.pathogg || '';
        const ext = item.pathmp3 ? 'mp3' : 'ogg';
        const filename = `forvo-${params.term.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}-${item.id ?? idx + 1}.${ext}`;
        forvoAudioNames.push(filename);
        if (!params.audioByFilename.has(filename)) {
          params.audioByFilename.set(filename, {
            filename,
            commons_file: filename,
            url: audioUrl,
            ...((item.code ?? params.normalizedLang)
              ? { language: item.code ?? params.normalizedLang ?? undefined }
              : {}),
            source_url: forvoPageUrl,
            provider: 'forvo',
            tier: 'native_speaker',
            ...(item.username ? { speaker: item.username } : {}),
            ...(item.country ? { country: item.country } : {}),
          });
        }
      }
      params.sources.push({
        provider: 'forvo',
        tier: 'native_speaker',
        status: 'verified',
        site: 'forvo.com',
        title: params.term,
        url: forvoPageUrl,
        label: `Forvo (${items.length} native speaker recording${items.length === 1 ? '' : 's'})`,
        ipa: [],
        audio_files: forvoAudioNames,
      });
    } else {
      params.sources.push({
        provider: 'forvo',
        tier: 'native_speaker',
        status: 'no_match',
        site: 'forvo.com',
        title: params.term,
        url: forvoPageUrl,
        label: 'Forvo (Native speaker audio)',
        ipa: [],
        audio_files: [],
      });
    }
  } catch {
    params.sources.push({
      provider: 'forvo',
      tier: 'native_speaker',
      status: 'error',
      site: 'forvo.com',
      title: params.term,
      url: forvoPageUrl,
      label: 'Forvo (Native speaker audio)',
      ipa: [],
      audio_files: [],
      note: 'Forvo API lookup failed; verify via the direct URL.',
    });
  }
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
  const cacheKey = createHash('sha256')
    .update(
      `v2|term:${term.toLowerCase()}|lang:${normalizedLang ?? ''}|region:${normalizedRegion ?? ''}|forvo:${forvoApiKey ? '1' : '0'}`
    )
    .digest('hex');
  const cachePath = path.join(cacheDir, `${cacheKey}.json`);

  if (!options.refresh && fs.existsSync(cachePath)) {
    try {
      const cachedRaw = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Omit<
        PronounceLookupResult,
        'rendered' | 'cache_hit'
      >;
      if (cachedRaw && typeof cachedRaw === 'object' && typeof cachedRaw.term === 'string') {
        const resultBody: Omit<PronounceLookupResult, 'rendered'> = {
          ...cachedRaw,
          ok: true,
          cache_hit: true,
        };
        const rendered = options.json ? JSON.stringify(resultBody, null, 2) : formatLookupText(resultBody);
        return { ...resultBody, rendered };
      }
    } catch {
      // Corrupt cache entry: fall through and re-fetch cleanly.
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

  writeFileAtomic(cachePath, `${JSON.stringify(payloadToCache, null, 2)}\n`);

  const resultBody: Omit<PronounceLookupResult, 'rendered'> = {
    ...payloadToCache,
    cache_hit: false,
  };
  const rendered = options.json ? JSON.stringify(resultBody, null, 2) : formatLookupText(resultBody);
  return { ...resultBody, rendered };
}
