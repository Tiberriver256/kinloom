import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serializeKinloomConfigYaml } from '@kinloom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from './cli.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from './errors.js';
import { discoverSiteCliPlugins, type KinloomCliPlugin } from './plugins.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCaptureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

function makeSampleSiteConfigYaml(plugins?: string[]): string {
  return serializeKinloomConfigYaml({
    schemaVersion: 1,
    site: {
      title: 'Alder Archive',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER',
      footerCredit: 'Built with Kinloom',
    },
    theme: { accent: '#7A4612' },
    defaultBranchId: 'alder',
    branches: [
      {
        id: 'alder',
        label: 'Alder',
        surnames: ['Alder'],
        lineageGroups: ['ancestor'],
        supportsDirectMode: true,
      },
    ],
    lineageSections: [],
    featuredKinshipPairs: [],
    migrationEras: [],
    mapDefaults: { centerLat: 40.0, centerLng: -83.0, zoom: 5, minSpanDeg: 1.0 },
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
      privateModeShowsBirthYear: true,
      stripLivingPortraits: true,
      stripLivingResidenceSpans: true,
      markGedcomLivingConfidential: true,
    },
    ...(plugins ? { plugins } : {}),
  });
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('site-root CLI plugin discovery and dispatch', () => {
  it('auto-detects a plugin in extensions/<name>/cli.mjs for --help, help <cmd>, <cmd> --help, and dispatch', async () => {
    const siteDir = await makeTempDir('kinloom-plugin-ext-');
    const pluginDir = path.join(siteDir, 'extensions', 'sample-plugin');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      path.join(pluginDir, 'cli.mjs'),
      `export default {
  id: 'sample-plugin',
  name: 'Sample Plugin',
  commands: [
    {
      name: 'greet',
      summary: 'Greet a researcher by name',
      help: 'Usage: kinloom greet --name <name>\\n\\nOptions:\\n  --name <name>  Name to greet',
      run(args, ctx) {
        const idx = args.indexOf('--name');
        const name = idx >= 0 && args[idx + 1] ? args[idx + 1] : 'Archive';
        ctx.io.stdout(\`Hello, \${name}! (cwd=\${ctx.cwd})\`);
        return 0;
      },
    },
  ],
};
`,
      'utf8'
    );

    const helpCap = createCaptureIo();
    expect(await runCli(['--help'], { cwd: siteDir, io: helpCap.io })).toBe(EXIT_OK);
    expect(helpCap.stderr).toEqual([]);
    const helpOutput = helpCap.stdout.join('\n');
    expect(helpOutput).toContain('Site plugin commands:');
    expect(helpOutput).toContain('greet');
    expect(helpOutput).toContain('Greet a researcher by name');

    const helpCmdCap = createCaptureIo();
    expect(await runCli(['help', 'greet'], { cwd: siteDir, io: helpCmdCap.io })).toBe(EXIT_OK);
    expect(helpCmdCap.stderr).toEqual([]);
    expect(helpCmdCap.stdout.join('\n')).toContain('Usage: kinloom greet --name <name>');

    const flagHelpCap = createCaptureIo();
    expect(await runCli(['greet', '--help'], { cwd: siteDir, io: flagHelpCap.io })).toBe(EXIT_OK);
    expect(flagHelpCap.stderr).toEqual([]);
    expect(flagHelpCap.stdout.join('\n')).toContain('Usage: kinloom greet --name <name>');

    const runCap = createCaptureIo();
    expect(await runCli(['greet', '--name', 'Ada'], { cwd: siteDir, io: runCap.io })).toBe(EXIT_OK);
    expect(runCap.stderr).toEqual([]);
    expect(runCap.stdout).toEqual([`Hello, Ada! (cwd=${siteDir})`]);
  });

  it('auto-detects a plugin declared in kinloom.config.yaml and passes siteConfig in context', async () => {
    const siteDir = await makeTempDir('kinloom-plugin-config-');
    const pluginsDir = path.join(siteDir, 'plugins');
    await mkdir(pluginsDir, { recursive: true });

    await writeFile(
      path.join(siteDir, 'kinloom.config.yaml'),
      makeSampleSiteConfigYaml(['./plugins/custom-cli.mjs']),
      'utf8'
    );

    await writeFile(
      path.join(pluginsDir, 'custom-cli.mjs'),
      `export const cliPlugin = {
  id: 'custom-site-tools',
  name: 'Custom Site Tools',
  commands: [
    {
      name: 'site-banner',
      summary: 'Print the configured site title',
      help: 'Usage: kinloom site-banner',
      async run(_args, ctx) {
        ctx.io.stdout(\`Site: \${ctx.siteConfig?.site.title ?? 'unknown'}\`);
        return 0;
      },
    },
  ],
};
`,
      'utf8'
    );

    const discovered = await discoverSiteCliPlugins(siteDir);
    expect(discovered.warnings).toEqual([]);
    expect(discovered.siteConfig?.site.title).toBe('Alder Archive');
    expect(discovered.plugins).toHaveLength(1);
    expect(discovered.plugins[0]?.id).toBe('custom-site-tools');

    const runCap = createCaptureIo();
    expect(await runCli(['site-banner'], { cwd: siteDir, io: runCap.io })).toBe(EXIT_OK);
    expect(runCap.stderr).toEqual([]);
    expect(runCap.stdout).toEqual(['Site: Alder Archive']);
  });

  it('prevents a plugin from shadowing built-in commands like verify while keeping safe commands', async () => {
    const siteDir = await makeTempDir('kinloom-plugin-shadow-');
    const pluginDir = path.join(siteDir, 'extensions', 'shadow-plugin');
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      path.join(pluginDir, 'cli.mjs'),
      `export const plugin = {
  id: 'shadow-plugin',
  name: 'Shadow Plugin',
  commands: [
    {
      name: 'verify',
      summary: 'Malicious override attempt',
      help: 'FAKE VERIFY HELP',
      run(_args, ctx) {
        ctx.io.stdout('SHADOWED');
        return 0;
      },
    },
    {
      name: 'safe-cmd',
      summary: 'A non-shadowing command',
      help: 'Usage: kinloom safe-cmd',
      run(_args, ctx) {
        ctx.io.stdout('SAFE_OK');
        return 0;
      },
    },
  ],
};
`,
      'utf8'
    );

    const discovered = await discoverSiteCliPlugins(siteDir);
    expect(discovered.warnings.some((w) => w.includes("shadow built-in command 'verify'"))).toBe(true);
    expect(discovered.plugins).toHaveLength(1);
    expect(discovered.plugins[0]?.commands?.map((c) => c.name)).toEqual(['safe-cmd']);

    const verifyHelpCap = createCaptureIo();
    expect(await runCli(['verify', '--help'], { cwd: siteDir, io: verifyHelpCap.io })).toBe(EXIT_OK);
    expect(verifyHelpCap.stdout.join('\n')).toContain('Usage: kinloom verify');
    expect(verifyHelpCap.stdout.join('\n')).not.toContain('FAKE VERIFY HELP');
    expect(verifyHelpCap.stderr.join('\n')).toContain("shadow built-in command 'verify'");

    const safeCap = createCaptureIo();
    expect(await runCli(['safe-cmd'], { cwd: siteDir, io: safeCap.io })).toBe(EXIT_OK);
    expect(safeCap.stdout).toEqual(['SAFE_OK']);
  });

  it('runs cleanly in directories without kinloom.config.yaml or extensions/', async () => {
    const emptyDir = await makeTempDir('kinloom-plugin-empty-');

    const discovered = await discoverSiteCliPlugins(emptyDir);
    expect(discovered.siteConfig).toBeNull();
    expect(discovered.plugins).toEqual([]);
    expect(discovered.warnings).toEqual([]);

    const helpCap = createCaptureIo();
    expect(await runCli(['--help'], { cwd: emptyDir, io: helpCap.io })).toBe(EXIT_OK);
    expect(helpCap.stderr).toEqual([]);
    expect(helpCap.stdout.join('\n')).not.toContain('Site plugin commands:');

    const unknownCap = createCaptureIo();
    expect(await runCli(['no-such-cmd'], { cwd: emptyDir, io: unknownCap.io })).toBe(EXIT_USAGE);
  });

  it('does not crash --help when kinloom.config.yaml is malformed', async () => {
    const brokenDir = await makeTempDir('kinloom-plugin-bad-yaml-');
    await writeFile(path.join(brokenDir, 'kinloom.config.yaml'), 'site:\n  title: [unclosed', 'utf8');

    const helpCap = createCaptureIo();
    expect(await runCli(['--help'], { cwd: brokenDir, io: helpCap.io })).toBe(EXIT_OK);
    expect(helpCap.stdout.join('\n')).toContain('Archive lifecycle:');
    expect(helpCap.stderr.join('\n')).toContain('Could not parse kinloom.config.yaml');
  });

  it('supports explicit options.plugins and deduplicates by id', async () => {
    const emptyDir = await makeTempDir('kinloom-plugin-explicit-');
    const explicitPlugin: KinloomCliPlugin = {
      id: 'explicit-plugin',
      name: 'Explicit Plugin',
      commands: [
        {
          name: 'ping',
          summary: 'Respond with pong',
          help: 'Usage: kinloom ping',
          run(_args, ctx) {
            ctx.io.stdout('pong');
            return EXIT_OK;
          },
        },
        {
          name: 'fail-cmd',
          summary: 'Return exit code 1',
          help: 'Usage: kinloom fail-cmd',
          run() {
            return EXIT_ERROR;
          },
        },
      ],
    };

    const pingCap = createCaptureIo();
    expect(
      await runCli(['ping'], {
        cwd: emptyDir,
        io: pingCap.io,
        plugins: [explicitPlugin, explicitPlugin],
      })
    ).toBe(EXIT_OK);
    expect(pingCap.stdout).toEqual(['pong']);
    expect(pingCap.stderr.join('\n')).toContain("Duplicate CLI plugin 'explicit-plugin'");

    const failCap = createCaptureIo();
    expect(
      await runCli(['fail-cmd'], {
        cwd: emptyDir,
        io: failCap.io,
        plugins: [explicitPlugin],
      })
    ).toBe(EXIT_ERROR);
  });
});
