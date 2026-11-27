import { LANG_DISPLAY_NAMES, normalizeLangCode } from './types.js';

const IPA_NON_VALUE_TOKENS = new Set(['pron', 'lang', 'local', 'also', 'ipa', '-', 'or', 'and', 'locally']);

export interface MediaWikiQueryResponse {
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

export interface WikiTargetSpec {
  host: string;
  project: 'wiktionary' | 'wikipedia';
  wikiLang: string;
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
  const normalized = filename
    .replace(/^File:/i, '')
    .trim()
    .replaceAll(' ', '_');
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(normalized)}`;
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

    if (lowerName === 'pron' && positional.length >= 1) {
      const tplLang = positional[1] ? normalizeLangCode(positional[1]) : wikiLang;
      if (!targetLang || !tplLang || tplLang === targetLang) {
        addIpa(positional[0]);
      }
      continue;
    }

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

export function buildWikiTargets(lang: string | null): WikiTargetSpec[] {
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

export function formatWikiSourceLabel(target: WikiTargetSpec, lang: string | null): string {
  const projectLabel = target.project === 'wiktionary' ? 'Wiktionary' : 'Wikipedia';
  const langKey = lang ?? target.wikiLang;
  const langDisplay = LANG_DISPLAY_NAMES[langKey] ?? langKey;
  return `${projectLabel} (${langDisplay} IPA)`;
}
