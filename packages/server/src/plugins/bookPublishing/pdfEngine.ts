import { KINLOOM_SERVER_VERSION } from '../../version.js';
import { inchesToPoints, roundToThousandth } from './geometry.js';
import type {
  BookCompiledPage,
  CompiledBookDocument,
  CoverDimensionsResult,
  PdfBoxPt,
  PdfRendererPort,
} from './types.js';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('latin1');

/**
 * Escapes text for PDF 1.4 literal strings inside parentheses `(...)`.
 * Normalizes common archival typographic punctuation to ASCII/WinAnsi so standard Type1 fonts render cleanly.
 */
export function encodePdfLiteralString(raw: string): string {
  const normalized = raw
    .replaceAll('\u2014', '--')
    .replaceAll('\u2013', '-')
    .replaceAll('\u2018', "'")
    .replaceAll('\u2019', "'")
    .replaceAll('\u201C', '"')
    .replaceAll('\u201D', '"')
    .replaceAll('\u2022', '*')
    .replaceAll('\u00B7', '|')
    .replaceAll('\u2026', '...');

  let out = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    if (code === 0x5c) {
      out += '\\\\';
    } else if (code === 0x28) {
      out += '\\(';
    } else if (code === 0x29) {
      out += '\\)';
    } else if (code >= 0x20 && code <= 0x7e) {
      out += normalized[i];
    } else if (code === 0x0a || code === 0x0d || code === 0x09) {
      out += ' ';
    } else {
      out += '?';
    }
  }
  return out;
}

