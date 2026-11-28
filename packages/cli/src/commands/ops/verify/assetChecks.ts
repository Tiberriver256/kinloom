import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fastLocaleCompare, parseYaml } from '@kinloom/core';
import type {
  LoadedVerifyArchive,
  VerifyExternalMediaHit,
  VerifyExternalMediaResult,
  VerifyTrackedBinaryExtension,
  VerifyTrackedMediaFile,
  VerifyTrackedMediaResult,
} from './types.js';

const EXTERNAL_SCHEME_RE = /^(?:https?:)?\/\//i;
const FALLBACK_HOST_RE = /^(?:https?:)?\/\/([^/?#]+)/i;

const RENDERED_ASSET_EXTENSION_KEYS = new Set([
  'audio_url',
  'token_audio_urls',
  'portrait_url',
  'thumb_url',
  'photo_url',
  'poster_url',
  'file',
  'thumb_file',
]);

const RAW_TOKEN_AUDIO_YAML_FILES = new Set(['people.yaml', 'places.yaml', 'media.yaml', 'narratives.yaml']);

const TRACKED_BINARY_EXTENSIONS = new Set<VerifyTrackedBinaryExtension>(['.mp3', '.wav', '.mp4']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractExternalAssetHost(rawValue: unknown): { url: string; host: string } | null {
  if (typeof rawValue !== 'string') {
    return null;
  }
  const trimmed = rawValue.trim();
  if (!trimmed || !EXTERNAL_SCHEME_RE.test(trimmed)) {
    return null;
  }
  const normalized = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname) {
      return { url: trimmed, host: parsed.hostname.toLowerCase() };
    }
  } catch {
    // Fall through to regex extraction for malformed URLs with an external scheme.
  }
  const match = FALLBACK_HOST_RE.exec(trimmed);
  const authority = match?.[1] ?? '';
  const hostPort = authority.includes('@') ? (authority.split('@').at(-1) ?? '') : authority;
  const host = (hostPort.split(':')[0] ?? '').toLowerCase();
  return { url: trimmed, host: host || 'unknown' };
}

function compareExternalMediaHits(a: VerifyExternalMediaHit, b: VerifyExternalMediaHit): number {
  return (
    fastLocaleCompare(a.file, b.file) ||
    fastLocaleCompare(a.entityId, b.entityId) ||
    fastLocaleCompare(a.field, b.field) ||
    fastLocaleCompare(a.url, b.url)
  );
}

export function scanExternalMediaUrls(
  archive: Pick<
    LoadedVerifyArchive,
    | 'repoDir'
    | 'siteConfig'
    | 'people'
    | 'places'
    | 'events'
    | 'media'
    | 'narratives'
    | 'enrichments'
    | 'yamlTexts'
  >
): VerifyExternalMediaResult {
  const hits: VerifyExternalMediaHit[] = [];
  const seen = new Set<string>();
  let checkedCount = 0;

  const inspectUrl = (file: string, entityId: string, field: string, rawValue: unknown): void => {
    if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
      return;
    }
    checkedCount += 1;
    const external = extractExternalAssetHost(rawValue);
    if (!external) {
      return;
    }
    const dedupeKey = `${file}\0${entityId}\0${field}\0${external.url}`;
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    hits.push({
      file,
      entityId,
      field,
      url: external.url,
      host: external.host,
    });
  };

  const inspectTokenAudioArray = (
    file: string,
    entityId: string,
    fieldPrefix: string,
    rawArray: unknown
  ): void => {
    if (!Array.isArray(rawArray)) {
      return;
    }
    for (let i = 0; i < rawArray.length; i += 1) {
      inspectUrl(file, entityId, `${fieldPrefix}[${i}]`, rawArray[i]);
    }
  };

  const inspectPronunciation = (file: string, entityId: string, pron: unknown, fieldPrefix: string): void => {
    if (!isPlainRecord(pron)) {
      return;
    }
    inspectUrl(file, entityId, `${fieldPrefix}.audio_url`, pron['audio_url']);
    inspectTokenAudioArray(file, entityId, `${fieldPrefix}.token_audio_urls`, pron['token_audio_urls']);
    const variants = pron['variants'];
    if (Array.isArray(variants)) {
      for (let i = 0; i < variants.length; i += 1) {
        const variant = variants[i];
        if (!isPlainRecord(variant)) {
          continue;
        }
        inspectUrl(file, entityId, `${fieldPrefix}.variants[${i}].audio_url`, variant['audio_url']);
        inspectTokenAudioArray(
          file,
          entityId,
          `${fieldPrefix}.variants[${i}].token_audio_urls`,
          variant['token_audio_urls']
        );
      }
    }
  };

  const inspectExtensions = (file: string, entityId: string, value: unknown, fieldPrefix: string): void => {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        inspectExtensions(file, entityId, value[i], `${fieldPrefix}[${i}]`);
      }
      return;
    }
    if (!isPlainRecord(value)) {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      const nextPrefix = `${fieldPrefix}.${key}`;
      if (RENDERED_ASSET_EXTENSION_KEYS.has(key)) {
        if (key === 'token_audio_urls') {
          inspectTokenAudioArray(file, entityId, nextPrefix, entry);
        } else {
          inspectUrl(file, entityId, nextPrefix, entry);
        }
      } else if (Array.isArray(entry) || isPlainRecord(entry)) {
        inspectExtensions(file, entityId, entry, nextPrefix);
      }
    }
  };

  // 1. data/media.yaml
  for (const item of archive.media) {
    inspectUrl('data/media.yaml', item.id, 'file', item.file);
    inspectUrl('data/media.yaml', item.id, 'thumb_file', item.thumb_file);
    inspectUrl('data/media.yaml', item.id, 'poster_url', item.poster_url);
    inspectUrl('data/media.yaml', item.id, 'transcript_url', item.transcript_url);
    if (item.extensions) {
      inspectExtensions('data/media.yaml', item.id, item.extensions, 'extensions');
    }
  }

  // 2. data/people.yaml
  for (const person of archive.people) {
    inspectUrl('data/people.yaml', person.id, 'portrait_url', person.portrait_url);
    inspectUrl('data/people.yaml', person.id, 'thumb_url', person.thumb_url);
    inspectPronunciation('data/people.yaml', person.id, person.pronunciation, 'pronunciation');
    if (person.extensions) {
      inspectExtensions('data/people.yaml', person.id, person.extensions, 'extensions');
    }
  }

  // 3. data/places.yaml
  for (const place of archive.places) {
    inspectUrl('data/places.yaml', place.id, 'photo_url', place.photo_url);
    inspectPronunciation('data/places.yaml', place.id, place.pronunciation, 'pronunciation');
    if (place.extensions) {
      inspectExtensions('data/places.yaml', place.id, place.extensions, 'extensions');
    }
  }

  // 4. data/events.yaml (photo_url and extensions only; source_url is a citation URL)
  for (const event of archive.events) {
    inspectUrl('data/events.yaml', event.id, 'photo_url', event.photo_url);
    if (event.extensions) {
      inspectExtensions('data/events.yaml', event.id, event.extensions, 'extensions');
    }
  }

  // 5. data/narrative-enrichments.yaml
  for (const enrichment of archive.enrichments) {
    const entityId = 'override_event_id' in enrichment ? enrichment.override_event_id : enrichment.id;
    inspectUrl('data/narrative-enrichments.yaml', entityId, 'photo_url', enrichment.photo_url);
  }

  // 6. data/narratives.yaml (extensions only; body_md citations are prose links, not rendered media fields)
  for (const narrative of archive.narratives) {
    if (narrative.extensions) {
      inspectExtensions('data/narratives.yaml', narrative.id, narrative.extensions, 'extensions');
    }
  }

  // 7. kinloom.config.yaml pronunciations
  if (archive.siteConfig.pronunciations) {
    for (const [key, pron] of Object.entries(archive.siteConfig.pronunciations)) {
      inspectPronunciation('kinloom.config.yaml', key, pron, `pronunciations.${key}`);
    }
  }

  // 8. Optional data/pronunciations.yaml lexicon
  const pronunciationsYamlPath = path.join(archive.repoDir, 'data', 'pronunciations.yaml');
  let rawPronunciationsYaml: string | null = null;
  try {
    rawPronunciationsYaml = fs.readFileSync(pronunciationsYamlPath, 'utf8');
  } catch {
    rawPronunciationsYaml = null;
  }
  if (rawPronunciationsYaml !== null) {
    try {
      const parsed = parseYaml(rawPronunciationsYaml);
      if (isPlainRecord(parsed)) {
        for (const [key, val] of Object.entries(parsed)) {
          if (isPlainRecord(val)) {
            inspectPronunciation('data/pronunciations.yaml', key, val, key);
          }
        }
      }
    } catch {
      // Malformed optional data/pronunciations.yaml is handled elsewhere.
    }
  }

  // 9. Raw token_audio_urls in entity YAML files (Zod strips unknown token_audio_urls on PronunciationSchema)
  for (const yamlFile of archive.yamlTexts) {
    if (!RAW_TOKEN_AUDIO_YAML_FILES.has(yamlFile.name) || !yamlFile.content.includes('token_audio_urls')) {
      continue;
    }
    try {
      const parsed = parseYaml(yamlFile.content);
      if (!Array.isArray(parsed)) {
        continue;
      }
      const relFile = `data/${yamlFile.name}`;
      for (const entry of parsed) {
        if (!isPlainRecord(entry)) {
          continue;
        }
        const entityId =
          typeof entry['id'] === 'string' && entry['id'].trim() ? entry['id'].trim() : 'unknown';
        inspectTokenAudioArray(relFile, entityId, 'token_audio_urls', entry['token_audio_urls']);
        if (isPlainRecord(entry['pronunciation'])) {
          inspectPronunciation(relFile, entityId, entry['pronunciation'], 'pronunciation');
        }
      }
    } catch {
      // Malformed YAML is already reported by archive loader.
    }
  }

  hits.sort(compareExternalMediaHits);
  return {
    ok: hits.length === 0,
    checkedCount,
    hits,
  };
}

