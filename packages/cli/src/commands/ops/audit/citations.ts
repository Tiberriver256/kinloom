import {
  type CitationsCheckResult,
  isPlainRecord,
  type LooseRecord,
  type UncitedSentenceItem,
} from './types.js';

const INLINE_CITATION_RE = /\[\^src_[A-Za-z0-9._:-]+(?:\|[A-Za-z0-9._:-]+)?\]/;

const ABBREVIATIONS = [
  'Mr.',
  'Mrs.',
  'Ms.',
  'Dr.',
  'Prof.',
  'Rev.',
  'Hon.',
  'Gov.',
  'Pres.',
  'Sen.',
  'Rep.',
  'Esq.',
  'Fr.',
  'Br.',
  'Mme.',
  'Mlle.',
  'Messrs.',
  'Supt.',
  'Jr.',
  'Sr.',
  'Gen.',
  'Col.',
  'Maj.',
  'Capt.',
  'Lt.',
  'Lieut.',
  'Sgt.',
  'Sergt.',
  'Cpl.',
  'Corpl.',
  'Pfc.',
  'PFC.',
  'Pvt.',
  'Adm.',
  'Brig.',
  'Cmdr.',
  'Ens.',
  'Spc.',
  'Spec.',
  'Nr.',
  'Nrs.',
  'nr.',
  'nrs.',
  'No.',
  'Nos.',
  'Vol.',
  'Vols.',
  'vol.',
  'vols.',
  'Lib.',
  'Fol.',
  'Fols.',
  'fol.',
  'fols.',
  'Reg.',
  'reg.',
  'Inv.',
  'inv.',
  'Afd.',
  'afd.',
  'Blz.',
  'blz.',
  'Hfdst.',
  'Vgl.',
  'vgl.',
  'Geb.',
  'geb.',
  'Ged.',
  'ged.',
  'Overl.',
  'overl.',
  'Begr.',
  'begr.',
  'Ch.',
  'ch.',
  'Sec.',
  'sec.',
  'Par.',
  'par.',
  'Pars.',
  'pars.',
  'Fig.',
  'Figs.',
  'fig.',
  'figs.',
  'Art.',
  'art.',
  'Bk.',
  'bk.',
  'Pt.',
  'pt.',
  'Ser.',
  'ser.',
  'Ed.',
  'Eds.',
  'ed.',
  'eds.',
  'p.',
  'pp.',
  'c.',
  'ca.',
  'cf.',
  'fl.',
  'abt.',
  'bef.',
  'aft.',
  'est.',
  'approx.',
  'e.g.',
  'i.e.',
  'et al.',
  'etc.',
  'vs.',
  'v.',
  'viz.',
  'Twp.',
  'twp.',
  'Co.',
  'St.',
  'Ste.',
  'Ave.',
  'Blvd.',
  'Rd.',
  'Ln.',
  'Ct.',
  'Pl.',
  'Sq.',
  'Dist.',
  'Pct.',
  'Mt.',
  'Ft.',
  'Isl.',
  'R.F.D.',
  'R.R.',
  'P.O.',
  'Bldg.',
  'Dept.',
  'Assn.',
  'Bros.',
  'Inc.',
  'Ltd.',
  'Corp.',
  'Mfg.',
  'Jan.',
  'Feb.',
  'Mar.',
  'Apr.',
  'Jun.',
  'Jul.',
  'Aug.',
  'Sep.',
  'Sept.',
  'Oct.',
  'Nov.',
  'Dec.',
  'JAN.',
  'FEB.',
  'MAR.',
  'APR.',
  'JUN.',
  'JUL.',
  'AUG.',
  'SEP.',
  'SEPT.',
  'OCT.',
  'NOV.',
  'DEC.',
  'U.S.',
  'U.S.A.',
  'D.C.',
  'Ala.',
  'Ariz.',
  'Ark.',
  'Calif.',
  'Colo.',
  'Conn.',
  'Del.',
  'Fla.',
  'Ga.',
  'Ill.',
  'Ind.',
  'Kan.',
  'Kans.',
  'Ky.',
  'La.',
  'Mass.',
  'Md.',
  'Mich.',
  'Minn.',
  'Miss.',
  'Mo.',
  'Mont.',
  'N.C.',
  'N.D.',
  'N.H.',
  'N.J.',
  'N.M.',
  'N.Y.',
  'Neb.',
  'Nebr.',
  'Nev.',
  'Okla.',
  'Ore.',
  'Oreg.',
  'Pa.',
  'R.I.',
  'S.C.',
  'S.D.',
  'Tenn.',
  'Tex.',
  'Va.',
  'Vt.',
  'W.Va.',
  'Wash.',
  'Wis.',
  'Wisc.',
  'Wyo.',
  'Ont.',
  'Que.',
  'N.S.',
  'N.B.',
  'B.C.',
  'A.D.',
  'a.m.',
  'p.m.',
  'b.',
  'd.',
  'm.',
  'bur.',
  'bap.',
  'chr.',
] as const;

