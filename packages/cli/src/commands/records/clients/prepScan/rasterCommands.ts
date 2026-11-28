import fs from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { CliValidationError } from '../../../../errors.js';
import {
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import { sha256Hex } from '../../runtime/cache.js';
import { encodeCompactJpeg, orientedDimensions, type SavedImageInfo } from '../../runtime/image.js';
import { resolveUserPathFromContext, runWithConcurrency } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
} from '../../runtime/types.js';
import {
  CROP_PARSE_SPEC,
  GRID_PARSE_SPEC,
  INFO_PARSE_SPEC,
  JOIN_PARSE_SPEC,
  PREVIEW_PARSE_SPEC,
  ROTATE_PARSE_SPEC,
  renderCropHelp,
  renderSubcommandHelp,
} from './cliSpecs.js';
import {
  alignOffset,
  clampBox,
  DEFAULT_MAX_WORKERS,
  expandMultiBoxArgs,
  normalizePrepScanArgv,
  normalizeRotationAngle,
  parseBox,
  parseJoinAlign,
  parseJoinDirection,
  parseRgbColor,
  roundKb,
  safeStem,
} from './geometry.js';
import {
  buildGridSvg,
  cropRgbImage,
  defaultCacheRoot,
  deskewImage,
  type LoadedRgbImage,
  loadRgbFromFile,
  mapChannelsToMode,
  paintBlackBoxesInclusive,
  resizeToWidth,
  resolveOutputAlias,
  rotateImageClockwise,
  saveArchivalImage,
} from './imageOps.js';

export async function cmdPreview(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), PREVIEW_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('preview')) };
  }

  const outDir = resolveUserPathFromContext(getStringOption(parsed, 'outDir') ?? '', ctx);
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1400;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;
  const rotateDeg = getNumberOption(parsed, 'rotate');
  const deskew = getBooleanOption(parsed, 'deskew');
  const asJson = getBooleanOption(parsed, 'json');

  const inputs = parsed.positionals.map((p) => resolveUserPathFromContext(p, ctx));
  const missing = inputs.filter((p) => !fs.existsSync(p) || !fs.statSync(p).isFile());
  if (missing.length > 0) {
    for (const m of missing) {
      ctx.io.stderr(`Error: input file not found: ${m}`);
    }
    return { exitCode: 1, bytesOut: 0 };
  }

  fs.mkdirSync(outDir, { recursive: true });

  const stemCounts = new Map<string, number>();
  for (const p of inputs) {
    const stem = safeStem(path.parse(p).name);
    stemCounts.set(stem, (stemCounts.get(stem) ?? 0) + 1);
  }

  interface PreviewItem extends SavedImageInfo {
    readonly source: string;
    readonly source_size: readonly [number, number];
  }

  const results = await runWithConcurrency(inputs, DEFAULT_MAX_WORKERS, async (src): Promise<PreviewItem> => {
    const stem = safeStem(path.parse(src).name);
    const outName =
      (stemCounts.get(stem) ?? 0) > 1
        ? `${stem}_${sha256Hex(src).slice(0, 8)}.preview.jpg`
        : `${stem}.preview.jpg`;
    const outPath = path.join(outDir, outName);

    let img = await loadRgbFromFile(src);
    const origW = img.width;
    const origH = img.height;
    if (rotateDeg !== undefined) {
      img = await rotateImageClockwise(img, rotateDeg);
    }
    if (deskew) {
      img = await deskewImage(img);
    }
    const saved = await encodeCompactJpeg(img.buffer, outPath, { maxWidth, maxKb });
    return {
      source: src,
      source_size: [origW, origH],
      ...saved,
    };
  });

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, results) };
  }
  const lines = results.map((item) => `${item.path}  ${item.width}x${item.height}  ${item.kb.toFixed(1)} KB`);
  return { exitCode: 0, bytesOut: lines.length > 0 ? emitStdout(ctx.io, lines.join('\n')) : 0 };
}

