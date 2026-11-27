import { createHash } from 'node:crypto';
import { CliValidationError } from '../../../../errors.js';

export const PHONEME_MODES = ['ipa', 'arpabet', 'plain'] as const;
export type PhonemeMode = (typeof PHONEME_MODES)[number];

export interface PhonemeTermHint {
  readonly text: string;
  readonly ipa?: string;
  readonly phonetic?: string;
  readonly arpabet?: string;
}

export interface PronunciationCacheKeyInput {
  readonly text: string;
  readonly phonetic?: string;
  readonly ipa?: string;
  readonly language?: string;
  readonly voice?: string;
}

const IPA_TO_ARPABET_TABLE: ReadonlyArray<readonly [string, string]> = [
  // Affricates and diphthongs (longest-first)
  ['t͡ʃ', 'CH'],
  ['d͡ʒ', 'JH'],
  ['tʃ', 'CH'],
  ['dʒ', 'JH'],
  ['aɪ', 'AY'],
  ['aʊ', 'AW'],
  ['ɔɪ', 'OY'],
  ['eɪ', 'EY'],
  ['oʊ', 'OW'],
  ['ɛɪ', 'EY'],
  ['œy', 'OY'],
  ['ʌu', 'AW'],
  ['ɑu', 'AW'],
  ['ɔy', 'OY'],
  ['ju', 'Y UW'],
  ['iː', 'IY'],
  ['uː', 'UW'],
  ['ɑː', 'AA'],
  ['ɔː', 'AO'],
  ['ɜː', 'ER'],
  ['eː', 'EY'],
  ['oː', 'OW'],
  ['aː', 'AA'],
  ['yː', 'IY'],
  ['øː', 'ER'],
  ['ʉː', 'UW'],
  ['eə', 'EH R'],
  ['ɪə', 'IH R'],
  ['ʊə', 'UH R'],
  ['ər', 'ER'],
  ['ɜr', 'ER'],
  // Single vowels
  ['i', 'IY'],
  ['ɪ', 'IH'],
  ['e', 'EH'],
  ['ɛ', 'EH'],
  ['æ', 'AE'],
  ['ɑ', 'AA'],
  ['a', 'AA'],
  ['ɒ', 'AA'],
  ['ɔ', 'AO'],
  ['o', 'OW'],
  ['ʊ', 'UH'],
  ['u', 'UW'],
  ['ʌ', 'AH'],
  ['ə', 'AH'],
  ['ɝ', 'ER'],
  ['ɚ', 'ER'],
  ['ɜ', 'ER'],
  ['y', 'IY'],
  ['ʏ', 'IH'],
  ['ø', 'ER'],
  ['œ', 'EH'],
  ['ɵ', 'UH'],
  ['ʉ', 'UW'],
  // Consonants
  ['ŋ', 'NG'],
  ['ʃ', 'SH'],
  ['ʒ', 'ZH'],
  ['θ', 'TH'],
  ['ð', 'DH'],
  ['ɹ', 'R'],
  ['ɾ', 'R'],
  ['ʁ', 'R'],
  ['ʀ', 'R'],
  ['r', 'R'],
  ['ʋ', 'V'],
  ['ɣ', 'G'],
  ['χ', 'HH'],
  ['x', 'HH'],
  ['ç', 'SH'],
  ['ɲ', 'N'],
  ['ʎ', 'L'],
  ['ɭ', 'L'],
  ['ɫ', 'L'],
  ['j', 'Y'],
  ['p', 'P'],
  ['b', 'B'],
  ['t', 'T'],
  ['d', 'D'],
  ['k', 'K'],
  ['ɡ', 'G'],
  ['g', 'G'],
  ['f', 'F'],
  ['v', 'V'],
  ['s', 'S'],
  ['z', 'Z'],
  ['h', 'HH'],
  ['ɦ', 'HH'],
  ['m', 'M'],
  ['n', 'N'],
  ['l', 'L'],
  ['w', 'W'],
];

