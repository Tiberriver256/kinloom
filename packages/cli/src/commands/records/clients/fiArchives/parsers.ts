import { collapseWhitespace, loadHtml } from '../../runtime/parse.js';
import {
  ASTIA_CARD_BASE,
  BOOK_LABELS,
  DIGIHAKEMISTO_ARCHIVE_BASE,
  DIGIHAKEMISTO_BASE,
  type DigihakemistoArchiveDetail,
  type DigihakemistoArchiveRow,
  type DigihakemistoChildRow,
  HISKI_BASE,
  HISKI_ENDPOINT,
  HISKI_EVENT_HREF_RE,
  HISKI_PERMALINK_RE,
  type HiskiEventDetail,
  type HiskiParish,
  type HiskiRecord,
  type HiskiSearchResult,
  PARISH_CODE_RE,
  TOTAL_EVENTS_RE,
} from './domain.js';

function cleanText(raw: string): string {
  return collapseWhitespace(raw.replaceAll('\u00A0', ' '));
}

function unescapeAndClean(raw: string): string {
  const $ = loadHtml(`<div>${raw}</div>`);
  return cleanText($('div').text());
}

export function parseHiskiParishes(page: string): HiskiParish[] {
  const seen = new Set<string>();
  const parishes: HiskiParish[] = [];
  const regex = /<OPTION\s+VALUE="?([^">]+)"?[^>]*>([^<\r\n]+)/gi;
  for (const match of page.matchAll(regex)) {
    const code = match[1].trim();
    const name = unescapeAndClean(match[2]);
    if (!PARISH_CODE_RE.test(code) || !name || seen.has(code)) {
      continue;
    }
    seen.add(code);
    parishes.push({
      code,
      name,
      url: `${HISKI_ENDPOINT}?en+${code}`,
    });
  }
  return parishes;
}

function hiskiRowToRecord(
  book: string,
  parishName: string,
  parishCode: string,
  rowId: string,
  href: string,
  texts: readonly string[]
): HiskiRecord {
  const col = (idx: number): string => texts[idx] ?? '';
  const base: HiskiRecord = {
    parish: parishName,
    parish_code: parishCode,
    book: BOOK_LABELS[book] ?? book,
    book_code: book,
    row_id: rowId,
    event_url: new URL(href, HISKI_BASE).toString(),
  };
  if (book === 'kastetut') {
    return {
      ...base,
      born: col(0),
      christened: col(1),
      village: col(2),
      farm: col(3),
      father: col(4),
      mother: col(5),
      child: col(6),
    };
  }
  if (book === 'vihityt') {
    return {
      ...base,
      announced: col(0),
      married: col(1),
      groom_village: col(2),
      groom_farm: col(3),
      groom: col(4),
      bride: col(5),
      bride_village: col(6),
      bride_farm: col(7),
    };
  }
  if (book === 'haudatut') {
    return {
      ...base,
      died: col(0),
      buried: col(1),
      village: col(2),
      farm: col(3),
      person: col(4),
      cause: col(5),
      age_years: col(6),
      age_months: col(7),
      age_weeks: col(8),
      age_days: col(9),
    };
  }
  if (book === 'smuutt' || book === 'umuutt') {
    return {
      ...base,
      departure: col(0),
      arrival: col(1),
      village: col(2),
      farm: col(3),
      person: col(4),
      other_place: col(5),
    };
  }
  return {
    ...base,
    columns: [...texts],
  };
}

