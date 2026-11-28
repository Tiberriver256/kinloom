import { MONTHS } from '@kinloom/core';

function formatSingleArchivalPoint(rawPart: string): string {
  const trimmed = rawPart.trim();
  if (!trimmed) {
    return '';
  }

  let prefix = '';
  let core = trimmed;
  const lastChar = core.at(-1);
  if (lastChar === '~' || lastChar === '%') {
    prefix = 'c. ';
    core = core.slice(0, -1);
  } else if (lastChar === '?') {
    prefix = 'est. ';
    core = core.slice(0, -1);
  }

  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(core);
  if (dayMatch) {
    const year = dayMatch[1];
    const monthIdx = Number(dayMatch[2]) - 1;
    const day = Number(dayMatch[3]);
    if (monthIdx >= 0 && monthIdx < 12 && day >= 1 && day <= 31) {
      return `${prefix}${day} ${MONTHS[monthIdx]} ${year}`;
    }
  }

  const monthMatch = /^(\d{4})-(\d{2})$/.exec(core);
  if (monthMatch) {
    const year = monthMatch[1];
    const monthIdx = Number(monthMatch[2]) - 1;
    if (monthIdx >= 0 && monthIdx < 12) {
      return `${prefix}${MONTHS[monthIdx]} ${year}`;
    }
  }

  const decadeMatch = /^(\d{3})X$/i.exec(core);
  if (decadeMatch) {
    return `${prefix}${Number(decadeMatch[1]) * 10}s`;
  }

  return `${prefix}${core}`;
}

/**
 * Format an EDTF date or interval into day-first human-readable archival notation
 * (e.g. "1778-01-05" -> "5 Jan 1778", "1781~" -> "c. 1781", "/1820" -> "Bef. 1820").
 */
export function formatArchivalEdtfDate(edtf: string | number | null | undefined): string {
  if (edtf === null || edtf === undefined || edtf === '') {
    return 'Undated';
  }
  const raw = String(edtf).trim();
  if (!raw) {
    return 'Undated';
  }

  const slashIdx = raw.indexOf('/');
  if (slashIdx !== -1) {
    const leftRaw = raw.slice(0, slashIdx).trim();
    const rightRaw = raw.slice(slashIdx + 1).trim();
    const leftOpen = !leftRaw || leftRaw === '..';
    const rightOpen = !rightRaw || rightRaw === '..';

    if (leftOpen && !rightOpen) {
      return `Bef. ${formatSingleArchivalPoint(rightRaw)}`;
    }
    if (!leftOpen && rightOpen) {
      return `Aft. ${formatSingleArchivalPoint(leftRaw)}`;
    }
    if (!leftOpen && !rightOpen) {
      const leftFmt = formatSingleArchivalPoint(leftRaw);
      const rightFmt = formatSingleArchivalPoint(rightRaw);
      const hasSpaces = leftFmt.includes(' ') || rightFmt.includes(' ');
      return hasSpaces ? `${leftFmt} – ${rightFmt}` : `${leftFmt}–${rightFmt}`;
    }
    return 'Undated';
  }

  return formatSingleArchivalPoint(raw);
}
