import fs from 'node:fs';
import path from 'node:path';
import { type Pronunciation, PronunciationSchema, parseYaml } from '@kinloom/core';

const SIMPLE_PRON_KEYS = new Set([
  'phonetic',
  'ipa',
  'language',
  'audio_url',
  'note',
  'source_url',
  'source_label',
  'region',
]);

function tryFastParseSimplePronunciation(val: Record<string, unknown>): Pronunciation | null {
  const out: Record<string, string> = {};
  for (const key of Object.keys(val)) {
    if (!SIMPLE_PRON_KEYS.has(key)) {
      return null;
    }
    const v = val[key];
    if (v === undefined) {
      continue;
    }
    if (typeof v !== 'string' || v.length === 0) {
      return null;
    }
    out[key] = v;
  }
  return out as Pronunciation;
}

export function loadArchivePronunciationLexicon(
  repoDir: string,
  sitePronunciations?: Readonly<Record<string, Pronunciation>>
): Record<string, Pronunciation> {
  const merged: Record<string, Pronunciation> = { ...(sitePronunciations ?? {}) };
  const dataLexiconPath = path.join(repoDir, 'data', 'pronunciations.yaml');
  let rawText: string;
  try {
    rawText = fs.readFileSync(dataLexiconPath, 'utf8');
  } catch {
    return merged;
  }
  try {
    const parsed = parseYaml(rawText);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [key, val] of Object.entries(parsed)) {
        if (typeof val !== 'object' || val === null || Array.isArray(val)) {
          continue;
        }
        const fast = tryFastParseSimplePronunciation(val as Record<string, unknown>);
        if (fast !== null) {
          merged[key] = fast;
          continue;
        }
        const result = PronunciationSchema.safeParse(val);
        if (result.success) {
          merged[key] = result.data;
        }
      }
    }
  } catch {
    // Malformed optional data/pronunciations.yaml is surfaced by schema/YAML checks elsewhere.
  }
  return merged;
}
