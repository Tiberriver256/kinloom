import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KINLOOM_OG_DIMENSIONS, serializeKinloomConfigYaml } from '@kinloom/core';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from '../cli.js';
import { EXIT_OK } from '../errors.js';
import { encodeIcoFromPngs, runBrandkitCommand } from './brandkit.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('kinloom brandkit command', () => {
  it('encodes a valid multi-size ICO container from PNG frames', async () => {
    const png16 = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 27, g: 42, b: 65, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const png32 = await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 122, g: 70, b: 18, alpha: 1 } },
    })
      .png()
      .toBuffer();

    const ico = encodeIcoFromPngs([
      { size: 16, png: png16 },
      { size: 32, png: png32 },
    ]);

    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // ICO type
    expect(ico.readUInt16LE(4)).toBe(2); // 2 frames
    expect(ico.readUInt8(6)).toBe(16); // first frame width
    expect(ico.readUInt8(22)).toBe(32); // second frame width
  });

  it('generates all 10 all-device brandkit assets with light/dark favicons and < 300 KB OG budget', async () => {
    const dir = await makeTempDir('kinloom-brandkit-default-');
    const outDir = path.join(dir, 'public');

    const result = await runBrandkitCommand({ outDir, cwd: dir });
    expect(result.files.map((f) => f.fileName)).toEqual([
      'favicon.svg',
      'favicon-light.svg',
      'favicon-dark.svg',
      'favicon.ico',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'icon-maskable-512.png',
      'site.webmanifest',
      'og-default.png',
    ]);
    expect(result.ogBytes).toBeLessThan(KINLOOM_OG_DIMENSIONS.recommendedMaxBytes);

    const lightSvg = await readFile(path.join(outDir, 'favicon-light.svg'), 'utf8');
    expect(lightSvg).not.toContain('@media (prefers-color-scheme: dark)');
    expect(lightSvg).toContain('#F5EFE2');

    const darkSvg = await readFile(path.join(outDir, 'favicon-dark.svg'), 'utf8');
    expect(darkSvg).not.toContain('@media (prefers-color-scheme: dark)');
    expect(darkSvg).toContain('#20324D');

    const appleMeta = await sharp(path.join(outDir, 'apple-touch-icon.png')).metadata();
    expect(appleMeta.width).toBe(180);
    expect(appleMeta.height).toBe(180);

    const icon192Meta = await sharp(path.join(outDir, 'icon-192.png')).metadata();
    expect(icon192Meta.width).toBe(192);
    expect(icon192Meta.height).toBe(192);

    const maskableMeta = await sharp(path.join(outDir, 'icon-maskable-512.png')).metadata();
    expect(maskableMeta.width).toBe(512);
    expect(maskableMeta.height).toBe(512);

    const ogMeta = await sharp(path.join(outDir, 'og-default.png')).metadata();
    expect(ogMeta.width).toBe(1200);
    expect(ogMeta.height).toBe(630);

    const icoBuf = await readFile(path.join(outDir, 'favicon.ico'));
    expect(icoBuf.readUInt16LE(2)).toBe(1);
    expect(icoBuf.readUInt16LE(4)).toBe(3);

    const manifest = JSON.parse(await readFile(path.join(outDir, 'site.webmanifest'), 'utf8')) as {
      name: string;
      icons: Array<{ purpose: string; sizes: string }>;
    };
    expect(manifest.name).toBe('Kinloom');
    expect(manifest.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
  });

  it('supports config-driven customization, vignette image, --no-force, and CLI dispatch', async () => {
    const dir = await makeTempDir('kinloom-brandkit-custom-');
    const configPath = path.join(dir, 'kinloom.config.yaml');
    const vignettePath = path.join(dir, 'vignette.png');
    const outDir = path.join(dir, 'public');

    await sharp({
      create: { width: 400, height: 500, channels: 3, background: { r: 214, g: 206, b: 190 } },
    })
      .png()
      .toFile(vignettePath);

    await writeFile(
      configPath,
      serializeKinloomConfigYaml({
        schemaVersion: 1,
        site: {
          title: 'Alder Family Archive',
          familyName: 'Alder',
          gedcomSourceName: 'ALDER_ARCHIVE',
          footerCredit: 'Built with Kinloom',
        },
        theme: { accent: '#2F5245' },
        brand: {
          subtitle: 'Five Generations · 1812–1968',
          surface: 'parchment',
          themeColorLight: '#F5EFE2',
          themeColorDark: '#1B2A41',
          vignetteImage: 'vignette.png',
          showFooterCredit: true,
          dynamicOg: false,
        },
        branches: [],
        lineageSections: [],
        featuredKinshipPairs: [],
        migrationEras: [],
        mapDefaults: { centerLat: 38.5, centerLng: -96.0, zoom: 4, minSpanDeg: 1.2 },
        privacy: {
          livingCutoffYears: 101,
          privateModeShowsBirthYear: true,
          stripLivingPortraits: true,
          stripLivingResidenceSpans: true,
          markGedcomLivingConfidential: true,
        },
      }),
      'utf8'
    );

    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    };

    const code = await runCli(['brandkit', '--config', configPath, '--out', outDir, '--print-head'], {
      io,
      cwd: dir,
    });
    expect(code).toBe(EXIT_OK);
    expect(stderr).toEqual([]);
    expect(stdout.join('\n')).toContain('Generated brandkit');
    expect(stdout.join('\n')).toContain('og:image');

    const svg = await readFile(path.join(outDir, 'favicon.svg'), 'utf8');
    expect(svg).toContain('#2F5245');

    // Re-running with --no-force skips all 8 existing files
    const skipResult = await runBrandkitCommand({ configPath, outDir, force: false, cwd: dir });
    expect(skipResult.files.every((f) => f.skipped)).toBe(true);
  });
});
