import { fetchJsonWithRetry } from './lookupCache.js';
import {
  buildCommonsAudioUrl,
  buildWikiTargets,
  extractMediaWikiPronunciations,
  formatWikiSourceLabel,
  type MediaWikiQueryResponse,
} from './mediaWiki.js';
import type {
  PronounceAudioHit,
  PronounceProviderId,
  PronounceSourceHit,
  PronounceSourceTier,
} from './types.js';

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

export async function queryMediaWikiPronunciations(params: {
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

export async function queryForvoPronunciations(params: {
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