function formatPdfNumber(value: number): string {
  const rounded = roundToThousandth(value);
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function formatPdfBox(box: PdfBoxPt): string {
  return `[${formatPdfNumber(box.x0)} ${formatPdfNumber(box.y0)} ${formatPdfNumber(box.x1)} ${formatPdfNumber(box.y1)}]`;
}

interface PdfPageSpec {
  readonly mediaBox: PdfBoxPt;
  readonly bleedBox: PdfBoxPt;
  readonly trimBox: PdfBoxPt;
  readonly contentStream: string;
}

function buildPdfDocumentBytes(params: {
  readonly title: string;
  readonly author: string;
  readonly subject: string;
  readonly pages: readonly PdfPageSpec[];
}): Uint8Array {
  const objects: string[] = [];
  const addObject = (body: string): number => {
    objects.push(body);
    return objects.length;
  };

  // Reserve 1: Catalog, 2: Pages, 3: Info, 4..7: Standard Type1 fonts
  const catalogId = addObject('');
  const pagesId = addObject('');
  const infoId = addObject(
    `<< /Title (${encodePdfLiteralString(params.title)}) /Author (${encodePdfLiteralString(params.author)}) /Subject (${encodePdfLiteralString(params.subject)}) /Creator (Kinloom Archival Press ${encodePdfLiteralString(KINLOOM_SERVER_VERSION)}) /Producer (Kinloom Pure-TS Prepress PDF Engine) >>`
  );
  const fontSerifId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>');
  const fontSerifBoldId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>');
  const fontSerifItalicId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic >>');
  const fontMonoId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>');

  const fontDict = `<< /F1 ${fontSerifId} 0 R /F2 ${fontSerifBoldId} 0 R /F3 ${fontSerifItalicId} 0 R /F4 ${fontMonoId} 0 R >>`;
  const pageObjectIds: number[] = [];

  for (const page of params.pages) {
    const streamBytes = TEXT_ENCODER.encode(page.contentStream);
    const contentId = addObject(
      `<< /Length ${streamBytes.byteLength} >>\nstream\n${page.contentStream}\nendstream`
    );
    const pageId = addObject(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox ${formatPdfBox(page.mediaBox)} /BleedBox ${formatPdfBox(page.bleedBox)} /TrimBox ${formatPdfBox(page.trimBox)} /Resources << /Font ${fontDict} >> /Contents ${contentId} 0 R >>`
    );
    pageObjectIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Count ${pageObjectIds.length} /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] >>`;

  const chunks: string[] = ['%PDF-1.4\n%KinloomArchivalPDF\n'];
  const offsets: number[] = [0];
  let byteOffset = TEXT_ENCODER.encode(chunks[0]).byteLength;

  for (let i = 0; i < objects.length; i += 1) {
    const entry = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    offsets.push(byteOffset);
    chunks.push(entry);
    byteOffset += TEXT_ENCODER.encode(entry).byteLength;
  }

  const xrefStart = byteOffset;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
  for (let i = 1; i < offsets.length; i += 1) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  chunks.push(xrefLines.join(''), trailer);
  return TEXT_ENCODER.encode(chunks.join(''));
}

function buildInteriorPageStream(doc: CompiledBookDocument, page: BookCompiledPage): string {
  const geom = doc.report.interiorGeometry;
  const w = geom.bleedWidthPt;
  const h = geom.bleedHeightPt;
  const isLeft = page.pageNumber % 2 === 0;
  const outerMarginPt = inchesToPoints(geom.bleedIn + geom.safetyMarginIn);
  const innerMarginPt = inchesToPoints(geom.bleedIn + geom.insideGutterIn);
  const leftX = isLeft ? outerMarginPt : innerMarginPt;
  const rightX = w - (isLeft ? innerMarginPt : outerMarginPt);
  const topY = h - outerMarginPt;
  const bottomY = outerMarginPt;

  const ops: string[] = [];

  // Subtle archival paper background fill across full bleed canvas (#FCF9F2)
  ops.push('q');
  ops.push('0.988 0.976 0.949 rg');
  ops.push(`0 0 ${formatPdfNumber(w)} ${formatPdfNumber(h)} re f`);
  ops.push('Q');

  if (page.kind !== 'blank-verso') {
    // Running header rule & text
    ops.push('0.796 0.749 0.659 RG 0.75 w');
    ops.push(
      `${formatPdfNumber(leftX)} ${formatPdfNumber(topY - 14)} m ${formatPdfNumber(rightX)} ${formatPdfNumber(topY - 14)} l S`
    );

    ops.push('BT');
    ops.push('0.306 0.290 0.259 rg');
    ops.push('/F4 8 Tf');
    ops.push(`1 0 0 1 ${formatPdfNumber(leftX)} ${formatPdfNumber(topY - 8)} Tm`);
    ops.push(`(${encodePdfLiteralString(doc.report.title.toUpperCase().slice(0, 56))}) Tj`);
    ops.push(
      `1 0 0 1 ${formatPdfNumber(Math.max(leftX + 180, rightX - 180))} ${formatPdfNumber(topY - 8)} Tm`
    );
    ops.push(`(${encodePdfLiteralString(page.sectionTitle.toUpperCase().slice(0, 32))}) Tj`);
    ops.push('ET');

    let cursorY = topY - 40;
    if (page.heading) {
      ops.push('BT');
      ops.push('0.106 0.165 0.255 rg');
      ops.push('/F2 18 Tf');
      ops.push(`1 0 0 1 ${formatPdfNumber(leftX)} ${formatPdfNumber(cursorY)} Tm`);
      ops.push(`(${encodePdfLiteralString(page.heading.slice(0, 82))}) Tj`);
      ops.push('ET');
      cursorY -= 22;
    }

    if (page.subtitle) {
      ops.push('BT');
      ops.push('0.306 0.290 0.259 rg');
      ops.push('/F3 10.5 Tf');
      ops.push(`1 0 0 1 ${formatPdfNumber(leftX)} ${formatPdfNumber(cursorY)} Tm`);
      ops.push(`(${encodePdfLiteralString(page.subtitle.slice(0, 96))}) Tj`);
      ops.push('ET');
      cursorY -= 20;
    }

    const footnoteReserve = page.footnotes.length > 0 ? 18 + page.footnotes.length * 11 : 16;
    const minBodyY = bottomY + footnoteReserve;
    ops.push('BT');
    ops.push('0.102 0.114 0.137 rg');
    ops.push('/F1 10 Tf');
    for (const line of page.lines) {
      if (cursorY < minBodyY) {
        break;
      }
      if (line.length > 0) {
        ops.push(`1 0 0 1 ${formatPdfNumber(leftX)} ${formatPdfNumber(cursorY)} Tm`);
        ops.push(`(${encodePdfLiteralString(line.slice(0, 108))}) Tj`);
      }
      cursorY -= 14;
    }
    ops.push('ET');

    if (page.footnotes.length > 0) {
      let fnY = bottomY + 14 + (page.footnotes.length - 1) * 10;
      ops.push('0.796 0.749 0.659 RG 0.5 w');
      ops.push(
        `${formatPdfNumber(leftX)} ${formatPdfNumber(fnY + 9)} m ${formatPdfNumber(rightX)} ${formatPdfNumber(fnY + 9)} l S`
      );
      ops.push('BT');
      ops.push('0.306 0.290 0.259 rg');
      ops.push('/F4 7.5 Tf');
      for (const fn of page.footnotes) {
        ops.push(`1 0 0 1 ${formatPdfNumber(leftX)} ${formatPdfNumber(fnY)} Tm`);
        ops.push(`(${encodePdfLiteralString(fn.slice(0, 118))}) Tj`);
        fnY -= 10;
      }
      ops.push('ET');
    }

    // Page folio number
    ops.push('BT');
    ops.push('0.306 0.290 0.259 rg');
    ops.push('/F4 8.5 Tf');
    ops.push(`1 0 0 1 ${formatPdfNumber(isLeft ? leftX : rightX - 24)} ${formatPdfNumber(bottomY - 4)} Tm`);
    ops.push(`(${page.pageNumber}) Tj`);
    ops.push('ET');
  }

  return ops.join('\n');
}

function buildCoverSpreadStream(doc: CompiledBookDocument, coverDimensions: CoverDimensionsResult): string {
  const totalW = coverDimensions.totalWidthPt;
  const totalH = coverDimensions.totalHeightPt;
  const wrapPt = inchesToPoints(coverDimensions.wrapAllowanceIn);
  const spinePt = inchesToPoints(coverDimensions.spineWidthIn);
  const trimWPt = (totalW - 2 * wrapPt - spinePt) / 2;
  const trimHPt = totalH - 2 * wrapPt;

  const backX = wrapPt;
  const spineX = wrapPt + trimWPt;
  const frontX = spineX + spinePt;

  const ops: string[] = [];

  // Full archival indigo board cover background (#1B2A41)
  ops.push('q');
  ops.push('0.106 0.165 0.255 rg');
  ops.push(`0 0 ${formatPdfNumber(totalW)} ${formatPdfNumber(totalH)} re f`);
  ops.push('Q');

  // Front cover gold archival frame
  const frameInset = 54;
  ops.push('0.784 0.541 0.294 RG 1.5 w');
  ops.push(
    `${formatPdfNumber(frontX + frameInset)} ${formatPdfNumber(wrapPt + frameInset)} ${formatPdfNumber(trimWPt - frameInset * 2)} ${formatPdfNumber(trimHPt - frameInset * 2)} re S`
  );

  // Front cover title & subtitle
  ops.push('BT');
  ops.push('0.988 0.976 0.949 rg');
  ops.push('/F4 9 Tf');
  ops.push(
    `1 0 0 1 ${formatPdfNumber(frontX + frameInset + 24)} ${formatPdfNumber(wrapPt + trimHPt - frameInset - 44)} Tm`
  );
  ops.push(`(${encodePdfLiteralString(`${doc.report.familyName.toUpperCase()} ARCHIVAL EDITION`)}) Tj`);
  ops.push('/F2 26 Tf');
  ops.push(
    `1 0 0 1 ${formatPdfNumber(frontX + frameInset + 24)} ${formatPdfNumber(wrapPt + trimHPt * 0.56)} Tm`
  );
  ops.push(`(${encodePdfLiteralString(doc.report.title.slice(0, 48))}) Tj`);
  ops.push('/F3 12 Tf');
  ops.push(
    `1 0 0 1 ${formatPdfNumber(frontX + frameInset + 24)} ${formatPdfNumber(wrapPt + trimHPt * 0.56 - 28)} Tm`
  );
  ops.push(`(${encodePdfLiteralString(doc.report.subtitle.slice(0, 72))}) Tj`);
  ops.push('ET');

  // Back cover colophon & privacy notice (kept clear of lower-right barcode box)
  ops.push('BT');
  ops.push('0.910 0.875 0.808 rg');
  ops.push('/F4 8.5 Tf');
  ops.push(`1 0 0 1 ${formatPdfNumber(backX + 48)} ${formatPdfNumber(wrapPt + trimHPt - 64)} Tm`);
  ops.push(`(${encodePdfLiteralString(doc.report.familyName)}) Tj`);
  ops.push('/F1 9.5 Tf');
  ops.push(`1 0 0 1 ${formatPdfNumber(backX + 48)} ${formatPdfNumber(wrapPt + trimHPt - 86)} Tm`);
  ops.push(`(${encodePdfLiteralString(doc.report.colophonNotice.slice(0, 88))}) Tj`);
  ops.push('ET');

  // Spine typography strictly guarded by >= 80 pages & >= 0.375 in spine threshold
  if (coverDimensions.allowSpineText) {
    const spineCenterX = spineX + spinePt / 2 + 3;
    const spineStartY = wrapPt + 64;
    ops.push('BT');
    ops.push('0.961 0.937 0.886 rg');
    ops.push('/F4 9 Tf');
    ops.push(`0 1 -1 0 ${formatPdfNumber(spineCenterX)} ${formatPdfNumber(spineStartY)} Tm`);
    ops.push(
      `(${encodePdfLiteralString(`${doc.report.title} -- ${doc.report.familyName}`.slice(0, 56))}) Tj`
    );
    ops.push('ET');
  }

  return ops.join('\n');
}

/**
 * Pure-TypeScript deterministic PDF 1.4 renderer with zero native binaries or headless browser dependencies.
 * Runs identically in Node CLI and Cloudflare Workers isolates while stamping exact MediaBox, BleedBox,
 * and TrimBox coordinates on every page.
 */
export function createDeterministicPdfRenderer(): PdfRendererPort {
  return {
    adapterKind: 'deterministic-pdf',
    async renderInterior(doc: CompiledBookDocument): Promise<Uint8Array> {
      const geom = doc.report.interiorGeometry;
      const pageSpecs: PdfPageSpec[] = doc.pages.map((page) => ({
        mediaBox: geom.mediaBoxPt,
        bleedBox: geom.bleedBoxPt,
        trimBox: geom.trimBoxPt,
        contentStream: buildInteriorPageStream(doc, page),
      }));
      return buildPdfDocumentBytes({
        title: doc.report.title,
        author: doc.report.familyName,
        subject: doc.report.colophonNotice,
        pages: pageSpecs,
      });
    },
    async renderCover(
      doc: CompiledBookDocument,
      overrideCoverDimensions?: CoverDimensionsResult
    ): Promise<Uint8Array> {
      const dims = overrideCoverDimensions ?? doc.report.coverDimensions;
      const wrapPt = inchesToPoints(dims.wrapAllowanceIn);
      const mediaBox: PdfBoxPt = { x0: 0, y0: 0, x1: dims.totalWidthPt, y1: dims.totalHeightPt };
      const trimBox: PdfBoxPt = {
        x0: wrapPt,
        y0: wrapPt,
        x1: roundToThousandth(dims.totalWidthPt - wrapPt),
        y1: roundToThousandth(dims.totalHeightPt - wrapPt),
      };
      return buildPdfDocumentBytes({
        title: `${doc.report.title} — Hardcover Casewrap Cover`,
        author: doc.report.familyName,
        subject: `SKU ${dims.providerSku} · Spine ${dims.spineWidthIn} in`,
        pages: [
          {
            mediaBox,
            bleedBox: mediaBox,
            trimBox,
            contentStream: buildCoverSpreadStream(doc, dims),
          },
        ],
      });
    },
  };
}

export interface InspectedPdfPrepress {
  readonly validHeader: boolean;
  readonly validEof: boolean;
  readonly byteLength: number;
  readonly pageCount: number;
  readonly mediaBoxPt: PdfBoxPt | null;
  readonly bleedBoxPt: PdfBoxPt | null;
  readonly trimBoxPt: PdfBoxPt | null;
  readonly rawText: string;
}

function parseFirstPdfBox(raw: string, boxName: 'MediaBox' | 'BleedBox' | 'TrimBox'): PdfBoxPt | null {
  const re = new RegExp(
    `\\/${boxName}\\s*\\[\\s*(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)\\s+(-?\\d+(?:\\.\\d+)?)\\s*\\]`
  );
  const match = re.exec(raw);
  if (!match) {
    return null;
  }
  return {
    x0: Number(match[1]),
    y0: Number(match[2]),
    x1: Number(match[3]),
    y1: Number(match[4]),
  };
}

/**
 * Inspects a PDF binary for header/EOF validity, exact page count, and PDF prepress boxes.
 */
export function inspectPdfPrepress(bytes: Uint8Array): InspectedPdfPrepress {
  const raw = TEXT_DECODER.decode(bytes);
  const validHeader = raw.startsWith('%PDF-');
  const validEof = raw.trimEnd().endsWith('%%EOF');
  const pageMatches = raw.match(/\/Type\s*\/Page\b(?!s)/g);
  const pageCount = pageMatches ? pageMatches.length : 0;

  return {
    validHeader,
    validEof,
    byteLength: bytes.byteLength,
    pageCount,
    mediaBoxPt: parseFirstPdfBox(raw, 'MediaBox'),
    bleedBoxPt: parseFirstPdfBox(raw, 'BleedBox'),
    trimBoxPt: parseFirstPdfBox(raw, 'TrimBox'),
    rawText: raw,
  };
}

export interface CloudflareBrowserPdfRendererOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

/**
 * Cloudflare Browser Rendering PDF adapter (works in Cloudflare Workers and Node).
 * Calls POST /accounts/{accountId}/browser-rendering/pdf with preferCSSPageSize=true.
 */
export function createCloudflareBrowserPdfRenderer(
  options: CloudflareBrowserPdfRendererOptions
): PdfRendererPort {
  const baseUrl = trimTrailingSlashes(options.apiBaseUrl ?? 'https://api.cloudflare.com/client/v4');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function renderHtmlToPdf(html: string, widthIn: number, heightIn: number): Promise<Uint8Array> {
    const endpoint = `${baseUrl}/accounts/${encodeURIComponent(options.accountId)}/browser-rendering/pdf`;
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        html,
        pdfOptions: {
          preferCSSPageSize: true,
          printBackground: true,
          width: `${widthIn}in`,
          height: `${heightIn}in`,
          margin: { top: '0in', right: '0in', bottom: '0in', left: '0in' },
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Cloudflare Browser Rendering PDF request failed (${res.status}): ${detail.slice(0, 240)}`
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  return {
    adapterKind: 'cloudflare-browser-rendering',
    async renderInterior(doc: CompiledBookDocument): Promise<Uint8Array> {
      const geom = doc.report.interiorGeometry;
      return renderHtmlToPdf(doc.interiorHtml, geom.bleedWidthIn, geom.bleedHeightIn);
    },
    async renderCover(
      doc: CompiledBookDocument,
      overrideCoverDimensions?: CoverDimensionsResult
    ): Promise<Uint8Array> {
      const dims = overrideCoverDimensions ?? doc.report.coverDimensions;
      return renderHtmlToPdf(doc.coverHtml, dims.totalWidthIn, dims.totalHeightIn);
    },
  };
}
