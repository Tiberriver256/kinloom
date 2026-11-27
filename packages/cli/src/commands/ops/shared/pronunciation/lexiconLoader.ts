import fs from 'node:fs';
import path from 'node:path';
import { type Pronunciation, PronunciationSchema, parseYaml } from '@kinloom/core';

export function loadArchivePronunciationLexicon(
  repoDir: string,
  sitePronunciations?: Readonly<Record<string, Pronunciation>>
): Record<string, Pronunciation> {
  const merged: Record<string, Pronunciation> = { ...(sitePronunciations ?? {}) };
  const dataLexiconPath = path.join(repoDir, 'data', 'pronunciations.yaml');
  if (fs.existsSync(dataLexiconPath)) {
    try {
      const parsed = parseYaml(fs.readFileSync(dataLexiconPath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val !== 'object' || val === null || Array.isArray(val)) {
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
  }
  return merged;
}
