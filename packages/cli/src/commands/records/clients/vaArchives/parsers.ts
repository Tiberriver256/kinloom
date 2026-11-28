import { loadHtml } from '../../runtime/parse.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import {
  CHANCERY_DETAIL,
  CHANCERY_ZIP,
  type ChanceryCaseDetail,
  type ChanceryImagesInfo,
  type ChanceryLocalityRow,
  type ChancerySearchPage,
  type ChancerySearchRecord,
  type DunmoreDrawerResult,
  type DunmoreImage,
  normalizeLvaImageUrl,
  PRIMO_BASE,
  PRIMO_VID,
  type PrimoCatalogRecord,
  type RosettaDeliveryInfo,
  type RosettaFileEntry,
  type RosettaViewerInfo,
} from './domain.js';

function decodeHtmlEntities(text: string): string {
  const $ = loadHtml(`<body>${text.replace(/</g, '&lt;')}</body>`);
  return $('body').text();
}

function cleanPreservingLines(htmlText: string): string {
  const withBreaks = htmlText.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(withBreaks.replace(/[ \t]+/g, ' ')).trim();
}

function parseNamesCell(cellHtml: string): string[] {
  return cleanPreservingLines(cellHtml)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseDunmoreDrawer(page: string): DunmoreDrawerResult {
  const titleMatch = /Dunmore's War\s*-\s*Page\s*(\d+)/i.exec(page);
  const current = titleMatch ? Number.parseInt(titleMatch[1], 10) : null;
  const images: DunmoreImage[] = [];
  const linkRe = /<a href="(\/Microfilm\/[^"]+)"\s*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(page)) !== null) {
    let url: string;
    try {
      url = normalizeLvaImageUrl(decodeHtmlEntities(match[1]));
    } catch {
      continue;
    }
    const labelText = cleanPreservingLines(match[2]);
    const labelMatch = /Page\s*(\d+)/.exec(labelText);
    const isCurrent = labelMatch === null;
    const num = labelMatch ? Number.parseInt(labelMatch[1], 10) : current;
    images.push({ page: num, url, current: isCurrent });
  }
  return { current_page: current, images };
}

export function parseRosettaDelivery(page: string): RosettaDeliveryInfo {
  const viewerMatch = /src="([^"]*ieViewer\.do[^"]*)"/i.exec(page);
  const viewerUrl = viewerMatch ? decodeHtmlEntities(viewerMatch[1]) : null;
  const dvsMatch = /dps_dvs=([0-9]+~[0-9]+)/.exec(page);
  return {
    viewer_url: viewerUrl,
    dps_dvs: dvsMatch ? dvsMatch[1] : null,
  };
}

export function parseRosettaViewer(page: string): RosettaViewerInfo {
  const files: RosettaFileEntry[] = [];
  const seen = new Set<string>();
  const itemRe = /<item id='(FL\d+)' title='([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(page)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      files.push({ fl: match[1], title: decodeHtmlEntities(match[2]) });
    }
  }
  const jsonRe = /JSONObject\s*=\s*'(\{[^']*\})'/g;
  while ((match = jsonRe.exec(page)) !== null) {
    try {
      const obj: unknown = JSON.parse(match[1]);
      if (!isPlainRecord(obj)) {
        continue;
      }
      for (const val of Object.values(obj)) {
        const flMatches = String(val).match(/FL\d+/g) ?? [];
        for (const fl of flMatches) {
          if (!seen.has(fl)) {
            seen.add(fl);
            files.push({ fl, title: '' });
          }
        }
      }
    } catch {
      // Ignore malformed inline JSONObject snippets.
    }
  }
  const initMatch = /initialSelect\s*=\s*"(FL\d+)"/.exec(page);
  const initial = initMatch ? initMatch[1] : (files[0]?.fl ?? null);
  return { files, initial };
}

export function parseSearchPage(page: string): ChancerySearchPage {
  const totalMatch =
    /Your search returned (\d+) record\(s\)\. You are now viewing records (\d+) through (\d+)/.exec(page);
  const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : 0;
  const first = totalMatch ? Number.parseInt(totalMatch[2], 10) : 0;
  const last = totalMatch ? Number.parseInt(totalMatch[3], 10) : 0;

  const pat =
    /<strong>Index Number:<\/strong>\s*([^<]+?)\s*<\/span>\s*<a href="case_detail\.asp\?CFN=([0-9-]+)"[^>]*>[\s\S]*?<strong>Locality:<\/strong>\s*([^<]+?)\s*<\/td>[\s\S]*?<td valign="top">\s*([\s\S]*?)\s*<\/td>\s*<td valign="top">\s*([\s\S]*?)\s*<\/td>/gi;

  const records: ChancerySearchRecord[] = [];
  let match: RegExpExecArray | null;
  while ((match = pat.exec(page)) !== null) {
    records.push({
      index_number: decodeHtmlEntities(match[1].trim()),
      cfn: match[2],
      locality: decodeHtmlEntities(match[3].trim()),
      plaintiffs: parseNamesCell(match[4]),
      defendants: parseNamesCell(match[5]),
      case_url: `${CHANCERY_DETAIL}?CFN=${match[2]}`,
    });
  }
  return { total, first, last, records };
}

