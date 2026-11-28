import fs from 'node:fs';
import sharp, { type OverlayOptions } from 'sharp';
import { CliValidationError } from '../../../../errors.js';
import {
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import { encodeCompactJpeg } from '../../runtime/image.js';
import { resolveUserPathFromContext, runWithConcurrency } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import { renderSubcommandHelp, SHEET_STRIP_PARSE_SPEC, STITCH_PARSE_SPEC } from './cliSpecs.js';
import {
  type Box,
  clampBox,
  DEFAULT_MAX_WORKERS,
  DEFAULT_TIMEOUT_S,
  expandMultiBoxArgs,
  normalizePrepScanArgv,
  parseBox,
  parseJoinDirection,
  parseRgbColor,
  shortLabel,
} from './geometry.js';
import {
  buildHeaderSvg,
  cropRgbImage,
  extractBand,
  type LoadedRgbImage,
  loadImageFromSource,
  loadRgbFromFile,
  paintBlackBoxesInclusive,
  resizeToWidth,
  resolveOutputAlias,
  rotateImageClockwise,
  saveArchivalImage,
} from './imageOps.js';

export async function cmdSheetStrip(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), SHEET_STRIP_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('sheet-strip')) };
  }

  const sources = parsed.positionals;
  const outPath = resolveUserPathFromContext(getStringOption(parsed, 'out') ?? '', ctx);
  const band = (getStringOption(parsed, 'band') ?? 'top') as 'top' | 'left';
  const bandPct = getNumberOption(parsed, 'bandPct') ?? 18.0;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 250;
  const targetWidth = getNumberOption(parsed, 'width') ?? 1400;
  const timeoutSec = getNumberOption(parsed, 'timeout') ?? DEFAULT_TIMEOUT_S;
  const noRotateLeft = getBooleanOption(parsed, 'noRotateLeft');
  const asJson = getBooleanOption(parsed, 'json');

  interface FetchedBand {
    readonly index: number;
    readonly source: string;
    readonly label: string;
    readonly image: LoadedRgbImage | null;
    readonly error: string | null;
  }

  const fetched = await runWithConcurrency(
    sources,
    DEFAULT_MAX_WORKERS,
    async (src, idx): Promise<FetchedBand> => {
      const index = idx + 1;
      const label = shortLabel(src, index);
      try {
        const im = await loadImageFromSource(src, timeoutSec, ctx);
        const bandIm = await extractBand(im, band, bandPct, !noRotateLeft);
        const resized = await resizeToWidth(bandIm, targetWidth);
        return { index, source: src, label, image: resized, error: null };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { index, source: src, label, image: null, error: msg };
      }
    }
  );

  const okCount = fetched.filter((row) => row.image !== null).length;
  if (okCount === 0) {
    for (const row of fetched) {
      ctx.io.stderr(`Error ${row.label}: ${row.error ?? 'unknown error'}`);
    }
    return { exitCode: 1, bytesOut: 0 };
  }

  const headerH = 26;
  const errorH = 36;
  const gapH = 6;
  const totalH = Math.max(
    1,
    fetched.reduce((sum, row) => sum + headerH + (row.image ? row.image.height : errorH) + gapH, 0)
  );

  const overlays: OverlayOptions[] = [];
  let y = 0;
  for (const row of fetched) {
    const headerText = row.error ? `${row.label}  ERROR: ${row.error}` : row.label;
    overlays.push({ input: buildHeaderSvg(targetWidth, headerH, headerText), left: 0, top: y });
    y += headerH;
    if (row.image) {
      overlays.push({ input: row.image.buffer, left: 0, top: y });
      y += row.image.height + gapH;
    } else {
      overlays.push({
        input: buildHeaderSvg(targetWidth, errorH, row.error ?? 'Error', '#5a1414', '#ffdcdc'),
        left: 0,
        top: y,
      });
      y += errorH + gapH;
    }
  }

  const canvas = await sharp({
    create: {
      width: targetWidth,
      height: totalH,
      channels: 3,
      background: { r: 24, g: 24, b: 24 },
    },
    limitInputPixels: false,
  })
    .composite(overlays)
    .removeAlpha()
    .png()
    .toBuffer();

  const saved = await encodeCompactJpeg(canvas, outPath, { maxWidth: targetWidth, maxKb });
  const errors = fetched.filter((r) => r.error !== null).map((r) => ({ source: r.source, error: r.error }));

  const payload = {
    band,
    band_pct: bandPct,
    count: sources.length,
    ok: okCount,
    errors,
    ...saved,
  };

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
  }
  const text =
    `${saved.path}  ${saved.width}x${saved.height}  ${(saved.bytes / 1024).toFixed(1)} KB  ` +
    `(${okCount}/${sources.length} bands)`;
  const bytesOut = emitStdout(ctx.io, text);
  for (const err of errors) {
    ctx.io.stderr(`warning: ${err.source}: ${err.error ?? ''}`);
  }
  return { exitCode: 0, bytesOut };
}