export function parseHiskiResults(page: string): HiskiSearchResult {
  const $ = loadHtml(page);
  const records: HiskiRecord[] = [];
  let currentHeading = '';

  $('font[size="+2"], table[border="1"]').each((_idx, el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'font') {
      const boldText = cleanText($(el).find('b').text());
      if (boldText) {
        currentHeading = boldText;
      }
      return;
    }
    // Skip nested border="1" tables inside another border="1" table.
    if ($(el).parents('table[border="1"]').length > 0) {
      return;
    }
    const parishName = currentHeading.includes(' - ')
      ? currentHeading.split(' - ', 1)[0].trim()
      : currentHeading;

    const rows =
      $(el).children('tbody').length > 0 ? $(el).children('tbody').children('tr') : $(el).children('tr');

    rows.each((_rIdx, trEl) => {
      const cellEls = $(trEl).children('td, th');
      if (cellEls.length === 0) {
        return;
      }
      const cells: { readonly tag: string; readonly text: string; readonly hrefs: string[] }[] = [];
      cellEls.each((_cIdx, cellEl) => {
        const hrefs: string[] = [];
        $(cellEl)
          .find('a[href]')
          .each((_aIdx, aEl) => {
            const href = $(aEl).attr('href')?.trim();
            if (href) {
              hrefs.push(href);
            }
          });
        cells.push({
          tag: cellEl.tagName.toLowerCase(),
          text: cleanText($(cellEl).text()),
          hrefs,
        });
      });

      if (cells.every((c) => c.tag === 'th')) {
        return;
      }

      let eventHref = '';
      let eventMatch: RegExpExecArray | null = null;
      for (const href of cells[0].hrefs) {
        const m = HISKI_EVENT_HREF_RE.exec(href);
        if (m) {
          eventHref = href;
          eventMatch = m;
          break;
        }
      }

      if (!eventMatch) {
        if (records.length > 0 && cells.length >= 2 && !cells[0].text) {
          const note = cells
            .slice(1)
            .map((c) => c.text)
            .filter((t) => t.length > 0)
            .join(' ')
            .trim();
          if (note) {
            const last = records[records.length - 1];
            last.comment = last.comment ? `${last.comment}; ${note}` : note;
          }
        }
        return;
      }

      const parishCode = eventMatch[1];
      const bookCode = eventMatch[2].toLowerCase();
      const rowId = eventMatch[3];
      const texts = cells.map((c) => c.text);
      records.push(hiskiRowToRecord(bookCode, parishName, parishCode, rowId, eventHref, texts));
    });
  });

  let reportedTotal: number | undefined;
  const totalMatches = [...page.matchAll(TOTAL_EVENTS_RE)];
  if (totalMatches.length > 0) {
    reportedTotal = totalMatches.reduce((sum, m) => sum + Number.parseInt(m[1], 10), 0);
  }

  return {
    total_reported: reportedTotal ?? records.length,
    records,
  };
}

export function parseHiskiEventDetail(
  page: string,
  ref: { readonly parishCode: string; readonly bookCode: string; readonly rowId: string }
): HiskiEventDetail {
  const $ = loadHtml(page);
  const parishName = cleanText($('h2').first().text());
  const bookTitle = cleanText($('h3').first().text()) || BOOK_LABELS[ref.bookCode] || ref.bookCode;

  const permalinkMatch = HISKI_PERMALINK_RE.exec(page);
  const permalinkId = permalinkMatch ? permalinkMatch[1] : '';

  const sshyMatch = /HREF="(https?:\/\/www\.sukuhistoria\.fi\/[^"]+)"/i.exec(page);
  const sshyUrl = sshyMatch ? sshyMatch[1] : '';

  const fields: Record<string, string> = {};
  const detailTable = $('table[border="4"]').first();
  if (detailTable.length > 0) {
    const rows =
      detailTable.children('tbody').length > 0
        ? detailTable.children('tbody').children('tr')
        : detailTable.children('tr');
    rows.each((_rIdx, trEl) => {
      const cells: string[] = [];
      $(trEl)
        .children('td, th')
        .each((_cIdx, cellEl) => {
          cells.push(cleanText($(cellEl).text()));
        });
      if (cells.length === 0) {
        return;
      }
      const label = cells[0].replace(/:+$/, '').trim();
      const values = cells.slice(1).filter((v) => v.length > 0);
      if (label && label.toLowerCase() !== 'links') {
        fields[label] = values.join(' | ');
      }
    });
  }

  return {
    parish: parishName,
    parish_code: ref.parishCode,
    book: bookTitle,
    book_code: ref.bookCode,
    row_id: ref.rowId,
    permalink_id: permalinkId,
    permalink_url: permalinkId ? `${HISKI_ENDPOINT}?en+${permalinkId}` : '',
    event_url: `${HISKI_ENDPOINT}?en+${ref.parishCode}+${ref.bookCode}+${ref.rowId}`,
    sshy_url: sshyUrl,
    fields,
  };
}