function defaultExecGitLsFiles(cwd: string): string {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isTrackedBinaryExtension(ext: string): ext is VerifyTrackedBinaryExtension {
  return TRACKED_BINARY_EXTENSIONS.has(ext as VerifyTrackedBinaryExtension);
}

export function scanTrackedBinaryMedia(
  repoDir: string,
  options?: { execGitLsFiles?: (cwd: string) => string }
): VerifyTrackedMediaResult {
  const runner = options?.execGitLsFiles ?? defaultExecGitLsFiles;
  let stdout: string;
  try {
    stdout = runner(repoDir);
  } catch {
    return {
      ok: true,
      isGitRepo: false,
      trackedCount: 0,
      files: [],
    };
  }

  const trackedPaths = stdout.split('\0').filter((entry) => entry.length > 0);
  const files: VerifyTrackedMediaFile[] = [];

  for (const rawPath of trackedPaths) {
    const normalizedPath = rawPath.replaceAll('\\', '/');
    const ext = path.posix.extname(normalizedPath).toLowerCase();
    if (isTrackedBinaryExtension(ext)) {
      files.push({
        path: normalizedPath,
        extension: ext,
      });
    }
  }

  files.sort((a, b) => fastLocaleCompare(a.path, b.path));
  return {
    ok: files.length === 0,
    isGitRepo: true,
    trackedCount: trackedPaths.length,
    files,
  };
}