export async function cmdCrop(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const expanded = expandMultiBoxArgs(normalizePrepScanArgv(argv), new Set(['--redact', '--redact-orig']));
  const parsed = parseCommandArgs(expanded, CROP_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCropHelp()) };
  }

  const src = resolveUserPathFromContext(parsed.positionals[0] ?? '', ctx);
  const outPath = resolveOutputAlias('crop', parsed.positionals[1], getStringOption(parsed, 'outOpt'), ctx);
  const quality = getNumberOption(parsed, 'quality') ?? 92;
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1400;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;
  const rotateDeg = getNumberOption(parsed, 'rotate');
  const boxRaw = getStringOption(parsed, 'box');
  const redactRaws = getStringListOption(parsed, 'redact');
  const redactOrigRaws = getStringListOption(parsed, 'redactOrig');
  const previewOutOpt = getStringOption(parsed, 'previewOut');
  const asJson = getBooleanOption(parsed, 'json');

  const requestedBox = boxRaw !== undefined ? parseBox(boxRaw) : undefined;
  const redactBoxes = redactRaws.map((raw) => parseBox(raw));
  const redactOrigBoxes = redactOrigRaws.map((raw) => parseBox(raw));
  const normalizedRotate = normalizeRotationAngle(rotateDeg);

  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    ctx.io.stderr(`Error: input file not found: ${src}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  let img = await loadRgbFromFile(src);
  img = await rotateImageClockwise(img, normalizedRotate);

  const origRedacted = await paintBlackBoxesInclusive(img, redactOrigBoxes, '--redact-orig');
  img = origRedacted.image;

  const targetBox = requestedBox ?? { x0: 0, y0: 0, x1: img.width, y1: img.height };
  const cropBox = clampBox(targetBox, img.width, img.height, 'crop --box');
  let cropped = await cropRgbImage(img, cropBox);

  const postRedacted = await paintBlackBoxesInclusive(
    cropped,
    redactBoxes,
    '--redact',
    'If you read the box from prep-scan grid, pass the same numbers to --redact-orig. ' +
      '--redact uses coordinates on the cropped image.'
  );
  cropped = postRedacted.image;

  const saved = await saveArchivalImage(cropped, outPath, quality);

  let previewPath: string;
  if (previewOutOpt) {
    previewPath = resolveUserPathFromContext(previewOutOpt, ctx);
  } else {
    const digest = sha256Hex(outPath).slice(0, 8);
    previewPath = path.join(
      defaultCacheRoot(ctx),
      'previews',
      `${safeStem(path.parse(outPath).name)}_${digest}.preview.jpg`
    );
  }
  const preview = await encodeCompactJpeg(cropped.buffer, previewPath, { maxWidth, maxKb });

  const payload = {
    source: src,
    rotate: normalizedRotate,
    box: [cropBox.x0, cropBox.y0, cropBox.x1, cropBox.y1],
    redactions: postRedacted.painted,
    redactions_orig: origRedacted.painted,
    output: saved,
    preview,
  };

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
  }
  const text =
    `output:  ${saved.path}  ${saved.width}x${saved.height}  ${(saved.bytes / 1024).toFixed(1)} KB\n` +
    `preview: ${preview.path}  ${preview.width}x${preview.height}  ${(preview.bytes / 1024).toFixed(1)} KB`;
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, text) };
}

export async function cmdRotate(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), ROTATE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('rotate')) };
  }

  const src = resolveUserPathFromContext(parsed.positionals[0] ?? '', ctx);
  const outPath = resolveOutputAlias('rotate', parsed.positionals[1], getStringOption(parsed, 'outOpt'), ctx);
  const angle = normalizeRotationAngle(getNumberOption(parsed, 'angle'));
  const quality = getNumberOption(parsed, 'quality') ?? 92;
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1400;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;
  const previewOutOpt = getStringOption(parsed, 'previewOut');
  const asJson = getBooleanOption(parsed, 'json');

  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    ctx.io.stderr(`Error: input file not found: ${src}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  const img = await loadRgbFromFile(src);
  const rotated = await rotateImageClockwise(img, angle);
  const saved = await saveArchivalImage(rotated, outPath, quality);

  let preview: SavedImageInfo | undefined;
  if (previewOutOpt) {
    preview = await encodeCompactJpeg(rotated.buffer, resolveUserPathFromContext(previewOutOpt, ctx), {
      maxWidth,
      maxKb,
    });
  }

  const payload = {
    source: src,
    angle,
    width: saved.width,
    height: saved.height,
    bytes: saved.bytes,
    kb: saved.kb,
    out: saved.path,
    ...(preview ? { preview } : {}),
  };

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
  }
  const text = `${saved.path}  ${saved.width}x${saved.height}  ${saved.kb.toFixed(1)} KB (rotated ${angle} deg)`;
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, text) };
}

export async function cmdGrid(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), GRID_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('grid')) };
  }

  const src = resolveUserPathFromContext(parsed.positionals[0] ?? '', ctx);
  const outPath = resolveOutputAlias('grid', parsed.positionals[1], getStringOption(parsed, 'outOpt'), ctx);
  const step = getNumberOption(parsed, 'step') ?? 200;
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1600;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;
  const rotateDeg = getNumberOption(parsed, 'rotate');

  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    ctx.io.stderr(`Error: input file not found: ${src}`);
    return { exitCode: 1, bytesOut: 0 };
  }

  let img = await loadRgbFromFile(src);
  img = await rotateImageClockwise(img, rotateDeg);
  const origW = img.width;
  const origH = img.height;

  const base = origW > maxWidth ? await resizeToWidth(img, maxWidth) : img;
  const gridSvg = buildGridSvg(base.width, base.height, origW, origH, step);
  const composited = await sharp(base.buffer, { limitInputPixels: false })
    .composite([{ input: gridSvg, left: 0, top: 0 }])
    .removeAlpha()
    .png()
    .toBuffer();

  const saved = await encodeCompactJpeg(composited, outPath, { maxWidth, maxKb });
  const payload = {
    original_width: origW,
    original_height: origH,
    preview_width: saved.width,
    preview_height: saved.height,
    step,
    bytes: saved.bytes,
    out: saved.path,
  };
  return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
}

