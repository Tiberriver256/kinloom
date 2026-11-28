export type NarrativeAudioDownloadKind = 'biography' | 'family_story' | 'research_note' | 'memoir';

export interface NarrativeAudioDownloadInput {
  readonly src: string;
  readonly narrativeSlug?: string | null;
  readonly narrativeTitle: string;
  readonly narrativeKind: NarrativeAudioDownloadKind;
  readonly personSlug?: string | null;
}

export interface NarrativeAudioDownloadDescriptor {
  readonly href: string;
  readonly filename: string;
  readonly extension: string;
  readonly formatLabel: string;
}

const KNOWN_AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'ogg', 'aac', 'flac', 'opus', 'webm']);
const DEFAULT_AUDIO_EXTENSION = 'mp3';
const DEFAULT_FILENAME_STEM = 'narrative-audio';
const MAX_FILENAME_STEM_LENGTH = 80;

export function sanitizeAudioFilenameStem(raw: string | null | undefined): string {
  if (!raw) {
    return '';
  }
  const normalized = raw
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (normalized.length <= MAX_FILENAME_STEM_LENGTH) {
    return normalized;
  }
  return normalized.slice(0, MAX_FILENAME_STEM_LENGTH).replace(/-+$/g, '');
}

export function extractAudioExtension(src: string): string {
  const withoutQueryOrHash = src.split(/[?#]/, 1)[0] ?? '';
  const lastSegment = withoutQueryOrHash.split('/').pop() ?? '';
  const match = /\.([a-zA-Z0-9]{2,5})$/.exec(lastSegment);
  if (!match) {
    return DEFAULT_AUDIO_EXTENSION;
  }
  const ext = match[1].toLowerCase();
  return KNOWN_AUDIO_EXTENSIONS.has(ext) ? ext : DEFAULT_AUDIO_EXTENSION;
}

function resolveDownloadStem(input: NarrativeAudioDownloadInput): string {
  const narrativeSlugStem = sanitizeAudioFilenameStem(input.narrativeSlug);
  if (narrativeSlugStem) {
    return narrativeSlugStem;
  }
  const personSlugStem = sanitizeAudioFilenameStem(input.personSlug);
  if (input.narrativeKind === 'biography' && personSlugStem) {
    return personSlugStem.endsWith('-biography') ? personSlugStem : `${personSlugStem}-biography`;
  }
  const titleStem = sanitizeAudioFilenameStem(input.narrativeTitle);
  if (titleStem) {
    return titleStem;
  }
  if (personSlugStem) {
    return personSlugStem;
  }
  return DEFAULT_FILENAME_STEM;
}

function isServerMediaPathname(pathname: string): boolean {
  return pathname.startsWith('/media/') && pathname.length > '/media/'.length;
}

function buildDownloadHref(src: string, filename: string): string {
  const trimmed = src.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      if (!isServerMediaPathname(parsed.pathname)) {
        return trimmed;
      }
      parsed.searchParams.set('download', '1');
      parsed.searchParams.set('filename', filename);
      return parsed.toString();
    } catch {
      return trimmed;
    }
  }
  if (trimmed.startsWith('/media/')) {
    try {
      const parsed = new URL(trimmed, 'https://kinloom.invalid');
      if (!isServerMediaPathname(parsed.pathname)) {
        return trimmed;
      }
      parsed.searchParams.set('download', '1');
      parsed.searchParams.set('filename', filename);
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function buildNarrativeAudioDownload(
  input: NarrativeAudioDownloadInput
): NarrativeAudioDownloadDescriptor {
  const extension = extractAudioExtension(input.src);
  const stem = resolveDownloadStem(input);
  const filename = `${stem}.${extension}`;
  return {
    href: buildDownloadHref(input.src, filename),
    filename,
    extension,
    formatLabel: extension.toUpperCase(),
  };
}
