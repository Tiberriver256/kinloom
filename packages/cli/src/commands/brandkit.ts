import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type BrandOverrides,
  type BrandSurface,
  buildWebManifest,
  KINLOOM_ICON_SIZES,
  KINLOOM_OG_DIMENSIONS,
  type KinloomSiteConfig,
  parseKinloomConfigYaml,
  renderBrandkitHeadTags,
  renderFaviconSvg,
  renderIconSvg,
  renderOgCardSvg,
  renderPrivacySafeServiceWorkerScript,
  renderThemeInitScriptSource,
  resolveBrandSpec,
} from '@kinloom/core';
import sharp from 'sharp';
import { CliValidationError } from '../errors.js';

export interface IcoPngFrame {
  readonly size: number;
  readonly png: Buffer;
}

/**
 * Encodes one or more square PNG buffers (e.g. 16x16, 32x32, 48x48) into a
 * standards-compliant multi-size Windows/browser `.ico` container.
 */
export function encodeIcoFromPngs(frames: readonly IcoPngFrame[]): Buffer {
  if (frames.length === 0) {
    throw new RangeError('At least one PNG frame is required to encode an ICO file.');
  }

  const headerSize = 6;
  const entrySize = 16;
  const directorySize = headerSize + frames.length * entrySize;
  const totalDataSize = frames.reduce((sum, frame) => sum + frame.png.length, 0);
  const out = Buffer.alloc(directorySize + totalDataSize);

  // ICONDIR header: reserved(0), type(1 = ICO), count
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(frames.length, 4);

  let dataOffset = directorySize;
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i];
    const entryOffset = headerSize + i * entrySize;
    const dimByte = frame.size >= 256 ? 0 : frame.size;

    out.writeUInt8(dimByte, entryOffset + 0); // width
    out.writeUInt8(dimByte, entryOffset + 1); // height
    out.writeUInt8(0, entryOffset + 2); // color palette count
    out.writeUInt8(0, entryOffset + 3); // reserved
    out.writeUInt16LE(1, entryOffset + 4); // color planes
    out.writeUInt16LE(32, entryOffset + 6); // bits per pixel
    out.writeUInt32LE(frame.png.length, entryOffset + 8); // image data size
    out.writeUInt32LE(dataOffset, entryOffset + 12); // image data offset

    frame.png.copy(out, dataOffset);
    dataOffset += frame.png.length;
  }

  return out;
}

export interface BrandkitFileArtifact {
  readonly fileName: string;
  readonly filePath: string;
  readonly bytes: number;
  readonly skipped: boolean;
}

export interface BrandkitCommandOptions {
  readonly outDir: string;
  readonly configPath?: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly metadataLine?: string;
  readonly accent?: string;
  readonly surface?: BrandSurface;
  readonly markSvgPath?: string;
  readonly vignetteImagePath?: string;
  readonly baseUrl?: string;
  readonly force?: boolean;
  readonly cwd?: string;
}

