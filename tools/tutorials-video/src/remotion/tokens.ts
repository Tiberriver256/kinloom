import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ArchivalVideoPalette {
  readonly surfaceCanvas: string;
  readonly surfaceCard: string;
  readonly surfaceLinen: string;
  readonly surfaceHeader: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textInverse: string;
  readonly accentPrimary: string;
  readonly accentSecondary: string;
  readonly borderDecorative: string;
  readonly borderControl: string;
  readonly fontSerif: string;
  readonly fontMono: string;
}

interface RawTokensDocument {
  readonly color: {
    readonly primitive: Record<string, { readonly $value: string }>;
    readonly primitiveDark: Record<string, { readonly $value: string }>;
    readonly semantic: Record<string, { readonly $value: string }>;
    readonly semanticDark: Record<string, { readonly $value: string }>;
  };
}

function resolveRef(val: string, doc: RawTokensDocument): string {
  const match = /^\{color\.(primitive|primitiveDark)\.([^}]+)\}$/.exec(val);
  if (!match) {
    return val;
  }
  const bucket = match[1] === 'primitive' ? doc.color.primitive : doc.color.primitiveDark;
  return bucket[match[2]]?.$value ?? val;
}

const DEFAULT_TOKENS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/tokens/tokens.json'
);

export function loadArchivalVideoPalette(
  theme: 'light' | 'dark' = 'light',
  tokensPath = DEFAULT_TOKENS_PATH
): ArchivalVideoPalette {
  const raw = JSON.parse(fs.readFileSync(tokensPath, 'utf8')) as RawTokensDocument;
  const semantic = theme === 'dark' ? raw.color.semanticDark : raw.color.semantic;
  const pick = (key: string, fallback: string): string =>
    semantic[key] ? resolveRef(semantic[key].$value, raw) : fallback;

  return {
    surfaceCanvas: pick('surface-canvas', '#F5EFE2'),
    surfaceCard: pick('surface-card', '#FCF9F2'),
    surfaceLinen: pick('surface-linen', '#EAE1CE'),
    surfaceHeader: pick('surface-header', '#1B2A41'),
    textPrimary: pick('text-primary', '#23272E'),
    textSecondary: pick('text-secondary', '#4E4A42'),
    textInverse: pick('text-inverse', '#FCF9F2'),
    accentPrimary: pick('accent-primary', '#7A4612'),
    accentSecondary: pick('accent-secondary', '#2F5245'),
    borderDecorative: pick('border-decorative', '#D6CEBE'),
    borderControl: pick('border-control', '#827A6A'),
    fontSerif: "'Newsreader', Georgia, serif",
    fontMono: "'IBM Plex Mono', ui-monospace, monospace",
  };
}
