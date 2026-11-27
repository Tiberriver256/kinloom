import { countWords, NOTES_MARKER, splitScript } from './script.js';

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

export interface ScriptLintResult {
  readonly sections: readonly string[];
  readonly notes: readonly string[];
  readonly wordCount: number;
  readonly problems: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function lintNarrativeScript(
  scriptLabel: string,
  text: string,
  names?: Readonly<Record<string, string>>
): ScriptLintResult {
  const problems: string[] = [];
  const patterns: readonly (readonly [string, RegExp])[] = [
    ["day-before-month date (write 'May ninth, 1766')", new RegExp(`\\b\\d{1,2} (${MONTHS})\\b`)],
    ["numeric month-day date (write 'May ninth')", new RegExp(`\\b(${MONTHS}) \\d{1,2}\\b(?!\\d)`)],
    ["currency symbol (write '470 pounds')", /[£$]/],
    ['s./d. money abbreviation', /\b\d+[sd]\./],
    ['citation remnant', /\b(Lib\.|Vol\.|pp?\.\s*\d|DB \d|FHL|Book \d+)/],
    ["slash (write 'or')", /\S\/\S/],
    ['comma-grouped number (Chirp pauses on commas; spell out in words)', /\b\d{1,3}(?:,\d{3})+\b/],
    ['abbreviation to spell out', /\b(ca\.|b\.|d\.|decd|Co\.|Jr\.|Sr\.|Capt\.|U\.S\.|No\.)(?=\s|$)/],
    ['markdown emphasis or link', /[*_`]|\]\(/],
    ['quotation mark', /["\u201c\u201d]/],
  ];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const [label, rx] of patterns) {
      if (rx.test(line)) {
        problems.push(`${scriptLabel}:${i + 1}: ${label}: ${line.trim().slice(0, 100)}`);
      }
    }
  }

  if (!text.includes(NOTES_MARKER)) {
    problems.push(`no '${NOTES_MARKER}' section (fine only if there are no notes)`);
  }

  if (names) {
    for (const [k, v] of Object.entries(names)) {
      const rx = new RegExp(`(?<!\\w)${escapeRegExp(k)}(?!\\w)`);
      if (!rx.test(text)) {
        problems.push(`names: '${k}' does not appear in the script`);
      }
      if (!(v.startsWith('/') && v.endsWith('/'))) {
        problems.push(`names: '${k}' value is not /IPA/ in slashes: ${v}`);
      }
    }
  }

  const { sections, notes } = splitScript(text);
  return {
    sections,
    notes,
    wordCount: countWords(text),
    problems,
  };
}