const STRESSED_VOWELS: ReadonlySet<string> = new Set([
  'AA',
  'AE',
  'AH',
  'AO',
  'AW',
  'AY',
  'EH',
  'ER',
  'EY',
  'IH',
  'IY',
  'OW',
  'OY',
  'UH',
  'UW',
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripIpaSlashes(ipa: string): string {
  return ipa
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .trim();
}

export function parsePhonemeMode(raw: string | undefined, defaultMode: PhonemeMode = 'ipa'): PhonemeMode {
  if (raw === undefined || raw.trim() === '') {
    return defaultMode;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'ipa' || normalized === 'arpabet' || normalized === 'plain') {
    return normalized;
  }
  throw new CliValidationError(`Invalid --phoneme-mode '${raw}': choose from ipa, arpabet, plain.`);
}

/**
 * Deterministic IPA-to-ARPAbet converter for phoneme-tagged TTS models.
 * Falls back to stripped IPA when no mapped symbols exist.
 */
export function ipaToArpabet(rawIpa: string): string {
  const cleaned = stripIpaSlashes(rawIpa)
    .replace(/^\[+|\]+$/g, '')
    .trim();
  if (!cleaned) {
    return '';
  }

  const tokens: string[] = [];
  let pendingStress: '1' | '2' | null = null;
  let i = 0;

  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === 'ˈ') {
      pendingStress = '1';
      i += 1;
      continue;
    }
    if (ch === 'ˌ') {
      pendingStress = '2';
      i += 1;
      continue;
    }
    if (ch === '.' || ch === '-' || ch === 'ː' || ch === 'ˑ' || ch === '(' || ch === ')') {
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingStress = null;
      i += 1;
      continue;
    }

    let matched = false;
    for (const [ipaSeq, arpa] of IPA_TO_ARPABET_TABLE) {
      if (cleaned.startsWith(ipaSeq, i)) {
        const parts = arpa.split(' ');
        for (const part of parts) {
          if (STRESSED_VOWELS.has(part)) {
            const stress = pendingStress ?? '0';
            tokens.push(`${part}${stress}`);
            pendingStress = null;
          } else {
            tokens.push(part);
          }
        }
        i += ipaSeq.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      i += 1;
    }
  }

  return tokens.length > 0 ? tokens.join(' ') : cleaned;
}

export function formatPhonemeTerm(hint: PhonemeTermHint, mode: PhonemeMode): string {
  if (mode === 'plain') {
    return hint.phonetic?.trim() || hint.text.trim();
  }
  if (mode === 'arpabet') {
    const explicitArpabet = hint.arpabet?.trim();
    if (explicitArpabet) {
      return `<|phoneme_start|>${explicitArpabet}<|phoneme_end|>`;
    }
    const ipa = stripIpaSlashes(hint.ipa ?? '');
    if (ipa) {
      return `<|phoneme_start|>${ipaToArpabet(ipa)}<|phoneme_end|>`;
    }
    return hint.phonetic?.trim() || hint.text.trim();
  }
  const ipa = stripIpaSlashes(hint.ipa ?? '');
  if (ipa) {
    return `<|phoneme_start|>${ipa}<|phoneme_end|>`;
  }
  return hint.phonetic?.trim() || hint.text.trim();
}

export function applyPhonemeTags(
  text: string,
  hints: Readonly<Record<string, string | PhonemeTermHint>>,
  mode: PhonemeMode
): string {
  let out = text;
  const entries = Object.entries(hints).sort((a, b) => b[0].length - a[0].length);
  for (const [term, value] of entries) {
    if (!term.trim()) {
      continue;
    }
    const hint: PhonemeTermHint =
      typeof value === 'string'
        ? { text: term, ipa: value }
        : { text: value.text || term, ipa: value.ipa, phonetic: value.phonetic, arpabet: value.arpabet };
    const replacement = formatPhonemeTerm(hint, mode);
    if (!replacement || replacement === term) {
      continue;
    }
    const rx = new RegExp(`(?<![\\w/])${escapeRegExp(term)}(?![\\w/])`, 'g');
    out = out.replace(rx, () => replacement);
  }
  return out;
}

/**
 * Compute the deterministic v2 SHA-256 cache key matching
 * `packages/server/src/services/pronunciationHelper.ts` byte-for-byte.
 * IPA preserves case because IPA distinguishes case (e.g., /I/ vs /i/).
 */
export function computePronunciationCacheKey(params: PronunciationCacheKeyInput): string {
  const text = params.text.trim().toLowerCase();
  const phonetic = (params.phonetic ?? '').trim().toLowerCase();
  const ipa = stripIpaSlashes(params.ipa ?? '');
  const lang = (params.language ?? '').trim().toLowerCase();
  const voice = (params.voice ?? 'Charon').trim().toLowerCase();
  const payload = `v2|text:${text}|phonetic:${phonetic}|ipa:${ipa}|lang:${lang}|voice:${voice}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function pronunciationAudioFilename(
  params: PronunciationCacheKeyInput & { readonly ext?: 'wav' | 'mp3' }
): string {
  const ext = params.ext ?? 'wav';
  const hash = computePronunciationCacheKey(params);
  return `pronunciation-${hash.slice(0, 16)}.${ext}`;
}
