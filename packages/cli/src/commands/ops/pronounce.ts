import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseKinloomConfigYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  resolveEffectiveLiving,
  resolvePersonPronunciation,
  resolvePlacePronunciation,
  type KinloomSiteConfig,
  type Place,
  type Pronunciation,
  type PronunciationCoverage,
  type PronunciationVariant,
  type RawPerson,
} from '@kinloom/core';
import { CliValidationError } from '../../errors.js';

export const PRONOUNCE_SUPPORTED_LANGS = ['nl', 'sv', 'fi', 'pl', 'de', 'en'] as const;
export type PronounceLang = (typeof PRONOUNCE_SUPPORTED_LANGS)[number];

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'kinloom-pronounce');
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_FETCH_ATTEMPTS = 4;
const DEFAULT_USER_AGENT = 'KinloomCLI/1.0 (https://kinloom.org; archival pronunciation lookup)';

const LANG_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  nl: 'Dutch',
  sv: 'Swedish',
  fi: 'Finnish',
  pl: 'Polish',
  de: 'German',
  en: 'English',
  fr: 'French',
  no: 'Norwegian',
  da: 'Danish',
};

export interface PronounceAudioHit {
  filename: string;
  commons_file: string;
  url: string;
  language?: string;
  source_url: string;
}

export interface PronounceSourceHit {
  site: string;
  title: string;
  url: string;
  label: string;
  ipa: string[];
  audio_files: string[];
}

export interface PronounceLookupResult {
  ok: true;
  term: string;
  lang: string | null;
  verified: boolean;
  cache_hit: boolean;
  ipa: string[];
  primary_ipa: string | null;
  audio_files: PronounceAudioHit[];
  source_url: string | null;
  source_label: string | null;
  sources: PronounceSourceHit[];
  fetched_at: string;
  rendered: string;
}

export interface PronounceLookupOptions {
  term: string;
  lang?: string;
  json?: boolean;
  refresh?: boolean;
  cacheDir?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowIso?: () => string;
}

export interface PronounceCoverageGapPerson {
  surname: string;
  deceased_count: number;
}

export interface PronounceMissingPersonGap {
  id: string;
  full_name: string;
  surname: string;
}

export interface PronouncePartialPersonGap {
  id: string;
  full_name: string;
  coverage: Exclude<PronunciationCoverage, 'full'>;
  matched_part: string | null;
  missing_parts: string[];
}

export interface PronounceLivingLeak {
  scope: 'person' | 'lexicon';
  location: string;
  reason: string;
}

export interface PronounceCoverageGapPlace {
  id: string;
  name: string;
  full_name: string;
  reason: string;
}

export interface PronounceUnsourcedEntry {
  scope: 'lexicon' | 'person' | 'place';
  key: string;
  label: string;
  missing_note: boolean;
}

export interface PronounceHomonymCollision {
  lexicon_key: string;
  places: Array<{ id: string; name: string; full_name: string; scope_hint: string }>;
  recommendation: string;
}

export interface PronounceQualityWarning {
  scope: 'lexicon' | 'person' | 'place';
  key: string;
  code: 'empty_entry' | 'malformed_ipa' | 'suspicious_english_ipa_for_foreign_lang';
  language?: string;
  ipa?: string;
  message: string;
}

export interface PronounceAuditResult {
  ok: boolean;
  strictOk: boolean;
  repo: string;
  summary: {
    deceasedTotal: number;
    deceasedFullCoverage: number;
    deceasedPartialOnly: number;
    deceasedMissing: number;
    livingLeaks: number;
    placesTotal: number;
    placesCovered: number;
    placesMissing: number;
    lexicon_entries: number;
    deceased_people: number;
    living_people_excluded: number;
    places: number;
    missing_surnames: number;
    missing_non_trivial_places: number;
    unsourced_entries: number;
    homonymous_place_collisions: number;
    ipa_quality_warnings: number;
  };
  living_leaks: PronounceLivingLeak[];
  coverage_gaps: {
    people_missing: PronounceMissingPersonGap[];
    people_partial: PronouncePartialPersonGap[];
    surnames: PronounceCoverageGapPerson[];
    places: PronounceCoverageGapPlace[];
  };
  unsourced_entries: PronounceUnsourcedEntry[];
  homonymous_place_collisions: PronounceHomonymCollision[];
  ipa_quality_warnings: PronounceQualityWarning[];
  rendered: string;
}