const ABBREVIATION_RE = new RegExp(
  `(?<![A-Za-z])(?:${[...ABBREVIATIONS]
    .toSorted((a, b) => b.length - a.length)
    .map((abbr) => abbr.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})`,
  'g'
);
const LOWERCASE_NUMBER_ABBR_RE = /(?<![A-Za-z])nos?\.(?=\s+(?:\d|[IVX]+\b|[A-Za-z]\d))/g;
const CITATION_FOLLOWS_RE = /^["”’')]*\[\^[^\]]+\]/;

export function splitParagraphIntoSentences(paragraph: string): string[] {
  let protectedText = paragraph.replaceAll(/\s+/g, ' ').trim();
  if (!protectedText) {
    return [];
  }

  protectedText = protectedText.replaceAll(/`[^`]+`/g, (m) =>
    m.replaceAll('.', '\u0001').replaceAll('!', '\u0002').replaceAll('?', '\u0003')
  );

  const maskAbbreviation = (match: string, offset: number, full: string): string => {
    const after = full.slice(offset + match.length);
    if (CITATION_FOLLOWS_RE.test(after) && match.endsWith('.')) {
      return `${match.slice(0, -1).replaceAll('.', '\u0001')}.`;
    }
    return match.replaceAll('.', '\u0001');
  };
  protectedText = protectedText.replaceAll(ABBREVIATION_RE, maskAbbreviation);
  protectedText = protectedText.replaceAll(LOWERCASE_NUMBER_ABBR_RE, maskAbbreviation);
  protectedText = protectedText.replaceAll(/(?<![A-Za-z])([A-Z])\.(?=\s+[A-Za-z&(])/g, '$1\u0001');

  const rawParts = protectedText.split(/(?<=[.!?]["”’')]*?(?:\[\^[^\]]+\])*)\s+(?=[A-Z0-9"“‘'([]|[^a-z\s])/);

  return rawParts
    .map((s) => s.replaceAll('\u0001', '.').replaceAll('\u0002', '!').replaceAll('\u0003', '?').trim())
    .filter((s) => s.length > 0);
}

export function runUncitedSentenceCheck(patch: LooseRecord): CitationsCheckResult {
  const narratives = Array.isArray(patch['narratives']) ? patch['narratives'] : [];
  let totalSentences = 0;
  let citedSentences = 0;
  const uncitedSentences: UncitedSentenceItem[] = [];

  for (const rawNar of narratives) {
    if (!isPlainRecord(rawNar)) {
      continue;
    }
    const body = typeof rawNar['body_md'] === 'string' ? rawNar['body_md'] : '';
    if (!body) {
      continue;
    }
    const narId = typeof rawNar['id'] === 'string' ? rawNar['id'] : 'unknown';

    const withoutCode = body.replaceAll(/```[\s\S]*?```/g, '\n');
    const lines = withoutCode.replaceAll('\r\n', '\n').split('\n');

    const proseParagraphs: string[] = [];
    let current: string[] = [];
    const flush = (): void => {
      if (current.length > 0) {
        proseParagraphs.push(current.join(' ').trim());
        current = [];
      }
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        flush();
        continue;
      }
      if (
        /^#{1,6}\s/.test(line) ||
        line.startsWith('>') ||
        /^[-*_]{3,}$/.test(line) ||
        line.startsWith('|') ||
        /^\[\^[^\]]+\]:/.test(line) ||
        line.startsWith('![')
      ) {
        flush();
        continue;
      }
      if (/^(?:[-*+]|\d+[.)])\s/.test(line)) {
        flush();
        const stripped = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim();
        if (stripped.endsWith(':') || !/[.!?](?:\[\^[^\]]+\])*$/.test(stripped) || stripped.length < 40) {
          continue;
        }
        proseParagraphs.push(stripped);
        continue;
      }
      if (/^\*\*[^*]+\*\*:?$/.test(line)) {
        flush();
        continue;
      }
      current.push(line);
    }
    flush();

    for (let pIdx = 0; pIdx < proseParagraphs.length; pIdx += 1) {
      const para = proseParagraphs[pIdx];
      if (para === undefined) continue;
      const sentences = splitParagraphIntoSentences(para);
      for (const sentence of sentences) {
        if (sentence.split(/\s+/).length < 4) {
          continue;
        }
        totalSentences += 1;
        if (INLINE_CITATION_RE.test(sentence)) {
          citedSentences += 1;
        } else {
          uncitedSentences.push({
            narrative_id: narId,
            paragraph: pIdx + 1,
            text: sentence.length > 220 ? `${sentence.slice(0, 217)}...` : sentence,
          });
        }
      }
    }
  }

  return {
    ok: uncitedSentences.length === 0,
    totalSentences,
    citedSentences,
    uncitedCount: uncitedSentences.length,
    uncitedSentences,
  };
}
