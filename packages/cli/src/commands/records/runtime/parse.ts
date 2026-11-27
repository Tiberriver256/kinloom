import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import { type X2jOptions, XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';

export type CheerioDocument = cheerio.CheerioAPI;

export function loadHtml(html: string): CheerioDocument {
  return cheerio.load(html);
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function extractFormHiddenInputs($: CheerioDocument, formSelector = 'form'): Record<string, string> {
  const result: Record<string, string> = {};
  const scope = $(formSelector);
  const inputs = scope.length > 0 ? scope.find('input[type="hidden"]') : $('input[type="hidden"]');
  inputs.each((_idx, el) => {
    const name = $(el).attr('name');
    if (name) {
      result[name] = $(el).attr('value') ?? '';
    }
  });
  return result;
}

export interface ParsedHtmlTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export function extractHtmlTables($: CheerioDocument, tableSelector = 'table'): ParsedHtmlTable[] {
  const tables: ParsedHtmlTable[] = [];
  $(tableSelector).each((_tIdx, tableEl) => {
    const headers: string[] = [];
    const rows: string[][] = [];
    $(tableEl)
      .find('tr')
      .each((rowIdx, trEl) => {
        const ths = $(trEl).find('th');
        if (rowIdx === 0 && ths.length > 0) {
          ths.each((_i, th) => {
            headers.push(collapseWhitespace($(th).text()));
          });
          return;
        }
        const cells: string[] = [];
        $(trEl)
          .find('td, th')
          .each((_i, cell) => {
            cells.push(collapseWhitespace($(cell).text()));
          });
        if (cells.length > 0) {
          rows.push(cells);
        }
      });
    tables.push({ headers, rows });
  });
  return tables;
}

export function parseXml<T = unknown>(xml: string, options: Partial<X2jOptions> = {}): T {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
    ...options,
  });
  return parser.parse(xml) as T;
}

export function unzipEntries(zipBytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(zipBytes);
}

export function gunzipBytes(gzipBytes: Uint8Array): Buffer {
  return gunzipSync(gzipBytes);
}

export function gunzipText(gzipBytes: Uint8Array, encoding: BufferEncoding = 'utf8'): string {
  return gunzipSync(gzipBytes).toString(encoding);
}