export function parseCasePage(page: string): ChanceryCaseDetail {
  const section = (label: string): string => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `<strong>${escaped}<\\/strong><\\/td><\\/tr>\\s*<tr>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`,
      'i'
    );
    const m = re.exec(page);
    return m ? cleanPreservingLines(m[1]) : '';
  };

  const head =
    /<strong>Locality<\/strong><\/td><td[^>]*><strong>Index Number<\/strong><\/td><td[^>]*><strong>Original Case Number<\/strong><\/td><\/tr>\s*<tr>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/i.exec(
      page
    );
  const parties =
    /<strong>Plaintiff\(s\)<\/strong><\/td><td[^>]*><strong>Defendant\(s\)<\/strong><\/td><\/tr>\s*<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i.exec(
      page
    );
  const surnames = /<strong>Surname\(s\)<\/strong><\/td><\/tr>\s*<tr><td[^>]*>([\s\S]*?)<\/td>/i.exec(page);
  const plat =
    /<strong>Plat\?<\/strong><\/td><\/tr>\s*<tr><td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/i.exec(page);
  const willsMatch =
    /<strong>Wills<\/strong><\/td><td[^>]*>[\s\S]*?Plat\?[\s\S]*?<\/tr>\s*<tr><td[^>]*>([\s\S]*?)<\/td>/i.exec(
      page
    );

  return {
    locality: head ? decodeHtmlEntities(head[1].trim()) : '',
    index_number: head ? decodeHtmlEntities(head[2].trim()) : '',
    original_case_number: head ? decodeHtmlEntities(head[3].trim()) : '',
    plaintiffs: parties ? parseNamesCell(parties[1]) : [],
    defendants: parties ? parseNamesCell(parties[2]) : [],
    surnames: surnames ? parseNamesCell(surnames[1]) : [],
    wills: willsMatch ? cleanPreservingLines(willsMatch[1]) : '',
    plat: plat ? decodeHtmlEntities(plat[2].trim()) : '',
    format: section('Format'),
  };
}

export function parseImagesPage(page: string): ChanceryImagesInfo {
  const urls: string[] = [];
  const imgRe = /myImages\[\d+\]\s*=\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(page)) !== null) {
    if (match[1]) {
      urls.push(match[1]);
    }
  }
  const totalMatch = /of\s+(\d+)\s+prev/.exec(cleanPreservingLines(page));
  const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : urls.length;
  const zipMatch = /href="([^"]*download\.php\?cfn=[^"]*)"/i.exec(page);
  const origin = 'https://old.lva.virginia.gov';
  return {
    total_pages: total,
    page_pdfs: urls.map((u) => (u.startsWith('/') ? `${origin}${u}` : u)),
    zip_url: zipMatch ? `${origin}${decodeHtmlEntities(zipMatch[1])}` : `${CHANCERY_ZIP}?cfn=`,
  };
}

export function parseLocalitiesPage(page: string): ChanceryLocalityRow[] {
  const rows: ChanceryLocalityRow[] = [];
  const rowRe =
    /<TR><TD>([^<]*)<\/td><TD>([^<]*)<\/td><TD>([^<]*)<\/td><TD>([^<]*)<\/td><TD>([\s\S]*?)<\/td><\/TR>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(page)) !== null) {
    rows.push({
      locality: decodeHtmlEntities(match[1].replace(/&nbsp;/gi, ' ').trim()),
      region: decodeHtmlEntities(match[2].replace(/&nbsp;/gi, ' ').trim()),
      time_frame: decodeHtmlEntities(match[3].replace(/&nbsp;/gi, ' ').trim()),
      viewing_status: decodeHtmlEntities(match[4].replace(/&nbsp;/gi, ' ').trim()),
      notes: cleanPreservingLines(match[5]),
    });
  }
  return rows;
}

export function mapPnxsRecord(doc: unknown): PrimoCatalogRecord {
  const docObj = isPlainRecord(doc) ? doc : {};
  const pnx = isPlainRecord(docObj['pnx']) ? docObj['pnx'] : {};
  const disp = isPlainRecord(pnx['display']) ? pnx['display'] : {};
  const control = isPlainRecord(pnx['control']) ? pnx['control'] : {};
  const recordIds = Array.isArray(control['recordid']) ? control['recordid'] : [];
  const recordid = typeof recordIds[0] === 'string' ? recordIds[0] : '';

  const first = (key: string): string => {
    const vals = disp[key];
    return Array.isArray(vals) && typeof vals[0] === 'string' ? vals[0].trim() : '';
  };

  return {
    recordid,
    title: first('title'),
    creator: first('creator'),
    date: first('creationdate'),
    type: first('type'),
    source: first('source'),
    record_url: recordid
      ? `${PRIMO_BASE}/discovery/fulldisplay?docid=${recordid}&context=L&vid=${encodeURIComponent(PRIMO_VID)}&lang=en&search_scope=MyInstitution`
      : '',
  };
}