export interface BrandkitCommandResult {
  readonly outDir: string;
  readonly files: readonly BrandkitFileArtifact[];
  readonly headTags: string;
  readonly ogBytes: number;
  readonly totalBytes: number;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function extractInnerSvgContent(rawSvg: string): string {
  const openMatch = rawSvg.match(/<svg\b[^>]*>/i);
  const closeIdx = rawSvg.lastIndexOf('</svg>');
  if (!openMatch || openMatch.index === undefined || closeIdx === -1) {
    throw new CliValidationError('Custom mark SVG must contain a valid <svg>...</svg> element.');
  }
  return rawSvg.slice(openMatch.index + openMatch[0].length, closeIdx).trim();
}

async function loadVignetteDataUri(imagePath: string): Promise<string> {
  const raw = await readFile(imagePath);
  const compressed = await sharp(raw)
    .resize(330, 454, { fit: 'cover', position: 'attention' })
    .jpeg({ quality: 78, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${compressed.toString('base64')}`;
}

async function rasterizeSvgToPng(
  svgMarkup: string,
  width: number,
  height: number,
  palette = false
): Promise<Buffer> {
  return sharp(Buffer.from(svgMarkup, 'utf8'), { density: 144 })
    .resize(width, height, { fit: 'fill' })
    .png({ compressionLevel: 9, palette })
    .toBuffer();
}

export async function runBrandkitCommand(options: BrandkitCommandOptions): Promise<BrandkitCommandResult> {
  const cwd = options.cwd ?? process.cwd();
  const outDirRaw = options.outDir.trim();
  if (!outDirRaw) {
    throw new CliValidationError('Output directory (`--out`) is required for `kinloom brandkit`.');
  }
  if (options.accent && !HEX_COLOR_RE.test(options.accent.trim())) {
    throw new CliValidationError('Option `--accent` must be a 6-digit hex color such as #7A4612.');
  }
  if (options.surface && options.surface !== 'parchment' && options.surface !== 'navy') {
    throw new CliValidationError('Option `--surface` must be `parchment` or `navy`.');
  }

  let siteConfig: KinloomSiteConfig | null = null;
  let configBaseDir = cwd;

  if (options.configPath) {
    const resolvedConfig = path.resolve(cwd, options.configPath);
    const rawYaml = await readFile(resolvedConfig, 'utf8');
    try {
      siteConfig = parseKinloomConfigYaml(rawYaml);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliValidationError(`Invalid kinloom.config.yaml at ${resolvedConfig}: ${msg}`);
    }
    configBaseDir = path.dirname(resolvedConfig);
  }

  const markPathRaw = options.markSvgPath ?? siteConfig?.brand?.markSvg;
  let customMarkInnerSvg: string | undefined;
  if (markPathRaw) {
    const resolvedMark = path.resolve(options.markSvgPath ? cwd : configBaseDir, markPathRaw);
    const rawMarkSvg = await readFile(resolvedMark, 'utf8');
    customMarkInnerSvg = extractInnerSvgContent(rawMarkSvg);
  }

  const vignettePathRaw = options.vignetteImagePath ?? siteConfig?.brand?.vignetteImage;
  let vignetteDataUri: string | undefined;
  if (vignettePathRaw) {
    const resolvedVignette = path.resolve(options.vignetteImagePath ? cwd : configBaseDir, vignettePathRaw);
    vignetteDataUri = await loadVignetteDataUri(resolvedVignette);
  }

  const overrides: BrandOverrides = {
    title: options.title,
    subtitle: options.subtitle,
    metadataLine: options.metadataLine,
    accent: options.accent,
    surface: options.surface,
    customMarkInnerSvg,
    vignetteDataUri,
    baseUrl: options.baseUrl,
  };

  const spec = resolveBrandSpec(siteConfig, overrides);

  const faviconSvg = renderFaviconSvg({
    accent: spec.accent,
    accentDark: siteConfig?.theme?.accentDark,
    label: `${spec.title} icon`,
    customMarkInnerSvg,
    mode: 'adaptive',
  });
  const faviconLightSvg = renderFaviconSvg({
    accent: spec.accent,
    accentDark: siteConfig?.theme?.accentDark,
    label: `${spec.title} icon`,
    customMarkInnerSvg,
    mode: 'light',
  });
  const faviconDarkSvg = renderFaviconSvg({
    accent: spec.accent,
    accentDark: siteConfig?.theme?.accentDark,
    label: `${spec.title} icon`,
    customMarkInnerSvg,
    mode: 'dark',
  });

  const icoFrames: IcoPngFrame[] = await Promise.all(
    KINLOOM_ICON_SIZES.ico.map(async (size) => {
      const svg = renderIconSvg({
        size,
        variant: 'any',
        surface: 'parchment',
        accent: spec.accent,
        transparentBackground: false,
        customMarkInnerSvg,
      });
      const png = await rasterizeSvgToPng(svg, size, size);
      return { size, png };
    })
  );
  const faviconIco = encodeIcoFromPngs(icoFrames);

  const [appleTouchPng, icon192Png, icon512Png, iconMaskable512Png, ogDefaultPng] = await Promise.all([
    rasterizeSvgToPng(
      renderIconSvg({
        size: KINLOOM_ICON_SIZES.appleTouch,
        variant: 'apple',
        surface: spec.surface,
        accent: spec.accent,
        customMarkInnerSvg,
      }),
      KINLOOM_ICON_SIZES.appleTouch,
      KINLOOM_ICON_SIZES.appleTouch
    ),
    rasterizeSvgToPng(
      renderIconSvg({
        size: KINLOOM_ICON_SIZES.pwaSmall,
        variant: 'any',
        surface: spec.surface,
        accent: spec.accent,
        customMarkInnerSvg,
      }),
      KINLOOM_ICON_SIZES.pwaSmall,
      KINLOOM_ICON_SIZES.pwaSmall
    ),
    rasterizeSvgToPng(
      renderIconSvg({
        size: KINLOOM_ICON_SIZES.pwaLarge,
        variant: 'any',
        surface: spec.surface,
        accent: spec.accent,
        customMarkInnerSvg,
      }),
      KINLOOM_ICON_SIZES.pwaLarge,
      KINLOOM_ICON_SIZES.pwaLarge
    ),
    rasterizeSvgToPng(
      renderIconSvg({
        size: KINLOOM_ICON_SIZES.maskable,
        variant: 'maskable',
        surface: spec.surface,
        accent: spec.accent,
        customMarkInnerSvg,
      }),
      KINLOOM_ICON_SIZES.maskable,
      KINLOOM_ICON_SIZES.maskable
    ),
    rasterizeSvgToPng(
      renderOgCardSvg({
        title: spec.title,
        subtitle: spec.subtitle,
        metadataLine: spec.metadataLine,
        footerCredit: spec.footerCredit,
        surface: spec.surface,
        accent: spec.accent,
        customMarkInnerSvg,
        vignetteDataUri,
      }),
      KINLOOM_OG_DIMENSIONS.width,
      KINLOOM_OG_DIMENSIONS.height,
      true
    ),
  ]);

  const webManifest = `${JSON.stringify(buildWebManifest(siteConfig, overrides), null, 2)}\n`;
  const serviceWorkerScript = renderPrivacySafeServiceWorkerScript({
    baseUrl: options.baseUrl,
    siteTitle: spec.title,
  });

  const resolvedOutDir = path.resolve(cwd, outDirRaw);
  await mkdir(resolvedOutDir, { recursive: true });

  const force = options.force ?? true;
  const outputs: Array<[string, Buffer | string]> = [
    ['favicon.svg', faviconSvg],
    ['favicon-light.svg', faviconLightSvg],
    ['favicon-dark.svg', faviconDarkSvg],
    ['favicon.ico', faviconIco],
    ['apple-touch-icon.png', appleTouchPng],
    ['icon-192.png', icon192Png],
    ['icon-512.png', icon512Png],
    ['icon-maskable-512.png', iconMaskable512Png],
    ['site.webmanifest', webManifest],
    ['sw.js', serviceWorkerScript],
    ['theme-init.js', renderThemeInitScriptSource()],
    ['og-default.png', ogDefaultPng],
  ];

  const files: BrandkitFileArtifact[] = [];
  for (const [fileName, content] of outputs) {
    const filePath = path.join(resolvedOutDir, fileName);
    const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
    if (!force && (await fileExists(filePath))) {
      files.push({ fileName, filePath, bytes, skipped: true });
      continue;
    }
    if (typeof content === 'string') {
      await writeFile(filePath, content, 'utf8');
    } else {
      await writeFile(filePath, content);
    }
    files.push({ fileName, filePath, bytes, skipped: false });
  }

  return {
    outDir: resolvedOutDir,
    files,
    headTags: renderBrandkitHeadTags(siteConfig, overrides),
    ogBytes: ogDefaultPng.length,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
  };
}