export function parseDigihakemistoSearch(page: string): DigihakemistoArchiveRow[] {
  const $ = loadHtml(page);
  const results: DigihakemistoArchiveRow[] = [];
  $('tr.searchrow').each((_idx, trEl) => {
    const link = $(trEl).find('a.aineisto[href]').first();
    if (link.length === 0) {
      return;
    }
    const href = link.attr('href') ?? '';
    const hrefMatch = /^\/aineisto\/([A-Za-z0-9_-]+)$/.exec(href);
    if (!hrefMatch) {
      return;
    }
    const archiveId = hrefMatch[1];
    const title = cleanText(link.text());
    const nodigi = link.hasClass('nodigi') || link.find('.nodigi').length > 0;
    const comment = cleanText($(trEl).find('span.searchtarget.searchtarget2').first().text());
    const digitized = !nodigi && !comment.toLowerCase().includes('ei digitoitu');
    const astiaUrl = /^\d+$/.test(archiveId) ? `${ASTIA_CARD_BASE}?id=${archiveId}` : '';
    results.push({
      id: archiveId,
      title,
      comment,
      digitized,
      digihakemisto_url: new URL(href, DIGIHAKEMISTO_BASE).toString(),
      astia_url: astiaUrl,
    });
  });
  return results;
}

export function parseDigihakemistoArchive(page: string, archiveId: string): DigihakemistoArchiveDetail {
  const $ = loadHtml(page);
  const title = cleanText($('title').first().text());
  const astiaAttr = $('a#alkup[href]').attr('href') ?? '';
  const astiaUrl = astiaAttr.startsWith('https://astia.narc.fi/')
    ? astiaAttr
    : /^\d+$/.test(archiveId)
      ? `${ASTIA_CARD_BASE}?id=${archiveId}`
      : '';

  const notes: string[] = [];
  $('span.tieto').each((_idx, el) => {
    const text = cleanText($(el).text());
    if (text) {
      notes.push(text);
    }
  });

  const accessNotes: string[] = [];
  $('div.msg').each((_idx, el) => {
    const text = cleanText($(el).text());
    if (text) {
      accessNotes.push(text);
    }
  });

  const children: DigihakemistoChildRow[] = [];
  $('tr.searchrow').each((_idx, trEl) => {
    let linkEl: ReturnType<typeof $> | undefined;
    $(trEl)
      .find('a[href]')
      .each((_aIdx, aEl) => {
        if (linkEl) {
          return;
        }
        const href = $(aEl).attr('href') ?? '';
        if (href.startsWith('/aineisto/') || href.startsWith('/item/')) {
          linkEl = $(aEl);
        }
      });
    if (!linkEl) {
      return;
    }
    const href = linkEl.attr('href') ?? '';
    const trimmedParts = href.replace(/^\/+|\/+$/g, '').split('/');
    const childId = trimmedParts.at(-1) ?? '';
    const childTitle = cleanText(linkEl.text());
    const nodigi = linkEl.hasClass('nodigi') || linkEl.find('.nodigi').length > 0;
    const comment = cleanText($(trEl).find('span.searchtarget.searchtarget2').first().text());
    const digitized = !nodigi && !comment.toLowerCase().includes('ei digitoitu');
    children.push({
      id: childId,
      kind: href.startsWith('/item/') ? 'item' : 'series',
      title: childTitle,
      comment,
      digitized,
      digihakemisto_url: new URL(href, DIGIHAKEMISTO_BASE).toString(),
      astia_url: /^\d+$/.test(childId) ? `${ASTIA_CARD_BASE}?id=${childId}` : '',
    });
  });

  return {
    id: archiveId,
    title,
    digihakemisto_url: `${DIGIHAKEMISTO_ARCHIVE_BASE}/${archiveId}`,
    astia_url: astiaUrl,
    notes,
    access_notes: accessNotes,
    children,
  };
}