export async function cmdStitch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const expanded = expandMultiBoxArgs(normalizePrepScanArgv(argv), new Set(['--box', '--redact']));
  const parsed = parseCommandArgs(expanded, STITCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('stitch')) };
  }

  const src = resolveUserPathFromContext(parsed.positionals[0] ?? '', ctx);
  const outPath = resolveOutputAlias('stitch', parsed.positionals[1], getStringOption(parsed, 'outOpt'), ctx);
  const boxRaws = getStringListOption(parsed, 'box');
  const redactRaws = getStringListOption(parsed, 'redact');
  const rotateDeg = getNumberOption(parsed, 'rotate');
  const direction = parseJoinDirection(getStringOption(parsed, 'direction') ?? 'vertical');
  const gap = getNumberOption(parsed, 'gap') ?? 6;
  const dividerRgb = parseRgbColor(getStringOption(parsed, 'dividerColor') ?? '#222222');
  const quality = getNumberOption(parsed, 'quality') ?? 90;
  const maxWidth = getNumberOption(parsed, 'maxWidth');
  const maxKb = getNumberOption(parsed, 'maxKb');
  const rawLabels = getStringListOption(parsed, 'labels');
  const labels =
    rawLabels.length === 1 && (rawLabels[0] ?? '').includes(',')
      ? (rawLabels[0] ?? '').split(',').map((s) => s.trim())
      : rawLabels;
  const headerHeightOpt = getNumberOption(parsed, 'headerHeight');
  const headerH = labels.length > 0 ? (headerHeightOpt ?? 26) : 0;

  const boxes = boxRaws.map((raw) => parseBox(raw));
  const redactBoxes = redactRaws.map((raw) => parseBox(raw));

  if (boxes.length < 2) {
    throw new CliValidationError(
      'stitch requires at least 2 --box regions (for example header + target band).'
    );
  }

  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    ctx.io.stderr(`Error: input file not found: ${src}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  let img = await loadRgbFromFile(src);
  img = await rotateImageClockwise(img, rotateDeg);

  const redacted = await paintBlackBoxesInclusive(img, redactBoxes, '--redact');
  img = redacted.image;

  const croppedBands: Array<{ readonly box: Box; readonly image: LoadedRgbImage }> = [];
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    if (!box) continue;
    const clamped = clampBox(box, img.width, img.height, `--box #${i + 1}`);
    const bandImg = await cropRgbImage(img, clamped);
    croppedBands.push({ box: clamped, image: bandImg });
  }

  let canvasW: number;
  let canvasH: number;
  if (direction === 'horizontal') {
    canvasW = croppedBands.reduce((sum, b) => sum + b.image.width, 0) + gap * (croppedBands.length - 1);
    canvasH = Math.max(...croppedBands.map((b) => b.image.height + headerH));
  } else {
    canvasW = Math.max(...croppedBands.map((b) => b.image.width));
    canvasH =
      croppedBands.reduce((sum, b) => sum + b.image.height + headerH, 0) + gap * (croppedBands.length - 1);
  }

  const overlays: OverlayOptions[] = [];
  const bandReports: Array<{
    readonly box: readonly [number, number, number, number];
    readonly width: number;
    readonly height: number;
    readonly x_offset: number;
    readonly y_offset: number;
    readonly label?: string;
  }> = [];

  if (direction === 'horizontal') {
    let x = 0;
    for (let i = 0; i < croppedBands.length; i += 1) {
      const entry = croppedBands[i];
      if (!entry) continue;
      const { box: cbox, image: band } = entry;
      const label = labels[i];
      const bandTop = headerH;
      if (headerH > 0) {
        overlays.push({
          input: buildHeaderSvg(band.width, headerH, label ?? `Panel ${i + 1}`),
          left: x,
          top: 0,
        });
      }
      if (band.height + headerH < canvasH) {
        overlays.push({
          input: {
            create: {
              width: band.width,
              height: canvasH - headerH,
              channels: 3,
              background: { r: 255, g: 255, b: 255 },
            },
          },
          left: x,
          top: bandTop,
        });
      }
      const yOffset = bandTop + Math.floor((canvasH - headerH - band.height) / 2);
      overlays.push({ input: band.buffer, left: x, top: yOffset });
      bandReports.push({
        box: [cbox.x0, cbox.y0, cbox.x1, cbox.y1],
        width: band.width,
        height: band.height,
        x_offset: x,
        y_offset: yOffset,
        ...(label !== undefined ? { label } : {}),
      });
      x += band.width + gap;
    }
  } else {
    let y = 0;
    for (let i = 0; i < croppedBands.length; i += 1) {
      const entry = croppedBands[i];
      if (!entry) continue;
      const { box: cbox, image: band } = entry;
      const label = labels[i];
      if (headerH > 0) {
        overlays.push({
          input: buildHeaderSvg(canvasW, headerH, label ?? `Panel ${i + 1}`),
          left: 0,
          top: y,
        });
        y += headerH;
      }
      if (band.width < canvasW) {
        overlays.push({
          input: {
            create: {
              width: canvasW,
              height: band.height,
              channels: 3,
              background: { r: 255, g: 255, b: 255 },
            },
          },
          left: 0,
          top: y,
        });
      }
      const xOffset = Math.floor((canvasW - band.width) / 2);
      overlays.push({ input: band.buffer, left: xOffset, top: y });
      bandReports.push({
        box: [cbox.x0, cbox.y0, cbox.x1, cbox.y1],
        width: band.width,
        height: band.height,
        x_offset: xOffset,
        y_offset: y,
        ...(label !== undefined ? { label } : {}),
      });
      y += band.height + gap;
    }
  }

  const canvasBuf = await sharp({
    create: {
      width: Math.max(1, canvasW),
      height: Math.max(1, canvasH),
      channels: 3,
      background: dividerRgb,
    },
    limitInputPixels: false,
  })
    .composite(overlays)
    .removeAlpha()
    .png()
    .toBuffer();

  const canvasImage: LoadedRgbImage = {
    buffer: canvasBuf,
    width: Math.max(1, canvasW),
    height: Math.max(1, canvasH),
  };

  const saved =
    maxWidth !== undefined || maxKb !== undefined
      ? await encodeCompactJpeg(canvasBuf, outPath, {
          maxWidth: maxWidth ?? canvasImage.width,
          maxKb: maxKb ?? 280,
        })
      : await saveArchivalImage(canvasImage, outPath, quality);

  const payload = {
    width: saved.width,
    height: saved.height,
    bytes: saved.bytes,
    bands: bandReports,
    redactions: redacted.painted,
    out: saved.path,
  };
  return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
}