export async function cmdInfo(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), INFO_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('info')) };
  }

  const asJson = getBooleanOption(parsed, 'json');
  interface InfoFileRecord {
    readonly path: string;
    readonly width: number;
    readonly height: number;
    readonly format: string;
    readonly mode: string;
    readonly bytes: number;
    readonly kb: number;
  }

  const files: InfoFileRecord[] = [];
  const errors: string[] = [];

  for (const raw of parsed.positionals) {
    const src = resolveUserPathFromContext(raw, ctx);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      errors.push(`input file not found: ${src}`);
      continue;
    }
    try {
      const nbytes = fs.statSync(src).size;
      const meta = await sharp(src, { limitInputPixels: false }).metadata();
      const { width, height } = orientedDimensions(meta);
      const imageFormat = (meta.format ?? 'UNKNOWN').toUpperCase();
      const mode = mapChannelsToMode(meta.channels, meta.space);
      files.push({
        path: src,
        width,
        height,
        format: imageFormat,
        mode,
        bytes: nbytes,
        kb: roundKb(nbytes),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`cannot read image ${src}: ${msg}. Use a JPEG, PNG, WEBP, or TIFF file.`);
    }
  }

  if (errors.length > 0) {
    for (const message of errors) {
      ctx.io.stderr(`Error: ${message}`);
    }
    return { exitCode: 1, bytesOut: 0 };
  }

  if (asJson) {
    return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, { count: files.length, files }) };
  }
  const lines = files.map(
    (item) => `${item.path}: ${item.width}x${item.height} ${item.format} (${item.kb.toFixed(1)} KB)`
  );
  return { exitCode: 0, bytesOut: lines.length > 0 ? emitStdout(ctx.io, lines.join('\n')) : 0 };
}

export async function cmdJoin(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(normalizePrepScanArgv(argv), JOIN_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSubcommandHelp('join')) };
  }

  if (parsed.positionals.length < 2) {
    throw new CliValidationError('join requires at least 2 images. Pass two or more paths and --out <file>.');
  }

  const outPath = resolveUserPathFromContext(getStringOption(parsed, 'out') ?? '', ctx);
  const direction = parseJoinDirection(getStringOption(parsed, 'direction') ?? 'vertical');
  const gap = getNumberOption(parsed, 'gap') ?? 8;
  const align = parseJoinAlign(getStringOption(parsed, 'align') ?? 'center');
  const background = parseRgbColor(getStringOption(parsed, 'dividerColor') ?? '#222222');
  const quality = getNumberOption(parsed, 'quality') ?? 92;
  const previewOutOpt = getStringOption(parsed, 'previewOut');
  const maxWidth = getNumberOption(parsed, 'maxWidth') ?? 1400;
  const maxKb = getNumberOption(parsed, 'maxKb') ?? 280;

  const frames: LoadedRgbImage[] = [];
  for (const raw of parsed.positionals) {
    const src = resolveUserPathFromContext(raw, ctx);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      ctx.io.stderr(`Error: input file not found: ${src}`);
      return { exitCode: 1, bytesOut: 0 };
    }
    frames.push(await loadRgbFromFile(src));
  }

  let canvasW: number;
  let canvasH: number;
  if (direction === 'horizontal') {
    canvasW = frames.reduce((sum, f) => sum + f.width, 0) + gap * (frames.length - 1);
    canvasH = Math.max(...frames.map((f) => f.height));
  } else {
    canvasW = Math.max(...frames.map((f) => f.width));
    canvasH = frames.reduce((sum, f) => sum + f.height, 0) + gap * (frames.length - 1);
  }

  const overlays: OverlayOptions[] = [];
  let cursor = 0;
  for (const frame of frames) {
    if (direction === 'horizontal') {
      const x = cursor;
      const y = alignOffset(canvasH, frame.height, align);
      overlays.push({ input: frame.buffer, left: x, top: y });
      cursor += frame.width + gap;
    } else {
      const x = alignOffset(canvasW, frame.width, align);
      const y = cursor;
      overlays.push({ input: frame.buffer, left: x, top: y });
      cursor += frame.height + gap;
    }
  }

  const canvasBuf = await sharp({
    create: {
      width: Math.max(1, canvasW),
      height: Math.max(1, canvasH),
      channels: 3,
      background,
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
  const saved = await saveArchivalImage(canvasImage, outPath, quality);

  let previewPath: string | undefined;
  if (previewOutOpt) {
    const preview = await encodeCompactJpeg(canvasBuf, resolveUserPathFromContext(previewOutOpt, ctx), {
      maxWidth,
      maxKb,
    });
    previewPath = preview.path;
  }

  const payload = {
    width: saved.width,
    height: saved.height,
    bytes: saved.bytes,
    count: parsed.positionals.length,
    direction,
    out: saved.path,
    ...(previewPath !== undefined ? { preview_out: previewPath } : {}),
  };
  return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, payload) };
}
