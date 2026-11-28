import { gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  cleanHtmlText,
  collapseWhitespace,
  extractFormHiddenInputs,
  extractHtmlTables,
  gunzipText,
  loadHtml,
  parseXml,
  unzipEntries,
} from './parse.js';

describe('records runtime parse helpers', () => {
  it('parses HTML tables and hidden ASP.NET inputs via cheerio', () => {
    const html = `
      <form id="searchForm">
        <input type="hidden" name="__VIEWSTATE" value="abc123" />
        <input type="hidden" name="__EVENTVALIDATION" value="xyz789" />
      </form>
      <table class="results">
        <tr><th>Name</th><th>Year</th></tr>
        <tr><td>  Alder,   John </td><td>1870</td></tr>
      </table>
    `;
    const $ = loadHtml(html);
    expect(extractFormHiddenInputs($, '#searchForm')).toEqual({
      __VIEWSTATE: 'abc123',
      __EVENTVALIDATION: 'xyz789',
    });
    expect(extractHtmlTables($, 'table.results')).toEqual([
      {
        headers: ['Name', 'Year'],
        rows: [['Alder, John', '1870']],
      },
    ]);
    expect(collapseWhitespace('  hello \n\t world  ')).toBe('hello world');
  });

  it('parses XML via fast-xml-parser, extracts ZIP entries via fflate, and decompresses gzip', () => {
    const xml = '<book><page leaf="4"><word>Lincoln</word></page></book>';
    const parsed = parseXml(xml);
    expect(parsed).toEqual({ book: { page: { '@_leaf': '4', word: 'Lincoln' } } });

    const zipped = zipSync({ 'hello.txt': Buffer.from('world', 'utf8') });
    const entries = unzipEntries(zipped);
    expect(Buffer.from(entries['hello.txt']).toString('utf8')).toBe('world');

    const gz = gzipSync(Buffer.from('ocr-payload', 'utf8'));
    expect(gunzipText(gz)).toBe('ocr-payload');
  });

  it('strips scripts with whitespace in end tags and handles adversarial inputs in linear time', () => {
    expect(
      cleanHtmlText('<script>alert(1)</script ><style>.a{color:red}</style ><b>Hello</b><p>World</p>', {
        stripScriptsAndStyles: true,
      })
    ).toBe('Hello World');
    expect(cleanHtmlText('<span>Alpha &amp; Beta</span>')).toBe('Alpha & Beta');

    const start = performance.now();
    const longScripts = '<script'.repeat(10_000);
    const longAngles = '<'.repeat(10_000);
    expect(cleanHtmlText(longScripts, { stripScriptsAndStyles: true })).toBe('');
    expect(cleanHtmlText(longAngles)).toBe(longAngles);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