export interface PronounceAuditOptions {
  repoDir?: string;
  json?: boolean;
  strict?: boolean;
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
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function splitTemplateParams(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    const next = body[i + 1];
    if (ch === '{' && next === '{') {
      braceDepth += 1;
      current += '{{';
      i += 1;
      continue;
    }
    if (ch === '}' && next === '}' && braceDepth > 0) {
      braceDepth -= 1;
      current += '}}';
      i += 1;
      continue;
    }
    if (ch === '[' && next === '[') {
      bracketDepth += 1;
      current += '[[';
      i += 1;
      continue;
    }
    if (ch === ']' && next === ']' && bracketDepth > 0) {
      bracketDepth -= 1;
      current += ']]';
      i += 1;
      continue;
    }
    if (ch === '|' && braceDepth === 0 && bracketDepth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function findTemplates(wikitext: string): Array<{ name: string; params: string[] }> {
  const templates: Array<{ name: string; params: string[] }> = [];
  let i = 0;
  while (i < wikitext.length - 1) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < wikitext.length - 1 && depth > 0) {
        if (wikitext[j] === '{' && wikitext[j + 1] === '{') {
          depth += 1;
          j += 2;
          continue;
        }
        if (wikitext[j] === '}' && wikitext[j + 1] === '}') {
          depth -= 1;
          j += 2;
          continue;
        }
        j += 1;
      }
      if (depth === 0) {
        const inner = wikitext.slice(i + 2, j - 2);
        const parts = splitTemplateParams(inner);
        const name = (parts[0] ?? '').trim();
        if (name) {
          templates.push({ name, params: parts.slice(1) });
        }
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return templates;
}

function normalizeExtractedIpa(raw: string): string | null {
  const stripped = raw
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/''+/g, '')
    .trim();
  if (!stripped) {
    return null;
  }
  if (/^(?:pron|lang|audio|local|also|ipa|us|uk|nl|sv|fi|pl|de|en)$/i.test(stripped)) {
    return null;
  }
  if (/\.(?:ogg|oga|wav|mp3|flac)$/i.test(stripped)) {
    return null;
  }
  if (stripped.startsWith('/') && stripped.endsWith('/') && stripped.length > 2) {
    return stripped;
  }
  if (stripped.startsWith('[') && stripped.endsWith(']') && stripped.length > 2) {
    return stripped;
  }
  const clean = stripped.replace(/^\/+|\/+$/g, '').trim();
  if (!clean || clean.length > 120) {
    return null;
  }
  return `/${clean}/`;
}

function normalizeAudioFilename(raw: string): string | null {
  const cleaned = raw
    .replace(/^File:/i, '')
    .replace(/^Image:/i, '')
    .trim();
  if (!cleaned || !/\.(?:ogg|oga|wav|mp3|flac)$/i.test(cleaned)) {
    return null;
  }
  return cleaned.replaceAll(' ', '_');
}

export function buildCommonsAudioUrl(filename: string): string {
  const normalized = filename.replace(/^File:/i, '').trim().replaceAll(' ', '_');
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(normalized)}`;
}

const IPA_NON_VALUE_TOKENS = new Set([
  'pron',
  'lang',
  'local',
  'also',
  'ipa',
  '-',
  'or',
  'and',
  'locally',
]);

function normalizeLangCode(lang?: string | null): string | null {
  if (!lang) {
    return null;
  }
  const base = lang.trim().toLowerCase().split(/[-_]/)[0];
  return base || null;
}

/**
 * Extract verified IPA transcriptions and Wikimedia Commons audio filenames from
 * MediaWiki wikitext (Wiktionary and Wikipedia templates).
 */
export function extractMediaWikiPronunciations(
  wikitext: string,
  options?: { targetLang?: string | null; wikiLang?: string }
): { ipa: string[]; audioFiles: Array<{ filename: string; language?: string }> } {
  const targetLang = normalizeLangCode(options?.targetLang);
  const wikiLang = normalizeLangCode(options?.wikiLang) ?? 'en';
  const ipaSet = new Set<string>();
  const audioByFile = new Map<string, string | undefined>();

  const addIpa = (candidate: string): void => {
    const normalized = normalizeExtractedIpa(candidate);
    if (normalized) {
      ipaSet.add(normalized);
    }
  };

  const addAudio = (candidate: string, lang?: string): void => {
    const filename = normalizeAudioFilename(candidate);
    if (filename && !audioByFile.has(filename)) {
      audioByFile.set(filename, lang);
    }
  };

  const templates = findTemplates(wikitext);
  for (const tpl of templates) {
    const rawName = tpl.name.trim();
    const lowerName = rawName.toLowerCase();

    const positional: string[] = [];
    const named = new Map<string, string>();
    for (const p of tpl.params) {
      const eqIdx = p.indexOf('=');
      if (eqIdx !== -1 && /^[a-z0-9_-]+$/i.test(p.slice(0, eqIdx).trim())) {
        named.set(p.slice(0, eqIdx).trim().toLowerCase(), p.slice(eqIdx + 1).trim());
      } else {
        positional.push(p.trim());
      }
    }

    const namedAudio = named.get('audio') ?? named.get('sound');
    if (namedAudio) {
      addAudio(namedAudio, targetLang ?? wikiLang);
    }

    // {{IPA|nl|/ɣus/}} or {{IPA|nl|ɣus}} or {{IPA|/ˈmɜːrsər/}}
    if (lowerName === 'ipa') {
      if (positional.length >= 2 && /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(positional[0])) {
        const tplLang = normalizeLangCode(positional[0]);
        if (!targetLang || !tplLang || tplLang === targetLang) {
          for (const val of positional.slice(1)) {
            if (!val || IPA_NON_VALUE_TOKENS.has(val.toLowerCase())) {
              continue;
            }
            const maybeAudio = normalizeAudioFilename(val);
            if (maybeAudio) {
              addAudio(maybeAudio, tplLang ?? undefined);
              continue;
            }
            addIpa(val);
          }
        }
      } else if (positional.length >= 1) {
        if (!targetLang || wikiLang === targetLang) {
          for (const val of positional) {
            if (!val || IPA_NON_VALUE_TOKENS.has(val.toLowerCase())) {
              continue;
            }
            addIpa(val);
          }
        }
      }
      continue;
    }

    // {{IPA-nl|ɣus|-|Nl-Goes.ogg}}, {{IPA-sv|...}}, {{IPA-pl|...}}, {{IPA-fi|...}}, {{IPA-de|...}}, {{IPA-en|...}}
    const ipaDashMatch = /^ipa-([a-z]{2,3})$/i.exec(lowerName);
    if (ipaDashMatch) {
      const tplLang = normalizeLangCode(ipaDashMatch[1]);
      if (!targetLang || !tplLang || tplLang === targetLang || tplLang === 'all') {
        for (const val of positional) {
          if (!val || IPA_NON_VALUE_TOKENS.has(val.toLowerCase())) {
            continue;
          }
          const maybeAudio = normalizeAudioFilename(val);
          if (maybeAudio) {
            addAudio(maybeAudio, tplLang === 'all' ? (targetLang ?? undefined) : (tplLang ?? undefined));
            continue;
          }
          addIpa(val);
        }
      }
      continue;
    }

    // {{nl-IPA|...}}, {{sv-IPA|...}}, {{pl-IPA|...}}, {{fi-IPA|...}}, {{de-IPA|...}}
    const langIpaMatch = /^([a-z]{2,3})-ipa$/i.exec(lowerName);
    if (langIpaMatch) {
      const tplLang = normalizeLangCode(langIpaMatch[1]);
      if (!targetLang || !tplLang || tplLang === targetLang) {
        for (const val of positional) {
          if (!val || IPA_NON_VALUE_TOKENS.has(val.toLowerCase())) {
            continue;
          }
          addIpa(val);
        }
      }
      continue;
    }

    // nl.wiktionary {{pron|/ɣus/|nl}} or {{ipa|/ɣus/|nl}}
    if (lowerName === 'pron' && positional.length >= 1) {
      const tplLang = positional[1] ? normalizeLangCode(positional[1]) : wikiLang;
      if (!targetLang || !tplLang || tplLang === targetLang) {
        addIpa(positional[0]);
      }
      continue;
    }

    // {{audio|nl|Nl-Goes.ogg|Audio}} or {{Audio|Nl-Goes.ogg|listen}}
    if (lowerName === 'audio') {
      if (positional.length >= 2 && /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(positional[0])) {
        const tplLang = normalizeLangCode(positional[0]);
        if (!targetLang || !tplLang || tplLang === targetLang) {
          addAudio(positional[1], tplLang ?? undefined);
        }
      } else if (positional.length >= 1) {
        if (!targetLang || wikiLang === targetLang) {
          addAudio(positional[0], wikiLang);
        }
      }
      continue;
    }

    const langAudioMatch = /^(?:audio-([a-z]{2,3})|([a-z]{2,3})-audio)$/i.exec(lowerName);
    if (langAudioMatch && positional.length >= 1) {
      const tplLang = normalizeLangCode(langAudioMatch[1] ?? langAudioMatch[2]);
      if (!targetLang || !tplLang || tplLang === targetLang) {
        addAudio(positional[0], tplLang ?? undefined);
      }
    }
  }

  return {
    ipa: [...ipaSet],
    audioFiles: [...audioByFile.entries()].map(([filename, language]) => ({
      filename,
      ...(language ? { language } : {}),
    })),
  };
}

interface MediaWikiQueryResponse {
  query?: {
    pages?: Array<{
      title?: string;
      missing?: boolean;
      revisions?: Array<{
        slots?: {
          main?: {
            content?: string;
          };
        };
        content?: string;
      }>;
    }>;
  };
}

interface WikiTargetSpec {
  host: string;
  project: 'wiktionary' | 'wikipedia';
  wikiLang: string;
}

function buildWikiTargets(lang: string | null): WikiTargetSpec[] {
  const targets: WikiTargetSpec[] = [];
  const seen = new Set<string>();
  const add = (wikiLang: string, project: 'wiktionary' | 'wikipedia'): void => {
    const host = `${wikiLang}.${project}.org`;
    if (seen.has(host)) {
      return;
    }
    seen.add(host);
    targets.push({ host, project, wikiLang });
  };

  if (lang && lang !== 'en') {
    add(lang, 'wiktionary');
    add('en', 'wiktionary');
    add(lang, 'wikipedia');
    add('en', 'wikipedia');
  } else {
    add('en', 'wiktionary');
    add('en', 'wikipedia');
  }
  return targets;
}

function formatSourceLabel(target: WikiTargetSpec, lang: string | null): string {
  const projectLabel = target.project === 'wiktionary' ? 'Wiktionary' : 'Wikipedia';
  const langKey = lang ?? target.wikiLang;
  const langDisplay = LANG_DISPLAY_NAMES[langKey] ?? langKey;
  return `${projectLabel} (${langDisplay} IPA)`;
}

function formatLookupText(result: Omit<PronounceLookupResult, 'rendered'>): string {
  const lines: string[] = [];
  lines.push(
    `Pronunciation lookup: ${result.term}${result.lang ? ` [${result.lang}]` : ''} (verified=${result.verified}, cache_hit=${result.cache_hit})`
  );
  if (result.verified) {
    lines.push(`  IPA: ${result.ipa.join(', ')}`);
    if (result.source_label || result.source_url) {
      lines.push(`  Source: ${result.source_label ?? 'Wikimedia'}${result.source_url ? ` (${result.source_url})` : ''}`);
    }
    if (result.audio_files.length > 0) {
      lines.push(`  Native audio (${result.audio_files.length}):`);
      for (const audio of result.audio_files) {
        lines.push(`    - ${audio.filename}: ${audio.url}`);
      }
    }
  } else {
    lines.push('  No verified IPA found on Wiktionary or Wikipedia (never fabricating IPA).');
    if (result.audio_files.length > 0) {
      lines.push(`  Native audio (${result.audio_files.length}):`);
      for (const audio of result.audio_files) {
        lines.push(`    - ${audio.filename}: ${audio.url}`);
      }
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
  const cacheKey = createHash('sha256')
    .update(`v1|term:${term.toLowerCase()}|lang:${normalizedLang ?? ''}`)
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
        const rendered = options.json
          ? JSON.stringify(resultBody, null, 2)
          : formatLookupText(resultBody);
        return { ...resultBody, rendered };
      }
    } catch {
      // Corrupt cache entry: fall through and re-fetch cleanly.
    }
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleepFn = options.sleepFn ?? defaultSleep;
  const targets = buildWikiTargets(normalizedLang);

  const allIpa = new Set<string>();
  const audioByFilename = new Map<string, PronounceAudioHit>();
  const sources: PronounceSourceHit[] = [];
  let primarySourceUrl: string | null = null;
  let primarySourceLabel: string | null = null;

  for (const target of targets) {
    const apiUrl = new URL(`https://${target.host}/w/api.php`);
    apiUrl.searchParams.set('action', 'query');
    apiUrl.searchParams.set('prop', 'revisions');
    apiUrl.searchParams.set('rvprop', 'content');
    apiUrl.searchParams.set('rvslots', 'main');
    apiUrl.searchParams.set('redirects', '1');
    apiUrl.searchParams.set('format', 'json');
    apiUrl.searchParams.set('formatversion', '2');
    apiUrl.searchParams.set('titles', term);

    let payload: MediaWikiQueryResponse | null = null;
    try {
      payload = (await fetchJsonWithRetry({
        url: apiUrl.toString(),
        fetchImpl,
        timeoutMs,
        sleepFn,
      })) as MediaWikiQueryResponse | null;
    } catch {
      continue;
    }

    const pages = payload?.query?.pages ?? [];
    for (const page of pages) {
      if (page.missing || !page.title) {
        continue;
      }
      const rev = page.revisions?.[0];
      const wikitext = rev?.slots?.main?.content ?? rev?.content ?? '';
      if (!wikitext) {
        continue;
      }

      const extracted = extractMediaWikiPronunciations(wikitext, {
        targetLang: normalizedLang,
        wikiLang: target.wikiLang,
      });

      if (extracted.ipa.length === 0 && extracted.audioFiles.length === 0) {
        continue;
      }

      const pageUrl = `https://${target.host}/wiki/${encodeURIComponent(page.title.replaceAll(' ', '_'))}`;
      const label = formatSourceLabel(target, normalizedLang);

      sources.push({
        site: target.host,
        title: page.title,
        url: pageUrl,
        label,
        ipa: extracted.ipa,
        audio_files: extracted.audioFiles.map((a) => a.filename),
      });

      for (const ipaStr of extracted.ipa) {
        allIpa.add(ipaStr);
      }
      if (!primarySourceUrl && extracted.ipa.length > 0) {
        primarySourceUrl = pageUrl;
        primarySourceLabel = label;
      }

      for (const audio of extracted.audioFiles) {
        if (!audioByFilename.has(audio.filename)) {
          audioByFilename.set(audio.filename, {
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

  const ipaList = [...allIpa];
  const audioList = [...audioByFilename.values()];
  const fetchedAt = (options.nowIso ?? (() => new Date().toISOString()))();

  const payloadToCache: Omit<PronounceLookupResult, 'rendered' | 'cache_hit'> = {
    ok: true,
    term,
    lang: normalizedLang,
    verified: ipaList.length > 0,
    ipa: ipaList,
    primary_ipa: ipaList[0] ?? null,
    audio_files: audioList,
    source_url: primarySourceUrl,
    source_label: primarySourceLabel,
    sources,
    fetched_at: fetchedAt,
  };

  writeFileAtomic(cachePath, `${JSON.stringify(payloadToCache, null, 2)}\n`);

  const resultBody: Omit<PronounceLookupResult, 'rendered'> = {
    ...payloadToCache,
    cache_hit: false,
  };
  const rendered = options.json
    ? JSON.stringify(resultBody, null, 2)
    : formatLookupText(resultBody);
  return { ...resultBody, rendered };
}

// ---------------------------------------------------------------------------
// `kinloom pronounce audit`
// ---------------------------------------------------------------------------

const NON_ENGLISH_COUNTRY_HINTS = [
  'netherlands',
  'nederland',
  'holland',
  'zeeland',
  'friesland',
  'gelderland',
  'sweden',
  'sverige',
  'finland',
  'suomi',
  'poland',
  'polska',
  'germany',
  'deutschland',
  'prussia',
  'preußen',
  'belgium',
  'belgië',
  'norway',
  'norge',
  'denmark',
  'danmark',
  'france',
  'italy',
  'italia',
  'austria',
  'switzerland',
];

const NON_TRIVIAL_PLACE_PATTERNS: readonly RegExp[] = [
  /(?:dijk|kerk|stad|holm|vik|berg|borg|huizen|woude|zand|sluis|meer|veld|veen|buren|dam|sloot)$/i,
  /(?:järvi|koski|mäki|lahti|niemi|luoto|pää|kylä)$/i,
  /(?:sz|cz|rz|dz|ść|ź|ł|ń|ś|ć)/i,
  /(?:ij|oe|ui|eu|aa|ee|oo|uu)/i,
  /(?:ough|augh|sch|tz|ckh|gham|cester|wich|borough|burgh)/i,
];

function hasNonAsciiChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) {
      return true;
    }
  }
  return false;
}

const FOREIGN_IPA_SUSPICIOUS_RULES: Readonly<
  Record<string, readonly { readonly pattern: RegExp; readonly tokenLabel: string }[]>
> = {
  nl: [
    { pattern: /[ɝɚ]/, tokenLabel: 'rhotic schwa (/ɝ/ or /ɚ/)' },
    { pattern: /ɜː?r/, tokenLabel: 'English r-colored /ɜːr/' },
    { pattern: /ɹ/, tokenLabel: 'English approximant /ɹ/' },
    { pattern: /aɪ(?![̯])/, tokenLabel: 'English diphthong /aɪ/' },
    { pattern: /oʊ/, tokenLabel: 'English diphthong /oʊ/' },
    { pattern: /eɪ/, tokenLabel: 'English diphthong /eɪ/' },
    { pattern: /[θð]/, tokenLabel: 'English dental fricative (/θ/ or /ð/)' },
  ],
  sv: [
    { pattern: /[ɝɚ]/, tokenLabel: 'rhotic schwa (/ɝ/ or /ɚ/)' },
    { pattern: /ɜː?r/, tokenLabel: 'English r-colored /ɜːr/' },
    { pattern: /ɹ/, tokenLabel: 'English approximant /ɹ/' },
    { pattern: /aɪ/, tokenLabel: 'English diphthong /aɪ/' },
    { pattern: /oʊ/, tokenLabel: 'English diphthong /oʊ/' },
    { pattern: /eɪ/, tokenLabel: 'English diphthong /eɪ/' },
    { pattern: /[θð]/, tokenLabel: 'English dental fricative (/θ/ or /ð/)' },
  ],
  fi: [
    { pattern: /[ɝɚ]/, tokenLabel: 'rhotic schwa (/ɝ/ or /ɚ/)' },
    { pattern: /ɜː?r/, tokenLabel: 'English r-colored /ɜːr/' },
    { pattern: /ɹ/, tokenLabel: 'English approximant /ɹ/' },
    { pattern: /aɪ/, tokenLabel: 'English diphthong /aɪ/' },
    { pattern: /oʊ/, tokenLabel: 'English diphthong /oʊ/' },
    { pattern: /eɪ/, tokenLabel: 'English diphthong /eɪ/' },
    { pattern: /[θð]/, tokenLabel: 'English dental fricative (/θ/ or /ð/)' },
  ],
  pl: [
    { pattern: /[ɝɚ]/, tokenLabel: 'rhotic schwa (/ɝ/ or /ɚ/)' },
    { pattern: /ɜː?r/, tokenLabel: 'English r-colored /ɜːr/' },
    { pattern: /ɹ/, tokenLabel: 'English approximant /ɹ/' },
    { pattern: /aɪ/, tokenLabel: 'English diphthong /aɪ/' },
    { pattern: /oʊ/, tokenLabel: 'English diphthong /oʊ/' },
    { pattern: /eɪ/, tokenLabel: 'English diphthong /eɪ/' },
    { pattern: /[θð]/, tokenLabel: 'English dental fricative (/θ/ or /ð/)' },
  ],
  de: [
    { pattern: /[ɝɚ]/, tokenLabel: 'rhotic schwa (/ɝ/ or /ɚ/)' },
    { pattern: /ɜː?r/, tokenLabel: 'English r-colored /ɜːr/' },
    { pattern: /ɹ/, tokenLabel: 'English approximant /ɹ/' },
    { pattern: /oʊ/, tokenLabel: 'English diphthong /oʊ/' },
    { pattern: /eɪ/, tokenLabel: 'English diphthong /eɪ/' },
    { pattern: /[θð]/, tokenLabel: 'English dental fricative (/θ/ or /ð/)' },
  ],
};

function inspectNonTrivialPlaceReason(place: Place): string | null {
  const fullLower = place.full_name.toLowerCase();
  const segments = place.full_name
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const qualifierJoined = segments.length > 1 ? segments.slice(1).join(', ') : fullLower;

  for (const countryHint of NON_ENGLISH_COUNTRY_HINTS) {
    if (qualifierJoined.includes(countryHint)) {
      return `foreign place (${countryHint})`;
    }
  }
  if (hasNonAsciiChar(place.name)) {
    return 'non-ASCII orthography';
  }
  for (const pattern of NON_TRIVIAL_PLACE_PATTERNS) {
    if (pattern.test(place.name)) {
      return 'non-trivial orthography';
    }
  }
  return null;
}

function derivePlaceScopeHint(place: Place): string {
  const segments = place.full_name
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length <= 1) {
    return place.full_name;
  }
  return segments.slice(-2).join(', ');
}

function inspectPronunciationQuality(
  scope: 'lexicon' | 'person' | 'place',
  key: string,
  entry: Pick<Pronunciation, 'phonetic' | 'ipa' | 'language' | 'audio_url' | 'note'> | PronunciationVariant,
  warnings: PronounceQualityWarning[]
): void {
  const phonetic = entry.phonetic?.trim() ?? '';
  const ipa = entry.ipa?.trim() ?? '';
  const audioUrl = entry.audio_url?.trim() ?? '';
  const language = entry.language?.trim() ?? '';

  if (!phonetic && !ipa && !audioUrl) {
    warnings.push({
      scope,
      key,
      code: 'empty_entry',
      ...(language ? { language } : {}),
      message: `Entry '${key}' has no phonetic guide, IPA, or audio_url.`,
    });
    return;
  }

  if (ipa) {
    const validSlashed = ipa.startsWith('/') && ipa.endsWith('/') && ipa.length > 2;
    const validBracketed = ipa.startsWith('[') && ipa.endsWith(']') && ipa.length > 2;
    if (!validSlashed && !validBracketed) {
      warnings.push({
        scope,
        key,
        code: 'malformed_ipa',
        ...(language ? { language } : {}),
        ipa,
        message: `Entry '${key}' has unslashed/malformed IPA '${ipa}' (expected /.../ or [...]).`,
      });
    } else {
      const inner = ipa.slice(1, -1).trim();
      if (!inner || /[A-Z]{2,}/.test(inner)) {
        warnings.push({
          scope,
          key,
          code: 'malformed_ipa',
          ...(language ? { language } : {}),
          ipa,
          message: `Entry '${key}' IPA '${ipa}' looks malformed or contains uppercase phonetic respelling.`,
        });
      }
    }

    const baseLang = normalizeLangCode(language);
    if (baseLang && FOREIGN_IPA_SUSPICIOUS_RULES[baseLang]) {
      const matchedLabels: string[] = [];
      for (const rule of FOREIGN_IPA_SUSPICIOUS_RULES[baseLang]) {
        if (rule.pattern.test(ipa)) {
          matchedLabels.push(rule.tokenLabel);
        }
      }
      if (matchedLabels.length > 0) {
        warnings.push({
          scope,
          key,
          code: 'suspicious_english_ipa_for_foreign_lang',
          language,
          ipa,
          message: `Entry '${key}' (language=${language}) contains suspicious English IPA token(s): ${matchedLabels.join(', ')}.`,
        });
      }
    }
  }
}

function hasPronunciationValues(entry?: Pronunciation | null): boolean {
  if (!entry) {
    return false;
  }
  if (
    Boolean(entry.phonetic?.trim()) ||
    Boolean(entry.ipa?.trim()) ||
    Boolean(entry.audio_url?.trim()) ||
    Boolean(entry.note?.trim())
  ) {
    return true;
  }
  return Boolean(
    entry.variants?.some(
      (v) =>
        Boolean(v.phonetic?.trim()) ||
        Boolean(v.ipa?.trim()) ||
        Boolean(v.audio_url?.trim()) ||
        Boolean(v.note?.trim()),
    ),
  );
}

function formatAuditText(result: Omit<PronounceAuditResult, 'rendered'>): string {
  const s = result.summary;
  const lines: string[] = [
    `Pronunciation audit (${result.repo})`,
    `  Pronunciation Lexicon entries: ${s.lexicon_entries} | Living excluded: ${s.living_people_excluded}`,
    `  Deceased full-name coverage: ${s.deceasedFullCoverage}/${s.deceasedTotal} (partial/surname-only: ${s.deceasedPartialOnly}, missing: ${s.deceasedMissing})`,
    `  Places coverage: ${s.placesCovered}/${s.placesTotal} (missing: ${s.placesMissing})`,
    `  Living pronunciation leaks: ${s.livingLeaks}`,
    `  Homonymous bare place collisions: ${s.homonymous_place_collisions}`,
    `  Unsourced entries: ${s.unsourced_entries} | IPA / quality warnings: ${s.ipa_quality_warnings}`,
  ];

  if (result.living_leaks.length > 0) {
    lines.push('', `LIVING PRONUNCIATION LEAKS (${result.living_leaks.length}) [FAIL]:`);
    for (const leak of result.living_leaks) {
      lines.push(`  - [${leak.scope}] ${leak.location}: ${leak.reason}`);
    }
  }

  if (result.coverage_gaps.people_missing.length > 0) {
    lines.push(
      '',
      `Deceased people missing pronunciation (${result.coverage_gaps.people_missing.length}):`,
    );
    for (const p of result.coverage_gaps.people_missing.slice(0, 25)) {
      lines.push(`  - ${p.id}: ${p.full_name}`);
    }
    if (result.coverage_gaps.people_missing.length > 25) {
      lines.push(`  ... and ${result.coverage_gaps.people_missing.length - 25} more.`);
    }
  }

  if (result.coverage_gaps.people_partial.length > 0) {
    lines.push(
      '',
      `Deceased people with surname-only or partial pronunciation (${result.coverage_gaps.people_partial.length}):`,
    );
    for (const p of result.coverage_gaps.people_partial.slice(0, 25)) {
      const missingStr =
        p.missing_parts.length > 0 ? ` (missing: ${p.missing_parts.join(', ')})` : '';
      lines.push(`  - ${p.id}: ${p.full_name} [${p.coverage}]${missingStr}`);
    }
    if (result.coverage_gaps.people_partial.length > 25) {
      lines.push(`  ... and ${result.coverage_gaps.people_partial.length - 25} more.`);
    }
  }

  if (result.coverage_gaps.places.length > 0) {
    lines.push('', `Places missing pronunciation (${result.coverage_gaps.places.length}):`);
    for (const p of result.coverage_gaps.places.slice(0, 25)) {
      lines.push(`  - ${p.id}: ${p.full_name} (${p.reason})`);
    }
    if (result.coverage_gaps.places.length > 25) {
      lines.push(`  ... and ${result.coverage_gaps.places.length - 25} more.`);
    }
  }

  if (result.homonymous_place_collisions.length > 0) {
    lines.push('', 'Homonymous bare place collisions:');
    for (const c of result.homonymous_place_collisions) {
      const list = c.places.map((p) => `${p.id} (${p.full_name})`).join('; ');
      lines.push(`  - "${c.lexicon_key}" matches multiple places: ${list}`);
      lines.push(`    -> ${c.recommendation}`);
    }
  }

  if (result.ipa_quality_warnings.length > 0) {
    lines.push('', 'IPA / quality warnings:');
    for (const w of result.ipa_quality_warnings) {
      lines.push(`  - [${w.scope}:${w.key}] (${w.code}) ${w.message}`);
    }
  }

  if (result.unsourced_entries.length > 0) {
    lines.push('', `Unsourced entries (${result.unsourced_entries.length}):`);
    for (const u of result.unsourced_entries.slice(0, 25)) {
      lines.push(
        `  - [${u.scope}] ${u.label}${u.missing_note ? ' (missing source and note)' : ' (missing source_url/source_label)'}`,
      );
    }
    if (result.unsourced_entries.length > 25) {
      lines.push(`  ... and ${result.unsourced_entries.length - 25} more.`);
    }
  }

  if (result.coverage_gaps.surnames.length > 0) {
    lines.push('', `Missing deceased surnames (${result.coverage_gaps.surnames.length}):`);
    for (const g of result.coverage_gaps.surnames.slice(0, 20)) {
      lines.push(`  - ${g.surname} (${g.deceased_count} deceased)`);
    }
    if (result.coverage_gaps.surnames.length > 20) {
      lines.push(`  ... and ${result.coverage_gaps.surnames.length - 20} more.`);
    }
  }

  return lines.join('\n');
}

export function runPronounceAuditCommand(
  options: PronounceAuditOptions,
): PronounceAuditResult {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }

  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  const peoplePath = path.join(repoDir, 'data', 'people.yaml');
  const placesPath = path.join(repoDir, 'data', 'places.yaml');

  if (!fs.existsSync(configPath)) {
    throw new CliValidationError(
      `Missing ${configPath} (pass --repo <archive-root> if running outside the archive root).`,
    );
  }

  const siteConfig: KinloomSiteConfig = parseKinloomConfigYaml(fs.readFileSync(configPath, 'utf8'));
  const people: RawPerson[] = fs.existsSync(peoplePath)
    ? parsePeopleYaml(fs.readFileSync(peoplePath, 'utf8'))
    : [];
  const places: Place[] = fs.existsSync(placesPath)
    ? parsePlacesYaml(fs.readFileSync(placesPath, 'utf8'))
    : [];

  const lexicon: Record<string, Pronunciation> = siteConfig.pronunciations ?? {};
  const lexiconLowerKeys = new Map<string, string>();
  for (const key of Object.keys(lexicon)) {
    lexiconLowerKeys.set(key.trim().toLowerCase(), key);
  }

  // Strictly partition deceased vs living people; never print any living name, surname, or ID.
  const deceasedPeople: RawPerson[] = [];
  const livingPeople: Array<{ index: number; person: RawPerson }> = [];
  for (let i = 0; i < people.length; i += 1) {
    const person = people[i];
    if (
      person.is_living ||
      person.full_name.trim() === 'Living' ||
      resolveEffectiveLiving(person, siteConfig.privacy)
    ) {
      livingPeople.push({ index: i + 1, person });
      continue;
    }
    deceasedPeople.push(person);
  }
  const livingExcluded = livingPeople.length;

  // Verify 0 living people carry an explicit pronunciation or living-only lexicon entry.
  const deceasedFullNamesLower = new Set(
    deceasedPeople.map((p) => p.full_name.trim().toLowerCase()).filter(Boolean),
  );
  const deceasedIdsLower = new Set(deceasedPeople.map((p) => p.id.trim().toLowerCase()));
  const livingLeaks: PronounceLivingLeak[] = [];

  for (const { index, person } of livingPeople) {
    if (hasPronunciationValues(person.pronunciation)) {
      livingLeaks.push({
        scope: 'person',
        location: `data/people.yaml record #${index}`,
        reason: 'Living person record contains a pronunciation entry (redacted for privacy).',
      });
    }
    const idLower = person.id.trim().toLowerCase();
    if (idLower && !deceasedIdsLower.has(idLower) && lexiconLowerKeys.has(idLower)) {
      livingLeaks.push({
        scope: 'lexicon',
        location: `kinloom.config.yaml pronunciations (matches data/people.yaml record #${index})`,
        reason: 'Pronunciation Lexicon contains a key matching a living person ID (redacted for privacy).',
      });
    }
    const fullLower = person.full_name.trim().toLowerCase();
    if (
      fullLower &&
      fullLower !== 'living' &&
      !deceasedFullNamesLower.has(fullLower) &&
      lexiconLowerKeys.has(fullLower)
    ) {
      livingLeaks.push({
        scope: 'lexicon',
        location: `kinloom.config.yaml pronunciations (matches data/people.yaml record #${index})`,
        reason: 'Pronunciation Lexicon contains a full-name key matching a living person (redacted for privacy).',
      });
    }
  }

  // 100% full-name pronunciation coverage audit for every confirmed deceased person.
  let deceasedFullCoverage = 0;
  const peoplePartial: PronouncePartialPersonGap[] = [];
  const peopleMissing: PronounceMissingPersonGap[] = [];

  for (const person of deceasedPeople) {
    const resolved = resolvePersonPronunciation(person, lexicon);
    if (!resolved || !hasPronunciationValues(resolved)) {
      peopleMissing.push({
        id: person.id,
        full_name: person.full_name,
        surname: person.surname,
      });
      continue;
    }
    if (resolved.coverage === 'full') {
      deceasedFullCoverage += 1;
    } else {
      peoplePartial.push({
        id: person.id,
        full_name: person.full_name,
        coverage: resolved.coverage,
        matched_part: resolved.matchedPart ?? null,
        missing_parts: [...(resolved.missingParts ?? [])],
      });
    }
  }
  peopleMissing.sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id));
  peoplePartial.sort((a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id));

  // Backward-compatible surname gap summary
  const surnameStats = new Map<
    string,
    { canonical: string; deceasedCount: number; hasExplicitOverride: boolean }
  >();
  for (const person of deceasedPeople) {
    const surname = person.surname.trim();
    if (!surname || surname.toLowerCase() === 'unknown') {
      continue;
    }
    const lower = surname.toLowerCase();
    const existing = surnameStats.get(lower);
    const hasOwn = hasPronunciationValues(person.pronunciation);
    if (existing) {
      existing.deceasedCount += 1;
      if (hasOwn) {
        existing.hasExplicitOverride = true;
      }
    } else {
      surnameStats.set(lower, {
        canonical: surname,
        deceasedCount: 1,
        hasExplicitOverride: hasOwn,
      });
    }
  }

  const missingSurnames: PronounceCoverageGapPerson[] = [];
  for (const [lower, stat] of surnameStats.entries()) {
    if (!lexiconLowerKeys.has(lower) && !stat.hasExplicitOverride) {
      missingSurnames.push({
        surname: stat.canonical,
        deceased_count: stat.deceasedCount,
      });
    }
  }
  missingSurnames.sort(
    (a, b) => b.deceased_count - a.deceased_count || a.surname.localeCompare(b.surname),
  );

  // 100% coverage audit for every place in data/places.yaml.
  let placesCovered = 0;
  let nonTrivialMissingPlaces = 0;
  const missingPlaces: PronounceCoverageGapPlace[] = [];
  for (const place of places) {
    const resolved = resolvePlacePronunciation(place, lexicon);
    if (resolved && (resolved.phonetic || resolved.ipa || resolved.audio_url)) {
      placesCovered += 1;
      continue;
    }
    const nonTrivialReason = inspectNonTrivialPlaceReason(place);
    if (nonTrivialReason) {
      nonTrivialMissingPlaces += 1;
    }
    missingPlaces.push({
      id: place.id,
      name: place.name,
      full_name: place.full_name,
      reason: nonTrivialReason ?? 'missing pronunciation entry',
    });
  }
  missingPlaces.sort((a, b) => a.full_name.localeCompare(b.full_name));

  // Unsourced entries & IPA/linguistic quality checks
  const unsourcedEntries: PronounceUnsourcedEntry[] = [];
  const qualityWarnings: PronounceQualityWarning[] = [];

  const auditEntry = (
    scope: 'lexicon' | 'person' | 'place',
    key: string,
    label: string,
    entry: Pronunciation,
  ): void => {
    const hasSource = Boolean(entry.source_url?.trim() || entry.source_label?.trim());
    if (!hasSource) {
      unsourcedEntries.push({
        scope,
        key,
        label,
        missing_note: !entry.note?.trim(),
      });
    }
    inspectPronunciationQuality(scope, key, entry, qualityWarnings);
    for (const variant of entry.variants ?? []) {
      inspectPronunciationQuality(scope, `${key} [${variant.label}]`, variant, qualityWarnings);
    }
  };

  for (const [term, entry] of Object.entries(lexicon).toSorted(([a], [b]) => a.localeCompare(b))) {
    auditEntry('lexicon', term, term, entry);
  }
  for (const person of deceasedPeople) {
    if (person.pronunciation) {
      auditEntry('person', person.id, `${person.full_name} (${person.id})`, person.pronunciation);
    }
  }
  for (const place of places) {
    if (place.pronunciation) {
      auditEntry('place', place.id, `${place.full_name} (${place.id})`, place.pronunciation);
    }
  }

  // Homonymous bare place collisions
  const placesByBareNameLower = new Map<string, Place[]>();
  for (const place of places) {
    const lower = place.name.trim().toLowerCase();
    if (!lower) {
      continue;
    }
    const list = placesByBareNameLower.get(lower) ?? [];
    list.push(place);
    placesByBareNameLower.set(lower, list);
  }

  const homonymousCollisions: PronounceHomonymCollision[] = [];
  for (const [key] of Object.entries(lexicon).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (key.includes(',') || key.startsWith('plc_')) {
      continue;
    }
    const matchingPlaces = placesByBareNameLower.get(key.trim().toLowerCase());
    if (!matchingPlaces || matchingPlaces.length < 2) {
      continue;
    }
    const distinctScopes = new Set(matchingPlaces.map((p) => derivePlaceScopeHint(p).toLowerCase()));
    if (distinctScopes.size < 2) {
      continue;
    }
    const sortedMatches = [...matchingPlaces].toSorted((a, b) =>
      a.full_name.localeCompare(b.full_name),
    );
    const exampleKeys = sortedMatches
      .slice(0, 2)
      .map((p) => `"${p.name}, ${derivePlaceScopeHint(p)}"`)
      .join(' and ');
    homonymousCollisions.push({
      lexicon_key: key,
      places: sortedMatches.map((p) => ({
        id: p.id,
        name: p.name,
        full_name: p.full_name,
        scope_hint: derivePlaceScopeHint(p),
      })),
      recommendation: `Replace bare key "${key}" with qualified keys such as ${exampleKeys} (or set explicit region / match_full_name_contains).`,
    });
  }

  const strictOk =
    livingLeaks.length === 0 &&
    peoplePartial.length === 0 &&
    peopleMissing.length === 0 &&
    missingPlaces.length === 0 &&
    homonymousCollisions.length === 0;
  const ok = livingLeaks.length === 0 && (!options.strict || strictOk);

  const resultBody: Omit<PronounceAuditResult, 'rendered'> = {
    ok,
    strictOk,
    repo: repoDir,
    summary: {
      deceasedTotal: deceasedPeople.length,
      deceasedFullCoverage,
      deceasedPartialOnly: peoplePartial.length,
      deceasedMissing: peopleMissing.length,
      livingLeaks: livingLeaks.length,
      placesTotal: places.length,
      placesCovered,
      placesMissing: missingPlaces.length,
      lexicon_entries: Object.keys(lexicon).length,
      deceased_people: deceasedPeople.length,
      living_people_excluded: livingExcluded,
      places: places.length,
      missing_surnames: missingSurnames.length,
      missing_non_trivial_places: nonTrivialMissingPlaces,
      unsourced_entries: unsourcedEntries.length,
      homonymous_place_collisions: homonymousCollisions.length,
      ipa_quality_warnings: qualityWarnings.length,
    },
    living_leaks: livingLeaks,
    coverage_gaps: {
      people_missing: peopleMissing,
      people_partial: peoplePartial,
      surnames: missingSurnames,
      places: missingPlaces,
    },
    unsourced_entries: unsourcedEntries,
    homonymous_place_collisions: homonymousCollisions,
    ipa_quality_warnings: qualityWarnings,
  };

  const rendered = options.json
    ? JSON.stringify(resultBody, null, 2)
    : formatAuditText(resultBody);
  return { ...resultBody, rendered };
}
